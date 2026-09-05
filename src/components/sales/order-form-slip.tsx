import { formatMoney } from "@/lib/money";

/**
 * One A5 "Delivery & Order Form" — half of a printed A4 landscape sheet.
 *
 * This is NOT the invoice (`/sales/orders/[id]/invoice`). The invoice is the
 * customer's priced document: line items, discounts, balance due. This is the
 * slip that travels with the parcel — who it goes to, which order it is, how
 * many pieces, what to collect. The two deliberately stay separate documents;
 * folding the delivery form into the invoice would mean either printing prices
 * the packer doesn't need or dropping the discount/paid lines the customer
 * does.
 *
 * `order = null` renders a BLANK form to fill in by hand — not an error state.
 * It's what fills the right-hand column when an odd number of orders is
 * printed, and the two render deliberately differently: see BLANK VS FILLED.
 */

/** One line of the packing list. */
export type SlipItem = {
  /** Product name with its variant, e.g. "Baby Pants · M". */
  name: string;
  /** Net of returns; fully-returned lines never reach here. */
  qty: number;
};

export type SlipOrder = {
  /** Shown under "অর্ডার আইডি" — courier consignment no. when there is one. */
  orderNumber: string;
  /** Already formatted for print — the component does no date maths. */
  dateLabel: string;
  customerName: string | null;
  phone: string | null;
  address: string | null;
  /** What actually goes in the box. */
  items: SlipItem[];
  /**
   * Total PIECES across the whole order, not the number of distinct products:
   * the packer counts things going into the box, and two units of one product
   * is still two things. Returned units are already excluded.
   */
  totalQty: number;
  /**
   * What must actually be handed over on delivery.
   *
   * NOT the order's value. An order already settled by bKash collects nothing,
   * and a part-paid one collects only the balance — printing the full total on
   * either is how a courier ends up taking money twice. See amountOutstanding.
   */
  collect: number;
  /** The order's full value. Printed as context only when it differs from `collect`. */
  total: number;
  /** What the customer has already handed over. */
  paid: number;
  /**
   * A cancelled order also collects nothing, but for the opposite reason to a
   * settled one — the sale didn't happen. Without this the two are
   * indistinguishable from the figures alone, and a cancelled parcel printed
   * "সম্পূর্ণ পরিশোধিত" as if the customer had paid in full.
   */
  cancelled: boolean;
  /** null when it can't be told from the courier zone. Blank form only. */
  insideDhaka: boolean | null;
  /** null when the method maps to neither printed option. Blank form only. */
  codPayment: boolean | null;
  notes: string | null;
};

export type SlipWorkspace = {
  name: string;
  logoUrl: string | null;
  /** Bare host, e.g. "gedushop.com". Omitted from the footer when absent. */
  websiteUrl: string | null;
};

/**
 * Print colours, fixed rather than themed. This document is captured to PDF
 * and put on paper, where the app's light/dark tokens mean nothing and a
 * near-black "muted foreground" turns into an unreadable grey at 9px on an
 * inkjet. Sampled from the shop's existing form so a reprint sits next to an
 * old one without looking like a different shop.
 */
const INK = "#2f2a5c"; // headings
const ACCENT = "#e8544f"; // the "Delivery & Order Form" line and required marks
const RULE = "#9b96c0"; // the blank form's write-in boxes
const BODY = "#111111"; // filled-in values
const MUTED = "#6b6785"; // field labels on a filled slip

/*
 * BLANK VS FILLED
 *
 * The same document, but the two sides of a sheet are doing different jobs and
 * one shared layout served neither well.
 *
 * A blank form is something a person writes on. It keeps the fields the packing
 * table fills by hand, plus the ruled boxes and the red required marks: the box
 * is where the pen goes and the asterisk says the line can't be left out.
 *
 * A filled slip is a record that travels taped to a parcel, read by a packer
 * and a courier at arm's length. So it drops what neither of them acts on
 * (delivery area repeats the address; payment method repeats the amount to
 * collect), drops the boxes and asterisks, hides an empty notes section
 * entirely, and leans on type instead — a small grey label over a large dark
 * value, with the two things a courier is answerable for, the phone number and
 * the amount to collect, largest of all.
 */

