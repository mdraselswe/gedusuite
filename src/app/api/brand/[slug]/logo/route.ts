import { prisma } from "@/lib/prisma";

/**
 * The shop's logo as a plain image, for places that can only fetch a URL —
 * the reseller Google Sheet's =IMAGE(). The logo is stored as a data URL and
 * is printed on everything the shop sends out, so it is public.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ws = await prisma.workspace.findUnique({ where: { slug }, select: { logoUrl: true } });
  const m = ws?.logoUrl?.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!m) return new Response("Not found", { status: 404 });
  // SVG can carry script; only raster images go out.
  if (/svg/i.test(m[1])) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(m[2], "base64"), {
    headers: {
      "Content-Type": m[1],
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
