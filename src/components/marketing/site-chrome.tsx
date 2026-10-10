import Link from "next/link";

const LINKS = [
  { href: "/#how", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
];

export function SiteHeader({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <header className="border-b border-ink/10">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
        <Link href="/" className="font-display text-xl font-bold tracking-tight text-ink">
          GeduSuite
        </Link>
        <nav className="flex items-center gap-1 text-sm sm:gap-4">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="hidden rounded px-2 py-1 text-ink/75 hover:text-ink sm:inline"
            >
              {l.label}
            </Link>
          ))}
          {signedIn ? (
            <Link
              href="/"
              className="rounded-md bg-ink px-3.5 py-2 font-medium text-paper hover:bg-ink/90"
            >
              Open my workspaces
            </Link>
          ) : (
            <>
              <Link href="/login" className="rounded px-2 py-1 text-ink/75 hover:text-ink">
                Sign in
              </Link>
              <Link
                href="/register"
                className="rounded-md bg-ink px-3.5 py-2 font-medium text-paper hover:bg-ink/90"
              >
                Start free trial
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const email = process.env.BILLING_SUPPORT_EMAIL;
  const phone = process.env.BILLING_SUPPORT_PHONE;
  return (
    <footer className="border-t border-ink/10 bg-paper">
      <div className="mx-auto flex max-w-6xl flex-wrap items-start justify-between gap-8 px-5 py-10 text-sm text-ink/70">
        <div className="max-w-xs space-y-2">
          <div className="font-display text-lg font-bold text-ink">GeduSuite</div>
          <p>
            Stock, orders, courier cash and partner profit for small online shops — in one book
            that agrees with itself.
          </p>
        </div>
        <ul className="space-y-1.5">
          <li>
            <Link href="/pricing" className="hover:text-ink">
              Pricing
            </Link>
          </li>
          <li>
            <Link href="/login" className="hover:text-ink">
              Sign in
            </Link>
          </li>
          <li>
            <Link href="/register" className="hover:text-ink">
              Create an account
            </Link>
          </li>
        </ul>
        <ul className="space-y-1.5">
          <li>
            <Link href="/terms" className="hover:text-ink">
              Terms of service
            </Link>
          </li>
          <li>
            <Link href="/privacy" className="hover:text-ink">
              Privacy policy
            </Link>
          </li>
          <li>
            <Link href="/refund" className="hover:text-ink">
              Refund policy
            </Link>
          </li>
        </ul>
        {email || phone ? (
          <ul className="space-y-1.5">
            {email ? <li>{email}</li> : null}
            {phone ? <li>{phone}</li> : null}
          </ul>
        ) : null}
      </div>
    </footer>
  );
}
