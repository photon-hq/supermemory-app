import { randomBytes } from "node:crypto";
import { exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import type { ManualDestination } from "../src/config.ts";
import { openStore } from "../src/db.ts";
import { createInstallationService } from "../src/installations.ts";
import { createPhotonApi } from "../src/photon/api.ts";
import { createAssertionSigner } from "../src/photon/assertion.ts";
import { createInstallationClient } from "../src/photon/installations.ts";
import { createAppProvisioner, createManualProvisioner } from "../src/photon/provisioner.ts";
import { createTokenSource } from "../src/photon/token.ts";
import { createSupermemoryClient } from "../src/relay/supermemory.ts";
import { createRelayWorker } from "../src/relay/worker.ts";
import { createApp } from "../src/server.ts";
import { fakeFetch, json, messageReceived, newWebhookSecret, ORG_ID, PROJECT_ID, signedHeaders } from "./fixtures.ts";

const API = "https://api.staging.photon.codes";
const TOKEN_URL = "https://auth.example/oauth2/token";
const SUPERMEMORY = "https://api.supermemory.example";
const PUBLIC = "https://relay.example";

async function harness(options: { mode: "manual" | "app"; destinationsApiStatus?: number }) {
  const dataKey = randomBytes(32);
  const store = openStore(":memory:");
  // `revoked`: uninstalled in Photon — the credential and any token it issued stop working.
  const state = { revoked: false, supermemoryStatus: 200 };
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });

  const photon = fakeFetch({
    [`POST ${API}/v1/installation-requests/redeem`]: () =>
      json({ status: "created", installationId: "pho_ain_1", clientId: "client_1", clientSecret: "m2m-secret" }),
    [`POST ${API}/v1/installation-requests`]: async (request) => {
      const body = (await request.json()) as { state: string };
      return json({ requestId: "pho_air_1", appId: "pho_app_test", appVersion: "1", redirectUri: `${PUBLIC}/callback`, state: body.state, createdAt: "t" }, 201);
    },
    [`POST ${TOKEN_URL}`]: () =>
      state.revoked ? json({ error: "invalid_client" }, 401) : json({ access_token: "app-token", expires_in: 300 }),
    [`GET ${API}/v1/organizations/current`]: (request) =>
      !state.revoked && request.headers.get("authorization") === "Bearer app-token"
        ? json({ organizationId: ORG_ID, name: "Test Org", avatarUrl: null, createdAt: "t", updatedAt: "t", version: "1" })
        : json({ code: "UNAUTHORIZED" }, 401),
    [`GET ${API}/v1/organizations/${ORG_ID}/projects`]: () =>
      json({ projects: [{ projectId: PROJECT_ID, organizationId: ORG_ID, name: "Test Project", deletedAt: null }] }),
    [`POST ${API}/v1/projects/${PROJECT_ID}/webhooks/destinations`]: () =>
      options.destinationsApiStatus && options.destinationsApiStatus >= 400
        ? json({ code: "FORBIDDEN", title: "Forbidden" }, options.destinationsApiStatus)
        : json({ destination: { destinationId: "pho_whd_1", projectId: PROJECT_ID, url: "x" }, signingSecret: newWebhookSecret() }, 201),
  });
  const supermemory = fakeFetch({
    [`POST ${SUPERMEMORY}/ns/`]: () =>
      state.supermemoryStatus === 200 ? json({ id: "doc", status: "queued" }) : json({ error: "busy" }, state.supermemoryStatus),
  });

  const manualSecret = newWebhookSecret();
  const manual: Record<string, ManualDestination> = {
    "test-destination": { organizationId: ORG_ID, projectId: PROJECT_ID, secret: manualSecret },
  };
  const api = createPhotonApi({ apiOrigin: API, fetch: photon.fetch });
  const provisioner =
    options.mode === "app"
      ? createAppProvisioner({ store, api, dataKey, publicBaseUrl: PUBLIC, webhookApiVersion: "2026-07-01" })
      : createManualProvisioner(manual);
  const installClient = createInstallationClient({
    apiOrigin: API,
    dashboardOrigin: "https://app.staging.photon.codes",
    appId: "pho_app_test",
    redirectUri: `${PUBLIC}/callback`,
    sign: await createAssertionSigner({ apiOrigin: API, appId: "pho_app_test", keyId: "k", algorithm: "ES256", privateKeyPem: await exportPKCS8(privateKey) }),
    fetch: photon.fetch,
  });
  const installations = createInstallationService({
    store,
    dataKey,
    installations: installClient,
    tokens: createTokenSource({ tokenUrl: TOKEN_URL, fetch: photon.fetch }),
    api,
    provisioner,
  });
  const worker = createRelayWorker({
    store,
    dataKey,
    supermemory: createSupermemoryClient({ apiOrigin: SUPERMEMORY, apiKey: "sm-key", fetch: supermemory.fetch }),
  });
  const app = createApp({
    store,
    dataKey,
    sessionSecret: "s".repeat(32),
    secureCookies: true,
    installClient,
    installations,
    provisioner,
    onQueued: () => {},
  });

  /** Walks the admin through: /install → Photon → /callback. */
  async function install() {
    const start = await app.request("/install");
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toBe("https://app.staging.photon.codes/organization/install?requestId=pho_air_1");
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const sent = photon.calls.find((c) => c.url === `${API}/v1/installation-requests`)!;
    const { state: installState } = JSON.parse(sent.body) as { state: string };
    return { cookie, installState };
  }

  async function deliver(secret: string, key: string, body: string, id?: string) {
    return app.request(`/webhooks/photon/${key}`, { method: "POST", body, headers: signedHeaders(secret, body, { id }) });
  }

  return { app, store, state, photon, supermemory, worker, installations, install, deliver, manualSecret };
}

