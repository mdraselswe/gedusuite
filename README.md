# GeduSuite

A multi-tenant business management PWA — inventory/purchases, sales, multi-partner
finance & treasury, reporting, and automatic Google Sheets + JSON backups.

Originally built for **GeduShop** (baby products business), designed so any
business can register its own isolated Workspace on the same app.

## Docs

Read these in order before writing any code:

1. [`docs/PRD.md`](docs/PRD.md) — full business requirements
2. [`docs/TECH_SPEC.md`](docs/TECH_SPEC.md) — stack, data models, architecture
3. [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — phased build plan with ready-to-use Claude Code prompts

## Status

Active implementation. The core phased app is in place: authentication,
multi-tenant workspaces, role-based access, products, purchases, customers,
orders, partners, treasury, internal purchases, reports, notifications, PWA
offline queue, theming, and Google Sheets/JSON backup screens.

See `docs/IMPLEMENTATION_PLAN.md` for the original phase plan and the current
implementation status checklist.

## Stack (summary — full detail in TECH_SPEC.md)

Next.js 16 (App Router, TypeScript) · PostgreSQL (Neon, free tier) · Prisma 6 ·
NextAuth.js (Credentials + Google OAuth) · Tailwind CSS 4 + shadcn-style UI ·
Serwist service worker · Hosted free on Vercel · Google Sheets/Drive API for backups

## Vercel Deployment

Before deploying, add these required Production environment variables in Vercel:

- `DATABASE_URL` — pooled Neon PostgreSQL URL
- `NEXTAUTH_SECRET` — random secret string

Recommended runtime variables:

- `NEXTAUTH_URL` — production app URL
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `BACKUP_CRON_SECRET`

The Vercel build command is `npm run vercel-build` / `yarn vercel-build`.
It runs `prisma generate` and `next build`.

Run migrations separately when schema changes:

```bash
npm run db:deploy
```

Do not run `prisma migrate deploy` inside every Vercel build. Repeated or
concurrent deployments can compete for Prisma's migration advisory lock and fail
the deployment even when the app build itself is fine.
