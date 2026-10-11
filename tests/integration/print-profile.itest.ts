import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "@/lib/prisma";
import { updatePrintProfile } from "@/server/actions/print-profile";
import { parsePrintProfile } from "@/lib/print-profile";
import { actAs, addMember, createUser, createWorkspaceWithOwner, fd, resetDatabase } from "./harness";

let ownerA = "";
let managerA = "";
let wsA = "";

beforeAll(async () => {
  await resetDatabase();
  const o = await createUser("owner@pp.test", "Owner");
  const m = await createUser("mgr@pp.test", "Manager");
  const ws = await createWorkspaceWithOwner("Nila Fashion", "nila", o.id);
  await addMember(ws.id, m.id, "MANAGER");
  ownerA = o.id;
  managerA = m.id;
  wsA = ws.id;
});

describe("printed extras are the workspace's own", () => {
  it("only the owner can change them, and they persist per workspace", async () => {
    await actAs(managerA);
    expect((await updatePrintProfile("nila", fd({ facebook: "x", tagline: "y" }))).ok).toBe(false);

    await actAs(ownerA);
    const res = await updatePrintProfile(
      "nila",
      fd({ facebook: "nila.bd", whatsapp: "01811111111", tagline: "Everyday style", giftQuote: "" }),
    );
    expect(res.ok).toBe(true);
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: wsA } });
    const p = parsePrintProfile(row.printProfile);
    expect(p.facebook).toBe("nila.bd");
    expect(p.giftQuote).toBe(""); // cleared on purpose, stays cleared
  });

  it("the data migration gives the founding shop its old wording, and nobody else", async () => {
    const sql = readFileSync(
      resolve(process.cwd(), "prisma/migrations/20261014000000_print_profile/migration.sql"),
      "utf8",
    );
    const update = sql.slice(sql.indexOf('UPDATE "Workspace"'));

    const founding = await prisma.workspace.create({
      data: { name: "Founding", slug: "founding", websiteUrl: "gedushop.com" },
    });
    const other = await prisma.workspace.create({
      data: { name: "Other", slug: "other-shop", websiteUrl: "othershop.example" },
    });
    const custom = await prisma.workspace.create({
      data: {
        name: "Custom",
        slug: "custom-shop",
        websiteUrl: "gedushop.com",
        printProfile: { tagline: "mine" },
      },
    });

    await prisma.$executeRawUnsafe(update);

    const f = parsePrintProfile((await prisma.workspace.findUniqueOrThrow({ where: { id: founding.id } })).printProfile);
    expect(f.facebook).toBe("facebook.com/gedushop");
    expect(f.whatsapp).toBe("01552-958606");
    expect(f.headline).toContain("\n");

    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: other.id } })).printProfile).toBeNull();
    // a profile somebody already saved is never overwritten
    const c = parsePrintProfile((await prisma.workspace.findUniqueOrThrow({ where: { id: custom.id } })).printProfile);
    expect(c.tagline).toBe("mine");
    expect(c.facebook).toBeUndefined();
  });
});
