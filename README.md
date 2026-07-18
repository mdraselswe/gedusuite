# GeduSuite

A multi-tenant business management PWA — inventory/purchases, sales, multi-partner
finance & treasury, reporting, and automatic Google Sheets + JSON backups.

Originally built for **GeduShop** (baby products business), designed so any
business can register its own isolated Workspace on the same app.

## Stack

Next.js 16 (App Router, TypeScript) · PostgreSQL (Neon) · Prisma 6 ·
NextAuth.js (Credentials + Google OAuth) · Tailwind CSS v4 + shadcn/ui ·
Serwist (PWA / service worker) · hosted free on Vercel.

> The tech spec targeted Next.js 14; this scaffold uses the current Next.js 16 +
> React 19 + Tailwind v4. PWA uses **Serwist** (the maintained successor to
> `next-pwa`, which does not support the App Router on Next 15/16).

## Phase 0 — what's built

- Email/password + Google OAuth sign-in (`/login`, `/register`).
- Workspace registration — a new user creates a Workspace and becomes its **OWNER**
  (`/workspaces/new`).
- Team invites with roles OWNER / PARTNER / MANAGER / STAFF
  (`/[workspace]/settings/team`); invite links are shown in-app (no email service yet)
  and accepted at `/invite/[token]`.
- Middleware scopes every request to the current workspace and enforces the RBAC
  matrix from `docs/TECH_SPEC.md` section 5 (`src/lib/rbac.ts`).
- PWA basics: web manifest, service worker, and an install prompt.

## Phase 1 — what's built

- Supplier master list CRUD (`/[workspace]/products` → Suppliers tab).
- Product CRUD with category, SKU/barcode, image (stored as a data URI for now),
  low-stock threshold, expiry tracking, and size/color variants
  (`/[workspace]/products` → Products tab).
- Purchase entry (`/[workspace]/purchases`): product/variant + supplier select,
  date, unit cost, quantity, expiry date (shown when the product tracks expiry).
  Stock is derived from purchase quantities per variant.
- Low-stock and expiry-approaching alerts — reconciled into `Notification` rows and
  shown as a banner on the dashboard (`src/lib/inventory.ts`).
- All product/purchase actions are gated by the Phase 0 RBAC matrix
  (STAFF add-only, MANAGER/PARTNER edit, OWNER full).

> Product images are stored inline as data URIs (Prisma `imageUrl`). Fine for a
> small catalog; move to blob storage (Vercel Blob / S3) if the catalog grows.

## Phase 2 — what's built

- Customer CRUD with search (`/[workspace]/customers`) and a per-customer order-history
  page (`/[workspace]/customers/[id]`) with lifetime value.
- Multi-item order entry (`/[workspace]/sales/orders`): per-line price/qty/discount,
  delivery type + charge, packaging/gift/order discount, payment method + status,
  and which partner holds the cash (`heldByMembershipId`).
- Order status flow Pending → Confirmed → Shipped → Delivered → Cancelled (inline).
- Returns/refunds per order line; damaged/returned units restore stock.
- **Stock is fully derived** (`src/lib/inventory.ts`): `purchased − sold + returned`,
  where "sold"/"returned" only count orders in a consuming status
  (Confirmed/Shipped/Delivered). Confirming an order decrements stock; cancelling
  restores it — no stored stock column to drift.
- **All money math is server-side** (`src/lib/orders.ts`): unit cost is snapshotted
  from the latest purchase at sale time; profit = sale − cost − packaging − discount −
  gift, computed on returns-adjusted quantities. Profit columns are shown only to
  roles with `reports` view.

## Phase 3 — what's built

- `Partner`, `PartnerTxn`, `TreasuryEntry` models + enums.
- Partners (`/[workspace]/partners`): promote a member to partner, set profit-share %,
  per-partner ledger (`/[workspace]/partners/[id]`) with a transaction log
  (investment / expense / withdrawal / deposit-to-treasury). Balances (invested,
  withdrawn, expenses, net capital) are **derived from the txn log**, never stored.
- Central Treasury (`/[workspace]/treasury`): running balance = IN − OUT, manual
  entries, filter by direction/partner. A `DEPOSIT_TO_TREASURY` partner txn
  auto-creates a linked IN entry (deleting the txn cascades the entry).
- Overdue receivables: orders unpaid/partial past 7 days are flagged with the amount
  and which partner holds the cash — surfaced on the treasury page and dashboard,
  reconciled into `OVERDUE_PAYMENT` notifications.
