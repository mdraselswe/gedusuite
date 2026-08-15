import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import {
  treasuryBalance,
  refreshOverdueAlerts,
  overdueOrders,
  cashHeldByMember,
  totalDue,
  paidNotDeposited,
  supplierDues,
  totalBusinessProfit,
} from "@/lib/finance";
import { serverT } from "@/lib/session";
import { TreasuryManager } from "@/components/treasury/treasury-manager";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { PageHeader } from "@/components/ui/page-header";
import { Money } from "@/components/ui/money";
import { formatMoney, round2, toneForBalance } from "@/lib/money";
import { dhakaRecordStamp } from "@/lib/dhaka-time";
import { Wallet } from "lucide-react";

const PAGE_SIZE = 50;

export default async function TreasuryPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { workspace: slug } = await params;
  const page = parsePage((await searchParams).page);
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "treasury", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }
  const workspaceId = access.workspaceId;
  const canManage = can(access.role, "treasury", "full", access.permissions);

  const [
    balance,
    profit,
    entryCount,
    entries,
    partners,
    allDue,
    heldCash,
    due,
    notDeposited,
    distributions,
    owedToSuppliers,
  ] = await Promise.all([
      treasuryBalance(workspaceId),
      // Shown beside the balance when distributing: the treasury says what
      // cash is there, this says whether any of it was earned.
      totalBusinessProfit(workspaceId),
      prisma.treasuryEntry.count({ where: { workspaceId } }),
      prisma.treasuryEntry.findMany({
        where: { workspaceId },
        orderBy: { date: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { partner: { include: { user: { select: { name: true, email: true } } } } },
      }),
      prisma.partner.findMany({
        where: { workspaceId },
        include: { user: { select: { name: true, email: true } } },
      }),
      // Every unpaid/partial order (days=0), not just week-old ones — the card
      // itself flags which rows have crossed the overdue threshold. The alert
      // reconciliation below still uses the 7-day cutoff for notifications.
      overdueOrders(workspaceId, 0),
      cashHeldByMember(workspaceId),
      totalDue(workspaceId),
      paidNotDeposited(workspaceId),
      prisma.profitDistribution.findMany({
        where: { workspaceId },
        orderBy: { date: "desc" },
        take: 200, // client-side pagination in the table handles the rest
      }),
      // What the balance above is already spoken for — see the card below.
      supplierDues(workspaceId),
    ]);

  // Keep OVERDUE_PAYMENT notifications reconciled (7-day threshold).
  await refreshOverdueAlerts(workspaceId);

  const entryRows = entries.map((e) => ({
    id: e.id,
    // The money's own date, plus when the line was written — a day's entries
    // are read in the order they happened.
    ...dhakaRecordStamp(e.date, e.createdAt, e.dateHasTime),
    type: e.type,
    amount: Number(e.amount),
    source: e.source,
    note: e.note,
    partnerName: e.partner ? (e.partner.user.name ?? e.partner.user.email) : null,
    fromDeposit: !!e.partnerTxnId,
    fromOrder: !!e.orderId,
    // Carried through so the row can offer the way back. Marking an order's
    // cash deposited takes it out of the "not deposited" list, which is where
    // the only undo lived — so a mis-click had nowhere to go afterwards.
    orderId: e.orderId,
    fromPurchase: !!e.purchaseId || !!e.internalPurchaseId,
    fromDistribution: !!e.distributionId,
    fromBoost: !!e.boostSpendId,
  }));

  // Paid for, not banked yet: sitting in the courier's app until it remits, or
  // in a team member's pocket. Net of the courier's cut, so this is what will
  // actually land rather than what the customer handed over — and a parcel the
  // courier charged for but collected nothing on subtracts here, because that
  // one is going the other way.
  //
  // Kept firmly out of `balance`. Every check that guards real money — can this
  // distribution be covered, can this purchase be paid for — reads that one, and
  // money still in someone else's app can't pay a supplier. This is the other
  // question, the one the balance alone can't answer: how much has the shop
  // taken, whoever is currently holding it.
  const onTheWay = notDeposited.reduce((s, o) => s + o.amount, 0);
  const expected = balance + onTheWay;
  // The same total, split the way the cards below split it: a courier's
  // collections net of its charges, and cash a colleague is carrying. One
  // figure covering both is what makes this line look like a third number
  // that agrees with neither card.
  const withCourierNet = notDeposited
    .filter((o) => o.isCourierCollection || o.amount < 0)
    .reduce((s, o) => s + o.amount, 0);
  const withPeople = round2(onTheWay - withCourierNet);

  const partnerOptions = partners.map((p) => ({
    id: p.id,
    label: p.user.name ?? p.user.email,
  }));

  const sharePartners = partners
    .filter((p) => Number(p.profitSharePercent) > 0)
    .map((p) => ({
      id: p.id,
      label: p.user.name ?? p.user.email,
      percent: Number(p.profitSharePercent),
    }));

  const distributionRows = distributions.map((d) => ({
    id: d.id,
    ...dhakaRecordStamp(d.date, d.createdAt, d.dateHasTime),
    totalAmount: Number(d.totalAmount),
    note: d.note,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Wallet />}
        color="amber"
        count={entryCount}
        title={(await serverT())("treasury")}
        action={
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>
              In hand:{" "}
              <Money
                value={balance}
                tone={toneForBalance(balance)}
                className="text-lg font-bold"
              />
            </span>
            {onTheWay > 0 && (
              <>
                <span
                  // Where it is, not just how much. "On the way" is one figure
                  // covering two quite different situations — a courier holding
                  // a payout, and a colleague holding cash — and the cards below
                  // split them apart while this line did not, so the number
                  // matched neither card and read as a third one.
                  title={`${formatMoney(withCourierNet)} with couriers (their charges already taken off) · ${formatMoney(withPeople)} with the team`}
                >
                  On the way:{" "}
                  <Money value={onTheWay} className="text-lg font-bold" />
                </span>
                {/* The number somebody actually means by "how much have we
                    taken" — the balance answers a narrower question and gets
                    read as this one. */}
                <span>
                  Total:{" "}
                  <Money
                    value={expected}
                    tone={toneForBalance(expected)}
                    className="text-lg font-bold"
                  />
                </span>
              </>
            )}
            <span>
              Due:{" "}
              <Money
                value={due.gross}
                tone={due.gross > 0 ? "negative" : "muted"}
                className="text-lg font-bold"
              />
              {/* What the customer owes and what the shop gets are not the same
                  number when a courier collects it. Both, rather than the
                  invoice alone sitting beside a net figure. */}
              {due.courierCut > 0 && (
                <span className="ml-1 text-xs">
                  (<Money value={due.net} /> after courier)
                </span>
              )}
            </span>
          </div>
        }
      />
      <TreasuryManager
        slug={slug}
        balance={balance}
        entries={entryRows}
        partnerOptions={partnerOptions}
        sharePartners={sharePartners}
        distributions={distributionRows}
        overdue={allDue}
        heldCash={heldCash}
        distributableProfit={profit.distributableProfit}
        netProfit={profit.netProfit}
        alreadyDistributed={profit.distributed}
        supplierDues={owedToSuppliers}
        notDeposited={notDeposited}
        canManage={canManage}
      />
      <Pagination
        page={page}
        totalPages={Math.ceil(entryCount / PAGE_SIZE)}
        basePath={`/${slug}/treasury`}
      />
    </div>
  );
}
