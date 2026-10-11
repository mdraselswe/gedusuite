// Signs in the demo user in a real browser and reports exactly what happens.
//   node scripts/demo/login-check.mjs [baseUrl]
import { chromium } from "@playwright/test";
const BASE = process.argv[2] ?? "http://localhost:3000";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.on("console", (m) => m.type() === "error" && console.log("console.error:", m.text().slice(0, 300)));
p.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 300)));
p.on("response", (r) => {
  const u = r.url();
  if (u.includes("/api/auth/") || r.status() >= 400) console.log(r.status(), r.request().method(), u.replace(BASE, ""));
});
for (const attempt of [1, 2]) {
  console.log(`--- attempt ${attempt}`);
  await p.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 240000 });
  await p.waitForTimeout(1500);
  await p.fill('input[name="email"]', "demo@gedusuite.test");
  await p.fill('input[name="password"]', "Demo#2026");
  await p.click('button[type="submit"]');
  await p.waitForTimeout(12000);
  console.log("url:", p.url().replace(BASE, ""));
  console.log("title/h1:", await p.title(), "|", (await p.locator("h1,h2").first().textContent().catch(() => "?"))?.slice(0, 80));
  const toast = await p.locator("[data-sonner-toast]").first().textContent().catch(() => null);
  if (toast) console.log("toast:", toast);
  await p.screenshot({ path: `demo-assets/login-attempt-${attempt}.png` });
  if (!p.url().includes("/login")) break;
}
await b.close();
