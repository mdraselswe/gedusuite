# GeduSuite — Phased Implementation Plan for Claude Code

Don't hand Claude Code the whole PRD and ask for the full app in one shot — a system this size (auth, multi-tenancy, RBAC, 6+ business modules, Google Sheets/JSON backup, PWA) needs to be built and tested in stages, or bugs compound and become hard to trace. Below is a phase-by-phase plan. Each phase has a ready-to-paste prompt for Claude Code. Run them **in order**, and test each phase before moving to the next.

Keep `TECH_SPEC.md` and `PRD.md` in your repo (e.g. under `/docs`) — reference them in every prompt so Claude Code stays consistent across sessions.

---

## Phase 0 — Project Scaffold, Auth & Multi-Tenancy

**Goal:** empty but working app with login, Google OAuth, workspace creation, and role-based membership.

**Prompt:**
```
Read /docs/TECH_SPEC.md and /docs/PRD.md.

Scaffold a Next.js 14 (App Router, TypeScript) project named "gedusuite"
with Tailwind CSS + shadcn/ui.
Set up Prisma with PostgreSQL using the data models in TECH_SPEC.md section 3
(start with Workspace, User, Membership only — other tables come later).

Implement:
1. NextAuth.js with email/password (Credentials) and Google OAuth.
2. Workspace registration flow: a new user can create a Workspace and becomes its OWNER.
3. Team invite flow: OWNER can invite other emails to the workspace with a role
   (OWNER/PARTNER/MANAGER/STAFF).
4. Middleware that scopes every request to the current workspace and enforces
   role-based access per the permission matrix in TECH_SPEC.md section 5.

Set up the PWA basics (manifest.json, service worker via next-pwa) even though
there's no offline data yet — get the install prompt working now.

Write a short README explaining how to run migrations and start the dev server.
```

---

## Phase 1 — Product & Purchase Management

**Goal:** product catalog + purchase entry, matching PRD section 6.1 and 6.8.

**Prompt:**
```
Read /docs/PRD.md sections 6.1 and 6.8, and TECH_SPEC.md section 3.

Add Prisma models: Supplier, Product, ProductVariant, Purchase.

Build:
1. Supplier master list (CRUD) — reusable across purchase entries.
2. Product CRUD with category, variants (size/color), image upload, SKU/barcode (optional).
3. Purchase entry form: date, product/variant, supplier (select from master list),
   unit cost, quantity, expiry date (if expiryTracked).
4. Low-stock and expiry-approaching alerts (dashboard banner + Notification records).

Use the RBAC rules already in place from Phase 0 to gate access to this module.
```

---

## Phase 2 — Sales & Order Management

**Goal:** full sales flow, matching PRD section 6.2, 6.3, 6.9.

**Prompt:**
```
Read /docs/PRD.md sections 6.2, 6.3, and 6.9. TECH_SPEC.md section 3 for models.

Add Prisma models: Customer, Order, OrderItem, Return.

Build:
1. Customer CRUD with order history view.
2. Order entry: multi-item orders, per-item price/cost/discount, auto profit
   calculation (sale - cost - packaging - discount - gift, per TECH_SPEC formula),
   delivery type + charge, gift, packaging cost, payment method + status,
   which partner is currently holding the order's cash (heldByPartnerId).
3. Order status flow: Pending → Confirmed → Shipped → Delivered → Cancelled.
4. Return/refund entry that restores stock and adjusts profit figures.
5. Stock auto-decrements on order confirmation, restores on cancellation/return.

Ensure calculations are done server-side (never trust client-computed totals).
```

---

## Phase 3 — Partner Finance & Treasury

**Goal:** multi-partner investment, expense, and central treasury, matching PRD 6.4, 6.6, 6.7.

