// Pulls a few frames out of a recorded video, to check it by eye.
//   node scripts/demo/video-frames.mjs <video.webm> <outDir> <seconds...>
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const [file, out, ...secs] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
// A real file:// page, so the browser is allowed to open a local video.
const page = join(out, "player.html");
writeFileSync(page, `<video id=v src="${pathToFileURL(resolve(file)).href}" muted preload=auto style="width:1280px"></video>`);
await p.goto(pathToFileURL(resolve(page)).href);
await p.waitForFunction(() => document.getElementById("v").readyState >= 1);
const dur = await p.evaluate(() => document.getElementById("v").duration);
console.log("duration", dur);
for (const s of secs) {
  await p.evaluate((t) => new Promise((r) => { const v = document.getElementById("v"); v.onseeked = r; v.currentTime = t; }), Number(s));
  await p.screenshot({ path: join(out, `frame-${s}.png`) });
}
await b.close();
