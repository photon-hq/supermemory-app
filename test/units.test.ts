import { randomBytes } from "node:crypto";
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { open, seal } from "../src/crypto.ts";
import { createAssertionSigner } from "../src/photon/assertion.ts";
import { createInstallationClient } from "../src/photon/installations.ts";
import { createTokenSource, TokenError } from "../src/photon/token.ts";
import { mapMessageEvent, messageText, namespaceFor } from "../src/relay/map.ts";
import { verifyWebhook } from "../src/relay/verify.ts";
import { backoffMs } from "../src/relay/worker.ts";
import { fakeFetch, json, messageReceived, newWebhookSecret, ORG_ID, PROJECT_ID, SENDER_ID, signedHeaders } from "./fixtures.ts";

describe("crypto", () => {
  const key = randomBytes(32);

  it("round-trips and never stores the plaintext", () => {
    const sealed = seal(key, "client-secret");
    expect(sealed).not.toContain("client-secret");
    expect(open(key, sealed)).toBe("client-secret");
  });

  it("refuses a tampered value or the wrong key", () => {
    const sealed = seal(key, "client-secret");
    const tampered = sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA");
    expect(() => open(key, tampered)).toThrow();
    expect(() => open(randomBytes(32), sealed)).toThrow();
  });
});

describe("message → memory", () => {
  it("maps a received text message to the sender's namespace", () => {
    const mapped = mapMessageEvent(messageReceived(), ORG_ID);
    expect(mapped.kind).toBe("memory");
    if (mapped.kind !== "memory") return;
    expect(mapped.document).toMatchObject({
      namespace: `photon:${ORG_ID}:${SENDER_ID}`,
      id: "photon:pho_msg_01testmessage0000000000000",
      content: "I'm vegetarian and I'm moving to Lisbon in March.",
      date: "2026-10-17T10:00:00.000Z",
      group: { conversation: "pho_spc_01testspace000000000000000" },
      metadata: { source: "photon", organizationId: ORG_ID, projectId: PROJECT_ID, platform: "imessage", senderId: SENDER_ID },
    });
    // The sender's phone number stays out of Supermemory.
    expect(JSON.stringify(mapped.document)).not.toContain("+15555550100");
  });

  it("joins the text parts of a group and skips what has no words", () => {
    expect(
      messageText({ type: "group", parts: [{ type: "text", text: "one" }, { type: "attachment", attachmentId: "a" }, { type: "text", text: "two" }] }),
    ).toBe("one\ntwo");
    expect(mapMessageEvent(messageReceived({ content: { type: "attachment", attachmentId: "a" } }), ORG_ID)).toEqual({
      kind: "skip",
      reason: "no text (content type attachment)",
    });
    expect(mapMessageEvent(messageReceived({ type: "message.delivered" }), ORG_ID).kind).toBe("skip");
    expect(mapMessageEvent({}, ORG_ID).kind).toBe("skip");
  });

  it("keeps namespaces inside Supermemory's alphabet and length", () => {
    const ns = namespaceFor("org with spaces", "x".repeat(200));
    expect(ns).toMatch(/^[A-Za-z0-9_:-]{1,100}$/);
  });
});

describe("webhook verification", () => {
  const secret = newWebhookSecret();
  const body = JSON.stringify(messageReceived());
  const headersOf = (h: Record<string, string>) => ({
    id: h["webhook-id"],
    timestamp: h["webhook-timestamp"],
    signature: h["webhook-signature"],
  });

  it("accepts Photon's signature", () => {
    expect(verifyWebhook(secret, body, headersOf(signedHeaders(secret, body)))).toMatchObject({ type: "message.received" });
  });

  it("refuses a changed body, another secret, a stale timestamp or missing headers", () => {
    const headers = headersOf(signedHeaders(secret, body));
    expect(() => verifyWebhook(secret, body.replace("Lisbon", "Paris"), headers)).toThrow();
    expect(() => verifyWebhook(newWebhookSecret(), body, headers)).toThrow();
    const stale = headersOf(signedHeaders(secret, body, { at: new Date(Date.now() - 10 * 60_000) }));
    expect(() => verifyWebhook(secret, body, stale)).toThrow();
    expect(() => verifyWebhook(secret, body, { id: undefined, timestamp: undefined, signature: undefined })).toThrow();
  });
});