export function OrderFormSlip({
  order,
  workspace,
  density = 2,
}: {
  order: SlipOrder | null;
  workspace: SlipWorkspace;
  /**
   * How many slips share the A4 sheet. 2 (the default) is the original A5
   * half-sheet layout, unchanged. 4 is a quarter-sheet: half the height, so
   * the item list and footer are dropped and everything but order id, phone
   * and the collect amount shrinks — see FilledBody/BlankBody's `compact`
   * branches.
   */
  density?: 2 | 4;
}) {
  const compact = density === 4;
  return (
    <div
      className={`flex h-full flex-col overflow-hidden leading-tight ${
        compact ? "px-[6mm] py-[2.5mm]" : "px-[8mm] py-[6mm]"
      }`}
      style={{ color: BODY }}
    >
      <header className="flex flex-col items-center text-center">
        {workspace.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={workspace.logoUrl}
            alt={workspace.name}
            className={
              compact
                ? "mb-[0.5mm] h-[11mm] w-auto max-w-[50mm] object-contain"
                : "mb-[1.5mm] h-[17mm] w-auto max-w-[70mm] object-contain"
            }
          />
        )}
        <h1
          className={compact ? "text-[17px] font-bold" : "text-[22px] font-bold"}
          style={{ color: INK }}
        >
          {workspace.name}
        </h1>
        {!compact && (
          <p className="text-[12px] font-semibold" style={{ color: ACCENT }}>
            Delivery &amp; Order Form
          </p>
        )}
      </header>

      {/* First thing under the masthead on both faces. Every conversation about
          a parcel — with the courier, with the customer, in the app — starts by
          quoting this number, so it should be the first thing found rather than
          hunted for halfway down. */}
      <div
        className={`flex items-end justify-between gap-[4mm] border-b-2 ${
          compact ? "mt-[1mm] pb-[1mm]" : "mt-[3.5mm] pb-[1.5mm]"
        }`}
        style={{ borderColor: INK }}
      >
        <div>
          <div className="text-[10px]" style={{ color: MUTED }}>
            অর্ডার আইডি (Order ID)
          </div>
          {order ? (
            <div
              className={`leading-tight font-bold tabular-nums ${compact ? "text-[19px]" : "text-[22px]"}`}
              style={{ color: INK }}
            >
              {order.orderNumber}
            </div>
          ) : (
            <div className="h-[6mm]" />
          )}
        </div>
        {/* Printed record only. On a blank form the date would be one more
            thing to write for no gain — whoever fills it in is holding it the
            day they fill it in, and the space is better spent on the boxes. */}
        {order && (
          <div className="text-right">
            <div className="text-[10px]" style={{ color: MUTED }}>
              তারিখ (Date)
            </div>
            <div className="text-[12px] font-medium" style={{ color: INK }}>
              {order.dateLabel}
            </div>
          </div>
        )}
      </div>

      {order ? (
        <FilledBody order={order} compact={compact} />
      ) : (
        <BlankBody compact={compact} />
      )}

      <Footer workspace={workspace} compact={compact} />
    </div>
  );
}

