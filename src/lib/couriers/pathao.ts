import type {
  BookedParcel,
  CourierProvider,
  ParcelRequest,
  ParcelStatus,
  ProviderResult,
} from "@/lib/couriers/provider";

/**
 * Pathao Courier (Merchant "Aladdin" API) client.
 *
 * WRITTEN FROM THE PUBLISHED API DOCUMENTATION AND NOT YET RUN AGAINST A LIVE
 * OR SANDBOX ACCOUNT — there were no credentials to test with. The request and
 * response shapes below are covered by tests against mocked responses, which
 * proves this code does what its author believes the API does, not that the
 * API does it. Before this is connected to booking, run it once against
 * Pathao's sandbox and compare a booked parcel's fee and cash-on-delivery with
 * what the app computes for the same order.
 *
 * Auth is OAuth2 password grant; the access token is short-lived and is
 * fetched per instance (cached in memory for its lifetime).
 */
export type PathaoCredentials = {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  storeId: number;
  /** Sandbox is a different host with its own credentials. */
  sandbox?: boolean;
};

const HOSTS = {
  live: "https://api-hermes.pathao.com",
  sandbox: "https://courier-api-sandbox.pathao.com",
};

/** Pathao's own status strings, as documented, mapped to ours. */
export function mapPathaoStatus(raw: string): ParcelStatus["state"] {
  const s = raw.toLowerCase();
  if (s.includes("delivered") && !s.includes("partial")) return "delivered";
  if (s.includes("return") || s.includes("partial")) return "returned";
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("hold") || s.includes("pending_payment")) return "on_hold";
  if (
    s.includes("pickup") ||
    s.includes("picked") ||
    s.includes("transit") ||
    s.includes("sorting") ||
    s.includes("assigned") ||
    s.includes("out_for_delivery") ||
    s.includes("at_the_sorting_hub")
  ) {
    return "in_transit";
  }
  if (s.includes("pending") || s.includes("created") || s.includes("requested")) return "pending";
  return "unknown";
}

type Fetch = typeof fetch;

export class PathaoProvider implements CourierProvider {
  readonly key = "pathao";
  readonly label = "Pathao";
  private token: { value: string; until: number } | null = null;

  constructor(
    private readonly creds: PathaoCredentials,
    private readonly http: Fetch = fetch,
  ) {}

  private get base() {
    return this.creds.sandbox ? HOSTS.sandbox : HOSTS.live;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 60_000) return this.token.value;
    const res = await this.http(`${this.base}/aladdin/api/v1/issue-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        username: this.creds.username,
        password: this.creds.password,
        grant_type: "password",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Pathao sign-in failed (${res.status})`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("Pathao sign-in returned no token");
    this.token = {
      value: json.access_token,
      until: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return json.access_token;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.accessToken();
    const res = await this.http(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(25_000),
    });
    const body = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) {
      throw new Error(body?.message ? `Pathao: ${body.message}` : `Pathao answered ${res.status}`);
    }
    return body;
  }

  async book(req: ParcelRequest): Promise<ProviderResult<BookedParcel>> {
    try {
      const res = await this.call<{
        data?: { consignment_id?: string; delivery_fee?: number };
      }>("/aladdin/api/v1/orders", {
        method: "POST",
        body: JSON.stringify({
          store_id: this.creds.storeId,
          merchant_order_id: req.reference,
          recipient_name: req.recipientName,
          recipient_phone: req.recipientPhone,
          recipient_address: req.recipientAddress,
          // 48 = normal delivery, 12 = on-demand; item_type 2 = parcel.
          delivery_type: 48,
          item_type: 2,
          item_quantity: req.itemCount,
          item_weight: Math.max(0.5, req.weightKg),
          amount_to_collect: Math.round(req.cashToCollect),
          item_description: req.description,
          special_instruction: req.note,
        }),
      });
      const id = res.data?.consignment_id;
      if (!id) return { ok: false, error: "Pathao did not return a consignment id" };
      return {
        ok: true,
        data: { consignmentId: id, deliveryFee: res.data?.delivery_fee },
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Pathao booking failed" };
    }
  }

  async status(consignmentId: string): Promise<ProviderResult<ParcelStatus>> {
    try {
      const res = await this.call<{ data?: { order_status?: string } }>(
        `/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}/info`,
      );
      const raw = res.data?.order_status;
      if (!raw) return { ok: false, error: "Pathao did not return a status" };
      return { ok: true, data: { raw, state: mapPathaoStatus(raw) } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Pathao status failed" };
    }
  }
}
