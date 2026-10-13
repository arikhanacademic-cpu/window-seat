// Builds the exact railway line from Zermatt to St. Moritz, with an elevation profile.
//
//   node scripts/build-route.mjs
//
// 1. Downloads every metre-gauge railway in the corridor from OpenStreetMap (Overpass API).
// 2. Turns the tracks into a graph and finds the path through each station in config.json.
// 3. Marks tunnels and bridges, and samples the ground height from Terrarium elevation tiles.
//    Inside tunnels and on bridges the height is interpolated between the two ends,
//    so the train goes through mountains and across gorges instead of following the ground.
//
// Output: public/data/route.json      Cache: cache/osm.json, cache/terrain/*.png

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { decodePNG } from "./png.mjs";

const ROOT = new URL("../", import.meta.url);
const config = JSON.parse(await readFile(new URL("config.json", ROOT)));
const CACHE = new URL("cache/", ROOT), TERRAIN = new URL("cache/terrain/", ROOT);
await mkdir(TERRAIN, { recursive: true });
await mkdir(new URL("public/data/", ROOT), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = async (u) => { try { await access(u); return true; } catch { return false; } };

/* ---------- 1. OpenStreetMap ---------- */
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
const { south, west, north, east } = config.corridor; const B = `${south},${west},${north},${east}`;
const QUERY = `[out:json][timeout:300];
(
  way["railway"="narrow_gauge"](${B});
  way["railway"="rail"]["gauge"="1000"](${B});
  way["railway"="rail"]["operator"~"Matterhorn|Rh.tische|RhB|MGB",i](${B});
  node["railway"~"^(station|halt)$"](${B});
);
out tags geom;`;
const osmFile = new URL("osm.json", CACHE);
if (!(await exists(osmFile))) {
  console.log("Downloading railways from OpenStreetMap…");
  let text = null;
  for (let i = 0; i < 10 && !text; i++) {
    const url = OVERPASS[i % OVERPASS.length];
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "window-seat (github.com/arikhanacademic-cpu)" }, body: "data=" + encodeURIComponent(QUERY) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const t = await res.text(); const j = JSON.parse(t); if (j.remark && /error|timed out/i.test(j.remark)) throw new Error(j.remark); text = t;
    } catch (e) { const w = Math.min(120, 10 * 2 ** i); console.warn(`  ${e.message} from ${new URL(url).host}, retrying in ${w}s`); await sleep(w * 1000); }
  }
  if (!text) { console.error("Could not download railways. Run again later."); process.exit(1); }
  await writeFile(osmFile, text);
}
const osm = JSON.parse(await readFile(osmFile, "utf8"));

