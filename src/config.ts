import { readFileSync } from "node:fs";

export type ProvisionerMode = "manual" | "app";

/** A webhook destination someone created by hand in a Photon project. */
export interface ManualDestination {
  organizationId: string;
  projectId: string;
  /** The `whsec_…` signing secret Photon showed once when it was created. */
  secret: string;
}

export interface Config {
  port: number;
  /** Where Photon's API lives, e.g. https://api.staging.photon.codes */
  photonApiOrigin: string;
  /** Where Photon's dashboard lives; admins approve installs there. */
  photonDashboardOrigin: string;
  /** The OAuth token endpoint that turns the App's M2M credential into a bearer token. */
  photonTokenUrl: string;
  /** Payload version for webhook destinations this App creates itself. */
  photonWebhookApiVersion: string;
  appId: string;
  keyId: string;
  keyAlgorithm: "ES256" | "RS256";
  privateKeyPem: string;
  /** This service's public HTTPS origin: the install callback and the relay live under it. */
  publicBaseUrl: string;
  provisioner: ProvisionerMode;
  manualDestinations: Record<string, ManualDestination>;
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

function manualDestinations(raw: string | undefined): Record<string, ManualDestination> {
  if (!raw?.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MANUAL_DESTINATIONS must be a JSON object");
  }
  const result: Record<string, ManualDestination> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) {
      throw new Error(`MANUAL_DESTINATIONS key "${key}" must be 8–64 of [A-Za-z0-9_-]`);
    }
    const item = value as Partial<ManualDestination>;
    if (!item.organizationId || !item.projectId || !item.secret?.startsWith("whsec_")) {
      throw new Error(`MANUAL_DESTINATIONS["${key}"] needs organizationId, projectId and a whsec_ secret`);
    }
    result[key] = {
      organizationId: item.organizationId,
      projectId: item.projectId,
      secret: item.secret,
    };
  }
  return result;
}

export function loadConfig(env: Env = process.env): Config {
  const keyAlgorithm = (env.PHOTON_APP_KEY_ALG?.trim() || "ES256") as Config["keyAlgorithm"];
  if (keyAlgorithm !== "ES256" && keyAlgorithm !== "RS256") {
    throw new Error("PHOTON_APP_KEY_ALG must be ES256 or RS256");
  }
  const provisioner = (env.PROVISIONER?.trim() || "manual") as ProvisionerMode;
  if (provisioner !== "manual" && provisioner !== "app") {
    throw new Error("PROVISIONER must be manual or app");
  }
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
    photonWebhookApiVersion: env.PHOTON_WEBHOOK_API_VERSION?.trim() || "2026-07-01",
    appId: required(env, "PHOTON_APP_ID"),
    keyId: required(env, "PHOTON_APP_KEY_ID"),
    keyAlgorithm,
    privateKeyPem: readFileSync(required(env, "PHOTON_APP_PRIVATE_KEY_PATH"), "utf8"),
    publicBaseUrl: origin(env, "PUBLIC_BASE_URL"),
    provisioner,
    manualDestinations: manualDestinations(env.MANUAL_DESTINATIONS),
    supermemoryApiOrigin: origin(env, "SUPERMEMORY_API_ORIGIN", "https://api.supermemory.ai"),
    supermemoryApiKey: required(env, "SUPERMEMORY_API_KEY"),
    dataKey,
    sessionSecret,
    databasePath: env.DATABASE_PATH?.trim() || "data/supermemory-app.db",
  };
}
