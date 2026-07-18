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

🚧 Not started yet — see `docs/IMPLEMENTATION_PLAN.md` Phase 0 to begin.

## Stack (summary — full detail in TECH_SPEC.md)

Next.js 14 (App Router, TypeScript) · PostgreSQL (Neon, free tier) · Prisma · NextAuth.js (Google OAuth) ·
Tailwind CSS + shadcn/ui · next-pwa · Hosted free on Vercel · Google Sheets/Drive API for backups
