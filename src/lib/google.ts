import { google } from "googleapis";
import type { Snapshot } from "@/lib/backup";
import { variantFullName } from "@/lib/variants";
import { dhakaInstant } from "@/lib/dhaka-time";

/**
 * Personal per-user backup uses each user's own OAuth token (see
 * google-personal.ts) and writes through the formatter below.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SheetsAuth = any;

// ── Tab / column specification ──────────────────────────────────────

type Col = { key: string; label: string; currency?: boolean; date?: boolean };
type TabSpec = { tab: string; table: keyof Snapshot["tables"]; columns: Col[] };

const TAB_SPECS: TabSpec[] = [
  {
    tab: "Suppliers",
    table: "suppliers",
    columns: [
      { key: "name", label: "Name" },
      { key: "phone", label: "Phone" },
      { key: "altPhone", label: "Alt phone" },
      { key: "address", label: "Address" },
      { key: "notes", label: "Notes" },
    ],
  },
  {
    tab: "Products",
    table: "products",
    columns: [
      { key: "name", label: "Name" },
      { key: "category", label: "Category" },
      { key: "sku", label: "SKU" },
      { key: "barcode", label: "Barcode" },
      { key: "lowStockThreshold", label: "Low-stock threshold" },
    ],
  },
  {
    tab: "Purchases",
    table: "purchases",
    columns: [
      { key: "date", label: "Date", date: true },
      { key: "productName", label: "Product" }, // enriched (see enrichSnapshotTables)
      { key: "unitCost", label: "Unit cost", currency: true },
      { key: "salePrice", label: "Sale price", currency: true },
      { key: "quantity", label: "Quantity" },
      { key: "expiryDate", label: "Expiry", date: true },
    ],
  },
  {
    tab: "Customers",
    table: "customers",
    columns: [
      { key: "name", label: "Name" },
      { key: "phone", label: "Phone" },
      { key: "altPhone", label: "Alt phone" },
      { key: "address", label: "Address" },
    ],
  },
  {
    tab: "Orders",
    table: "orders",
    columns: [
      { key: "date", label: "Date", date: true },
      { key: "customerName", label: "Customer" }, // enriched (see enrichSnapshotTables)
      { key: "status", label: "Status" },
      { key: "paymentMethod", label: "Payment method" },
      { key: "paymentStatus", label: "Payment status" },
      // Without them a PARTIAL row in the backup says only that "some" of the
      // money arrived — which is the state the app itself used to be in.
      { key: "amountPaid", label: "Paid so far", currency: true },
      { key: "deliveryCharge", label: "Delivery", currency: true },
      { key: "packagingCost", label: "Packaging", currency: true },
      { key: "giftCost", label: "Gift", currency: true },
      { key: "discount", label: "Discount", currency: true },
    ],
  },
  {
    tab: "Order Gifts",
    table: "orderGifts",
    columns: [
      { key: "label", label: "Gift" },
      { key: "quantity", label: "Quantity" },
      { key: "unitCost", label: "Unit cost", currency: true },
    ],
  },
  {
    tab: "Partners",
    table: "partners",
    columns: [
      { key: "partnerName", label: "Partner" }, // enriched

      { key: "profitSharePercent", label: "Profit share %" },
      { key: "notes", label: "Notes" },
    ],
  },
  {
    tab: "Profit Distributions",
    table: "profitDistributions",
    columns: [
      { key: "date", label: "Date", date: true },
      { key: "totalAmount", label: "Total amount", currency: true },
      { key: "note", label: "Note" },
    ],
  },
  {
    tab: "Treasury",
    table: "treasuryEntries",
    columns: [
      { key: "date", label: "Date", date: true },
      { key: "type", label: "Direction" },
      { key: "amount", label: "Amount", currency: true },
      { key: "source", label: "Source" },
      { key: "note", label: "Note" },
    ],
  },
  {
    tab: "Internal Purchases",
    table: "internalPurchases",
    columns: [
      { key: "date", label: "Date", date: true },
      { key: "itemName", label: "Item" },
      { key: "category", label: "Category" },
      { key: "supplierName", label: "Supplier" },
      { key: "cost", label: "Cost", currency: true },
      { key: "quantity", label: "Quantity" },
    ],
  },
  {
    tab: "Boost Campaigns",
    table: "boostCampaigns",
    columns: [
      { key: "name", label: "Campaign" },
      { key: "objective", label: "Objective" },
      { key: "status", label: "Status" },
      { key: "notes", label: "Notes" },
    ],
  },
  {
    tab: "Boost Ad Sets",
    table: "boostAdSets",
    columns: [
      { key: "name", label: "Ad set" },
      { key: "startDate", label: "Start", date: true },
      { key: "endDate", label: "End", date: true },
      { key: "dailyBudget", label: "Daily budget", currency: true },
      { key: "status", label: "Status" },
      { key: "notes", label: "Notes" },
    ],
  },
  {
    tab: "Boost Spends",
    table: "boostDailySpends",
    columns: [
      { key: "date", label: "Date", date: true },
      { key: "amount", label: "Amount", currency: true },
      { key: "paidFromTreasury", label: "Treasury funded" },
      { key: "note", label: "Note" },
    ],
  },
  // The three below were missing, which left the workbook unable to explain
  // its own bottom line: stock written off is a real loss against profit, the
  // partner ledger is where every taka in and out of a partner is recorded,
  // and a refund is money that left. Reading the sheets without them gave a
  // rosier picture than the app's own reports.
  {
    tab: "Stock Adjustments",
    table: "stockAdjustments",
    columns: [
      { key: "date", label: "Date", date: true },
      { key: "productName", label: "Product" }, // enriched
      { key: "type", label: "Type" },
      { key: "delta", label: "Change" },
      { key: "lossValue", label: "Value lost", currency: true }, // enriched
      { key: "reason", label: "Reason" },
    ],
  },
  {
    tab: "Partner Ledger",
    table: "partnerTxns",
    columns: [
      { key: "date", label: "Date", date: true },
      { key: "partnerName", label: "Partner" }, // enriched
      { key: "type", label: "Type" },
      { key: "amount", label: "Amount", currency: true },
      { key: "purpose", label: "Purpose" },
      { key: "derivedFrom", label: "Generated from" }, // enriched
    ],
  },
  {
    tab: "Returns",
    table: "returns",
    columns: [
      { key: "date", label: "Date", date: true },
      { key: "orderRef", label: "Order" }, // enriched
      { key: "customerName", label: "Customer" }, // enriched
      { key: "productName", label: "Product" }, // enriched
      { key: "quantity", label: "Quantity" },
      { key: "refundAmount", label: "Refunded", currency: true },
      { key: "reason", label: "Reason" },
    ],
  },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * Read in Dhaka, not UTC — a sale made at 9 PM belongs to the day the shop says
 * it does, and this used to export the day before. The time comes along when the
 * record has one of its own (`dateHasTime`); a date-only row would otherwise
 * export as 6 AM, which it never was.
 */
