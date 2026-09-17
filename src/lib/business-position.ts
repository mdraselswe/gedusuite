import { round2 } from "@/lib/money";

export type UnbankedMoney = {
  amount: number;
  paymentMethod: string;
  isCourierCollection: boolean;
};

export type BusinessMoneyPosition = {
  treasury: number;
  courier: number;
  cash: number;
  bkash: number;
  nagad: number;
  other: number;
  dueGross: number;
  dueNet: number;
  totalExcludingStock: number;
};

/**
 * Split money already collected but not banked by where it physically sits,
 * then add customer receivables once. `dueNet` is used in the grand total:
 * courier charges that will be deducted before an unpaid COD reaches us are
 * not an asset, even though the customer still owes the gross invoice.
 */
export function businessMoneyPosition(input: {
  treasury: number;
  unbanked: UnbankedMoney[];
  dueGross: number;
  dueNet: number;
}): BusinessMoneyPosition {
  const buckets = { courier: 0, cash: 0, bkash: 0, nagad: 0, other: 0 };

  for (const row of input.unbanked) {
    // A negative unbanked amount is a courier bill waiting to be netted from a
    // payout, regardless of how the customer was meant to pay.
    if (row.isCourierCollection || row.amount < 0) buckets.courier += row.amount;
    else if (row.paymentMethod === "CASH") buckets.cash += row.amount;
    else if (row.paymentMethod === "BKASH") buckets.bkash += row.amount;
    else if (row.paymentMethod === "NAGAD") buckets.nagad += row.amount;
    else buckets.other += row.amount;
  }

  const position = {
    treasury: round2(input.treasury),
    courier: round2(buckets.courier),
    cash: round2(buckets.cash),
    bkash: round2(buckets.bkash),
    nagad: round2(buckets.nagad),
    other: round2(buckets.other),
    dueGross: round2(input.dueGross),
    dueNet: round2(input.dueNet),
  };
  return {
    ...position,
    totalExcludingStock: round2(
      position.treasury +
        position.courier +
        position.cash +
        position.bkash +
        position.nagad +
        position.other +
        position.dueNet,
    ),
  };
}
