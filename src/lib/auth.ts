import type { NextAuthOptions } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
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
      async authorize(credentials) {
        if (!credentials?.email || !credentials.password) return null;
        const user = await prisma.user.findUnique({
          where: { email: credentials.email.toLowerCase() },
        });
        if (!user?.passwordHash) return null;
        const ok = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!ok) return null;
        return { id: user.id, name: user.name, email: user.email, image: user.image };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger }) {
      // On sign-in, stamp the user id and load memberships once.
      if (user) token.uid = user.id;
      // Refresh memberships on sign-in and whenever the client calls update()
      // (e.g. right after creating a workspace or accepting an invite).
      if (user || trigger === "update") {
        if (token.uid) token.memberships = await loadMemberships(token.uid as string);
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.uid as string) ?? "";
        session.user.memberships =
          (token.memberships as SessionMembership[] | undefined) ?? [];
      }
      return session;
    },
  },
};
