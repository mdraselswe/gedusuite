import { google } from "googleapis";
import { bandLines, type ResellerRow } from "@/lib/reseller-pricing";

/**
 * The reseller price list as a Google Sheet, in the shop's own Drive.
 *
 * The sheet has a column the app never writes: A, the product image. The owner
 * drops pictures in there by hand (Insert → Image → In cell, or =IMAGE("url")),
 * and a sync that rewrote the whole sheet would wipe them every time. So rows
 * are matched by a key — the variant id, in hidden column B — and updated where
 * they stand: new variants are appended, gone ones have their row deleted (the
 * picture goes with it, which is right), and a sort puts everything back in
 * order. Sorting and deleting are structural, so a picture travels with its row.
 *
 * Only ResellerRow reaches this file. It has no cost or profit in it, and
 * nothing here can add one.
 */

type Auth = InstanceType<typeof google.auth.OAuth2>;

export const PRICE_TAB = "Price list";
export const TERMS_TAB = "Terms";

/** Row 4 is the header; data starts on row 5 (1-based, as the sheet shows it). */
const HEADER_ROW = 4;
const FIRST_DATA_ROW = HEADER_ROW + 1;
/**
 * A image, B key, C product, D variant, E SKU, F category, G retail, H the
 * reseller prices. Bands differ from product to product, so H holds a row's
 * own bands one per line ("1 pc: ৳900") rather than a column per band.
 * I, hidden, is the row's place in the app's order: sorting on it keeps the
 * app's rules (uncategorised last) where a sort on the text columns would put
 * empty categories first.
 */
const HEADERS = ["Image", "ID", "Product", "Variant", "SKU", "Category", "Retail price (sell at least)", "Reseller price", "Order"];
const RETAIL_COL = 6;
const PRICE_COL = 7;
const ORDER_COL = 8;
const WIDTH = HEADERS.length;
/** Sheets made before bands moved into one column had one per band, out to here. */
const MAX_COL = "Z";
/** Enough height for this many band lines in the price cell. */
const LINE_PX = 21;

const CURRENCY_FORMAT = '"৳"#,##0';
const HEADER_BG = { red: 0.918, green: 0.929, blue: 0.988 };

