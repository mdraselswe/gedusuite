import { createHash } from "node:crypto";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/crypto";
import { oauthClient } from "@/lib/google-personal";
import { loadResellerList } from "@/lib/reseller-list";
import { createResellerSheet, sheetExists, writeResellerSheet, addSheetViewer, setSheetPublic } from "@/lib/reseller-sheet";
import { dhakaStampLine } from "@/lib/dhaka-time";
import { appUrl } from "@/lib/mailer";
import { facebookContact, parsePrintProfile, websiteContact, whatsappContact } from "@/lib/print-profile";

/**
 * Keeping the reseller sheet in step with the app.
 *
 * Every save that can move a reseller price (a product, a variant, a purchase
 * that changes cost, the list's own settings) calls queueResellerSync, which
 * does the work after the response has gone — the person saving never waits on
 * Google. Saves close together share one sync: see the lock on
 * ResellerPriceList.syncLockedUntil.
 */

const LOCK_MS = 120_000;

type ListTokens = {
  googleAccessToken: string | null;
  googleRefreshToken: string | null;
  googleExpiryDate: bigint | null;
};

export function resellerGoogleClient(list: ListTokens) {
  if (!list.googleAccessToken) return null;
  const client = oauthClient();
  client.setCredentials({
    access_token: decrypt(list.googleAccessToken) ?? undefined,
    refresh_token: list.googleRefreshToken ? (decrypt(list.googleRefreshToken) ?? undefined) : undefined,
    expiry_date: list.googleExpiryDate ? Number(list.googleExpiryDate) : undefined,
  });
  return client;
}

/** Keep a refreshed access token, so the next call doesn't refresh again. */
export async function persistResellerTokens(
  workspaceId: string,
  client: NonNullable<ReturnType<typeof resellerGoogleClient>>,
): Promise<void> {
  const c = client.credentials;
  if (!c.access_token) return;
  await prisma.resellerPriceList.update({
    where: { workspaceId },
    data: {
      googleAccessToken: encrypt(c.access_token),
      ...(c.expiry_date ? { googleExpiryDate: BigInt(c.expiry_date) } : {}),
    },
  });
}

export function parseViewers(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string") : [];
}

function googleError(e: unknown): string {
  const err = e as { message?: string; response?: { data?: { error?: { message?: string } | string } } };
  const data = err.response?.data?.error;
  const msg = (typeof data === "string" ? data : data?.message) ?? err.message ?? "Unknown error";
  if (/invalid_grant/i.test(msg)) return "Google access was revoked or expired — reconnect the Google account.";
  return msg;
}

/** The shop's logo and how to reach it, as the sheet shows them. */
function brand(ws: { slug: string; logoUrl: string | null; websiteUrl: string | null; printProfile: unknown }) {
  const p = parsePrintProfile(ws.printProfile);
  const contacts = [
    ["Website", websiteContact(ws.websiteUrl)],
    ["WhatsApp", whatsappContact(p.whatsapp)],
    ["Facebook", facebookContact(p.facebook)],
  ] as const;
  const base = appUrl();
  // Google fetches the image itself, so a local address is no use to it. The
  // version makes it fetch again when the logo changes.
  const logoUrl =
    ws.logoUrl && !/localhost|127\.0\.0\.1/.test(base)
      ? `${base}/api/brand/${ws.slug}/logo?v=${createHash("sha1").update(ws.logoUrl).digest("hex").slice(0, 8)}`
      : null;
  return {
    logoUrl,
    contacts: contacts.flatMap(([label, c]) => (c ? [{ label, display: c.display, url: c.url }] : [])),
  };
}

/**
 * Write the sheet once. Creates it first when `create` is set and there is none
 * (or the old one was deleted), sharing it again with everyone on the list.
 */
