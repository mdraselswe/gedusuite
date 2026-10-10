import type { DefaultSession } from "next-auth";
import type { SessionMembership } from "@/lib/auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      memberships: SessionMembership[];
      locale?: string;
      /** JWT issued-at, seconds since epoch. */
      issuedAt?: number;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    memberships?: SessionMembership[];
    locale?: string;
  }
}
