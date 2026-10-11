# GeduSuite

A multi-tenant **small-business ERP** for online shops, built as a PWA — stock,
orders, courier money, cash and partner profit in one system that agrees with
itself. Each business gets its own isolated workspace; plans, billing and an
admin console are built in so it can be run and sold as a service.

| Area | Modules |
|---|---|
| Inventory & procurement | Products, variants, combos, purchases, suppliers, stock, low-stock & expiry alerts |
| Order management | Sales orders, returns, invoices, courier booking and reconciliation |
| Finance | Treasury ledger, spending, internal purchases, partner capital & profit distribution |
| CRM | Customers, follow-ups, call list (website order → phone call → order) |
| Marketing | Boosting — ad campaigns with orders attributed back to the spend |
| Reporting | Dashboard, reports, per-product profitability |
| Platform | Workspaces, roles & permissions, backups (JSON, Drive, off-site), offline queue |
| SaaS | Free trial, plans & limits, manual (bKash/Nagad/bank) billing, platform admin, support |

## The one rule the money code follows

Every figure has exactly one place it is computed. An order's profit comes from
`orderNetProfit`, the courier's fee from `quoteCourier`, what the treasury
receives from `depositAmount` — so the orders list, the dashboard and the
reports cannot disagree. A Golden Master test pins the whole set of figures for
a generated business and fails on a single taka of difference.

## Everything is per workspace

Nothing about one business is built into the code or the deployment:

| What | Where it lives |
|---|---|
| Shop name, logo, website | Settings → Appearance |
| Gift tags, leaflet wording, social links | Settings → Appearance → Printed extras |
| Invoice and order-form branding | the workspace's name, logo and website |
| Couriers, zones, rates, API keys (encrypted) | Couriers |
| WooCommerce site, keys, webhooks (encrypted) | Settings → Website |
| Team, roles, per-person permissions | Settings → Team |
| Plan, limits, payments | Settings → Plan & billing |
| Invoice numbers | workspace slug + order number |

Deploying a second, separate copy of the product needs no code change — see
[`docs/DEPLOY_NEW_INSTANCE.md`](docs/DEPLOY_NEW_INSTANCE.md).

## Stack

Next.js 16 (App Router, TypeScript) · PostgreSQL · Prisma 6 · NextAuth.js
(Credentials + Google) · Tailwind CSS 4 + shadcn-style UI · Serwist (PWA) ·
Vitest · Playwright · Vercel + Neon.

## Docs

| | |
|---|---|
| [`docs/DEPLOY_NEW_INSTANCE.md`](docs/DEPLOY_NEW_INSTANCE.md) | stand up an independent production deployment |
| [`docs/RUN_DEMO_AND_DEPLOY.md`](docs/RUN_DEMO_AND_DEPLOY.md) | run locally, demo workspace, pre-deploy checklist |
| [`docs/LOCAL_REVIEW_GUIDE.md`](docs/LOCAL_REVIEW_GUIDE.md) | where to see each feature |
| [`docs/SAAS_UPGRADE_LOG.md`](docs/SAAS_UPGRADE_LOG.md) | what was built, phase by phase, and how it was verified |
| [`docs/PRD.md`](docs/PRD.md), [`docs/TECH_SPEC.md`](docs/TECH_SPEC.md) | requirements and architecture |
| [`integrations/woocommerce`](integrations/woocommerce/gedusuite-combo/README.md) | the optional WooCommerce combo plugin |

## Development

```bash
yarn db:local          # a local Postgres (separate terminal, keep running)
yarn local:migrate     # create tables
yarn demo:seed         # a believable demo business
yarn local:dev         # http://localhost:3000   (demo@gedusuite.test / Demo#2026)

yarn test              # unit tests, no database
yarn test:integration  # real server actions, Golden Master, roles, tenants
yarn typecheck         # app and tests
```

Always run the real production build before a deploy
(`npx next build --webpack`): it catches things the type-checker and tests
cannot.

The money math lives in `src/lib` (`orders.ts`, `order-cash.ts`, `courier.ts`,
`finance.ts`, `product-report.ts`). Change a figure there and run
`yarn test:integration` — the Golden Master will say if anything moved.
