// Turns on the lofi music and the ride sounds in a headless browser and reports any errors.
import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
const p = await b.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.goto("about:blank"); await p.addScriptTag({ path: new URL("../public/audio.js", import.meta.url).pathname });
const r = await p.evaluate(async () => { WSAudio.music(true); WSAudio.ambience(true); WSAudio.update({ speed: 60, rain: 0.8, snow: 0, wind: 30, tunnel: false }); WSAudio.thunder(true); await new Promise((res) => setTimeout(res, 4000)); return [WSAudio.musicOn, WSAudio.ambienceOn]; });
console.log("music/ambience on:", r, "errors:", errs.length ? errs : "none"); await b.close();
