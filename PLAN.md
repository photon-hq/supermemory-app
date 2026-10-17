# Supermemory App — build plan (ENG-4010)

Linear: https://linear.app/photonhq/issue/ENG-4010/experimental-supermemory-app
Branch name if this becomes a repo: `kelly/eng-4010-experimental-supermemory-app`

Read ENG-4010's description and its comment thread before starting. They hold
the evidence behind every constraint below.

## Goal

An experimental, installable **Photon App** that mirrors every inbound message
in an organization's projects to [Supermemory](https://supermemory.ai) as
memories of the person who sent it. It exists to show how an external system
integrates with Photon through the **Apps** feature: an Owner or Admin installs
it and approves its permissions, and nobody pastes API keys into it.

## The one thing you cannot build yet

Photon's backend does not let an App reach messages. An installed App acts
with a service identity token (`serviceIdentityBearer`), and the staging API
refuses that token on:

- `GET /v1/projects/{id}/messages` (and `/messages/{messageId}`)
- `POST /v1/projects/{projectId}/metrics/query` (`message_events`)
- `/v1/projects/{projectId}/webhooks/destinations*`
- `POST /v1/projects/{projectId}/api-keys`

The backend fix is asked for in ENG-4010: accept App tokens on webhook
destinations, and have uninstall remove the webhook destinations an App
created. **Do not try to work around this** with account service keys
(`pho_ask_`). They act as a whole human account and cannot be scoped. Do not
change Photon's other repos either.

So build everything around that gap, with the gap behind one interface:

- **`manual` mode (works now):** a person creates a `message.received` webhook
  destination by hand in a test project's Webhooks page
  (`https://app.staging.photon.codes/<org>/<project>/webhooks`), pointing at
  this service's relay URL, and puts the signing secret in this service's
  config.
- **`app` mode (ready for when the backend lands):** after install, the App
  creates the destinations itself with its own token. Implement it fully, keep
  it off by default, and make it fail loudly and clearly on the expected
  401/403 today.

## What already exists (verified 2026-10-17)

- **The Apps feature on staging** (`https://app.staging.photon.codes`):
  - Developer → Apps (`/organization/developer/apps`): register an app (name,
    HTTPS callback, requested permissions, public signing keys). An app called
    `demo` (`pho_app_0vgf6mcpmx80qv6zjmqnxjwh21`) already exists. Register a
    new one named "Supermemory" for this.
  - Install page: `/organization/install?requestId=…`. Only an Owner or Admin
    can approve.
  - Installed apps: `/organization/apps`.
- **API base:** `https://api.staging.photon.codes`. The OpenAPI spec is in
  `../api-internal/openapi/staging.json`. Run `git -C ../api-internal pull`
  first; the local checkout is behind `origin/main`.
- **Install helper:** `@photon-hq/auth-api` (GitHub Packages:
  `@photon-hq:registry=https://npm.pkg.github.com`; copy the auth setup from
  `../dashboard-v2/.npmrc`, never commit a token). Its
  `@photon-hq/auth-api/installation-backend` export provides
  `createInstallationAssertion({ appId, audience, algorithm, keyId, privateKey })`.
  Its README, at
  `../dashboard-v2/node_modules/@photon-hq/auth-api/README.md`, shows the
  whole request → callback → redeem flow. Follow it exactly:
  - Make a fresh assertion for every call, retries included.
  - The audience is the full endpoint URL, e.g.
    `https://api.staging.photon.codes/v1/installation-requests`, and the
    redeem path gets its own assertion.
  - Generate `state` randomly, bind it to the browser session, and check it on
    the callback.
  - Redeem returns `clientId` and `clientSecret` once
    (`status: "created"`). Losing them means an admin has to run "repair". Do
    not retry blindly, and never log assertions, codes or credentials.
- **Typed client for everything else:** `@photon-hq/api-internal`
  (`photon.organizations.*`, `photon.projects.*`), or plain `fetch`.
- **Webhooks** follow the Standard Webhooks scheme: `webhook-id`,
  `webhook-timestamp` and `webhook-signature` headers, and a `whsec_…` signing
  secret. Use the `standardwebhooks` npm package to verify; don't hand-roll it.
  Event type: `message.received`. Get its payload schema with
  `GET /v1/projects/{id}/webhooks/event-types/message.received/schema` (with a
  project API key, or by reading it in the dashboard), and confirm it carries
  the message text, the sender, and the space/conversation id **before**
  designing the Supermemory mapping.

## Unknowns to settle early (write down what you find)

1. **M2M token exchange.** Redeem gives a WorkOS M2M `clientId` (`client_…`)
   and `clientSecret`. The secret must be exchanged for a short-lived access
   token before calling the API (`Authorization: Bearer <token>`). The
   dashboard's OAuth copy points to `POST /oauth2/token`, and staging's
   AuthKit domain is `https://valuable-sunset-13-staging.authkit.app`, so try
   `POST https://valuable-sunset-13-staging.authkit.app/oauth2/token` with
   `grant_type=client_credentials`. This is **unconfirmed**. Verify it with
   `GET /v1/organizations/current` (permission `organization:read`), which
   must return the installing organization. If it doesn't work, stop and
   record what you tried. Don't guess further.
2. **Supermemory's API.** Read its current docs and use its official SDK if
   there is one. You need: add a memory/document with content, a per-user
   container/tag, metadata, and an idempotency key or custom id. Don't rely
   on remembered endpoint names.
3. **The `message.received` payload**, as above.

## Architecture

One small TypeScript service (Node 24 + Hono is suggested, since
`@photon-hq/auth-api`'s types target Hono's `hc` client) with SQLite for
state. Keep it a single deployable process; this is a demo.

