// Screenshots of the printable extras (gift tags, leaflet) for the demo shop.
//   node scripts/demo/print-shots.mjs [baseUrl] [outDir]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.argv[3] ?? "demo-assets/shots";
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 1100 } });
await p.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
await p.fill('input[name="email"]', "demo@gedusuite.test");
await p.fill('input[name="password"]', "Demo#2026");
await Promise.all([p.waitForURL((u) => !u.pathname.startsWith("/login")), p.click('button[type="submit"]')]);
for (const [n, path] of [["gift-tags", "sales/gift-tags"], ["leaflet", "sales/leaflet"]]) {
  await p.goto(`${BASE}/little-nest/${path}`, { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: join(OUT, `print-${n}.png`) });
}
await b.close();
console.log("done");
