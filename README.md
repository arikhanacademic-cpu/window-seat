# Window Seat

Take a window seat on a real train crossing the Swiss Alps, right now. Choose from three lines: the Glacier Express route (Zermatt → St. Moritz), the Bernina line (St. Moritz → Tirano, over the Bernina Pass to Italy) and the Gotthard Panorama line (Arth-Goldau → Bellinzona, with the Wassen loops).

Pick a train that's on the line, and you ride along in real time: the real track, the real mountains, live times and delays. Leave and come back whenever you like. Your train keeps going, and you collect stamps for the landmarks it passes, even while you're away.

It follows the route of the Glacier Express. When the Glacier Express itself isn't running (it takes an autumn break), you ride the regional trains on the same tracks.

## What you see

**New in this version**

- **Your own train**, visible on the curves ahead, plus **real trains passing** the other way, with a whoosh as they go by
- **Realistic speed**: the train slows for tight curves and steep climbs instead of gliding at one speed between stations
- **Station stops**: platforms, blue station signs, shelters and lamps, and a door chime when you arrive and leave
- **"Coming up" cards** with a short story before each landmark
- **Meadows**: grass and wildflowers by the line that sway in the live wind; **leaves blowing past** in autumn, blossom in spring
- **Broadleaf trees** in the valleys that turn yellow and orange in autumn, **low cloud** around the peaks, **sun glare**, and **lakes that mirror the sky**
- **Night**: lit windows in the villages and lamps on the platforms
- **Postcards**: ✉ saves the current view as a postcard with the place, height, time and weather, ready to share
- **A pixel-art boarding screen** that stays up until the mountains around you have loaded
- **Automatic quality** for phones: lighter mode on weak devices, and lower resolution if the frame rate drops
- **[How it works](public/how.html)**: a write-up page with diagrams