Routes:

| Route | Does |
|---|---|
| `GET /` | A plain page with an **Install on Photon** button and the list of installed organizations. |
| `GET /install` | Makes a signed installation request, stores `state` in the session, and redirects to Photon's `/organization/install?requestId=…`. |
| `GET /callback` | Checks `state`, redeems the code (on the server), and stores the credential encrypted. In `app` mode it then provisions webhooks. |
| `POST /webhooks/photon/:destinationKey` | Verifies the signature, deduplicates by `webhook-id`, keeps only inbound `message.received`, and queues it for Supermemory. |
| `GET /healthz` | Liveness. |

Modules (each unit-testable without the network):

- `photon/assertion.ts`: wraps `createInstallationAssertion` and loads the
  private key (PKCS#8 PEM from env/secret file).
- `photon/installations.ts`: makes the request, redeems, and stores
  credentials (secret encrypted at rest with a key from env).
- `photon/token.ts`: exchanges client credentials for a token and caches it
  until shortly before expiry.
- `photon/provisioner.ts`: `interface WebhookProvisioner { ensure(org): Promise<Destination[]>; remove(org): Promise<void> }`
  - `ManualProvisioner` reads destinations and secrets from config.
  - `AppProvisioner` lists projects (`organization:read_projects`) and creates
    a `message.received` destination in each one that lacks it (with an
    `Idempotency-Key`). It stores each signing secret, which is shown once.
- `relay/verify.ts`: Standard Webhooks verification, with a timestamp
  tolerance.
- `relay/map.ts`: turns a Photon message into a Supermemory memory. It's a
  pure function: content = message text; container = one per sender (e.g.
  `photon:<orgId>:<senderHandle or user id>`); metadata = org, project,
  space, platform, message id, timestamp; custom id = message id (so retries
  don't duplicate).
- `relay/supermemory.ts`: the client, with retry/backoff on 429/5xx.
- `db.ts`: tables `installations`, `destinations`, `deliveries`
  (`webhook-id` primary key, for dedupe), `oauth_states`.

Config (`.env.example`, never commit real values): `PHOTON_API_ORIGIN`,
`PHOTON_APP_ID`, `PHOTON_APP_KEY_ID`, `PHOTON_APP_PRIVATE_KEY_PATH`,
`PHOTON_APP_KEY_ALG` (`ES256` recommended), `PHOTON_TOKEN_URL`,
`PUBLIC_BASE_URL` (the HTTPS callback/relay origin; use a tunnel such as
`cloudflared` locally), `PROVISIONER=manual|app`, `MANUAL_DESTINATIONS`
(JSON: key → `{ orgId, projectId, secret }`), `SUPERMEMORY_API_KEY`,
`DATA_ENCRYPTION_KEY`, `SESSION_SECRET`.

## Steps

1. **Scaffold** `supermemory-app/` here: package.json, tsconfig, lint,
   vitest, `.env.example`, `.gitignore` (`.env`, `*.pem`, `*.db`), a README,
   and `git init`.
2. **Signing key:** a script that makes an ES256 key pair, writes the private
   PEM to a gitignored path, and prints the public JWK with a `kid` to paste
   into Developer → Apps.
3. **Register the App on staging** (by hand, in the dashboard): name
   "Supermemory", description, HTTPS callback `PUBLIC_BASE_URL/callback`, the
   public key, and permissions `organization:read`,
   `organization:read_projects`, `project:read`, `project:write`.
4. **Install flow** (`/install`, `/callback`) per the auth-api README.
   Done when a test organization's admin installs it, the credential is
   stored encrypted, and Photon's `/organization/apps` shows it Installed.
5. **Token exchange** (unknown 1). Done when `GET /v1/organizations/current`
   returns the test organization using the App's token.
6. **Relay in `manual` mode.** Create the webhook by hand in a test project,
   then verify, dedupe, map, and push to Supermemory. Done when a message
   sent to the test project's line shows up as a memory in Supermemory under
   the sender's container, exactly once, even if Photon retries.
7. **`AppProvisioner`.** Implement and unit-test it with a fake API, then run
   it once for real and record the actual staging response (expected: 401/403
   on `webhooks/destinations`) in the README and as a comment on ENG-4010.
   This is the proof the issue is blocked on.
8. **Uninstall handling.** Detect a revoked installation (token exchange or
   API calls start failing with an auth error), mark it inactive, and stop
   relaying for that organization. In `app` mode, remove its destinations
   while the token still works, if Photon ever notifies the app; record that
   no such notification exists today.
9. **README:** what it shows, how to run it locally with a tunnel, both
   provisioner modes, the blocked step with the evidence, and the data note
   below.

## Testing

- Unit: assertion options/audiences, state checking, the token cache, the
  provisioner (fake API), signature verification (valid, tampered, stale
  timestamp, rotated secret), the mapping (fixtures from the real payload
  schema), and dedupe.
- End to end on staging: install → token → manual webhook → message →
  memory. Write down the exact steps and results in the README.
- Never run against production (`app.beta.photon.codes`).

## Rules

- **Test data only:** use a test organization and test project, and messages
  you send yourself. Mirroring real customers' messages to a third party
  needs a privacy decision that hasn't been made.
- Never log or print assertions, install codes, client secrets, webhook
  secrets, tokens or message content outside debug fixtures.
- Don't create or use account service keys, and don't edit `dashboard-v2`,
  `api-internal` or any other repo under `photon/`. Changes Photon needs go
  to ENG-4010 as comments.
- Before calling it done, report: what works, the recorded 401/403 from
  step 7, the answers to the three unknowns, and anything you couldn't
  verify.