function fmtDate(v: unknown, withTime: boolean): string {
  if (!v) return "";
  const d = new Date(v as string);
  if (Number.isNaN(d.getTime())) return String(v);
  const { date, time } = dhakaInstant(d);
  const [year, month, day] = date.split("-");
  const human = `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
  return withTime && time ? `${human}, ${time}` : human;
}

function cellValue(row: Record<string, unknown>, col: Col): string | number {
  const raw = row[col.key];
  if (raw === null || raw === undefined) return "";
  // Only the record's own date can carry a time; an expiry or a campaign end is
  // a day by definition.
  if (col.date) return fmtDate(raw, col.key === "date" && row.dateHasTime === true);
  if (col.currency) return Number(raw);
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  return typeof raw === "number" ? raw : String(raw);
}

/** How an order is referred to on an invoice — the last 8 of its id. */
function orderRef(id: string): string {
  return `#${id.slice(-8).toUpperCase()}`;
}

/** Which source row generated a ledger entry, in words. */
function derivedFromLabel(txn: Record<string, unknown>): string {
  if (txn.distributionId) return "Profit distribution";
  if (txn.boostSpendId) return "Boost spend";
  if (txn.purchaseId) return "Product purchase";
  if (txn.internalPurchaseId) return "Internal purchase";
  return "";
}

