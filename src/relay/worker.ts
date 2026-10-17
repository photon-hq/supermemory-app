import { open } from "../crypto.ts";
import type { Store } from "../db.ts";
import { mapMessageEvent } from "./map.ts";
import { SupermemoryError, type SupermemoryClient } from "./supermemory.ts";

export const MAX_ATTEMPTS = 8;

/** 30s, 1m, 2m, … capped at an hour. */
export const backoffMs = (attempts: number) => Math.min(30_000 * 2 ** attempts, 3_600_000);

/**
 * Sends queued webhooks to Supermemory. A message is relayed only while its
 * organization has an active installation: uninstalling or suspending the
 * App in Photon stops the mirror once the next check notices.
 */
export function createRelayWorker(options: {
  store: Store;
  dataKey: Buffer;
  supermemory: SupermemoryClient;
  log?: (line: string) => void;
}) {
  const { store, dataKey, supermemory } = options;
  const log = options.log ?? (() => {});
  let running: Promise<void> | null = null;

  async function processOnce(batch = 20) {
    for (const delivery of store.dueDeliveries(batch)) {
      if (!delivery.payload_sealed) {
        store.finishDelivery(delivery.webhook_id, "failed", "payload missing");
        continue;
      }
      if (!store.activeInstallationFor(delivery.organization_id)) {
        store.finishDelivery(delivery.webhook_id, "skipped", "no active installation for this organization");
        log(`delivery ${delivery.webhook_id}: skipped, no active installation`);
        continue;
      }
      const mapped = mapMessageEvent(JSON.parse(open(dataKey, delivery.payload_sealed)), delivery.organization_id);
      if (mapped.kind === "skip") {
        store.finishDelivery(delivery.webhook_id, "skipped", mapped.reason);
        continue;
      }
      try {
        const result = await supermemory.addDocument(mapped.document);
        store.finishDelivery(delivery.webhook_id, "done", `supermemory ${result.status}`);
        log(`delivery ${delivery.webhook_id}: stored (${result.status})`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        const retryable = !(error instanceof SupermemoryError) || error.retryable;
        if (retryable && delivery.attempts + 1 < MAX_ATTEMPTS) {
          store.retryDelivery(delivery.webhook_id, new Date(Date.now() + backoffMs(delivery.attempts)), detail);
          log(`delivery ${delivery.webhook_id}: will retry (${detail})`);
        } else {
          store.finishDelivery(delivery.webhook_id, "failed", detail);
          log(`delivery ${delivery.webhook_id}: failed (${detail})`);
        }
      }
    }
  }

  return {
    processOnce,
    /** Runs one pass unless one is already running. */
    kick() {
      running ??= processOnce()
        .catch((error) => log(`relay worker error: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}