**Prompt:**
```
Read /docs/PRD.md sections 6.4, 6.6, 6.7. TECH_SPEC.md section 3 for models.

Add Prisma models: Partner, PartnerTxn, TreasuryEntry.

Build:
1. Partner profile with total invested amount and profit-share percentage.
2. Partner transaction log: investment / expense / withdrawal / deposit-to-treasury,
   each with purpose and date.
3. Central Treasury ledger with running balance, filterable by source/partner.
4. Overdue-payment reminder: flag orders where paymentStatus is unpaid past N days,
   and surface which partner is owed that cash.
5. Partner-wise profit/loss dashboard view (uses profitSharePercent from Phase 3
   applied to Order profit figures from Phase 2).
```

---

## Phase 4 — Internal Purchases

**Goal:** non-sales internal purchase tracking, PRD section 6.5.

**Prompt:**
```
Read /docs/PRD.md section 6.5.

Add Prisma model: InternalPurchase (kept fully separate from the sales-product
Purchase model from Phase 1 — no shared references).

Build CRUD: date, item name, description, supplier/shop details, cost, quantity,
expense category (office supplies, packaging material, equipment, etc.).
```

---

## Phase 5 — Reports, Dashboard & Notifications

**Goal:** analytics layer, PRD section 6.10, 6.11.

**Prompt:**
```
Read /docs/PRD.md sections 6.10 and 6.11.

Build:
1. Dashboard KPIs: daily/weekly/monthly sales & profit summary, best-selling and
   slow-moving products, partner-wise profit share, custom date-range filter.
2. Excel and PDF export for any report view.
3. Invoice/receipt generation (printable/shareable) per order.
4. In-app notification center wiring up the Notification records already created
   in Phases 1 and 3 (low stock, expiry, overdue payment, new order).

Use Recharts for charts as specified in TECH_SPEC.md.
```

---

## Phase 6 — Backup System (Google Sheets + JSON)

**Goal:** the disaster-recovery system, PRD section 6.12, TECH_SPEC section 6.

**Prompt:**
```
Read /docs/PRD.md section 6.12 and TECH_SPEC.md section 6.

Using the googleapis npm package, implement:
1. OAuth/service-account connection to the company's registered Google account,
   configured in Settings > Backup.
2. A Google Sheets sync job (queued) that writes each module's data
   (Purchases, Sales, Customers, Partners, Treasury, Internal Purchases) to its
   own tab in a per-workspace Google Sheet, human-readable (proper headers,
   formatted dates/currency), set as view-only/protected ranges.
3. A JSON export job (scheduled + manual "Backup Now" button) that snapshots
   the full workspace and stores it in the same Drive folder, keeping the last
   N versions.
4. An import/restore flow: upload JSON → validate & preview → choose
   Merge or Overwrite → auto-snapshot current data first → apply.
5. Log every backup/restore action to BackupLog with who triggered it and when.

This module needs careful error handling — a failed backup should alert the
Owner, not fail silently.
```

---

## Phase 7 — PWA Polish, Theming & Deployment

**Goal:** ship it.

**Prompt:**
```
Read TECH_SPEC.md sections 7 and 8.

1. Finish offline support: queue writes made offline in IndexedDB, sync on
   reconnect, show an offline indicator in the UI.
2. Implement the theme switcher (CSS variables, a handful of preset palettes,
   saved per user).
3. Add Bangla/English language toggle.
4. Review all list views for search/filter/sort per PRD non-functional requirements.
5. Prepare a production build and deployment steps for the Hostinger VPS
   (PM2 + Nginx reverse proxy, environment variables, Postgres connection,
   HTTPS via Let's Encrypt).
```

---

## Notes on Working With Claude Code Across Phases

- Start a **fresh, focused conversation per phase** rather than one giant thread — keeps context clean and reduces the chance Claude Code loses track of earlier decisions.
- After each phase, **actually run the app and click through it** before moving on. Catching a schema mistake in Phase 1 is cheap; catching it after Phase 5 depends on it is expensive.
- If you change your mind on a schema field mid-way, update `TECH_SPEC.md` first, then tell Claude Code to re-read it before making the change — keeps the spec and the code from drifting apart.
