# Guardian

A small offline-first web app for emergency response and situational awareness — built as a single-page PWA, no backend required.

The idea: if you're coordinating a rescue effort or just want to know if you're walking into a flood zone, you shouldn't need a live server to check. Guardian runs entirely in the browser, stores everything locally in IndexedDB, and keeps working once it's cached.

## Running it

Easiest way — just open `index.html` in a browser. For full PWA behavior (service worker, install prompt, offline caching), serve it over HTTP instead:

```bash
python3 -m http.server 8080
# or
npx serve .
```

Then visit `http://localhost:8080`.

Log in with one of the seeded accounts:

| Username | Password     | Role        |
|----------|--------------|-------------|
| admin    | Guardian@123 | Coordinator |
| rescue   | rescue123    | Responder   |

These are demo accounts created on first run — change them (or the seeding logic in `seedDefaultData()`) before using this for anything real.

## What it does

**Auth & storage** — passwords are hashed client-side with SHA-256 (Web Crypto), sessions expire after 24h, and there's basic rate limiting on login attempts plus input sanitization. Everything persists in IndexedDB so it survives a page reload and works offline.

**Map & zones** — a Leaflet map with a dark theme shows danger zones as colored circles: red for high-risk areas (flooding, fire, cyclone), yellow for caution, and the rest treated as safe. As your GPS position updates, the app checks which zone you're in and fires an alert if you cross into one.

**Location** — uses the browser's Geolocation API with continuous position watching. If GPS isn't available it falls back to a rough simulated position so the rest of the app still has something to work with.

**Weather** — pulls live conditions from Open-Meteo (no API key needed) and flags risky conditions on its own: high wind, thunderstorms, heavy rain, poor visibility. Refreshes every 5 minutes.

**SOS** — one button broadcasts your GPS location and a map link to all your saved contacts, drops a marker on the map, vibrates the device, and logs the event.

**Contacts** — India's emergency numbers (112, 101, 108, 100, plus NDRF) are pre-loaded; you can add your own on top. Everything's stored locally so it works without a connection.

**Event log** — a running log of everything the app does (auth, zone changes, weather warnings, SOS events), color-coded by severity.

**Offline** — a service worker caches the app shell, map tiles as you browse them, and the last weather response, so the whole thing keeps functioning without a network connection after the first load.

## Files

```
index.html      shell, styles, and markup
app.js          all the application logic
sw.js           service worker / offline caching
manifest.json   PWA manifest
```

Everything's plain JS — no build step, no framework, no bundler. Leaflet is the only real dependency and it's loaded from a CDN.

## Deploying

Drop the folder on Netlify, Vercel, GitHub Pages, or any static host — there's nothing to build. Just keep in mind:

- Geolocation requires HTTPS in production (localhost is fine for testing)
- Same goes for service workers

## Extending it

The SOS flow currently just logs the event and shows contacts — wiring it up to actually send SMS/push notifications would mean swapping in something like Twilio or a regional provider (Fast2SMS, MSG91) inside `confirmSOS()`.

Similarly, `generateZones()` currently makes up sample danger zones for demo purposes. Real deployments would want to replace it with data from something like IMD or NDMA alerts.

## Disclaimer

This is a personal/demo project, not a certified emergency system. If you're in an actual emergency, call the real numbers: 112 (national emergency), 101 (fire), 108 (ambulance), 100 (police).
