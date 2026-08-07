"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import {
  adoptAllMatchedCredits,
  adoptPartnerCredit,
  deletePartnerTxn,
  generateAllPartnerCredits,
  generatePartnerCredit,
  type SourceKind,
} from "@/server/actions/partners";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney as money } from "@/lib/money";

type Source = { kind: SourceKind; id: string; date: string; label: string; amount: number };
type Manual = { id: string; date: string; purpose: string | null; amount: number };

export type ReconcileGroup = {
  partnerId: string;
  partnerName: string;
  /** Partner-funded purchases with no credit linked to them yet. */
  sources: Source[];
  /** Hand-typed INVESTMENT entries not yet tied to any purchase. */
  manual: Manual[];
};
const key = (s: Source) => `${s.kind}:${s.id}`;
const sum = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100;

/**
 * Mirrors adoptAllMatchedCredits' pairing — oldest purchase first, nearest
 * date wins a tie, each entry claimable once — so the button's count is what
 * pressing it will actually do. The server pairs again from scratch; this is
 * only for the label and the confirmation.
 */
function matchable(g: ReconcileGroup): { count: number; total: number } {
  const pool = g.manual.map((m) => ({ amount: m.amount, time: Date.parse(m.date) }));
  const claimed: number[] = [];
  for (const s of [...g.sources].sort((a, b) => a.date.localeCompare(b.date))) {
    const at = Date.parse(s.date);
    let best = -1;
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].amount !== s.amount) continue;
      if (best === -1 || Math.abs(pool[i].time - at) < Math.abs(pool[best].time - at)) best = i;
    }
    if (best === -1) continue;
    claimed.push(pool[best].amount);
    pool.splice(best, 1);
  }
  return { count: claimed.length, total: sum(claimed) };
}

