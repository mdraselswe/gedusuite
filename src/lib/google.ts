import { google } from "googleapis";
import type { Snapshot } from "@/lib/backup";

/**
 * Company-level Google integration uses a service account
 * (GOOGLE_SERVICE_ACCOUNT_JSON). Personal per-user backup uses each user's own
 * OAuth token (see google-personal.ts). Both write through the SAME formatter
 * below so the sheets stay visually identical.
 */
export function isGoogleConfigured(): boolean {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
}

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SheetsAuth = any;

function serviceAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Google integration is not configured");
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  return new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
}

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
      { key: "unitCost", label: "Unit cost", currency: true },
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
      { key: "address", label: "Address" },
    ],
  },
  {
    tab: "Orders",
    table: "orders",
    columns: [
      { key: "date", label: "Date", date: true },
      { key: "status", label: "Status" },
      { key: "paymentMethod", label: "Payment method" },
      { key: "paymentStatus", label: "Payment status" },
      { key: "deliveryCharge", label: "Delivery", currency: true },
      { key: "packagingCost", label: "Packaging", currency: true },
      { key: "giftCost", label: "Gift", currency: true },
      { key: "discount", label: "Discount", currency: true },
    ],
  },
  {
    tab: "Partners",
    table: "partners",
    columns: [
      { key: "userId", label: "User" },
      { key: "profitSharePercent", label: "Profit share %" },
      { key: "notes", label: "Notes" },
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
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(v: unknown): string {
  if (!v) return "";
  const d = new Date(v as string);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function cellValue(row: Record<string, unknown>, col: Col): string | number {
  const raw = row[col.key];
  if (raw === null || raw === undefined) return "";
  if (col.date) return fmtDate(raw);
  if (col.currency) return Number(raw);
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  return typeof raw === "number" ? raw : String(raw);
}

export type BackupSummary = {
  workspaceName: string;
  totalSales: number;
  totalPurchases: number;
  treasuryBalance: number;
  lastSync: string;
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
    const data = (snapshot.tables[t.table] ?? []) as Record<string, unknown>[];
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

/** Company-level sync (service account auth). */
export async function syncSnapshotToSheets(
  snapshot: Snapshot,
  summary: BackupSummary,
  sheetId: string | null,
): Promise<{ sheetId: string; url: string }> {
  return writeFormattedWorkbook(serviceAuth(), sheetId, snapshot, summary);
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

/** Upload a JSON snapshot file to Drive (company service account). */
export async function uploadJsonToDrive(
  filename: string,
  json: string,
  folderId: string | null,
): Promise<{ fileId: string; url: string }> {
  const drive = google.drive({ version: "v3", auth: serviceAuth() });
  const res = await drive.files.create({
    requestBody: {
      name: filename,
      mimeType: "application/json",
      ...(folderId ? { parents: [folderId] } : {}),
    },
    media: { mimeType: "application/json", body: json },
    fields: "id, webViewLink",
  });
  return {
    fileId: res.data.id!,
    url: res.data.webViewLink ?? `https://drive.google.com/file/d/${res.data.id}`,
  };
}
