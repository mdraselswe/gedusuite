# GeduSuite — Technical Specification
_(Reference document for Claude Code implementation. Pairs with `PRD.md` and `IMPLEMENTATION_PLAN.md`.)_

> **Project name:** GeduSuite — a multi-tenant **small-business ERP**, built as
> a PWA. GeduShop is the first business ("Workspace") running on it; anyone else
> can register their own Workspace on the same app.
>
> ERP rather than CRM: the system covers inventory and procurement, order
> management and courier money, finance (treasury, spending, partner
> profit-sharing), marketing attribution and reporting. Customers and the call
> list are one module of seven, not the headline. See `PRD.md` §1 for the full
> area → module map.

## 1. Recommended Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 16 (App Router, TypeScript) | Server components, server actions, and API routes in one project, easy PWA support |
| Styling | Tailwind CSS + shadcn/ui | Fast, consistent, theme-able via CSS variables |
| PWA | Serwist (`@serwist/next`) | Service worker, offline caching, installable app |
| Database | PostgreSQL | Relational integrity matters here — money, ownership, multi-partner ledgers must never go inconsistent. NoSQL (Firestore) makes cross-record math and reporting harder. |
| ORM | Prisma | Type-safe schema, migrations, works well with Claude Code iterating on models |
| Auth | NextAuth.js (Credentials + Google provider) | Matches your "email/password + Google Sign-In" requirement |
| Backup integration | `googleapis` npm package (Sheets API + Drive API) | For the human-readable + JSON backup system |
| Data mutations | Next.js server actions | Keeps permission checks and business calculations server-side; offline writes are queued and replayed through `/api/mutations`. |
| Charts | Recharts | For the reports/dashboard module |
| Hosting | **Vercel (Free/Hobby)** for the app + **Neon (Free tier)** for PostgreSQL | Confirmed: the Hostinger plan is shared hosting (MySQL only, no Node.js support) — not usable for a custom Node app. This combo needs zero payment. Details and caveats in section 9. |

## 1.1 Current Implementation Snapshot

In production at `app.gedushop.com`. Every ERP area in `PRD.md` §1 is
implemented:

- Pages for login/register, workspace creation, dashboard, products, purchases,
  sales orders, call list, couriers, customers, partners, treasury, boosting,
  spending, internal purchases, reports, notifications, and team/backup/
  appearance settings.
- Prisma schema and migrations covering multi-tenancy, NextAuth adapter tables,
  products/variants/purchases, customers/orders/gifts/returns, couriers and
  zones, WooCommerce leads, partner finance and profit distributions, treasury,
  internal purchases, boost campaigns/ad-sets/daily spend, stock adjustments,
  backup logs/settings, and personal Google backup connections.
- Server actions per module, with permission checks and money math server-side.
- Serwist service worker, offline fallback, local mutation queue replayed
  through `/api/mutations`, and reconnect sync UI.
- Vitest coverage on the money math (`src/lib/*.test.ts`).

## 1.2 One Number, One Source

The rule that keeps the ERP self-consistent, and the first thing to check
before adding a figure to a page:

| Figure | Comes from |
|---|---|
| An order's profit, whatever its status | `orderNetProfit` (`lib/orders.ts`) |
| A delivered order's full breakdown | `computeOrderTotals` |
| What a cancellation left behind | `cancelledOrderCost` |
| Courier delivery charge, COD fee, return charge | `quoteCourier` (`lib/courier.ts`) |
| What the customer has paid / still owes | `amountCollected` / `amountOutstanding` (`lib/order-cash.ts`) |
| What lands in the treasury | `depositAmount` |
| Per-product revenue and profit | `allocateOrderLines` (`lib/product-report.ts`) |

Pages call these; they do not re-derive. A number shown on two screens has one
function behind it, or the two screens will eventually disagree about the same
order and nobody will know which is right.

## 2. Multi-Tenancy Model

- **Workspace** = one registered business (e.g., GeduShop). Every data table has a `workspaceId`.
- **User** can belong to multiple Workspaces via **Membership** (role: `OWNER | PARTNER | MANAGER | STAFF`).
- Every database query is scoped by `workspaceId` derived from the logged-in session — never trust a client-supplied workspace id alone.

## 3. Core Data Models (Prisma outline)

