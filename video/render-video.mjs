// Renders a short promo film of Window Seat from the live site, frame by frame, with the site's own
// lofi as the soundtrack. Time inside the page is controlled by Playwright's fake clock, so every
// frame is exactly 1/FPS apart no matter how slowly the machine renders (no GPU needed).
//
//   node video/render-video.mjs            → video/out/window-seat.mp4
//
// Env: SITE (default the GitHub Pages URL), W, H, FPS, SPEED (preview speed-up), WEATHER, SHOTS (JSON), MOCK=1 (offline test)
import { chromium } from "playwright";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SITE = (process.env.SITE || "https://arikhanacademic-cpu.github.io/window-seat/").replace(/\/?$/, "/");
const W = +process.env.W || 1600, H = +process.env.H || 900, FPS = +process.env.FPS || 30, SPEED = +process.env.SPEED || 3;
const WEATHER = process.env.WEATHER ?? "clear", MOCK = !!process.env.MOCK, OUT = new URL("./out/", import.meta.url).pathname;
const XF = 0.8; // crossfade between shots, seconds
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ff = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { stdio: "inherit" });

// Where each shot starts: a landmark on the route, plus a few hundred metres of run-up.
const route = MOCK ? JSON.parse(readFileSync(new URL("../public/data/glacier/route.json", import.meta.url))) : await (await fetch(SITE + "data/glacier/route.json")).json();
const kmOf = (id) => (route.stamps.find((s) => s[0] === id) || [])[3];
const SHOTS = process.env.SHOTS ? JSON.parse(process.env.SHOTS) : [
  { at: "landwasser", before: 0.9, view: "front", secs: 8, title: true },
  { at: "oberalp", before: 0.6, view: "left", yaw: -0.25, pan: 0.03, secs: 6.5 },
  { at: "ruinaulta", before: 0.4, view: "right", yaw: 0.2, pan: -0.03, secs: 6.5 },
  { at: "albula", before: 0.5, view: "left", yaw: -0.1, pitch: 0.12, secs: 6.5 },
  { at: "matterhorn", before: -1.5, view: "front", yaw: 0.35, secs: 6.5 }
];

const b = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });

