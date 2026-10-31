import { Webhook } from "standardwebhooks";

/**
 * Photon signs webhooks the Standard Webhooks way: `webhook-id`,
 * `webhook-timestamp` and `webhook-signature` over the raw body, with the
 * destination's `whsec_…` secret. Throws on a bad signature or a timestamp
 * outside the library's tolerance (5 minutes).
 */
export function verifyWebhook(
  secret: string,
  rawBody: string,
  headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
): unknown {
  if (!headers.id || !headers.timestamp || !headers.signature) {
    throw new Error("Missing webhook-id, webhook-timestamp or webhook-signature");
  }
  return new Webhook(secret).verify(rawBody, {
    "webhook-id": headers.id,
    "webhook-timestamp": headers.timestamp,
    "webhook-signature": headers.signature,
  });
}

/** Where a verified App delivery came from: the installation, organization and project it's for. */
export interface AppDelivery {
  eventId: string;
  type: string;
  installationId: string;
  organizationId: string;
  projectId: string;
}

const isId = (value: unknown, prefix: string): value is string =>
  typeof value === "string" && value.startsWith(prefix) && value.length > prefix.length;

/**
 * Checks a verified App delivery's routing fields. Photon signs
 * `app_installation_id` and `data.organizationId` into every App delivery;
 * the event id must match `webhook-id`, and the message must belong to the
 * project the envelope names. Throws on anything else; never routes on a
 * field it couldn't check.
 */
export function parseAppEvent(event: unknown, webhookId: string): AppDelivery {
  const e = event as {
    id?: unknown;
    type?: unknown;
    app_installation_id?: unknown;
    data?: { organizationId?: unknown; projectId?: unknown; object?: { id?: unknown; projectId?: unknown } };
  };
  if (!isId(e?.id, "") || e.id !== webhookId) throw new Error("Event id doesn't match webhook-id");
  if (typeof e.type !== "string") throw new Error("Event has no type");
  if (!isId(e.app_installation_id, "pho_ain_")) throw new Error("Not an App delivery: no app_installation_id");
  if (!isId(e.data?.organizationId, "pho_org_")) throw new Error("No data.organizationId");
  if (!isId(e.data.projectId, "pho_prj_")) throw new Error("No data.projectId");
  if (e.type.startsWith("message.")) {
    if (!isId(e.data.object?.id, "pho_msg_")) throw new Error("No message id");
    if (e.data.object.projectId !== e.data.projectId) throw new Error("Message project doesn't match the envelope");
  }
  return {
    eventId: e.id,
    type: e.type,
    installationId: e.app_installation_id,
    organizationId: e.data.organizationId,
    projectId: e.data.projectId,
  };
}