```
Workspace        { id, name, slug, logoUrl, themeColor, createdAt }
User             { id, name, email, passwordHash?, theme, colorPreset, locale, createdAt }
Membership       { id, userId, workspaceId, role, permissions(json), invitedBy, createdAt }

Supplier         { id, workspaceId, name, address, phone, notes }
Product          { id, workspaceId, name, category, sku, barcode, imageUrl, expiryTracked(bool), lowStockThreshold }
ProductVariant   { id, productId, size, color, sku }
Purchase         { id, workspaceId, supplierId?, productVariantId, date, unitCost, quantity, expiryDate }

Courier          { id, workspaceId, name, isDefault, baseWeightKg, extraKgRate,
                    codFeePercent, codFeeBase(GROSS|NET), returnChargeType, returnChargeValue }
CourierZone      { id, courierId, workspaceId, name, rate }

Customer         { id, workspaceId, name, phone, address, notes }
Order            { id, workspaceId, customerId, date, status(enum), deliveryType, deliveryCharge,
                    deliveryCost, courierId?, courierZoneId?, weightKg?, codFeeCost,
                    courierTrackingId?, paymentMethod, paymentStatus, amountPaid,
                    cancelledCollected, cashInTreasury, packagingCost, giftCost, discount,
                    source?, boostCampaignId?, heldByMembershipId, notes }
OrderItem        { id, orderId, productVariantId, unitPrice, quantity, unitCost, discount }
OrderGift        { id, orderId, productVariantId?, label, quantity, unitCost }
Return           { id, orderItemId, quantity, reason, refundAmount, date }
OrderLead        { id, workspaceId, source, externalId, customerName, phone, address, itemsText,
                    total, channel, callStatus, fulfilmentStatus, convertedCustomerId?, notes }

Partner          { id, workspaceId, userId, profitSharePercent, notes }
PartnerTxn       { id, workspaceId, partnerId, type(INVESTMENT|EXPENSE|WITHDRAWAL|DEPOSIT_TO_TREASURY),
                    amount, purpose, date }
TreasuryEntry    { id, workspaceId, type(IN|OUT), amount, source, note, date, partnerId?, partnerTxnId? }
ProfitDistribution { id, workspaceId, totalAmount, note, date, lines(per partner) }

InternalPurchase { id, workspaceId, itemName, description, supplierName, cost, quantity,
                    category(ExpenseCategory), spreadMonths?, date }

BoostCampaign    { id, workspaceId, name, objective, status, budget, startDate, endDate?, notes }
BoostAdSet       { id, campaignId, workspaceId, name, startDate, endDate?, budget }
BoostDailySpend  { id, adSetId, workspaceId, date, amount, results? }

WooSyncState     { id, workspaceId, lastSyncedAt, cursor }
ProcessedMutation{ id, workspaceId, mutationId, processedAt }   // offline queue idempotency

BackupLog        { id, workspaceId, type(SHEETS|JSON), status, triggeredBy, fileUrl, payload, error, createdAt }
BackupSetting    { id, workspaceId, googleSheetId, driveFolderId, autoJson, lastJsonAt, lastSheetsAt }
StockAdjustment  { id, workspaceId, productVariantId, type(DAMAGED|LOST|GIFT|CORRECTION), delta, reason, date }
UserGoogleConnection { id, userId, scope(PERSONAL_BACKUP), accessToken(encrypted), refreshToken(encrypted),
                        expiryDate, sheetId, connectedAt, lastSyncedAt }
Notification     { id, workspaceId, type, message, dedupeKey, read, createdAt }
```

## 4. Module → Route Map

```
/auth/*                        → NextAuth (login, Google OAuth)
/[workspace]/dashboard          → KPI summary
/[workspace]/products           → product + variant + supplier CRUD
/[workspace]/purchases          → purchase entries
/[workspace]/sales/orders        → sales/order entry, returns, status, cancellation costs
/[workspace]/leads              → call list (WooCommerce lead → phone call → order)
/[workspace]/couriers           → courier rules, zones, and balance reconciliation
/[workspace]/customers          → customer list + history
/[workspace]/partners           → investment, expense, profit-share, distributions
/[workspace]/treasury           → central ledger
/[workspace]/boosting           → ad campaigns, daily spend, order attribution
/[workspace]/expenses           → spending: where the day's money went
/[workspace]/internal-purchases → non-sales purchases
/[workspace]/reports            → analytics, export
/[workspace]/settings/team      → invite admins/staff, roles
/[workspace]/settings/backup    → Google Sheets/JSON backup controls
/[workspace]/settings/appearance → theme/language preferences
/[workspace]/notifications      → notification center
/[workspace]/customers/[id]     → customer order history
/[workspace]/partners/[id]      → partner transaction history
/[workspace]/boosting/[id]      → campaign detail + attributed orders
/[workspace]/products/[id]      → per-product profitability
/[workspace]/sales/orders/[id]/invoice   → printable invoice
/[workspace]/sales/orders/[id]/breakdown → how this order's profit was computed
/api/cron/woo-lead              → WooCommerce webhook (HMAC-signed) → call list
/api/cron/backup                → nightly company backup (Bearer CRON_SECRET)
/api/mutations                  → offline queue replay
```

