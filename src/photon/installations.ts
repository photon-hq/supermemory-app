import type { AssertionSigner } from "./assertion.ts";
import { photonJson, type Fetch } from "./http.ts";

const REQUEST_PATH = "/v1/installation-requests";
const REDEEM_PATH = "/v1/installation-requests/redeem";

export interface InstallationRequest {
  requestId: string;
  appId: string;
  appVersion: string;
  redirectUri: string;
  state: string;
  createdAt: string;
}

/**
 * `created` is the only answer that carries the credential, and only once.
 * The others: `delivery_consumed` (already handed over), `recovery_required`
 * (an admin repairs it in Photon), `revocation_pending` and `revoked` (the
 * installation is going or gone).
 */
export type RedeemResult =
  | { status: "created"; installationId: string; clientId: string; clientSecret: string }
  | {
      status: "delivery_consumed" | "recovery_required" | "revocation_pending" | "revoked";
      installationId: string;
    };

export function createInstallationClient(options: {
  apiOrigin: string;
  dashboardOrigin: string;
  appId: string;
  redirectUri: string;
  sign: AssertionSigner;
  fetch?: Fetch;
}) {
  const fetchImpl = options.fetch ?? fetch;

  return {
    /** Asks Photon for an install; the admin approves it at the returned URL. */
    async request(state: string) {
      const request = await photonJson<InstallationRequest>(
        fetchImpl,
        "Create installation request",
        new URL(REQUEST_PATH, options.apiOrigin).href,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            appId: options.appId,
            clientAssertion: await options.sign(REQUEST_PATH),
            redirectUri: options.redirectUri,
            state,
          }),
        },
      );
      // Photon echoes what it recorded; anything else isn't our request.
      if (
        !request.requestId?.startsWith("pho_air_") ||
        request.appId !== options.appId ||
        request.state !== state ||
        request.redirectUri !== options.redirectUri
      ) {
        throw new Error("Photon's answer to the install request doesn't match what was sent");
      }
      const approveUrl = new URL("/organization/install", options.dashboardOrigin);
      approveUrl.searchParams.set("requestId", request.requestId);
      return { request, approveUrl: approveUrl.href };
    },

    /**
     * Swaps the callback's one-time code for the App's credential. Not retried
     * here: a lost "created" answer can't be fetched again, only repaired by an
     * admin, so a caller must never treat an ambiguous failure as "nothing happened".
     */
    async redeem(code: string) {
      return photonJson<RedeemResult>(
        fetchImpl,
        "Redeem installation code",
        new URL(REDEEM_PATH, options.apiOrigin).href,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            appId: options.appId,
            clientAssertion: await options.sign(REDEEM_PATH),
            code,
          }),
        },
      );
    },
  };
}

export type InstallationClient = ReturnType<typeof createInstallationClient>;
