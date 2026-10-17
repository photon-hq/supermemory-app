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

## What works, and what Photon doesn't allow yet

| Step | Status |
|---|---|
| Signed install request → admin approves in Photon → callback → redeem the one-time credential | Built and tested against fakes; needs a run on staging |
| Exchange the App's M2M credential for a token; check it with `GET /v1/organizations/current` | Built; **token endpoint unconfirmed** (see below) |
| Receive `message.received` webhooks, verify, dedupe, store in Supermemory | Built and tested |
| Stop relaying when the App is uninstalled or suspended | Built and tested |
| **The App creating its own webhooks** (`PROVISIONER=app`) | Built, but **Photon refuses an App's token** on `/webhooks/destinations` today. That's the ENG-4010 block |

So the service has two ways of getting webhooks pointed at it, behind one
interface (`src/photon/provisioner.ts`):

- **`manual`** (works today): someone creates a `message.received` webhook by
  hand in the project's Webhooks page and lists it in `MANUAL_DESTINATIONS`.
  The App still has to be installed in that organization: messages are only
  relayed while its installation is active.
- **`app`** (for when the backend lands): after install, the App lists the
  organization's projects and creates a destination in each, with its own
  token. Today every project comes back `refused` (HTTP 401/403), and the
  install page says so.

## How it works

```
Admin ──/install──▶ this service ──POST /v1/installation-requests (signed)──▶ Photon
  ◀── redirect to app.staging.photon.codes/organization/install?requestId=… ──┘
Admin approves in Photon ──▶ /callback?code&state ──POST …/redeem (signed)──▶ clientId + clientSecret (once)
this service ──client_credentials──▶ token ──GET /v1/organizations/current──▶ active

Photon project ──message.received webhook──▶ /webhooks/photon/:key
  verify signature → queue once per webhook-id → worker → Supermemory
  POST /ns/photon:<org>:<sender>/document { id: photon:<messageId>, content, group: { conversation } }
```

- **Assertions:** `@photon-hq/auth-api/installation-backend`, a fresh one per
  call, with the endpoint's full URL as audience.
- **The credential:** stored AES-256-GCM sealed (`DATA_ENCRYPTION_KEY`). It
  is never retried or re-requested. If it's lost, an admin repairs the
  installation in Photon.
- **Webhooks:** Standard Webhooks (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`, `whsec_` secrets). Each delivery is queued once per
  `webhook-id` and answered with 202 right away. The queued body is sealed
  and dropped once handled.
- **Supermemory:** v5 API. One namespace per sender
  (`photon:<organizationId>:<userId>`), grouped by conversation (space). The
  document id is the Photon message id, so a retry never adds a message
  twice. Messages without text (attachments, read receipts, typing) are
  skipped. The sender's handle (phone number or email) is not sent.
- **Health check** (every 5 minutes and after install): token +
  `/organizations/current`. If either is refused, the installation is marked
  inactive and its messages are skipped. In `app` mode the check also adds
  destinations for new projects.
- **Retries:** Supermemory 429/5xx/409 back off (30s doubling, up to an hour,
  8 attempts). Other 4xx fail the delivery.

## Unknowns

1. **The token endpoint.** Redeem returns a WorkOS M2M `clientId`
   (`client_…`) and secret. Photon's API takes a bearer token, so the secret
   is exchanged with `grant_type=client_credentials` at `PHOTON_TOKEN_URL`
   (default: staging AuthKit's `/oauth2/token`). This hasn't been run against
   staging yet. The install page shows the result of the
   `/organizations/current` check, which confirms or refutes it on the first
   install.
2. **Callback parameters.** The code assumes `code` and `state` on success
   and the OAuth `error=access_denied` on cancel, per Photon's spec for the
   return route.

## Run it against staging

1. `pnpm install`. `@photon-hq/*` comes from GitHub Packages, so your
   `~/.npmrc` needs a token for `npm.pkg.github.com`.
2. `pnpm keygen`. This writes `supermemory-<date>.pem` (gitignored) and prints
   the public JWK.
3. Start a tunnel to `localhost:8787` (e.g. `cloudflared tunnel --url
   http://localhost:8787`). Its HTTPS URL is `PUBLIC_BASE_URL`.
4. In Photon staging, under Organization settings → Developer → Apps → New
   app, register:
   - **Name:** "Supermemory"
   - **HTTPS callback:** `PUBLIC_BASE_URL/callback`
   - **Public key:** the JWK from step 2
   - **Permissions:** `organization:read`, `organization:read_projects`,
     `project:read`, `project:write`

   Put its `pho_app_…` id in `.env`.
5. For `manual` mode, in a test project's Webhooks page, create a destination:
   - **URL:** `PUBLIC_BASE_URL/webhooks/photon/<some-key>`
   - **Event:** `message.received`
   - **API version:** `2026-07-01`

   Then add `<some-key>` → `{organizationId, projectId, secret}` to
   `MANUAL_DESTINATIONS`.
6. Fill in the rest of `.env` from `.env.example` (`SUPERMEMORY_API_KEY`, and
   `openssl rand` for the two secrets), then run `pnpm dev`.
7. Open `PUBLIC_BASE_URL`, click **Install on Photon**, and approve as an
   Owner or Admin of the test organization. The callback page shows the token
   check and the webhook outcome.
8. Send a message to the test project's line. It should show up in
   Supermemory under `photon:<org>:<sender>`, and as `done` on the home page.

To record the ENG-4010 evidence, set `PROVISIONER=app` and install again (or
wait for the health check). The callback page lists each project as `refused`
with Photon's status and code.

## Develop

```
pnpm test        # vitest: units + an end-to-end flow against fake Photon/Supermemory
pnpm typecheck
```

Node ≥ 24 runs the TypeScript directly (type stripping) and provides
`node:sqlite`. There's no build step.

Logs carry ids, statuses and error summaries only. Never log assertions,
codes, client secrets, webhook secrets, tokens or message content.
