import { open, seal } from "./crypto.ts";
import type { InstallationRow, Store } from "./db.ts";
import type { PhotonApi } from "./photon/api.ts";
import { PhotonError } from "./photon/http.ts";
import type { InstallationClient, RedeemResult } from "./photon/installations.ts";
import { TokenError, type TokenSource } from "./photon/token.ts";

export type CallbackOutcome =
  | { kind: "installed"; installation: InstallationRow; check: CheckResult }
  | {
      kind: "not-delivered";
      status: Exclude<RedeemResult["status"], "created">;
      installationId: string;
      /** This service already holds the credential (e.g. the callback was opened twice). */
      stored: boolean;
    };

export type CheckResult =
  | { status: "active"; organizationId: string; organizationName: string }
  | { status: "inactive"; detail: string }
  /** Something else went wrong (network, 5xx): the stored status stands. */
  | { status: "unknown"; detail: string };

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** At most one on-demand check per installation this often. */
const RECHECK_INTERVAL_MS = 30_000;

/** Install this App and keep checking that each installation is still active. */
export function createInstallationService(options: {
  store: Store;
  dataKey: Buffer;
  installations: InstallationClient;
  tokens: TokenSource;
  api: PhotonApi;
  /** Called when an installation checks out active, so deliveries waiting for it go out. */
  onActive?: (installationId: string) => void;
  log?: (line: string) => void;
}) {
  const { store, dataKey, tokens, api } = options;
  const log = options.log ?? (() => {});
  const lastRecheck = new Map<string, number>();

  const credentialOf = (row: InstallationRow) => ({
    clientId: row.client_id,
    clientSecret: open(dataKey, row.client_secret_sealed),
  });

  /**
   * Is the App still installed? A token that works and names its
   * organization means active. A refused credential, or a 401/403 from
   * Photon, means uninstalled or suspended.
   */
  async function check(row: InstallationRow): Promise<CheckResult> {
    try {
      const token = await tokens.token(credentialOf(row));
      const organization = await api.currentOrganization(token);
      store.setInstallationStatus(row.installation_id, "active", null, {
        id: organization.organizationId,
        name: organization.name,
      });
      if (row.status !== "active") {
        // Newly bound or resumed: deliveries held for it go out now.
        store.releaseDeliveries(row.installation_id);
        options.onActive?.(row.installation_id);
      }
      return { status: "active", organizationId: organization.organizationId, organizationName: organization.name };
    } catch (error) {
      const gone =
        (error instanceof TokenError && error.refused) ||
        (error instanceof PhotonError && (error.status === 401 || error.status === 403));
      if (gone) {
        tokens.forget(row.client_id);
        store.setInstallationStatus(row.installation_id, "inactive", describe(error));
        if (row.status === "active") {
          log(`installation ${row.installation_id}: now inactive (${describe(error)})`);
        }
        return { status: "inactive", detail: describe(error) };
      }
      log(`installation ${row.installation_id}: check failed (${describe(error)})`);
      return { status: "unknown", detail: describe(error) };
    }
  }

  async function checkInstallation(installationId: string) {
    const row = store.getInstallation(installationId);
    if (!row) throw new Error(`Unknown installation ${installationId}`);
    const result = await check(row);
    return { installation: store.getInstallation(installationId)!, check: result };
  }

  return {
    /** The install callback: redeem the code, keep the credential, then check it. */
    async completeInstall(code: string): Promise<CallbackOutcome> {
      const delivery = await options.installations.redeem(code);
      if (delivery.status !== "created") {
        return {
          kind: "not-delivered",
          status: delivery.status,
          installationId: delivery.installationId,
          stored: Boolean(store.getInstallation(delivery.installationId)),
        };
      }
      // Stored before anything else can fail: this answer can't be fetched again.
      if (store.getInstallation(delivery.installationId)) {
        throw new Error(`Installation ${delivery.installationId} already has a stored credential`);
      }
      store.insertInstallation({
        installationId: delivery.installationId,
        clientId: delivery.clientId,
        clientSecretSealed: seal(dataKey, delivery.clientSecret),
      });
      log(`installation ${delivery.installationId}: credential stored`);
      return { kind: "installed", ...(await checkInstallation(delivery.installationId)) };
    },

    checkInstallation,

    /**
     * A delivery is waiting on this installation: check it now instead of at
     * the next health check (it may just have been resumed). Throttled.
     */
    recheck(installationId: string): Promise<void> {
      const last = lastRecheck.get(installationId);
      if (last !== undefined && Date.now() - last < RECHECK_INTERVAL_MS) return Promise.resolve();
      lastRecheck.set(installationId, Date.now());
      return checkInstallation(installationId).then(
        () => {},
        (error) => log(`installation ${installationId}: recheck failed (${describe(error)})`),
      );
    },

    /** Periodic: every stored installation, so suspended ones are noticed when they resume. */
    async checkAll() {
      for (const row of store.listInstallations()) await checkInstallation(row.installation_id);
    },
  };
}

export type InstallationService = ReturnType<typeof createInstallationService>;