function colLetter(index0: number): string {
  let n = index0 + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function q(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

export type SheetContact = { label: string; display: string; url: string };

export type SheetContent = {
  title: string;
  updatedLine: string;
  rows: ResellerRow[];
  notes: string;
  /** A URL Google can fetch, for =IMAGE() in the top-left corner. */
  logoUrl: string | null;
  /** Website, WhatsApp, Facebook: shown under the title, each a link. */
  contacts: SheetContact[];
};

const CONTACT_SEP = "   ·   ";

/** "Website: gedushop.com   ·   WhatsApp: 017…" and where each link sits in it. */
function contactCell(contacts: SheetContact[]) {
  let text = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runs: any[] = [];
  contacts.forEach((c, i) => {
    if (i > 0) text += CONTACT_SEP;
    runs.push({ startIndex: text.length, format: { bold: true } });
    text += `${c.label}: `;
    runs.push({ startIndex: text.length, format: { link: { uri: c.url } } });
    text += c.display;
    runs.push({ startIndex: text.length, format: {} });
  });
  // A run may not start at the very end of the text.
  if (runs.length && runs[runs.length - 1].startIndex >= text.length) runs.pop();
  return { text, runs };
}

const taka = (v: number) => `৳${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function rowValues(r: ResellerRow, order: number): (string | number)[] {
  return [r.key, r.product, r.variant, r.sku, r.category, r.retail, bandLines(r, taka).join("\n"), order];
}

/**
 * Create the spreadsheet: two tabs, and viewers barred from downloading,
 * printing or copying it — the list is for looking at, not for forwarding.
 */
export async function createResellerSheet(auth: Auth, title: string): Promise<string> {
  const sheets = google.sheets({ version: "v4", auth });
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [{ properties: { title: PRICE_TAB } }, { properties: { title: TERMS_TAB } }],
    },
  });
  const id = created.data.spreadsheetId!;
  const drive = google.drive({ version: "v3", auth });
  await drive.files.update({ fileId: id, requestBody: { copyRequiresWriterPermission: true } });
  return id;
}

/** Is the sheet still there? A deleted or trashed one is as good as gone. */
export async function sheetExists(auth: Auth, sheetId: string): Promise<boolean> {
  const drive = google.drive({ version: "v3", auth });
  try {
    const f = await drive.files.get({ fileId: sheetId, fields: "id,trashed" });
    return !f.data.trashed;
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 404) return false;
    throw e;
  }
}

/** Bring the sheet up to date without disturbing the image column. */
export async function writeResellerSheet(auth: Auth, sheetId: string, content: SheetContent): Promise<void> {
  const sheets = google.sheets({ version: "v4", auth });

  // Tabs may have been renamed or removed by hand; put back what's missing.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
  const tabId = new Map<string, number>();
  for (const s of meta.data.sheets ?? []) {
    if (s.properties?.title != null && s.properties.sheetId != null) tabId.set(s.properties.title, s.properties.sheetId);
  }
  const missing = [PRICE_TAB, TERMS_TAB].filter((t) => !tabId.has(t));
  if (missing.length) {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
    });
    for (const r of res.data.replies ?? []) {
      const p = r.addSheet?.properties;
      if (p?.title != null && p.sheetId != null) tabId.set(p.title, p.sheetId);
    }
  }
  const priceTab = tabId.get(PRICE_TAB)!;

  // ── Which rows hold which variant ──
  const keyRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${q(PRICE_TAB)}!B${FIRST_DATA_ROW}:B`,
  });
  const existing = (keyRes.data.values ?? []).map((r) => String(r?.[0] ?? ""));
  const wanted = new Map(content.rows.map((r) => [r.key, r]));
  const order = new Map(content.rows.map((r, i) => [r.key, i + 1]));

  // Rows for variants no longer on the list go, bottom-up so indexes hold.
  const goneIdx = existing
    .map((k, i) => (k && !wanted.has(k) ? i : -1))
    .filter((i) => i >= 0)
    .reverse();
  if (goneIdx.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: goneIdx.map((i) => ({
          deleteDimension: {
            range: {
              sheetId: priceTab,
              dimension: "ROWS",
              startIndex: FIRST_DATA_ROW - 1 + i,
              endIndex: FIRST_DATA_ROW + i,
            },
          },
        })),
      },
    });
  }
  const remaining = existing.filter((k) => !k || wanted.has(k));

  // ── Values: every column but A ──
  const width = WIDTH;
  const lastCol = colLetter(width - 1);
  const data: { range: string; values: (string | number)[][] }[] = [
    { range: `${q(PRICE_TAB)}!B1:C2`, values: [["", content.title], ["", content.updatedLine]] },
    { range: `${q(PRICE_TAB)}!A${HEADER_ROW}:${lastCol}${HEADER_ROW}`, values: [HEADERS] },
  ];
  const placed = new Set<string>();
  remaining.forEach((k, i) => {
    const row = k ? wanted.get(k) : undefined;
    if (!row) return;
    placed.add(k);
    const r = FIRST_DATA_ROW + i;
    data.push({ range: `${q(PRICE_TAB)}!B${r}:${lastCol}${r}`, values: [rowValues(row, order.get(k)!)] });
  });
  const fresh = content.rows.filter((r) => !placed.has(r.key));
  const appendAt = FIRST_DATA_ROW + remaining.length;
  if (fresh.length) {
    data.push({
      range: `${q(PRICE_TAB)}!B${appendAt}:${lastCol}${appendAt + fresh.length - 1}`,
      values: fresh.map((r) => rowValues(r, order.get(r.key)!)),
    });
  }
  const totalRows = remaining.length + fresh.length;
  const lastDataRow = FIRST_DATA_ROW + totalRows - 1;

  // Columns past the last one held band prices in older sheets; clear them.
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: `${q(PRICE_TAB)}!${colLetter(width)}${HEADER_ROW}:${MAX_COL}`,
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: "RAW", data },
  });

  // ── Terms tab: the shop's notes, one line per row ──
  const termLines = content.notes
    .split(/\r?\n/)
    .map((l) => [l]);
  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: q(TERMS_TAB) });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${q(TERMS_TAB)}!A1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        [content.title],
        [content.updatedLine],
        ...content.contacts.map((c) => [`${c.label}: ${c.display}`]),
        [],
        ...termLines,
      ],
    },
  });

  // ── Order and look ──
  const contact = contactCell(content.contacts);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requests: any[] = [
    // The logo fills A1:A3, beside the title, the date and the contacts.
    { unmergeCells: { range: { sheetId: priceTab, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 } } },
    {
      mergeCells: {
        range: { sheetId: priceTab, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 },
        mergeType: "MERGE_ALL",
      },
    },
    {
      updateCells: {
        range: { sheetId: priceTab, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
        rows: [
          {
            values: [
              content.logoUrl
                ? { userEnteredValue: { formulaValue: `=IMAGE("${content.logoUrl.replace(/"/g, "%22")}")` } }
                : {},
            ],
          },
        ],
        fields: "userEnteredValue",
      },
    },
    {
      updateCells: {
        range: { sheetId: priceTab, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 2, endColumnIndex: 3 },
        rows: [
          {
            values: [
              contact.text
                ? { userEnteredValue: { stringValue: contact.text }, textFormatRuns: contact.runs }
                : {},
            ],
          },
        ],
        fields: "userEnteredValue,textFormatRuns",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: priceTab, dimension: "ROWS", startIndex: 0, endIndex: 3 },
        properties: { pixelSize: 26 },
        fields: "pixelSize",
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId: priceTab, gridProperties: { frozenRowCount: HEADER_ROW } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    {
      repeatCell: {
        range: { sheetId: priceTab, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 2, endColumnIndex: 3 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } } },
        fields: "userEnteredFormat.textFormat",
      },
    },
    {
      repeatCell: {
        range: { sheetId: priceTab, startRowIndex: HEADER_ROW - 1, endRowIndex: HEADER_ROW, startColumnIndex: 0, endColumnIndex: width },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: HEADER_BG,
            wrapStrategy: "WRAP",
            verticalAlignment: "MIDDLE",
          },
        },
        fields: "userEnteredFormat(textFormat,backgroundColor,wrapStrategy,verticalAlignment)",
      },
    },
    // The key and order columns are the sync's bookkeeping, not something to read.
    ...[1, ORDER_COL].map((c) => ({
      updateDimensionProperties: {
        range: { sheetId: priceTab, dimension: "COLUMNS", startIndex: c, endIndex: c + 1 },
        properties: { hiddenByUser: true },
        fields: "hiddenByUser",
      },
    })),
    {
      updateDimensionProperties: {
        range: { sheetId: priceTab, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 90 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: priceTab, dimension: "COLUMNS", startIndex: 2, endIndex: 3 },
        properties: { pixelSize: 260 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: priceTab, dimension: "COLUMNS", startIndex: 3, endIndex: RETAIL_COL },
        properties: { pixelSize: 120 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: priceTab, dimension: "COLUMNS", startIndex: RETAIL_COL, endIndex: RETAIL_COL + 1 },
        properties: { pixelSize: 110 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: priceTab, dimension: "COLUMNS", startIndex: PRICE_COL, endIndex: PRICE_COL + 1 },
        properties: { pixelSize: 190 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: tabId.get(TERMS_TAB)!, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 700 },
        fields: "pixelSize",
      },
    },
  ];
  if (totalRows > 0) {
    const maxLines = Math.max(1, ...content.rows.map((r) => r.bands.length));
    const dataRange = {
      sheetId: priceTab,
      startRowIndex: FIRST_DATA_ROW - 1,
      endRowIndex: lastDataRow,
    };
    requests.push(
      {
        sortRange: {
          range: { ...dataRange, startColumnIndex: 0, endColumnIndex: width },
          sortSpecs: [{ dimensionIndex: ORDER_COL, sortOrder: "ASCENDING" }],
        },
      },
      {
        repeatCell: {
          range: { ...dataRange, startColumnIndex: RETAIL_COL, endColumnIndex: RETAIL_COL + 1 },
          cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: CURRENCY_FORMAT } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        repeatCell: {
          range: { ...dataRange, startColumnIndex: 2, endColumnIndex: width },
          cell: { userEnteredFormat: { verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" } },
          fields: "userEnteredFormat(verticalAlignment,wrapStrategy)",
        },
      },
      {
        repeatCell: {
          range: { ...dataRange, startColumnIndex: PRICE_COL, endColumnIndex: PRICE_COL + 1 },
          cell: { userEnteredFormat: { horizontalAlignment: "LEFT" } },
          fields: "userEnteredFormat.horizontalAlignment",
        },
      },
      // Tall enough for a product picture in column A to be worth looking at,
      // and for every line of the longest price cell.
      {
        updateDimensionProperties: {
          range: { sheetId: priceTab, dimension: "ROWS", startIndex: FIRST_DATA_ROW - 1, endIndex: lastDataRow },
          properties: { pixelSize: Math.max(64, maxLines * LINE_PX + 8) },
          fields: "pixelSize",
        },
      },
    );
  }
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests } });
}

