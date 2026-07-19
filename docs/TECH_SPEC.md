# GeduSuite — Technical Specification
_(Reference document for Claude Code implementation. Pairs with `PRD.md` and `IMPLEMENTATION_PLAN.md`.)_

> **Project name:** GeduSuite — a multi-tenant business management PWA.
> GeduShop is the first business ("Workspace") that will run on it; anyone
> else can register their own Workspace on the same app later.

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

The repository is no longer a blank scaffold. It currently includes:

- Next.js App Router pages for login/register, workspace creation, dashboard,
  products, purchases, sales orders, customers, partners, treasury, internal
  purchases, reports, notifications, team settings, appearance settings, and
  backup settings.
- Prisma schema and migrations through the core modules: multi-tenancy,
  NextAuth adapter tables, products/purchases, customers/orders/returns,
  partner finance, treasury, internal purchases, backup logs/settings, stock
  adjustments, and personal Google backup connections.
- Server actions for each business module, plus server-side inventory/order
  validation helpers.
- Serwist service worker, offline fallback page, IndexedDB-style local mutation
  queue helpers, and reconnect sync UI.
- Company-level and personal Google backup code paths using shared Google API
  helpers.

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

Customer         { id, workspaceId, name, phone, address, notes }
Order            { id, workspaceId, customerId, date, status(enum), deliveryType, deliveryCharge,
                    deliveryCost, paymentMethod, paymentStatus, packagingCost, giftCost, discount,
                    heldByMembershipId, notes }
OrderItem        { id, orderId, productVariantId, unitPrice, quantity, unitCost, discount }
Return           { id, orderItemId, quantity, reason, refundAmount, date }

Partner          { id, workspaceId, userId, profitSharePercent, notes }
PartnerTxn       { id, workspaceId, partnerId, type(INVESTMENT|EXPENSE|WITHDRAWAL|DEPOSIT_TO_TREASURY),
                    amount, purpose, date }
TreasuryEntry    { id, workspaceId, type(IN|OUT), amount, source, note, date, partnerId?, partnerTxnId? }

InternalPurchase { id, workspaceId, itemName, description, supplierName, cost, quantity, category, date }

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
/[workspace]/sales/orders        → sales/order entry, returns, status
/[workspace]/customers          → customer list + history
/[workspace]/partners           → investment, expense, profit-share
/[workspace]/treasury           → central ledger
/[workspace]/internal-purchases → non-sales purchases
/[workspace]/reports            → analytics, export
/[workspace]/settings/team      → invite admins/staff, roles
/[workspace]/settings/backup    → Google Sheets/JSON backup controls
/[workspace]/settings/appearance → theme/language preferences
/[workspace]/notifications      → notification center
/[workspace]/customers/[id]     → customer order history
/[workspace]/partners/[id]      → partner transaction history
/[workspace]/sales/orders/[id]/invoice → printable invoice
```

## 5. RBAC Permission Matrix (starting point — refine per module)

| Module | Owner | Partner | Manager | Staff |
|---|---|---|---|---|
| Products/Purchases | Full | View+Edit | View+Add+Edit | Add only |
| Sales/Orders | Full | View+Edit | View+Add+Edit | Add only |
| Partner Finance | Full | View own + Add own | View only | No access |
| Treasury | Full | View | View | No access |
| Team/Settings | Full | No access | No access | No access |
| Backup | Full | View | No access | No access |

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
| Domain | Existing `gedushop.com` | Add a subdomain (e.g. `suite.gedushop.com`) as a CNAME pointing to Vercel — done in Hostinger's DNS Zone Editor, free, and Vercel issues the HTTPS certificate automatically. |

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
