/**
 * Steadfast Courier's booking API.
 *
 * Six fields go out and a consignment comes back. That is genuinely all there
 * is: `create_order` takes invoice, name, phone, address, COD and a note, and
 * has no field for district, city, weight, or home-vs-point delivery. This was
 * checked against Steadfast's own WooCommerce plugin (steadfast-api 1.0.7,
 * includes/functions.php:46), which builds its address the same way —
 *
 *   $recipient_address = $address_1 . ',' . $city . '-' . $postcode;
 *
 * — so anything the app's dropdowns capture can only reach Steadfast as part
 * of the address line. lib/bd-locations composes that line; this file sends it.
 *
 * The mapping functions are pure and exported on their own, because what goes
 * on the label is worth testing and mocking fetch to test it would be silly.
 */

const BASE_URL = "https://portal.packzy.com/api/v1";
const TIMEOUT_MS = 20_000;

export type SteadfastCredentials = { apiKey: string; secretKey: string };

export type ParcelPayload = {
  invoice: string;
  recipient_name: string;
  recipient_phone: string;
  recipient_address: string;
  cod_amount: number;
  note?: string;
  item_description?: string;
  alternative_phone?: string;
};

export type Consignment = {
  consignment_id: number;
  invoice: string;
  tracking_code: string;
  recipient_name: string;
  recipient_phone: string;
  recipient_address: string;
  cod_amount: number;
  status: string;
  created_at: string;
  updated_at: string;
};

export type SteadfastResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/**
 * A Bangladeshi mobile number as Steadfast's own plugin sends it: the last ten
 * digits with a leading zero.
 *
 * The published docs show "+8801309055966", but the plugin posts "01309055966"
 * and 8,000 shops book through it daily, so that is the format with evidence
 * behind it. Taking the LAST ten digits is what makes every stored variant —
 * +8801…, 8801…, 01…, and numbers with spaces or dashes — land on the same
 * answer. Returns null when there aren't ten digits to take, because a parcel
 * with an unreachable number is a parcel that comes back.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  const last10 = digits.slice(-10);
  // Every BD mobile number is 01[3-9]XXXXXXXX, so the last ten always start
  // with the operator digit. Anything else is a landline or a typo.
  if (!/^1[3-9]\d{8}$/.test(last10)) return null;
  return `0${last10}`;
}

/**
 * The `invoice` Steadfast files the parcel under. Must be unique per parcel —
 * a repeat submits as a duplicate and is rejected.
 */
export function buildInvoice(prefix: string, orderNo: number): string {
  const clean = prefix.trim().replace(/[^A-Za-z0-9-]/g, "").toUpperCase();
  return clean ? `${clean}-${orderNo}` : String(orderNo);
}

/**
 * What the courier sees on the label. Kept short — this is a one-line field on
 * a printed sticker, not a packing list — and quantity-first so a rider
 * counting boxes can check it at the door.
 */
