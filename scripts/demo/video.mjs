// Records a guided walkthrough of the product as a video, using the demo
// workspace. Plain captions at the bottom say what is being shown.
//
//   node scripts/demo/video.mjs [baseUrl] [outDir]
//
// Needs the app running locally and the demo seeded. Output: .webm files in
// outDir (desktop walkthrough, phone clip).
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.argv[3] ?? "demo-assets/video";
const SLUG = "little-nest";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE)) {
  throw new Error("Refusing to record against a non-local address.");
}
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function caption(page, text) {
  await page.evaluate((t) => {
    let el = document.getElementById("__cap");
    if (!el) {
      el = document.createElement("div");
      el.id = "__cap";
      el.style.cssText =
        "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;" +
        "background:rgba(15,31,51,.94);color:#fff;font:500 20px/1.35 Inter,system-ui,sans-serif;" +
        "padding:12px 22px;border-radius:8px;max-width:78vw;text-align:center;" +
        "box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:none;transition:opacity .25s";
      document.body.appendChild(el);
    }
    el.textContent = t;
    el.style.opacity = t ? "1" : "0";
  }, text);
}

async function glide(page, to, ms = 2400) {
  await page.evaluate(
    ([y, d]) =>
      new Promise((res) => {
        const start = window.scrollY;
        const t0 = performance.now();
        const step = (now) => {
          const k = Math.min(1, (now - t0) / d);
          const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          window.scrollTo(0, start + (y - start) * e);
          k < 1 ? requestAnimationFrame(step) : res();
        };
        requestAnimationFrame(step);
      }),
    [to, ms],
  );
}

async function scene(page, path, text, { scrollTo = 0, hold = 3500 } = {}) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await sleep(900);
  await caption(page, text);
  await sleep(hold);
  if (scrollTo) {
    await glide(page, scrollTo, 2600);
    await sleep(1800);
  }
}

const browser = await chromium.launch();

// ── Desktop walkthrough ──────────────────────────────────────────────
{
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  await scene(page, "/", "GeduSuite — stock, courier cash and partner profit in one book", {
    hold: 4500,
    scrollTo: 1500,
  });
  await caption(page, "Every figure is worked out in one place, so every screen agrees");
  await sleep(3000);
  await glide(page, 2900, 2800);
  await caption(page, "Simple plans, a free trial, pay by bKash or Nagad");
  await sleep(3500);

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await sleep(1200);
  await caption(page, "Sign in");
  await page.fill('input[name="email"]', "demo@gedusuite.test");
  await sleep(500);
  await page.fill('input[name="password"]', "Demo#2026");
  await sleep(700);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login")),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState("networkidle");

  await scene(page, `/${SLUG}/dashboard`, "The day at a glance: sales, profit, stock, cash and what needs attention", {
    scrollTo: 700,
    hold: 4500,
  });
  await scene(page, `/${SLUG}/sales/orders`, "Orders: status, payment, courier and what each parcel earned", {
    hold: 3500,
    scrollTo: 420,
  });
  await scene(page, `/${SLUG}/products`, "Products and variants, with stock and cost kept honest", { hold: 3500 });
  await scene(page, `/${SLUG}/purchases`, "Purchases: who paid, from the treasury or a partner's pocket", { hold: 3500 });
  await scene(page, `/${SLUG}/couriers`, "Courier rate cards: delivery cost and cash-on-delivery fee, worked out for you", { hold: 3800 });
  await scene(page, `/${SLUG}/leads`, "Website orders land in a call list, ready to phone", { hold: 3500 });
  await scene(page, `/${SLUG}/treasury`, "The treasury: every taka in, every taka out", { hold: 3800, scrollTo: 500 });
  await scene(page, `/${SLUG}/partners`, "Partners: capital, expenses, withdrawals and profit share", {
    hold: 4200,
    scrollTo: 900,
  });
  await scene(page, `/${SLUG}/boosting`, "Ads: see profit after the spend, not just sales", { hold: 3800 });
  await scene(page, `/${SLUG}/reports`, "Reports: order profit to net profit, by product, source and district", {
    hold: 4200,
    scrollTo: 800,
  });
  await scene(page, `/${SLUG}/settings/team`, "Roles and permissions: give each person only what they need", { hold: 3500 });
  await scene(page, `/${SLUG}/settings/billing`, "Plan and billing: usage, limits and simple manual payment", { hold: 3800 });
  await caption(page, "GeduSuite — start your free trial");
  await sleep(2500);

  const vid = page.video();
  await ctx.close();
  const path = await vid.path();
  renameSync(path, join(OUT, "gedusuite-preview-desktop.webm"));
}

// ── Phone clip ───────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    recordVideo: { dir: OUT, size: { width: 390, height: 844 } },
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await sleep(1200);
  await page.fill('input[name="email"]', "demo@gedusuite.test");
  await page.fill('input[name="password"]', "Demo#2026");
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login")),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState("networkidle");
  await scene(page, `/${SLUG}/dashboard`, "On your phone", { hold: 2500, scrollTo: 900 });
  await scene(page, `/${SLUG}/sales/orders`, "Take and track orders anywhere", { hold: 2500, scrollTo: 500 });
  await scene(page, `/${SLUG}/treasury`, "Know your cash", { hold: 2500 });
  const vid = page.video();
  await ctx.close();
  renameSync(await vid.path(), join(OUT, "gedusuite-preview-phone.webm"));
}

await browser.close();
console.log(readdirSync(OUT).join("\n"));
