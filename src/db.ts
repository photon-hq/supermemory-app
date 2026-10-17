import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type InstallationStatus = "active" | "inactive";
export type DeliveryStatus = "pending" | "done" | "skipped" | "failed";

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

export interface DestinationRow {
  key: string;
  organization_id: string;
  project_id: string;
  installation_id: string;
  destination_id: string;
  secret_sealed: string;
  created_at: string;
}

export interface DeliveryRow {
  webhook_id: string;
  destination_key: string;
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
CREATE TABLE IF NOT EXISTS destinations (
  key TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  secret_sealed TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (installation_id, project_id)
);
CREATE TABLE IF NOT EXISTS deliveries (
  webhook_id TEXT PRIMARY KEY,
  destination_key TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  payload_sealed TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_attempt_at);
`;

const now = () => new Date().toISOString();

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
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
    /** The organization's newest installation that last checked out. */
    activeInstallationFor(organizationId: string) {
      return db
        .prepare(
          `SELECT * FROM installations WHERE organization_id = ? AND status = 'active'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(organizationId) as InstallationRow | undefined;
    },

    // --- destinations the App created itself (manual ones live in config) ---
    insertDestination(row: Omit<DestinationRow, "created_at">) {
      db.prepare(
        `INSERT INTO destinations (key, organization_id, project_id, installation_id, destination_id, secret_sealed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.key,
        row.organization_id,
        row.project_id,
        row.installation_id,
        row.destination_id,
        row.secret_sealed,
        now(),
      );
    },
    getDestination(key: string) {
      return db.prepare("SELECT * FROM destinations WHERE key = ?").get(key) as DestinationRow | undefined;
    },
    destinationsFor(installationId: string) {
      return db
        .prepare("SELECT * FROM destinations WHERE installation_id = ?")
        .all(installationId) as unknown as DestinationRow[];
    },
    deleteDestination(key: string) {
      db.prepare("DELETE FROM destinations WHERE key = ?").run(key);
    },

    // --- deliveries: one row per webhook-id, so Photon's retries are no-ops ---
    /** False when this webhook-id was seen before. */
    enqueueDelivery(row: {
      webhookId: string;
      destinationKey: string;
      organizationId: string;
      projectId: string;
      payloadSealed: string;
    }): boolean {
      const t = now();
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO deliveries
             (webhook_id, destination_key, organization_id, project_id, status, next_attempt_at, payload_sealed, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(row.webhookId, row.destinationKey, row.organizationId, row.projectId, t, row.payloadSealed, t, t);
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
    finishDelivery(webhookId: string, status: Exclude<DeliveryStatus, "pending">, detail: string | null) {
      db.prepare(
        `UPDATE deliveries SET status = ?, last_error = ?, payload_sealed = NULL, attempts = attempts + 1, updated_at = ?
         WHERE webhook_id = ?`,
      ).run(status, detail, now(), webhookId);
    },
    retryDelivery(webhookId: string, at: Date, detail: string) {
      db.prepare(
        `UPDATE deliveries SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE webhook_id = ?`,
      ).run(at.toISOString(), detail, now(), webhookId);
    },
    deliveryCounts() {
      return db
        .prepare("SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status")
        .all() as unknown as { status: DeliveryStatus; count: number }[];
    },
    getDelivery(webhookId: string) {
      return db.prepare("SELECT * FROM deliveries WHERE webhook_id = ?").get(webhookId) as DeliveryRow | undefined;
    },
  };
}
