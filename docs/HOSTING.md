# Hosting & Domains

Where GeduSuite runs, why it runs there, and what has to move together when
the address changes.

## Where it runs

| Piece | Runs on | Notes |
|---|---|---|
| The app | Vercel (project `gedusuite`, Hobby plan) | Deploys on every push to `main` |
| Database | Neon Postgres | Reached over `DATABASE_URL` / `DIRECT_URL` |
| Migrations | `scripts/vercel-build.mjs` | `prisma migrate deploy` runs before the build |
| Nightly backups | `vercel.json` crons | `/api/cron/backup` 02:00, `/api/cron/personal-backup` 03:00 UTC |
| Addresses | `app.gedushop.com` (primary), `gedusuite.vercel.app` (fallback) | Both point at the same production deployment |

The shop itself is separate and stays separate: `gedushop.com` is a Cloudflare
Pages site, `wp.gedushop.com` is WooCommerce on shared hosting. GeduSuite
shares a domain with them and nothing else.

## Why not move it onto the shop's hosting

The obvious-looking saving — "we already pay for hosting, put the admin app
there too" — is the one thing to avoid.

- It is a Next.js SSR app with server actions, Prisma, and scheduled jobs.
  Shared cPanel hosting serves PHP; Node apps live there under Passenger,
  without deploy-on-push, without migrations, and without the cron guarantees.
- It would put the admin app on the same CPU and RAM as the shop. On a busy
  sales day the two would compete, and the shop is the one that must never
  slow down.

The domain is shared through **one DNS record**. No request for
`app.gedushop.com` ever reaches the shop's server.

## Why `app.gedushop.com` exists at all

`gedusuite.vercel.app` intermittently failed to load from Bangladesh —
`ERR_CONNECTION_TIMED_OUT`, minutes at a time, then fine again.

It was not a Vercel limit. Exhausting a Vercel plan produces an HTTP response
(429, or a "deployment paused" page), never a TCP timeout. Measured while it
was working: DNS resolved identically on the ISP resolver, 1.1.1.1 and 8.8.8.8;
TCP 443 connected to every Vercel IP returned; ten HTTPS requests came back
200 in ~370 ms.

That leaves the network path. BD ISPs periodically filter on the TLS SNI
hostname, and `vercel.app` gets caught by blanket blocks aimed at the phishing
sites that live on other people's `*.vercel.app` subdomains. A domain of our
own carries a different SNI, so it is not in anyone's block list.

If `app.gedushop.com` ever times out the same way, the block is on the IPs
rather than the name: turn the Cloudflare proxy **on** (orange cloud) for the
`app` record, so traffic arrives over Cloudflare's edge instead. Do that only
*after* Vercel has issued the certificate — with the proxy on from the start,
Vercel's validation cannot complete. Cloudflare SSL mode must be Full (strict).

## The DNS record

Vercel is the source of truth for what the record should be — the project's
Settings → Domains page prints it, and Vercel has changed its recommended
targets before. As set up:

```
Type    CNAME
Name    app
Value   8ec255bfeafd9fc5.vercel-dns-017.com
Proxy   DNS only (grey cloud)
TTL     Auto
```

It goes in the **Cloudflare zone for gedushop.com** — a DNS record, *not* a
cPanel subdomain. A cPanel subdomain would create a document root on the
shop's server and point the name at it, which is the opposite of what this is
for.

## What has to change together with the domain

The address is not only DNS. Four things read it, and a half-finished move
locks everyone out of the app:

1. **`NEXTAUTH_URL`** (Vercel → Settings → Environment Variables, Production).
   NextAuth builds its callback URLs from it, and `src/lib/google-personal.ts`
   builds the Drive OAuth `redirect_uri` from it too. Change it only once the
   new domain actually serves the app, then redeploy — pointing it at a domain
   that is not live yet breaks sign-in on the old one as well.

   It names one address, and that address is `app.gedushop.com`. The
   consequence is worth knowing: signing in at `gedusuite.vercel.app` sends
   the browser to the primary domain to finish, so the fallback is a fallback
   for *reading* a page, not for logging in while the primary is unreachable.
2. **Google OAuth authorised redirect URIs** (Google Cloud Console → the OAuth
   client used by `GOOGLE_CLIENT_ID`). Both are needed:
   - `https://app.gedushop.com/api/auth/callback/google` — sign-in
   - `https://app.gedushop.com/api/google/personal/callback` — personal backup

   As of August 2026 the only OAuth client in the `geduShop` Google Cloud
   project lists exactly one redirect URI — `https://gedushop.com/wp-login.php
   ?loginSocial=google`, WordPress's social login. Nothing for GeduSuite at
   any address. So either the app's Google sign-in and Drive backup have never
   worked, or `GOOGLE_CLIENT_ID` points at a client in some other Google
   account. Worth settling before anyone relies on either feature; the domain
   move does not make it worse.
3. **The WooCommerce webhook** (WP admin → WooCommerce → Settings → Advanced →
   Webhooks), if its delivery URL names the old host. It posts new orders to
   `/api/cron/woo-lead`, which is what fills the call list.
4. **Anything bookmarked or installed.** The PWA remembers the origin it was
   installed from; re-install from the new address to get it pointing there.

## Vercel plan

The project is on Hobby, which is officially non-commercial. GeduSuite is an
internal business tool, so a strict reading puts it on Pro ($20/mo). Custom
domains work on Hobby and nothing is currently blocked — this is recorded so
the answer is known if Vercel ever asks, not because anything needs doing.
