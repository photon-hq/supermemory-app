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

/** `status: "created"` is the only answer that carries the credential, and only once. */
export type RedeemResult =
  | { status: "created"; installationId: string; clientId: string; clientSecret: string }
  | { status: string; installationId?: string };

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
