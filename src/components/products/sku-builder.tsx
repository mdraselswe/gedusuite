"use client";

import { useEffect, useRef, useState } from "react";
import {
  formatSku,
  isSkuTaken,
  nextSkuNumber,
  parseSku,
  subCodesFor,
  suggestPrefix,
  knownPrefixes,
} from "@/lib/sku";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type SkuSource = { sku: string | null; category: string | null };

const NEW_SUB = "__new__";

/**
 * Composes a PREFIX-SUB-NNN SKU instead of asking someone to remember the
 * scheme and hand-count the next number. The number is the part that actually
 * went wrong before — there is no unique index on sku, so a repeated one used
 * to pass silently.
 *
 * Everything is derived from the products already loaded on the page, so no
 * extra request and no hard-coded vocabulary. Typing a SKU that doesn't fit
 * the scheme stays possible through "custom" — the scheme is a convention,
 * not a constraint, and a supplier's own code sometimes wins.
 */
export function SkuBuilder({
  value,
  onChange,
  products,
  category,
  /** The SKU this product already has, so editing it isn't "taken" by itself. */
  ownSku,
  className,
}: {
  value: string;
  onChange: (sku: string) => void;
  products: SkuSource[];
  category: string;
  ownSku?: string | null;
  className?: string;
}) {
  const initial = parseSku(value);
  // A SKU that's set but unparseable can only be edited as free text.
  const [custom, setCustom] = useState(!!value && !initial);
  const [prefix, setPrefix] = useState(initial?.prefix ?? suggestPrefix(products, category) ?? "");
  const [sub, setSub] = useState(initial?.sub ?? "");
  const [newSub, setNewSub] = useState("");
  const [addingSub, setAddingSub] = useState(false);
  const [n] = useState(initial?.n ?? nextSkuNumber(products));

  // Once a prefix is chosen by hand, changing category stops overriding it.
  const prefixTouched = useRef(!!initial);
  useEffect(() => {
    if (custom || prefixTouched.current) return;
    setPrefix(suggestPrefix(products, category) ?? "");
  }, [category, products, custom]);

  const effectiveSub = addingSub ? newSub.trim().toUpperCase() : sub;
  const composed = prefix && effectiveSub ? formatSku(prefix, effectiveSub, n) : "";

  // Push the composed value up. Guarded on `custom` so switching to free text
  // doesn't get overwritten by the builder's own state.
  useEffect(() => {
    if (custom) return;
    onChange(composed);
    // onChange is a fresh closure each render; the composed string is what
    // actually matters, so it alone drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composed, custom]);

  const taken = isSkuTaken(products, value, ownSku);
  const prefixes = knownPrefixes(products);
  const subs = subCodesFor(products, prefix);

  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor="p-sku">SKU</Label>

      {custom ? (
        <Input
          id="p-sku"
          value={value}
          placeholder="Any code you like"
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            value={prefix}
            onValueChange={(v) => {
              if (!v) return;
              prefixTouched.current = true;
              setPrefix(v);
              // SUB codes are scoped to a prefix — EDU-TTH would be nonsense.
              setSub("");
              setAddingSub(false);
            }}
            items={prefixes.map((p) => ({ value: p.code, label: p.code }))}
          >
            <SelectTrigger id="p-sku" className="w-24">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              {prefixes.map((p) => (
                <SelectItem key={p.code} value={p.code}>
                  {p.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <span className="text-muted-foreground">-</span>

          {addingSub ? (
            <Input
              autoFocus
              value={newSub}
              maxLength={5}
              placeholder="CODE"
              className="w-24 uppercase"
              onChange={(e) => setNewSub(e.target.value.replace(/[^a-zA-Z]/g, ""))}
              onBlur={() => {
                if (!newSub.trim()) setAddingSub(false);
              }}
            />
          ) : (
            <Select
              value={sub}
              disabled={!prefix}
              onValueChange={(v) => {
                if (!v) return;
                if (v === NEW_SUB) {
                  setNewSub("");
                  setAddingSub(true);
                  return;
                }
                setSub(v);
              }}
              items={[
                ...subs.map((s) => ({ value: s.code, label: `${s.code} (${s.count})` })),
                { value: NEW_SUB, label: "+ New code…" },
              ]}
            >
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Kind" />
              </SelectTrigger>
              <SelectContent>
                {subs.map((s) => (
                  <SelectItem key={s.code} value={s.code}>
                    {s.code} <span className="text-muted-foreground">({s.count})</span>
                  </SelectItem>
                ))}
                <SelectItem value={NEW_SUB}>+ New code…</SelectItem>
              </SelectContent>
            </Select>
          )}

          <span className="text-muted-foreground">-</span>

          <Input
            readOnly
            tabIndex={-1}
            value={String(n).padStart(3, "0")}
            title="Next free number in the catalogue"
            className="w-16 bg-muted text-muted-foreground"
          />

          <span
            className={cn(
              "ml-1 font-mono text-sm",
              composed ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {composed || "—"}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 text-xs">
        <button
          type="button"
          className="text-muted-foreground underline"
          onClick={() => {
            setCustom((c) => !c);
            if (custom) onChange("");
          }}
        >
          {custom ? "Use the standard format" : "Type a custom SKU instead"}
        </button>
        {taken && (
          <span className="font-medium text-destructive">
            Already used by another product
          </span>
        )}
      </div>
    </div>
  );
}
