import { prisma } from "@/lib/prisma";
import { parcelJourney } from "@/lib/parcel-journey";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { DHAKA_TZ, formatDhakaTime } from "@/lib/dhaka-time";
import { formatMoney as money } from "@/lib/money";

/**
 * Where this parcel got to, in five lines.
 *
 * Sits above the change history rather than instead of it. The history answers
 * "why does this order say what it says" and needs every edit to do it; this
 * answers "where is it", which is what gets asked with a customer on the phone,
 * and twelve rows including two campaign tags is the wrong shape for that.
 *
 * A server component with its own query, like RecordHistory beside it — the
 * page drops it in and threads nothing through.
 */

/**
 * Dhaka, because that is where the person reading this is — and the clock the
 * rest of the app already shows, through the same formatter, so a step here
 * and the history row it came from never disagree about what 10:20 means.
 */
const dayFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: DHAKA_TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
});

export async function ParcelJourney({
  workspaceId,
  orderId,
}: {
  workspaceId: string;
  orderId: string;
}) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    select: {
      createdAt: true,
      status: true,
      deliveryType: true,
      courierTrackingId: true,
      courierStatus: true,
      courierStatusAt: true,
      cashInTreasury: true,
      returnLeg: true,
      returnLegAt: true,
      cancelledCollected: true,
      deliveryCharge: true,
      deliveryCost: true,
      courier: { select: { name: true } },
      courierZone: { select: { name: true } },
    },
  });
  if (!order) return null;

  const activity = await prisma.activityLog.findMany({
    where: { workspaceId, entity: "Order", entityId: orderId },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, summary: true, changes: true, action: true },
  });

  const steps = parcelJourney(
    { ...order, cancelledCollected: Number(order.cancelledCollected) },
    activity,
  );
  // The step the parcel is actually on: the last one behind it. Drawn solid
  // while the ones ahead stay hollow, so the eye lands on it without reading.
  const current = steps.map((s) => s.done).lastIndexOf(true);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Where this parcel got to</CardTitle>
        {/* Where it was going, on its own line and above the steps, because
            the zone is the fact the delivery charge comes out of and the one
            nobody can recover from the dates. A parcel to Keraniganj booked on
            the Dhaka City rate looks exactly like a correct one until a payout
            disagrees — so the zone and what the trip actually cost are shown
            together, which is the pair that gives it away. */}
        {order.deliveryType === "COURIER" && (
          <p className="text-sm text-muted-foreground">
            {order.courier?.name ?? "Courier"}
            {" · "}
            {order.courierZone ? (
              <span className="font-medium text-foreground">{order.courierZone.name}</span>
            ) : (
              <span className="text-amber-700 dark:text-amber-400">no zone set</span>
            )}
            {" · "}
            {money(Number(order.deliveryCost ?? order.deliveryCharge))} delivery
            {order.courierTrackingId && ` · ${order.courierTrackingId}`}
          </p>
        )}
        {order.deliveryType !== "COURIER" && (
          <p className="text-sm text-muted-foreground">Delivered by us, no courier</p>
        )}
      </CardHeader>
      <CardContent>
        <ol className="space-y-0">
          {steps.map((step, i) => {
            const on = i === current;
            const when = step.at
              ? { day: dayFmt.format(step.at), time: formatDhakaTime(step.at) }
              : null;
            return (
              <li key={step.key} className="flex gap-3">
                {/* The rail: a dot per step and a line between them, with the
                    last line left off so the list ends rather than trails. */}
                <div className="flex flex-col items-center">
                  <span
                    className={cn(
                      "mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border-2",
                      step.done
                        ? on
                          ? "border-primary bg-background"
                          : "border-primary bg-primary text-primary-foreground"
                        : "border-muted-foreground/30 bg-background",
                    )}
                  >
                    {step.done && !on && <Check className="size-2.5" strokeWidth={4} />}
                    {on && <span className="size-1.5 rounded-full bg-primary" />}
                  </span>
                  {i < steps.length - 1 && (
                    <span
                      className={cn(
                        "w-0.5 flex-1",
                        steps[i + 1].done ? "bg-primary" : "bg-muted-foreground/20",
                      )}
                    />
                  )}
                </div>

                <div className={cn("pb-5", i === steps.length - 1 && "pb-0")}>
                  <p
                    className={cn(
                      "text-sm leading-5",
                      step.done ? "font-medium" : "text-muted-foreground",
                    )}
                  >
                    {step.label}
                  </p>
                  {when ? (
                    <p className="text-xs text-muted-foreground">
                      {when.day} · {when.time}
                    </p>
                  ) : (
                    step.done && (
                      // Done, and nobody wrote down when. Said out loud, because
                      // a blank here reads as "hasn't happened".
                      <p className="text-xs text-muted-foreground">no time recorded</p>
                    )
                  )}
                  {step.detail && (
                    <p className="text-xs text-muted-foreground">{step.detail}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
