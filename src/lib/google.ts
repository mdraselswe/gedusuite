import { google } from "googleapis";
import type { Snapshot } from "@/lib/backup";

/**
 * Google integration is enabled by setting GOOGLE_SERVICE_ACCOUNT_JSON to the
 * full service-account key JSON (share the target Drive/Sheet with that account's
 * email). Without it, all functions here report "not configured" and the UI
 * degrades gracefully — the JSON backup/restore still works locally.
 */
export function isGoogleConfigured(): boolean {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
}

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

function getAuth() {
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

// Which snapshot tables become human-readable sheet tabs, with column order.
const SHEET_TABS: { tab: string; table: keyof Snapshot["tables"] | string; columns: string[] }[] = [
  { tab: "Suppliers", table: "suppliers", columns: ["name", "phone", "address", "notes"] },
  { tab: "Products", table: "products", columns: ["name", "category", "sku", "barcode", "expiryTracked", "lowStockThreshold"] },
  { tab: "Purchases", table: "purchases", columns: ["date", "productVariantId", "supplierId", "unitCost", "quantity", "expiryDate"] },
  { tab: "Customers", table: "customers", columns: ["name", "phone", "address", "notes"] },
  { tab: "Orders", table: "orders", columns: ["date", "status", "customerId", "paymentMethod", "paymentStatus", "deliveryCharge", "packagingCost", "giftCost", "discount"] },
  { tab: "Partners", table: "partners", columns: ["userId", "profitSharePercent", "notes"] },
  { tab: "Treasury", table: "treasuryEntries", columns: ["date", "type", "amount", "source", "note", "partnerId"] },
  { tab: "Internal Purchases", table: "internalPurchases", columns: ["date", "itemName", "category", "supplierName", "cost", "quantity"] },
];

function cell(v: unknown): string | number {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/**
 * Sync a snapshot to a per-workspace Google Sheet — one tab per module, with
 * header rows. Creates the spreadsheet if `sheetId` is null. Returns its id/url.
 */
export async function syncSnapshotToSheets(
  snapshot: Snapshot,
  workspaceName: string,
  sheetId: string | null,
): Promise<{ sheetId: string; url: string }> {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // Create the spreadsheet with all tabs if we don't have one yet.
  if (!sheetId) {
    const created = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: `GeduSuite Backup — ${workspaceName}` },
        sheets: SHEET_TABS.map((t) => ({ properties: { title: t.tab } })),
      },
    });
    sheetId = created.data.spreadsheetId!;

    // Protect every tab so the human-readable backup can't be edited by accident.
    const protectRequests = (created.data.sheets ?? [])
      .filter((s) => s.properties?.sheetId != null)
      .map((s) => ({
        addProtectedRange: {
          protectedRange: {
            range: { sheetId: s.properties!.sheetId! },
            description: "GeduSuite backup — view only",
            warningOnly: true,
          },
        },
      }));
    if (protectRequests.length) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: { requests: protectRequests },
      });
    }
  } else {
    // Ensure every tab exists on the existing spreadsheet.
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));
    const toAdd = SHEET_TABS.filter((t) => !existing.has(t.tab));
    if (toAdd.length) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: toAdd.map((t) => ({ addSheet: { properties: { title: t.tab } } })),
        },
      });
    }
  }

  // Write each tab: clear, then header + rows.
  for (const t of SHEET_TABS) {
    const data = (snapshot.tables[t.table] ?? []) as Record<string, unknown>[];
    const values = [t.columns, ...data.map((row) => t.columns.map((c) => cell(row[c])))];
    await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: `${t.tab}` });
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${t.tab}!A1`,
      valueInputOption: "RAW",
      requestBody: { values },
    });
  }

  return { sheetId, url: `https://docs.google.com/spreadsheets/d/${sheetId}` };
}

/** Upload a JSON snapshot file to Drive (optionally inside a folder). */
export async function uploadJsonToDrive(
  filename: string,
  json: string,
  folderId: string | null,
): Promise<{ fileId: string; url: string }> {
  const auth = getAuth();
  const drive = google.drive({ version: "v3", auth });
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
