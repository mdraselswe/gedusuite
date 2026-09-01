"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@/lib/live-router";
import { toast } from "sonner";
import {
  Boxes,
  CloudUpload,
  Pencil,
  Plus,
  PowerOff,
  Power,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { MoneyInput } from "@/components/ui/money-input";
import { Money } from "@/components/ui/money";
import { InfoNote } from "@/components/ui/info-note";
import { DataTable, type Column } from "@/components/ui/data-table";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Field, FormError, type FieldError } from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AsyncCombobox, type ComboOption } from "@/components/ui/async-combobox";
import { searchVariants, type VariantOption } from "@/server/actions/search";
import {
  linkSiblingVariantsToWebsite,
  linkVariantToWebsite,
  pushComboToWebsite,
  searchWebsiteProducts,
  suggestWebsiteLinks,
} from "@/server/actions/woo-push";
import {
  checkComboDrift,
  comboComponentFacts,
  createCombo,
  deleteCombo,
  setComboActive,
  updateCombo,
  type ComboDrift,
  type ComponentFacts,
} from "@/server/actions/combos";
import { allocateComboPrice, comboBuildable, componentsTotal } from "@/lib/combos";
import { round2 } from "@/lib/money";

/** A combo as the products page hands it over — already costed and counted. */
export type ComboRow = {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  freeDelivery: boolean;
  active: boolean;
  wooProductId: number | null;
  validFrom: string | null;
  validTo: string | null;
  /** Complete sets the shelf can make right now. */
  buildable: number;
  /** What the same goods list for bought separately. */
  listTotal: number;
  /** What the same goods cost the shop. */
  costTotal: number;
  components: {
    productVariantId: string;
    label: string;
    quantity: number;
    salePrice: number | null;
    unitCost: number;
    stock: number;
    /** Null until somebody links it — a recipe can't be pushed without it. */
    wooProductId: number | null;
  }[];
};

type ComponentDraft = {
  variant: VariantOption | null;
  quantity: string;
};

function emptyComponent(): ComponentDraft {
  return { variant: null, quantity: "1" };
}

type WebsitePick = ComboOption & { managesStock: boolean };

/**
 * Says which website product this component stands for, and lets somebody
 * choose when it doesn't yet.
 *
 * The link belongs to the variant rather than to this combo, so it is saved
 * the moment it is picked instead of waiting for the combo to be saved — link
 * a product once and every later combo that uses it is already ready to push.
 */
