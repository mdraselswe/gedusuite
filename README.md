# GeduSuite

A multi-tenant **small-business ERP**, built as a PWA — stock, orders, courier
money, cash and partner profit in one system that agrees with itself.

Originally built for **GeduShop** (baby products, Bangladesh), designed so any
business can register its own isolated Workspace on the same app.

## Why "ERP" and not "CRM"

ERP is the accurate label: the app covers a whole business's operations, not one
relationship with a customer. Customers and the call list are one module of
seven.

| Area | Modules |
|---|---|
| Inventory & procurement | Products, variants, Purchases, suppliers, stock, low-stock & expiry alerts |
| Order management | Sales orders, returns, invoices, Courier assignment and reconciliation |
| Finance | Treasury ledger, Spending, Internal purchases, Partner profit-sharing & distributions |
| CRM | Customers, Call list (WooCommerce lead → phone call → order) |
| Marketing | Boosting — ad campaigns with orders attributed back to the spend |
| Reporting | Dashboard, Reports, per-product profitability |
| Platform | Workspaces, Team roles (RBAC), Backup, PWA offline queue |

Two things a general ERP does not have, both there because of how this kind of
business actually runs:

- **Partner profit-sharing.** Small shops are jointly owned. The app tracks
  what each partner is owed, what has been distributed, and what is left.
- **Ad-spend attribution.** Facebook-driven commerce lives or dies on whether a
  campaign paid for itself, so orders carry their campaign and the reports net
  the spend off the profit.

## The one rule the money code follows

Every figure has exactly one place it is computed. An order's profit comes from
`orderNetProfit`, the courier's fee from `quoteCourier`, what the treasury
receives from `depositAmount` — so the orders list, the dashboard and the
reports cannot disagree about the same order. When a page shows a number that
another page also shows, it is the same function behind both.

## Docs

1. [`docs/PRD.md`](docs/PRD.md) — full business requirements
2. [`docs/TECH_SPEC.md`](docs/TECH_SPEC.md) — stack, data models, architecture
3. [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — phased build plan and current status
4. [`docs/HOSTING.md`](docs/HOSTING.md) — where it runs, the domains, and what moves with them

## Status

In production for GeduShop. Every module listed above is implemented, along
with authentication, role-based access, notifications, theming, i18n, the PWA
offline queue, and Google Sheets/JSON backups.

## Stack

Next.js 16 (App Router, TypeScript) · PostgreSQL (Neon) · Prisma 6 ·
NextAuth.js (Credentials + Google OAuth) · Tailwind CSS 4 + shadcn-style UI ·
Serwist service worker · Vitest · Vercel · Google Sheets/Drive API for backups

## Deployment

Runs on Vercel; production is `app.gedushop.com`. See
[`docs/HOSTING.md`](docs/HOSTING.md) for the domain setup and everything that
has to change together when it moves.

Required Production environment variables:

- `DATABASE_URL` — pooled Neon PostgreSQL URL
- `DIRECT_URL` — unpooled URL, used by migrations
- `NEXTAUTH_SECRET` — random secret string
- `NEXTAUTH_URL` — the production app URL. NextAuth's callbacks and the Drive
  OAuth `redirect_uri` are both built from it.

Optional, per feature:

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google sign-in and Drive backup
- `BACKUP_ENCRYPTION_KEY` — encrypts stored personal-backup refresh tokens
- `CRON_SECRET` — **required for the scheduled backups.** The cron endpoints
  refuse every request (503) while it is unset, so an unconfigured deployment
  has no open `/api/cron/*` routes. Must match the `Authorization: Bearer …`
  header Vercel Cron sends.
- `WP_URL`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET`, `WOO_WEBHOOK_SECRET`,
  `WOO_WORKSPACE_SLUG` — the WooCommerce link that fills the call list

### Migrations

The Vercel build command is `vercel-build`, which runs
[`scripts/vercel-build.mjs`](scripts/vercel-build.mjs): `prisma migrate deploy`,
then `prisma generate`, then `next build`.

Migrating inside the build is deliberate. Vercel prefers `vercel-build` over
`build` when both exist, so the migrate step that used to live in `build` never
ran on a deploy — and a deploy that got ahead of its migration shipped code
querying a column the database did not have. A failed migration now stops the
deploy instead of shipping the mismatch.

Preview builds carry no `DATABASE_URL`/`DIRECT_URL` of their own, so the
migrate step skips itself there rather than migrating whatever those happen to
resolve to.

To migrate by hand:

```bash
yarn db:deploy
```

## Development

```bash
yarn dev          # localhost:3000
yarn test         # vitest
yarn typecheck    # tsc --noEmit
```

The money math lives in `src/lib` (`orders.ts`, `order-cash.ts`, `courier.ts`,
`finance.ts`, `product-report.ts`) and is the part with tests. Change a figure
there and run `yarn test` before anything else.

If a route 404s in dev while the file plainly exists, delete `.next` and
restart — a stale build cache, not a routing bug.
