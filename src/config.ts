import { readFileSync } from "node:fs";

export interface Config {
  port: number;
  /** Where Photon's API lives, e.g. https://api.staging.photon.codes */
  photonApiOrigin: string;
  /** Where Photon's dashboard lives; admins approve installs there. */
  photonDashboardOrigin: string;
  /** The OAuth token endpoint that turns the App's M2M credential into a bearer token. */
  photonTokenUrl: string;
  /**
   * The App's `whsec_…` webhook signing secret, revealed once on its
   * Developer → Apps page. One per App, shared by all its installations.
   */
  webhookSecret: string;
  appId: string;
  keyId: string;
  keyAlgorithm: "ES256" | "RS256";
  privateKeyPem: string;
  /** This service's public HTTPS origin: the install callback and the relay live under it. */
  publicBaseUrl: string;
  supermemoryApiOrigin: string;
  supermemoryApiKey: string;
  /** 32 bytes, base64: encrypts credentials and queued messages at rest. */
  dataKey: Buffer;
  sessionSecret: string;
  databasePath: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function origin(env: Env, name: string, fallback?: string): string {
  const raw = env[name]?.trim() || fallback;
  if (!raw) throw new Error(`${name} is required`);
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`${name} must be https`);
  }
  return url.origin;
}

export function loadConfig(env: Env = process.env): Config {
  const keyAlgorithm = (env.PHOTON_APP_KEY_ALG?.trim() || "ES256") as Config["keyAlgorithm"];
  if (keyAlgorithm !== "ES256" && keyAlgorithm !== "RS256") {
    throw new Error("PHOTON_APP_KEY_ALG must be ES256 or RS256");
  }
  const webhookSecret = required(env, "PHOTON_WEBHOOK_SECRET");
  if (!webhookSecret.startsWith("whsec_")) throw new Error("PHOTON_WEBHOOK_SECRET must be the App's whsec_ secret");
  const dataKey = Buffer.from(required(env, "DATA_ENCRYPTION_KEY"), "base64");
  if (dataKey.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes, base64");
  const sessionSecret = required(env, "SESSION_SECRET");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");

  return {
    port: Number(env.PORT ?? 8787),
    photonApiOrigin: origin(env, "PHOTON_API_ORIGIN", "https://api.staging.photon.codes"),
    photonDashboardOrigin: origin(env, "PHOTON_DASHBOARD_ORIGIN", "https://app.staging.photon.codes"),
    photonTokenUrl: new URL(
      env.PHOTON_TOKEN_URL?.trim() ||
        "https://valuable-sunset-13-staging.authkit.app/oauth2/token",
    ).href,
    webhookSecret,
    appId: required(env, "PHOTON_APP_ID"),
    keyId: required(env, "PHOTON_APP_KEY_ID"),
    keyAlgorithm,
    privateKeyPem: readFileSync(required(env, "PHOTON_APP_PRIVATE_KEY_PATH"), "utf8"),
    publicBaseUrl: origin(env, "PUBLIC_BASE_URL"),
    supermemoryApiOrigin: origin(env, "SUPERMEMORY_API_ORIGIN", "https://api.supermemory.ai"),
    supermemoryApiKey: required(env, "SUPERMEMORY_API_KEY"),
    dataKey,
    sessionSecret,
    databasePath: env.DATABASE_PATH?.trim() || "data/supermemory-app.db",
  };
}
