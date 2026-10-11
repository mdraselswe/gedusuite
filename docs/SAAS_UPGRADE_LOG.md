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

## Phase 3 — plans, billing, limits, platform admin ✅

Migration `20261013000000_plans_and_billing` (additive): `Subscription`,
`BillingInvoice`, three enums; **every existing workspace is given a `LEGACY`
subscription (unlimited, never expires)** so the original shop is untouched.

- **Plans in code** (`lib/plans.ts`): Starter ৳499, Business ৳1,299, Pro ৳2,999
  per month; yearly = ten months. Limits: members, orders/month, products,
  couriers; Pro adds the website connection. Prices/limits are one file.
- **Lifecycle is derived from dates, never from a cron**: trial → read-only at
  end; paid → 7-day grace → read-only; suspended/cancelled → read-only. A missed
  cron run cannot strand a workspace.
- **Read-only, not locked-out**: lapsed workspaces can still read, export,
  back up and pay. Nothing is hidden or deleted.
- **Enforcement is OFF until `BILLING_ENFORCEMENT=on`** and fails open on error.
  With it off, no check touches the database.
- **Where limits bite**: create order / product / courier, invite member, save
  website connection; plus a single write-gate inside `requireAccess`.
- **Payments (manual first)**: owner picks plan+cycle → payment request → pays
  by bKash/Nagad/bank → submits transaction ID → platform admin approves →
  subscription moves (early renewal extends from the current end). Same
  transaction ID cannot buy two invoices; two admins can't double-settle.
- **Platform admin**: `/admin` (tenants, plan, state, usage; set plan, +7/+30
  days, suspend/restore) and `/admin/payments`. Admins are an **env allow-list**
  (`PLATFORM_ADMIN_EMAILS`), checked in every action — no screen can create one.
- **Owner UI**: Settings → Plan & billing (usage vs limits, plans, history),
  trial/renewal banner.
- **Daily reminder cron** `/api/cron/billing` (3 days, 1 day, expiry, end of
  grace) — notification + email to owners; added to `vercel.json`.
- New workspaces start a 14-day Business trial. App-reserved slugs
  (`admin`, `pricing`, …) can't be taken by a workspace.

Verification: 17 + 2 new integration tests (limits, read-only reasons, grace,
LEGACY immunity, Pro-only website, payment flow, double-approval, trx reuse,
early renewal, rejection, admin allow-list, suspend/extend, trial on create,
reserved slug, reminder thresholds), 14 unit tests (lifecycle, pricing, dates).
Golden Master: the regenerated baseline equals the committed one except
`returns[].date`, which turned out to be wall-clock (DB `now()`); it is now
excluded from the comparison.

**Needs from you before deploy:** `BILLING_BKASH_NUMBER` / `BILLING_NAGAD_NUMBER`
/ `BILLING_BANK_DETAILS` (shown to customers), `PLATFORM_ADMIN_EMAILS` (your
address), and the decision of when to flip `BILLING_ENFORCEMENT=on` — keep it off
for the first deploy.

## Phase 4 — public site and onboarding ✅

No migration.

- **Public front door**: `/` shows the landing page to signed-out visitors and
  the workspace picker, unchanged, to signed-in ones. `/pricing`, `/terms`,
  `/privacy`, `/refund` are public.
- **Landing design**: the hero is one real order followed to the partners'
  shares, produced by the app's own `computeOrderTotals`, `depositAmount` and
  `splitByShare` — so the page that promises "one number, one place" is built
  from exactly that. Ink/paper palette, display face Bricolage Grotesque, a
  numbered five-step money path (a real sequence), plain-language FAQ.
- **Pricing** reads `lib/plans.ts`, so the page can never disagree with what is
  charged. Monthly/yearly toggle, comparison table.
- **Legal pages** are drafted text matching what the product actually does
  (read-only after grace, export, data held, providers). **They are a starting
  point, not legal advice — have them reviewed before launch.**
- **Sign-up** links Terms and Privacy.
- **Onboarding checklist** on the dashboard of a new workspace: product →
  purchase → first order, plus optional courier / partners / team / branding.
  Computed from the database; one indexed count hides it for every established
  shop (including the original one).
- **Help & support**: in-app page with a message form (emailed to
  `BILLING_SUPPORT_EMAIL`, falling back to the first platform admin), contact
  details, links.

Verification: 4 new integration tests (checklist progress, hides for
established shop, support mail contents, validation/tenant check). Whole suite
46 integration + 617 unit tests green; Golden Master unchanged; `tsc` clean;
landing rendered and checked in a browser.

**Needs from you:** `BILLING_SUPPORT_EMAIL` / `BILLING_SUPPORT_PHONE`; a lawyer's
pass over the three legal pages.

## Phase 5 — redesign (presentation layer only) ✅

No migration. **No file under `src/lib/**` financial logic or `src/server/**`
business logic was touched by the redesign** (the only server-side edits in this
phase are phases 3–4 features). Golden Master unchanged.