export function buildItemDescription(
  items: { name: string; quantity: number }[],
  maxLength = 200,
): string {
  const text = items.map((i) => `${i.quantity}x ${i.name}`).join(", ");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

async function request<T>(
  creds: SteadfastCredentials,
  path: string,
  init: {
    method: "GET" | "POST";
    body?: unknown;
    /**
     * What counts as success in the body. The parcel endpoints answer 200; the
     * money ones answer `{"status": 1, "alertClass": "success"}`, and reading
     * that as a failure is how a working endpoint looks broken.
     */
    okStatus?: number[];
  },
): Promise<SteadfastResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "api-key": creds.apiKey,
        "secret-key": creds.secretKey,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // A gateway error page, or the portal being down. Say which, rather than
      // "Unexpected token < in JSON".
      return { ok: false, error: `Steadfast returned a non-JSON response (HTTP ${res.status})` };
    }

    const body = json as {
      status?: number;
      message?: string;
      errors?: Record<string, string[]>;
    } & Record<string, unknown>;

    // Steadfast answers HTTP 200 with its real status in the body, and 401 with
    // nothing useful in it, so both have to be checked.
    if (res.status === 401 || body.status === 401) {
      return { ok: false, error: "Steadfast rejected the API key — check the credentials in Settings → Couriers" };
    }
    if (body.errors && Object.keys(body.errors).length > 0) {
      const first = Object.values(body.errors)[0]?.[0];
      return {
        ok: false,
        error: first ?? body.message ?? "Steadfast rejected the parcel",
        fieldErrors: body.errors,
      };
    }
    const accepted = init.okStatus ?? [200];
    if (!res.ok || (body.status != null && !accepted.includes(body.status))) {
      return { ok: false, error: body.message ?? `Steadfast returned HTTP ${res.status}` };
    }

    return { ok: true, data: json as T };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "Steadfast did not respond in 20 seconds — the parcel was not booked" };
    }
    return { ok: false, error: `Could not reach Steadfast: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function createParcel(
  creds: SteadfastCredentials,
  payload: ParcelPayload,
): Promise<SteadfastResult<Consignment>> {
  const res = await request<{ consignment: Consignment }>(creds, "/create_order", {
    method: "POST",
    body: payload,
  });
  if (!res.ok) return res;
  if (!res.data.consignment?.consignment_id) {
    // Booked or not? Neither answer is safe to assume, so say exactly that —
    // the caller must not record a tracking id it did not receive, and the
    // operator must not press the button again without looking.
    return {
      ok: false,
      error: "Steadfast accepted the request but returned no consignment — check the Steadfast app before retrying",
    };
  }
  return { ok: true, data: res.data.consignment };
}

/**
 * The account balance. Used to prove a pasted API key actually works before it
 * is stored — the cheapest call that exercises both halves of the credential.
 *
 * The API has more than this (status_by_cid, fraud_check, payments, returns).
 * They are not wrapped here because nothing calls them yet: delivery status
 * arrives by webhook, and an unused export is a promise this file has not been
 * asked to keep.
 */
export async function getBalance(
  creds: SteadfastCredentials,
): Promise<SteadfastResult<{ current_balance: number }>> {
  return request(creds, "/get_balance", { method: "GET" });
}


/** One line of Steadfast's payment history — a payout it has made, or is making. */
export type SteadfastPayment = {
  payment_id: string;
  /** What the parcels in this payout collected, before anything was kept. */
  amount: number;
  method: string | null;
  /** The delivery charges on those parcels. */
  due_bills: number;
  paid_bills: number;
  /**
   * The percentage fee — charged on the payout as a whole and floored to a
   * whole taka, not summed from the parcels. 18,199 collected less 2,075 of
   * delivery bills is 16,124, and this came back as 161.
   */
  charges: number;
  /** amount − due_bills − charges: what actually reaches the bank. */
  total: number;
  status_label: string;
  created_at: string | null;
  ready_at: string | null;
  paid_at: string | null;
};

/** A parcel inside a payout. No charge or weight here — only what it collected. */
export type SteadfastPaymentConsignment = {
  consignment_id: number;
  invoice: string | null;
  tracking_code: string | null;
  recipient_name: string | null;
  cod_amount: number;
  status: string;
};

/**
 * Every payout Steadfast has made to this account.
 *
 * The one thing the app could never work out for itself: which parcels a
 * payment covered, and what it actually paid. Guessing at it from "has this
 * order been marked deposited" is close but never exact — the two sets are
 * kept by different people for different reasons.
 */
export async function listPayments(
  creds: SteadfastCredentials,
): Promise<SteadfastResult<SteadfastPayment[]>> {
  const res = await request<{ payments?: SteadfastPayment[] }>(creds, "/payments", {
    method: "GET",
    okStatus: [1, 200],
  });
  if (!res.ok) return res;
  return { ok: true, data: res.data.payments ?? [] };
}

/** One payout, with the parcels it settled. */
export async function getPayment(
  creds: SteadfastCredentials,
  paymentId: string,
): Promise<SteadfastResult<SteadfastPayment & { consignments: SteadfastPaymentConsignment[] }>> {
  const res = await request<{
    payment?: SteadfastPayment & { consignments?: SteadfastPaymentConsignment[] };
  }>(creds, `/payments/${encodeURIComponent(paymentId)}`, { method: "GET", okStatus: [1, 200] });
  if (!res.ok) return res;
  if (!res.data.payment) return { ok: false, error: `Steadfast returned no payment ${paymentId}` };
  return { ok: true, data: { ...res.data.payment, consignments: res.data.payment.consignments ?? [] } };
}
