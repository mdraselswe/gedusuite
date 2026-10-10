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