- **The exact railway**, taken from OpenStreetMap: every curve and station, tunnels like the 15.4 km Furka Base Tunnel, and bridges like the Landwasser Viaduct
- **Real terrain** from elevation data, draped in swisstopo aerial imagery and streamed in around the train
- **Live journeys** from the Swiss public transport API: real departures, stops, changes and delays
- **Left, right or front windows**: drag to look around
- **Window view**: lean to the glass for a framed carriage window. Drag to look, scroll or use −/+ to zoom, and pull the roller blind down when you've had enough sun.
- **Peek map**: a live swisstopo aerial photo or Swiss national map from above, with the train, the line, and a wedge showing exactly what your window is looking at. The wedge follows your direction and zoom.
- **Sky and light that match the real time of day** in the Alps: a sky with the sun's disc and glow, drifting clouds, stars at night, and haze that fades distant ridges into blue
- **Live weather where the train is right now** (Open-Meteo, at the train's altitude):
  - Clouds thicken and the sky turns grey in overcast weather.
  - Rain streaks past, and drops land on the window and run back along the glass at speed.
  - Snow falls and settles over the valley when snow is lying at the track.
  - Thunderstorms bring lightning and rolling thunder.
  - Fog closes in to the real visibility.
- **Snow cover that follows the season**, with a snowline that drops through autumn and lifts in spring, plus the measured snow depth
- **Villages along the line**: buildings from OpenStreetMap near the track, as dark larch chalets and white plaster houses with gable roofs, which collect snow in winter
- **The railway up close**: ballast, sleepers and rails, overhead-line masts and the contact wire
- **Birds**: a flock of alpine choughs, and a golden eagle circling high above, in fair weather
- **Lofi music, generated live** (♪ Lofi), plus **ride sounds** (Sound): rumble, rail joints that click faster as the train speeds up, rain, wind and thunder. All of it is synthesised with the Web Audio API, so there are no recordings and nothing to license.
- **3D forests**: near the train, every forest pixel in the aerial photo becomes a tree, and in October and November the larches turn gold
- **Film-style colour**: ACES tone mapping and a light colour grade on the imagery, with a faint glass reflection on the window
- **12 stamps to collect**, from the Matterhorn to Oberalp Pass (2,033 m) and the Landwasser Viaduct
- **Tunnels go dark**, with the tunnel's name and the distance to daylight
- **An elevation profile of the whole route**, showing where you are

## How it works

**Building the route** (`scripts/build-route.mjs`, run by GitHub Actions):

1. Downloads every railway of the right gauge in each route's corridor from the Overpass API (metre gauge for the Glacier and Bernina lines, standard gauge for the Gotthard). Each route in `config.json` builds into `public/data/<route>/`, and the first route has to succeed for the deploy to go ahead.
2. Builds a graph from the tracks and runs Dijkstra through each station in `config.json`, which gives the exact line (via the Furka Base Tunnel, Chur and the Albula spirals).
3. Resamples the line every 20 m and marks tunnels and bridges.
4. Samples each point's height from Terrarium elevation tiles. A small PNG decoder means there are no dependencies. Inside tunnels and on bridges, the height is interpolated between the two ends, so the train goes through mountains and across gorges.

**The viewer** (`public/app.js`, three.js; `public/weather.js`; `public/audio.js`):

- **Terrain streaming:** four rings of terrain tiles stream in around the train, at zoom levels 14, 12, 10 and 8, so the horizon goes out about 150 km. Each coarser ring cuts a hole (in a shader) where the finer ring has loaded, so blurry tiles never poke through a detailed valley.
- **Live train position:** journeys come from transport.opendata.ch. Each stop is projected onto the track, searching forward from the previous stop so stations the train passes twice (Reichenau) work. The train's position is interpolated between stops with gentle acceleration and braking.
- **Saved progress:** your ride and stamps are saved in your browser, so the train's position is worked out from the clock when you return.
- **Terrain shading:** terrain is lit per pixel, with a noise-based micro-relief, live snow cover that settles on gentler slopes first, and darker, shinier ground when it's wet.
- **Rain and snow:** about 16,000 particles that wrap around the camera, drifting with the real wind.
- **Window glass:** drops and flakes are drawn on a 2D canvas over the glass.
- **Fallback:** if live data can't be reached, the page says so and falls back to an estimated timetable.

## Run it

```bash
npm i
npm run build:offline   # builds a route from synthetic test data, no network needed
npm run serve           # then open http://localhost:8790/?lite=1
```

`npm run build` builds the real route; it needs internet access.

### URL options

| Option | What it does |
| --- | --- |
| `?preview=10&km=219` | Ride a sample journey 10× faster, starting near the Landwasser Viaduct. Useful for recording videos. Clearly labelled as not live. |
| `?lite=1` | Lighter terrain, for slow devices (switched on automatically on weak phones). |
| `?film=1` | Film mode for recording: hides every control and the window frame, adds 2.39:1 cinema bars, a vignette, a calmer camera and an opening title. Keys: **H** shows/hides the controls, **B** toggles the bars, **T** replays the title. `?film=nobars` starts without bars. |
| `?hq=1` | Never switch to the lighter mode automatically. |
| `?route=bernina` | Open a route directly: `glacier`, `bernina` or `gotthard`. |
| `?preview=2&km=40&hour=20` | With preview: pick an evening train to see the night lighting. |
| `?weather=snow` | Demo weather, labelled as a demo on screen: `clear`, `cloudy`, `rain`, `snow`, `storm` or `fog`. |

## Deploy

1. Push to GitHub.
2. Go to **Settings → Pages** and set the source to **GitHub Actions**.
3. The **Build and deploy** workflow builds the route and publishes the site.

## Credits

- Railway data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL)
- Aerial imagery © [swisstopo](https://www.swisstopo.admin.ch)
- Elevation: [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/) (Mapzen)
- Timetable: [transport.opendata.ch](https://transport.opendata.ch)
- Weather: [Open-Meteo](https://open-meteo.com) (CC BY 4.0)
- Inspired by [InFlightSimulator](https://inflightsimulator.com/)

This is an independent project. It is not affiliated with Glacier Express, Bernina Express, Matterhorn Gotthard Bahn, the Rhaetian Railway or SBB.

Built by Ari Khan. MIT licence.
