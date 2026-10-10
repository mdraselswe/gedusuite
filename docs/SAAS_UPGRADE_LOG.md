# SaaS upgrade — phase log

Each phase ends with: typecheck clean, unit tests green, integration + Golden
Master green. Nothing here has been deployed.

## How to run everything locally

```bash
yarn db:local          # terminal 1: local Postgres (foreground)
yarn local:migrate     # once, and after each new migration
yarn local:dev         # the app, on the LOCAL database
yarn test              # unit tests (no database)
yarn test:integration  # real server actions + Golden Master (local database)
```

`.env.saas.local` holds the local settings. `.env.local` points at the
PRODUCTION database — nothing in this branch's tooling reads it.

## Phase 0 — safety net and local environment ✅

- Local Postgres 18 (embedded, UTF8) with all 70 existing migrations applying cleanly.
- `src/lib/prisma.ts`: non-`neon.tech` hosts use the plain `pg` adapter; Neon
  hosts take the original path unchanged.
- `scripts/dev/assert-safe-db.mjs`: integration tests refuse any non-local DB.
- Integration harness runs the real server actions with a mocked session.
- Golden Master: 70-day, ~120-order business built through the real actions;
  ~150 KB of figures (partner balances, capital, treasury, profit, reports,
  stock, inventory value, per-product reports) pinned in
  `tests/golden/baseline.json`. Two independent runs are byte-identical.
- CI workflow (typecheck + unit tests).
- Baseline recorded from code that differs from `main` only in `prisma.ts`'s
  adapter selection — no business logic.

## Phase 1 — security and account lifecycle ✅

Migration `20261011000000_account_security` (additive): `User.sessionsValidAfter`,
`RateLimit` table, and a backfill marking every existing user's email verified
so nobody is locked out.

- **Email confirmation**: sign-up mails a one-time link (hashed token, 24 h);
  the confirm page uses a button so mail scanners can't burn the token.
  Unverified accounts can use the app but cannot create workspaces; a banner
  offers "resend".
- **Password reset**: `/forgot-password` → mailed single-use link (30 min) →
  `/reset-password/[token]`. Never reveals whether an address is registered.
  A reset voids every older session cookie.
- **Throttling**: DB-backed fixed-window limits on sign-in (per account and per
  IP), sign-up, reset, workspace creation. Fails open.
- **Pre-hijack fix**: Google sign-in clears the password of a still-unverified
  account with the same address, so a pre-registered attacker password dies
  when the real owner arrives. Existing Google/password users are unaffected.
- **Removed members / role changes** take effect at once: `requireMembership`
  reads the database instead of the JWT snapshot (same query is reused for the
  email-verified banner, so no extra round trip).
- **Headers**: HSTS, nosniff, frame, referrer, permissions; CSP in report-only
  mode with a `/api/csp-report` sink.
- **Error reporting**: `reportError()` + `instrumentation.ts`; Sentry via HTTP
  envelope when `SENTRY_DSN` is set (no SDK).
- **Encryption key**: production warns when `BACKUP_ENCRYPTION_KEY` is unset.
- **Mailer**: Resend HTTP API; without `RESEND_API_KEY` mail goes to the log and
  an in-memory outbox (what the tests read).

Verification: 10 new integration tests (sign-up, confirm, single-use tokens,
purpose binding, expiry, reset, session void, throttle lockout/clear, rate
window, pre-hijack, verified account untouched, unverified Google profile
refused); 5 new unit tests; Golden Master unchanged; `tsc` clean.

**Needs from you before deploy:** `RESEND_API_KEY` + `MAIL_FROM` (a verified
sending domain); optionally `SENTRY_DSN`; a distinct `BACKUP_ENCRYPTION_KEY`
only if you also re-save stored credentials (changing it makes existing
encrypted courier/Google tokens unreadable).

## Phase 2 — multi-tenant integrations and backups ✅

Migration `20261012000000_workspace_integration` (additive): one new table.

- **Per-workspace website connection** (`WorkspaceIntegration`, secrets
  encrypted). `resolveWooConfig()`: the workspace's own saved connection, else
  the environment's — but only for the workspace named by `WOO_WORKSPACE_SLUG`
  (or for every workspace when that variable is unset, i.e. today's behaviour).
  The original shop therefore needs no change at all.
- **Settings → Website** (owner only): address + API keys, test connection,
  webhook URL/secret/beacon to paste into WooCommerce, regenerate, disconnect.
  Keys are never shown again; leaving a key blank keeps it.
- **Webhooks**: `/api/cron/woo-lead` and `/api/cron/abandoned-cart` untouched in
  behaviour (the shared logic moved to `lib/woo-webhook.ts`). New
  `/api/hooks/woo/[token]` and `/api/hooks/cart/[token]` for other workspaces:
  token selects the workspace, HMAC authenticates the body.
- **Callers updated** to take the workspace's config: catalogue search/link
  suggestions, combo push, combo drift check, order-status mirroring, lead sync.
  The catalogue cache is now per website.
- **GeduShop-specific content**: gift tags and the promo leaflet (fixed brand
  text, QR codes, WhatsApp number) are offered only on the original shop's
  workspace; other workspaces get no button and a 404 on the URL.
- **Off-site backups**: S3-compatible (R2/S3/B2) upload of an encrypted, gzipped
  snapshot after each scheduled JSON backup when `BACKUP_S3_*` is set. SigV4
  implemented without an SDK and verified against AWS's published example.
- **Backup cron**: least-recently-backed-up first, 45 s budget, remainder
  deferred to the next run (reported as `deferred`); expired rate-limit rows are
  purged nightly.
- **Data export**: already present (owner's "Download JSON backup"); unchanged.
- **Account deletion**: self-service, refused with the reason while the person
  is a workspace's only owner or a partner of record.

Verification: 12 new integration tests (config resolution, owner-only save,
encryption at rest, key retention on edit, legacy webhook still works, tenant
isolation on per-workspace webhooks, bad signature/unknown token/ping,
regeneration voids the old address, disconnect, account deletion rules); 3 unit
tests (SigV4 vs AWS vector, request shape, seal/open/tamper). Golden Master
unchanged; `tsc` clean; 602 unit tests green.

**Needs from you before deploy:**
- Nothing for GeduShop to keep working — it continues on the environment.
- Off-site backup: create an R2/S3 bucket and set `BACKUP_S3_ENDPOINT`,
  `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`
  (optional `BACKUP_S3_REGION`, default `auto`).
- Vercel cron runs once a day; with many tenants shorten the schedule in
  `vercel.json` (needs Pro for sub-daily).
