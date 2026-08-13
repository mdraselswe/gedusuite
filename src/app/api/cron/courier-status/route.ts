import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { denyCron } from "@/lib/cron-auth";
import { syncCourierStatuses } from "@/lib/courier-status-sync";

/**
 * The nightly sweep for parcel statuses.
 *
 * Daily because that is what a Hobby plan allows, and a day is far too long to
 * be the only time this happens — so the sales page runs the same sync when it
 * is opened, throttled. This is the floor: a shop that goes a week without
 * opening the list still comes back to parcels marked where they actually are.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = denyCron(req);
  if (denied) return denied;

  const res = await syncCourierStatuses({ max: 200 });
  for (const slug of res.slugs) {
    revalidatePath(`/${slug}/sales/orders`);
    revalidatePath(`/${slug}/couriers`);
    revalidatePath(`/${slug}/treasury`);
  }
  return NextResponse.json({
    ok: true,
    checked: res.checked,
    changed: res.changed,
    delivered: res.delivered,
  });
}
