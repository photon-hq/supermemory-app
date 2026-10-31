import { randomBytes } from "node:crypto";
import { exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { openStore } from "../src/db.ts";
import { createInstallationService } from "../src/installations.ts";
import { createPhotonApi } from "../src/photon/api.ts";
import { createAssertionSigner } from "../src/photon/assertion.ts";
import { createInstallationClient } from "../src/photon/installations.ts";
import { createTokenSource } from "../src/photon/token.ts";
import { createSupermemoryClient } from "../src/relay/supermemory.ts";
import { createRelayWorker, QUARANTINE_MS } from "../src/relay/worker.ts";
import { createApp } from "../src/server.ts";
import {
  fakeFetch,
  INSTALLATION_ID,
  json,
  messageReceived,
  newWebhookSecret,
  ORG_ID,
  signedHeaders,
} from "./fixtures.ts";

const API = "https://api.staging.photon.codes";
const TOKEN_URL = "https://auth.example/oauth2/token";
const SUPERMEMORY = "https://api.supermemory.example";
const PUBLIC = "https://relay.example";

async function harness() {
  const dataKey = randomBytes(32);
  const store = openStore(":memory:");
  const webhookSecret = newWebhookSecret();
  // `revoked`: uninstalled or suspended in Photon — the credential and any token it issued stop working.
  const state = {
    revoked: false,
    supermemoryStatus: 200,
    redeemStatus: "created",
    organizationId: ORG_ID,
    clock: Date.now(),
  };
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });

  const photon = fakeFetch({
    [`POST ${API}/v1/installation-requests/redeem`]: () =>
      json(
        state.redeemStatus === "created"
          ? { status: "created", installationId: INSTALLATION_ID, clientId: "client_1", clientSecret: "m2m-secret" }
          : { status: state.redeemStatus, installationId: INSTALLATION_ID },
      ),
    [`POST ${API}/v1/installation-requests`]: async (request) => {
      const body = (await request.json()) as { state: string };
      return json({ requestId: "pho_air_1", appId: "pho_app_test", appVersion: "1", redirectUri: `${PUBLIC}/callback`, state: body.state, createdAt: "t" }, 201);
    },
    [`POST ${TOKEN_URL}`]: () =>
      state.revoked ? json({ error: "invalid_client" }, 401) : json({ access_token: "app-token", expires_in: 300 }),
    [`GET ${API}/v1/organizations/current`]: (request) =>
      !state.revoked && request.headers.get("authorization") === "Bearer app-token"
        ? json({ organizationId: state.organizationId, name: "Test Org", avatarUrl: null, createdAt: "t", updatedAt: "t", version: "1" })
        : json({ code: "UNAUTHORIZED" }, 401),
  });
  const supermemory = fakeFetch({
    [`POST ${SUPERMEMORY}/ns/`]: () =>
      state.supermemoryStatus === 200 ? json({ id: "doc", status: "queued" }) : json({ error: "busy" }, state.supermemoryStatus),
  });

  const installClient = createInstallationClient({
    apiOrigin: API,
    dashboardOrigin: "https://app.staging.photon.codes",
    appId: "pho_app_test",
    redirectUri: `${PUBLIC}/callback`,
    sign: await createAssertionSigner({ apiOrigin: API, appId: "pho_app_test", keyId: "k", algorithm: "ES256", privateKeyPem: await exportPKCS8(privateKey) }),
    fetch: photon.fetch,
  });
  const worker = createRelayWorker({
    store,
    dataKey,
    supermemory: createSupermemoryClient({ apiOrigin: SUPERMEMORY, apiKey: "sm-key", fetch: supermemory.fetch }),
    now: () => state.clock,
  });
  const installations = createInstallationService({
    store,
    dataKey,
    installations: installClient,
    tokens: createTokenSource({ tokenUrl: TOKEN_URL, fetch: photon.fetch }),
    api: createPhotonApi({ apiOrigin: API, fetch: photon.fetch }),
  });
  const app = createApp({
    store,
    dataKey,
    sessionSecret: "s".repeat(32),
    secureCookies: true,
    installClient,
    installations,
    webhookSecret,
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
    return app.request(`/callback?code=c1&state=${installState}`, { headers: { cookie } });
  }

  /** Photon delivering `event` to the App's webhook; `webhook-id` is the event id unless overridden. */
  async function deliver(event: { id: string }, options: { secret?: string; webhookId?: string } = {}) {
    const body = JSON.stringify(event);
    return app.request("/webhooks/photon", {
      method: "POST",
      body,
      headers: signedHeaders(options.secret ?? webhookSecret, body, { id: options.webhookId ?? event.id }),
    });
  }

  const deliveryOf = (event: { id: string }, installationId = INSTALLATION_ID) =>
    store.getDelivery({ installationId, eventId: event.id });

  return { app, store, state, photon, supermemory, worker, installations, install, deliver, deliveryOf };
}

