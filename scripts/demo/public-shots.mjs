// Screenshots of the signed-out pages (landing, pricing, sign-in, sign-up).
//   node scripts/demo/public-shots.mjs [baseUrl] [outDir]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.argv[3] ?? "demo-assets/shots";
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
for (const [label, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  const p = await b.newPage({ viewport });
  for (const [n, u] of [
    ["landing", "/"],
    ["pricing", "/pricing"],
    ["login", "/login"],
    ["register", "/register"],
    ["terms", "/terms"],
  ]) {
    await p.goto(BASE + u, { waitUntil: "networkidle" });
    await p.waitForTimeout(600);
    await p.screenshot({
      path: join(OUT, `public-${n}-${label}.png`),
      fullPage: n === "landing" || n === "pricing",
    });
  }
  await p.close();
}
await b.close();
console.log("done");
