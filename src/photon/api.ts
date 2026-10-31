import { photonJson, type Fetch } from "./http.ts";

export interface CurrentOrganization {
  organizationId: string;
  name: string;
}

/** The Photon API calls this App makes, with the App's bearer token. */
export function createPhotonApi(options: { apiOrigin: string; fetch?: Fetch }) {
  const fetchImpl = options.fetch ?? fetch;
  const url = (path: string) => new URL(path, options.apiOrigin).href;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  return {
    /** The organization the token belongs to. Needs `organization:read`. */
    currentOrganization(token: string) {
      return photonJson<CurrentOrganization>(fetchImpl, "Read current organization", url("/v1/organizations/current"), {
        headers: auth(token),
      });
    },
  };
}

export type PhotonApi = ReturnType<typeof createPhotonApi>;
