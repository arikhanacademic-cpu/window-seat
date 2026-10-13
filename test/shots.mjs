// Screenshot test: serves public/ with mocked terrain, imagery and live API. Needs `npm i` and a server on :8790.
import { chromium } from "playwright";
import { terrariumTile, connections, aerialTile } from "./mock.mjs";
import { readFileSync } from "node:fs";
const route = JSON.parse(readFileSync(new URL("../public/data/glacier/route.json", import.meta.url)));
const three = readFileSync(new URL("../node_modules/three/build/three.min.js", import.meta.url));
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=swiftshader", "--ignore-gpu-blocklist"] });
const plan = JSON.parse(process.argv[2]);
for (const s of plan) {
  const ctx = await b.newContext({ viewport: { width: s.w || 1280, height: s.h || 760 } });
  const p = await ctx.newPage(); const errs = [];
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error" && !/ERR_FAILED|imagery|swissimage/.test(m.text())) errs.push(m.text()); });
  await p.route("**/three.min.js", (r) => r.fulfill({ body: three, contentType: "text/javascript" }));
  await p.route("https://fonts.googleapis.com/**", (r) => r.abort());
  await p.route("**/leaflet.min.js", (r) => r.fulfill({ path: new URL("../node_modules/leaflet/dist/leaflet.js", import.meta.url).pathname, contentType: "text/javascript" }));
  await p.route("**/leaflet.min.css", (r) => r.fulfill({ path: new URL("../node_modules/leaflet/dist/leaflet.css", import.meta.url).pathname, contentType: "text/css" }));
  await p.route("https://wmts.geo.admin.ch/**", (r) => { if (s.noImagery) return r.abort(); const m = r.request().url().match(/3857\/(\d+)\/(\d+)\/(\d+)\.jpeg/); r.fulfill({ body: aerialTile(+m[1], +m[2], +m[3]), contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" } }); });
  await p.route("https://s3.amazonaws.com/**", (r) => { const m = r.request().url().match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/); r.fulfill({ body: terrariumTile(+m[1], +m[2], +m[3]), contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" } }); });
  await p.route("https://api.open-meteo.com/**", (r) => r.fulfill({ body: JSON.stringify({ current: s.wx || { temperature_2m: 7, weather_code: 2, cloud_cover: 40, rain: 0, snowfall: 0, wind_speed_10m: 12, wind_direction_10m: 250, visibility: 30000, snow_depth: 0 } }), contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" } }));
  await p.route("https://transport.opendata.ch/**", (r) => s.apiDown ? r.abort() : r.fulfill({ body: connections(route, r.request().url()), contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" } }));
  if (s.shiftH) await p.addInitScript((h) => { const real = Date.now.bind(Date); Date.now = () => real() + h * 3600000; }, s.shiftH);
  await p.goto("http://localhost:8790/" + (s.q || ""));
  await p.waitForTimeout(s.wait || 6000);
  if (s.board) { await p.screenshot({ path: `test/${s.name}_board.png` }); await p.evaluate(() => document.querySelector(".trip")?.click()); await p.waitForTimeout(s.after || 12000); }
  for (const a of s.actions || []) { if (a.dragUp) { await p.mouse.move(400, 300); await p.mouse.down(); await p.mouse.move(400, 300 + a.dragUp, { steps: 5 }); await p.mouse.up(); } if (a.click) await p.evaluate((sel) => document.querySelector(sel)?.click(), a.click); if (a.wait) await p.waitForTimeout(a.wait); }
  await p.screenshot({ path: `test/${s.name}.png`, timeout: 120000 });
  console.log(s.name, errs.join(" | "));
  await ctx.close();
}
await b.close();
