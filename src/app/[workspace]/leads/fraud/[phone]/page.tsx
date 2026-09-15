import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import type { Prisma } from "@prisma/client";
import { AlertTriangle, ArrowLeft, ShieldCheck } from "lucide-react";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { loadCourierCredentials } from "@/lib/courier-credentials";
import { fraudCheck, normalizePhone } from "@/lib/steadfast";
import { phoneSearchTerms } from "@/lib/phone";
import { dhakaInstant } from "@/lib/dhaka-time";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_COOLDOWN_MS = 5 * 60 * 1000;

function jsonArray(value: unknown[]): Prisma.InputJsonValue {
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
          totalParcels: result.data.total_parcels,
          totalDelivered: result.data.total_delivered,
          totalCancelled: result.data.total_cancelled,
          totalFraudReports: jsonArray(result.data.total_fraud_reports),
          checkedAt: new Date(),
          lastError: null,
          errorAt: null,
        },
        update: {
          totalParcels: result.data.total_parcels,
          totalDelivered: result.data.total_delivered,
          totalCancelled: result.data.total_cancelled,
          totalFraudReports: jsonArray(result.data.total_fraud_reports),
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

  const cachedReports = Array.isArray(cached?.totalFraudReports)
    ? cached.totalFraudReports
    : [];
  const data = result.ok
    ? result.data
    : cached?.checkedAt
      ? {
          total_parcels: cached.totalParcels,
          total_delivered: cached.totalDelivered,
          total_cancelled: cached.totalCancelled,
          total_fraud_reports: cachedReports,
        }
      : null;
  const error = !result.ok
    ? result.error
    : cached?.checkedAt && cacheFresh
      ? null
      : null;
  const total = data?.total_parcels ?? 0;
  const delivered = data?.total_delivered ?? 0;
  const cancelled = data?.total_cancelled ?? 0;
  const reports = Array.isArray(data?.total_fraud_reports) ? data.total_fraud_reports.length : 0;
  const successRate = total > 0 ? Math.round((delivered / total) * 100) : null;
  const cancelRate = total > 0 ? Math.round((cancelled / total) * 100) : null;
  const risky = reports > 0 || (total >= 3 && successRate !== null && successRate < 60);

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
            <Metric label="Success rate" value={successRate === null ? "No history" : `${successRate}%`} />
            <Metric label="Delivered" value={delivered} />
            <Metric label="Cancelled" value={cancelRate === null ? cancelled : `${cancelled} (${cancelRate}%)`} />
            <Metric label="Fraud reports" value={reports} danger={reports > 0} />
          </section>

          <section className="rounded-md border p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">Steadfast summary</h2>
              <Badge variant={risky ? "destructive" : "secondary"}>
                {risky ? "Review before shipping" : "Looks clean"}
              </Badge>
              {courier && <span className="text-xs text-muted-foreground">via {courier.name}</span>}
            </div>
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <p>Total parcels: <span className="font-medium tabular-nums">{total}</span></p>
              <p>Total delivered: <span className="font-medium tabular-nums">{delivered}</span></p>
              <p>Total cancelled: <span className="font-medium tabular-nums">{cancelled}</span></p>
              <p>Total fraud reports: <span className="font-medium tabular-nums">{reports}</span></p>
            </div>
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
