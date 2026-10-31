import { open } from "../crypto.ts";
import type { DeliveryRow, Store } from "../db.ts";
import { mapMessageEvent } from "./map.ts";
import { SupermemoryError, type SupermemoryClient } from "./supermemory.ts";

export const MAX_ATTEMPTS = 8;

/** How long a delivery waits for its installation to be bound before it's dropped. */
export const QUARANTINE_MS = 24 * 3_600_000;
const QUARANTINE_RECHECK_MS = 60_000;

/** 30s, 1m, 2m, … capped at an hour. */
export const backoffMs = (attempts: number) => Math.min(30_000 * 2 ** attempts, 3_600_000);

/**
 * Sends queued deliveries to Supermemory, each only while the installation it
 * names is active and bound to the organization it names. Photon can deliver
 * before the install callback has stored the credential, so a delivery for an
 * installation that isn't bound yet waits (quarantine) instead of failing.
 */
export function createRelayWorker(options: {
  store: Store;
  dataKey: Buffer;
  supermemory: SupermemoryClient;
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
    if (!installation?.organization_id) {
      if (now() - Date.parse(delivery.created_at) >= QUARANTINE_MS) {
        store.finishDelivery(key, "failed", "installation never bound");
        log(`${label}: failed, installation never bound`);
      } else {
        store.deferDelivery(key, new Date(now() + QUARANTINE_RECHECK_MS), "waiting for the installation to be bound");
      }
      return;
    }
    if (installation.organization_id !== delivery.organization_id) {
      store.finishDelivery(key, "failed", "organization doesn't match the installation");
      log(`${label}: failed, organization mismatch`);
      return;
    }
    if (installation.status !== "active") {
      store.finishDelivery(key, "skipped", "installation inactive");
      log(`${label}: skipped, installation inactive`);
      return;
    }
    const mapped = mapMessageEvent(JSON.parse(open(dataKey, delivery.payload_sealed)), delivery.organization_id);
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
    for (const delivery of store.dueDeliveries(batch)) await relay(delivery);
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
