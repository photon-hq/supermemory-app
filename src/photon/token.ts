import type { Fetch } from "./http.ts";

/** Why the App's credential couldn't be exchanged for a token. */
export class TokenError extends Error {
  readonly status: number;
  /** The credential itself was refused: revoked on uninstall, or never valid. */
  readonly refused: boolean;

  constructor(status: number, oauthError: string | null) {
    super(`Token exchange failed: HTTP ${status}${oauthError ? ` ${oauthError}` : ""}`);
    this.name = "TokenError";
    this.status = status;
    this.refused = oauthError === "invalid_client" || oauthError === "unauthorized_client" || status === 401;
  }
}

export interface Credential {
  clientId: string;
  clientSecret: string;
}

interface Cached {
  token: string;
  expiresAt: number;
}

/** Refresh this long before Photon's token would expire. */
const EARLY_MS = 60_000;

/**
 * OAuth 2.0 client credentials: the App's M2M client secret is exchanged for
 * a short-lived bearer token, which is what Photon's API accepts. The secret
 * itself is never sent to a Photon business endpoint.
 */
export function createTokenSource(options: { tokenUrl: string; fetch?: Fetch; now?: () => number }) {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, Cached>();

  return {
    async token(credential: Credential): Promise<string> {
      const cached = cache.get(credential.clientId);
      if (cached && cached.expiresAt - EARLY_MS > now()) return cached.token;

      const response = await fetchImpl(options.tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: credential.clientId,
          client_secret: credential.clientSecret,
        }),
      });
      if (!response.ok) {
        let oauthError: string | null = null;
        try {
          const body = (await response.json()) as { error?: unknown };
          if (typeof body.error === "string") oauthError = body.error;
        } catch {
          // Not JSON.
        }
        cache.delete(credential.clientId);
        throw new TokenError(response.status, oauthError);
      }
      const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
      if (typeof body.access_token !== "string") throw new TokenError(response.status, "no_access_token");
      const lifetimeS = typeof body.expires_in === "number" ? body.expires_in : 300;
      cache.set(credential.clientId, { token: body.access_token, expiresAt: now() + lifetimeS * 1000 });
      return body.access_token;
    },

    forget(clientId: string) {
      cache.delete(clientId);
    },
  };
}

export type TokenSource = ReturnType<typeof createTokenSource>;
