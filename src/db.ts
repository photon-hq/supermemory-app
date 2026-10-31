import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type InstallationStatus = "active" | "inactive";
/** `held`: waiting for its installation (not bound yet, or inactive); not picked up until released. */
export type DeliveryStatus = "pending" | "held" | "done" | "skipped" | "failed";

export interface InstallationRow {
  installation_id: string;
  organization_id: string | null;
  organization_name: string | null;
  client_id: string;
  client_secret_sealed: string;
  status: InstallationStatus;
  status_detail: string | null;
  created_at: string;
  checked_at: string | null;
}

export interface DeliveryRow {
  installation_id: string;
  event_id: string;
  organization_id: string;
  project_id: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  payload_sealed: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryKey {
  installationId: string;
  eventId: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS installations (
  installation_id TEXT PRIMARY KEY,
  organization_id TEXT,
  organization_name TEXT,
  client_id TEXT NOT NULL,
  client_secret_sealed TEXT NOT NULL,
  status TEXT NOT NULL,
  status_detail TEXT,
  created_at TEXT NOT NULL,
  checked_at TEXT
);
CREATE TABLE IF NOT EXISTS deliveries (
  installation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  payload_sealed TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, event_id)
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_attempt_at);
`;

const SCHEMA_VERSION = 2;

/**
 * v1 relayed per-destination webhooks (made by hand or by the App). v2
 * receives App subscription deliveries, keyed by installation. Installations
 * and their sealed credentials are kept: Photon hands those out only once.
 */
function migrate(db: DatabaseSync) {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version >= SCHEMA_VERSION) return;
  db.exec("DROP TABLE IF EXISTS destinations; DROP TABLE IF EXISTS deliveries;");
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

const now = () => new Date().toISOString();

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  db.exec(SCHEMA);

  return {
    close: () => db.close(),

    // --- install `state`, bound to the browser session that started it ---
    saveState(state: string, sessionId: string, ttlMs: number) {
      db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(now());
      db.prepare("INSERT INTO oauth_states (state, session_id, expires_at) VALUES (?, ?, ?)").run(
        state,
        sessionId,
        new Date(Date.now() + ttlMs).toISOString(),
      );
    },
    /** One use: true only for an unexpired state started by this session. */
    takeState(state: string, sessionId: string): boolean {
      const row = db
        .prepare("DELETE FROM oauth_states WHERE state = ? RETURNING session_id, expires_at")
        .get(state) as { session_id: string; expires_at: string } | undefined;
      return Boolean(row && row.session_id === sessionId && row.expires_at > now());
    },

    // --- installations ---
    insertInstallation(row: {
      installationId: string;
      clientId: string;
      clientSecretSealed: string;
    }) {
      db.prepare(
        `INSERT INTO installations (installation_id, client_id, client_secret_sealed, status, created_at)
         VALUES (?, ?, ?, 'inactive', ?)`,
      ).run(row.installationId, row.clientId, row.clientSecretSealed, now());
    },
    setInstallationStatus(
      installationId: string,
      status: InstallationStatus,
      detail: string | null,
      organization?: { id: string; name: string },
    ) {
      db.prepare(
        `UPDATE installations SET status = ?, status_detail = ?, checked_at = ?,
           organization_id = COALESCE(?, organization_id),
           organization_name = COALESCE(?, organization_name)
         WHERE installation_id = ?`,
      ).run(status, detail, now(), organization?.id ?? null, organization?.name ?? null, installationId);
    },
    getInstallation(installationId: string) {
      return db.prepare("SELECT * FROM installations WHERE installation_id = ?").get(installationId) as
        | InstallationRow
        | undefined;
    },
    listInstallations() {
      return db.prepare("SELECT * FROM installations ORDER BY created_at DESC").all() as unknown as InstallationRow[];
    },
    // --- deliveries: one row per installation and event, so Photon's retries are no-ops ---
    /** False when this installation's event was seen before. */
    enqueueDelivery(row: {
      installationId: string;
      eventId: string;
      organizationId: string;
      projectId: string;
      payloadSealed: string;
    }): boolean {
      const t = now();
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO deliveries
             (installation_id, event_id, organization_id, project_id, status, next_attempt_at, payload_sealed, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(row.installationId, row.eventId, row.organizationId, row.projectId, t, row.payloadSealed, t, t);
      return result.changes > 0;
    },
    dueDeliveries(limit: number) {
      return db
        .prepare(
          `SELECT * FROM deliveries WHERE status = 'pending' AND next_attempt_at <= ?
           ORDER BY next_attempt_at LIMIT ?`,
        )
        .all(now(), limit) as unknown as DeliveryRow[];
    },
    /** Finished either way: the queued message is dropped, only the outcome stays. */
    finishDelivery(key: DeliveryKey, status: Exclude<DeliveryStatus, "pending">, detail: string | null) {
      db.prepare(
        `UPDATE deliveries SET status = ?, last_error = ?, payload_sealed = NULL, attempts = attempts + 1, updated_at = ?
         WHERE installation_id = ? AND event_id = ?`,
      ).run(status, detail, now(), key.installationId, key.eventId);
    },
    retryDelivery(key: DeliveryKey, at: Date, detail: string) {
      db.prepare(
        `UPDATE deliveries SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE installation_id = ? AND event_id = ?`,
      ).run(at.toISOString(), detail, now(), key.installationId, key.eventId);
    },
    /** Waiting for its installation: set aside until released, without using up a Supermemory attempt. */
    holdDelivery(key: DeliveryKey, detail: string) {
      db.prepare(
        `UPDATE deliveries SET status = 'held', last_error = ?, updated_at = ?
         WHERE installation_id = ? AND event_id = ?`,
      ).run(detail, now(), key.installationId, key.eventId);
    },
    /** This installation just checked out active: its held deliveries are due now. */
    releaseDeliveries(installationId: string) {
      db.prepare(
        `UPDATE deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ?
         WHERE installation_id = ? AND status = 'held'`,
      ).run(now(), now(), installationId);
    },
    /** Held since before `cutoff`: due now, so the worker can drop them. */
    releaseHeldBefore(cutoff: Date) {
      db.prepare(
        `UPDATE deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ?
         WHERE status = 'held' AND created_at <= ?`,
      ).run(now(), now(), cutoff.toISOString());
    },
    deliveryCounts() {
      return db
        .prepare("SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status")
        .all() as unknown as { status: DeliveryStatus; count: number }[];
    },
    getDelivery(key: DeliveryKey) {
      return db
        .prepare("SELECT * FROM deliveries WHERE installation_id = ? AND event_id = ?")
        .get(key.installationId, key.eventId) as DeliveryRow | undefined;
    },
  };
}