- Partner-wise profit share on the dashboard: `profitSharePercent × total business
  net profit` (net profit summed from Phase 2 orders).
- RBAC: partner finance is OWNER-full / PARTNER add-own (row-level) / MANAGER view /
  STAFF none; treasury is OWNER-full / PARTNER+MANAGER view / STAFF none.

## Phase 4 — what's built

- `InternalPurchase` model + `ExpenseCategory` enum (office supplies / packaging /
  equipment / utilities / other) — deliberately separate from the sales-product
  `Purchase` model, no shared references.
- CRUD at `/[workspace]/internal-purchases`: date, item, description, supplier/shop,
  unit cost, quantity, category; category filter + total-spend summary.
- RBAC-gated by the `internal-purchases` module (STAFF add / MANAGER+PARTNER edit /
  OWNER full).

## Phase 5 — what's built

- Reports (`/[workspace]/reports`, gated by `reports` view): custom date-range filter,
  KPI cards (revenue / net profit / orders / avg order), a Recharts sales-&-profit-by-day
  bar chart, best-selling + slow-moving product tables, and partner profit-share
  (`src/lib/reports.ts`).
- Exports: native **Excel (.xlsx)** via SheetJS and **PDF** via jsPDF + autotable.
- Printable **invoice/receipt** per order (`/[workspace]/sales/orders/[id]/invoice`),
  linked from the orders list.
- **Notification center** (`/[workspace]/notifications`) listing all workspace
  notifications with mark-read / mark-all-read, plus an unread bell badge in the header.
  Wires up the `Notification` records created in Phases 1 & 3 (low stock, expiry,
  overdue payment, new order).

## Phase 6 — what's built

- `BackupLog` + `BackupSetting` models; Settings › Backup page
  (`/[workspace]/settings/backup`, `backup` module — OWNER full / PARTNER view).
- **JSON backup** ("Backup Now"): serializes the full workspace (suppliers, products,
  variants, purchases, customers, orders, items, returns, partners, partner txns,
  treasury, internal purchases) to a downloadable JSON file, logged to `BackupLog`
  (last 10 snapshots kept in-DB for recoverability). `src/lib/backup.ts`.
- **Restore**: upload JSON → validate + preview per-table counts → choose **Merge**
  (insert new ids only) or **Overwrite** (clear + replace) → a safety snapshot is taken
  automatically first → applied in one transaction (FK-safe order; dangling member/user
  refs nulled/skipped).
- **Google Sheets sync** + **Drive JSON upload** via `googleapis` (`src/lib/google.ts`),
  one human-readable tab per module. **Env-gated**: set `GOOGLE_SERVICE_ACCOUNT_JSON`
  (full service-account key) and share the target Sheet/Drive folder with that
  account's email. Without it the UI shows "Not configured" and JSON backup/restore
  still work.
- Every backup/restore is written to `BackupLog` (success/failed); failures raise a
  `GENERAL` notification so the Owner sees them.
- **Scheduled backups**: `vercel.json` runs `/api/cron/backup` daily (02:00) — it JSON-
  backs-up every workspace with `autoJson` enabled (optionally to Drive), protected by
  `CRON_SECRET`. Google Sheet tabs are created as **protected ranges** (view-only).

## Environment (updated)

```bash
DATABASE_URL="postgresql://…"
NEXTAUTH_SECRET="…"
NEXTAUTH_URL="http://localhost:3000"
GOOGLE_CLIENT_ID="…"            # NextAuth Google sign-in
GOOGLE_CLIENT_SECRET="…"
# Optional — enables Sheets/Drive backup (Phase 6):
GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
```

## Phase 7 — what's built

- **Theming**: light/dark/system via `next-themes` + four color presets
  (indigo/green/rose/amber) as CSS-variable overrides (`html[data-preset]`). Saved
  **per user** (`User.theme`/`colorPreset`) and applied server-side (no flash) from
  the root layout. Settings › Appearance (`/[workspace]/settings/appearance`).
- **Bangla / English**: `User.locale` + a dictionary (`src/lib/i18n.ts`); the app
  shell (nav) is translated server-side, toggled from Appearance. The dictionary is
  scaffolding — extend `en`/`bn` together to localize more strings.
