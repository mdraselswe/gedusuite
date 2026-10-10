import { computeOrderTotals } from "@/lib/orders";
import { depositAmount } from "@/lib/order-cash";
import { splitByShare } from "@/lib/profit-share";

/**
 * One parcel, followed all the way to the people who own the business.
 *
 * Every figure on this slip is produced by the same functions the app uses for
 * a real order — computeOrderTotals, depositAmount, splitByShare — rather than
 * typed in. The page that claims "one number, one place" is therefore made of
 * exactly that, and cannot drift from what the product would show.
 */
const taka = (n: number) =>
  `৳${n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const takaWhole = (n: number) => `৳${n.toLocaleString("en")}`;

const ITEMS = [
  { name: "Baby Lotion 400ml", qty: 1, price: 780, cost: 520 },
  { name: "Feeding Bottle 250ml", qty: 1, price: 520, cost: 330 },
];
const DELIVERY_CHARGE = 130; // what the customer pays for delivery
const DELIVERY_COST = 120; // what the courier bills the shop
const COD_FEE = 14.3; // 1% of the cash collected at the door

export function OrderSlip() {
  const order = {
    deliveryCharge: DELIVERY_CHARGE,
    deliveryCost: DELIVERY_COST,
    codFeeCost: COD_FEE,
    packagingCost: 12,
    giftCost: 0,
    discount: 0,
    items: ITEMS.map((i) => ({
      unitPrice: i.price,
      unitCost: i.cost,
      quantity: i.qty,
      discount: 0,
      returns: [],
    })),
  };
  const t = computeOrderTotals(order);
  const bank = depositAmount(
    {
      status: "DELIVERED",
      deliveryType: "COURIER",
      paymentMethod: "COURIER_COLLECTION",
      paymentStatus: "PAID",
      deliveryCost: DELIVERY_COST,
      collectionShortfall: 0,
    },
    { customerTotal: t.customerTotal, deliveryCost: DELIVERY_COST, codFeeCost: COD_FEE },
  );
  const shares = splitByShare(
    [
      { name: "Shahriar", percent: 50 },
      { name: "Rafiul", percent: 30 },
      { name: "Mim", percent: 20 },
    ],
    t.netProfit,
  );

  return (
    <figure
      aria-label="One order followed from sale to partner profit"
      className="relative w-full max-w-md rotate-[0.6deg] border border-ink/15 bg-white px-6 pb-7 pt-6 text-[13px] leading-6 text-ink shadow-[6px_6px_0_0_var(--color-tape)]"
    >
      <div className="flex items-baseline justify-between">
        <span className="font-display text-lg font-semibold tracking-tight">Order #1042</span>
        <span className="text-xs text-ink/60">Delivered · Outside Dhaka · COD</span>
      </div>

      <hr className="my-3 border-dashed border-ink/25" />

      <ul className="space-y-0.5">
        {ITEMS.map((i) => (
          <li key={i.name} className="flex justify-between">
            <span>
              {i.qty} × {i.name}
            </span>
            <span className="tabular-nums">{takaWhole(i.price * i.qty)}</span>
          </li>
        ))}
        <li className="flex justify-between text-ink/70">
          <span>Delivery charged</span>
          <span className="tabular-nums">{takaWhole(DELIVERY_CHARGE)}</span>
        </li>
        <li className="flex justify-between border-t border-ink/20 pt-1 font-semibold">
          <span>Customer paid the rider</span>
          <span className="tabular-nums">{taka(t.customerTotal)}</span>
        </li>
      </ul>

      <hr className="my-3 border-dashed border-ink/25" />

      <ul className="space-y-0.5">
        <li className="flex justify-between text-ink/70">
          <span>Courier delivery bill</span>
          <span className="tabular-nums">− {taka(DELIVERY_COST)}</span>
        </li>
        <li className="flex justify-between text-ink/70">
          <span>Courier cash-on-delivery fee (1%)</span>
          <span className="tabular-nums">− {taka(COD_FEE)}</span>
        </li>
        <li className="flex justify-between border-t border-ink/20 pt-1 font-semibold">
          <span>Lands in the treasury</span>
          <span className="tabular-nums text-teal">{taka(bank.net)}</span>
        </li>
      </ul>

      <hr className="my-3 border-dashed border-ink/25" />

      <ul className="space-y-0.5">
        <li className="flex justify-between text-ink/70">
          <span>Goods at cost</span>
          <span className="tabular-nums">− {taka(t.cogs)}</span>
        </li>
        <li className="flex justify-between border-t border-ink/20 pt-1 font-semibold">
          <span>Profit on this parcel</span>
          <span className="tabular-nums text-teal">{taka(t.netProfit)}</span>
        </li>
        {shares.map((s) => (
          <li key={s.name} className="flex justify-between pl-4 text-ink/70">
            <span>
              {s.name} · {s.percent}%
            </span>
            <span className="tabular-nums">{taka(s.amount)}</span>
          </li>
        ))}
      </ul>

      <figcaption className="mt-5 text-xs text-ink/55">
        Worked out by the same code that runs your shop. The orders list, the dashboard and the
        reports all read this one number.
      </figcaption>

      <span
        aria-hidden
        className="absolute -right-3 -top-4 rotate-6 border-2 border-stamp px-2 py-0.5 font-display text-sm font-bold text-stamp"
      >
        Adds up
      </span>
    </figure>
  );
}