- **Design system through tokens**: `globals.css` palette (ink/paper/teal,
  radius, dark mode), the stored `indigo` preset now renders the brand teal
  (no data migration), Bricolage Grotesque for headings and figures, tabular
  numerals in cards and tables.
- **Shell**: dark ink sidebar with a single teal "you are here" marker; quiet
  icon chips instead of a dozen competing colours; mobile drawer to match.
- **PageHeader / StatTile**: sentence-case labels, display-face figures.
- **Fixes found while reviewing**: order filters showed the internal value
  `__all__` / `date_desc` in their closed state — now "All" / "Newest first";
  report KPI tiles showed bare `137110.00` — now ৳ with grouped digits (CSV/PDF
  exports unchanged).
- **Build safety (important)**: running the real `next build` caught two
  problems that `tsc` and the tests cannot — a non-async export in a `"use
  server"` file, and the new local-DB driver being pulled into the browser
  bundle. Both fixed. `tests/` and `scripts/` moved to `tsconfig.tests.json`
  (`yarn typecheck` runs both) so `next build`'s type-check fits its memory
  budget. **Do the production build before every deploy.**
- **Evidence**: `scripts/demo/shots.mjs` walks all 22 screens in a real browser
  at desktop and phone size against the production build: no HTTP 5xx, no
  console errors, no page errors.

Verification: `tsc` clean (app + tests), 617 unit + 46 integration tests green,
production `next build` succeeds.

## Phase 6 — courier providers ⚠️ partly done, on purpose

No migration.

- `lib/couriers/provider.ts`: the interface a second courier fills.
- `lib/couriers/pathao.ts`: a Pathao client (sign-in, book, status) with the
  documented request shapes, status mapping, and 4 tests against mocked
  responses.
- **Not wired into the booking screen.** The booking, status-sync and cash
  reconciliation paths are Steadfast-specific and move money; connecting a
  courier whose fee and COD behaviour could not be checked against a real
  (sandbox) account would put unverified numbers into the books. To finish:
  get Pathao sandbox credentials, book one parcel, compare the fee and COD with
  `quoteCourier` for the same order, then generalise `courier-booking.ts` and
  `courier-status-sync.ts` behind `CourierProvider`.

## Phase 7 — demo, verification, video ✅

- **Demo workspace** (`yarn demo:seed`): 90 days, ~250 orders, built through the
  app's own actions plus the real webhook path for website leads.
- **Integrity suite** over a generated business: treasury = in − out, no
  negative stock, every banked order's treasury entry equals what the courier
  remitted (signed), distributions lose no taka, order numbers gapless, report
  revenue equals an independent re-add.
- **Roles**: every role × 9 representative actions matches `rbac.ts` exactly;
  only owners change roles or remove members.
- **Tenant isolation**: a second workspace's owner, using valid ids from the
  first, changes nothing (status, payment, delete order/product/customer/
  treasury entry, change/remove member, bank cash).
- **Screens**: 22 screens × desktop/phone, production build, no 5xx/console
  errors. **Video**: 2m10s desktop walkthrough + phone clip, captioned.
- Final state: 621 unit + 59 integration tests green, `tsc` clean (app and
  tests), production `next build` succeeds.

## Independence pass ✅ (the product no longer knows about the first shop)

Migration `20261014000000_print_profile` (additive: `Workspace.printProfile`
JSONB; plus a guarded data update that carries the founding shop's old wording
across as data, selected by its own website and only where no profile is set).

Full list, with status of every dependency found: **docs/INDEPENDENCE_AUDIT.md**.
Highlights: gift tags and leaflet are per-workspace templates (settings form,
blank = not printed); no default website, mail sender, categories or courier
rates belong to one business; the WooCommerce combo plugin ships with the
product (same wire contract); one-off production scripts moved to
`scripts/legacy-gedushop/`; README/docs rewritten as a product;
**docs/DEPLOY_NEW_INSTANCE.md** for a separate Neon + Vercel + domain install.

Verification: 627 unit + 61 integration tests green, Golden Master unchanged,
`tsc` clean (app and tests), production `next build` succeeds, gift tag and
leaflet rendered from the demo workspace's own settings.

## Vivid theme & motion ✅ (presentation only)

- **Colour as wayfinding**: each section has its own hue — gradient chip in the
  sidebar, a soft glow behind that page's title, a coloured edge on its stat
  tiles, a coloured empty state. Vivid violet–blue primary with a brand gradient;
  deep indigo sidebar; two soft colour pools behind the content; glass header.
- **Motion**: pages rise in block by block, tile grids stagger, linked cards lift
  on hover, buttons press and carry a sheen, table rows light up, skeletons
  shimmer, header glows drift slowly. Everything stands down for
  `prefers-reduced-motion`.
- Landing page: drifting colour pools, gradient headline, coloured steps,
  gradient featured plan.
- No logic, no data, no financial code touched; Golden Master unaffected.
  22 screens × desktop/phone still load with no errors; production build passes.
