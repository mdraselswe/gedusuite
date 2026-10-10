import { describe, expect, it, vi } from "vitest";
import { PathaoProvider, mapPathaoStatus } from "@/lib/couriers/pathao";

const creds = {
  clientId: "cid",
  clientSecret: "csecret",
  username: "shop@example.com",
  password: "pw",
  storeId: 77,
  sandbox: true,
};

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Pathao client (against mocked responses)", () => {
  it("signs in once, then books a parcel with the documented fields", async () => {
    const calls: { url: string; body: unknown; auth?: string }[] = [];
    const http = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({
        url: u,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      if (u.endsWith("/issue-token")) return jsonRes({ access_token: "tok-1", expires_in: 3600 });
      return jsonRes({ data: { consignment_id: "DL12345", delivery_fee: 85 } });
    }) as unknown as typeof fetch;

    const p = new PathaoProvider(creds, http);
    const r1 = await p.book({
      reference: "GS-1042",
      recipientName: "Nusrat Jahan",
      recipientPhone: "01712345678",
      recipientAddress: "House 5, Road 2, Mirpur-10, Dhaka",
      cashToCollect: 1430.4,
      weightKg: 0.2,
      itemCount: 2,
      description: "Baby lotion, bottle",
    });
    expect(r1).toEqual({ ok: true, data: { consignmentId: "DL12345", deliveryFee: 85 } });

    await p.book({
      reference: "GS-1043",
      recipientName: "A",
      recipientPhone: "01712345679",
      recipientAddress: "Somewhere",
      cashToCollect: 0,
      weightKg: 1,
      itemCount: 1,
    });

    // one sign-in for two bookings
    expect(calls.filter((c) => c.url.endsWith("/issue-token"))).toHaveLength(1);
    const order = calls.find((c) => c.url.endsWith("/aladdin/api/v1/orders"))!;
    expect(order.url.startsWith("https://courier-api-sandbox.pathao.com")).toBe(true);
    expect(order.auth).toBe("Bearer tok-1");
    expect(order.body).toMatchObject({
      store_id: 77,
      merchant_order_id: "GS-1042",
      amount_to_collect: 1430, // whole taka
      item_weight: 0.5, // Pathao's minimum
      delivery_type: 48,
    });
  });

  it("reports a failed sign-in and a rejected booking as plain errors", async () => {
    const bad = vi.fn(async () => jsonRes({}, 401)) as unknown as typeof fetch;
    const r = await new PathaoProvider(creds, bad).book({
      reference: "x",
      recipientName: "a",
      recipientPhone: "01",
      recipientAddress: "b",
      cashToCollect: 0,
      weightKg: 1,
      itemCount: 1,
    });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("sign-in failed");

    const rejected = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/issue-token")
        ? jsonRes({ access_token: "t" })
        : jsonRes({ message: "Invalid recipient phone" }, 422),
    ) as unknown as typeof fetch;
    const r2 = await new PathaoProvider(creds, rejected).book({
      reference: "x",
      recipientName: "a",
      recipientPhone: "01",
      recipientAddress: "b",
      cashToCollect: 0,
      weightKg: 1,
      itemCount: 1,
    });
    expect(r2).toEqual({ ok: false, error: "Pathao: Invalid recipient phone" });
  });

  it("reads a parcel's status and maps it", async () => {
    const http = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/issue-token")
        ? jsonRes({ access_token: "t" })
        : jsonRes({ data: { order_status: "Delivered" } }),
    ) as unknown as typeof fetch;
    const r = await new PathaoProvider(creds, http).status("DL1");
    expect(r).toEqual({ ok: true, data: { raw: "Delivered", state: "delivered" } });
  });

  it("maps status strings conservatively", () => {
    expect(mapPathaoStatus("Pickup_Cancelled")).toBe("cancelled");
    expect(mapPathaoStatus("Return")).toBe("returned");
    expect(mapPathaoStatus("Partial_Delivery")).toBe("returned");
    expect(mapPathaoStatus("At_the_Sorting_HUB")).toBe("in_transit");
    expect(mapPathaoStatus("Pending")).toBe("pending");
    expect(mapPathaoStatus("Something new")).toBe("unknown");
  });
});