function WebsiteLinkField({
  slug,
  variant,
  onLinked,
}: {
  slug: string;
  variant: VariantOption;
  onLinked: (wooProductId: number) => void;
}) {
  const [linking, setLinking] = useState(false);
  const [picked, setPicked] = useState<WebsitePick | null>(null);
  /**
   * The other variants of this product that could go to the same listing.
   *
   * Kept here rather than read from the variant, because the moment a link is
   * made this field re-renders as "linked" and the chance to offer it would be
   * gone — which is exactly the moment the answer is obvious to whoever just
   * chose it.
   */
  const [siblings, setSiblings] = useState<{ wooProductId: number; count: number } | null>(null);

  async function onLinkSiblings() {
    if (!siblings) return;
    setLinking(true);
    const res = await linkSiblingVariantsToWebsite(slug, variant.value, siblings.wooProductId);
    setLinking(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setSiblings(null);
    toast.success(`Linked ${res.linked} more ${res.linked > 1 ? "variants" : "variant"}`);
  }

  if (variant.wooProductId != null) {
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          Website #{variant.wooProductId}
        </p>
        {siblings && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={linking}
            onClick={onLinkSiblings}
            className="h-7 text-xs"
          >
            Also link {siblings.count} more{" "}
            {siblings.count > 1 ? "variants" : "variant"} of this product
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-amber-600 dark:text-amber-400">
        Not linked to the website yet — pick what it is called there.
      </p>
      <AsyncCombobox
        value={picked}
        disabled={linking}
        onChange={async (opt) => {
          setPicked(opt);
          if (!opt) return;
          setLinking(true);
          const res = await linkVariantToWebsite(slug, variant.value, Number(opt.value));
          setLinking(false);
          if (!res.ok) {
            toast.error(res.error);
            setPicked(null);
            return;
          }
          toast.success("Linked to the website");
          if (res.unlinkedSiblings > 0) {
            setSiblings({ wooProductId: Number(opt.value), count: res.unlinkedSiblings });
          }
          onLinked(Number(opt.value));
        }}
        fetchPage={async (q) => {
          const res = await searchWebsiteProducts(slug, q);
          return res.ok
            ? {
                items: res.options.map((o) => ({
                  value: String(o.id),
                  label: o.label,
                  managesStock: o.managesStock,
                })),
                next: null,
              }
            : { items: [], next: null };
        }}
        placeholder="Search the website…"
        emptyText="No matching website product"
        renderItem={(o) => (
          <>
            <span className="truncate">{o.label}</span>
            {!o.managesStock && (
              <span className="shrink-0 text-xs text-amber-600 dark:text-amber-400">
                stock not counted
              </span>
            )}
          </>
        )}
      />
    </div>
  );
}

/** A date the <input type="date"> can hold — the stored value is a plain day. */
function dateInputValue(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

export function ComboManager({
  slug,
  combos,
  hasProducts,
  perms,
}: {
  slug: string;
  combos: ComboRow[];
  hasProducts: boolean;
  perms: { canAdd: boolean; canEdit: boolean; canDelete: boolean };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ComboRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<FieldError>(null);

  /**
   * What the website says about each combo, once somebody has asked.
   *
   * Checked on demand rather than on every page load: it is an HTTP call per
   * combo to a shop that is sometimes slow, and the products page has to open
   * whether or not the storefront is reachable.
   */
  const [drift, setDrift] = useState<Record<string, ComboDrift | "checking">>({});
  /** The combo whose push is in flight — one at a time, it writes to a live shop. */
  const [pushing, setPushing] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [freeDelivery, setFreeDelivery] = useState(false);
  const [active, setActive] = useState(true);
  const [wooProductId, setWooProductId] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [components, setComponents] = useState<ComponentDraft[]>([
    emptyComponent(),
    emptyComponent(),
  ]);

  function openCreate() {
    setEditing(null);
    setName("");
    setSku("");
    setPrice("");
    setFreeDelivery(false);
    setActive(true);
    setWooProductId("");
    setValidFrom("");
    setValidTo("");
    setComponents([emptyComponent(), emptyComponent()]);
    setFormError(null);
    setOpen(true);
  }

  function openEdit(c: ComboRow) {
    setEditing(c);
    setName(c.name);
    setSku(c.sku ?? "");
    setPrice(String(c.price));
    setFreeDelivery(c.freeDelivery);
    setActive(c.active);
    setWooProductId(c.wooProductId != null ? String(c.wooProductId) : "");
    setValidFrom(dateInputValue(c.validFrom));
    setValidTo(dateInputValue(c.validTo));
    setComponents(
      c.components.map((k) => ({
        // Seeded from the row itself: the variant may be well past the first
        // page of any search, and the combobox only knows what it has fetched.
        variant: {
          value: k.productVariantId,
          label: k.label,
          stock: k.stock,
          expiryTracked: false,
          unitCost: k.unitCost,
          salePrice: k.salePrice,
          unitsPerPack: null,
          weightGrams: null,
          wooProductId: k.wooProductId,
        },
        quantity: String(k.quantity),
      })),
    );
    setFormError(null);
    setOpen(true);
  }

  function updateComponent(i: number, patch: Partial<ComponentDraft>) {
    setComponents((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }

  /**
   * The whole point of the form: what this set is worth, what it costs, and how
   * many of it exist — worked out from the SAME functions the server saves
   * with, so what is previewed here is what lands on the order.
   */
  /**
   * Price, cost and stock for the picked components, straight from the server.
   *
   * The search dropdown carries numbers of its own, but they follow the order
   * form's rules rather than this one's, and the products page follows a third
   * set — which is how the same combo could quote one "bought separately" while
   * being built and another when reopened. One question, one answer, one place.
   */
  const [facts, setFacts] = useState<Record<string, ComponentFacts>>({});
  const pickedIds = components
    .map((c) => c.variant?.value)
    .filter((v): v is string => Boolean(v));
  const pickedKey = [...new Set(pickedIds)].sort().join(",");
  const factsReq = useRef(0);

  useEffect(() => {
    if (!open || !pickedKey) return;
    const req = ++factsReq.current;
    void comboComponentFacts(slug, pickedKey.split(",")).then((res) => {
      // A slower earlier answer must not overwrite a newer one.
      if (!res.ok || req !== factsReq.current) return;
      setFacts((prev) => ({ ...prev, ...res.facts }));
    });
  }, [slug, pickedKey, open]);

  const preview = useMemo(() => {
    // The same variant on two rows is one shelf being asked for twice. Summed
    // here so "can make now" counts what a set really takes; the save itself
    // refuses the duplicate and asks for a quantity instead.
    const byVariant = new Map<string, number>();
    for (const c of components) {
      const id = c.variant?.value;
      const qty = parseInt(c.quantity) || 0;
      if (!id || qty <= 0) continue;
      byVariant.set(id, (byVariant.get(id) ?? 0) + qty);
    }
    const duplicated = pickedIds.length !== new Set(pickedIds).size;

    // Rows that are one product once they reach the website. Ordinary, not an
    // error — this app keeps a toy's colours apart and the website sells one
    // listing for them — but worth saying out loud, because the set will be
    // described there as needing the total rather than the separate rows, and
    // its availability there will be counted from one shelf.
    const byWebsite = new Map<number, { labels: string[]; qty: number }>();
    for (const c of components) {
      const v = c.variant;
      const qty = parseInt(c.quantity) || 0;
      if (!v || v.wooProductId == null || qty <= 0) continue;
      const g = byWebsite.get(v.wooProductId) ?? { labels: [], qty: 0 };
      if (!g.labels.includes(v.label)) g.labels.push(v.label);
      g.qty += qty;
      byWebsite.set(v.wooProductId, g);
    }
    const websiteMerges = [...byWebsite]
      .filter(([, g]) => g.labels.length > 1)
      .map(([id, g]) => ({ id, ...g }));

    const picked = [...byVariant].map(([productVariantId, quantity]) => {
      const f = facts[productVariantId];
      return {
        productVariantId,
        quantity,
        salePrice: f?.salePrice ?? null,
        unitCost: f?.unitCost ?? 0,
        stock: f?.stock ?? 0,
      };
    });
    // Waiting on the server, or a piece nobody has ever priced: either way the
    // totals below are not yet the truth, and saying so beats showing ৳0.
    const unpriced = picked.filter((c) => c.salePrice == null).length;
    const loading = picked.some((c) => !facts[c.productVariantId]);

    const comboPrice = parseFloat(price) || 0;
    const listTotal = componentsTotal(picked);
    const costTotal = round2(picked.reduce((s, c) => s + c.unitCost * c.quantity, 0));
    const stockMap = new Map(picked.map((c) => [c.productVariantId, c.stock]));
    const margin = round2(comboPrice - costTotal);
    return {
      picked,
      loading,
      unpriced,
      duplicated,
      websiteMerges,
      listTotal,
      costTotal,
      saving: round2(Math.max(0, listTotal - comboPrice)),
      margin,
      marginPct: comboPrice > 0 ? Math.round((margin / comboPrice) * 100) : 0,
      buildable: comboBuildable(picked, stockMap),
      allocation: comboPrice > 0 ? allocateComboPrice(picked, comboPrice, 1) : [],
    };
    // pickedIds is derived from components; listing it too would only re-run
    // this on every keystroke that cannot change it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [components, price, facts]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const picked = components
      .filter((c) => c.variant && (parseInt(c.quantity) || 0) > 0)
      .map((c) => ({
        productVariantId: c.variant!.value,
        quantity: parseInt(c.quantity) || 0,
      }));
    if (picked.length < 2) {
      return toast.error("A combo needs at least two products");
    }

    setSaving(true);
    const fd = new FormData();
    fd.set("name", name);
    fd.set("sku", sku);
    fd.set("price", price);
    if (freeDelivery) fd.set("freeDelivery", "1");
    if (active) fd.set("active", "1");
    fd.set("wooProductId", wooProductId);
    fd.set("validFrom", validFrom);
    fd.set("validTo", validTo);
    fd.set("items", JSON.stringify(picked));

    const res = editing
      ? await updateCombo(slug, editing.id, fd)
      : await createCombo(slug, fd);
    setSaving(false);
    if (!res.ok) {
      setFormError(res);
      if (!res.field) toast.error(res.error);
      return;
    }
    setFormError(null);
    toast.success(editing ? "Combo updated" : "Combo created");
    setOpen(false);
    router.refresh();
  }

  async function onToggle(c: ComboRow) {
    const res = await setComboActive(slug, c.id, !c.active);
    if (!res.ok) return toast.error(res.error);
    toast.success(c.active ? "Combo switched off" : "Combo switched on", {
      // Only where it could mislead: a combo that is on the website is still
      // selling there, and this is the moment somebody would assume otherwise.
      description:
        c.active && c.wooProductId
          ? "Orders here only — it is still on sale on the website until you unpublish it there."
          : undefined,
    });
    router.refresh();
  }

  /**
   * Guess the website link for every component that hasn't got one.
   *
   * Matching a hundred products by hand is the tedious half of putting a combo
   * online, and the guesses are cheap to check: they are shown as a list and
   * nothing is written until somebody agrees to it. Anything ambiguous — two
   * website products with the same name — is left out rather than guessed.
   */
  async function onSuggestLinks() {
    const unlinked = components
      .map((c) => c.variant)
      .filter((v): v is VariantOption => Boolean(v) && v!.wooProductId == null);
    if (unlinked.length === 0) return;

    setSuggesting(true);
    const res = await suggestWebsiteLinks(
      slug,
      unlinked.map((v) => v.value),
    );
    setSuggesting(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }

    const found = unlinked.filter((v) => res.matches[v.value]);
    if (found.length === 0) {
      toast.error("No confident matches — pick them by hand.");
      return;
    }

    const ok = await confirmDialog({
      title: `Link ${found.length} product${found.length > 1 ? "s" : ""} to the website?`,
      description: found
        .map((v) => `${v.label} → ${res.matches[v.value].label}`)
        .join(", "),
      confirmText: "Link them",
    });
    if (!ok) return;

    for (const v of found) {
      const match = res.matches[v.value];
      const linked = await linkVariantToWebsite(slug, v.value, match.id);
      if (!linked.ok) {
        toast.error(`${v.label}: ${linked.error}`);
        continue;
      }
      setComponents((prev) =>
        prev.map((c) =>
          c.variant?.value === v.value
            ? { ...c, variant: { ...c.variant, wooProductId: match.id } }
            : c,
        ),
      );
    }
    toast.success("Linked");
    const missed = unlinked.length - found.length;
    if (missed > 0) {
      toast.error(`${missed} could not be matched — pick ${missed > 1 ? "them" : "it"} by hand.`);
    }
  }

  async function onPushWebsite(c: ComboRow) {
    setPushing(c.id);
    const res = await pushComboToWebsite(slug, c.id);
    setPushing(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(
      res.created
        ? `Created on the website as draft #${res.wooProductId} — review and publish it there.`
        : `Website product #${res.wooProductId} updated.`,
    );
    router.refresh();
  }

  async function onCheckWebsite(c: ComboRow) {
    setDrift((prev) => ({ ...prev, [c.id]: "checking" }));
    const res = await checkComboDrift(slug, c.id);
    setDrift((prev) => ({ ...prev, [c.id]: res }));
    if (!res.checked) {
      toast.error("Couldn't reach the website — try again in a moment");
    } else if (res.matches) {
      toast.success("The website combo matches this one");
    }
  }

  async function onDelete(c: ComboRow) {
    const ok = await confirmDialog({
      title: `Delete ${c.name}?`,
      description:
        "Orders that sold this combo keep their items and their figures — only the recipe and the report's name for it are lost. Switch it off instead to stop selling it.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteCombo(slug, c.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Combo deleted");
    router.refresh();
  }

  const columns: Column<ComboRow>[] = [
    {
      key: "name",
      header: "Combo",
      cardTitle: true,
      wrap: true,
      sortValue: (c) => c.name,
      cell: (c) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{c.name}</span>
            {!c.active && <Badge variant="outline">Off</Badge>}
            {c.freeDelivery && <Badge variant="secondary">Free delivery</Badge>}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {c.components.map((k) => `${k.label} ×${k.quantity}`).join(" + ")}
          </p>
        </div>
      ),
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      sortValue: (c) => c.price,
      cell: (c) => (
        <div>
          <Money value={c.price} />
          {c.listTotal > c.price && (
            <p className="text-xs text-muted-foreground">
              saves <Money value={round2(c.listTotal - c.price)} bare />
            </p>
          )}
        </div>
      ),
    },
    {
      key: "margin",
      header: "Margin",
      align: "right",
      hideable: true,
      sortValue: (c) => c.price - c.costTotal,
      cell: (c) => {
        const margin = round2(c.price - c.costTotal);
        return (
          <div>
            <Money value={margin} tone={margin < 0 ? "negative" : "positive"} />
            <p className="text-xs text-muted-foreground">
              cost <Money value={c.costTotal} bare />
            </p>
          </div>
        );
      },
    },
    {
      key: "buildable",
      header: "Can make",
      align: "right",
      sortValue: (c) => c.buildable,
      cell: (c) => (
        <span
          className={
            c.buildable === 0 ? "font-medium text-destructive" : "font-medium tabular-nums"
          }
        >
          {c.buildable === 0 ? "None left" : `${c.buildable} sets`}
        </span>
      ),
    },
    {
      key: "woo",
      header: "Website",
      hideable: true,
      wrap: true,
      cell: (c) => {
        if (c.wooProductId == null) {
          const unlinked = c.components.filter((x) => x.wooProductId == null).length;
          return (
            <span className="text-xs text-muted-foreground">
              Not on the website
              {unlinked > 0 && (
                <span className="block text-amber-600 dark:text-amber-400">
                  {unlinked} product{unlinked > 1 ? "s" : ""} to link first
                </span>
              )}
            </span>
          );
        }
        const d = drift[c.id];
        return (
          <div className="min-w-0">
            <span className="text-xs tabular-nums text-muted-foreground">#{c.wooProductId}</span>
            {d === "checking" && (
              <span className="block text-xs text-muted-foreground">Checking…</span>
            )}
            {d && d !== "checking" && !d.checked && (
              <span className="block text-xs text-muted-foreground">Website unreachable</span>
            )}
            {d && d !== "checking" && d.checked && d.matches && (
              <span className="block text-xs text-emerald-600 dark:text-emerald-400">Matches</span>
            )}
            {d && d !== "checking" && d.checked && !d.matches && (
              <span className="block text-xs text-destructive">{d.message}</span>
            )}
          </div>
        );
      },
    },
    ...(perms.canEdit
      ? [
          {
            key: "actions",
            header: "",
            cardFullWidth: true,
            cell: (c: ComboRow) => (
              // Outlined rather than ghost: these sit in a dense table, and a
              // borderless label next to four other borderless labels reads as
              // a sentence, not as five things you can press. `title` carries
              // the consequence, which is what somebody hesitating wants.
              <div className="flex flex-wrap gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  title="Change the price, the products in it, or the dates"
                  onClick={() => openEdit(c)}
                >
                  <Pencil />
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pushing === c.id}
                  title={
                    c.wooProductId != null
                      ? "Send this combo's current price and contents to the website"
                      : "Create this combo on the website as a draft product"
                  }
                  onClick={() => onPushWebsite(c)}
                >
                  <CloudUpload />
                  {pushing === c.id
                    ? "Sending…"
                    : c.wooProductId != null
                      ? "Send to website"
                      : "Put on website"}
                </Button>
                {c.wooProductId != null && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={drift[c.id] === "checking"}
                    title="Compare with the website and report any difference. Changes nothing."
                    onClick={() => onCheckWebsite(c)}
                  >
                    <RefreshCw />
                    Compare
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  title={
                    c.active
                      ? c.wooProductId
                        ? "Stop offering it on the order form here. Past orders keep theirs. The website is not affected — unpublish it in WooCommerce to stop selling there."
                        : "Stop offering it on the order form. Past orders keep theirs."
                      : "Offer it on the order form again"
                  }
                  onClick={() => onToggle(c)}
                >
                  {c.active ? <PowerOff /> : <Power />}
                  {c.active ? "Stop selling" : "Sell again"}
                </Button>
                {perms.canDelete && (
                  <Button
                    variant="destructive"
                    size="sm"
                    title="Remove the recipe for good. Past orders and stock are untouched."
                    onClick={() => onDelete(c)}
                  >
                    <Trash2 />
                    Delete
                  </Button>
                )}
              </div>
            ),
          } as Column<ComboRow>,
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <InfoNote title="A combo shares its stock with the products inside it.">
        <p>
          A combo is a recipe, not a thing on a shelf. Nothing here holds its own stock — every
          set is counted from the products inside it. Sell the last aeroplane on its own and
          every combo containing one goes to zero; sell that combo and the aeroplane&rsquo;s own
          listing goes to zero. There is no second number to keep in step.
        </p>
        <p>
          On an order a combo is never one line: it is written down as the products inside it,
          with the saving spread across them, so stock, cost, returns and profit all work on it
          the way they work on anything else.
        </p>
        <p>
          <strong>Put on website</strong> creates it there as a draft with the price and recipe
          already set; add the pictures and publish it. The id it comes back with is what turns
          a website order for the combo back into these products. Switching a combo off here,
          or letting its dates run out, does not stop it selling there.
        </p>
      </InfoNote>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Combo sets</h2>
          <p className="text-xs text-muted-foreground">
            Several products sold together at one price.
          </p>
        </div>
        {perms.canAdd && (
          <Button size="sm" onClick={openCreate} disabled={!hasProducts}>
            <Plus />
            New combo
          </Button>
        )}
      </div>

      {!hasProducts ? (
        <p className="text-sm text-muted-foreground">
          Add a product with a variant first — a combo is built out of them.
        </p>
      ) : (
        <DataTable
          rows={combos}
          rowKey={(c) => c.id}
          searchText={(c) =>
            `${c.name} ${c.sku ?? ""} ${c.components.map((k) => k.label).join(" ")}`
          }
          searchPlaceholder="Search combo or product…"
          empty={{
            icon: Boxes,
            title: "No combos yet",
            description: "Group a few products, set one price, and sell them as a set.",
          }}
          columns={columns}
        />
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit combo" : "New combo"}</DialogTitle>
          </DialogHeader>

          <form onSubmit={onSubmit} className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field name="name" error={formError} label="Combo name" required>
                <Input
                  id="combo-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Flight Starter Combo"
                  required
                />
              </Field>
              <div className="space-y-2">
                <Label htmlFor="combo-sku">SKU</Label>
                <Input
                  id="combo-sku"
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  placeholder="Optional"
                />
              </div>
              <Field name="price" error={formError} label="Combo price" required>
                <MoneyInput
                  id="combo-price"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  min="0"
                  step="0.01"
                  required
                />
              </Field>
              <Field
                name="wooProductId"
                error={formError}
                label="Website product id"
                hint="Filled in for you when you put the combo on the website. Type it only to adopt a combo that already exists there."
              >
                <Input
                  id="combo-woo"
                  type="number"
                  min="1"
                  inputMode="numeric"
                  value={wooProductId}
                  onChange={(e) => setWooProductId(e.target.value)}
                  placeholder="e.g. 4211"
                />
              </Field>
              <div className="space-y-2">
                <Label htmlFor="combo-from">Starts</Label>
                <Input
                  id="combo-from"
                  type="date"
                  value={validFrom}
                  onChange={(e) => setValidFrom(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="combo-to">Ends</Label>
                <Input
                  id="combo-to"
                  type="date"
                  value={validTo}
                  onChange={(e) => setValidTo(e.target.value)}
                />
              </div>
              <InfoNote
                tone="warn"
                className="sm:col-span-2"
                title="These dates stop orders taken here — not sales on the website."
              >
                <p>
                  The window is never sent to the website. A combo published there keeps
                  selling after the end date, at the same price, with no countdown, until
                  somebody unpublishes it in WooCommerce.
                </p>
                <p>
                  So these are for orders written up in this app — over the phone, on
                  Facebook. Ending a real offer on the shop is a second thing to do, in
                  WooCommerce.
                </p>
              </InfoNote>
            </div>

            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={freeDelivery}
                  onCheckedChange={(v) => setFreeDelivery(v === true)}
                />
                <span>
                  Free delivery with this combo
                  <span className="block text-xs text-muted-foreground">
                    Prefills the order&rsquo;s delivery charge at zero. What the courier
                    actually charged still goes in delivery cost, so the promotion shows up as
                    what it costs rather than disappearing.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={active} onCheckedChange={(v) => setActive(v === true)} />
                <span>
                  Available to sell
                  <span className="block text-xs text-muted-foreground">
                    Unticked, it stops appearing on the order form. Past orders keep theirs.
                  </span>
                </span>
              </label>
            </div>

            <section className="space-y-3 rounded-xl bg-muted/25 p-3 ring-1 ring-border">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold">What&rsquo;s in the box</h3>
                  <p className="text-xs text-muted-foreground">
                    Pick the exact variant — the colour and size that actually go in.
                  </p>
                </div>
                <div className="flex gap-2">
                  {components.some((c) => c.variant && c.variant.wooProductId == null) && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={suggesting}
                      onClick={onSuggestLinks}
                    >
                      {suggesting ? "Matching…" : "Match to website"}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setComponents([...components, emptyComponent()])}
                  >
                    <Plus />
                    Add product
                  </Button>
                </div>
              </div>

              <div className="space-y-3">
                {components.map((c, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[minmax(0,1fr)_5rem_2.25rem] items-end gap-2"
                  >
                    <div className="space-y-2">
                      <Label>Product {i + 1}</Label>
                      <AsyncCombobox
                        value={c.variant}
                        onChange={(opt) => updateComponent(i, { variant: opt })}
                        fetchPage={async (q, cursor) => {
                          const res = await searchVariants(slug, q, cursor);
                          return res.ok
                            ? { items: res.items, next: res.next }
                            : { items: [], next: null };
                        }}
                        placeholder="Search product…"
                        renderItem={(o) => (
                          <>
                            <span className="truncate">{o.label}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {o.stock} in stock
                            </span>
                          </>
                        )}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Qty</Label>
                      <Input
                        type="number"
                        min="1"
                        inputMode="numeric"
                        value={c.quantity}
                        onChange={(e) => updateComponent(i, { quantity: e.target.value })}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove product ${i + 1}`}
                      disabled={components.length <= 2}
                      onClick={() => setComponents(components.filter((_, j) => j !== i))}
                    >
                      <Trash2 />
                    </Button>
                    {c.variant && (
                      <div className="col-span-3">
                        <WebsiteLinkField
                          slug={slug}
                          variant={c.variant}
                          onLinked={(wooProductId) =>
                            updateComponent(i, {
                              variant: { ...(c.variant as VariantOption), wooProductId },
                            })
                          }
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {preview.picked.length > 0 && (
              <section className="space-y-2 rounded-xl bg-muted/25 p-3 text-sm ring-1 ring-border">
                <h3 className="text-sm font-semibold">
                  Before you save
                  {preview.loading && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      checking prices and stock…
                    </span>
                  )}
                </h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">Bought separately</dt>
                    <dd>
                      <Money value={preview.listTotal} />
                      {preview.unpriced > 0 && (
                        <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">
                          + {preview.unpriced} unpriced
                        </span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Customer saves</dt>
                    <dd>
                      <Money value={preview.saving} tone="positive" />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Your margin</dt>
                    <dd>
                      <Money
                        value={preview.margin}
                        tone={preview.margin < 0 ? "negative" : "positive"}
                      />
                      <span className="ml-1 text-xs text-muted-foreground">
                        {preview.marginPct}%
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Can make now</dt>
                    <dd className={preview.buildable === 0 ? "text-destructive" : undefined}>
                      {preview.buildable} sets
                    </dd>
                  </div>
                </dl>
                {preview.duplicated && (
                  <p className="text-xs text-destructive">
                    The same product is on more than one row. Put it on one row and set its
                    quantity — saving will refuse it otherwise.
                  </p>
                )}
                {preview.websiteMerges.map((m) => (
                  <p key={m.id} className="text-xs text-muted-foreground">
                    {m.labels.join(" and ")} are one product on the website (#{m.id}) — it
                    will be told this set needs {m.qty}, and will count how many sets it can
                    make from that one listing.
                  </p>
                ))}
                {preview.unpriced > 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {preview.unpriced} of these has no price of its own, so &ldquo;bought
                    separately&rdquo; is lower than the truth and the saving looks smaller than it
                    is. Give it a sale price on its product to fix the figure.
                  </p>
                )}
                {preview.margin < 0 && (
                  <p className="text-xs text-destructive">
                    This combo sells for less than the goods cost you. Save it only if that is
                    deliberate.
                  </p>
                )}
                {preview.allocation.length > 0 && (
                  <div className="pt-1">
                    <p className="text-xs text-muted-foreground">
                      On an order this writes:
                    </p>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {preview.allocation.map((a, i) => (
                        <li key={a.productVariantId} className="flex justify-between gap-3">
                          <span className="truncate">
                            {components.find((c) => c.variant?.value === a.productVariantId)
                              ?.variant?.label ?? `Item ${i + 1}`}{" "}
                            ×{a.quantity}
                          </span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            <Money value={a.unitPrice} bare /> less{" "}
                            <Money value={a.discount} bare />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}

            <FormError error={formError} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : editing ? "Save changes" : "Create combo"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