// ── Sharing ──────────────────────────────────────────────────────────

/** Give one reseller view-only access. Google emails them the link. */
export async function addSheetViewer(auth: Auth, sheetId: string, email: string, message?: string): Promise<void> {
  const drive = google.drive({ version: "v3", auth });
  await drive.permissions.create({
    fileId: sheetId,
    sendNotificationEmail: true,
    ...(message ? { emailMessage: message } : {}),
    requestBody: { type: "user", role: "reader", emailAddress: email },
  });
}

export async function removeSheetViewer(auth: Auth, sheetId: string, email: string): Promise<void> {
  const drive = google.drive({ version: "v3", auth });
  const list = await drive.permissions.list({
    fileId: sheetId,
    fields: "permissions(id,emailAddress,role,type)",
  });
  const target = email.toLowerCase();
  for (const p of list.data.permissions ?? []) {
    // Never the owner, whatever address was typed.
    if (p.role === "owner" || !p.id) continue;
    if (p.type === "user" && p.emailAddress?.toLowerCase() === target) {
      await drive.permissions.delete({ fileId: sheetId, permissionId: p.id });
    }
  }
}

/** Anyone with the link can view, or only the people it was shared with. */
export async function setSheetPublic(auth: Auth, sheetId: string, on: boolean): Promise<void> {
  const drive = google.drive({ version: "v3", auth });
  if (on) {
    await drive.permissions.create({
      fileId: sheetId,
      requestBody: { type: "anyone", role: "reader" },
    });
    return;
  }
  try {
    await drive.permissions.delete({ fileId: sheetId, permissionId: "anyoneWithLink" });
  } catch (e) {
    if ((e as { code?: number }).code !== 404) throw e;
  }
}

/** The address of the Google account the tokens belong to. */
export async function googleAccountEmail(auth: Auth): Promise<string | null> {
  const drive = google.drive({ version: "v3", auth });
  const about = await drive.about.get({ fields: "user(emailAddress)" });
  return about.data.user?.emailAddress ?? null;
}

export function sheetUrl(sheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${sheetId}`;
}
