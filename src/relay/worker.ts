import { open } from "../crypto.ts";
import type { DeliveryRow, Store } from "../db.ts";
import { mapMessageEvent } from "./map.ts";
import { SupermemoryError, type SupermemoryClient } from "./supermemory.ts";

export const MAX_ATTEMPTS = 8;

/** How long a delivery is held for its installation (to be bound, or active again) before it's dropped. */
export const QUARANTINE_MS = 24 * 3_600_000;

/** 30s, 1m, 2m, … capped at an hour. */
export const backoffMs = (attempts: number) => Math.min(30_000 * 2 ** attempts, 3_600_000);

/**
 * Sends queued deliveries to Supermemory, each only while the installation it
 * names is active and bound to the organization it names. Photon can deliver
 * before the install callback has stored the credential, and right after a
 * resume, before the health check has seen it. So a delivery for an
 * installation that isn't bound or active yet is held (quarantine) until the
 * installation checks out active, instead of being dropped.
 */
export function createRelayWorker(options: {
  store: Store;
  dataKey: Buffer;
  supermemory: SupermemoryClient;
  /** A delivery was held for this stored installation: check it again soon. */
  onHold?: (installationId: string) => void;
  now?: () => number;
  log?: (line: string) => void;
}) {
  const { store, dataKey, supermemory } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  let running: Promise<void> | null = null;

  async function relay(delivery: DeliveryRow) {
    const key = { installationId: delivery.installation_id, eventId: delivery.event_id };
    const label = `delivery ${delivery.installation_id}/${delivery.event_id}`;
    if (!delivery.payload_sealed) {
      store.finishDelivery(key, "failed", "payload missing");
      return;
    }
    const installation = store.getInstallation(delivery.installation_id);
    if (installation?.organization_id && installation.organization_id !== delivery.organization_id) {
      store.finishDelivery(key, "failed", "organization doesn't match the installation");
      log(`${label}: failed, organization mismatch`);
      return;
    }
    if (!installation?.organization_id || installation.status !== "active") {
      const bound = Boolean(installation?.organization_id);
      if (now() - Date.parse(delivery.created_at) >= QUARANTINE_MS) {
        if (bound) store.finishDelivery(key, "skipped", "installation inactive");
        else store.finishDelivery(key, "failed", "installation never bound");
        log(`${label}: ${bound ? "skipped, installation inactive" : "failed, installation never bound"}`);
      } else {
        store.holdDelivery(key, bound ? "waiting for the installation to be active" : "waiting for the installation to be bound");
        if (installation) options.onHold?.(installation.installation_id);
      }
      return;
    }
    let mapped: ReturnType<typeof mapMessageEvent>;
    try {
      mapped = mapMessageEvent(JSON.parse(open(dataKey, delivery.payload_sealed)), delivery.organization_id);
    } catch {
      // Not the error's text: a JSON error can quote the message.
      store.finishDelivery(key, "failed", "unreadable payload");
      log(`${label}: failed, unreadable payload`);
      return;
    }
    if (mapped.kind === "skip") {
      store.finishDelivery(key, "skipped", mapped.reason);
      return;
    }
    try {
      const result = await supermemory.addDocument(mapped.document);
      store.finishDelivery(key, "done", `supermemory ${result.status}`);
      log(`${label}: stored (${result.status})`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      const retryable = !(error instanceof SupermemoryError) || error.retryable;
      if (retryable && delivery.attempts + 1 < MAX_ATTEMPTS) {
        store.retryDelivery(key, new Date(now() + backoffMs(delivery.attempts)), detail);
        log(`${label}: will retry (${detail})`);
      } else {
        store.finishDelivery(key, "failed", detail);
        log(`${label}: failed (${detail})`);
      }
    }
  }

  async function processOnce(batch = 20) {
    store.releaseHeldBefore(new Date(now() - QUARANTINE_MS));
    for (const delivery of store.dueDeliveries(batch)) {
      try {
        await relay(delivery);
      } catch (error) {
        // One bad row mustn't stop the rest of the queue.
        log(`delivery ${delivery.installation_id}/${delivery.event_id}: error (${error instanceof Error ? error.message : String(error)})`);
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