export function ReconcileManager({
  slug,
  groups,
}: {
  slug: string;
  groups: ReconcileGroup[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  // Which hand-typed entry to adopt, per source row. Unset means "the first
  // amount-matched candidate", which is the right answer nearly every time.
  const [picked, setPicked] = useState<Record<string, string>>({});

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="Nothing left to reconcile"
        description="Every partner-funded purchase has its investment credit linked. New ones are linked automatically from now on."
      />
    );
  }

  async function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    setBusy(id);
    const res = await fn();
    setBusy(null);
    if (!res.ok) return toast.error(res.error ?? "Something went wrong");
    toast.success(done);
    router.refresh();
  }

  async function onDeleteManual(m: Manual) {
    const ok = await confirmDialog({
      title: "Delete this ledger entry?",
      description: `The ${money(m.amount)} investment dated ${m.date} will be removed from the partner's ledger. Do this when it duplicates a purchase you're about to generate a credit for.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    run(`m:${m.id}`, () => deletePartnerTxn(slug, m.id), "Entry deleted");
  }

  async function onAdoptAll(g: ReconcileGroup, m: { count: number; total: number }) {
    const ok = await confirmDialog({
      title: `Adopt ${m.count} matching ${m.count === 1 ? "entry" : "entries"}?`,
      description: `${money(m.total)} of hand-typed investment matches a purchase amount exactly and will be tied to that purchase. Nothing is created or deleted, so no total moves — each entry is just rewritten to its purchase's wording and date.`,
      confirmText: "Adopt all",
    });
    if (!ok) return;
    setBusy(`adopt:${g.partnerId}`);
    const res = await adoptAllMatchedCredits(slug, g.partnerId);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success(`${res.adopted} existing ${res.adopted === 1 ? "entry" : "entries"} linked`);
    router.refresh();
  }

  async function onGenerateAll(g: ReconcileGroup) {
    const leftover = sum(g.manual.map((m) => m.amount));
    const ok = await confirmDialog({
      title: `Create ${g.sources.length} credits for ${g.partnerName}?`,
      description:
        leftover > 0
          ? `${g.partnerName} still has ${money(leftover)} of hand-typed investment entries that aren't linked to any purchase. If any of those were entered FOR these purchases, generating credits now will count that money twice — adopt or delete them first.`
          : `Each unlinked purchase gets an investment credit matching its own amount. Total ${money(sum(g.sources.map((s) => s.amount)))}.`,
      confirmText: "Create credits",
      destructive: leftover > 0,
    });
    if (!ok) return;
    setBusy(`all:${g.partnerId}`);
    const res = await generateAllPartnerCredits(slug, g.partnerId);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success(`${res.created} credits created`);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">
        A partner paying out of their own pocket puts money into the business and spends it in
        the same moment, so every partner-funded purchase needs a matching investment credit.
        New purchases create that credit automatically. The ones below were made before that, so
        each needs a decision: <strong>Adopt</strong> if the credit was already typed into the
        ledger by hand, <strong>Create credit</strong> if it never was. Adopting rewrites the
        entry to match the purchase, and from then on it follows the purchase automatically.
      </p>

      {groups.map((g) => {
        const spend = sum(g.sources.map((s) => s.amount));
        const leftover = sum(g.manual.map((m) => m.amount));
        const matched = matchable(g);
        return (
          <Card key={g.partnerId}>
            <CardHeader>
              <CardTitle className="text-base">{g.partnerName}</CardTitle>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
                <span>
                  Unlinked spend{" "}
                  <span className="font-semibold text-foreground tabular-nums">
                    {money(spend)}
                  </span>{" "}
                  over {g.sources.length}{" "}
                  {g.sources.length === 1 ? "purchase" : "purchases"}
                </span>
                <span>
                  Unlinked hand-typed investment{" "}
                  <span className="font-semibold text-foreground tabular-nums">
                    {money(leftover)}
                  </span>
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Purchase</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Resolve</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {g.sources.map((s) => {
                      // Only an exact amount match can be adopted — a lump sum
                      // covering several purchases belongs to none of them.
                      const candidates = g.manual.filter((m) => m.amount === s.amount);
                      const chosen = picked[key(s)] ?? candidates[0]?.id;
                      const rowBusy = busy === key(s);
                      return (
                        <TableRow key={key(s)}>
                          <TableCell className="whitespace-nowrap tabular-nums">
                            {s.date}
                          </TableCell>
                          <TableCell>
                            <span className="block">{s.label}</span>
                            <span className="text-xs text-muted-foreground">
                              {s.kind === "PURCHASE" ? "Product purchase" : "Internal purchase"}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {money(s.amount)}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              {candidates.length > 0 && (
                                <>
                                  {candidates.length > 1 && (
                                    <Select
                                      value={chosen}
                                      onValueChange={(v) =>
                                        v && setPicked((p) => ({ ...p, [key(s)]: v }))
                                      }
                                    >
                                      <SelectTrigger className="h-8 w-52">
                                        <span data-slot="select-value">
                                          {candidates.find((c) => c.id === chosen)?.date}
                                          {" — "}
                                          {candidates.find((c) => c.id === chosen)?.purpose ??
                                            "no purpose"}
                                        </span>
                                      </SelectTrigger>
                                      <SelectContent>
                                        {candidates.map((c) => (
                                          <SelectItem key={c.id} value={c.id}>
                                            {c.date} — {c.purpose ?? "no purpose"}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  )}
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={rowBusy || !chosen}
                                    onClick={() =>
                                      run(
                                        key(s),
                                        () => adoptPartnerCredit(slug, s.kind, s.id, chosen!),
                                        "Existing entry linked",
                                      )
                                    }
                                    title={
                                      candidates.length === 1
                                        ? `Link the ${money(s.amount)} entry dated ${candidates[0].date}`
                                        : undefined
                                    }
                                  >
                                    Adopt
                                  </Button>
                                </>
                              )}
                              <Button
                                size="sm"
                                disabled={rowBusy}
                                onClick={() =>
                                  run(
                                    key(s),
                                    () => generatePartnerCredit(slug, s.kind, s.id),
                                    "Credit created",
                                  )
                                }
                              >
                                Create credit
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {g.manual.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">
                    Hand-typed investment entries not linked to a purchase
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Real capital the partner put in stays here untouched. Delete only the ones
                    that were standing in for a purchase above — otherwise generating its credit
                    counts the same money twice.
                  </p>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableBody>
                        {g.manual.map((m) => (
                          <TableRow key={m.id}>
                            <TableCell className="whitespace-nowrap tabular-nums">
                              {m.date}
                            </TableCell>
                            <TableCell>{m.purpose ?? "—"}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {money(m.amount)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy === `m:${m.id}`}
                                onClick={() => onDeleteManual(m)}
                              >
                                Delete
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              {/* Adopt first, create second — that's the safe order. Adopting
                  moves no totals, so clearing the exact matches shrinks what
                  the riskier bulk create has to guess about. */}
              <div className="flex flex-wrap gap-2">
                {matched.count > 0 && (
                  <Button
                    variant="outline"
                    disabled={busy === `adopt:${g.partnerId}`}
                    onClick={() => onAdoptAll(g, matched)}
                  >
                    Adopt all {matched.count} matched
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={busy === `all:${g.partnerId}`}
                  onClick={() => onGenerateAll(g)}
                >
                  Create credits for all {g.sources.length}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
