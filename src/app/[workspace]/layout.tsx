import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMembership } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/rbac";
import { SignOutButton } from "@/components/sign-out-button";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const { membership } = await requireMembership(slug);

  const workspace = await prisma.workspace.findUnique({
    where: { slug },
    select: { name: true },
  });
  if (!workspace) notFound();

  const role = membership.role;
  const nav = [
    { href: `/${slug}/dashboard`, label: "Dashboard", show: true },
    { href: `/${slug}/products`, label: "Products", show: can(role, "products", "view") },
    { href: `/${slug}/purchases`, label: "Purchases", show: can(role, "purchases", "view") },
    { href: `/${slug}/sales/orders`, label: "Sales", show: can(role, "sales", "view") },
    { href: `/${slug}/customers`, label: "Customers", show: can(role, "customers", "view") },
    { href: `/${slug}/treasury`, label: "Treasury", show: can(role, "treasury", "view") },
    { href: `/${slug}/settings/team`, label: "Team", show: can(role, "team", "view") },
  ].filter((n) => n.show);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-6">
          <Link href={`/${slug}/dashboard`} className="font-bold">
            {workspace.name}
          </Link>
          <nav className="hidden gap-4 text-sm text-muted-foreground sm:flex">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className="hover:text-foreground">
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-muted-foreground">
            {membership.role}
          </span>
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
