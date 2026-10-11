import type { NextAuthOptions } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { clientIp, rateLimit, resetRateLimit } from "@/lib/rate-limit";
import type { Role } from "@prisma/client";

export type SessionMembership = {
  workspaceId: string;
  slug: string;
  role: Role;
};

/** Load a user's workspace memberships in the compact shape stored on the JWT. */
async function loadMemberships(userId: string): Promise<SessionMembership[]> {
  const rows = await prisma.membership.findMany({
    where: { userId },
    select: { workspaceId: true, role: true, workspace: { select: { slug: true } } },
  });
  return rows.map((m) => ({
    workspaceId: m.workspaceId,
    slug: m.workspace.slug,
    role: m.role,
  }));
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      allowDangerousEmailAccountLinking: true,
    }),
    CredentialsProvider({
      name: "Email & Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials.password) return null;
        const email = credentials.email.toLowerCase();

        // Throttle guessing. Per account (so a botnet can't walk one password
        // list through many addresses' worth of IPs) and per client. A correct
        // password clears the account counter, so honest typos never add up.
        const emailKey = `login:email:${email}`;
        const ipKey = `login:ip:${clientIp(req?.headers as Record<string, string | string[] | undefined> | undefined)}`;
        // Not in `next dev`: the first sign-in there takes ~20s while the route
        // compiles, people click again, and the counter then locks the demo
        // login out of a machine nobody is attacking. Tests run as "test" and
        // production as "production", so the throttle is exercised in both.
        if (process.env.NODE_ENV !== "development") {
          const [byEmail, byIp] = await Promise.all([
            rateLimit(emailKey, 10, 15 * 60),
            rateLimit(ipKey, 60, 15 * 60),
          ]);
          if (!byEmail.allowed || !byIp.allowed) return null;
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.passwordHash) return null;
        const ok = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!ok) return null;
        await resetRateLimit(emailKey);
        return { id: user.id, name: user.name, email: user.email, image: user.image };
      },
    }),
  ],
  callbacks: {
    /**
     * Google sign-in may attach to an existing account with the same email
     * (allowDangerousEmailAccountLinking above). That is only safe when the
     * existing account's owner has proved the address. If it is still
     * unverified, whoever created it with a password never owned the inbox —
     * they could have pre-registered a victim's address to be linked into
     * their account later. Google has just proved the real owner, so that
     * password is removed and the address marked verified.
     */
    async signIn({ account, profile }) {
      if (account?.provider !== "google") return true;
      const p = profile as { email?: string; email_verified?: boolean } | undefined;
      if (!p?.email || p.email_verified === false) return false;
      const email = p.email.toLowerCase();
      const existing = await prisma.user.findUnique({
        where: { email },
        select: { id: true, emailVerified: true, passwordHash: true },
      });
      if (existing && !existing.emailVerified) {
        await prisma.user.update({
          where: { id: existing.id },
          data: { passwordHash: null, emailVerified: new Date(), sessionsValidAfter: new Date() },
        });
      }
      return true;
    },
    async jwt({ token, user, trigger }) {
      // On sign-in, stamp the user id and load memberships once.
      if (user) token.uid = user.id;
      // Refresh memberships on sign-in and whenever the client calls update()
      // (e.g. right after creating a workspace or accepting an invite).
      if (user || trigger === "update") {
        if (token.uid) {
          token.memberships = await loadMemberships(token.uid as string);
          const u = await prisma.user.findUnique({
            where: { id: token.uid as string },
            select: { locale: true },
          });
          token.locale = u?.locale ?? "en";
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.uid as string) ?? "";
        session.user.memberships =
          (token.memberships as SessionMembership[] | undefined) ?? [];
        session.user.locale = (token.locale as string) ?? "en";
        // When this cookie was issued; compared with User.sessionsValidAfter.
        session.user.issuedAt = typeof token.iat === "number" ? token.iat : undefined;
      }
      return session;
    },
  },
};