describe("manual mode, end to end", () => {
  it("installs, then mirrors each inbound message to Supermemory exactly once", async () => {
    const h = await harness({ mode: "manual" });
    const { cookie, installState } = await h.install();

    const callback = await h.app.request(`/callback?code=c1&state=${installState}`, { headers: { cookie } });
    expect(callback.status).toBe(200);
    const page = await callback.text();
    expect(page).toContain("Installed in Test Org");
    expect(page).toContain("1 hand-made webhook destination");
    // The credential is stored sealed, never as plaintext.
    const row = h.store.getInstallation("pho_ain_1")!;
    expect(row).toMatchObject({ status: "active", organization_id: ORG_ID, organization_name: "Test Org" });
    expect(row.client_secret_sealed).not.toContain("m2m-secret");

    const body = JSON.stringify(messageReceived());
    expect((await h.deliver(h.manualSecret, "test-destination", body, "msg_1")).status).toBe(202);
    // Photon retrying the same webhook-id changes nothing.
    expect((await h.deliver(h.manualSecret, "test-destination", body, "msg_1")).status).toBe(202);
    await h.worker.processOnce();

    expect(h.supermemory.calls).toHaveLength(1);
    const call = h.supermemory.calls[0]!;
    expect(call.url).toBe(`${SUPERMEMORY}/ns/${encodeURIComponent(`photon:${ORG_ID}:pho_usr_01testsender000000000000000`)}/document`);
    expect(call.headers.get("authorization")).toBe("Bearer sm-key");
    expect(JSON.parse(call.body)).toMatchObject({ id: "photon:pho_msg_01testmessage0000000000000", taskType: "memory" });
    expect(h.store.getDelivery("msg_1")).toMatchObject({ status: "done", payload_sealed: null });
  });

  it("refuses a callback from another browser, and webhooks that aren't Photon's", async () => {
    const h = await harness({ mode: "manual" });
    const { installState } = await h.install();
    const other = await h.app.request(`/callback?code=c1&state=${installState}`);
    expect(other.status).toBe(400);
    expect(h.photon.calls.some((c) => c.url.endsWith("/redeem"))).toBe(false);

    const body = JSON.stringify(messageReceived());
    expect((await h.deliver(newWebhookSecret(), "test-destination", body)).status).toBe(401);
    expect((await h.deliver(h.manualSecret, "unknown-destination", body)).status).toBe(404);
  });

  it("treats a cancelled install as nothing installed", async () => {
    const h = await harness({ mode: "manual" });
    const response = await h.app.request("/callback?error=access_denied&state=x");
    expect(await response.text()).toContain("Install cancelled");
    expect(h.store.listInstallations()).toHaveLength(0);
  });

  it("stops relaying once Photon refuses the App's credential (uninstalled)", async () => {
    const h = await harness({ mode: "manual" });
    const { cookie, installState } = await h.install();
    await h.app.request(`/callback?code=c1&state=${installState}`, { headers: { cookie } });

    h.state.revoked = true;
    await h.installations.checkAll();
    expect(h.store.getInstallation("pho_ain_1")).toMatchObject({ status: "inactive" });

    await h.deliver(h.manualSecret, "test-destination", JSON.stringify(messageReceived()), "msg_2");
    await h.worker.processOnce();
    expect(h.supermemory.calls).toHaveLength(0);
    expect(h.store.getDelivery("msg_2")).toMatchObject({ status: "skipped", payload_sealed: null });
  });

  it("retries Supermemory's 5xx later and gives up on a 4xx", async () => {
    const h = await harness({ mode: "manual" });
    const { cookie, installState } = await h.install();
    await h.app.request(`/callback?code=c1&state=${installState}`, { headers: { cookie } });

    h.state.supermemoryStatus = 503;
    await h.deliver(h.manualSecret, "test-destination", JSON.stringify(messageReceived({ messageId: "pho_msg_a" })), "msg_a");
    await h.worker.processOnce();
    expect(h.store.getDelivery("msg_a")).toMatchObject({ status: "pending", attempts: 1 });

    h.state.supermemoryStatus = 401;
    await h.deliver(h.manualSecret, "test-destination", JSON.stringify(messageReceived({ messageId: "pho_msg_b" })), "msg_b");
    await h.worker.processOnce();
    expect(h.store.getDelivery("msg_b")).toMatchObject({ status: "failed" });
  });
});

