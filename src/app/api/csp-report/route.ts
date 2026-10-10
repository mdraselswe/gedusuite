import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Receives Content-Security-Policy violation reports. The policy is shipped in
 * report-only mode first: it tells us what an enforced policy WOULD break
 * (fonts, Google sign-in, images) without breaking any of it.
 */
export async function POST(req: NextRequest) {
  const text = await req.text();
  console.warn("[csp-report]", text.slice(0, 1500));
  return new NextResponse(null, { status: 204 });
}
