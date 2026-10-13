// Live weather at the train's exact position and altitude, from Open-Meteo (free, no key).
// Returns one plain object the renderer turns into clouds, rain, snow, storms, fog and snow cover.
"use strict";
window.WSWeather = (() => {
  const API = "https://api.open-meteo.com/v1/forecast";
  const FULL = "temperature_2m,weather_code,cloud_cover,precipitation,rain,showers,snowfall,wind_speed_10m,wind_direction_10m,visibility,snow_depth,is_day";
  const BASIC = "temperature_2m,weather_code,cloud_cover,precipitation,rain,snowfall,wind_speed_10m,wind_direction_10m";

  // WMO weather codes → words and what to draw
  const CODES = {
    0: ["Clear", {}], 1: ["Mainly clear", {}], 2: ["Partly cloudy", {}], 3: ["Overcast", {}],
    45: ["Fog", { fog: 1 }], 48: ["Freezing fog", { fog: 1 }],
    51: ["Light drizzle", { rain: 0.2 }], 53: ["Drizzle", { rain: 0.3 }], 55: ["Heavy drizzle", { rain: 0.45 }],
    56: ["Freezing drizzle", { rain: 0.3 }], 57: ["Freezing drizzle", { rain: 0.45 }],
    61: ["Light rain", { rain: 0.45 }], 63: ["Rain", { rain: 0.7 }], 65: ["Heavy rain", { rain: 1 }],
    66: ["Freezing rain", { rain: 0.6 }], 67: ["Freezing rain", { rain: 0.9 }],
    71: ["Light snow", { snow: 0.4 }], 73: ["Snow", { snow: 0.7 }], 75: ["Heavy snow", { snow: 1 }], 77: ["Snow grains", { snow: 0.3 }],
    80: ["Rain showers", { rain: 0.5 }], 81: ["Heavy showers", { rain: 0.8 }], 82: ["Violent showers", { rain: 1 }],
    85: ["Snow showers", { snow: 0.6 }], 86: ["Heavy snow showers", { snow: 1 }],
    95: ["Thunderstorm", { rain: 0.9, storm: 1 }], 96: ["Thunderstorm, hail", { rain: 1, storm: 1 }], 99: ["Thunderstorm, hail", { rain: 1, storm: 1 }]
  };
  // for demos and screen recordings: ?weather=rain etc. (labelled as a demo on screen)
  const DEMO = {
    clear: { code: 0, cover: 5, temp: 12 }, cloudy: { code: 3, cover: 90, temp: 9 }, rain: { code: 63, cover: 100, temp: 8, rainMM: 3, vis: 6000 },
    snow: { code: 73, cover: 100, temp: -4, snowCM: 1.2, snowDepth: 0.35, vis: 2500 }, storm: { code: 95, cover: 100, temp: 16, rainMM: 8, vis: 5000, wind: 45 },
    fog: { code: 45, cover: 100, temp: 4, vis: 250 }
  };

  function shape(c, demo) {
    const code = c.code ?? 0; const [label, kind] = CODES[code] || ["", {}];
    // measured amounts refine the code's typical intensity
    let rain = kind.rain || 0, snow = kind.snow || 0;
    if (c.rainMM != null && c.rainMM > 0) rain = Math.max(rain, Math.min(1, 0.25 + c.rainMM / 6));
    if (c.snowCM != null && c.snowCM > 0) snow = Math.max(snow, Math.min(1, 0.3 + c.snowCM / 1.5));
    if (rain && c.temp != null && c.temp < 0.5 && !snow) { snow = rain; rain = 0; } // falls as snow at the train's altitude
    const vis = c.vis ?? (kind.fog ? 300 : rain ? 8000 : snow ? 3000 : 40000);
    return { code, label, temp: c.temp, cover: (c.cover ?? 0) / 100, rain, snow, storm: kind.storm || 0, fog: kind.fog || (vis < 1000 ? 1 : 0), vis, wind: c.wind ?? 8, windDir: c.windDir ?? 270, snowDepth: c.snowDepth ?? 0, demo: !!demo };
  }

  async function fetchAt(lat, lon, ele) {
    for (const vars of [FULL, BASIC]) {
      try {
        const q = new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), elevation: String(Math.round(ele)), current: vars, timezone: "Europe/Zurich" });
        const r = await fetch(`${API}?${q}`); if (!r.ok) throw new Error("HTTP " + r.status);
        const c = (await r.json()).current; if (!c) throw new Error("no data");
        return shape({ code: c.weather_code, temp: c.temperature_2m, cover: c.cloud_cover, rainMM: (c.rain || 0) + (c.showers || 0), snowCM: c.snowfall, vis: c.visibility, wind: c.wind_speed_10m, windDir: c.wind_direction_10m, snowDepth: c.snow_depth });
      } catch (e) { if (vars === BASIC) throw e; }
    }
  }
  return { fetchAt, demo: (name) => (DEMO[name] ? shape(DEMO[name], true) : null) };
})();