describe("App subscription, end to end", () => {
  it("installs, then mirrors each inbound message to Supermemory exactly once", async () => {
    const h = await harness();
    const callback = await h.install();
    expect(callback.status).toBe(200);
    const page = await callback.text();
    expect(page).toContain("Installed in Test Org");
    expect(page).toContain("message.received");
    // The credential is stored sealed, never as plaintext.
    const row = h.store.getInstallation(INSTALLATION_ID)!;
    expect(row).toMatchObject({ status: "active", organization_id: ORG_ID, organization_name: "Test Org" });
    expect(row.client_secret_sealed).not.toContain("m2m-secret");

    const event = messageReceived();
    expect((await h.deliver(event)).status).toBe(202);
    // Photon retrying the same event changes nothing.
    expect((await h.deliver(event)).status).toBe(202);
    await h.worker.processOnce();

    expect(h.supermemory.calls).toHaveLength(1);
    const call = h.supermemory.calls[0]!;
    expect(call.url).toBe(`${SUPERMEMORY}/ns/${encodeURIComponent(`photon:${ORG_ID}:pho_usr_01testsender000000000000000`)}/document`);
    expect(call.headers.get("authorization")).toBe("Bearer sm-key");
    expect(JSON.parse(call.body)).toMatchObject({ id: "photon:pho_msg_01testmessage0000000000000", taskType: "memory" });
    expect(h.deliveryOf(event)).toMatchObject({ status: "done", payload_sealed: null });
  });

  it("refuses deliveries that aren't Photon's, or whose routing doesn't add up", async () => {
    const h = await harness();
    const event = messageReceived();
    expect((await h.deliver(event, { secret: newWebhookSecret() })).status).toBe(401);
    expect((await h.deliver(event, { webhookId: "pho_evt_other" })).status).toBe(400);
    expect((await h.deliver(messageReceived({ messageProjectId: "pho_prj_elsewhere" }))).status).toBe(400);
    const { app_installation_id: _, ...ordinary } = messageReceived();
    expect((await h.deliver(ordinary)).status).toBe(400);
    // Other subscribed events are acknowledged and ignored.
    expect((await h.deliver(messageReceived({ type: "message.delivered" }))).status).toBe(204);
    expect(h.store.deliveryCounts()).toEqual([]);
  });

  it("keeps the same event id apart per installation", async () => {
    const h = await harness();
    const event = messageReceived();
    await h.deliver(event);
    await h.deliver(messageReceived({ installationId: "pho_ain_01otherinstallation0000000" }));
    expect(h.deliveryOf(event)).toBeDefined();
    expect(h.deliveryOf(event, "pho_ain_01otherinstallation0000000")).toBeDefined();
  });

  it("holds a delivery that arrives before the install finishes, then relays it", async () => {
    const h = await harness();
    const event = messageReceived();
    await h.deliver(event);
    await h.worker.processOnce();
    expect(h.deliveryOf(event)).toMatchObject({ status: "pending", attempts: 0 });
    expect(h.supermemory.calls).toHaveLength(0);

    await h.install();
    await h.worker.processOnce();
    expect(h.deliveryOf(event)).toMatchObject({ status: "done" });
  });

  it("drops a held delivery whose installation never shows up", async () => {
    const h = await harness();
    const event = messageReceived();
    await h.deliver(event);
    h.state.clock = Date.now() + QUARANTINE_MS;
    h.store.releaseDeliveries(INSTALLATION_ID);
    await h.worker.processOnce();
    expect(h.deliveryOf(event)).toMatchObject({ status: "failed", last_error: "installation never bound", payload_sealed: null });
  });

  it("fails a delivery naming another organization than the installation's", async () => {
    const h = await harness();
    await h.install();
    const event = messageReceived({ organizationId: "pho_org_01someoneelse000000000000" });
    await h.deliver(event);
    await h.worker.processOnce();
    expect(h.supermemory.calls).toHaveLength(0);
    expect(h.deliveryOf(event)).toMatchObject({ status: "failed" });
  });

  it("treats a cancelled install as nothing installed, and a callback from another browser as invalid", async () => {
    const h = await harness();
    const response = await h.app.request("/callback?error=access_denied&state=x");
    expect(await response.text()).toContain("Install cancelled");

    await h.app.request("/install");
    const sent = h.photon.calls.find((c) => c.url === `${API}/v1/installation-requests`)!;
    const { state: installState } = JSON.parse(sent.body) as { state: string };
    expect((await h.app.request(`/callback?code=c1&state=${installState}`)).status).toBe(400);
    expect(h.photon.calls.some((c) => c.url.endsWith("/redeem"))).toBe(false);
    expect(h.store.listInstallations()).toHaveLength(0);
  });

  it.each([
    ["delivery_consumed", "Nothing new to collect"],
    ["recovery_required", "needs repair"],
    ["revocation_pending", "being removed"],
    ["revoked", "was removed"],
  ])("explains a %s redeem without storing anything", async (status, text) => {
    const h = await harness();
    h.state.redeemStatus = status;
    const page = await (await h.install()).text();
    expect(page).toContain(text);
    expect(h.store.listInstallations()).toHaveLength(0);
  });

  it("stops relaying once Photon refuses the App's credential (suspended or uninstalled)", async () => {
    const h = await harness();
    await h.install();

    h.state.revoked = true;
    await h.installations.checkAll();
    expect(h.store.getInstallation(INSTALLATION_ID)).toMatchObject({ status: "inactive" });

    const event = messageReceived({ messageId: "pho_msg_2" });
    await h.deliver(event);
    await h.worker.processOnce();
    expect(h.supermemory.calls).toHaveLength(0);
    expect(h.deliveryOf(event)).toMatchObject({ status: "skipped", payload_sealed: null });
  });

  it("retries Supermemory's 5xx later and gives up on a 4xx", async () => {
    const h = await harness();
    await h.install();

    h.state.supermemoryStatus = 503;
    const a = messageReceived({ messageId: "pho_msg_a" });
    await h.deliver(a);
    await h.worker.processOnce();
    expect(h.deliveryOf(a)).toMatchObject({ status: "pending", attempts: 1 });

    h.state.supermemoryStatus = 401;
    const b = messageReceived({ messageId: "pho_msg_b" });
    await h.deliver(b);
    await h.worker.processOnce();
    expect(h.deliveryOf(b)).toMatchObject({ status: "failed" });
  });
});