/* ---------- 2. graph ---------- */
const LAT0 = (south + north) / 2, MX = 111320 * Math.cos((LAT0 * Math.PI) / 180), MY = 110574;
const P = (lat, lon) => [lon * MX, lat * MY];
const nodes = []; const index = new Map(); const adj = [];
function nodeId(lat, lon) {
  const k = lat.toFixed(7) + "," + lon.toFixed(7); let id = index.get(k);
  if (id === undefined) { id = nodes.length; index.set(k, id); nodes.push([lat, lon]); adj.push([]); }
  return id;
}
const dist = (a, b) => { const [x1, y1] = P(...nodes[a]), [x2, y2] = P(...nodes[b]); return Math.hypot(x2 - x1, y2 - y1); };
const stationsOSM = [];
let nWays = 0;
for (const el of osm.elements) {
  if (el.type === "node") { if (el.tags?.name) stationsOSM.push([el.tags.name, el.lat, el.lon]); continue; }
  if (el.type !== "way" || !el.geometry) continue;
  const t = el.tags || {};
  if (!t.railway || ["abandoned", "disused", "construction", "proposed"].includes(t.railway)) continue;
  const tunnel = t.tunnel && t.tunnel !== "no" ? 1 : 0, bridge = !tunnel && t.bridge && t.bridge !== "no" ? 1 : 0;
  const name = tunnel ? t["tunnel:name"] || t.name || "" : bridge ? t["bridge:name"] || t.name || "" : "";
  const attr = { tunnel, bridge, name };
  let prev = null;
  for (const g of el.geometry) {
    const id = nodeId(g.lat, g.lon);
    if (prev !== null && prev !== id) { const d = dist(prev, id); adj[prev].push([id, d, attr]); adj[id].push([prev, d, attr]); }
    prev = id;
  }
  nWays++;
}
// close tiny gaps between ways that should touch but don't share a node
const GRID = 50; const grid = new Map();
nodes.forEach(([lat, lon], i) => { const [x, y] = P(lat, lon); const k = Math.floor(x / GRID) + "," + Math.floor(y / GRID); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
function nearby(lat, lon, r) {
  const [x, y] = P(lat, lon); const out = []; const n = Math.ceil(r / GRID);
  for (let dx = -n; dx <= n; dx++) for (let dy = -n; dy <= n; dy++) for (const i of grid.get((Math.floor(x / GRID) + dx) + "," + (Math.floor(y / GRID) + dy)) || []) out.push(i);
  return out;
}
let joined = 0;
for (let i = 0; i < nodes.length; i++) {
  if (adj[i].length !== 1) continue;
  let best = -1, bd = 25;
  for (const j of nearby(nodes[i][0], nodes[i][1], 25)) { if (j === i || adj[i].some((e) => e[0] === j)) continue; const d = dist(i, j); if (d < bd) { bd = d; best = j; } }
  if (best >= 0) { const attr = { tunnel: 0, bridge: 0, name: "" }; adj[i].push([best, bd, attr]); adj[best].push([i, bd, attr]); joined++; }
}
console.log(`${nWays} railway ways, ${nodes.length} track points, ${joined} small gaps joined`);

function nearestNode(lat, lon, r) { let best = -1, bd = r; const [x, y] = P(lat, lon); for (const i of nearby(lat, lon, r)) { const [a, b] = P(...nodes[i]); const d = Math.hypot(a - x, b - y); if (d < bd && adj[i].length) { bd = d; best = i; } } return best; }
function dijkstra(src, dst) {
  const D = new Float64Array(nodes.length).fill(Infinity), prev = new Int32Array(nodes.length).fill(-1), via = new Array(nodes.length);
  const heap = [[0, src]]; D[src] = 0;
  const push = (e) => { heap.push(e); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  while (heap.length) {
    const [d, u] = pop(); if (d > D[u]) continue; if (u === dst) break;
    for (const [v, w, attr] of adj[u]) { const nd = d + w; if (nd < D[v]) { D[v] = nd; prev[v] = u; via[v] = attr; push([nd, v]); } }
  }
  if (!Number.isFinite(D[dst])) return null;
  const path = []; for (let v = dst; v !== -1; v = prev[v]) path.push([v, via[v]]); return path.reverse();
}

/* ---------- 3. path through the stations ---------- */
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
const stops = config.stations.map(([name, lat, lon]) => {
  // prefer the OpenStreetMap station node with the same name, if it's close
  let best = null, bd = 4000;
  for (const [n, la, lo] of stationsOSM) { if (norm(n) !== norm(name)) continue; const [x1, y1] = P(lat, lon), [x2, y2] = P(la, lo); const d = Math.hypot(x2 - x1, y2 - y1); if (d < bd) { bd = d; best = [la, lo]; } }
  const [la, lo] = best || [lat, lon]; const node = nearestNode(la, lo, 1500);
  if (node < 0) { console.error(`No railway found near ${name}. Check its coordinates in config.json.`); process.exit(1); }
  return { name, node };
});
let route = []; const stationIdx = [0];
for (let i = 1; i < stops.length; i++) {
  const p = dijkstra(stops[i - 1].node, stops[i].node);
  if (!p) { console.error(`No connected track between ${stops[i - 1].name} and ${stops[i].name}.`); process.exit(1); }
  route = route.concat(i === 1 ? p : p.slice(1));
  stationIdx.push(route.length - 1);
  console.log(`  ${stops[i - 1].name} → ${stops[i].name}`);
}

/* ---------- 4. resample every 20 m ---------- */
const STEP = 20;
const pts = []; const stationKm = [];
{
  let acc = 0, next = 0, si = 0;
  for (let i = 0; i < route.length; i++) {
    while (si < stationIdx.length && stationIdx[si] === i) { stationKm.push(acc / 1000); si++; }
    if (i === route.length - 1) break;
    const a = nodes[route[i][0]], b = nodes[route[i + 1][0]], attr = route[i + 1][1] || { tunnel: 0, bridge: 0, name: "" };
    const d = dist(route[i][0], route[i + 1][0]);
    while (next <= acc + d) { const t = d ? (next - acc) / d : 0; pts.push({ lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t, tunnel: attr.tunnel, bridge: attr.bridge, name: attr.name }); next += STEP; }
    acc += d;
  }
}
const kmOf = (i) => (i * STEP) / 1000;
console.log(`Route length ${(kmOf(pts.length - 1)).toFixed(1)} km`);

function runs(flag, minLen) {
  const out = []; let s = -1;
  for (let i = 0; i <= pts.length; i++) {
    const on = i < pts.length && pts[i][flag];
    if (on && s < 0) s = i;
    if (!on && s >= 0) { if ((i - s) * STEP >= minLen) { const names = pts.slice(s, i).map((p) => p.name).filter(Boolean); out.push([s, i - 1, names[0] || ""]); } s = -1; }
  }
  // merge runs split by short gaps (e.g. a tunnel made of several OSM ways)
  for (let k = out.length - 1; k > 0; k--) if ((out[k][0] - out[k - 1][1]) * STEP < 60 && (!out[k][2] || out[k][2] === out[k - 1][2])) { out[k - 1][1] = out[k][1]; out.splice(k, 1); }
  return out;
}
const tunnels = runs("tunnel", 40), bridges = runs("bridge", 30);

/* ---------- 5. elevation ---------- */
const Z = 13;
const tileCache = new Map();
async function tile(x, y) {
  const k = `${Z}_${x}_${y}`; if (tileCache.has(k)) return tileCache.get(k);
  const f = new URL(k + ".png", TERRAIN);
  if (!(await exists(f))) {
    for (let i = 0; i < 6; i++) {
      try { const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`); if (!r.ok) throw new Error("HTTP " + r.status); await writeFile(f, Buffer.from(await r.arrayBuffer())); break; }
      catch (e) { if (i === 5) throw e; await sleep(2000 * (i + 1)); }
    }
  }
  const png = decodePNG(await readFile(f)); tileCache.set(k, png); return png;
}
async function height(lat, lon) {
  const n = 2 ** Z; const fx = ((lon + 180) / 360) * n; const s = Math.sin((lat * Math.PI) / 180); const fy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  const tx = Math.floor(fx), ty = Math.floor(fy); const t = await tile(tx, ty);
  const px = Math.min(254.999, (fx - tx) * 256 - 0.5), py = Math.min(254.999, (fy - ty) * 256 - 0.5);
  const x0 = Math.max(0, Math.floor(px)), y0 = Math.max(0, Math.floor(py)), ax = px - x0, ay = py - y0;
  const h = (x, y) => { const i = (y * t.width + x) * t.bpp; return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768; };
  return h(x0, y0) * (1 - ax) * (1 - ay) + h(x0 + 1, y0) * ax * (1 - ay) + h(x0, y0 + 1) * (1 - ax) * ay + h(x0 + 1, y0 + 1) * ax * ay;
}
console.log("Sampling elevation…");
const ele = new Float64Array(pts.length);
for (let i = 0; i < pts.length; i++) { ele[i] = await height(pts[i].lat, pts[i].lon); if (i % 2000 === 0) process.stdout.write("."); }
console.log("");
// Valley-floor DEM noise: light smoothing outside tunnels and bridges
const sm = Float64Array.from(ele);
for (let i = 0; i < pts.length; i++) { if (pts[i].tunnel || pts[i].bridge) continue; let s = 0, n = 0; for (let k = -4; k <= 4; k++) { const j = i + k; if (j >= 0 && j < pts.length && !pts[j].tunnel && !pts[j].bridge) { s += ele[j]; n++; } } sm[i] = s / n; }
for (const [a, b] of [...tunnels, ...bridges]) {
  const ea = sm[Math.max(0, a - 1)], eb = sm[Math.min(pts.length - 1, b + 1)];
  for (let i = a; i <= b; i++) sm[i] = ea + (eb - ea) * ((i - a + 1) / (b - a + 2));
}

/* ---------- 6. stamps ---------- */
function nearestKm(lat, lon, fromIdx) {
  let best = -1, bd = 3000; const [x, y] = P(lat, lon);
  for (let i = fromIdx; i < pts.length; i++) { const [a, b] = P(pts[i].lat, pts[i].lon); const d = Math.hypot(a - x, b - y); if (d < bd) { bd = d; best = i; } }
  return best;
}
let from = 0; const stamps = [];
for (const [id, title, text, lat, lon, tunnelKey] of config.stamps) {
  let i = -1;
  if (tunnelKey) { const t = tunnels.find((t) => t[0] >= from && norm(t[2]).includes(norm(tunnelKey))) || tunnels.filter((t) => t[0] >= from).sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))[0]; if (t) i = Math.round((t[0] + t[1]) / 2); }
  else i = nearestKm(lat, lon, from);
  if (i < 0) { console.warn(`  stamp "${title}" not found near the route, skipped`); continue; }
  stamps.push([id, title, text, +kmOf(i).toFixed(2)]); from = i;
}

/* ---------- 7. buildings near the track ----------
   Villages along the line: footprints from OpenStreetMap within ~300 m of the track,
   with a height, a roof shape and a local style (dark larch chalets up high, white plaster lower down). */
const BCHUNK = 5; // km per file
const buildingChunks = [];
await mkdir(new URL("public/data/buildings/", ROOT), { recursive: true });
try {
  const bFile = new URL("buildings.json", CACHE);
  if (!(await exists(bFile))) {
    const boxes = [];
    for (let i = 0; i < pts.length; i += 100) { // one box per 2 km of track
      let a = 90, b = 180, c = -90, d = -180; for (let k = i; k < Math.min(pts.length, i + 101); k++) { a = Math.min(a, pts[k].lat); b = Math.min(b, pts[k].lon); c = Math.max(c, pts[k].lat); d = Math.max(d, pts[k].lon); }
      boxes.push(`  way["building"](${(a - 0.003).toFixed(5)},${(b - 0.0045).toFixed(5)},${(c + 0.003).toFixed(5)},${(d + 0.0045).toFixed(5)});`);
    }
    const q = `[out:json][timeout:300];\n(\n${boxes.join("\n")}\n);\nout tags geom;`;
    console.log("Downloading buildings along the line…");
    let text = null;
    for (let i = 0; i < 8 && !text; i++) {
      const url = OVERPASS[i % OVERPASS.length];
      try { const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "window-seat (github.com/arikhanacademic-cpu)" }, body: "data=" + encodeURIComponent(q) }); if (!res.ok) throw new Error("HTTP " + res.status); const t = await res.text(); JSON.parse(t); text = t; }
      catch (e) { const w = Math.min(120, 10 * 2 ** i); console.warn(`  ${e.message} from ${new URL(url).host}, retrying in ${w}s`); await sleep(w * 1000); }
    }
    if (text) await writeFile(bFile, text);
  }
  if (await exists(bFile)) {
    const data = JSON.parse(await readFile(bFile, "utf8"));
    const rg = new Map(); pts.forEach((p, i) => { const [x, y] = P(p.lat, p.lon); const k = Math.floor(x / 100) + "," + Math.floor(y / 100); (rg.get(k) || rg.set(k, []).get(k)).push(i); });
    const nearestIdx = (lat, lon) => { const [x, y] = P(lat, lon); let best = -1, bd = 330; for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) for (const i of rg.get((Math.floor(x / 100) + a) + "," + (Math.floor(y / 100) + b)) || []) { const [px, py] = P(pts[i].lat, pts[i].lon); const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = i; } } return best; };
    const chunks = new Map(); const seenB = new Set(); let nb = 0;
    const DEF = { church: 15, chapel: 9, cathedral: 22, apartments: 13, hotel: 15, commercial: 11, retail: 8, industrial: 9, warehouse: 8, school: 11, public: 11, civic: 11, train_station: 9, garage: 3, garages: 3, shed: 3, hut: 4, roof: 4, cabin: 5, barn: 7, farm_auxiliary: 6, stable: 6, house: 8.5, detached: 8.5, residential: 9.5, chalet: 8.5 };
    for (const el of data.elements || []) {
      if (el.type !== "way" || !el.geometry || seenB.has(el.id)) continue; seenB.add(el.id);
      const t = el.tags || {}; if (t.building === "no" || t.location === "underground") continue;
      let ring = el.geometry.map((g) => [g.lat, g.lon]); if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
      if (ring.length < 3) continue;
      let la = 0, lo = 0; for (const [a, b] of ring) { la += a; lo += b; } la /= ring.length; lo /= ring.length;
      const idx = nearestIdx(la, lo); if (idx < 0) continue;
      const xy = ring.map(([a, b]) => P(a, b)); let A = 0; for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) A += (xy[j][0] + xy[i][0]) * (xy[j][1] - xy[i][1]);
      if (Math.abs(A / 2) < 12) continue;
      let h = parseFloat(t.height) || (parseFloat(t["building:levels"]) > 0 ? parseFloat(t["building:levels"]) * 3 + 2.5 : 0);
      const ele0 = Math.min(...(await Promise.all(ring.map(([a, b]) => height(a, b)))));
      if (!h) h = (DEF[t.building] ?? 8) * (0.85 + ((el.id * 2654435761) % 1000) / 1000 * 0.35);
      h = Math.min(60, h);
      const r01 = ((el.id * 40503) % 997) / 997;
      // style: 0 dark larch chalet, 1 white plaster, 2 grey stone, 3 modern/concrete, 4 church
      let cls = 1;
      if (["church", "chapel", "cathedral"].includes(t.building) || t.amenity === "place_of_worship") cls = 4;
      else if (["industrial", "warehouse", "commercial", "retail", "train_station", "garage", "garages"].includes(t.building) || h > 18) cls = 3;
      else if (["barn", "stable", "farm_auxiliary", "hut", "cabin", "shed", "chalet"].includes(t.building)) cls = r01 < 0.85 ? 0 : 2;
      else cls = ele0 > 1150 ? (r01 < 0.6 ? 0 : r01 < 0.9 ? 1 : 2) : (r01 < 0.2 ? 0 : r01 < 0.85 ? 1 : 2);
      const shape = (t["roof:shape"] || "").toLowerCase();
      const roof = shape === "flat" || cls === 3 && !shape ? 0 : 1;
      const km = (idx * STEP) / 1000; const ci = Math.floor(km / BCHUNK);
      const rec = [Math.round(h * 2), cls, roof, Math.round(ele0)]; for (const [a, b] of ring) rec.push(+a.toFixed(6), +b.toFixed(6));
      (chunks.get(ci) || chunks.set(ci, []).get(ci)).push(rec); nb++;
    }
    for (const [ci, list] of chunks) { await writeFile(new URL(`public/data/buildings/${ci}.json`, ROOT), JSON.stringify(list)); buildingChunks.push(ci); }
    console.log(`${nb} buildings near the track, in ${chunks.size} files`);
  }
} catch (e) { console.warn("Buildings skipped:", e.message); }

/* ---------- write ---------- */
const flat = [];
for (let i = 0; i < pts.length; i++) flat.push(+pts[i].lat.toFixed(6), +pts[i].lon.toFixed(6), Math.round(sm[i]), pts[i].tunnel ? 1 : pts[i].bridge ? 2 : 0);
const out = {
  built: new Date().toISOString().slice(0, 10), step: STEP, length: +kmOf(pts.length - 1).toFixed(2),
  from: config.from, to: config.to, via: config.via,
  pts: flat,
  stations: stops.map((s, i) => [s.name, +stationKm[i].toFixed(2)]),
  tunnels: tunnels.map(([a, b, n]) => [+kmOf(a).toFixed(2), +kmOf(b).toFixed(2), n]),
  bridges: bridges.map(([a, b, n]) => [+kmOf(a).toFixed(2), +kmOf(b).toFixed(2), n]),
  stamps,
  buildings: { chunkKm: BCHUNK, chunks: buildingChunks.sort((a, b) => a - b) }
};
await writeFile(new URL("public/data/route.json", ROOT), JSON.stringify(out));
const maxE = Math.max(...sm), maxI = sm.indexOf(maxE);
console.log(`Wrote public/data/route.json: ${out.length} km, ${tunnels.length} tunnels, ${bridges.length} bridges, highest point ${Math.round(maxE)} m at km ${kmOf(maxI).toFixed(1)}`);