- **Offline**: offline indicator banner + service-worker document fallback (`/offline`),
  plus an **offline write queue** — mutations made offline are stored in IndexedDB
  (`src/lib/offline-queue.ts`) and replayed against `/api/mutations` on reconnect
  (`OutboxSync`). Wired for purchase and customer creation; other forms adopt it by
  calling `submitOrQueue(actionType, slug, payload)` (dispatcher map in
  `src/app/api/mutations/route.ts`).
- **Search** added to Products, Suppliers, and Orders lists (Customers, Treasury,
  Internal already had search/filter).
- **Bangla/English** now covers the app shell + every page title (server-translated via
  session locale); form/table strings are localized incrementally via the same
  dictionary (`t()` from `usePreferences()` / `serverT()`).

## Post-plan additions

- **Stock adjustments / damaged report** (`StockAdjustment` model): record
  damaged / lost / gift / correction against a variant; feeds the derived stock
  (`Products › Stock adjustments` tab) and is included in JSON backup/restore.
- `CRON_SECRET` env var (optional) — protects the scheduled backup route.

## Deployment (Vercel + Neon, free tier)

1. **Neon**: create a project, copy the pooled connection string → this is
   `DATABASE_URL`. (Migrations run automatically on deploy — the `build` script runs
   `prisma migrate deploy` before `next build`.)
2. **Vercel**: "Add New… → Project", import the GitHub repo. Framework preset is
   detected as Next.js. No `vercel.json` is needed.
3. **Environment variables** (Vercel → Project → Settings → Environment Variables),
   set for Production (and Preview):
   - `DATABASE_URL` — Neon pooled string
   - `NEXTAUTH_SECRET` — `openssl rand -base64 32`
   - `NEXTAUTH_URL` — `https://suite.gedushop.com` (your production URL)
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — from the Google Cloud OAuth client;
     add `https://suite.gedushop.com/api/auth/callback/google` as an authorized redirect
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — optional, for Sheets/Drive backup
4. **Deploy**. Every push to the default branch ships; each PR gets a preview URL.
5. **Custom domain**: Vercel → Domains → add `suite.gedushop.com`. In Hostinger's DNS
   Zone Editor add a `CNAME` record `suite` → `cname.vercel-dns.com`. Vercel issues the
   HTTPS certificate automatically. Update `NEXTAUTH_URL` and the Google redirect URI to
   the final domain.

> Build uses webpack (`next build --webpack`) because Serwist (PWA) doesn't support
> Turbopack yet — this is already wired into the `build` script, nothing to configure
> on Vercel.

## Prerequisites

- Node.js 20+ (tested on 22)
- A PostgreSQL database (Neon free tier)
- A Google Cloud OAuth client (Client ID + Secret) with
  `http://localhost:3000/api/auth/callback/google` as an authorized redirect URI

## Environment

Create `.env.local` in the project root:

```bash
DATABASE_URL="postgresql://…"            # Neon connection string (pooled)
NEXTAUTH_SECRET="…"                       # openssl rand -base64 32
NEXTAUTH_URL="http://localhost:3000"
GOOGLE_CLIENT_ID="…"
GOOGLE_CLIENT_SECRET="…"
```

## Setup & running

```bash
npm install                 # also runs `prisma generate` via postinstall

# Create/apply database migrations to your DATABASE_URL:
npm run db:migrate          # dev: creates a migration + applies it
# or, to push the schema without a migration history:
npm run db:push

npm run dev                 # start the dev server at http://localhost:3000
```

Other useful scripts:

```bash
npm run typecheck           # tsc --noEmit
npm run build               # production build (also builds the service worker)
npm run start               # run the production build
npm run db:studio           # open Prisma Studio
```

> The service worker is **disabled in development** (so hot-reload isn't fighting a
> cached shell). To test PWA install/offline behavior, run `npm run build && npm run start`.

## Project layout

```
prisma/schema.prisma              Data models (Workspace, User, Membership, Invite + NextAuth tables)
src/lib/auth.ts                   NextAuth options (Credentials + Google, JWT sessions)
src/lib/rbac.ts                   Permission matrix + access helpers
src/lib/session.ts                requireUser / requireMembership helpers
src/middleware.ts                 Workspace scoping + role gating
src/server/actions/*              Server actions: register, create workspace, invites
src/app/[workspace]/*             Workspace-scoped routes (dashboard, settings/team, …)
src/app/sw.ts                     Serwist service worker source
```

## Docs

1. [`docs/PRD.md`](docs/PRD.md) — business requirements
2. [`docs/TECH_SPEC.md`](docs/TECH_SPEC.md) — stack, data models, architecture
3. [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — phased build plan
