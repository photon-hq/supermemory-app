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
