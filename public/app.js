// Window Seat — ride a real train across the Swiss Alps, in real time.
//
//  • The track is the exact railway from OpenStreetMap, with tunnels, bridges and heights (scripts/build-route.mjs).
//  • Live trains come from transport.opendata.ch: real departures, stops and delays on the Glacier Express route.
//  • The view is real terrain (Terrarium elevation tiles) draped with swisstopo aerial imagery, streamed around the train.
//  • Your ride is saved in the browser, so you can leave and come back: the train keeps going, and stamps keep collecting.
"use strict";
(async function () {
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const PREVIEW = Math.max(0, +params.get("preview") || 0);   // ?preview=60 → 60× speed demo, not live
  const API = "https://transport.opendata.ch/v1/connections";
  const TERRAIN = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  const IMAGERY = (z, x, y) => `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/${z}/${x}/${y}.jpeg`;
  const TZ = "Europe/Zurich";
  const store = { get(k, d) { try { const v = localStorage.getItem("ws." + k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem("ws." + k, JSON.stringify(v)); } catch {} } };
  const fmtTime = (t) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(t);
  const fmtDate = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  const mins = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function fail(html) { const e = $("#err"); e.hidden = false; e.firstElementChild.innerHTML = html; }

  /* ---------- clock (real, or sped up in preview) ---------- */
  const t0Real = Date.now(); let previewStart = t0Real;
  const now = () => (PREVIEW ? previewStart + (Date.now() - t0Real) * PREVIEW : Date.now());

  /* ---------- route ---------- */
  let raw;
  try { raw = await (await fetch("data/route.json")).json(); }
  catch { fail(location.protocol === "file:" ? "<h2>Open this through a web server</h2><p>Run <code>npx serve public</code> in the project folder, then open the address it prints.</p>" : "<h2>No route yet</h2><p>Run <code>node scripts/build-route.mjs</code> (or the GitHub Action) to build <code>public/data/route.json</code>.</p>"); return; }
  const N = raw.pts.length / 4, STEP = raw.step / 1000, L = raw.length;
  let minLa = 90, maxLa = -90, minLo = 180, maxLo = -180;
  for (let i = 0; i < N; i++) { const la = raw.pts[i * 4], lo = raw.pts[i * 4 + 1]; minLa = Math.min(minLa, la); maxLa = Math.max(maxLa, la); minLo = Math.min(minLo, lo); maxLo = Math.max(maxLo, lo); }
  const LAT0 = (minLa + maxLa) / 2, LON0 = (minLo + maxLo) / 2, MX = 111320 * Math.cos((LAT0 * Math.PI) / 180), MY = 110574;
  const toXZ = (lat, lon) => [(lon - LON0) * MX, -(lat - LAT0) * MY];
  const toLL = (x, z) => [LAT0 - z / MY, LON0 + x / MX];

  function makeRoute(rev) {
    const X = new Float64Array(N), Y = new Float64Array(N), Z = new Float64Array(N), F = new Int8Array(N), LA = new Float64Array(N), LO = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const i = rev ? N - 1 - k : k; const la = raw.pts[i * 4], lo = raw.pts[i * 4 + 1]; const [x, z] = toXZ(la, lo);
      X[k] = x; Z[k] = z; Y[k] = raw.pts[i * 4 + 2]; F[k] = raw.pts[i * 4 + 3]; LA[k] = la; LO[k] = lo;
    }
    const m = (km) => (rev ? L - km : km);
    const ord = (a) => (rev ? a.slice().reverse() : a);
    const r = {
      rev, X, Y, Z, F, LA, LO,
      from: rev ? raw.to : raw.from, to: rev ? raw.from : raw.to,
      stations: ord(raw.stations).map(([n, km]) => [n, +m(km).toFixed(2)]).filter((s, i, a) => i === 0 || s[0] !== a[i - 1][0] || Math.abs(s[1] - a[i - 1][1]) > 0.5),
      tunnels: ord(raw.tunnels).map(([a, b, n]) => (rev ? [L - b, L - a, n] : [a, b, n])),
      bridges: ord(raw.bridges).map(([a, b, n]) => (rev ? [L - b, L - a, n] : [a, b, n])),
      stamps: ord(raw.stamps).map(([id, t, d, km]) => [id, t, d, m(km)])
    };
    r.at = (km) => {
      const f = Math.max(0, Math.min(N - 1.0001, km / STEP)); const i = Math.floor(f), u = f - i;
      const j = Math.max(0, i - 3), k = Math.min(N - 1, i + 4); let hx = X[k] - X[j], hz = Z[k] - Z[j]; const hl = Math.hypot(hx, hz) || 1;
      return { x: X[i] + (X[i + 1] - X[i]) * u, y: Y[i] + (Y[i + 1] - Y[i]) * u, z: Z[i] + (Z[i + 1] - Z[i]) * u, flag: F[u < 0.5 ? i : i + 1], hx: hx / hl, hz: hz / hl };
    };
    // nearest km to a coordinate, searching forward from a starting km (stations can repeat, e.g. Reichenau)
    r.project = (lat, lon, fromKm = 0, windowKm = 80) => {
      const [x, z] = toXZ(lat, lon); const s = Math.max(0, Math.floor((fromKm - 0.3) / STEP)), e = Math.min(N, Math.ceil((fromKm + windowKm) / STEP));
      let best = -1, bd = 900;
      for (let i = s; i < e; i++) { const d = Math.hypot(X[i] - x, Z[i] - z); if (d < bd) { bd = d; best = i; } if (best >= 0 && bd < 250 && d > bd + 1500) break; }
      return best < 0 ? null : best * STEP;
    };
    r.inTunnel = (km) => r.tunnels.find(([a, b]) => km >= a && km <= b);
    return r;
  }
  const ROUTES = { fwd: makeRoute(false), rev: makeRoute(true) };

  /* ---------- three.js scene ---------- */
  const canvas = $("#view");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.08;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 1, 1, 320000);
  const hemi = new THREE.HemisphereLight(0xdfe8f5, 0x4a4234, 0.7); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.9); scene.add(sun);
  // exponential haze: distant ridges fade into blue, the way alpine air really looks
  scene.fog = new THREE.FogExp2(0xc9d8e6, 1.2e-5);

  // Shared GLSL noise for the sky and the painted terrain
  const NOISE = `
    float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
      return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
    float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 17.1; a *= .5; } return v; }`;

  // Sky dome: gradient, sun disc and glow, soft drifting clouds, stars at night
  const skyU = { uCover: { value: 0.3 }, uGrey: { value: 0 }, uFlash: { value: 0 }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uSunCol: { value: new THREE.Color() }, uDay: { value: 1 }, uDusk: { value: 0 }, uTime: { value: 0 } };
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(200000, 48, 24), new THREE.ShaderMaterial({
    uniforms: skyU, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `uniform vec3 uSun, uZenith, uHorizon, uSunCol; uniform float uDay, uDusk, uTime, uCover, uGrey, uFlash; varying vec3 vDir; ${NOISE}
      void main(){
        vec3 d = normalize(vDir); float y = d.y; float h = clamp(y, 0., 1.);
        vec3 col = mix(uHorizon, uZenith, pow(h, .42));
        float cs = max(dot(d, normalize(uSun)), 0.);
        col += uSunCol * (1. - uGrey) * (pow(cs, 1400.) * 18. * step(-.02, uSun.y) + pow(cs, 9.) * (.18 + .55 * uDusk) + pow(cs, 2.) * .06 * uDusk);
        if (y > 0.) {
          vec2 p = d.xz / (y + .12) * 1.6 + vec2(uTime * .004, uTime * .0015);
          float n = fbm(p * 1.4) * .7 + fbm(p * 5.3) * .3;
          float c = smoothstep(.66 - .5 * uCover, .9 - .42 * uCover, n) * smoothstep(.0, .22, y);
          vec3 cloud = mix(vec3(.82, .85, .9), vec3(1.), .5 + .5 * uDay) * (.25 + .85 * uDay) * (1. - .5 * uGrey * smoothstep(.45, .8, n));
          cloud = mix(cloud, uSunCol * 1.1, .45 * uDusk * pow(cs, 3.));
          col = mix(col, cloud, c * .85);
          float st = step(.9965, hash12(floor(d.xz / (y + .05) * 260.))) * (1. - uDay) * smoothstep(.05, .3, y) * (1. - c);
          col += st * .8;
        } else col = uHorizon * (.85 + .15 * smoothstep(-.2, 0., y));
        col = mix(col, vec3(.5, .53, .58) * (.18 + .7 * uDay), uGrey * .93);   // overcast
        col += uFlash * vec3(.75, .8, 1.);                                       // lightning
        gl_FragColor = vec4(col, 1.);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }`
  }));
  skyDome.renderOrder = -1000; skyDome.frustumCulled = false; scene.add(skyDome);
  const FOV = { seat: null, window: 46 }; let seatMode = "seat";
  function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.fov = (seatMode === "window" ? FOV.window : FOV.seat) ?? (w < 760 ? 70 : 58); camera.updateProjectionMatrix(); }
  addEventListener("resize", resize); resize();

  // sun position for the real time of day (approximate solar ephemeris)
  function sunPos(t, lat, lon) {
    const d = t / 86400000 - 10957.5, rad = Math.PI / 180;
    const g = (357.529 + 0.98560028 * d) * rad, q = 280.459 + 0.98564736 * d;
    const Lr = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad, e = (23.439 - 3.6e-7 * d) * rad;
    const ra = Math.atan2(Math.cos(e) * Math.sin(Lr), Math.cos(Lr)), dec = Math.asin(Math.sin(e) * Math.sin(Lr));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24; const ha = ((gmst * 15 + lon) * rad - ra);
    const la = lat * rad; const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
    const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
    return { el, az };
  }
  const C = (h) => new THREE.Color(h).convertSRGBToLinear(); // colours are authored in sRGB, lit in linear
  const SKY = { zDay: C("#2f6fc0"), hDay: C("#cbdcee"), zDusk: C("#3c5590"), hDusk: C("#f2b27c"), zNight: C("#03060f"), hNight: C("#0f1628"), sunDay: C("#fff3df"), sunDusk: C("#ff9a52") };
  function setSky(t) {
    const { el, az } = sunPos(t, LAT0, LON0); const s = Math.sin(el);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), s, -Math.cos(az) * Math.cos(el));
    sun.position.copy(dir).setY(Math.max(0.04, s)).multiplyScalar(1000);
    const day = THREE.MathUtils.clamp((s + 0.08) / 0.3, 0, 1), dusk = THREE.MathUtils.clamp(1 - Math.abs(s - 0.03) / 0.14, 0, 1) * (s > -0.12 ? 1 : 0);
    const zen = SKY.zNight.clone().lerp(SKY.zDay, day).lerp(SKY.zDusk, dusk * 0.6), hor = SKY.hNight.clone().lerp(SKY.hDay, day).lerp(SKY.hDusk, dusk * 0.7);
    const sunCol = SKY.sunDay.clone().lerp(SKY.sunDusk, dusk);
    Object.assign(skyU.uDay, { value: day }); skyU.uDusk.value = dusk; skyU.uTime.value = (t / 1000) % 100000; skyU.uSun.value.copy(dir);
    skyU.uZenith.value.copy(zen); skyU.uHorizon.value.copy(hor); skyU.uSunCol.value.copy(sunCol);
    const grey = WX.grey; skyU.uCover.value = WX.cover; skyU.uGrey.value = grey; skyU.uFlash.value = WX.flash;
    hor.lerp(C("#8e959c").multiplyScalar(0.25 + 0.75 * day), grey * 0.8);
    scene.background = hor; scene.fog.color.copy(hor).lerp(C("#ffffff"), WX.flash * 0.5);
    scene.fog.density = Math.max(9e-6 + 6e-6 * dusk + 4e-6 * (1 - day), 1.87 / Math.max(120, WX.vis));
    sun.intensity = (0.05 + 1.45 * day * Math.min(1, s * 4 + 0.2)) * (1 - 0.8 * grey); sun.color.copy(sunCol);
    hemi.intensity = 0.18 + 0.5 * day + 0.25 * grey * day + WX.flash * 2.5; hemi.color.copy(C("#6d82b0").lerp(C("#cfe0f5"), day)); hemi.groundColor.copy(C("#2b2620").lerp(C("#6b5c45"), day));
  }

  /* ---------- weather state (filled from Open-Meteo, smoothed every frame) ---------- */
  const WX = { cover: 0.3, grey: 0, rain: 0, snow: 0, storm: 0, wind: 8, windDir: 270, vis: 40000, flash: 0, snowDepth: 0, info: null };
  const WXU = { uSnowLine: { value: 3000 }, uSnowAmt: { value: 1 }, uWet: { value: 0 } };
  // typical snowline by month in the central Alps (metres), lowered further when snow is lying at the train
  const SEASON_SNOW = [1000, 1000, 1200, 1700, 2300, 2800, 3100, 3200, 2900, 2500, 1800, 1200];

  /* ---------- terrain tiles ---------- */
  const LITE = params.has("lite"); // for slow devices and automated tests
  const LEVELS = [
    { z: 14, r: 1, segs: 128, drop: 0, img: LITE ? 15 : 16, trees: true }, // ~5 km around the train: 1.6 m imagery, 3D trees
    { z: 12, r: 2, segs: 96, drop: 14, img: 13 },                           // ~33 km
    { z: 10, r: 1, segs: 64, drop: 45, img: 11 },                           // ~80 km
    { z: 8, r: 1, segs: 48, drop: 140, img: 9 }                             // the far horizon
  ];
  if (LITE) LEVELS.forEach((l) => (l.segs = Math.max(16, l.segs / 4)));
  const tiles = new Map(); let inflight = 0; const queue = [];
  // Coarser rings cut a hole where the finer ring is fully loaded, so a blurry far tile
  // never pokes up through a detailed valley floor.
  LEVELS.forEach((lv) => (lv.hole = { value: new THREE.Vector4(0, 0, 0, 0) }));
  // Terrain shading. With aerial imagery: a gentle grade for crisper alpine colour.
  // Without it (outside Switzerland): painted procedurally from height and slope —
  // meadows, forest, alpine pasture, scree, rock and snow, broken up with noise.
  function terrainMaterial(lv, opts) {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0, ...opts });
    m.extensions = { derivatives: true };
    if (!opts.map) m.defines = { USE_PROC: "" };
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uHole = lv.hole; sh.uniforms.uDrop = { value: lv.drop }; sh.uniforms.uSnowLine = WXU.uSnowLine; sh.uniforms.uSnowAmt = WXU.uSnowAmt; sh.uniforms.uWet = WXU.uWet; sh.uniforms.uBump = { value: lv.z >= 14 ? 1 : 0.5 };
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vWXZ; varying float vWY; varying vec3 vWN; uniform float uDrop;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvec4 wpT = modelMatrix * vec4(transformed, 1.0); vWXZ = wpT.xz; vWY = wpT.y + uDrop; vWN = normalize(mat3(modelMatrix) * objectNormal);");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vWXZ; varying float vWY; varying vec3 vWN; uniform vec4 uHole; uniform float uSnowLine, uSnowAmt, uWet, uBump;\n" + NOISE)
        .replace("void main() {", "void main() {\n  if (vWXZ.x > uHole.x && vWXZ.x < uHole.z && vWXZ.y > uHole.y && vWXZ.y < uHole.w) discard;")
        .replace("#include <map_fragment>", `#include <map_fragment>
          #ifdef USE_MAP
            float lum = dot(diffuseColor.rgb, vec3(.2126, .7152, .0722));
            diffuseColor.rgb = mix(vec3(lum), diffuseColor.rgb, 1.08);
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * diffuseColor.rgb * 1.6, .1);
          #endif
          #ifdef USE_PROC
            float slope = 1. - clamp(vWN.y, 0., 1.);
            float n1 = fbm(vWXZ * .0035), n2 = fbm(vWXZ * .028), n3 = vnoise(vWXZ * .22);
            vec3 grass = mix(vec3(.30, .42, .15), vec3(.47, .56, .22), n2);
            vec3 forest = vec3(.12, .22, .10) * (.75 + .5 * n3);
            vec3 pasture = mix(vec3(.52, .52, .30), vec3(.45, .46, .33), n2);
            vec3 rock = mix(vec3(.40, .39, .37), vec3(.62, .60, .56), n2 * .8 + n3 * .2);
            float tree = smoothstep(.47, .55, n1 + .12 * n2) * (1. - smoothstep(1750., 2050., vWY + n2 * 140.)) * (1. - smoothstep(.5, .72, slope));
            vec3 c = mix(grass, forest, tree);
            c = mix(c, pasture, smoothstep(1950., 2350., vWY + n1 * 220.) * (1. - tree));
            float rk = max(smoothstep(.42, .66, slope + n2 * .14), smoothstep(2450., 2850., vWY + n1 * 260.) * .9);
            c = mix(c, rock, rk);
            diffuseColor.rgb = pow(c, vec3(2.2));
          #endif`)
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
          // micro relief: small bumps and gullies the elevation data is too coarse to show
          {
            float bh = fbm(vWXZ * .055) * 7. + vnoise(vWXZ * .45) * .9;
            vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition); float dhx = dFdx(bh), dhy = dFdy(bh);
            vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx); float det = dot(dpx, r1);
            normal = normalize(abs(det) * normal - sign(det) * (dhx * r1 + dhy * r2) * uBump);
          }
          // snow cover from the live weather and the season, settling on gentler slopes first
          {
            vec3 upV = normalize((viewMatrix * vec4(0., 1., 0., 0.)).xyz); float flatness = dot(normal, upV);
            float line = uSnowLine + (fbm(vWXZ * .004) - .5) * 280. + vnoise(vWXZ * .09) * 45.;
            float cover = smoothstep(line - 50., line + 140., vWY) * smoothstep(.5, .82, flatness) * uSnowAmt;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.86, .89, .94), cover);
            roughnessFactor = mix(roughnessFactor, .55, cover);
            diffuseColor.rgb *= 1. - .22 * uWet * (1. - cover); roughnessFactor = mix(roughnessFactor, .45, uWet * (1. - cover));
          }`);
    };
    return m;
  }
  const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
  const lat2y = (lat, z) => { const s = Math.sin((lat * Math.PI) / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z; };
  const y2lat = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(Math.sinh(n)); };
  const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
  function loadImage(url) {
    return new Promise((res, rej) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = () => rej(new Error(url)); im.src = url; });
  }
  function pump() { while (inflight < 6 && queue.length) { const job = queue.shift(); if (!tiles.has(job.key)) continue; inflight++; job.run().finally(() => { inflight--; pump(); }); } }
  function ensureTile(lv, x, y) {
    const key = `${lv.z}/${x}/${y}`; if (tiles.has(key)) { tiles.get(key).seen = performance.now(); return; }
    const t = { key, lv, x, y, mesh: null, seen: performance.now(), h: null };
    tiles.set(key, t);
    queue.push({ key, z: lv.z, run: () => buildTile(t) }); queue.sort((a, b) => b.z - a.z); pump();
  }
  const pal = [[0, "#6f8a52"], [900, "#7d9256"], [1500, "#8a9161"], [2000, "#8d8a78"], [2500, "#9a958c"], [2850, "#e9eef3"], [5000, "#ffffff"]].map(([h, c]) => [h, C(c)]);
  function colorFor(h, slope, out) {
    let a = pal[0], b = pal[pal.length - 1]; for (let i = 0; i < pal.length - 1; i++) if (h >= pal[i][0] && h < pal[i + 1][0]) { a = pal[i]; b = pal[i + 1]; break; }
    out.copy(a[1]).lerp(b[1], (h - a[0]) / (b[0] - a[0] || 1));
    if (slope > 0.9 && h < 2850) out.lerp(C("#7b7770"), Math.min(1, (slope - 0.9) * 1.5)); return out;
  }
  async function buildTile(t) {
    const { lv, x, y } = t; let img;
    try { img = await loadImage(TERRAIN(lv.z, x, y)); } catch { tiles.delete(t.key); return; }
    if (!tiles.has(t.key)) return;
    const cv = document.createElement("canvas"); cv.width = cv.height = 256; const g = cv.getContext("2d"); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, 256, 256).data;
    const H = (px, py) => { px = Math.max(0, Math.min(255, px)); py = Math.max(0, Math.min(255, py)); const i = (py * 256 + px) * 4; return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768; };
    const S = lv.segs, n = S + 1; const heights = new Float32Array(n * n);
    const pos = new Float32Array((n * n + 4 * n) * 3), col = new Float32Array((n * n + 4 * n) * 3), uv = new Float32Array((n * n + 4 * n) * 2);
    const c = new THREE.Color();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const fx = (i / S) * 255.999, fy = (j / S) * 255.999; const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
      const h = H(x0, y0) * (1 - ax) * (1 - ay) + H(x0 + 1, y0) * ax * (1 - ay) + H(x0, y0 + 1) * (1 - ax) * ay + H(x0 + 1, y0 + 1) * ax * ay;
      const la = y2lat(y + j / S, lv.z), lo = x2lon(x + i / S, lv.z); const [px, pz] = toXZ(la, lo);
      const k = j * n + i; heights[k] = h; pos.set([px, h - lv.drop, pz], k * 3); uv.set([i / S, 1 - j / S], k * 2);
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i; const hx = heights[j * n + Math.min(S, i + 1)] - heights[j * n + Math.max(0, i - 1)], hz = heights[Math.min(S, j + 1) * n + i] - heights[Math.max(0, j - 1) * n + i];
      const cell = ((40075016 * Math.cos((LAT0 * Math.PI) / 180)) / 2 ** lv.z / S) * 2; const slope = Math.hypot(hx, hz) / cell;
      colorFor(heights[k], slope, c); col.set([c.r, c.g, c.b], k * 3);
    }
    // skirts hide hairline cracks between neighbouring tiles
    const idx = []; for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const a = j * n + i, b = a + 1, cc = a + n, dd = cc + 1; idx.push(a, cc, b, b, cc, dd); }
    let v = n * n; const edges = [[...Array(n).keys()].map((i) => i), [...Array(n).keys()].map((i) => S * n + i), [...Array(n).keys()].map((j) => j * n), [...Array(n).keys()].map((j) => j * n + S)];
    for (const e of edges) { const base = v; for (const k of e) { pos.set([pos[k * 3], pos[k * 3 + 1] - 60, pos[k * 3 + 2]], v * 3); col.set(col.subarray(k * 3, k * 3 + 3), v * 3); uv.set(uv.subarray(k * 2, k * 2 + 2), v * 2); v++; } for (let q = 0; q < e.length - 1; q++) idx.push(e[q], base + q, e[q + 1], e[q + 1], base + q, base + q + 1); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("color", new THREE.BufferAttribute(col, 3)); geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals();
    const mat = terrainMaterial(lv, {});
    const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = -lv.z; scene.add(mesh); t.mesh = mesh; t.h = heights;
    loadImagery(t);
  }
  async function loadImagery(t) {
    const { lv, x, y } = t; const k = 2 ** (lv.img - lv.z); const size = 256 * k;
    const cv = document.createElement("canvas"); cv.width = cv.height = size; const g = cv.getContext("2d");
    let ok = 0;
    await Promise.all([...Array(k * k).keys()].map(async (q) => { const dx = q % k, dy = Math.floor(q / k); try { const im = await loadImage(IMAGERY(lv.img, x * k + dx, y * k + dy)); g.drawImage(im, dx * 256, dy * 256); ok++; } catch {} }));
    if (ok < k * k || !t.mesh || !tiles.has(t.key)) return; // outside Switzerland or offline: keep the painted terrain
    const tex = new THREE.CanvasTexture(cv); tex.anisotropy = renderer.capabilities.getMaxAnisotropy(); tex.encoding = THREE.sRGBEncoding;
    t.mesh.material.dispose(); t.mesh.material = terrainMaterial(lv, { map: tex });
    if (lv.trees) plantTrees(t, g, size);
  }
  /* ---------- 3D forests ----------
     Near the train, every dark-green forest pixel in the aerial photo becomes a real tree:
     spruce and fir in dark greens, and in autumn the larches turn gold, as they do in the Engadin. */
  const TREE_GEO = (() => {
    const parts = [[new THREE.CylinderGeometry(0.3, 0.42, 3, 5), 1.5, [0.25, 0.18, 0.12]], [new THREE.ConeGeometry(2.7, 13, 8), 8.5, [0.92, 0.95, 0.92]], [new THREE.ConeGeometry(1.7, 8, 7), 14.5, [1, 1, 1]]]; // slim alpine spruce
    const pos = [], nor = [], col = [];
    for (const [g0, y, c] of parts) { const g = g0.toNonIndexed(); g.translate(0, y, 0); pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array); for (let i = 0; i < g.attributes.position.count; i++) col.push(...c); }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); return g;
  })();
  const TREE_MAT = new THREE.MeshLambertMaterial({ vertexColors: true });
  const routeGrid = new Map(); { const R = ROUTES.fwd; for (let i = 0; i < N; i++) { const k = Math.floor(R.X[i] / 40) + "," + Math.floor(R.Z[i] / 40); (routeGrid.get(k) || routeGrid.set(k, []).get(k)).push(i); } }
  function nearTrack(x, z, d) { const cx = Math.floor(x / 40), cz = Math.floor(z / 40); const R = ROUTES.fwd; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const i of routeGrid.get((cx + a) + "," + (cz + b)) || []) if (Math.hypot(R.X[i] - x, R.Z[i] - z) < d) return true; return false; }
  const autumn = [9, 10].includes(new Date().getMonth());
  function plantTrees(t, g, size) {
    const { lv, x, y } = t; const S = lv.segs, n = S + 1; const px = g.getImageData(0, 0, size, size).data;
    const lat = y2lat(y + 0.5, lv.z); const tileM = (40075016 * Math.cos((lat * Math.PI) / 180)) / 2 ** lv.z; const step = (LITE ? 34 : 13) / tileM;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    const out = []; let seed = (x * 73856093) ^ (y * 19349663); const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let v = step / 2; v < 1; v += step) for (let u = step / 2; u < 1; u += step) {
      const uu = Math.min(0.999, u + (rnd() - 0.5) * step), vv = Math.min(0.999, v + (rnd() - 0.5) * step);
      const i4 = (Math.floor(vv * size) * size + Math.floor(uu * size)) * 4; const r = px[i4], gg = px[i4 + 1], b = px[i4 + 2]; const lum = (r + gg + b) / 3;
      if (!(gg > r + 3 && gg >= b - 8 && lum < 95 && lum > 10)) continue;              // forest pixels: dark, green-dominant
      const fx = uu * S, fy = vv * S, i = Math.floor(fx), j = Math.floor(fy), ax = fx - i, ay = fy - j; const H = t.h;
      const h = H[j * n + i] * (1 - ax) * (1 - ay) + H[j * n + i + 1] * ax * (1 - ay) + H[(j + 1) * n + i] * (1 - ax) * ay + H[(j + 1) * n + i + 1] * ax * ay;
      const sl = Math.hypot(H[j * n + i + 1] - H[j * n + i], H[(j + 1) * n + i] - H[j * n + i]) / (tileM / S); if (h > 2200 || sl > 1.3) continue;
      const [wx, wz] = toXZ(y2lat(y + vv, lv.z), x2lon(x + uu, lv.z)); if (nearTrack(wx, wz, 24)) continue;
      out.push([wx, h, wz]); if (out.length >= 9000) break;
    }
    if (!out.length || !tiles.has(t.key)) return;
    const im = new THREE.InstancedMesh(TREE_GEO, TREE_MAT, out.length);
    out.forEach(([wx, h, wz], k) => {
      const s = 0.65 + rnd() * 0.7; const w = s * (0.75 + rnd() * 0.4); q.setFromAxisAngle(up, rnd() * 6.28); m4.compose(ps.set(wx, h - 0.6, wz), q, sc.set(w, s * (0.85 + rnd() * 0.4), w)); im.setMatrixAt(k, m4);
      if (autumn && rnd() < 0.22 && h > 1100) col.setHSL(0.105 + rnd() * 0.025, 0.5 + rnd() * 0.15, 0.34 + rnd() * 0.07); else col.setHSL(0.3 + rnd() * 0.06, 0.28 + rnd() * 0.14, 0.1 + rnd() * 0.06);
      im.setColorAt(k, col.convertSRGBToLinear());
    });
    im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
    scene.add(im); t.trees = im;
  }

  function updateTiles(lat, lon) {
    for (const lv of LEVELS) {
      const cx = Math.floor(lon2x(lon, lv.z)), cy = Math.floor(lat2y(lat, lv.z));
      for (let dy = -lv.r; dy <= lv.r; dy++) for (let dx = -lv.r; dx <= lv.r; dx++) ensureTile(lv, cx + dx, cy + dy);
      lv.cx = cx; lv.cy = cy;
    }
    for (let i = 1; i < LEVELS.length; i++) {
      const f = LEVELS[i - 1]; let ready = true;
      for (let dy = -f.r; dy <= f.r && ready; dy++) for (let dx = -f.r; dx <= f.r; dx++) { const t = tiles.get(`${f.z}/${f.cx + dx}/${f.cy + dy}`); if (!t || !t.mesh) { ready = false; break; } }
      if (!ready) { LEVELS[i].hole.value.set(0, 0, 0, 0); continue; }
      const [x0, z0] = toXZ(y2lat(f.cy - f.r, f.z), x2lon(f.cx - f.r, f.z)), [x1, z1] = toXZ(y2lat(f.cy + f.r + 1, f.z), x2lon(f.cx + f.r + 1, f.z));
      const inset = 25; LEVELS[i].hole.value.set(Math.min(x0, x1) + inset, Math.min(z0, z1) + inset, Math.max(x0, x1) - inset, Math.max(z0, z1) - inset);
    }
    const nowT = performance.now();
    for (const [k, t] of tiles) if (nowT - t.seen > 20000) { if (t.trees) { scene.remove(t.trees); t.trees.dispose?.(); } if (t.mesh) { scene.remove(t.mesh); t.mesh.geometry.dispose(); if (t.mesh.material.map) t.mesh.material.map.dispose(); t.mesh.material.dispose(); } tiles.delete(k); }
  }
  function groundAt(x, z) {
    const [lat, lon] = toLL(x, z);
    for (const lv of LEVELS) {
      const fx = lon2x(lon, lv.z), fy = lat2y(lat, lv.z); const t = tiles.get(`${lv.z}/${Math.floor(fx)}/${Math.floor(fy)}`); if (!t || !t.h) continue;
      const S = lv.segs, n = S + 1; const i = Math.min(S - 1, Math.floor((fx % 1) * S)), j = Math.min(S - 1, Math.floor((fy % 1) * S));
      return Math.max(t.h[j * n + i], t.h[j * n + i + 1], t.h[(j + 1) * n + i], t.h[(j + 1) * n + i + 1]) - lv.drop;
    }
    return -1e9;
  }

  /* ---------- the railway itself: track, bridges, tunnel portals ---------- */
  {
    const R = ROUTES.fwd; const pos = [], idx = [], uvs = []; const W = 1.6;
    let open = false;
    for (let i = 1; i < N - 1; i++) {
      if (R.F[i] === 1) { open = false; continue; }
      const hx = R.X[i + 1] - R.X[i - 1], hz = R.Z[i + 1] - R.Z[i - 1], l = Math.hypot(hx, hz) || 1; const nx = -hz / l, nz = hx / l;
      const y = R.Y[i] + 0.35; const v = pos.length / 3;
      pos.push(R.X[i] + nx * W, y, R.Z[i] + nz * W, R.X[i] - nx * W, y, R.Z[i] - nz * W); const along = (i * raw.step) / 4; uvs.push(0, along, 1, along);
      if (open) idx.push(v - 2, v - 1, v, v - 1, v + 1, v);
      open = true;
    }
    // ballast, sleepers and two steel rails, painted once into a repeating texture
    const tc = document.createElement("canvas"); tc.width = 64; tc.height = 512; const tg = tc.getContext("2d");
    for (let y = 0; y < 512; y += 2) for (let x = 0; x < 64; x += 2) { const v = 100 + Math.random() * 40; tg.fillStyle = `rgb(${v},${v - 6},${v - 14})`; tg.fillRect(x, y, 2, 2); }
    for (let y = 8; y < 512; y += 64) { tg.fillStyle = "#4a3b30"; tg.fillRect(6, y, 52, 18); tg.fillStyle = "rgba(255,255,255,.06)"; tg.fillRect(6, y, 52, 3); }
    for (const x of [17, 44]) { tg.fillStyle = "#2b2b30"; tg.fillRect(x, 0, 4, 512); tg.fillStyle = "#b9bcc2"; tg.fillRect(x + 1, 0, 1, 512); }
    const ttex = new THREE.CanvasTexture(tc); ttex.wrapS = ttex.wrapT = THREE.RepeatWrapping; ttex.anisotropy = renderer.capabilities.getMaxAnisotropy(); ttex.encoding = THREE.sRGBEncoding;
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(idx); g.computeVertexNormals();
    const track = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: ttex, roughness: 0.9, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 })); scene.add(track);
    // overhead line: a mast every 55 m beside the track and the contact wire above it
    const mastGeo = (() => { const a = new THREE.BoxGeometry(0.28, 7.6, 0.28).toNonIndexed(); a.translate(0, 3.8, 0); const b = new THREE.BoxGeometry(3.1, 0.14, 0.14).toNonIndexed(); b.translate(-1.45, 7.1, 0);
      const gg = new THREE.BufferGeometry(); gg.setAttribute("position", new THREE.Float32BufferAttribute([...a.attributes.position.array, ...b.attributes.position.array], 3)); gg.setAttribute("normal", new THREE.Float32BufferAttribute([...a.attributes.normal.array, ...b.attributes.normal.array], 3)); return gg; })();
    const mastSpots = []; for (let i = 0; i < N; i += Math.round(55 / raw.step)) if (R.F[i] !== 1) mastSpots.push(i);
    const masts = new THREE.InstancedMesh(mastGeo, new THREE.MeshStandardMaterial({ color: 0x6d7076, roughness: 0.6, metalness: 0.4 }), mastSpots.length);
    const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), up4 = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p4 = new THREE.Vector3();
    mastSpots.forEach((i, k) => { const j = Math.min(N - 1, i + 1), h = Math.max(0, i - 1); const hx = R.X[j] - R.X[h], hz = R.Z[j] - R.Z[h]; const l = Math.hypot(hx, hz) || 1; const rx = -hz / l, rz = hx / l;
      q4.setFromAxisAngle(up4, Math.atan2(-rz, rx)); m4.compose(p4.set(R.X[i] + rx * 3.1, R.Y[i], R.Z[i] + rz * 3.1), q4, one); masts.setMatrixAt(k, m4); });
    masts.frustumCulled = false; scene.add(masts);
    const wire = []; for (let i = 1; i < N; i++) if (R.F[i] !== 1 && R.F[i - 1] !== 1) wire.push(R.X[i - 1], R.Y[i - 1] + 6.3, R.Z[i - 1], R.X[i], R.Y[i] + 6.3, R.Z[i]);
    const wg = new THREE.BufferGeometry(); wg.setAttribute("position", new THREE.Float32BufferAttribute(wire, 3));
    scene.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x2a2a2e, transparent: true, opacity: 0.8 })));
    // bridge piers every 20 m
    const stone = new THREE.MeshLambertMaterial({ color: 0xb9ad98 }); const pier = new THREE.BoxGeometry(3.2, 80, 3.2); pier.translate(0, -40, 0);
    for (const [a, b] of raw.bridges) { if (b - a < 0.06) continue; for (let km = a + 0.01; km < b; km += 0.02) { const p = R.at(km); const m = new THREE.Mesh(pier, stone); m.position.set(p.x, p.y - 0.5, p.z); scene.add(m); } }
    // tunnel portals
    const portal = new THREE.BoxGeometry(7, 7.5, 1.2); portal.translate(0, 3.5, 0); const dark = new THREE.MeshLambertMaterial({ color: 0x0b0a0c });
    for (const [a, b] of raw.tunnels) for (const km of [a, b]) { const p = R.at(km); const m = new THREE.Mesh(portal, dark); m.position.set(p.x, p.y, p.z); m.rotation.y = Math.atan2(p.hx, p.hz); scene.add(m); }
  }


  /* ---------- villages: buildings within ~300 m of the track ---------- */
  // Two repeating wall textures: dark larch planks with small shuttered windows, and white plaster.
  function wallTexture(wood) {
    const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d");
    if (wood) { for (let x = 0; x < 128; x += 4) { const v = 70 + Math.random() * 30; g.fillStyle = `rgb(${v + 22},${v},${v - 20})`; g.fillRect(x, 0, 4, 128); g.fillStyle = "rgba(0,0,0,.28)"; g.fillRect(x, 0, 1, 128); } }
    else { g.fillStyle = "#ece7dc"; g.fillRect(0, 0, 128, 128); for (let i = 0; i < 500; i++) { g.fillStyle = `rgba(120,110,95,${Math.random() * 0.08})`; g.fillRect(Math.random() * 128, Math.random() * 128, 3, 3); } }
    for (const [x, y] of [[22, 28], [78, 28], [22, 84], [78, 84]]) {
      if (wood) { g.fillStyle = "#e9e4da"; g.fillRect(x - 2, y - 2, 28, 24); }
      g.fillStyle = "#1f2228"; g.fillRect(x, y, 24, 20); g.fillStyle = "rgba(160,190,220,.25)"; g.fillRect(x + 2, y + 2, 8, 6);
      g.fillStyle = wood ? "#8a2a24" : "#4f6b46"; g.fillRect(x - 8, y, 6, 20); g.fillRect(x + 26, y, 6, 20);
    }
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  // style: [wall tint, uses wood half of the atlas, roof colour]
  const BSTYLE = [[C("#ffffff"), 1, C("#3f3a36")], [C("#ffffff"), 0, C("#55575d")], [C("#b9ad98"), 0, C("#4b4e55")], [C("#c9c6be"), 0, C("#6c6e72")], [C("#f4f0e6"), 0, C("#3c4a52")]];
  const snowify = (m) => { m.onBeforeCompile = (sh) => { sh.uniforms.uSnowRoof = WXU.uSnowAmt; sh.uniforms.uSnowLine2 = WXU.uSnowLine;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying float vWY2;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvWY2 = (modelMatrix * vec4(transformed, 1.)).y;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform float uSnowRoof, uSnowLine2; varying float vWY2;").replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n{ vec3 upV = normalize((viewMatrix * vec4(0.,1.,0.,0.)).xyz); float f = smoothstep(.35, .75, dot(normal, upV)) * uSnowRoof * smoothstep(uSnowLine2 - 150., uSnowLine2 + 50., vWY2); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.9,.92,.96), f); }"); }; return m; };
  const wallMats = [snowify(new THREE.MeshStandardMaterial({ map: wallTexture(false), vertexColors: true, roughness: 0.9, side: THREE.DoubleSide })), snowify(new THREE.MeshStandardMaterial({ map: wallTexture(true), vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }))];
  const roofMat = snowify(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }));
  const bChunks = new Map();
  async function loadBuildings(ci) {
    if (bChunks.has(ci)) return; const entry = { meshes: [] }; bChunks.set(ci, entry);
    let list; try { list = await (await fetch(`data/buildings/${ci}.json`)).json(); } catch { return; }
    const W2 = [{ p: [], u: [], c: [] }, { p: [], u: [], c: [] }], rp = [], rc = []; const col = new THREE.Color();
    for (const b of list) {
      const h = b[0] / 2, st = BSTYLE[b[1]] || BSTYLE[1], pitched = b[2] === 1, base = b[3];
      const pts = []; for (let i = 4; i < b.length; i += 2) pts.push(toXZ(b[i], b[i + 1]));
      const eave = pitched ? Math.max(2.8, h * 0.62) : h; const jitter = 0.92 + ((pts[0][0] * 13.1 + pts[0][1]) % 1 + 1) % 1 * 0.12;
      col.copy(st[0]).multiplyScalar(jitter); const wb = W2[st[1]]; const wp = wb.p, wu = wb.u, wc = wb.c;
      for (let i = 0; i < pts.length; i++) { // walls
        const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length]; const len = Math.hypot(x2 - x1, z2 - z1); const u0 = 0, uw = Math.max(1, Math.round(len / 4));
        const y0 = base - 3, y1 = base + eave;
        wp.push(x1, y0, z1, x2, y0, z2, x2, y1, z2, x1, y0, z1, x2, y1, z2, x1, y1, z1);
        const vT = eave / 4, a = u0, bb = u0 + uw; wu.push(a, -0.75, bb, -0.75, bb, vT, a, -0.75, bb, vT, a, vT);
        for (let k = 0; k < 6; k++) wc.push(col.r, col.g, col.b);
      }
      const rcol = st[2].clone().multiplyScalar(0.9 + jitter * 0.1);
      const tri = (a, b2, c) => { rp.push(...a, ...b2, ...c); for (let k = 0; k < 3; k++) rc.push(rcol.r, rcol.g, rcol.b); };
      if (!pitched) {
        const tris = THREE.ShapeUtils.triangulateShape(pts.map(([x, z]) => new THREE.Vector2(x, z)), []);
        for (const [a, b2, c] of tris) tri([pts[a][0], base + eave, pts[a][1]], [pts[b2][0], base + eave, pts[b2][1]], [pts[c][0], base + eave, pts[c][1]]);
      } else {
        // gable roof over the footprint's longest side, with eaves overhanging
        let best = 0, bl = 0; for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; const l = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]); if (l > bl) { bl = l; best = i; } }
        const j = (best + 1) % pts.length; const ux = (pts[j][0] - pts[best][0]) / bl, uz = (pts[j][1] - pts[best][1]) / bl, vx = -uz, vz = ux;
        let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9; for (const [x, z] of pts) { const a = x * ux + z * uz, bb = x * vx + z * vz; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, bb); b1 = Math.max(b1, bb); }
        const o = 0.7; a0 -= o; a1 += o; const bm = (b0 + b1) / 2; b0 -= o; b1 += o;
        const ridge = base + h, e = base + eave - 0.35; const P3 = (a, bb, y) => [ux * a + vx * bb, y, uz * a + vz * bb];
        const A = P3(a0, b0, e), B = P3(a1, b0, e), Cc = P3(a1, b1, e), D = P3(a0, b1, e), R1 = P3(a0, bm, ridge), R2 = P3(a1, bm, ridge);
        tri(A, B, R2); tri(A, R2, R1); tri(D, R1, R2); tri(D, R2, Cc);
        const g0 = P3(a0 + o, b0 + o, base + eave), g1 = P3(a0 + o, b1 - o, base + eave), g2 = P3(a0 + o, bm, ridge), g3 = P3(a1 - o, b0 + o, base + eave), g4 = P3(a1 - o, b1 - o, base + eave), g5 = P3(a1 - o, bm, ridge);
        // gable ends in the wall material
        for (const [p1, p2, p3] of [[g0, g1, g2], [g3, g5, g4]]) { wp.push(...p1, ...p2, ...p3); wu.push(0.05, 0.2, 0.95, 0.2, 0.5, 0.6); for (let k = 0; k < 3; k++) wc.push(col.r, col.g, col.b); }
      }
    }
    if (bChunks.get(ci) !== entry) return;
    for (const [P, U, Cl, mat] of [[W2[0].p, W2[0].u, W2[0].c, wallMats[0]], [W2[1].p, W2[1].u, W2[1].c, wallMats[1]], [rp, null, rc, roofMat]]) {
      if (!P.length) continue; const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); if (U) g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2)); g.setAttribute("color", new THREE.Float32BufferAttribute(Cl, 3)); g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat); scene.add(m); entry.meshes.push(m);
    }
  }
  function updateBuildings(kmFwd) {
    const B = raw.buildings; if (!B) return; const ck = B.chunkKm; const want = new Set();
    for (const ci of B.chunks) if (Math.abs((ci + 0.5) * ck - kmFwd) < ck + 6) want.add(ci);
    for (const ci of want) loadBuildings(ci);
    for (const [ci, e] of bChunks) if (!want.has(ci)) { e.meshes.forEach((m) => { scene.remove(m); m.geometry.dispose(); }); bChunks.delete(ci); }
  }

  /* ---------- birds: a flock of alpine choughs and a golden eagle riding the thermals ---------- */
  const birdGeo = (() => { const g = new THREE.BufferGeometry();
    const v = [0, 0, 0.55, -0.12, 0, -0.5, 0.12, 0, -0.5, /* body */ 0, 0, 0.15, -1.15, 0, -0.15, 0, 0, -0.3, /* left wing */ 0, 0, 0.15, 0, 0, -0.3, 1.15, 0, -0.15 /* right wing */];
    g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals(); return g; })();
  const birdMat = new THREE.MeshBasicMaterial({ color: 0x1b1a1d, side: THREE.DoubleSide, transparent: true, opacity: 1 });
  const birdU = { uT: { value: 0 } };
  birdMat.onBeforeCompile = (sh) => { sh.uniforms.uT = birdU.uT; sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nuniform float uT; attribute float aPhase;").replace("#include <begin_vertex>", "#include <begin_vertex>\nfloat flap = sin(uT * (aPhase > 50. ? 1.2 : 11.) + aPhase) * (aPhase > 50. ? .08 : .55); transformed.y += abs(transformed.x) * flap;"); };
  const NB = 26; const birds = new THREE.InstancedMesh(birdGeo, birdMat, NB + 1); birds.frustumCulled = false; scene.add(birds);
  const phases = new Float32Array(NB + 1); for (let i = 0; i < NB; i++) phases[i] = Math.random() * 6.28; phases[NB] = 99; birdGeo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
  const flock = Array.from({ length: NB }, (_, i) => ({ o: new THREE.Vector3((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 30), s: 0.6 + Math.random() * 0.3, k: Math.random() * 100 }));
  const bm4 = new THREE.Matrix4(), bq = new THREE.Quaternion(), bsc = new THREE.Vector3(), bp = new THREE.Vector3(), bfwd = new THREE.Vector3(), zAxis = new THREE.Vector3(0, 0, 1);
  function updateBirds(t, cam, show) {
    birds.visible = show; if (!show) return; const s = t / 1000; birdU.uT.value = s;
    // the flock wanders in loose loops a couple of hundred metres from the train
    const cx = cam.x + Math.sin(s * 0.05) * 220 + Math.sin(s * 0.13) * 60, cz = cam.z + Math.cos(s * 0.043) * 220, cy = cam.y + 70 + Math.sin(s * 0.09) * 30;
    const vx = Math.cos(s * 0.05) * 11 + Math.cos(s * 0.13) * 7.8, vz = -Math.sin(s * 0.043) * 9.5; const vl = Math.hypot(vx, vz) || 1;
    flock.forEach((b, i) => {
      bp.set(cx + b.o.x + Math.sin(s * 0.7 + b.k) * 6, cy + b.o.y + Math.sin(s * 0.9 + b.k * 2) * 3, cz + b.o.z + Math.cos(s * 0.6 + b.k) * 6);
      bfwd.set(vx / vl, Math.sin(s * 0.9 + b.k) * 0.15, vz / vl).normalize(); bq.setFromUnitVectors(zAxis, bfwd); bm4.compose(bp, bq, bsc.setScalar(b.s)); birds.setMatrixAt(i, bm4);
    });
    // the eagle: slow wide circles high above
    const ea = s * 0.08; bp.set(cam.x + Math.cos(ea) * 380, cam.y + 260 + Math.sin(s * 0.05) * 30, cam.z + Math.sin(ea) * 380);
    bfwd.set(-Math.sin(ea), 0, Math.cos(ea)); bq.setFromUnitVectors(zAxis, bfwd); bm4.compose(bp, bq, bsc.setScalar(2.6)); birds.setMatrixAt(NB, bm4);
    birds.instanceMatrix.needsUpdate = true;
  }

  /* ---------- rain and snow ---------- */
  const PCOUNT = LITE ? 3000 : 16000; const BOX = new THREE.Vector3(140, 70, 140);
  const pGeo = new THREE.BufferGeometry(); { const pp = new Float32Array(PCOUNT * 3), rr = new Float32Array(PCOUNT); for (let i = 0; i < PCOUNT; i++) { pp[i * 3] = Math.random() * BOX.x; pp[i * 3 + 1] = Math.random() * BOX.y; pp[i * 3 + 2] = Math.random() * BOX.z; rr[i] = Math.random(); } pGeo.setAttribute("position", new THREE.BufferAttribute(pp, 3)); pGeo.setAttribute("aR", new THREE.BufferAttribute(rr, 1)); }
  const pU = { uT: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: BOX }, uFall: { value: 9 }, uWind: { value: new THREE.Vector2() }, uSnow: { value: 0 }, uAmt: { value: 0 }, uLight: { value: 1 } };
  const precip = new THREE.Points(pGeo, new THREE.ShaderMaterial({
    uniforms: pU, transparent: true, depthWrite: false,
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float uT, uFall, uSnow, uAmt; uniform vec3 uCam, uBox; uniform vec2 uWind; attribute float aR; varying float vA; varying float vR;
      void main(){
        vec3 p = position; float t = uT;
        vec3 drift = vec3(uWind.x * t, -uFall * (.75 + .5 * aR) * t, uWind.y * t);
        if (uSnow > .5) drift.xz += vec2(sin(t * .9 + aR * 40.), cos(t * .7 + aR * 30.)) * 1.2;
        vec3 w = mod(p + drift - uCam + uBox * .5, uBox) - uBox * .5 + uCam;
        vec4 mv = modelViewMatrix * vec4(w, 1.);
        vA = step(aR, uAmt) * smoothstep(70., 8., length(mv.xyz)); vR = aR;
        gl_PointSize = (uSnow > .5 ? 2.4 : 5.5) * 160. / -mv.z;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uSnow, uLight; varying float vA; varying float vR;
      void main(){
        #include <logdepthbuf_fragment>
        vec2 c = gl_PointCoord - .5; float a;
        if (uSnow > .5) a = smoothstep(.5, .15, length(c)) * .95;
        else a = smoothstep(.07, .0, abs(c.x)) * smoothstep(.5, .05, abs(c.y)) * .7;
        if (vA * a < .01) discard;
        gl_FragColor = vec4(vec3(uSnow > .5 ? .97 : .82) * uLight, vA * a);
      }`
  }));
  precip.frustumCulled = false; scene.add(precip);

  /* ---------- the window glass: raindrops and snowflakes ---------- */
  const dropsCv = $("#drops"), dg = dropsCv.getContext("2d"); let drops = []; let lastDrops = 0;
  function sizeDrops() { const r = document.querySelector(".frame .glass").getBoundingClientRect(); Object.assign(dropsCv.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", borderRadius: getComputedStyle(document.querySelector(".frame .glass")).borderRadius }); dropsCv.width = Math.round(r.width * Math.min(2, devicePixelRatio)); dropsCv.height = Math.round(r.height * Math.min(2, devicePixelRatio)); }
  addEventListener("resize", sizeDrops); sizeDrops();
  function updateDrops(dt, inTunnel, kmh) {
    dt = Math.min(dt, 0.05);
    const W = dropsCv.width, H = dropsCv.height, k = W / Math.max(1, dropsCv.clientWidth);
    const wet = inTunnel ? 0 : WX.rain, flakes = inTunnel ? 0 : WX.snow;
    const dirX = view === "left" ? -1 : view === "right" ? 1 : 0; const push = Math.min(1, kmh / 70);
    for (let n = 0; n < Math.round((wet * 40 + flakes * 18) * dt); n++) drops.push({ x: Math.random() * W, y: Math.random() * H, r: (flakes > wet ? 1.2 + Math.random() * 2 : 1.5 + Math.random() * 3.5) * k, life: flakes > wet ? 3 + Math.random() * 3 : 6 + Math.random() * 8, age: 0, snow: flakes > wet, run: Math.random() < 0.35 });
    if (drops.length > 260) drops.splice(0, drops.length - 260);
    dg.clearRect(0, 0, W, H);
    drops = drops.filter((d) => (d.age += dt) < d.life);
    for (const d of drops) {
      const fade = Math.min(1, (d.life - d.age) / 1.5);
      if (d.snow) { dg.fillStyle = `rgba(255,255,255,${0.75 * fade})`; dg.beginPath(); dg.arc(d.x, d.y, d.r, 0, 7); dg.fill(); continue; }
      if (d.run && (push > 0.2 || d.r > 3 * k)) { // big drops and the airflow at speed make drops run across the glass
        const vx = dir0(dirX, d) * push * 120 * k, vy = (40 + (dirX ? 0 : 0)) * k * (1 - push * 0.6); const ox = d.x, oy = d.y; d.x += vx * dt; d.y += vy * dt;
        dg.strokeStyle = `rgba(210,225,240,${0.12 * fade})`; dg.lineWidth = d.r * 0.7; dg.beginPath(); dg.moveTo(ox - vx * 0.08, oy - vy * 0.08); dg.lineTo(d.x, d.y); dg.stroke();
      }
      const g = dg.createRadialGradient(d.x - d.r * 0.3, d.y - d.r * 0.3, d.r * 0.1, d.x, d.y, d.r);
      g.addColorStop(0, `rgba(255,255,255,${0.55 * fade})`); g.addColorStop(0.6, `rgba(190,205,220,${0.18 * fade})`); g.addColorStop(1, `rgba(20,25,35,${0.35 * fade})`);
      dg.fillStyle = g; dg.beginPath(); dg.arc(d.x, d.y, d.r, 0, 7); dg.fill();
    }
  }
  const dir0 = (dirX, d) => (dirX !== 0 ? dirX : (d.x < dropsCv.width / 2 ? -1 : 1)); // front window: drops spread outwards

  /* ---------- live weather ---------- */
  const DEMO_W = params.get("weather"); let wxAt = null, wxTime = 0, nextStrike = 0;
  async function refreshWeather(lat, lon, ele) {
    if (DEMO_W) { WX.info = WSWeather.demo(DEMO_W); }
    else { try { WX.info = await WSWeather.fetchAt(lat, lon, ele); } catch { WX.info = WX.info || null; } }
    if (!wxAt || !WX.ready) WX.snap = true; WX.ready = true; // first reading: show it straight away, later changes fade in
    wxAt = [lat, lon]; wxTime = Date.now(); renderWeatherChip();
  }
  function renderWeatherChip() {
    const el = $("#wx"); const w = WX.info; if (!w) { el.hidden = true; return; } el.hidden = false;
    const icon = w.storm ? "⛈" : w.snow ? "❄" : w.rain ? "☂" : w.fog ? "≋" : w.cover > 0.75 ? "☁" : w.cover > 0.35 ? "⛅" : "☀";
    el.innerHTML = `<span aria-hidden="true">${icon}</span> ${w.temp != null ? Math.round(w.temp) + "°C · " : ""}${esc(w.label)}${w.demo ? " <small>(demo)</small>" : ""}`;
    el.title = w.demo ? "Demo weather from the URL" : "Live weather at the train's position, from Open-Meteo";
  }
  function weatherTick(dt, t, p, tun) {
    const w = WX.info || { cover: 0.25, rain: 0, snow: 0, storm: 0, vis: 40000, wind: 8, windDir: 270, snowDepth: 0, fog: 0 };
    const k = WX.snap ? 1 : 1 - Math.exp(-dt / 4); WX.snap = false; // ease towards the target over a few seconds
    WX.cover += (w.cover - WX.cover) * k; WX.rain += (w.rain - WX.rain) * k; WX.snow += (w.snow - WX.snow) * k;
    WX.grey += (Math.min(1, Math.max(0, (w.cover - 0.55) * 1.6) + w.rain * 0.6 + w.snow * 0.6 + w.fog * 0.7) - WX.grey) * k;
    WX.vis += ((w.vis ?? 40000) - WX.vis) * k;
    WX.wind = w.wind; WX.windDir = w.windDir;
    // snow lying on the ground: season, plus the measured snow depth at the train
    const month = new Date(t).getMonth(); let line = SEASON_SNOW[month];
    if (w.snowDepth > 0.03) line = Math.min(line, p.y - 400); else if (w.snowDepth > 0) line = Math.min(line, p.y + 80);
    if (w.snow > 0.3 && (w.temp ?? 5) < 1) line = Math.min(line, p.y - 200);
    WXU.uSnowLine.value += (line - WXU.uSnowLine.value) * k; WXU.uWet.value += ((w.rain > 0.1 ? 1 : 0) - WXU.uWet.value) * k * 0.5;
    // precipitation particles
    const amt = tun ? 0 : Math.max(WX.rain, WX.snow); const snowy = WX.snow > WX.rain;
    pU.uT.value = (t / 1000) % 3600; pU.uCam.value.copy(camera.position); pU.uAmt.value = amt; pU.uSnow.value = snowy ? 1 : 0; pU.uFall.value = snowy ? 1.4 : 9.5;
    const wr = ((WX.windDir + 180) * Math.PI) / 180, ws = Math.min(14, WX.wind / 3.6) * (snowy ? 0.8 : 0.35); pU.uWind.value.set(Math.sin(wr) * ws, -Math.cos(wr) * ws);
    pU.uLight.value = 0.35 + 0.65 * skyU.uDay.value + WX.flash;
    // lightning
    WX.flash = Math.max(0, WX.flash - dt * 6);
    if (w.storm && !tun && t > nextStrike) {
      if (nextStrike) { WX.flash = 1; setTimeout(() => (WX.flash = 0.7), 120); const near = Math.random() < 0.35; flashScreen(); setTimeout(() => WSAudio.thunder(near), (near ? 400 : 1500 + Math.random() * 4000) / Math.max(1, PREVIEW || 1)); }
      nextStrike = t + (7000 + Math.random() * 20000) * Math.max(1, PREVIEW || 1);
    }
  }
  function flashScreen() { const f = $("#flash"); f.classList.remove("on"); void f.offsetWidth; f.classList.add("on"); }

  /* ---------- sound buttons ---------- */
  const musicBtn = $("#musicBtn"), soundBtn = $("#soundBtn");
  musicBtn.addEventListener("click", () => { const on = !WSAudio.musicOn; WSAudio.music(on); musicBtn.setAttribute("aria-pressed", on); store.set("music", on); });
  soundBtn.addEventListener("click", () => { const on = !WSAudio.ambienceOn; WSAudio.ambience(on); soundBtn.setAttribute("aria-pressed", on); store.set("sound", on); });

  /* ---------- journeys ---------- */
  const parseT = (s, ts) => (ts ? ts * 1000 : s ? Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) : NaN);
  async function fetchConnections(dir, when, limit) {
    const R = ROUTES[dir]; const vias = (dir === "rev" ? raw.via.slice().reverse() : raw.via);
    const q = new URLSearchParams({ from: R.from, to: R.to, date: fmtDate(when), time: fmtTime(when), limit: String(limit) });
    vias.forEach((v) => q.append("via[]", v));
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 12000);
    try { const res = await fetch(`${API}?${q}`, { signal: ctl.signal }); if (!res.ok) throw new Error("HTTP " + res.status); return (await res.json()).connections || []; }
    finally { clearTimeout(to); }
  }
  function journeyFromConnection(dir, c) {
    const R = ROUTES[dir]; const tl = []; const legs = []; let km = 0;
    for (const s of c.sections || []) {
      if (!s.journey) continue;
      const startKm = km;
      for (const p of s.journey.passList || []) {
        const co = p.station?.coordinate || p.location?.coordinate; if (!co || co.x == null) continue;
        const k = R.project(co.x, co.y, km); if (k == null) continue;
        const ta = parseT(p.prognosis?.arrival || p.arrival, p.prognosis?.arrival ? 0 : p.arrivalTimestamp);
        const td = parseT(p.prognosis?.departure || p.departure, p.prognosis?.departure ? 0 : p.departureTimestamp);
        const name = p.station?.name || p.location?.name || "";
        if (Number.isFinite(ta)) tl.push([ta, k, name]);
        if (Number.isFinite(td)) tl.push([td, k, name]);
        km = k;
      }
      const j = s.journey; legs.push({ cat: j.category || "", num: j.number || "", name: j.name || "", to: j.to || "", op: j.operator || "", from: startKm, toKm: km, gex: j.category === "PE" || /glacier/i.test(j.name || "") });
    }
    const clean = []; for (const e of tl.sort((a, b) => a[0] - b[0])) { const last = clean[clean.length - 1]; if (last && e[1] < last[1] - 0.2) continue; clean.push(e); }
    if (clean.length < 2) return null;
    return { dir, source: "live", dep: clean[0][0], arr: clean[clean.length - 1][0], tl: clean, legs, depLabel: parseT(c.from?.departure, c.from?.departureTimestamp) };
  }
  // Used only if live data can't be reached: a typical timetable, clearly labelled as an estimate.
  function estimatedJourneys(dir, around) {
    const R = ROUTES[dir]; const out = []; const base = new Date(around); base.setMinutes(52, 0, 0);
    for (let h = -9; h <= 2; h++) {
      const dep = base.getTime() + h * 3600000; let t = dep; const tl = [];
      R.stations.forEach(([name, km], i) => { if (i) t += ((km - R.stations[i - 1][1]) / 38) * 3600000; tl.push([t, km, name]); if (i && i < R.stations.length - 1) { t += 120000; tl.push([t, km, name]); } });
      out.push({ dir, source: "estimate", dep, arr: t, tl, legs: [{ cat: "", num: "", name: "Regional trains", to: R.to, from: 0, toKm: L }], depLabel: dep });
    }
    return out;
  }
  const ease = (u) => u - Math.sin(2 * Math.PI * u) / (2 * Math.PI); // gentle start and stop between stations
  function kmAt(j, t) {
    const tl = j.tl; if (t <= tl[0][0]) return tl[0][1]; if (t >= tl[tl.length - 1][0]) return tl[tl.length - 1][1];
    let i = 0; while (i < tl.length - 1 && tl[i + 1][0] <= t) i++;
    const a = tl[i], b = tl[i + 1]; if (b[0] === a[0]) return b[1];
    return a[1] + (b[1] - a[1]) * ease((t - a[0]) / (b[0] - a[0]));
  }

  /* ---------- state ---------- */
  let ride = store.get("ride", null); let dir = ride?.dir || "fwd"; let view = store.get("view", "left");
  let liveOK = null; const got = store.get("stamps", {});
  if (PREVIEW) { const d = new Date(); d.setUTCHours(8, 0, 0, 0); const e = estimatedJourneys("fwd", d.getTime()); ride = e[9]; ride.source = "preview"; // a morning departure, so the preview is in daylight
    dir = "fwd"; const k = +params.get("km") || 0; previewStart = ride.dep + (k / L) * (ride.arr - ride.dep) - 60000; }
  if (ride && now() > ride.arr + 30 * 60000) ride = null;

  /* ---------- boarding ---------- */
  const boardEl = $("#board"), tripsEl = $("#trips");
  function legsLabel(j) { const cats = [...new Set(j.legs.map((l) => (l.gex ? "Glacier Express" : `${l.cat}${l.num ? " " + l.num : ""}`).trim()).filter(Boolean))]; return cats.slice(0, 4).join(" · ") || "Regional trains"; }
  async function openBoard() {
    boardEl.hidden = false; tripsEl.innerHTML = "<p>Looking for trains on the line…</p>";
    $("#board .dir").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.d === dir));
    const t = now(); let list = [];
    try {
      const [a, b] = await Promise.all([fetchConnections(dir, new Date(t - 9 * 3600000), 16), fetchConnections(dir, new Date(t), 4)]);
      const seen = new Set();
      for (const c of [...a, ...b]) { const j = journeyFromConnection(dir, c); if (!j || seen.has(j.dep)) continue; seen.add(j.dep); list.push(j); }
      liveOK = true;
    } catch { liveOK = false; list = estimatedJourneys(dir, t); }
    const underway = list.filter((j) => j.dep <= t && j.arr > t).sort((p, q) => q.dep - p.dep);
    const upcoming = list.filter((j) => j.dep > t).sort((p, q) => p.dep - q.dep).slice(0, 3);
    const R = ROUTES[dir];
    const row = (j, up) => {
      const k = kmAt(j, t); const near = R.stations.filter((s) => s[1] <= k + 0.3).pop()?.[0] || R.from; const pct = Math.round((k / L) * 100);
      return `<button class="trip" type="button" data-dep="${j.dep}"><span class="t">${fmtTime(j.dep)}</span><span class="d"><b>${up ? `Departs in ${mins(j.dep - t)}` : `Near ${esc(near)}`}</b><span>${esc(legsLabel(j))} · arrives ${fmtTime(j.arr)}</span>${up ? "" : `<div class="bar"><i style="width:${pct}%"></i></div>`}</span><span class="p">${up ? "Board" : pct + "%"}</span></button>`;
    };
    tripsEl.innerHTML = (underway.length ? `<div class="sec">On the line now</div>${underway.map((j) => row(j, false)).join("")}` : `<p>No train is on the line right now. Trains run from early morning until the evening.</p>`) + (upcoming.length ? `<div class="sec">Next departures from ${esc(R.from)}</div>${upcoming.map((j) => row(j, true)).join("")}` : "");
    $("#board .card > p").textContent = liveOK ? "These are real trains crossing the Alps right now, on the route of the Glacier Express. Pick one and you'll ride along in real time. Leave and come back whenever you like: your train keeps going." : "Live train data isn't available right now, so you can ride along a typical timetable instead. The scenery is real; the train times are estimated.";
    $("#boardNote").textContent = liveOK ? "Live times and delays from transport.opendata.ch, the open Swiss public transport API." : "Live train data couldn't be reached, so these times are estimated from a typical timetable. They are not real trains.";
    tripsEl.querySelectorAll(".trip").forEach((b) => b.addEventListener("click", () => { ride = list.find((j) => j.dep === +b.dataset.dep); store.set("ride", ride); boardEl.hidden = true; startRide(); }));
  }
  $("#board .dir").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; dir = b.dataset.d; openBoard(); });
  $("#boardBtn").addEventListener("click", openBoard);
  $("#boardClose").addEventListener("click", () => { if (ride) boardEl.hidden = true; });

  /* ---------- stamps ---------- */
  function renderStamps() {
    const all = ROUTES.fwd.stamps; $("#stampCount").textContent = `${Object.keys(got).length}/${all.length}`;
    $("#stampGrid").innerHTML = all.map(([id, t, d]) => `<div class="stamp ${got[id] ? "got" : ""}"><b>${esc(t)}</b><span>${esc(d)}</span>${got[id] ? `<span>Collected ${esc(new Date(got[id]).toLocaleDateString("en-GB", { day: "numeric", month: "short" }))}</span>` : ""}</div>`).join("");
  }
  $("#stampsBtn").addEventListener("click", () => { renderStamps(); $("#stampSheet").hidden = false; });
  $("#stampClose").addEventListener("click", () => ($("#stampSheet").hidden = true));
  let toastT; function toast(html) { const el = $("#toast"); el.innerHTML = html; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 6000); }
  function checkStamps(km, quiet) {
    if (!ride || ride.source !== "live") return;
    for (const [id, t, d, skm] of ROUTES[ride.dir].stamps) if (km >= skm && !got[id]) { got[id] = Date.now(); store.set("stamps", got); if (!quiet) toast(`<span>Stamp collected</span><b>${esc(t)}</b>`); }
    renderStamps();
  }

  /* ---------- route strip with elevation profile ---------- */
  const strip = $("#strip");
  function drawStrip() {
    const R = ROUTES[dir]; const W = 1000, H = 74, top = 6, base = 44; let lo = 1e9, hi = -1e9; for (let i = 0; i < N; i += 10) { lo = Math.min(lo, R.Y[i]); hi = Math.max(hi, R.Y[i]); }
    const yOf = (e) => base - ((e - lo) / (hi - lo || 1)) * (base - top);
    let d = `M0 ${base}`; for (let i = 0; i < N; i += 20) d += ` L${((i * STEP) / L * W).toFixed(1)} ${yOf(R.Y[i]).toFixed(1)}`; d += ` L${W} ${base} Z`;
    const major = new Set([R.from, R.to, "Brig", "Disentis/Mustér", "Chur"]);
    const st = R.stations.filter((s) => major.has(s[0]) && !(s[0] === "Chur" && false));
    strip.setAttribute("viewBox", `0 0 ${W} ${H}`); strip.setAttribute("preserveAspectRatio", "none");
    strip.innerHTML = `<path d="${d}" fill="rgba(244,239,230,.10)" stroke="rgba(244,239,230,.35)" stroke-width="1" vector-effect="non-scaling-stroke"/>
      <line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="rgba(244,239,230,.25)" vector-effect="non-scaling-stroke"/>
      ${R.tunnels.filter((t) => t[1] - t[0] > 1.5).map((t) => `<rect x="${(t[0] / L) * W}" y="${base - 1.5}" width="${((t[1] - t[0]) / L) * W}" height="3" fill="#000"/>`).join("")}
      ${R.stamps.map(([id, , , km]) => `<circle cx="${(km / L) * W}" cy="${base}" r="3.2" fill="${got[id] ? "#d4202c" : "#1d1c22"}" stroke="#d4202c" vector-effect="non-scaling-stroke"/>`).join("")}
      <g id="ptr"><line x1="0" y1="2" x2="0" y2="${base}" stroke="#f4efe6" stroke-width="1.5" vector-effect="non-scaling-stroke"/><circle cx="0" cy="${base}" r="5" fill="#d4202c" stroke="#fff" stroke-width="1.5" vector-effect="non-scaling-stroke"/></g>`;
    // labels as HTML so they don't stretch with the SVG
    const wrap = strip.parentElement; wrap.querySelectorAll(".lbl").forEach((e) => e.remove());
    st.forEach(([n, km], i) => { if (i > 0 && st[i - 1][0] === n) return; const s = document.createElement("span"); s.className = "lbl" + ([R.from, R.to, "Chur"].includes(n) ? " keep" : ""); s.textContent = n.replace("/Mustér", "").replace("Oberalppass", "Oberalp"); s.style.cssText = `position:absolute;left:${(km / L) * 100}%;top:calc(100% - 13px);transform:translateX(${km < 1 ? "0" : km > L - 1 ? "-100%" : "-50%"});font-size:10px;color:var(--muted);white-space:nowrap`; wrap.appendChild(s); });
  }

  /* ---------- look around ---------- */
  let yawOff = 0, pitch = 0.06, drag = null;
  canvas.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY, yawOff, pitch]; canvas.classList.add("drag"); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => { if (!drag) return; const k = seatMode === "window" ? camera.fov / 58 : 1; yawOff = THREE.MathUtils.clamp(drag[2] + (e.clientX - drag[0]) * 0.004 * k, -1.5, 1.5); pitch = THREE.MathUtils.clamp(drag[3] + (e.clientY - drag[1]) * 0.003 * k, seatMode === "window" ? -0.75 : -0.35, 0.8); });
  const endDrag = () => { drag = null; canvas.classList.remove("drag"); }; canvas.addEventListener("pointerup", endDrag); canvas.addEventListener("pointercancel", endDrag);
  document.querySelectorAll(".pill button").forEach((b) => b.addEventListener("click", () => { view = b.dataset.v; store.set("view", view); yawOff = 0; document.querySelectorAll(".pill button").forEach((x) => x.setAttribute("aria-pressed", x === b)); }));
  document.querySelectorAll(".pill button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.v === view));

  /* ---------- window view: lean to the glass, zoom, pull the blind ---------- */
  function setSeatMode(m) {
    seatMode = m; document.body.classList.toggle("window", m === "window"); $("#winbar").hidden = m !== "window"; $("#winBtn").hidden = m === "window";
    store.set("seat", m); resize(); setTimeout(sizeDrops, 560); sizeDrops();
  }
  function zoomBy(f) { const key = seatMode; const cur = camera.fov; const next = THREE.MathUtils.clamp(cur * f, 18, 82); FOV[key] = next; camera.fov = next; camera.updateProjectionMatrix(); }
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomBy(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
  $("#winBtn").addEventListener("click", () => setSeatMode("window"));
  $("#seatBtn").addEventListener("click", () => setSeatMode("seat"));
  $("#zoomIn").addEventListener("click", () => zoomBy(0.8));
  $("#zoomOut").addEventListener("click", () => zoomBy(1.25));
  const shadeEl = $("#shade");
  function setShade(closed) { shadeEl.classList.toggle("closed", closed); $("#shadeBtn").textContent = closed ? "Open shade" : "Close shade"; store.set("shade", closed); }
  $("#shadeBtn").addEventListener("click", () => setShade(!shadeEl.classList.contains("closed")));
  setShade(store.get("shade", false)); setSeatMode(store.get("seat", "seat"));

  /* ---------- peek map: the real place you're looking at, from above ---------- */
  const peek = { map: null, marker: null, wedge: null, follow: true };
  const Lf = window.L; // (L is the route length elsewhere in this file)
  if (Lf && Lf.map) {
    const R0 = ROUTES.fwd; const line = []; for (let i = 0; i < N; i += 5) line.push([R0.LA[i], R0.LO[i]]);
    const map = Lf.map("peekmap", { zoomControl: false, attributionControl: true, center: line[0], zoom: 14, minZoom: 8, maxZoom: 18 });
    const sat = Lf.tileLayer("https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg", { maxZoom: 19, attribution: "© swisstopo" });
    const topo = Lf.tileLayer("https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg", { maxZoom: 18, attribution: "© swisstopo" });
    sat.addTo(map); map.attributionControl.setPrefix(false); map.attributionControl.addAttribution("Railway © OpenStreetMap");
    Lf.polyline(line, { color: "#d4202c", weight: 3, opacity: 0.85 }).addTo(map);
    peek.wedge = Lf.polygon([line[0], line[0], line[0]], { color: "#f2d38a", weight: 1, fillColor: "#f2d38a", fillOpacity: 0.28, interactive: false }).addTo(map);
    peek.icon = (deg) => Lf.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="trainmark" style="transform:rotate(${deg}deg)"><svg width="18" height="26" viewBox="0 0 18 26"><path d="M9 1c4 0 7 2 7 6v13c0 2-1.5 4-3.5 4h-7C3.5 24 2 22 2 20V7c0-4 3-6 7-6z" fill="#d4202c" stroke="#fff" stroke-width="1.6"/><rect x="5" y="5" width="8" height="5" rx="1.5" fill="#fff" opacity=".85"/></svg></div>` });
    peek.marker = Lf.marker(line[0], { icon: peek.icon(0), interactive: false }).addTo(map);
    map.on("dragstart", () => { peek.follow = false; $("#recenter").hidden = false; });
    $("#recenter").addEventListener("click", () => { peek.follow = true; $("#recenter").hidden = true; });
    $("#mapSat").addEventListener("click", () => { map.removeLayer(topo); sat.addTo(map); $("#mapSat").setAttribute("aria-pressed", true); $("#mapTopo").setAttribute("aria-pressed", false); });
    $("#mapTopo").addEventListener("click", () => { map.removeLayer(sat); topo.addTo(map); $("#mapTopo").setAttribute("aria-pressed", true); $("#mapSat").setAttribute("aria-pressed", false); });
    peek.map = map;
  } else $("#peek").hidden = true;
  $("#peekMin").addEventListener("click", () => { const el = $("#peek"); el.classList.toggle("min"); $("#peekMin").textContent = el.classList.contains("min") ? "+" : "−"; store.set("peekMin", el.classList.contains("min")); if (!el.classList.contains("min")) setTimeout(() => peek.map?.invalidateSize(), 50); });
  if (store.get("peekMin", innerWidth < 760)) { $("#peek").classList.add("min"); $("#peekMin").textContent = "+"; }
  let lastBearing = 0, lastHeading = 0;
  function updatePeek(p, tun) {
    if (!peek.map || $("#peek").classList.contains("min")) return;
    const [lat, lon] = toLL(p.x, p.z); const ll = [lat, lon];
    peek.marker.setLatLng(ll); peek.marker.setIcon(peek.icon(lastHeading));
    // the wedge shows exactly what the window shows: its direction and its horizontal field of view
    const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect * (seatMode === "window" ? 0.8 : 0.94));
    const z = peek.map.getZoom(); const mpp = (156543 * Math.cos((lat * Math.PI) / 180)) / 2 ** z; const d = 120 * mpp;
    const pt = (b) => [lat + (d * Math.cos(b)) / 111320, lon + (d * Math.sin(b)) / (111320 * Math.cos((lat * Math.PI) / 180))];
    const arc = [ll]; for (let k = 0; k <= 8; k++) arc.push(pt(lastBearing - hfov / 2 + (hfov * k) / 8));
    peek.wedge.setLatLngs(tun || shadeEl.classList.contains("closed") ? [ll, ll, ll] : arc);
    if (peek.follow) peek.map.setView(ll, z, { animate: false });
  }

  /* ---------- live updates for the current ride ---------- */
  async function refreshRide() {
    if (!ride || ride.source !== "live") return;
    try {
      const cs = await fetchConnections(ride.dir, new Date(ride.depLabel || ride.dep), 3);
      for (const c of cs) { const j = journeyFromConnection(ride.dir, c); if (j && Math.abs((j.depLabel || j.dep) - (ride.depLabel || ride.dep)) < 60000) { ride = j; store.set("ride", ride); liveOK = true; break; } }
    } catch { liveOK = false; }
  }
  setInterval(refreshRide, 120000);

  function startRide() {
    dir = ride.dir; drawStrip(); renderStamps();
    checkStamps(kmAt(ride, now()), true); // anything passed while you were away
    const live = $("#live"); live.className = "live" + (ride.source === "estimate" ? " est" : ride.source === "preview" ? " pre" : "");
    live.lastElementChild.textContent = ride.source === "live" ? "Live" : ride.source === "preview" ? `Preview ×${PREVIEW}, not live` : "Estimated times";
    $("#sub").textContent = `${ROUTES[dir].from} → ${ROUTES[dir].to}`;
  }

  /* ---------- frame loop ---------- */
  const look = new THREE.Vector3(); let hx = 0, hz = -1, lastTiles = 0, lastHud = 0, camY = null, lastFrame = performance.now();
  function frame() {
    requestAnimationFrame(frame);
    const pf = performance.now(), dt = Math.min(0.1, (pf - lastFrame) / 1000) * (PREVIEW || 1); lastFrame = pf;
    const t = now(); setSky(t);
    const R = ROUTES[dir]; const j = ride; const km = j ? kmAt(j, t) : 0; const p = R.at(km);
    // smooth the heading so curves feel like a train, not a camera cut
    const k = 0.08; hx += (p.hx - hx) * k; hz += (p.hz - hz) * k; const hl = Math.hypot(hx, hz) || 1; const fx = hx / hl, fz = hz / hl;
    const lx = fz, lz = -fx; // left of the direction of travel
    const base = view === "front" ? 0 : view === "left" ? 1.38 : -1.38; const a = base + yawOff;
    const tun = R.inTunnel(km);
    let y = p.y + 3.4; const gnd = tun ? -1e9 : groundAt(p.x, p.z) + 2.4; y = Math.max(y, gnd);
    camY = camY == null ? y : camY + (y - camY) * 0.2;
    camY = Math.max(camY, gnd); // never sink below the ground, even for a frame
    camera.position.set(p.x, camY, p.z);
    look.set(fx * Math.cos(a) + lx * Math.sin(a), Math.tan(pitch), fz * Math.cos(a) + lz * Math.sin(a));
    camera.lookAt(camera.position.x + look.x * 100, camera.position.y + look.y * 100, camera.position.z + look.z * 100);
    lastBearing = Math.atan2(look.x, -look.z); lastHeading = THREE.MathUtils.radToDeg(Math.atan2(fx, -fz));
    const sway = Math.min(1, speed / 50); camera.rotateZ(Math.sin(t / 610) * 0.0022 * sway + Math.sin(t / 233) * 0.0008 * sway); // the carriage rocks a little at speed
    skyDome.position.copy(camera.position);
    if (performance.now() - lastTiles > 400) {
      lastTiles = performance.now(); const [la, lo] = toLL(p.x, p.z); updateTiles(la, lo); updatePeek(p, !!tun); updateBuildings(dir === "rev" ? L - km : km);
      const moved = wxAt ? Math.hypot((la - wxAt[0]) * 111, (lo - wxAt[1]) * 76) : 1e9;
      if (!wxAt || moved > 8 || Date.now() - wxTime > 10 * 60000) { wxAt = [la, lo]; wxTime = Date.now(); refreshWeather(la, lo, p.y); }
    }
    weatherTick(dt / (PREVIEW || 1), t, p, tun);
    updateBirds(pf, camera.position, !tun && skyU.uDay.value > 0.35 && WX.rain + WX.snow < 0.5 && WX.vis > 1500);
    if (pf - lastDrops > 33) { updateDrops((pf - lastDrops) / 1000, !!tun, speed); lastDrops = pf; }
    WSAudio.update({ speed, rain: WX.rain, snow: WX.snow, wind: WX.wind, tunnel: !!tun });
    renderer.render(scene, camera);
    // tunnel
    const tEl = $("#tunnel"); tEl.classList.toggle("on", !!tun && j);
    if (tun && j) { $("#tName").textContent = tun[2] || "Tunnel"; $("#tInfo").textContent = `${(tun[1] - tun[0]).toFixed(1)} km · ${(tun[1] - km).toFixed(1)} km to daylight`; if (!tEl.dataset.lamps) { tEl.dataset.lamps = 1; for (let i = 0; i < 4; i++) { const l = document.createElement("i"); l.style.animationDelay = `${-i * 0.27}s`; tEl.appendChild(l); } } }
    if (j && performance.now() - lastHud > 500) { lastHud = performance.now(); hud(t, km); }
  }
  let prevKm = null, prevT = null, speed = 0;
  function hud(t, km) {
    const R = ROUTES[dir]; const j = ride;
    if (prevKm != null && t > prevT) { const v = ((km - prevKm) / ((t - prevT) / 3600000)); speed += (Math.max(0, v) - speed) * 0.35; }
    prevKm = km; prevT = t;
    $("#clock").textContent = fmtTime(t); $("#arr").textContent = fmtTime(j.arr);
    $("#alt").textContent = `${Math.round(R.at(km).y).toLocaleString("en-GB")} m`; $("#spd").textContent = `${Math.round(speed)} km/h`;
    const ptr = strip.querySelector("#ptr"); if (ptr) ptr.setAttribute("transform", `translate(${(km / L) * 1000},0)`);
    const tl = j.tl;
    if (t < j.dep) { $("#nextLabel").textContent = `At ${R.from}`; $("#nextName").textContent = `Departs ${fmtTime(j.dep)}`; $("#nextEta").textContent = `in ${mins(j.dep - t)}`; }
    else if (t >= j.arr) { $("#nextLabel").textContent = "Arrived"; $("#nextName").textContent = R.to; $("#nextEta").textContent = `at ${fmtTime(j.arr)} · choose another train to keep riding`; }
    else {
      let i = 0; while (i < tl.length - 1 && tl[i + 1][0] <= t) i++;
      if (tl[i + 1] && Math.abs(tl[i + 1][1] - tl[i][1]) < 0.05) { $("#nextLabel").textContent = "At the platform"; $("#nextName").textContent = tl[i][2]; $("#nextEta").textContent = `departs ${fmtTime(tl[i + 1][0])}`; }
      else { const n = tl[i + 1] || tl[i]; $("#nextLabel").textContent = "Next stop"; $("#nextName").textContent = n[2]; $("#nextEta").textContent = `${fmtTime(n[0])} · in ${mins(Math.max(0, n[0] - t))}`; }
    }
    const leg = j.legs.find((l) => km >= l.from - 0.05 && km <= l.toKm + 0.05) || j.legs[0];
    $("#trainName").innerHTML = leg ? `${leg.gex ? "<em>Glacier Express</em>" : leg.cat ? `<em>${esc(leg.cat)}${leg.num ? " " + esc(leg.num) : ""}</em>` : ""}${leg.to ? "to " + esc(leg.to) : esc(leg.name)}` : "";
    checkStamps(km, false);
    const live = $("#live"); if (j.source === "live" && liveOK === false) live.lastElementChild.textContent = "Live (reconnecting)";
  }

  renderStamps(); drawStrip();
  // sound needs a tap to start (browsers block autoplay); remember the choice for next time
  if (store.get("music", false) || store.get("sound", false)) addEventListener("pointerdown", function once() { removeEventListener("pointerdown", once); if (store.get("music", false)) musicBtn.click(); if (store.get("sound", false)) soundBtn.click(); });
  if (ride) startRide(); else openBoard();
  requestAnimationFrame(frame);
})();
