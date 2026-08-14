"use client";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Money } from "@/components/ui/money";
import {
  AD_FUNDING_SOURCES,
  FUNDING_SOURCES,
  fundingNeedsPartner,
  fundingSourceHint,
  fundingSourceLabel,
  fundingSpendsTreasury,
  type FundingSource,
} from "@/lib/funding";

export { fundingLabel } from "@/lib/funding";

/**
 * Who paid, on every form that asks.
 *
 * The three forms each had their own copy of this — the same select, the same
 * conditional partner picker, the same treasury-balance line — and they had
 * already drifted: one said "Not tracked", another "None", and the boost form
 * offered three options where the others offered four. Adding a fifth to three
 * hand-maintained copies is how a form ends up quietly unable to save a state
 * the server accepts.
 */

/** No partner chosen. A sentinel because Select can't hold an empty value. */
export const NO_PARTNER = "__none__";

export type PartnerOption = { id: string; label: string };

export function FundingPicker({
  value,
  onChange,
  partnerId,
  onPartnerChange,
  partnerOptions,
  treasuryBalance,
  /** Advertising is never bought on account, so the boost form drops CREDIT. */
  allowCredit = true,
  idPrefix = "funding",
}: {
  value: FundingSource;
  onChange: (next: FundingSource) => void;
  partnerId: string;
  onPartnerChange: (next: string) => void;
  partnerOptions: PartnerOption[];
  treasuryBalance?: number;
  allowCredit?: boolean;
  idPrefix?: string;
}) {
  const options = allowCredit ? FUNDING_SOURCES : AD_FUNDING_SOURCES;
  const needsPartner = fundingNeedsPartner(value);

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-source`}>Funding source</Label>
        {/* `items` is what lets the closed trigger show the label rather than
            the raw enum — Base UI's Select.Value has nothing else to map a
            value to its text with, so without it the field read "TREASURY". */}
        <Select
          value={value}
          onValueChange={(v) => onChange((v as FundingSource) ?? "NONE")}
          items={options.map((source) => ({ value: source, label: fundingSourceLabel[source] }))}
        >
          <SelectTrigger id={`${idPrefix}-source`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          {/* The popup normally takes the trigger's width, and these labels are
              sentences — in the boost form's narrow column that cropped the
              longest one to "A partner paid, the treasu". Sized to its content
              instead, never narrower than the trigger and never wider than the
              space the positioner says it has. */}
          <SelectContent className="w-max min-w-(--anchor-width) max-w-(--available-width)">
            {options.map((source) => (
              <SelectItem key={source} value={source}>
                {fundingSourceLabel[source]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{fundingSourceHint[value]}</p>
        {/* Shown for a reimbursement too — it spends the balance exactly as a
            plain treasury row does, and the save is refused the same way if it
            can't cover the amount. */}
        {fundingSpendsTreasury(value) && treasuryBalance !== undefined && (
          <p className="text-xs text-muted-foreground">
            Treasury balance: <Money value={treasuryBalance} />
          </p>
        )}
      </div>
      {needsPartner && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-partner`}>
            {value === "REIMBURSED" ? "Who paid and was reimbursed" : "Partner"}
          </Label>
          {/* null rather than the sentinel while nothing is chosen: Base UI
              only shows the placeholder for an empty value, and given a value
              it has no item for it printed the sentinel itself — the field
              read "__none__". */}
          <Select
            value={partnerId === NO_PARTNER ? null : partnerId}
            onValueChange={(v) => onPartnerChange((v as string | null) ?? NO_PARTNER)}
            items={partnerOptions.map((p) => ({ value: p.id, label: p.label }))}
          >
            <SelectTrigger id={`${idPrefix}-partner`} className="w-full">
              <SelectValue placeholder="Select partner" />
            </SelectTrigger>
            <SelectContent>
              {partnerOptions.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </>
  );
}

/**
 * The partner id to send with the form: only for the states that store one, so
 * a stale id left over from switching the radio can't ride along on a treasury
 * row. `resolveFunding` drops it server-side as well — this just keeps the
 * request honest.
 */
export function fundingPartnerField(value: FundingSource, partnerId: string): string {
  return fundingNeedsPartner(value) && partnerId !== NO_PARTNER ? partnerId : "";
}
