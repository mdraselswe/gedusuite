# GeduSuite — Technical Specification
_(Reference document for Claude Code implementation. Pairs with `PRD.md` and `IMPLEMENTATION_PLAN.md`.)_

> **Project name:** GeduSuite — a multi-tenant business management PWA.
> GeduShop is the first business ("Workspace") that will run on it; anyone
> else can register their own Workspace on the same app later.

## 1. Recommended Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 14 (App Router, TypeScript) | Server components + API routes in one project, easy PWA support |
| Styling | Tailwind CSS + shadcn/ui | Fast, consistent, theme-able via CSS variables |
| PWA | `next-pwa` | Service worker, offline caching, installable app |
| Database | PostgreSQL | Relational integrity matters here — money, ownership, multi-partner ledgers must never go inconsistent. NoSQL (Firestore) makes cross-record math and reporting harder. |
| ORM | Prisma | Type-safe schema, migrations, works well with Claude Code iterating on models |
| Auth | NextAuth.js (Credentials + Google provider) | Matches your "email/password + Google Sign-In" requirement |
| Backup integration | `googleapis` npm package (Sheets API + Drive API) | For the human-readable + JSON backup system |
| Data fetching | TanStack Query | Caching, offline-friendly retry behavior (useful with PWA) |
| Charts | Recharts | For the reports/dashboard module |
| Hosting | Your existing Hostinger VPS (Node + PM2 + Nginx) | You already have SSH set up there; reuse it. Postgres can run on the same VPS or a managed free-tier (Neon/Supabase) if you want automatic DB backups without managing them yourself |

## 2. Multi-Tenancy Model

- **Workspace** = one registered business (e.g., GeduShop). Every data table has a `workspaceId`.
- **User** can belong to multiple Workspaces via **Membership** (role: `OWNER | PARTNER | MANAGER | STAFF`).
- Every database query is scoped by `workspaceId` derived from the logged-in session — never trust a client-supplied workspace id alone.

## 3. Core Data Models (Prisma outline)

```
Workspace        { id, name, logoUrl, themeColor, createdAt }
User             { id, name, email, passwordHash?, googleId?, createdAt }
Membership       { id, userId, workspaceId, role, permissions(json), invitedBy }

Supplier         { id, workspaceId, name, address, phone, notes }
Product          { id, workspaceId, name, category, sku, barcode, expiryTracked(bool) }
ProductVariant   { id, productId, size, color, sku }
Purchase         { id, workspaceId, supplierId, productVariantId, date, unitCost, quantity, expiryDate }

Customer         { id, workspaceId, name, phone, address, notes }
Order            { id, workspaceId, customerId, date, status(enum), deliveryType, deliveryCharge,
                    paymentMethod, paymentStatus, packagingCost, giftCost, discount, heldByPartnerId }
OrderItem        { id, orderId, productVariantId, unitPrice, quantity, unitCost, discount }
Return           { id, orderItemId, quantity, reason, refundAmount, date }

Partner          { id, workspaceId, userId, investedAmount, profitSharePercent }
PartnerTxn       { id, partnerId, type(INVESTMENT|EXPENSE|WITHDRAWAL|DEPOSIT_TO_TREASURY),
                    amount, purpose, date }
TreasuryEntry    { id, workspaceId, type(IN|OUT), amount, source, note, date }

InternalPurchase { id, workspaceId, itemName, supplierName, cost, quantity, category, date }

BackupLog        { id, workspaceId, type(SHEETS|JSON), status, triggeredBy, fileUrl, createdAt }
Notification     { id, workspaceId, type, message, read, createdAt }
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

- **Google Sheets sync**: one Google Sheet per workspace in the company's registered-email Drive, one tab per module (Purchases, Sales, Partners, Treasury, Internal Purchases, Customers). Sync via a queued job — either on every write, or batched hourly/daily (configurable). Sheet tabs are protected ranges (view-only) to prevent accidental edits.
- **JSON export**: full-workspace snapshot generated on a cron schedule (daily/weekly) + a manual "Backup Now" action, stored in the same Drive folder. Keep the last N versions.
- **Restore**: admin uploads a JSON file → validate/preview → choose Merge or Overwrite → auto-snapshot current data first as a safety net → apply.
- Both integrations authenticate against the company's registered email via OAuth (or a service account shared with that email's Drive).

## 7. PWA Requirements

- `manifest.json` with icons, theme color, `display: standalone`.
- Service worker: network-first for API calls (so data stays fresh when online), cache-first for static assets, offline fallback page for full disconnection.
- Local write queue: entries made offline are queued in IndexedDB and synced when connectivity returns.

## 8. Theming

- CSS custom properties per theme (e.g., `--color-primary`, `--color-bg`), a small set of preset palettes, stored as a per-user preference in `User` or `Membership`.
