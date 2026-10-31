import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { openStore } from "./db.ts";
import { createInstallationService } from "./installations.ts";
import { createPhotonApi } from "./photon/api.ts";
import { createAssertionSigner } from "./photon/assertion.ts";
import { createInstallationClient } from "./photon/installations.ts";
import { createTokenSource } from "./photon/token.ts";
import { createRelayWorker } from "./relay/worker.ts";
import { createSupermemoryClient } from "./relay/supermemory.ts";
import { createApp } from "./server.ts";

const WORKER_INTERVAL_MS = 15_000;
const HEALTH_INTERVAL_MS = 5 * 60_000;

// Ids, statuses and error summaries only: never assertions, codes, secrets,
// tokens or message content.
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const config = loadConfig();
const store = openStore(config.databasePath);
const sign = await createAssertionSigner({
  apiOrigin: config.photonApiOrigin,
  appId: config.appId,
  keyId: config.keyId,
  algorithm: config.keyAlgorithm,
  privateKeyPem: config.privateKeyPem,
});
const installClient = createInstallationClient({
  apiOrigin: config.photonApiOrigin,
  dashboardOrigin: config.photonDashboardOrigin,
  appId: config.appId,
  redirectUri: new URL("/callback", config.publicBaseUrl).href,
  sign,
});
const api = createPhotonApi({ apiOrigin: config.photonApiOrigin });
const worker = createRelayWorker({
  store,
  dataKey: config.dataKey,
  supermemory: createSupermemoryClient({ apiOrigin: config.supermemoryApiOrigin, apiKey: config.supermemoryApiKey }),
  onHold: (installationId) => void installations.recheck(installationId),
  log,
});
const installations = createInstallationService({
  store,
  dataKey: config.dataKey,
  installations: installClient,
  tokens: createTokenSource({ tokenUrl: config.photonTokenUrl }),
  api,
  onActive: () => void worker.kick(),
  log,
});

const app = createApp({
  store,
  dataKey: config.dataKey,
  sessionSecret: config.sessionSecret,
  secureCookies: new URL(config.publicBaseUrl).protocol === "https:",
  installClient,
  installations,
  webhookSecret: config.webhookSecret,
  onQueued: () => void worker.kick(),
  log,
});

const healthCheck = () =>
  installations.checkAll().catch((error) => log(`health check error: ${error instanceof Error ? error.message : String(error)}`));

setInterval(() => void worker.kick(), WORKER_INTERVAL_MS).unref();
setInterval(healthCheck, HEALTH_INTERVAL_MS).unref();
void healthCheck();

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  log(`supermemory-app on :${port}, events at ${new URL("/webhooks/photon", config.publicBaseUrl).href}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    store.close();
    process.exit(0);
  });
}