describe("app mode", () => {
  it("reports Photon refusing the App's token on webhook destinations (today's ENG-4010 block)", async () => {
    const h = await harness({ mode: "app", destinationsApiStatus: 403 });
    const { cookie, installState } = await h.install();
    const page = await (await h.app.request(`/callback?code=c1&state=${installState}`, { headers: { cookie } })).text();

    expect(page).toContain("refused");
    expect(page).toContain("ENG-4010");
    const create = h.photon.calls.find((c) => c.url.endsWith("/webhooks/destinations"))!;
    expect(create.headers.get("authorization")).toBe("Bearer app-token");
    expect(create.headers.get("idempotency-key")).toBe(`supermemory:pho_ain_1:${PROJECT_ID}`);
    expect(JSON.parse(create.body)).toMatchObject({ enabledEvents: ["message.received"], apiVersion: "2026-07-01" });
    expect(h.store.destinationsFor("pho_ain_1")).toHaveLength(0);
  });

  it("once Photon allows it, creates one destination per project and relays through it", async () => {
    const h = await harness({ mode: "app", destinationsApiStatus: 201 });
    const { cookie, installState } = await h.install();
    await h.app.request(`/callback?code=c1&state=${installState}`, { headers: { cookie } });
    const [destination] = h.store.destinationsFor("pho_ain_1");
    expect(destination).toMatchObject({ project_id: PROJECT_ID, destination_id: "pho_whd_1" });

    // A second check doesn't create another.
    await h.installations.checkAll();
    expect(h.photon.calls.filter((c) => c.url.endsWith("/webhooks/destinations"))).toHaveLength(1);

    const resolved = createAppProvisioner({
      store: h.store,
      api: createPhotonApi({ apiOrigin: API }),
      dataKey: Buffer.alloc(32),
      publicBaseUrl: PUBLIC,
      webhookApiVersion: "2026-07-01",
    });
    expect(() => resolved.resolve(destination!.key)).toThrow(); // sealed with another key
  });
});
