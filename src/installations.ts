import { open, seal } from "./crypto.ts";
import type { InstallationRow, Store } from "./db.ts";
import type { PhotonApi } from "./photon/api.ts";
import { PhotonError } from "./photon/http.ts";
import type { InstallationClient } from "./photon/installations.ts";
import type { ProvisionReport, WebhookProvisioner } from "./photon/provisioner.ts";
import { TokenError, type TokenSource } from "./photon/token.ts";

export type CallbackOutcome =
  | { kind: "installed"; installation: InstallationRow; check: CheckResult; provision: ProvisionReport | null }
  | { kind: "not-delivered"; status: string; installationId?: string };

export type CheckResult =
  | { status: "active"; organizationId: string; organizationName: string }
  | { status: "inactive"; detail: string }
  /** Something else went wrong (network, 5xx): the stored status stands. */
  | { status: "unknown"; detail: string };

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Install, check and keep provisioning installations of this App. */
export function createInstallationService(options: {
  store: Store;
  dataKey: Buffer;
  installations: InstallationClient;
  tokens: TokenSource;
  api: PhotonApi;
  provisioner: WebhookProvisioner;
  log?: (line: string) => void;
}) {
  const { store, dataKey, tokens, api, provisioner } = options;
  const log = options.log ?? (() => {});

  const credentialOf = (row: InstallationRow) => ({
    clientId: row.client_id,
    clientSecret: open(dataKey, row.client_secret_sealed),
  });

  /**
   * Is the App still installed? A token that works and names its
   * organization means active. A refused credential, or a 401/403 from
   * Photon, means uninstalled or suspended.
   */
  async function check(row: InstallationRow): Promise<{ result: CheckResult; token?: string }> {
    try {
      const token = await tokens.token(credentialOf(row));
      const organization = await api.currentOrganization(token);
      store.setInstallationStatus(row.installation_id, "active", null, {
        id: organization.organizationId,
        name: organization.name,
      });
      return {
        result: { status: "active", organizationId: organization.organizationId, organizationName: organization.name },
        token,
      };
    } catch (error) {
      const gone =
        (error instanceof TokenError && error.refused) ||
        (error instanceof PhotonError && (error.status === 401 || error.status === 403));
      if (gone) {
        tokens.forget(row.client_id);
        store.setInstallationStatus(row.installation_id, "inactive", describe(error));
        if (row.status === "active") {
          provisioner.release(row);
          log(`installation ${row.installation_id}: now inactive (${describe(error)})`);
        }
        return { result: { status: "inactive", detail: describe(error) } };
      }
      log(`installation ${row.installation_id}: check failed (${describe(error)})`);
      return { result: { status: "unknown", detail: describe(error) } };
    }
  }

  async function checkAndProvision(installationId: string) {
    const row = store.getInstallation(installationId);
    if (!row) throw new Error(`Unknown installation ${installationId}`);
    const { result, token } = await check(row);
    let provision: ProvisionReport | null = null;
    if (result.status === "active" && token) {
      try {
        provision = await provisioner.ensure(store.getInstallation(installationId)!, token);
      } catch (error) {
        provision = { mode: provisioner.mode, summary: `Provisioning failed: ${describe(error)}`, projects: [] };
      }
    }
    return { installation: store.getInstallation(installationId)!, check: result, provision };
  }

  return {
    /** The install callback: redeem the code, keep the credential, then check and provision. */
    async completeInstall(code: string): Promise<CallbackOutcome> {
      const delivery = await options.installations.redeem(code);
      if (delivery.status !== "created" || !("clientSecret" in delivery)) {
        return { kind: "not-delivered", status: delivery.status, installationId: delivery.installationId };
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
      return { kind: "installed", ...(await checkAndProvision(delivery.installationId)) };
    },

    checkAndProvision,

    /** Periodic: every stored installation, so suspended ones are noticed when they resume. */
    async checkAll() {
      for (const row of store.listInstallations()) await checkAndProvision(row.installation_id);
    },
  };
}

export type InstallationService = ReturnType<typeof createInstallationService>;