async function writeOnce(workspaceId: string, create: boolean): Promise<string> {
  const list = await prisma.resellerPriceList.findUnique({
    where: { workspaceId },
    include: { workspace: { select: { name: true, slug: true, logoUrl: true, websiteUrl: true, printProfile: true } } },
  });
  const client = list && resellerGoogleClient(list);
  if (!list || !client) throw new Error("Connect a Google account first.");

  let sheetId = list.sheetId;
  if (sheetId && !(await sheetExists(client, sheetId))) sheetId = null;
  if (!sheetId) {
    if (!create) throw new Error("The Google Sheet was deleted. Create it again from the reseller page.");
    sheetId = await createResellerSheet(client, `${list.workspace.name} — ${list.title}`);
    await prisma.resellerPriceList.update({ where: { workspaceId }, data: { sheetId } });
    for (const email of parseViewers(list.viewers)) {
      await addSheetViewer(client, sheetId, email);
    }
    if (list.publicLink) await setSheetPublic(client, sheetId, true);
  }

  const { settings, resellerRows } = await loadResellerList(workspaceId);
  await writeResellerSheet(client, sheetId, {
    title: `${list.workspace.name} — ${settings.title}`,
    updatedLine: `Updated ${dhakaStampLine(new Date())}`,
    rows: resellerRows,
    notes: settings.notes,
    ...brand(list.workspace),
  });
  await persistResellerTokens(workspaceId, client);
  return sheetId;
}

/**
 * Sync now, under the lock. Returns once the sheet is current — or straight
 * away with `queued` when another sync holds it, which will pick this change
 * up before it lets go.
 */
export async function syncResellerSheet(
  workspaceId: string,
  opts: { create?: boolean } = {},
): Promise<{ ok: true; queued?: boolean } | { ok: false; error: string }> {
  const now = new Date();
  const claimed = await prisma.resellerPriceList.updateMany({
    where: {
      workspaceId,
      googleAccessToken: { not: null },
      OR: [{ syncLockedUntil: null }, { syncLockedUntil: { lt: now } }],
    },
    data: { syncLockedUntil: new Date(now.getTime() + LOCK_MS), syncPending: false },
  });
  if (claimed.count === 0) {
    const marked = await prisma.resellerPriceList.updateMany({
      where: { workspaceId, googleAccessToken: { not: null } },
      data: { syncPending: true },
    });
    return marked.count ? { ok: true, queued: true } : { ok: false, error: "Connect a Google account first." };
  }

  try {
    let create = opts.create ?? false;
    for (;;) {
      await writeOnce(workspaceId, create);
      create = false;
      // Let go only if nothing asked for another pass meanwhile; otherwise go
      // round again with the lock still held.
      const released = await prisma.resellerPriceList.updateMany({
        where: { workspaceId, syncPending: false },
        data: { syncLockedUntil: null, lastSyncedAt: new Date(), lastSyncError: null },
      });
      if (released.count) return { ok: true };
      await prisma.resellerPriceList.update({
        where: { workspaceId },
        data: { syncPending: false, syncLockedUntil: new Date(Date.now() + LOCK_MS) },
      });
    }
  } catch (e) {
    const error = googleError(e);
    await prisma.resellerPriceList.update({
      where: { workspaceId },
      data: { syncLockedUntil: null, lastSyncError: error },
    });
    return { ok: false, error };
  }
}

/**
 * Something that moves reseller prices was saved: bring the sheet along, after
 * the response. Costs one indexed read when the shop has no sheet.
 */
export function queueResellerSync(workspaceId: string): void {
  const job = async () => {
    try {
      const list = await prisma.resellerPriceList.findUnique({
        where: { workspaceId },
        select: { sheetId: true, googleAccessToken: true },
      });
      if (!list?.sheetId || !list.googleAccessToken) return;
      await syncResellerSheet(workspaceId);
    } catch {
      // Recorded on the list by syncResellerSheet where it can be; a sync is
      // never allowed to fail the save that set it off.
    }
  };
  try {
    after(job);
  } catch {
    // Outside a request (a script, a test) there is no "after the response";
    // just run it.
    void job();
  }
}