/**
 * The snapshot stores raw rows with foreign keys only — unreadable in a
 * spreadsheet ("which product was this purchase?"). Derive human columns from
 * data already inside the snapshot. Pure/read-only; the snapshot itself is
 * never mutated, so nothing here can affect what a restore writes back.
 *
 * Partner names are the one thing not derivable from the snapshot — they live
 * on User, which is deliberately excluded — so they come in from the summary.
 */
function enrichSnapshotTables(
  snapshot: Snapshot,
  partnerNames: Record<string, string> = {},
): Snapshot["tables"] {
  const t = snapshot.tables;
  const rows = (name: string) => (t[name] ?? []) as Record<string, unknown>[];

  const productNameById = new Map(rows("products").map((p) => [p.id as string, p.name as string]));
  const variantLabelById = new Map(
    rows("productVariants").map((v) => [
      v.id as string,
      variantFullName(productNameById.get(v.productId as string) ?? "?", v.attributes),
    ]),
  );
  const variantCostById = new Map(
    rows("productVariants").map((v) => [v.id as string, Number(v.unitCost ?? 0)]),
  );
  const customerNameById = new Map(
    rows("customers").map((c) => [c.id as string, c.name as string]),
  );
  const orderById = new Map(rows("orders").map((o) => [o.id as string, o]));
  const orderItemById = new Map(rows("orderItems").map((i) => [i.id as string, i]));

  // Last purchase price per variant — the same cost a sale would snapshot, and
  // what a written-off piece is therefore worth. Rows are scanned newest-first
  // so the first hit wins.
  const lastPurchaseCost = new Map<string, number>();
  for (const p of [...rows("purchases")].sort(
    (a, b) => String(b.date).localeCompare(String(a.date)),
  )) {
    const vid = p.productVariantId as string;
    if (!lastPurchaseCost.has(vid)) lastPurchaseCost.set(vid, Number(p.unitCost ?? 0));
  }
  const unitCostOf = (vid: string) => lastPurchaseCost.get(vid) ?? variantCostById.get(vid) ?? 0;

  return {
    ...t,
    purchases: rows("purchases").map((p) => ({
      ...p,
      productName: variantLabelById.get(p.productVariantId as string) ?? "",
    })),
    orders: rows("orders").map((o) => ({
      ...o,
      customerName: o.customerId ? (customerNameById.get(o.customerId as string) ?? "") : "Walk-in",
    })),
    partners: rows("partners").map((p) => ({
      ...p,
      partnerName: partnerNames[p.id as string] ?? (p.userId as string),
    })),
    partnerTxns: rows("partnerTxns").map((x) => ({
      ...x,
      partnerName: partnerNames[x.partnerId as string] ?? (x.partnerId as string),
      derivedFrom: derivedFromLabel(x),
    })),
    stockAdjustments: rows("stockAdjustments").map((a) => {
      const vid = a.productVariantId as string;
      const delta = Number(a.delta ?? 0);
      return {
        ...a,
        productName: variantLabelById.get(vid) ?? "",
        // Only what LEFT is a loss. A gift or a positive correction costs
        // nothing here, so the cell is empty — null rather than "", because a
        // currency column turns an empty string into a very convincing ৳0.00.
        lossValue:
          a.type === "DAMAGED" || a.type === "LOST"
            ? Math.abs(Math.min(0, delta)) * unitCostOf(vid)
            : null,
      };
    }),
    returns: rows("returns").map((r) => {
      const item = orderItemById.get(r.orderItemId as string);
      const order = item ? orderById.get(item.orderId as string) : undefined;
      return {
        ...r,
        productName: item ? (variantLabelById.get(item.productVariantId as string) ?? "") : "",
        orderRef: order ? orderRef(order.id as string) : "",
        customerName: order?.customerId
          ? (customerNameById.get(order.customerId as string) ?? "")
          : order
            ? "Walk-in"
            : "",
      };
    }),
  };
}

