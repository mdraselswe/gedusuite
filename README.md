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
