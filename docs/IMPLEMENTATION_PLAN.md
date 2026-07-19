# GeduSuite — Phased Implementation Plan for Claude Code

> **Current repo status:** this plan began as a build guide for a blank app.
> The repository now has the core app implemented through the main business
> modules, reporting, notifications, PWA support, theming, and backup flows.
> Treat the phase prompts below as historical/reference prompts, not as a sign
> that the app has not started.

## Current Implementation Status

| Area | Status | Notes |
|---|---|---|
| Phase 0 — Scaffold/Auth/Multi-tenancy | Implemented | Next.js App Router, NextAuth Credentials + Google OAuth, workspace creation, invites, memberships, RBAC helpers. |
| Phase 1 — Products/Purchases | Implemented | Supplier/product/variant/purchase flows, stock adjustments, low-stock/expiry notification support. |
| Phase 2 — Sales/Orders/Customers | Implemented | Customer CRUD/history, multi-item orders, statuses, invoice route, server-side order helpers. |
| Phase 3 — Partners/Treasury | Implemented | Partner profiles, partner transactions, treasury ledger, linked treasury entries for deposits. |
| Phase 4 — Internal Purchases | Implemented | Separate non-sales purchase model and manager UI. |
| Phase 5 — Reports/Notifications | Implemented | Report view/export helpers and notification center are present. |
| Phase 6 — Backup | Implemented, verify in environment | Company JSON/Sheets flow, backup logs/settings, and personal Google backup connection model/actions/components are present. Real Google OAuth credentials are still required for end-to-end testing. |
| Phase 7 — PWA/Theming/Deployment | Partially implemented | Serwist service worker, offline page/queue UI, and appearance settings are present. Final Vercel/Neon environment validation is still a launch task. |

## Current Stack Adjustment

The prompts below mention `Next.js 14` and `next-pwa` because they were written
before implementation. The actual repo uses Next.js 16, React 19, Tailwind CSS 4,
Prisma 6, and Serwist (`@serwist/next`). Continue using the installed stack unless
there is a deliberate migration decision.

Don't hand Claude Code the whole PRD and ask for the full app in one shot — a system this size (auth, multi-tenancy, RBAC, 6+ business modules, Google Sheets/JSON backup, PWA) needs to be built and tested in stages, or bugs compound and become hard to trace. Below is a phase-by-phase plan. Each phase has a ready-to-paste prompt for Claude Code. Run them **in order**, and test each phase before moving to the next.

Keep `TECH_SPEC.md` and `PRD.md` in your repo (e.g. under `/docs`) — reference them in every prompt so Claude Code stays consistent across sessions.

---

## Phase 0 — Project Scaffold, Auth & Multi-Tenancy

**Goal:** empty but working app with login, Google OAuth, workspace creation, and role-based membership.

**Prompt:**
```
Read /docs/TECH_SPEC.md and /docs/PRD.md.

Scaffold a Next.js 16 (App Router, TypeScript) project named "gedusuite"
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

Set up the PWA basics (manifest.ts, service worker via Serwist) even though
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
5. Prepare the project for deployment on Vercel (free Hobby plan) with Neon
   as the PostgreSQL provider, per TECH_SPEC.md section 9. Concretely:
   ensure Prisma's `DATABASE_URL` reads from an environment variable (no
   hardcoded connection string), add a `vercel.json` only if non-default
   behavior is needed, document which environment variables must be set
   in the Vercel dashboard (DATABASE_URL, NEXTAUTH_SECRET, GOOGLE_CLIENT_ID/
   SECRET, Google Sheets/Drive service account credentials), and add a
   README section on connecting the GitHub repo to a new Vercel project
   and adding `suite.gedushop.com` as a custom domain.
```

---

---

## Retrofit — UI/UX & Typography Pass (run this now, before continuing further phases)

**Why this exists:** the original phase prompts above focused on functionality
and didn't specify typography, responsive breakpoints, or visual polish —
so the first implementation pass came out visually basic with a single font
awkwardly covering both Bangla and English. This prompt fixes what's already
built before any new phase adds more screens on the same shaky foundation.

**Prompt:**
```
Read /docs/TECH_SPEC.md section 10 (UI/UX & Typography Standards) in full.

Go through every existing screen in the app built so far and retrofit it to
match that section exactly:

1. Replace the current font setup with the Anek Bangla + fallback pairing
   specified in section 10, loaded via next/font, applied globally.
2. Rebuild each screen mobile-first: verify and fix layout at 375px, 768px,
   and 1280px widths specifically — don't just eyeball it, actually resize
   and check each one.
3. Convert any data tables (products, orders, transactions) to a stacked
   card layout below the `md:` breakpoint instead of horizontal scroll.
4. Apply the spacing, touch-target, hover/focus state, and empty-state
   rules from section 10 consistently across all screens.
5. Do not change any business logic, data models, or API behavior in this
   pass — this is a visual/layout-only retrofit.

After finishing, list which screens you touched and flag any screen where
the retrofit revealed a structural layout problem that needs a bigger
rework than a style fix.
```

