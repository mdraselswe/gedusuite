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
import { StatGrid, StatTile } from "@/components/ui/stat-tile";
import { FigureList, FigureRow } from "@/components/ui/figure-list";
import { InfoNote } from "@/components/ui/info-note";
import { Money } from "@/components/ui/money";
import { toneForBalance } from "@/lib/money";
import { Handshake, PiggyBank, Receipt, Wallet } from "lucide-react";

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
      treasuryCapitalSpend: b?.treasuryCapitalSpend ?? 0,
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
            Left to distribute:{" "}
            <Money
              value={profit.distributableProfit}
              tone={toneForBalance(profit.distributableProfit)}
              className="font-semibold"
            />
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
        <CardContent className="space-y-3">
          <FigureList>
            <FigureRow
              label="Order profit (returns and cancellations applied)"
              value={profit.tradingProfit}
            />
            {profit.adSpend !== 0 && (
              <FigureRow label="Ad spend" value={-profit.adSpend} tone="muted" />
            )}
            {profit.internalPurchaseSpend !== 0 && (
              <FigureRow
                label="Internal purchases"
                value={-profit.internalPurchaseSpend}
                tone="muted"
              />
            )}
            {profit.miscExpense !== 0 && (
              <FigureRow
                label="Other partner expenses"
                value={-profit.miscExpense}
                tone="muted"
              />
            )}
            {profit.stockLoss !== 0 && (
              <FigureRow label="Damaged / lost stock" value={-profit.stockLoss} tone="muted" />
            )}
            {profit.distributed > 0 && (
              <FigureRow
                label="Already distributed to partners"
                value={-profit.distributed}
                tone="muted"
              />
            )}
            <FigureRow
              label="Left to distribute"
              value={profit.distributableProfit}
              tone={toneForBalance(profit.distributableProfit)}
              total
            />
            {profit.prepaidExpenses > 0 && (
              <FigureRow
                label="Paid for but not yet expensed"
                hint="spread costs with months left to run — already out of the account"
                value={profit.prepaidExpenses}
                tone="muted"
                sub
              />
            )}
          </FigureList>

          <InfoNote title="When a cost lands on this list">
            <p>
              Expenses come off in the period they were paid for, unless a purchase says
              how many months it covers. Stock bought to resell is separate again: that
              reaches profit as cost of goods sold when it sells, not when it&apos;s
              bought.
            </p>
          </InfoNote>
          {!sharesNormalized && (
            <InfoNote tone="warn" title="The profit shares don't add up to 100%">
              <p>
                Each partner is paid their percent of the total in use rather than of 100
                — the &quot;Effective %&quot; column below. A distribution splits the
                money exactly the same way, so what they read and what they&apos;re paid
                still agree.
              </p>
            </InfoNote>
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

      {/* The two figures somebody actually came for, then the breakdown that
          explains them. This used to be eight identical tiles in a six-column
          grid — every category at the same weight as the answer, and the
          answer last. */}
      <StatGrid className="lg:grid-cols-3">
        <StatTile
          label="Capital in the business"
          value={capital.netInvested}
          icon={<Wallet />}
          color="indigo"
          sub={
            capital.totalCapitalWithdrawn > 0 ? (
              <>
                <Money value={capital.totalInvested} /> put in,{" "}
                <Money value={capital.totalCapitalWithdrawn} /> taken back
              </>
            ) : (
              "what the partners have put in"
            )
          }
        />
        <StatTile
          label="Still the partners'"
          value={capital.capitalPlusStock}
          tone={toneForBalance(capital.capitalPlusStock)}
          icon={<PiggyBank />}
          color="emerald"
          sub={
            capital.inventoryValue > 0 ? (
              <>
                <Money value={capital.totalRemaining} /> unspent ·{" "}
                <Money value={capital.inventoryValue} /> as stock (
                {capital.inventoryUnits} pcs)
              </>
            ) : (
              "nothing left over as stock"
            )
          }
        />
        {capital.supplierDue > 0 ? (
          <StatTile
            label="Owed to suppliers"
            value={capital.supplierDue}
            tone="negative"
            icon={<Receipt />}
            color="amber"
            sub="bought on credit, not paid for yet"
          />
        ) : (
          <StatTile
            label="Spent so far"
            value={capital.totalExpenses}
            icon={<Receipt />}
            color="orange"
            sub="every recorded purchase, however it was funded"
          />
        )}
      </StatGrid>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Where the money went</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Sub-rows sit under the number they break down, instead of the
                prose paragraph that used to carry the same three facts. */}
            <FigureList>
              <FigureRow label="Customer products" value={capital.customerProductSpend} />
              <FigureRow label="Internal purchases" value={capital.internalPurchaseSpend} />
              <FigureRow label="Boosting (ads)" value={capital.boostSpend} />
              <FigureRow label="Other (rent, food…)" value={capital.miscExpense} />
              <FigureRow label="Total spent" value={capital.totalExpenses} total />
              {capital.treasuryFundedSpend > 0 && (
                <FigureRow
                  label="paid from the treasury"
                  value={capital.treasuryFundedSpend}
                  tone="muted"
                  sub
                />
              )}
              {capital.partnerCashInTreasury > 0 && capital.treasuryFundedSpend > 0 && (
                <FigureRow
                  label="…of that, the shop's own takings"
                  hint="the rest of it spent partner money the treasury was holding"
                  value={capital.salesFundedSpend}
                  tone="muted"
                  sub
                />
              )}
              {capital.supplierDue > 0 && (
                <FigureRow
                  label="still owed to suppliers"
                  value={capital.supplierDue}
                  tone="muted"
                  sub
                />
              )}
              <FigureRow
                label="came out of partner capital"
                value={capital.capitalSpend}
                tone="muted"
                sub
              />
            </FigureList>
          </CardContent>
        </Card>

        <div className="space-y-3">
          {capital.salesFundedSpend > 0 && (
            <InfoNote title="Not all of that spending used partner capital">
              <p>
                Sales takings are the business&apos;s own money, so spending them uses up
                nobody&apos;s capital. Of the <Money value={capital.totalExpenses} />{" "}
                spent, <Money value={capital.salesFundedSpend} /> came out of takings, and
                only the remaining <Money value={capital.capitalSpend} /> counts against
                &quot;Still the partners&apos;&quot;.
              </p>
            </InfoNote>
          )}
          {capital.partnerCashInTreasury > 0 && (
            <InfoNote title="Part of the treasury is partner money">
              <p>
                <Money value={capital.partnerCashInTreasury} /> of what the treasury holds
                was deposited by partners rather than earned by the shop. Spending that
                spends their capital wherever the cash happened to be sitting, so treasury
                purchases are charged against capital until that much of it has gone —
                otherwise handing money over and spending it yourself would give two
                different answers for the same purchase.
              </p>
              <p>
                In the table below it&apos;s charged to each partner in proportion to what
                they still have in the pot, not by profit share. Profit is what the shares
                divide; capital is whatever each partner put in, and a partner who has
                deposited nothing pays none of it.
              </p>
            </InfoNote>
          )}
          {capital.inventoryValue > 0 && (
            <InfoNote title="Stock bought is capital moved, not capital lost">
              <p>
                Buying <Money value={capital.inventoryValue} /> of stock drops the unspent
                figure by the same amount, but the goods are on the shelf and still
                belong to the partners. That is why the headline adds the two together.
              </p>
              {capital.inventoryFromCorrections > 0 && (
                <p>
                  <Money value={capital.inventoryFromCorrections} /> of that stock was
                  added by a manual correction rather than a purchase — real if the count
                  was genuinely wrong, and worth checking if it wasn&apos;t, because no
                  money is recorded as having bought it.
                </p>
              )}
            </InfoNote>
          )}
          <InfoNote title="Why this doesn't match the per-partner table below">
            <p>
              These totals count every recorded purchase, tagged or not. The table below
              counts only the ones with a &quot;Paid by&quot; partner on them, so an
              untagged purchase appears here and against nobody there.
            </p>
          </InfoNote>
        </div>
      </div>

      <PartnerManager
        slug={slug}
        partners={rows}
        memberOptions={memberOptions}
        canManage={canManage}
      />
    </div>
  );
}
