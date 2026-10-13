// Builds the route offline from the synthetic fixtures in test/mock.mjs (no network needed).
import { writeFile, mkdir } from "node:fs/promises";
import { osm, terrariumTile } from "./mock.mjs";
await mkdir(new URL("../cache/glacier/", import.meta.url), { recursive: true });
const o = osm();
await writeFile(new URL("../cache/glacier/osm.json", import.meta.url), JSON.stringify({ elements: o.elements.filter((e) => !e.tags?.building) }));
await writeFile(new URL("../cache/glacier/buildings.json", import.meta.url), JSON.stringify({ elements: o.elements.filter((e) => e.tags?.building) }));
globalThis.fetch = async (url) => { const m = String(url).match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/); if (!m) throw new Error("offline: " + url); const b = terrariumTile(+m[1], +m[2], +m[3]); return new Response(b, { status: 200 }); };
process.env.ROUTE = "glacier";
await import("../scripts/build-route.mjs");
const { writeFile: wf } = await import("node:fs/promises");
await wf(new URL("../public/data/routes.json", import.meta.url), JSON.stringify([{ id: "glacier", name: "Glacier Express route", from: "Zermatt", to: "St. Moritz" }, { id: "bernina", name: "Bernina line", from: "St. Moritz", to: "Tirano" }, { id: "gotthard", name: "Gotthard Panorama line", from: "Arth-Goldau", to: "Bellinzona" }]));
