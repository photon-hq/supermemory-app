import { randomBytes } from "node:crypto";
import { Webhook } from "standardwebhooks";

export const ORG_ID = "pho_org_01testorganization000000000";
export const PROJECT_ID = "pho_prj_01testproject00000000000000";
export const SENDER_ID = "pho_usr_01testsender000000000000000";

/** A `message.received` event shaped like Photon's `ImessageMessageReceivedEvent` (API 2026-07-01). */
export function messageReceived(overrides: { messageId?: string; content?: unknown; type?: string } = {}) {
  const messageId = overrides.messageId ?? "pho_msg_01testmessage0000000000000";
  return {
    id: `pho_evt_${messageId.slice(8)}`,
    type: overrides.type ?? "message.received",
    apiVersion: "2026-07-01",
    source: "imessage.photon",
    timestamp: "2026-10-17T10:00:01.000Z",
    data: {
      projectId: PROJECT_ID,
      object: {
        id: messageId,
        projectId: PROJECT_ID,
        platform: "imessage",
        status: "received",
        space: { id: "pho_spc_01testspace000000000000000", projectId: PROJECT_ID, platform: "imessage", kind: "direct", participantIds: [SENDER_ID], details: {}, metadata: {} },
        sentBy: { id: SENDER_ID, projectId: PROJECT_ID, platform: "imessage", handle: "+15555550100", kind: "person", details: {}, metadata: { displayName: "Test Sender" } },
        content: overrides.content ?? { type: "text", format: "plain", text: "I'm vegetarian and I'm moving to Lisbon in March." },
        metadata: {},
        createdAt: "2026-10-17T10:00:00.500Z",
        updatedAt: "2026-10-17T10:00:00.500Z",
        timestamps: { receivedAt: "2026-10-17T10:00:00.000Z" },
      },
    },
  };
}

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString("base64")}`;

/** Headers Photon would send for this body, signed with `secret`. */
export function signedHeaders(secret: string, body: string, options: { id?: string; at?: Date } = {}) {
  const id = options.id ?? `msg_${randomBytes(8).toString("hex")}`;
  const at = options.at ?? new Date();
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(Math.floor(at.getTime() / 1000)),
    "webhook-signature": new Webhook(secret).sign(id, at, body),
  };
}

type Handler = (request: Request) => Response | Promise<Response>;

/** A fetch that routes by "METHOD URL-prefix" and records every call. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; body: string; headers: Headers }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    calls.push({ method: request.method, url: request.url, body, headers: request.headers });
    const key = Object.keys(routes)
      .filter((route) => {
        const [method, prefix] = route.split(" ");
        return method === request.method && request.url.startsWith(prefix!);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response(JSON.stringify({ error: "no route" }), { status: 599 });
    return routes[key]!(request);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