export type BackupSummary = {
  workspaceName: string;
  totalSales: number;
  totalPurchases: number;
  treasuryBalance: number;
  lastSync: string;
  /**
   * partnerId -> display name. Names live on User, which the snapshot doesn't
   * carry (auth rows are deliberately excluded), so the Partners tab used to
   * print a raw cuid where a person's name belongs. Passed alongside rather
   * than folded into the snapshot: this is for rendering, and adding a field
   * the restore doesn't know about would break createMany.
   */
  partnerNames: Record<string, string>;
};

const CURRENCY_FORMAT = '"৳"#,##0.00';
const HEADER_BG = { red: 0.918, green: 0.929, blue: 0.988 }; // soft indigo

/**
 * Shared formatter — writes the summary tab + one tab per module, with a bold
 * frozen header row, ৳ currency formatting, human dates, and auto-sized columns.
 * Used by BOTH the company sync and the personal per-user sync.
 */
export async function writeFormattedWorkbook(
  auth: SheetsAuth,
  sheetId: string | null,
  snapshot: Snapshot,
  summary: BackupSummary,
): Promise<{ sheetId: string; url: string }> {
  const sheets = google.sheets({ version: "v4", auth });
  const tabTitles = ["Summary", ...TAB_SPECS.map((t) => t.tab)];

  if (!sheetId) {
    const created = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: `GeduSuite Backup — ${summary.workspaceName}` },
        sheets: tabTitles.map((title) => ({ properties: { title } })),
      },
    });
    sheetId = created.data.spreadsheetId!;
  } else {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));
    const toAdd = tabTitles.filter((t) => !existing.has(t));
    if (toAdd.length) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: { requests: toAdd.map((title) => ({ addSheet: { properties: { title } } })) },
      });
    }
  }

  // Numeric sheetId per tab title (needed for formatting requests).
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const idByTitle = new Map<string, number>();
  for (const s of meta.data.sheets ?? []) {
    if (s.properties?.title && s.properties.sheetId != null) {
      idByTitle.set(s.properties.title, s.properties.sheetId);
    }
  }

  const tables = enrichSnapshotTables(snapshot, summary.partnerNames);

  // ── Write values ──
  // Summary tab (first): at-a-glance totals.
  const summaryValues: (string | number)[][] = [
    ["GeduSuite Backup", summary.workspaceName],
    ["Last synced", summary.lastSync],
    [],
    ["Total sales", summary.totalSales],
    ["Total purchases", summary.totalPurchases],
    ["Treasury balance", summary.treasuryBalance],
  ];
  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: "Summary" });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "Summary!A1",
    valueInputOption: "RAW",
    requestBody: { values: summaryValues },
  });

  for (const t of TAB_SPECS) {
    const data = (tables[t.table] ?? []) as Record<string, unknown>[];
    const values = [
      t.columns.map((c) => c.label),
      ...data.map((row) => t.columns.map((c) => cellValue(row, c))),
    ];
    await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: t.tab });
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${t.tab}!A1`,
      valueInputOption: "RAW",
      requestBody: { values },
    });
  }

  // ── Formatting requests ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requests: any[] = [];
  const headerFmt = (sid: number, cols: number) => {
    requests.push({
      repeatCell: {
        range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: cols },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: HEADER_BG,
          },
        },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    });
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: sid, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    });
    requests.push({
      autoResizeDimensions: {
        dimensions: { sheetId: sid, dimension: "COLUMNS", startIndex: 0, endIndex: cols },
      },
    });
  };

  const summaryId = idByTitle.get("Summary");
  if (summaryId != null) {
    requests.push({
      repeatCell: {
        range: { sheetId: summaryId, startRowIndex: 0, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat",
      },
    });
    // Currency format for the totals column (rows 4-6, col B).
    requests.push({
      repeatCell: {
        range: { sheetId: summaryId, startRowIndex: 3, endRowIndex: 6, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: CURRENCY_FORMAT } } },
        fields: "userEnteredFormat.numberFormat",
      },
    });
    requests.push({
      autoResizeDimensions: {
        dimensions: { sheetId: summaryId, dimension: "COLUMNS", startIndex: 0, endIndex: 2 },
      },
    });
  }

  for (const t of TAB_SPECS) {
    const sid = idByTitle.get(t.tab);
    if (sid == null) continue;
    headerFmt(sid, t.columns.length);
    t.columns.forEach((c, i) => {
      if (!c.currency) return;
      requests.push({
        repeatCell: {
          range: { sheetId: sid, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
          cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: CURRENCY_FORMAT } } },
          fields: "userEnteredFormat.numberFormat",
        },
      });
    });
  }

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests } });
  }

  return { sheetId, url: `https://docs.google.com/spreadsheets/d/${sheetId}` };
}