Route access is gated twice: `src/proxy.ts` checks workspace membership and
module-level RBAC before the page renders, and every server action re-checks
its own permission. The proxy is convenience; the action is the boundary.

## 5. RBAC Permission Matrix

`src/lib/rbac.ts` is the implementation of this table — change them together.
Levels are ordered (`none < view < add < edit < full`), so a higher level
implies every lower one.

| Module | Owner | Partner | Manager | Staff |
|---|---|---|---|---|
| Dashboard | Full | View | View | View |
| Products/Purchases | Full | Edit | Edit | Add |
| Sales/Orders | Full | Edit | Edit | Add |
| Customers | Full | Edit | Edit | Add |
| Partner Finance | Full | Add (own rows only) | View | None |
| Treasury | Full | View | View | None |
| Boosting | Full | Edit | Add | None |
| Internal Purchases | Full | Edit | Edit | None |
| Reports | Full | View | View | None |
| Team/Settings | Full | None | None | None |
| Backup | Full | View | None | None |

Two modules have no row of their own and are gated by another's: **Couriers**
sits under `sales` (it is order money), and **Spending** under `purchases` (it
is the purchase records read a different way). A segment missing from
`moduleForSegment` gets no gate at all, which is why adding a route means
adding it there too.

Cost and profit figures are additionally gated on `reports` access — the Profit
column, the breakdown page and per-product margins all check it, so a Staff
account can enter an order without seeing what the business makes on it.

Per-membership overrides sit in `Membership.permissions` (json) on top of this
matrix, so one partner can be given something the role does not grant by
default.

## 6. Backup & Recovery Design

- **Company-level Google Sheets sync**: one Google Sheet per workspace in the company's registered-email Drive, one tab per module (Purchases, Sales, Partners, Treasury, Internal Purchases, Customers). Sync via a queued job — either on every write, or batched hourly/daily (configurable). Sheet tabs are protected ranges (view-only) to prevent accidental edits.
- **Personal per-user Google Sheets backup (added after user feedback):** any user (Owner, Partner, Manager) can, from Settings, connect *their own* Google account via OAuth (separate consent from the company backup connection) and get a personal copy of the workspace data written to a Sheet in *their own* Drive. This is opt-in per user, not automatic — the app never writes to someone's personal Drive without them explicitly connecting it.
  - Same human-readable format as the company sheet (proper headers, formatted dates/currency, one tab per module) but generated from a shared formatting function so both stay visually consistent — don't build two separate formatters.
  - Personal sheets sync on the same schedule as the company one, or on-demand via a "Sync to my Sheet" button.
  - A user can disconnect their personal sync anytime from Settings; disconnecting revokes the stored OAuth token.
- **JSON export**: full-workspace snapshot generated on a cron schedule (daily/weekly) + a manual "Backup Now" action, stored in the company Drive folder. Keep the last N versions.
- **Restore**: admin uploads a JSON file → validate/preview → choose Merge or Overwrite → auto-snapshot current data first as a safety net → apply.
- Company-level integration authenticates via the company's registered email OAuth (or a service account shared with that email's Drive). Personal sync uses each user's own OAuth token, stored encrypted, scoped only to Sheets/Drive file creation (not full Drive access).

**Formatting requirements for "human-readable and well-organized" (this was reported broken/basic and needs explicit attention):**
- Header row: bold, frozen, with a background color per module tab.
- Dates formatted as human dates (not raw ISO timestamps or Unix epoch).
- Currency columns formatted with the ৳ symbol and thousands separators, right-aligned.
- Column widths auto-sized to content, not default narrow columns.
- A summary tab (first tab in the workbook) with basic totals (total sales, total purchases, current treasury balance, last sync time) so opening the sheet gives an at-a-glance view before drilling into module tabs.

## 7. PWA Requirements

- `manifest.json` with icons, theme color, `display: standalone`.
- Service worker: Serwist-powered caching, offline fallback page for full disconnection, and cache-first static assets.
- Local write queue: entries made offline are queued locally and replayed via `/api/mutations` when connectivity returns.

## 8. Theming

- CSS custom properties per theme (e.g., `--color-primary`, `--color-bg`), a small set of preset palettes, stored as a per-user preference in `User` or `Membership`.

## 9. Hosting & Deployment (100% Free Tier — Confirmed No VPS Available)

The Hostinger plan currently in use for gedushop.com is **shared hosting**
(MySQL only, no Node.js support, no root/SSH beyond a restricted shell) —
confirmed by checking hPanel directly. It cannot run a persistent Node.js
app. Since no new spending is wanted, GeduSuite will run entirely on free
tiers of dedicated platforms instead:

