import Link from "next/link";
import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { partnerBalances, totalBusinessProfit, businessCapitalSummary } from "@/lib/finance";
import { unlinkedPartnerFundingCount } from "@/lib/partner-credit";
import { splitByShare, sharesAreNormalized } from "@/lib/profit-share";
import { serverT } from "@/lib/session";
import { PartnerManager } from "@/components/partners/partner-manager";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Handshake } from "lucide-react";

export default async function PartnersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "partners", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }
  const workspaceId = access.workspaceId;
  const canManage = can(access.role, "partners", "full", access.permissions);
  const canReconcile = can(access.role, "partners", "edit", access.permissions);

  const [partners, balances, profit, members, capital, unreconciled] = await Promise.all([
    prisma.partner.findMany({
      where: { workspaceId },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    partnerBalances(workspaceId),
    totalBusinessProfit(workspaceId),
    prisma.membership.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    businessCapitalSummary(workspaceId),
    canReconcile ? unlinkedPartnerFundingCount(workspaceId) : Promise.resolve(0),
  ]);

  // Full transparency model (owner's decision): every partner sees every
  // partner's record. Managing (add/edit/delete) is still gated by canManage.
  //
  // Shares come from splitByShare — the same function a distribution pays out
  // with — against profit AFTER the ads and internal purchases are covered.
  // Both of those used to be missing here, so this table promised each partner
  // a cut of money the business had already spent.
  const cuts = splitByShare(
    partners.map((p) => ({ id: p.id, percent: Number(p.profitSharePercent) })),
    profit.netProfit,
  );
  const cutById = new Map(cuts.map((c) => [c.id, c]));

  const rows = partners.map((p) => {
    const b = balances.get(p.id);
    const cut = cutById.get(p.id);
    return {
      id: p.id,
      name: p.user.name ?? p.user.email,
      profitSharePercent: Number(p.profitSharePercent),
      effectiveSharePercent: cut?.effectivePercent ?? 0,
      invested: b?.invested ?? 0,
      withdrawn: b?.withdrawn ?? 0,
      capitalWithdrawn: b?.capitalWithdrawn ?? 0,
      customerProductSpend: b?.customerProductSpend ?? 0,
      internalPurchaseSpend: b?.internalPurchaseSpend ?? 0,
      boostSpend: b?.boostSpend ?? 0,
      miscExpense: b?.miscExpense ?? 0,
      expenses: b?.expenses ?? 0,
      depositedToTreasury: b?.depositedToTreasury ?? 0,
      netCapital: b?.netCapital ?? 0,
      remaining: b?.remaining ?? 0,
      profitShareAmount: cut?.amount ?? 0,
    };
  });
  const sharesNormalized = sharesAreNormalized(rows.map((r) => ({ percent: r.profitSharePercent })));

  // Members who aren't partners yet (for the add form).
  const partnerUserIds = new Set(partners.map((p) => p.userId));
  const memberOptions = members
    .filter((m) => !partnerUserIds.has(m.userId))
    .map((m) => ({ userId: m.userId, label: m.user.name ?? m.user.email }));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Handshake />}
        color="cyan"
        count={partners.length}
        title={(await serverT())("partners")}
        action={
          <span className="text-sm text-muted-foreground">
            Distributable profit:{" "}
            <span className="font-semibold text-foreground">{profit.netProfit.toFixed(2)}</span>
          </span>
        }
      />

      {/* The derivation, not just the answer: a partner asking why their share
          moved should be able to read the reason off this card rather than
          take the total on trust. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">How distributable profit is worked out</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {(
            [
              ["Order profit (returns and cancellations applied)", profit.tradingProfit, false],
              ["Ad spend", -profit.adSpend, true],
              ["Internal purchases", -profit.internalPurchaseSpend, true],
              ["Other partner expenses", -profit.miscExpense, true],
              ["Damaged / lost stock", -profit.stockLoss, true],
            ] as [string, number, boolean][]
          )
            .filter(([, value], i) => i === 0 || value !== 0)
            .map(([label, value, muted]) => (
              <div key={label} className="flex justify-between gap-3 border-b py-1.5">
                <span>{label}</span>
                <span className={`tabular-nums ${muted ? "text-muted-foreground" : ""}`}>
                  {value < 0 ? "−" : ""}
                  {Math.abs(value).toFixed(2)}
                </span>
              </div>
            ))}
          <div className="flex justify-between gap-3 pt-1.5 font-semibold">
            <span>Distributable profit</span>
            <span
              className={`tabular-nums ${profit.netProfit < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}`}
            >
              {profit.netProfit.toFixed(2)}
            </span>
          </div>
          {profit.prepaidExpenses > 0 && (
            <div className="mt-2 flex justify-between gap-3 border-t pt-2">
              <span className="text-muted-foreground">
                Paid for but not yet expensed
                <span className="block text-xs">
                  spread costs with months left to run — this money has already left
                  the account, so it isn&apos;t available to distribute
                </span>
              </span>
              <span className="tabular-nums text-muted-foreground">
                {profit.prepaidExpenses.toFixed(2)}
              </span>
            </div>
          )}
          <p className="pt-2 text-xs text-muted-foreground">
            Expenses come off in the period they were paid for, unless a purchase says
            how many months it covers. Stock bought to resell is separate again: that
            reaches profit as cost of goods sold when it sells, not when it&apos;s bought.
          </p>
          {!sharesNormalized && (
            <p className="pt-2 text-xs text-muted-foreground">
              The profit shares don&apos;t add up to 100%, so each partner is paid their
              percent of the total in use rather than of 100 — the &quot;Effective %&quot;
              column. A distribution splits the money exactly the same way.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Purchases made before the credit was derived from the purchase — until
          they're resolved, these partners' "invested" totals may be missing
          money they actually put in. Disappears once the list is empty. */}
      {unreconciled > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-semibold text-amber-800 dark:text-amber-300">
            {unreconciled} partner-funded {unreconciled === 1 ? "purchase has" : "purchases have"}{" "}
            no investment credit linked
          </p>
          <p className="mt-1 text-muted-foreground">
            Those purchases count as spending but the money the partner put in to make them
            isn&apos;t counted, so &quot;Remaining&quot; reads lower than it is.{" "}
            <Link
              href={`/${slug}/partners/reconcile`}
              className="font-medium text-foreground underline"
            >
              Reconcile them
            </Link>
            .
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total invested
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">
            {capital.totalInvested.toFixed(2)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Customer products
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-bold">
            {capital.customerProductSpend.toFixed(2)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Internal purchases
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-bold">
            {capital.internalPurchaseSpend.toFixed(2)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Boosting (ads)
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-bold">
            {capital.boostSpend.toFixed(2)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Other (rent, food, etc.)
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-bold">
            {capital.miscExpense.toFixed(2)}
          </CardContent>
        </Card>
        {capital.totalCapitalWithdrawn > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Capital taken back
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold tabular-nums">
                {capital.totalCapitalWithdrawn.toFixed(2)}
              </div>
              <p className="text-xs text-muted-foreground">
                still in: {capital.netInvested.toFixed(2)}
              </p>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Remaining capital
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold tabular-nums ${capital.totalRemaining < 0 ? "text-destructive" : ""}`}
            >
              {capital.totalRemaining.toFixed(2)}
            </div>
            <p className="text-xs text-muted-foreground">of what partners put in</p>
          </CardContent>
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">
        Total spent, all categories: {capital.totalExpenses.toFixed(2)}
        {capital.treasuryFundedSpend > 0 && (
          <>
            {" "}
            — of which {capital.treasuryFundedSpend.toFixed(2)} came from the treasury.
            Treasury money is the business&apos;s own, mostly sales takings, so spending it
            uses up none of anyone&apos;s capital; only the remaining{" "}
            {capital.capitalSpend.toFixed(2)} counts against &quot;Remaining capital&quot;
          </>
        )}
        . The spend figures above count every recorded purchase whether or not anyone was
        tagged as having paid; the per-partner table below only counts purchases tagged
        with &quot;Paid by&quot;.
      </p>

      <PartnerManager
        slug={slug}
        partners={rows}
        memberOptions={memberOptions}
        canManage={canManage}
      />
    </div>
  );
}
