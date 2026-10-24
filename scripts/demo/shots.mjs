// Walks every screen of the demo workspace in a real browser, saves a
// screenshot of each (desktop and phone) and reports anything that looks
// broken: a server error, a page that fails to load, a console error.
//
//   node scripts/demo/shots.mjs [baseUrl] [outDir]
//
// Needs the local app running (yarn local:dev) and the demo seeded
// (yarn demo:seed). Talks to localhost only.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.argv[3] ?? "demo-assets/shots";
// Defaults walk the demo shop; the env can point it at another local workspace.
const SLUG = process.env.SHOTS_SLUG ?? "little-nest";
const EMAIL = process.env.SHOTS_EMAIL ?? "demo@gedusuite.test";
const PASSWORD = process.env.SHOTS_PASSWORD ?? "Demo#2026";

if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE)) {
  throw new Error(`Refusing to run against ${BASE}: the demo login only exists locally.`);
}

const PAGES = [
  ["dashboard", "dashboard"],
  ["products", "products"],
  ["purchases", "purchases"],
  ["orders", "sales/orders"],
  ["call-list", "leads"],
  ["couriers", "couriers"],
  ["customers", "customers"],
  ["follow-ups", "customers/follow-ups"],
  ["partners", "partners"],
  ["treasury", "treasury"],
  ["boosting", "boosting"],
  ["spending", "expenses"],
  ["internal-purchases", "internal-purchases"],
  ["reports", "reports"],
  ["activity", "activity"],
  ["notifications", "notifications"],
  ["team", "settings/team"],
  ["backup", "settings/backup"],
  ["appearance", "settings/appearance"],
  ["website", "settings/website"],
  ["billing", "settings/billing"],
  ["help", "help"],
];

const problems = [];
const browser = await chromium.launch();

async function session(viewport, label) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180_000);
  let current = "(login)";
  page.on("pageerror", (e) => problems.push(`${label} ${current}: page error — ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Failed to load resource.*(404|401)/.test(m.text())) {
      problems.push(`${label} ${current}: console error — ${m.text().slice(0, 200)}`);
    }
  });
  page.on("response", (r) => {
    if (r.status() >= 500) problems.push(`${label} ${current}: HTTP ${r.status()} ${r.url()}`);
  });

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  // The form is a React handler; filling it before hydration submits natively.
  await page.waitForTimeout(1500);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120_000 }),
    page.click('button[type="submit"]'),
  ]);
  return { page, ctx, setCurrent: (c) => (current = c) };
}

for (const [label, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  const dir = join(OUT, label);
  mkdirSync(dir, { recursive: true });
  const { page, ctx, setCurrent } = await session(viewport, label);
  for (const [name, path] of PAGES) {
    setCurrent(name);
    const t0 = Date.now();
    try {
      const res = await page.goto(`${BASE}/${SLUG}/${path}`, { waitUntil: "networkidle" });
      if (!res || res.status() >= 400) problems.push(`${label} ${name}: HTTP ${res?.status()}`);
      // Let entrance animations finish so the capture is what a person sees.
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
      console.log(`${label.padEnd(7)} ${name.padEnd(20)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      problems.push(`${label} ${name}: ${String(e).slice(0, 200)}`);
    }
  }
  await ctx.close();
}
await browser.close();

console.log("\n" + (problems.length ? `${problems.length} problem(s):\n` + problems.join("\n") : "No problems found."));
process.exitCode = problems.length ? 1 : 0;
