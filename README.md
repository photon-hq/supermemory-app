# Supermemory App for Photon (experimental)

[ENG-4010](https://linear.app/photonhq/issue/ENG-4010/experimental-supermemory-app):
an installable **Photon App** that mirrors inbound messages in an
organization's projects to [Supermemory](https://supermemory.ai), as memories
of the person who sent each one. It's a demo of how an external system
integrates with Photon through Apps: an Owner or Admin installs it and approves
its permissions, and nobody pastes API keys into it.

**Not for real customer data.** Use a test organization and messages you
send yourself. Mirroring customers' messages to a third party needs a privacy
decision that hasn't been made.

## How Photon gets messages to it

Through **App event subscriptions**
([ENG-4110](https://linear.app/photonhq/issue/ENG-4110), on staging since
2026-10-24 and production since 2026-10-28). The design is written up in
Photon's App developer guide
([photon-hq/docs#126](https://github.com/photon-hq/docs/pull/126)).

- **The registration** declares one event webhook URL and the events the App
  wants, here `message.received`. That event needs the `messages:read`
  permission.
- **Installing:** an admin approves the App's permissions for **All projects**
  (including projects created later) or **Only selected projects**. Photon then
  delivers the subscribed events from those projects to the App's URL.
- **Pausing or uninstalling** in Integrations → Apps stops delivery, and so
  does removing a project from the App's access.
- **The App never creates webhooks itself**, and nobody creates them by hand.
- **Signing:** every delivery is signed with the App's one `whsec_…` secret.
  It carries a signed `app_installation_id` and `data.organizationId`, which
  is how the relay knows whose message it is.

(Before ENG-4110, this repo had a `manual` mode with hand-made project
webhooks, and an `app` mode in which the App tried to create them and Photon
refused. Both are gone.)

| Step | Status |
|---|---|
| Signed install request → admin approves in Photon → callback → redeem the one-time credential | Built and tested against fakes |
| Exchange the credential for a token; check it with `GET /v1/organizations/current` | Built; the token endpoint is confirmed on staging |
| Receive App deliveries, verify, route by installation, dedupe, store in Supermemory | Built and tested |
| Hold deliveries that arrive before the install callback finishes | Built and tested |
| Stop relaying when the App is suspended or uninstalled | Built and tested |
| **A run on staging** | Not yet: see below |

## How it works

```
Admin ──/install──▶ this service ──POST /v1/installation-requests (signed)──▶ Photon
  ◀── redirect to app.staging.photon.codes/organization/install?requestId=… ──┘
Admin approves (permissions + project access) ──▶ /callback?code&state
this service ──POST …/redeem (signed)──▶ installationId + clientId + clientSecret (once)
this service ──client_credentials──▶ token ──GET /v1/organizations/current──▶ active, bound to its organization

Photon (every project in the installation's scope) ──message.received──▶ /webhooks/photon
  verify (App secret) → check routing → queue once per (installation, event) → worker → Supermemory
  POST /ns/photon:<org>:<sender>/document { id: photon:<messageId>, content, group: { conversation } }
```

- **Assertions:** `@photon-hq/auth-api/installation-backend`, a fresh one per
  call, with the endpoint's full URL as audience. The install request's echoed
  `requestId`, `appId`, `state` and `redirectUri` are checked.
- **The credential:** stored AES-256-GCM sealed (`DATA_ENCRYPTION_KEY`). It's
  never retried or requested again. Redeem answers other than `created`
  carry nothing:
  - `delivery_consumed`: already handed over;
  - `recovery_required`: an admin repairs it in Photon;
  - `revocation_pending` / `revoked`: the installation is going or gone.

  The callback page explains each one.
- **Webhooks:** Standard Webhooks (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`), checked against the App's `whsec_` secret over the raw
  body. After that, the receiver requires:
  - `event.id` equals `webhook-id`;
  - a `pho_ain_` installation id, a `pho_org_` organization and a `pho_prj_`
    project;
  - the message belongs to that project.

  Anything else gets a 400. Other event types get a 204. Each delivery is
  queued once per `(app_installation_id, event.id)` and answered 202 right
  away. The queued body is sealed and dropped once handled.
- **Routing:** the worker relays a delivery only if its installation is
  active and bound to the organization the delivery names.
  - **Unknown installation** (Photon can deliver before the callback has
    stored the credential): the delivery waits. It goes out as soon as the
    install check binds the installation, and is dropped after 24 hours.
  - **Organization mismatch:** failed.
  - **Inactive installation:** skipped.
- **Supermemory:** v5 API. One namespace per sender
  (`photon:<organizationId>:<userId>`), grouped by conversation (space). The
  document id is the Photon message id, so a retry never adds a message
  twice. Messages without text (attachments, read receipts, typing) are
  skipped. The sender's handle (phone number or email) is not sent.
- **Health check** (every 5 minutes and after install): token +
  `/organizations/current`. If either is refused, the installation is marked
  inactive and its messages are skipped. Photon stops delivering to a paused
  or uninstalled App anyway; this catches what's already queued.
- **Retries:** Supermemory 429/5xx/409 back off (30s doubling, up to an hour,
  8 attempts). Other 4xx fail the delivery.

## Run it against staging

1. `pnpm install`. `@photon-hq/*` comes from GitHub Packages, so your
   `~/.npmrc` needs a valid token for `npm.pkg.github.com`.
2. `pnpm keygen`. This writes `supermemory-<date>.pem` (gitignored) and prints
   the public JWK.
3. Start a tunnel to `localhost:8787` (e.g. `cloudflared tunnel --url
   http://localhost:8787`). Its HTTPS URL is `PUBLIC_BASE_URL`.
4. In Photon staging, under Organization settings → Developer → Apps → New
   app, register (or edit the existing "Supermemory" App):

   | Field | Value |
   |---|---|
   | Name | Supermemory |
   | HTTPS callback | `PUBLIC_BASE_URL/callback` |
   | Public key | the JWK from step 2 |
   | Permissions | `organization:read`, `messages:read` |
   | Event webhook URL | `PUBLIC_BASE_URL/webhooks/photon` |
   | Subscribed events | `message.received` |
   | Event API version | `2026-07-01` |

   Put its `pho_app_…` id in `.env`. Then, under **Webhook signing secret**,
   click **Generate and reveal secret** and put the `whsec_…` value in
   `PHOTON_WEBHOOK_SECRET`. It's shown once.
5. Fill in the rest of `.env` from `.env.example` (`SUPERMEMORY_API_KEY`, and
   `openssl rand` for the two secrets), then run `pnpm dev`.
6. Open `PUBLIC_BASE_URL`, click **Install on Photon**, and approve as an
   Owner or Admin of the test organization. Give it access to a test project
   with a working line. The callback page shows the token check.

   An installation approved before the registration changed keeps its old
   approved configuration. Install again, or approve the update in
   Integrations → Apps.
7. Send a message to the test project's line. It should show up in
   Supermemory under `photon:<org>:<sender>`, and as `done` on the home page.
8. Suspend the App in Integrations → Apps: new messages stop arriving. Resume
   it, then uninstall: the next health check marks the installation inactive.

## Develop

```
pnpm test        # vitest: units + an end-to-end flow against fake Photon/Supermemory
pnpm typecheck
```

Node ≥ 24 runs the TypeScript directly (type stripping) and provides
`node:sqlite`. There's no build step. A database from before App
subscriptions is migrated on start: its installations are kept, and its old
deliveries and destinations are dropped.

Logs carry ids, statuses and error summaries only. Never log assertions,
codes, client secrets, webhook secrets, tokens or message content.
