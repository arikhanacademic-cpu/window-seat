// Renders the site's own generative lofi (public/audio.js) to a WAV file, faster than real time,
// by running it inside an OfflineAudioContext in headless Chromium.
//
//   node video/render-music.mjs 45 video/out/music.wav [ambience]
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const D = +process.argv[2] || 45, OUT = process.argv[3] || "video/out/music.wav", AMB = process.argv[4] === "ambience";
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const p = await b.newPage();
await p.goto("about:blank");
await p.evaluate(({ D, AMB }) => { const sr = 44100; window.__off = new OfflineAudioContext(2, Math.ceil(sr * D), sr); window.AudioContext = function () { return window.__off; }; window.__AMB = AMB; }, { D, AMB });
await p.addScriptTag({ path: new URL("../public/audio.js", import.meta.url).pathname });
const b64 = await p.evaluate(async (D) => {
  const off = window.__off; off.resume = () => Promise.resolve();
  if (window.__AMB) { WSAudio.ambience(true); WSAudio.update({ speed: 55, wind: 12 }); } else WSAudio.music(true);
  // the music schedules a little ahead on a 25 ms timer, so pause the render every 50 ms of audio and let the timer catch up
  for (let t = 0.05; t < D; t += 0.05) off.suspend(+t.toFixed(3)).then(() => new Promise((r) => setTimeout(r, 30)).then(() => off.resume === Object.getPrototypeOf(off).resume ? null : OfflineAudioContext.prototype.resume.call(off)));
  const buf = await off.startRendering();
  const L = buf.getChannelData(0), R = buf.getChannelData(1), n = L.length; const dv = new DataView(new ArrayBuffer(44 + n * 4));
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); dv.setUint32(4, 36 + n * 4, true); w(8, "WAVEfmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, 44100, true); dv.setUint32(28, 44100 * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) { dv.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true); dv.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
  let s = ""; const u = new Uint8Array(dv.buffer); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s);
}, D);
mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, Buffer.from(b64, "base64")); console.log("wrote", OUT);
await b.close();