Run this before starting whichever phase you haven't reached yet — it keeps
new screens consistent with the fixed ones instead of fixing everything twice.

---

## Bugfix & Enhancement Pass (run after user testing revealed issues)

Run these **one at a time, in this order**, and test after each before moving
to the next. Don't paste all five together — a couple of these touch
overlapping code (product forms, stock logic) and reviewing one clean diff
at a time makes it far easier to catch a regression.

### Fix 1 — Performance diagnosis (do this first, it may explain issue reports beyond just "slow")
```
The app feels slow — navigation and save/view actions take a long time.
Before changing anything, diagnose:
1. Check if Neon's free-tier compute is auto-suspending between requests
   (cold start) — log query timing and report whether the first request
   after idle is disproportionately slow vs subsequent ones.
2. Review the data-fetching pattern on the slowest 2-3 pages: look for
   N+1 queries (fetching related records in a loop instead of a single
   join/include), missing pagination on list views, and over-fetching
   (selecting all columns/relations when the UI only needs a few).
3. Check React Query configuration — confirm staleTime/cacheTime are set
   sensibly (not refetching on every navigation) and that mutations use
   optimistic updates or at least proper loading states instead of a full
   page block.
4. Report findings with numbers (approximate ms per request) before fixing
   anything, then propose and apply fixes for whatever's actually slow.
```

### Fix 2 — Dropdown selection not displaying
```
Select/dropdown components across the app don't visually reflect the
selected value after choosing an option. Audit every Select/dropdown
component (product category, supplier, customer, partner, status, etc.):
ensure each is a fully controlled component (value + onChange bound to
state, not relying on defaultValue), and that comparisons use the option's
id/value rather than object reference equality. Fix all instances, not
just one, and confirm by testing at least one dropdown in each major
module (Products, Purchases, Sales, Partners).
```

### Fix 3 — Product creation shouldn't require variants
```
Currently, creating a product without adding a variant disables several
fields/options that should work for simple products with no size/color
variation — most products in this business won't have variants.

Fix: variants must be fully optional. When a product is created without
explicit variants, automatically create a single hidden "default" variant
behind the scenes so the rest of the system (stock tracking, purchases,
orders) keeps working against ProductVariant uniformly, but the UI never
forces the user to interact with variant fields unless they choose
"Add variants" for that product. Re-test the full product creation →
purchase → sale flow for both a variant-less product and a product with
variants (e.g. sizes) to confirm both paths work.
```

### Fix 4 — Prevent selling out-of-stock products
```
Currently the sales/order flow allows selling a product variant with zero
or insufficient available stock. Add server-side validation (not just a
UI warning) in the order-item creation logic: reject (or clearly block)
adding a quantity that exceeds the variant's currently available stock,
accounting for stock already reserved by other pending orders if that
matters to this business (check with the reporting logic from Phase 2).
Show a clear inline error naming the product and available quantity,
don't just fail silently or with a generic error.
```

### Fix 5 — Personal per-user Google Sheets backup
```
Read /docs/TECH_SPEC.md section 6 (updated) and the new UserGoogleConnection
model in section 3.

The current backup implementation doesn't match this spec. Implement:
1. A Settings page section "My personal backup" where any user can connect
   their own Google account (separate OAuth consent/scope from the
   company-level backup connection) and see connection status + last synced
   time + a "Sync now" button + a "Disconnect" button.
2. On connect, create a Sheet in that user's own Drive and populate it using
   the same formatting function as the company sheet — don't duplicate
   formatting logic in two places, extract a shared formatter.
3. Apply the human-readable formatting requirements explicitly listed in
   TECH_SPEC.md section 6: bold/frozen header row per tab, human-formatted
   dates, currency formatted with ৳ and thousands separators, auto-sized
   columns, and a summary tab as the first tab with totals + last sync time.
4. Also verify and fix whatever was broken in the existing company-level
   sync — check the BackupLog entries for failed sync attempts and surface
   the actual error rather than failing silently.
5. Disconnecting revokes the stored token and stops future syncs for that
   user, without affecting the company-level sync or other users' personal
   syncs.
```

---

## Notes on Working With Claude Code Across Phases


- Start a **fresh, focused conversation per phase** rather than one giant thread — keeps context clean and reduces the chance Claude Code loses track of earlier decisions.
- After each phase, **actually run the app and click through it** before moving on. Catching a schema mistake in Phase 1 is cheap; catching it after Phase 5 depends on it is expensive.
- If you change your mind on a schema field mid-way, update `TECH_SPEC.md` first, then tell Claude Code to re-read it before making the change — keeps the spec and the code from drifting apart.