async function mockRoutes(p) {
  const { terrariumTile, connections, aerialTile } = await import("../test/mock.mjs");
  const three = readFileSync(new URL("../node_modules/three/build/three.min.js", import.meta.url));
  await p.route("**/three.min.js", (r) => r.fulfill({ body: three, contentType: "text/javascript" }));
  await p.route("https://fonts.googleapis.com/**", (r) => r.abort());
  await p.route("**/leaflet.min.js", (r) => r.fulfill({ path: new URL("../node_modules/leaflet/dist/leaflet.js", import.meta.url).pathname, contentType: "text/javascript" }));
  await p.route("**/leaflet.min.css", (r) => r.fulfill({ path: new URL("../node_modules/leaflet/dist/leaflet.css", import.meta.url).pathname, contentType: "text/css" }));
  await p.route("https://wmts.geo.admin.ch/**", (r) => { const m = r.request().url().match(/3857\/(\d+)\/(\d+)\/(\d+)\.jpeg/); r.fulfill({ body: aerialTile(+m[1], +m[2], +m[3]), contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" } }); });
  await p.route("https://s3.amazonaws.com/**", (r) => { const m = r.request().url().match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/); r.fulfill({ body: terrariumTile(+m[1], +m[2], +m[3]), contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" } }); });
  await p.route("https://api.open-meteo.com/**", (r) => r.fulfill({ body: "{}", contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" } }));
  await p.route("https://transport.opendata.ch/**", (r) => r.fulfill({ body: connections(route, r.request().url()), contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" } }));
}

async function shoot(s, i) {
  const km = Math.max(0.2, (s.km ?? kmOf(s.at) ?? 50) - (s.before || 0));
  const q = new URLSearchParams({ film: "nobars", preview: SPEED, km: km.toFixed(2), view: s.view || "left", fps: FPS });
  for (const k of ["yaw", "pan", "pitch"]) if (s[k] != null) q.set(k, s[k]);
  if (WEATHER) q.set("weather", WEATHER); if (MOCK) q.set("lite", "1");
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const p = await ctx.newPage(); p.on("pageerror", (e) => console.warn("  page error:", e.message));
  if (MOCK) await mockRoutes(p);
  await p.clock.install({ time: Date.now() });
  await p.goto(SITE + "?" + q, { waitUntil: "load", timeout: 120000 });
  // Let the terrain, photos, trees and buildings load: page time creeps forward while real time passes.
  const t0 = Date.now();
  for (;;) {
    await p.clock.runFor(MOCK ? 400 : 100); await sleep(MOCK ? 100 : 400);
    const gone = await p.evaluate(() => !document.getElementById("loader"));
    if (gone && Date.now() - t0 > (MOCK ? 0 : 25000)) break;
    if (Date.now() - t0 > 240000) { console.warn("  still loading after 4 min, shooting anyway"); break; }
  }
  for (let k = 0; k < (MOCK ? 4 : 30); k++) { await p.clock.runFor(100); await sleep(MOCK ? 50 : 300); } // settle: let the camera ease in and nearby tiles finish
  if (s.title) await p.keyboard.press("t");
  const dir = `${OUT}shot${i}/`; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const n = Math.round((s.secs + (i ? XF : 0)) * FPS);
  for (let f = 0; f < n; f++) {
    await p.clock.runFor(1000 / FPS);
    await p.screenshot({ path: `${dir}${String(f).padStart(5, "0")}.jpg`, type: "jpeg", quality: 93, timeout: 180000 });
    if (f % FPS === 0) console.log(`  shot ${i + 1}/${SHOTS.length} (${s.at || s.km}): ${f}/${n} frames`);
  }
  await ctx.close();
  ff("-framerate", String(FPS), "-i", `${dir}%05d.jpg`, "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p", `${OUT}shot${i}.mp4`);
  rmSync(dir, { recursive: true, force: true });
  return n / FPS;
}

// End card, drawn as a web page in the site's own fonts.
async function endCard(secs) {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  await p.setContent(`<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=JetBrains+Mono:wght@400;500&display=swap"></head>
  <body style="margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse at 50% 40%,#2b3a4a 0%,#141319 72%);color:#f4efe6;text-align:center;font-family:'JetBrains Mono',monospace">
  <div><div style="font:500 ${Math.round(H / 75)}px 'JetBrains Mono',monospace;letter-spacing:.3em;text-transform:uppercase;color:#a59f97">A live train ride across the Swiss Alps</div>
  <div style="font:600 ${Math.round(H / 7.5)}px Fraunces,Georgia,serif;margin:${H / 60}px 0 ${H / 40}px">Window Seat</div>
  <div style="font-size:${Math.round(H / 48)}px;color:#d9d2c6">Real trains · real track · real weather, built from open data</div>
  <div style="margin-top:${H / 18}px;display:inline-block;padding:${H / 70}px ${H / 35}px;border:1px solid rgba(244,239,230,.25);border-radius:999px;font-size:${Math.round(H / 50)}px">${SITE.replace(/^https?:\/\//, "").replace(/\/$/, "")}</div>
  <div style="margin-top:${H / 22}px;font-size:${Math.round(H / 65)}px;color:#a59f97">Built by Ari Khan</div></div></body></html>`, { waitUntil: "networkidle" }).catch(() => {});
  await p.screenshot({ path: `${OUT}end.png` }); await p.close();
  ff("-loop", "1", "-framerate", String(FPS), "-t", String(secs + XF), "-i", `${OUT}end.png`, "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", `${OUT}end.mp4`);
}

const lens = [];
for (const [i, s] of SHOTS.entries()) { console.log(`Shot ${i + 1}: ${s.at || "km " + s.km}, ${s.view}`); lens.push(await shoot(s, i)); }
const END = 4.5; await endCard(END); lens.push(END + XF);
await b.close();

// Join with crossfades.
const parts = [...SHOTS.keys()].map((i) => `${OUT}shot${i}.mp4`).concat(`${OUT}end.mp4`);
let filter = "", last = "[0:v]", t = lens[0];
for (let i = 1; i < parts.length; i++) { const o = i === parts.length - 1 ? "[v]" : `[x${i}]`; filter += `${last}[${i}:v]xfade=transition=fade:duration=${XF}:offset=${(t - XF).toFixed(3)}${o};`; t += lens[i] - XF; last = o; }
const total = t;
ff(...parts.flatMap((f) => ["-i", f]), "-filter_complex", filter.replace(/;$/, ""), "-map", "[v]", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", `${OUT}picture.mp4`);

// Soundtrack: the site's lofi, rendered offline, with the ride's rumble underneath.
const node = process.execPath, here = new URL("./render-music.mjs", import.meta.url).pathname, D = Math.ceil(total + 1);
execFileSync(node, [here, String(D), `${OUT}music.wav`], { stdio: "inherit", env: process.env });
execFileSync(node, [here, String(D), `${OUT}ride.wav`, "ambience"], { stdio: "inherit", env: process.env });
ff("-i", `${OUT}picture.mp4`, "-i", `${OUT}music.wav`, "-i", `${OUT}ride.wav`,
  "-filter_complex", `[2:a]volume=0.35[r];[1:a][r]amix=inputs=2:normalize=0,alimiter=limit=0.89,loudnorm=I=-15:TP=-1.5,afade=t=in:d=1.2,afade=t=out:st=${(total - 2.5).toFixed(2)}:d=2.5[a]`,
  "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", `${OUT}window-seat.mp4`);
console.log(`Done: video/out/window-seat.mp4 (${total.toFixed(1)} s, ${W}×${H}, ${FPS} fps)`);
