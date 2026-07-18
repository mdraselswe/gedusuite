import type { DefaultSession } from "next-auth";
import type { SessionMembership } from "@/lib/auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      memberships: SessionMembership[];
      locale?: string;
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