| Piece | Service | Free tier reality (read before relying on it) |
|---|---|---|
| App hosting (Next.js) | **Vercel — Hobby plan** | Free, includes serverless functions + custom domains + HTTPS. Vercel's ToS scopes the Hobby plan to personal/non-commercial use. Using it for GeduShop's own internal tool is the common case people run for free; if GeduSuite is ever sold/offered as a paid product to other businesses, that crosses into commercial use and Vercel's Pro plan ($20/mo) would be the honest path at that point. |
| Database (PostgreSQL) | **Neon — Free tier** | ~0.5GB storage, generous compute hours. Auto-suspends after a period of inactivity and wakes on the next request (a few hundred ms delay on the first query after idle) — no data loss, just a cold-start pause. Fine for a business tool that isn't hit 24/7. |
| Backups | Google Sheets + Drive API | Already free (section 6) — uses your own Google account's storage quota. |
| Auth | NextAuth + Google OAuth | Free — only needs a Google Cloud project (also free to create) for OAuth credentials. |
| Domain | `app.gedushop.com` | A CNAME in the shop's **Cloudflare** zone (not Hostinger — the domain's nameservers are Cloudflare's), DNS-only, pointing at Vercel, which issues the certificate. The shop's own server never sees this traffic. Full setup, and why the app is not on `gedusuite.vercel.app` any more, in [`HOSTING.md`](HOSTING.md). |

**Why this is a solid choice, not just "the free option"**
Vercel + Neon is what Next.js is built and optimized for — deployments are
git-push-to-deploy, previews per branch, and Neon's branching feature can
give you a free throwaway database copy to test schema changes safely.
This isn't a downgrade from the VPS plan, it's arguably a smoother workflow.

**What changes in the implementation plan**
- Prisma's `provider` stays `postgresql` — Neon is standard Postgres, no
  code changes needed versus the earlier self-hosted plan.
- Drop all PM2/Nginx/VPS-specific steps from Phase 7 — deployment becomes
  "connect the GitHub repo to a Vercel project" instead.
- Environment variables (`DATABASE_URL`, Google OAuth secrets, etc.) are
  set in the Vercel project dashboard rather than a `.env` file on a server.

**Multi-tenant note (unchanged)**
Other businesses registering a Workspace are still just new rows in the
same Neon Postgres database — no new infrastructure needed per business,
free tier or not. The `workspaceId` scoping from section 2 still does the
isolation work.

**If the free tiers are ever outgrown**
Neon's free tier limit (~0.5GB) is the one most likely to be hit first as
data grows across months of purchases/sales/customers. When that happens,
Neon's paid tier starts small (a few dollars/month) rather than requiring
a full re-architecture — a decision to make later, with real usage data,
not now.

## 10. UI/UX & Typography Standards (Retrofit Required)

This section was missing from the original plan, which is why the first
implementation pass came out visually basic. Apply this to all existing and
future screens.

**Typography — bilingual font pairing**
Do not rely on Tailwind's default font stack for Bangla text — it falls back
to inconsistent system fonts that clash visually with the Latin/English text
next to them (different weight, height, rhythm).

Use **Anek Bangla** (Google Fonts, free, variable font) as the primary UI
font — it's purpose-built to render Bangla and Latin script in the same
visual rhythm, so mixed Bangla/English sentences (very common in this app:
"স্ট্যাটাস: Pending", "মোট: ৳৫০০") look like one coherent typeface instead of
two fonts awkwardly stitched together.
```css
/* globals.css or tailwind config */
font-family: 'Anek Bangla', sans-serif;
```
Fallback pairing if Anek Bangla doesn't cover a need: `Noto Sans Bengali` +
`Noto Sans` (Google explicitly designs these as metrically compatible).

**Responsive — mobile-first, not desktop-retrofitted**
- Build every screen mobile-first: base Tailwind classes target the
  smallest screen, then layer `sm:`/`md:`/`lg:` for larger viewports —
  not the other way around.
- Minimum touch target size 44×44px for buttons/tappable rows (this is a
  PWA meant to be used on phones during a sale, not just a desktop admin panel).
- Test explicitly at three widths before calling a screen done: 375px
  (small phone), 768px (tablet), 1280px (desktop). Don't assume — resize
  and look.
- Tables (product lists, order lists, transaction logs) need a mobile
  fallback — a data table that requires horizontal scrolling on a 375px
  screen is not acceptable; switch to a stacked card layout below `md:`.

**Visual polish baseline**
- Consistent spacing scale (Tailwind's default scale is fine — just use it
  consistently, don't mix arbitrary pixel values with Tailwind spacing units).
- Every interactive element needs a visible hover/active/focus state.
- Empty states (no products yet, no orders yet) get a simple illustration
  or icon + short message, not a blank white area.
