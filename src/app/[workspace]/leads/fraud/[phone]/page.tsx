import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import type { Prisma } from "@prisma/client";
import { AlertTriangle, ArrowLeft, ShieldCheck } from "lucide-react";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { loadCourierCredentials } from "@/lib/courier-credentials";
import { fraudCheck, normalizePhone, type FraudCheck } from "@/lib/steadfast";
import { phoneSearchTerms } from "@/lib/phone";
import { dhakaInstant } from "@/lib/dhaka-time";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_COOLDOWN_MS = 5 * 60 * 1000;

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export default async function LeadFraudPage({
  params,
}: {
  params: Promise<{ workspace: string; phone: string }>;
}) {
  const { workspace: slug, phone: rawPhone } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "sales", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const phone = normalizePhone(decodeURIComponent(rawPhone));
  if (!phone) {
    return (
      <div className="space-y-6">
        <PageHeader icon={<AlertTriangle />} color="rose" title="Fraud check" />
        <p className="text-sm text-muted-foreground">This is not a valid Bangladeshi mobile number.</p>
        <Link href={`/${slug}/leads`} className="inline-flex items-center gap-2 text-sm underline">
          <ArrowLeft className="size-4" />
          Back to call list
        </Link>
      </div>
    );
  }

  const courier = await prisma.courier.findFirst({
    where: {
      workspaceId: access.workspaceId,
      apiProvider: "STEADFAST",
      apiKeyEnc: { not: null },
      apiSecretEnc: { not: null },
    },
    select: { id: true, name: true },
  });
  const creds = courier ? await loadCourierCredentials(courier.id) : null;
  const cached = await prisma.courierFraudCheck.findUnique({
    where: { workspaceId_phone: { workspaceId: access.workspaceId, phone } },
  });
  const now = Date.now();
  const cacheFresh = cached?.checkedAt
    ? now - cached.checkedAt.getTime() < CACHE_TTL_MS
    : false;
  const errorCoolingDown = cached?.errorAt
    ? now - cached.errorAt.getTime() < ERROR_COOLDOWN_MS
    : false;

  let result:
    | Awaited<ReturnType<typeof fraudCheck>>
    | { ok: false; error: string; cachedOnly?: true } = creds
      ? { ok: false, error: "No cached Steadfast result yet", cachedOnly: true }
      : { ok: false, error: "Steadfast API is not connected in Settings > Couriers" };
  if (creds && !cacheFresh && !errorCoolingDown) {
    result = await fraudCheck(creds, phone);
    if (result.ok) {
      await prisma.courierFraudCheck.upsert({
        where: { workspaceId_phone: { workspaceId: access.workspaceId, phone } },
        create: {
          workspaceId: access.workspaceId,
          phone,
          totalParcels: 0,
          totalDelivered: result.data.delivery_ratio ?? 0,
          totalCancelled: result.data.cancellation_ratio ?? result.data.return_ratio ?? 0,
          totalFraudReports: jsonValue(result.data),
          checkedAt: new Date(),
          lastError: null,
          errorAt: null,
        },
        update: {
          totalParcels: 0,
          totalDelivered: result.data.delivery_ratio ?? 0,
          totalCancelled: result.data.cancellation_ratio ?? result.data.return_ratio ?? 0,
          totalFraudReports: jsonValue(result.data),
          checkedAt: new Date(),
          lastError: null,
          errorAt: null,
        },
      });
    } else {
      await prisma.courierFraudCheck.upsert({
        where: { workspaceId_phone: { workspaceId: access.workspaceId, phone } },
        create: {
          workspaceId: access.workspaceId,
          phone,
          totalFraudReports: [],
          lastError: result.error,
          errorAt: new Date(),
        },
        update: {
          lastError: result.error,
          errorAt: new Date(),
        },
      });
    }
  } else if (cached?.lastError && !cacheFresh) {
    result = { ok: false, error: cached.lastError, cachedOnly: true };
  }

  const terms = phoneSearchTerms(phone);
  const localLeads = await prisma.orderLead.findMany({
    where: {
      workspaceId: access.workspaceId,
      OR: terms.flatMap((p) => [{ phone: { contains: p } }, { altPhone: { contains: p } }]),
    },
    orderBy: { orderedAt: "desc" },
    take: 10,
    select: {
      id: true,
      orderNo: true,
      customerName: true,
      phone: true,
      total: true,
      callStatus: true,
      orderedAt: true,
    },
  });

  const rawCache = cached?.totalFraudReports;
  const isScoreObject =
    rawCache &&
    typeof rawCache === "object" &&
    !Array.isArray(rawCache) &&
    ("delivery_ratio" in rawCache || "total_reports" in rawCache || "volume_band" in rawCache);

  const cachedData: FraudCheck | null = isScoreObject
    ? (rawCache as unknown as FraudCheck)
    : cached?.checkedAt
      ? {
          status: 200,
          phone,
          score: null,
          level: null,
          reasons: [],
          scoring_disabled: true,
          doubtful_reports: false,
          total_reports: Array.isArray(rawCache) ? rawCache.length : 0,
          delivery_ratio:
            cached.totalParcels > 0
              ? Math.round((cached.totalDelivered / cached.totalParcels) * 100)
              : cached.totalDelivered > 0
                ? cached.totalDelivered
                : null,
          cancellation_ratio:
            cached.totalParcels > 0
              ? Math.round((cached.totalCancelled / cached.totalParcels) * 100)
              : cached.totalCancelled > 0
                ? cached.totalCancelled
                : null,
          volume_band: cached.totalParcels > 0 ? "medium" : "none",
          fraud_categories: [],
          return_ratio:
            cached.totalParcels > 0
              ? Math.round((cached.totalCancelled / cached.totalParcels) * 100)
              : cached.totalCancelled > 0
                ? cached.totalCancelled
                : null,
        }
      : null;

  const data: FraudCheck | null = result.ok ? result.data : cachedData;
  const error = !result.ok
    ? result.error
    : cached?.checkedAt && cacheFresh
      ? null
      : null;

  const deliveryRatio = data?.delivery_ratio ?? null;
  const cancelRatio = data?.cancellation_ratio ?? data?.return_ratio ?? null;
  const volumeBand = (data?.volume_band ?? "none").toLowerCase();
  const reports = data?.total_reports ?? 0;
  const doubtfulReports = data?.doubtful_reports ?? false;
  const hasHistory = volumeBand !== "none" && deliveryRatio !== null;

  const risky = reports > 0 || (hasHistory && deliveryRatio < 60);

  const volumeLabel: Record<string, string> = {
    none: "None (new customer)",
    low: "Low volume",
    medium: "Medium volume",
    high: "High volume",
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={risky ? <AlertTriangle /> : <ShieldCheck />}
        color={risky ? "rose" : "emerald"}
        title="Fraud check"
        action={
          <Link href={`/${slug}/leads`} className="inline-flex items-center gap-2 text-sm underline">
            <ArrowLeft className="size-4" />
            Call list
          </Link>
        }
      />

      <section className="space-y-3">
        <div>
          <p className="text-sm text-muted-foreground">Phone</p>
          <h2 className="text-xl font-semibold tabular-nums">{phone}</h2>
        </div>
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
            {cached?.checkedAt && " Showing the last saved Steadfast result below."}
          </div>
        )}
        {cached?.checkedAt && !error && (
          <p className="text-xs text-muted-foreground">
            Last checked {cached.checkedAt.toLocaleString("en-US", { timeZone: "Asia/Dhaka" })} Bangladesh time.
          </p>
        )}
      </section>

      {data && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Delivery success rate"
              value={deliveryRatio === null ? "No history" : `${deliveryRatio}%`}
              danger={deliveryRatio !== null && deliveryRatio < 60}
            />
            <Metric
              label="Cancellation rate"
              value={cancelRatio === null ? "No history" : `${cancelRatio}%`}
              danger={cancelRatio !== null && cancelRatio > 40}
            />
            <Metric
              label="Steadfast parcel volume"
              value={volumeLabel[volumeBand] ?? volumeBand}
            />
            <Metric
              label="Fraud reports"
              value={`${reports}${doubtfulReports ? " (doubtful)" : ""}`}
              danger={reports > 0}
            />
          </section>

          <section className="rounded-md border p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">Steadfast delivery record & score</h2>
                <Badge variant={risky ? "destructive" : hasHistory ? "secondary" : "outline"}>
                  {risky
                    ? "Review before shipping"
                    : hasHistory
                      ? deliveryRatio >= 80
                        ? "Reliable customer"
                        : "Moderate delivery record"
                      : "New customer"}
                </Badge>
              </div>
              {courier && <span className="text-xs text-muted-foreground">via {courier.name}</span>}
            </div>

            <div className="grid gap-2 text-sm sm:grid-cols-2 pt-1">
              <p>
                Delivery success:{" "}
                <span className="font-medium tabular-nums">
                  {deliveryRatio !== null ? `${deliveryRatio}%` : "No parcel history"}
                </span>
              </p>
              <p>
                Cancellation / return:{" "}
                <span className="font-medium tabular-nums">
                  {cancelRatio !== null ? `${cancelRatio}%` : "No parcel history"}
                </span>
              </p>
              <p>
                Courier parcel activity:{" "}
                <span className="font-medium capitalize">
                  {volumeLabel[volumeBand] ?? volumeBand}
                </span>
              </p>
              <p>
                Merchant fraud reports:{" "}
                <span className={cn("font-medium tabular-nums", reports > 0 && "font-semibold text-destructive")}>
                  {reports}
                  {doubtfulReports && " (marked doubtful)"}
                </span>
              </p>
              {data.score !== null && data.score !== undefined && (
                <p>
                  Fraud score: <span className="font-medium">{data.score}</span>
                </p>
              )}
              {data.level && (
                <p>
                  Risk level: <span className="font-medium capitalize">{data.level}</span>
                </p>
              )}
            </div>

            {Array.isArray(data.reasons) && data.reasons.length > 0 && (
              <div className="rounded border bg-muted/40 p-2.5 text-xs">
                <p className="font-semibold text-foreground mb-1">Report reasons:</p>
                <ul className="list-inside list-disc space-y-0.5 text-muted-foreground">
                  {data.reasons.map((r: unknown, i: number) => (
                    <li key={i}>{String(r)}</li>
                  ))}
                </ul>
              </div>
            )}

            {Array.isArray(data.fraud_categories) && data.fraud_categories.length > 0 && (
              <div className="rounded border bg-muted/40 p-2.5 text-xs">
                <p className="font-semibold text-foreground mb-1">Fraud categories:</p>
                <div className="flex flex-wrap gap-1">
                  {data.fraud_categories.map((c: unknown, i: number) => (
                    <Badge key={i} variant="outline" className="text-xs">
                      {String(c)}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </section>
        </>
      )}

      <section className="rounded-md border p-4">
        <h2 className="mb-3 font-semibold">Local call-list history</h2>
        {localLeads.length === 0 ? (
          <p className="text-sm text-muted-foreground">No GeduSuite call-list rows found for this number.</p>
        ) : (
          <div className="divide-y">
            {localLeads.map((lead) => {
              const stamped = dhakaInstant(lead.orderedAt);
              return (
                <div key={lead.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">{lead.customerName}</p>
                    <p className="text-xs text-muted-foreground">
                      {lead.orderNo ?? "No order no."} · {stamped.date} {stamped.time} · {lead.callStatus.replace(/_/g, " ").toLowerCase()}
                    </p>
                  </div>
                  <span className="shrink-0 font-medium tabular-nums">
                    <Money value={Number(lead.total)} />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="rounded-md border p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={danger ? "mt-1 text-2xl font-semibold text-destructive" : "mt-1 text-2xl font-semibold"}>
        {value}
      </p>
    </div>
  );
}
