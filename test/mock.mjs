// Test fixtures: synthetic Alps, railway and live timetable in the real data formats.
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url))).routes[0];
const FLOOR = { "Zermatt": 1605, "Visp": 650, "Brig": 680, "Fiesch": 1050, "Oberwald": 1370, "Realp": 1540, "Andermatt": 1436, "Oberalppass": 2033, "Disentis/Mustér": 1130, "Ilanz": 700, "Reichenau-Tamins": 600, "Chur": 585, "Thusis": 700, "Tiefencastel": 850, "Filisur": 1030, "Bergün/Bravuogn": 1370, "Preda": 1790, "Samedan": 1720, "Celerina": 1730, "St. Moritz": 1775 };
const S = config.stations; const MX = 111320 * Math.cos(46.4 * Math.PI / 180), MY = 110574;
export function elevation(lat, lon) {
  let h = 2300 + 500 * Math.sin(lat * 140) * Math.cos(lon * 95) + 350 * Math.sin(lat * 410 + lon * 230) + 160 * Math.cos(lat * 1300 - lon * 900);
  h += 2100 * Math.exp(-(((lat - 45.9763) * MY) ** 2 + ((lon - 7.6586) * MX) ** 2) / (2 * 1600 ** 2)); // Matterhorn
  let best = 1e9, floor = 1000;
  for (let i = 1; i < S.length; i++) {
    const [, la1, lo1] = S[i - 1], [, la2, lo2] = S[i]; const ax = lo1 * MX, ay = la1 * MY, bx = lo2 * MX, by = la2 * MY, px = lon * MX, py = lat * MY;
    const dx = bx - ax, dy = by - ay; const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(ax + dx * u - px, ay + dy * u - py); if (d < best) { best = d; floor = FLOOR[S[i - 1][0]] * (1 - u) + FLOOR[S[i][0]] * u; }
  }
  return Math.min(h, floor + Math.max(0, best - 250) * 0.42 + 4);
}
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); }
const demCache = new Map();
export function terrariumTile(z, x, y) {
  const key = "dem" + z + "/" + x + "/" + y; if (demCache.has(key)) return demCache.get(key); const aerialCache = demCache;
  const raw = Buffer.alloc(256 * (256 * 3 + 1));
  for (let j = 0; j < 256; j++) {
    raw[j * 769] = 0;
    const n = Math.PI - (2 * Math.PI * (y + (j + 0.5) / 256)) / 2 ** z; const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
    for (let i = 0; i < 256; i++) { const lon = ((x + (i + 0.5) / 256) / 2 ** z) * 360 - 180; const v = elevation(lat, lon) + 32768; const o = j * 769 + 1 + i * 3; raw[o] = Math.floor(v / 256); raw[o + 1] = Math.floor(v) % 256; raw[o + 2] = Math.floor((v % 1) * 256); }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(256, 0); ihdr.writeUInt32BE(256, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  aerialCache.set(key, png); return png;
}
function vhashS(x, y) { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); }
export function osm() {
  const els = []; let id = 1;
  for (const [n, la, lo] of S) els.push({ type: "node", id: id++, lat: la + 0.0004, lon: lo - 0.0003, tags: { railway: "station", name: n } });
  const seenPair = new Set();
  for (let i = 1; i < S.length; i++) {
    const a = S[i - 1], b = S[i]; const key = [a[0], b[0]].sort().join("|"); if (seenPair.has(key)) continue; seenPair.add(key);
    const pts = []; const M = 60; for (let k = 0; k <= M; k++) { const u = k / M; const w = k === 0 || k === M ? 0 : Math.sin(u * Math.PI * 5) * 0.0012; pts.push({ lat: a[1] + (b[1] - a[1]) * u + w, lon: a[2] + (b[2] - a[2]) * u - w }); }
    const tagged = (from, to, tags) => els.push({ type: "way", id: id++, tags: { railway: "narrow_gauge", gauge: "1000", ...tags }, geometry: pts.slice(from, to + 1) });
    if (a[0] === "Oberwald") { tagged(0, 6, {}); tagged(6, 54, { tunnel: "yes", name: "Furka-Basistunnel" }); tagged(54, M, {}); }
    else if (b[0] === "Filisur") { tagged(0, 55, {}); tagged(55, 58, { bridge: "yes", name: "Landwasserviadukt" }); tagged(58, M, {}); }
    else if (a[0] === "Bergün/Bravuogn") { tagged(0, 50, {}); tagged(50, 58, { tunnel: "yes", name: "Albulatunnel" }); tagged(58, M, {}); }
    else tagged(0, M, {});
  }
  // little villages of chalets beside every station
  for (const [n, la, lo] of S) for (let k = 0; k < 26; k++) {
    const dx = (vhashS(k, la) - 0.5) * 0.006, dy = (vhashS(la, k) - 0.5) * 0.004; if (Math.abs(dy) < 0.0004) continue; const c = [la + dy + 0.0006, lo + dx];
    const w = 0.00008 + vhashS(k, lo) * 0.00006, d = 0.00011 + vhashS(lo, k) * 0.00006;
    els.push({ type: "way", id: id++, tags: { building: k % 9 === 0 ? "church" : k % 4 === 0 ? "barn" : "house" }, geometry: [[0, 0], [w, 0], [w, d], [0, d], [0, 0]].map(([a, b]) => ({ lat: c[0] + a, lon: c[1] + b })) });
  }
  // a decoy branch line and standard-gauge track that must be ignored
  els.push({ type: "way", id: id++, tags: { railway: "narrow_gauge", gauge: "1000" }, geometry: [{ lat: 46.6355, lon: 8.594 }, { lat: 46.70, lon: 8.60 }] });
  return { elements: els };
}
// transport.opendata.ch-shaped connections along the synthetic line
export function connections(route, url) {
  const q = new URL(url).searchParams; const fwd = q.get("from") === "Zermatt"; const limit = +q.get("limit") || 4;
  const [Y, M, D] = q.get("date").split("-").map(Number); const [h, m] = q.get("time").split(":").map(Number);
  const startUTC = Date.UTC(Y, M - 1, D, h - 2, m); // Swiss summer time (UTC+2) in October
  const P = route.pts; const at = (km) => { const i = Math.min(P.length / 4 - 1, Math.round((km * 1000) / route.step)); return { x: P[i * 4], y: P[i * 4 + 1] }; };
  let st = route.stations.filter((s, i, a) => i === 0 || s[0] !== a[i - 1][0] || Math.abs(s[1] - a[i - 1][1]) > 0.5);
  if (!fwd) st = st.slice().reverse().map(([n, km]) => [n, route.length - km]);
  const out = [];
  let dep = Math.ceil((startUTC - 52 * 60000) / 3600000) * 3600000 + 52 * 60000; // :52 every hour
  while (out.length < limit) {
    const legsAt = fwd ? ["Brig", "Disentis/Mustér", "Chur"] : ["Chur", "Disentis/Mustér", "Brig"];
    const sections = []; let cur = { category: "R", number: "", to: "", passList: [] }; let t = dep / 1000;
    st.forEach(([n, km], i) => {
      if (i) t += ((Math.abs(km - st[i - 1][1])) / 38) * 3600;
      const kmf = fwd ? km : route.length - km; const c = at(kmf);
      const stop = { station: { name: n, coordinate: { type: "WGS84", x: c.x, y: c.y } }, arrival: null, arrivalTimestamp: i ? Math.round(t) : null, departureTimestamp: i < st.length - 1 ? Math.round(t + 120) : null, prognosis: { arrival: null, departure: null } };
      cur.passList.push(stop);
      if (legsAt.includes(n) && i < st.length - 1) { cur.to = n; sections.push({ journey: cur }); cur = { category: sections.length === 1 ? "RE" : sections.length === 2 ? "PE" : "RE", number: String(900 + sections.length * 2), name: sections.length === 2 ? "PE 904" : "", to: "", passList: [{ ...stop, arrivalTimestamp: null }] }; }
      if (i) t += 120;
    });
    cur.to = st[st.length - 1][0]; sections.push({ journey: cur });
    out.push({ from: { departureTimestamp: dep / 1000 }, sections });
    dep += 3600000;
  }
  return JSON.stringify({ connections: out });
}
// A stand-in for swisstopo aerial imagery: meadows, forest patches, rock and snow, with grain.
function vhash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) { const i = Math.floor(x), j = Math.floor(y), f = x - i, g = y - j, u = f * f * (3 - 2 * f), v = g * g * (3 - 2 * g); return (vhash(i, j) * (1 - u) + vhash(i + 1, j) * u) * (1 - v) + (vhash(i, j + 1) * (1 - u) + vhash(i + 1, j + 1) * u) * v; }
function fbm(x, y) { let s = 0, a = 0.5; for (let k = 0; k < 5; k++) { s += a * vnoise(x, y); x = x * 2.03 + 17; y = y * 2.03 + 17; a *= 0.5; } return s; }
const aerialCache = new Map();
export function aerialTile(z, x, y) {
  const key = z + "/" + x + "/" + y; if (aerialCache.has(key)) return aerialCache.get(key);
  const raw = Buffer.alloc(256 * 769); const n2 = 2 ** z; const R = 4; // computed on a 64×64 grid to keep tests fast
  for (let j = 0; j < 256; j++) {
    raw[j * 769] = 0; if (j % R) { raw.copy(raw, j * 769, (j - 1) * 769, j * 769); continue; }
    const nn = Math.PI - (2 * Math.PI * (y + (j + 0.5) / 256)) / n2; const lat = (180 / Math.PI) * Math.atan(Math.sinh(nn));
    for (let i = 0; i < 256; i++) {
      if (i % R) { const o = j * 769 + 1 + i * 3; raw.copy(raw, o, o - 3, o); continue; }
      const lon = ((x + (i + 0.5) / 256) / n2) * 360 - 180; const h = elevation(lat, lon), hx = elevation(lat, lon + 0.0004) - h, hy = elevation(lat + 0.0003, lon) - h; const slope = Math.hypot(hx / 30, hy / 33);
      const X = lon * MX, Y = lat * MY; const f1 = fbm(X * 0.0035, Y * 0.0035), f2 = fbm(X * 0.03, Y * 0.03), grain = vhash(X * 3.1, Y * 2.7);
      let c = [92 + 30 * f2, 112 + 26 * f2, 62 + 14 * f2];
      if (f1 + 0.12 * f2 > 0.5 && h < 1950 && slope < 0.75) c = [34 + 14 * grain, 58 + 18 * grain, 30 + 10 * grain];
      if (h > 2100) c = c.map((v, k) => v * 0.6 + [128, 124, 92][k] * 0.4);
      if (slope > 0.6 || h > 2600) c = [118 + 40 * f2, 114 + 38 * f2, 106 + 36 * f2];
      if (h > 2750 + f1 * 300 && slope < 0.85) c = [236, 240, 246];
      const o = j * 769 + 1 + i * 3; raw[o] = Math.max(0, Math.min(255, c[0] + (grain - 0.5) * 14)); raw[o + 1] = Math.max(0, Math.min(255, c[1] + (grain - 0.5) * 14)); raw[o + 2] = Math.max(0, Math.min(255, c[2] + (grain - 0.5) * 14));
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(256, 0); ihdr.writeUInt32BE(256, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  aerialCache.set(key, png); return png;
}