describe("installation client", () => {
  it("signs each call for its own endpoint and sends the admin to Photon's approval page", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const sign = await createAssertionSigner({
      apiOrigin: "https://api.staging.photon.codes",
      appId: "pho_app_test",
      keyId: "test-key",
      algorithm: "ES256",
      privateKeyPem: await exportPKCS8(privateKey),
    });
    const { fetch, calls } = fakeFetch({
      "POST https://api.staging.photon.codes/v1/installation-requests/redeem": () =>
        json({ status: "created", installationId: "pho_ain_1", clientId: "client_1", clientSecret: "s" }),
      "POST https://api.staging.photon.codes/v1/installation-requests": () =>
        json({ requestId: "pho_air_1", appId: "pho_app_test", appVersion: "1", redirectUri: "x", state: "st", createdAt: "t" }, 201),
    });
    const client = createInstallationClient({
      apiOrigin: "https://api.staging.photon.codes",
      dashboardOrigin: "https://app.staging.photon.codes",
      appId: "pho_app_test",
      redirectUri: "https://relay.example/callback",
      sign,
      fetch,
    });

    const { approveUrl } = await client.request("st");
    expect(approveUrl).toBe("https://app.staging.photon.codes/organization/install?requestId=pho_air_1");
    await client.redeem("code-1");

    const [request, redeem] = calls.map((call) => JSON.parse(call.body) as Record<string, string>);
    expect(request).toMatchObject({ appId: "pho_app_test", redirectUri: "https://relay.example/callback", state: "st" });
    expect(decodeJwt(request!.clientAssertion!).aud).toBe("https://api.staging.photon.codes/v1/installation-requests");
    expect(decodeProtectedHeader(request!.clientAssertion!)).toMatchObject({ alg: "ES256", kid: "test-key" });
    expect(decodeJwt(redeem!.clientAssertion!).aud).toBe("https://api.staging.photon.codes/v1/installation-requests/redeem");
    expect(decodeJwt(redeem!.clientAssertion!).jti).not.toBe(decodeJwt(request!.clientAssertion!).jti);
    expect(redeem!.code).toBe("code-1");
  });
});

describe("token source", () => {
  const credential = { clientId: "client_1", clientSecret: "secret" };

  it("exchanges client credentials once and reuses the token until shortly before expiry", async () => {
    let t = 0;
    let issued = 0;
    const { fetch, calls } = fakeFetch({
      "POST https://auth.example/oauth2/token": () => json({ access_token: `token-${++issued}`, expires_in: 300 }),
    });
    const tokens = createTokenSource({ tokenUrl: "https://auth.example/oauth2/token", fetch, now: () => t });
    expect(await tokens.token(credential)).toBe("token-1");
    t = 200_000;
    expect(await tokens.token(credential)).toBe("token-1");
    t = 250_000;
    expect(await tokens.token(credential)).toBe("token-2");
    expect(new URLSearchParams(calls[0]!.body).get("grant_type")).toBe("client_credentials");
  });

  it("calls a refused credential refused, and a server error not", async () => {
    const refused = createTokenSource({
      tokenUrl: "https://auth.example/oauth2/token",
      fetch: fakeFetch({ "POST https://auth.example": () => json({ error: "invalid_client" }, 400) }).fetch,
    });
    await expect(refused.token(credential)).rejects.toMatchObject({ refused: true });
    const flaky = createTokenSource({
      tokenUrl: "https://auth.example/oauth2/token",
      fetch: fakeFetch({ "POST https://auth.example": () => json({}, 503) }).fetch,
    });
    const error = await flaky.token(credential).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenError);
    expect((error as TokenError).refused).toBe(false);
  });
});

describe("retry backoff", () => {
  it("doubles from 30 seconds and stops at an hour", () => {
    expect([0, 1, 2].map(backoffMs)).toEqual([30_000, 60_000, 120_000]);
    expect(backoffMs(20)).toBe(3_600_000);
  });
});