/** Personal sync (per-user OAuth auth). */
export async function syncSnapshotForUser(
  auth: SheetsAuth,
  snapshot: Snapshot,
  summary: BackupSummary,
  sheetId: string | null,
): Promise<{ sheetId: string; url: string }> {
  return writeFormattedWorkbook(auth, sheetId, snapshot, summary);
}

/**
 * Upload a raw JSON snapshot as a new file in the user's own Drive (uses their
 * personal OAuth token — drive.file scope — so it lands in their own storage,
 * fully owned/quota-charged to them). A new dated file each run, no overwrite,
 * so past snapshots stay available as history.
 */
const BACKUP_FOLDER_NAME = "GeduSuite Backups";

/**
 * Find-or-create the "GeduSuite Backups" folder. drive.file scope only sees
 * files/folders THIS app created, so a folder the user made by hand is
 * invisible here — the app maintains its own folder of the same name.
 */
async function ensureBackupFolder(drive: ReturnType<typeof google.drive>): Promise<string> {
  const found = await drive.files.list({
    q: `name = '${BACKUP_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
  });
  const existing = found.data.files?.[0]?.id;
  if (existing) return existing;
  const created = await drive.files.create({
    requestBody: { name: BACKUP_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" },
    fields: "id",
  });
  return created.data.id!;
}

/** One-time tidy: move app-created backup JSONs still loose in My Drive root
 * into the backups folder, so history collects in one place. */
async function sweepLooseBackups(
  drive: ReturnType<typeof google.drive>,
  folderId: string,
): Promise<void> {
  const loose = await drive.files.list({
    q: `name contains 'gedusuite-backup-' and mimeType = 'application/json' and 'root' in parents and trashed = false`,
    fields: "files(id)",
    pageSize: 100,
  });
  for (const f of loose.data.files ?? []) {
    if (!f.id) continue;
    await drive.files.update({ fileId: f.id, addParents: folderId, removeParents: "root" });
  }
}

export async function uploadJsonBackupToDrive(
  auth: SheetsAuth,
  json: string,
  filename: string,
): Promise<{ fileId: string; url: string }> {
  const drive = google.drive({ version: "v3", auth });
  const folderId = await ensureBackupFolder(drive);
  // Best-effort — a failed sweep must never block the fresh backup itself.
  try {
    await sweepLooseBackups(drive, folderId);
  } catch {
    // Old files stay in root until the next run retries.
  }
  const created = await drive.files.create({
    requestBody: { name: filename, mimeType: "application/json", parents: [folderId] },
    media: { mimeType: "application/json", body: json },
    fields: "id",
  });
  const fileId = created.data.id!;
  return { fileId, url: `https://drive.google.com/file/d/${fileId}/view` };
}