function FilledBody({ order, compact }: { order: SlipOrder; compact: boolean }) {
  if (compact) {
    return (
      <>
        {/* Name shrinks to a caption; the phone is the field a courier
            actually dials, so it keeps most of its size. */}
        <Value className="mt-[2mm] text-[14px] font-semibold">{order.customerName}</Value>
        <Value className="mt-[0.75mm] text-[19px] font-bold tracking-wide tabular-nums">
          {order.phone}
        </Value>
        {/* Product names are dropped at this density — no room to read them
            at arm's length — but the address stays: it's what makes the
            parcel deliverable, just clamped tighter than the half-sheet. */}
        <Value className="mt-[1.5mm] min-h-[15mm] text-[13px] leading-snug whitespace-pre-wrap" clampLines={3}>
          {order.address}
        </Value>

        {/* The one figure the shop can be argued with about, boxed the way
            every courier's own COD label boxes it. */}
        <div className="mt-auto border-2 px-[3mm] py-[2mm]" style={{ borderColor: INK }}>
          <div className="text-[11px]" style={{ color: MUTED }}>
            সংগ্রহ করতে হবে (ডেলিভারি সহ)
          </div>
          <div className="text-[26px] leading-none font-bold tabular-nums" style={{ color: INK }}>
            {formatMoney(order.collect)}
          </div>
          {settledNote(order) && (
            <div className="mt-[1mm] text-[9px]" style={{ color: MUTED }}>
              {settledNote(order)}
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <Heading>প্রাপক (Deliver to)</Heading>
      <Value className="mt-[2mm] text-[17px] font-semibold">{order.customerName}</Value>
      {/* The number a courier dials from the doorstep — the largest thing on
          the slip after the amount. */}
      <Value className="mt-[1mm] text-[20px] font-bold tracking-wide tabular-nums">
        {order.phone}
      </Value>
      {/* Six lines, and the space for all six reserved whether they're used or
          not. A Dhaka address with a floor and a landmark on it runs past four
          lines and was being cut mid-word; reserving the height as well as
          raising the cap keeps the amount box in the same place on every slip,
          so a stack of them still reads at a glance. 7.5em = 6 lines at this
          size's leading. */}
      <Value
        className="mt-[1.5mm] min-h-[7.5em] text-[16px] whitespace-pre-wrap"
        clampLines={6}
      >
        {order.address}
      </Value>

      <Heading className="mt-[5mm]">পণ্য (Items)</Heading>
      <ItemList items={order.items} totalQty={order.totalQty} />

      {/* The one figure the shop can be argued with about, boxed the way every
          courier's own COD label boxes it. */}
      <div
        className="mt-[5mm] border-2 px-[3.5mm] py-[2.5mm]"
        style={{ borderColor: INK }}
      >
        <div className="text-[11px]" style={{ color: MUTED }}>
          সংগ্রহ করতে হবে (ডেলিভারি সহ)
        </div>
        <div className="text-[32px] leading-none font-bold tabular-nums" style={{ color: INK }}>
          {formatMoney(order.collect)}
        </div>
        {settledNote(order) && (
          <div className="mt-[1.5mm] text-[10.5px]" style={{ color: MUTED }}>
            {settledNote(order)}
          </div>
        )}
      </div>

      {/* An empty notes section on a record is three lines saying nothing. */}
      {order.notes?.trim() && (
        <>
          <Heading className="mt-[6mm]">বিশেষ নির্দেশনা (Note)</Heading>
          <Value className="mt-[2mm] text-[14px] whitespace-pre-wrap" clampLines={2}>
            {order.notes}
          </Value>
        </>
      )}
    </>
  );
}

/**
 * The compact blank form keeps only what has to be written on a quarter page:
 * customer name, mobile, address and the amount collected.
 */
function BlankBody({ compact }: { compact: boolean }) {
  if (compact) {
    return (
      <BlankGroup>
        <BlankField label="কাস্টমারের নাম" height="10mm" />
        <BlankField label="মোবাইল নম্বর" height="10mm" />
        <BlankField label="পূর্ণাঙ্গ ঠিকানা" height="24mm" />
        <BlankField label="সংগ্রহ করতে হবে (ডেলিভারি সহ)" height="12mm" />
      </BlankGroup>
    );
  }

  return (
    <>
      <Heading className="mt-[2mm]">১. কাস্টমার ও ডেলিভারি তথ্য (Customer &amp; Delivery)</Heading>
      <BlankGroup>
        <BlankField label="কাস্টমারের নাম" />
        <BlankField label="মোবাইল নম্বর" />
        {/* Written out by hand, and a Dhaka address runs long — it gets more
            room than a field somebody writes one word in. */}
        <BlankField label="পূর্ণাঙ্গ ঠিকানা" height="22mm" />
        <BlankField
          label="ডেলিভারি এরিয়া"
          ticks={["ঢাকার ভিতরে", "ঢাকার বাইরে"]}
        />
      </BlankGroup>

      <Heading className="mt-[2mm]">২. অর্ডার ও পেমেন্ট তথ্য (Order &amp; Payment)</Heading>
      <BlankGroup>
        <BlankField label="পরিমাণ (Qty)" />
        <BlankField label="সংগ্রহ করতে হবে (ডেলিভারি সহ)" />
        <BlankField label="পেমেন্ট মেথড" ticks={["COD", "বিকাশ/নগদ"]} />
      </BlankGroup>

      <Heading className="mt-[2mm]">৩. বিশেষ নোট (Special Notes)</Heading>
      <BlankGroup>
        <BlankField label="নির্দেশনা" height="12mm" />
      </BlankGroup>
    </>
  );
}

/**
 * The line under the amount, explaining why it isn't the order's total. Only
 * printed when the two differ — on the ordinary unpaid COD parcel, most of
 * them, the amount stands on its own and a note would just be noise.
 */
function settledNote(order: SlipOrder): string | null {
  // Checked before the money, because a cancelled order collects nothing for
  // a completely different reason and the figures alone can't tell them apart.
  if (order.cancelled) return "অর্ডার বাতিল (Cancelled) — সংগ্রহ করার কিছু নেই";
  if (order.paid <= 0) return null;
  if (order.collect <= 0) return `সম্পূর্ণ পরিশোধিত (${formatMoney(order.total)}) — কিছু নিতে হবে না`;
  return `বিল ${formatMoney(order.total)} · পরিশোধিত ${formatMoney(order.paid)}`;
}

/**
 * What goes in the box, the way a packer reads it: name on the left, count on
 * the right, one line each.
 *
 * Capped rather than scrolled — this is paper. Past the cap the remainder is
 * counted rather than silently dropped, so a packer looking at "+2 আরও পণ্য"
 * knows to open the order instead of trusting the slip. The total is printed
 * whatever happens, because that's the number worth checking the box against.
 */
const MAX_LINES = 7;

function ItemList({ items, totalQty }: { items: SlipItem[]; totalQty: number }) {
  if (items.length === 0) {
    return <div className="mt-[2mm] text-[13px]">—</div>;
  }
  const shown = items.slice(0, MAX_LINES);
  const hidden = items.length - shown.length;

  return (
    // A minimum height so a one-line order still reads as a packing list with
    // a total under it, rather than two stray lines followed by a third of a
    // page of nothing. The total sits at the bottom of that box either way.
    <div className="mt-[2mm] flex min-h-[26mm] flex-col">
      {shown.map((it, i) => (
        <div key={i} className="flex items-baseline gap-[3mm] py-[0.6mm] text-[13px]">
          {/* Two lines each: one catalogue name long enough to wrap five times
              would otherwise push the amount off the page on its own. */}
          <span
            className="min-w-0 flex-1 wrap-break-word"
            style={{
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2,
              overflow: "hidden",
            }}
          >
            {it.name}
          </span>
          <span className="shrink-0 font-semibold tabular-nums">×{it.qty}</span>
        </div>
      ))}
      {hidden > 0 && (
        <div className="py-[0.6mm] text-[11px]" style={{ color: MUTED }}>
          + আরও {hidden}টি পণ্য
        </div>
      )}
      <div
        className="mt-auto flex items-baseline justify-between border-t pt-[1mm] text-[12px]"
        style={{ borderColor: RULE }}
      >
        <span style={{ color: MUTED }}>মোট পিস (Total pieces)</span>
        <span className="text-[15px] font-bold tabular-nums">{totalQty}</span>
      </div>
    </div>
  );
}

function Footer({ workspace, compact }: { workspace: SlipWorkspace; compact: boolean }) {
  // Compact keeps only the bare URL — no caption, no thank-you line — there's
  // no room for either at a quarter page.
  if (compact) {
    if (!workspace.websiteUrl) return null;
    // No auto margin here: FilledBody/BlankBody already push their own last
    // element to the bottom with one, and a second auto margin on this
    // sibling would split the leftover space between the two instead of
    // letting the amount box sit flush just above this line.
    return (
      <p className="mt-[1mm] text-center text-[12px] font-bold" style={{ color: ACCENT }}>
        {workspace.websiteUrl}
      </p>
    );
  }
  return (
    <div
      className="mt-auto border-t pt-[2.5mm] text-center"
      style={{ borderColor: RULE }}
    >
      {workspace.websiteUrl && (
        <>
          <p className="text-[10.5px]" style={{ color: MUTED }}>
            যেকোনো প্রোডাক্ট অর্ডার করতে ভিজিট করুন
          </p>
          <p className="text-[16px] font-bold" style={{ color: ACCENT }}>
            {workspace.websiteUrl}
          </p>
        </>
      )}
      <p className="mt-[0.5mm] text-[10px] italic" style={{ color: INK }}>
        Thank you for shopping with {workspace.name}! 🎀
      </p>
    </div>
  );
}

function Heading({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <h2
      className={`border-b pb-[1mm] text-[11.5px] font-semibold tracking-wide ${className}`}
      style={{ color: INK, borderColor: INK }}
    >
      {children}
    </h2>
  );
}

/**
 * A value on a filled slip. `clampLines` caps the height of anything typed by
 * a person — one pasted five-line address must not push the footer off the
 * page — and shows an ellipsis rather than cutting silently.
 */
function Value({
  children,
  className = "",
  clampLines,
}: {
  children: React.ReactNode;
  className?: string;
  clampLines?: number;
}) {
  const text = typeof children === "string" ? children.trim() : children;
  return (
    <div
      className={`wrap-break-word ${className}`}
      style={
        clampLines
          ? {
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: clampLines,
              overflow: "hidden",
            }
          : undefined
      }
    >
      {/* An em dash rather than nothing: a blank line on a record reads as a
          layout bug, where "—" reads as "we don't have this". */}
      {text || "—"}
    </div>
  );
}

/** Small grey caption over a value, for the two short fields printed side by side. */
function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px]" style={{ color: MUTED }}>
        {label}
      </div>
      <div className="mt-[0.5mm]">{children}</div>
    </div>
  );
}

function BlankGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-[1.5mm] border-t border-l" style={{ borderColor: RULE }}>
      {children}
    </div>
  );
}

function BlankField({
  label,
  ticks,
  height,
}: {
  label: string;
  ticks?: string[];
  height?: string;
}) {
  return (
    <div className="flex border-b" style={{ borderColor: RULE, minHeight: height ?? "10mm" }}>
      <div
        className="flex w-[38%] shrink-0 items-center border-r px-[2.5mm] py-[1.5mm] text-[12px]"
        style={{ borderColor: RULE, color: INK }}
      >
        <span>
          {label} <span style={{ color: ACCENT }}>*</span>
        </span>
      </div>
      <div
        className="flex flex-1 items-center border-r px-[2.5mm] py-[1.5mm]"
        style={{ borderColor: RULE }}
      >
        {ticks && (
          <span className="flex flex-wrap items-center gap-x-[4mm] text-[12px]">
            {ticks.map((t) => (
              <span key={t} className="whitespace-nowrap">
                {/* A fixed-width gap inside the brackets: a hand-drawn tick
                    needs room, and literal spaces gave none consistently. */}
                <span className="font-mono">
                  [<span className="inline-block w-[1.2em]" />]
                </span>{" "}
                {t}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
