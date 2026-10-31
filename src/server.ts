import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { randomToken, seal } from "./crypto.ts";
import type { Store } from "./db.ts";
import type { InstallationService } from "./installations.ts";
import { callbackPage, homePage, messagePage } from "./pages.ts";
import type { InstallationClient } from "./photon/installations.ts";
import { parseAppEvent, verifyWebhook, type AppDelivery } from "./relay/verify.ts";

const SESSION_COOKIE = "sm_session";
const STATE_TTL_MS = 15 * 60_000;
/** Far above any message event; anything bigger is refused before it's read or verified. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;

export interface AppDependencies {
  store: Store;
  dataKey: Buffer;
  sessionSecret: string;
  secureCookies: boolean;
  installClient: InstallationClient;
  installations: InstallationService;
  /** The App's `whsec_…` secret: Photon signs every App delivery with it. */
  webhookSecret: string;
  /** Called after a webhook is queued, to send it on without holding Photon's request. */
  onQueued: () => void;
  log?: (line: string) => void;
}

export function createApp(deps: AppDependencies) {
  const app = new Hono();
  const log = deps.log ?? (() => {});

  app.get("/healthz", (c) => c.text("ok"));

  app.get("/", (c) =>
    c.html(
      homePage({
        installations: deps.store.listInstallations(),
        deliveries: deps.store.deliveryCounts(),
      }),
    ),
  );

  // Start an install: a signed request to Photon, then off to Photon's
  // approval page. `state` is bound to this browser's session cookie.
  app.get("/install", async (c) => {
    let sessionId = await getSignedCookie(c, deps.sessionSecret, SESSION_COOKIE);
    if (!sessionId) {
      sessionId = randomToken();
      await setSignedCookie(c, SESSION_COOKIE, sessionId, deps.sessionSecret, {
        httpOnly: true,
        secure: deps.secureCookies,
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60,
      });
    }
    const state = randomToken();
    deps.store.saveState(state, sessionId, STATE_TTL_MS);
    try {
      const { approveUrl } = await deps.installClient.request(state);
      return c.redirect(approveUrl, 302);
    } catch (error) {
      log(`install request failed: ${error instanceof Error ? error.message : String(error)}`);
      return c.html(
        messagePage("Photon didn't take the install request", error instanceof Error ? error.message : "Unknown error", "bad"),
        502,
      );
    }
  });

  // Where Photon returns the admin: `code` and `state`, or an OAuth `error`.
  app.get("/callback", async (c) => {
    const { code, state, error } = c.req.query();
    if (error) {
      return c.html(
        messagePage(
          error === "access_denied" ? "Install cancelled" : "Install didn't finish",
          error === "access_denied" ? "Nothing was installed." : `Photon answered: ${error}`,
        ),
      );
    }
    const sessionId = await getSignedCookie(c, deps.sessionSecret, SESSION_COOKIE);
    if (!state || !sessionId || !deps.store.takeState(state, sessionId)) {
      return c.html(
        messagePage("This install link doesn't match", "Start the install again from this page, in the same browser.", "bad"),
        400,
      );
    }
    if (!code) return c.html(messagePage("No code from Photon", "Start the install again.", "bad"), 400);
    try {
      return c.html(callbackPage(await deps.installations.completeInstall(code)));
    } catch (err) {
      // Never retried: a lost credential is only recovered by an admin's repair.
      log(`redeem failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(
        messagePage(
          "Couldn't collect the App's credential",
          `${err instanceof Error ? err.message : "Unknown error"}. If Photon shows the App as installed, an Owner or Admin can repair it from Photon's Apps page.`,
          "bad",
        ),
        502,
      );
    }
  });

  // The App's event webhook. Photon delivers subscribed events from every
  // installation's projects here, signed with the App's one secret; the
  // signed `app_installation_id` says whose they are. Queued once per
  // installation and event (Photon's retries are no-ops), answered right away.
  const webhookBodyLimit = bodyLimit({ maxSize: MAX_WEBHOOK_BYTES, onError: (c) => c.body(null, 413) });
  app.post("/webhooks/photon", webhookBodyLimit, async (c) => {
    const rawBody = await c.req.text();
    const webhookId = c.req.header("webhook-id");
    let event: { type?: unknown };
    try {
      event = verifyWebhook(deps.webhookSecret, rawBody, {
        id: webhookId,
        timestamp: c.req.header("webhook-timestamp"),
        signature: c.req.header("webhook-signature"),
      }) as { type?: unknown };
    } catch {
      return c.body(null, 401);
    }
    if (event?.type !== "message.received") return c.body(null, 204);
    let delivery: AppDelivery;
    try {
      delivery = parseAppEvent(event, webhookId!);
    } catch (error) {
      log(`webhook ${webhookId}: refused (${error instanceof Error ? error.message : String(error)})`);
      return c.body(null, 400);
    }
    const queued = deps.store.enqueueDelivery({
      installationId: delivery.installationId,
      eventId: delivery.eventId,
      organizationId: delivery.organizationId,
      projectId: delivery.projectId,
      payloadSealed: seal(deps.dataKey, rawBody),
    });
    if (queued) deps.onQueued();
    return c.body(null, 202);
  });

  return app;
}
