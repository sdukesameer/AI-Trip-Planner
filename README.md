# AI Trip Planner 🗺️✈️

> An AI-powered travel itinerary generator with interactive maps, real-time place discovery, PDF export, trip sharing, and smart storage management — built with Vanilla JS, Leaflet, and multi-provider AI fallback.

[![Netlify Status](https://api.netlify.com/api/v1/badges/b6c9161e-4862-4733-a554-e2911e243341/deploy-status)](https://app.netlify.com/projects/my-trip-genie/deploys)

---

## 📑 Table of Contents

- [Overview](#overview)
- [Live Demo](#live-demo)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Data Schemas](#data-schemas)
- [API Integrations](#api-integrations)
- [Environment Variables](#environment-variables)
- [Local Development](#local-development)
- [Deploying to Netlify](#deploying-to-netlify)
- [Storage Management](#storage-management)
- [Architecture Notes](#architecture-notes)
- [Browser Support](#browser-support)
- [Performance Tips](#performance-tips)
- [Roadmap](#roadmap)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

---

## Overview

AI Trip Planner generates a full day-by-day travel itinerary for any set of destinations (India-focused, internationally extensible) using large language models.

Crucially, **the geography is not left to the model**. Candidate places are clustered into one
neighbourhood per day in code (k-means++), each day is ordered to minimise backtracking (2-opt),
and only then is the model asked to schedule and describe the result. It cannot scatter a zone
across the week. Real road distances and travel times come from OSRM, and everything renders on
an interactive map with the actual route drawn.

**Smart features:**
- Zone-first planning: deterministic clustering + route optimisation, verified after generation
- Stay/hotel anchor so every day starts and ends where you're sleeping
- Real road routing and per-day travel time, distance and fare
- Multi-provider AI fallback (Gemini 2.5 Flash → Gemini 2.5 Flash Lite → Groq → OpenRouter)
- Location-aware image fetching (Unsplash + Picsum fallback)
- Fuzzy duplicate detection (avoids "Taj Mahal" + "Taj Mahal Museum")
- Session caching (survives navigation, clears on tab close)
- Storage quota management (~30 KB per trip, up to 5 trips in 3 MB localStorage)
- Keyboard shortcuts (Ctrl+S save, Ctrl+D PDF, Esc close)
- Dark/light theme (persistent, map tiles swap)
- Mobile-responsive design (480px breakpoint tested)

---

## Live Demo

> **https://ai-trip-genie.netlify.app**

Fully functional. Try uploading a 15-day trip to see storage usage in action.

---

## Features

| Feature | Description |
|---------|---|
| 🤖 Multi-provider AI | Gemini 2.5 Flash → Gemini 2.5 Flash Lite → Groq Llama 3.3 70B → Groq Llama 3.1 8B → OpenRouter (auto-fallback) |
| 🗺️ Interactive Map | Leaflet + CartoDB tiles: pin-drop markers, day-focus overlay, polyline routes, rich popups |
| 🌤️ Daily Weather | OpenWeatherMap integration: temp range, humidity, rain chance, wind speed (optional, non-blocking) |
| 📅 Realistic Scheduling | Days start 10 AM, places ordered by `arrivalTime`, realistic visit durations computed cumulatively |
| 📍 Geographic Clustering | Done in code (k-means++ + 2-opt), not requested from the model — see [Zone-First Planning](#zone-first-planning) |
| 🔍 Place Discovery | Photon geocode "Search Nearby" + AI enrichment; Nominatim for coordinate lookup |
| 🎯 Custom Places | Pre-seed from home screen textarea or paste list in discovery screen; AI auto-enriches names |
| 📸 Place Images | Unsplash API with context-aware queries (place name + city); Picsum fallback; SVG placeholder |
| 💾 Save & Share | localStorage (up to 5 trips, ~30 KB each); URL hash encoding for sharing; trip load/restore |
| 📄 Rich PDF Export | jsPDF: place thumbnails, coloured day banners, commute info, entry fee breakdown, weather badges |
| 📋 Emoji Copy Text | WhatsApp-friendly itinerary with flag emojis, time slots, → arrows, metadata |
| 💰 Budget Estimator | Tickets + food + transport + stay, per day and whole trip, scaled by group size |
| 🌙 Dark/Light Theme | Persisted in localStorage (`atp_theme`); Leaflet tiles & CSS vars adapt automatically |
| 📱 Mobile Responsive | Full 480px breakpoint with stacked layouts, optimised touch targets, readable text |
| ⚡ Session Caching | AI responses cached in `sessionStorage` with composite key; survives screen navigation |
| 🔢 Progressive Place Grid | Initial 2 rows shown per location; "Load More" reveals cached then fetches fresh from API |
| 🔁 Collapsible Commute | Getting-there info collapsed by default per place row; expands to show walk/cab/metro detail |
| 🎯 Auto Place Mode | User selects places manually OR enables "AI picks the best" (smart dedup, geo-context aware) |
| ⌨️ Keyboard Shortcuts | Ctrl+S → Save, Ctrl+D → PDF, Esc → Close top modal, ↑/↓ + Enter in autocomplete |
| 🔐 Secure Keys | No API keys ever reach the browser; all provider calls go through Netlify functions |
| 📊 Storage Meter | Visual quota indicator in "My Trips" modal with colour-coded bar (green/amber/red) |
| ⚙️ Trip Preferences | Pace, budget level, day start time, group size, kids, step-free access, interests, "avoid" list — all fed into the prompt and persisted |
| 🏷️ Category Filters | Filter the discovery grid by category, or show only your selections |
| ✂️ Editable Itinerary | Reorder, move between days, swap, note or remove any stop; budget, routes and pins recompute instantly |
| 📅 Calendar Export | One-click `.ics` download with timed events, locations and GEO coordinates |
| 🖨️ Print Layout | Dedicated print stylesheet — every day expands, chrome and map are stripped |
| 📏 Per-Day Distance | Real road distance and travel time shown on each day header |
| ↩️ Back Button | Browser back/forward moves between the three screens instead of leaving the app |
| 📴 Offline Shell | Service worker caches the app shell so saved trips open without a connection |
| ♿ Accessibility | Focus-trapped modals, keyboard-operable cards and accordions, ARIA live regions, `prefers-reduced-motion` |
| 🧭 Zone-first planning | Places are clustered into one neighbourhood per day **in code** (k-means + 2-opt), then the model only schedules them — it cannot scatter a zone across the week |
| 🏨 Stay anchor | Give your hotel/area and every day starts and ends there, with the nearest zone planned first |
| 🛣️ Real road routing | OSRM road distance, duration and drawn route per day; graceful straight-line fallback |
| 🚇 Transport modes | Walking / public transport / taxi / self-drive / mixed — changes the plan, the advice and the fare estimates |
| 💰 Full budget | Tickets + food + local transport + stay, scaled by group size, in 8 currencies |
| 🍽️ Meal slots | Breakfast/lunch/dinner suggested along each day's route with approximate cost |
| ✏️ Full editing | Reorder, move between days, swap for a nearby alternative, add notes, re-plan or re-optimise a single day |
| 🎒 Packing list | Generated from your dates, forecast and planned activities, with saved checkboxes |
| 🌐 Local info | Emergency numbers, plug type, tipping, transport tips, etiquette and useful phrases |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Core** | Vanilla HTML5, JavaScript ES Modules (no build step required) |
| **Styling** | Vanilla CSS with CSS custom properties (dark/light theme support) |
| **Maps** | [Leaflet.js](https://leafletjs.com/) 1.9.4 + CartoDB (dark/light tiles) |
| **AI (primary)** | [Google Gemini API](https://ai.google.dev/) — `gemini-2.5-flash` (highest quality) |
| **AI (tier 1b)** | [Google Gemini API](https://ai.google.dev/) — `gemini-2.5-flash-lite` (faster, lower cost) |
| **AI (tier 2)** | [Groq API](https://groq.com/) — `llama-3.3-70b-versatile` then `llama-3.1-8b-instant` |
| **AI (safety net)** | [OpenRouter API](https://openrouter.ai/) — `meta-llama/llama-3.1-8b-instruct:free` |
| **Images** | [Unsplash API](https://unsplash.com/developers) + Picsum fallback |
| **Weather** | [OpenWeatherMap API](https://openweathermap.org/api) (optional, non-blocking) |
| **Geocoding** | [Photon API](https://photon.komoot.io/) for autocomplete; [Nominatim](https://nominatim.openstreetmap.org/) for coordinate lookup (both OSM-backed, no key) |
| **Routing** | [OSRM](https://project-osrm.org/) public demo server (road distance, duration, geometry) |
| **Planning** | In-house k-means++ clustering and 2-opt route optimisation (`js/planner.js`) — no dependency |
| **PDF Export** | [jsPDF](https://github.com/parallax/jsPDF) 2.5.1 (CDN) |
| **Deployment** | [Netlify](https://netlify.com/) (static hosting + serverless functions) |

---

## Project Structure

```
AI-Trip-Planner/
├── index.html              # Single-page app shell (3 screens + modals)
├── build-env.js            # Netlify build script: env vars → js/app-config.js (flags only)
├── netlify.toml            # Netlify config (build, functions, CSP + security headers)
├── sw.js                   # Service worker: offline app shell
│
├── css/
│   ├── style.css           # Global tokens, resets, a11y helpers, print styles
│   └── components.css      # Component-level styles (accordion, map, modals, cards)
│
├── js/
│   ├── env.js              # Committed placeholder — never contains secrets
│   ├── env.local.js        # (git-ignored, optional) real keys for direct-provider local dev
│   ├── app-config.js       # Generated at build: capability flags, no secrets
│   ├── util.js             # Escaping, timezone-safe dates, geo, concurrency, focus trap
│   ├── planner.js          # ★ Zone clustering (k-means++), route optimisation (2-opt), validation
│   ├── routing.js          # OSRM road routing, transport modes, fare model
│   ├── budget.js           # Currency handling + whole-trip cost breakdown
│   ├── app.js              # ★ Main orchestrator: state, screen routing, UI logic
│   ├── api.js              # AI providers + JSON repair; discovery, scheduling, packing, local info
│   ├── maps.js             # Leaflet: markers, popups, focus, polylines, theme swap
│   └── download.js         # Export: clipboard, text, .ics calendar, rich PDF
│
├── netlify/functions/
│   ├── _shared.js          # Origin allow-list, rate limiting, response helpers
│   ├── ai-proxy.js         # Server-side AI calls (keeps keys safe)
│   ├── unsplash-proxy.js   # Unsplash image search (proxy for key safety)
│   └── weather-proxy.js    # OpenWeatherMap forecast (proxy for key safety)
│
├── manifest.json           # PWA manifest (icons, metadata)
├── .gitignore              # Excludes node_modules and js/env.local.js
└── README.md               # This file
```

### Screen Flow

```
screen-input  ──[Plan My Trip]──►  screen-progress (overlay)
    │   │                               │
    │   │ [custom places textarea]      │ (fetches places + images)
    │   │                               ▼
    │   │                        screen-discovery
    │   │                        (select/deselect cards,
    │   │                         search nearby, paste list,
    │   │                         load more per location)
    │   │                               │
    │   │                        [Generate Itinerary]
    │   │                               │
    │   ◄───────────────────────────────┘
    │
    ├─[Load Saved Trip] ─┐
    │                    │
    │              ┌─────▼──────────────┐
    │              │ screen-itinerary   │
    │              │ MAP + ACCORDION    │
    │              │ [PDF/TXT/Copy/     │
    │              │  Save/Share]       │
    │              └─────┬──────────────┘
    │                    │
    └────[Share/Load]────┘
```

---

## Data Schemas

### `Place`
```javascript
{
  name:          string;           // Display name
  location:      string;           // City/area
  shortDesc?:    string;           // 1-line teaser (discovery screen)
  desc?:         string;           // 2–3 sentence description (itinerary)
  category?:     'Heritage' | 'Nature' | 'Religious' | 'Market' | 'Museum' | 'Entertainment' | 'Food';
  openingHours?: string;           // e.g. "9:00 AM – 6:00 PM" or "Open 24hrs"
  entryFee?:     string;           // e.g. "₹40" or "Free"
  arrivalTime?:  string;           // e.g. "10:00 AM" (computed per-day schedule)
  visitDuration?: string;          // e.g. "2 hrs"
  bestTime?:     string;           // e.g. "Early morning before crowds"
  closedNote?:   string;           // e.g. "Closed Mondays" (only if closed that date)
  lat?:          number;           // WGS84 decimal latitude
  lng?:          number;           // WGS84 decimal longitude
  commute_from_prev?: Commute;     // Transit info from previous place
}
```

### `Commute`
```javascript
{
  walk:  string;   // e.g. "12 min (900m)" | "N/A"
  cab:   string;   // e.g. "₹80–120" | "N/A"
  metro: string;   // e.g. "Yellow Line → Rajiv Chowk (₹30)" | "N/A"
}
```

### `Day`
```javascript
{
  day:      number;    // Day number (1-indexed)
  date:     string;    // ISO date "YYYY-MM-DD"
  theme:    string;    // Creative day title e.g. "Mughal Grandeur & Old Delhi"
  location: string;    // Primary city/area for this day
  places:   Place[];
}
```

### `Itinerary`
```javascript
{
  summary: string;   // 1–2 line trip overview
  days:    Day[];
}
```

---

## API Integrations

### Google Gemini (Primary AI — Tier 1)
- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- **Models:** `gemini-2.5-flash` (primary), `gemini-2.5-flash-lite` (tier 1b)
- **Rate limits:** Free tier ~10 RPM / 250 RPD
- **Status:** ✅ Highest quality; first in fallback chain

### Groq (Fast Fallback — Tier 2)
- **Endpoint:** `https://api.groq.com/openai/v1/chat/completions`
- **Models:** `llama-3.3-70b-versatile` (tier 2a), `llama-3.1-8b-instant` (tier 2b)
- **Rate limits:** Free tier ~14,400 req/day
- **Status:** ✅ Very fast; catches Gemini 429s reliably

### OpenRouter (Safety Net — Tier 3)
- **Endpoint:** `https://openrouter.ai/api/v1/chat/completions`
- **Model:** `meta-llama/llama-3.1-8b-instruct:free`
- **Rate limits:** Free tier ~50 req/day (as of Apr 2025)
- **Status:** ✅ Ultimate fallback; lower quality than Gemini/Groq

### Unsplash (Images)
- **Endpoint:** `https://api.unsplash.com/search/photos`
- **Query strategy:** `"{place name} {city} landmark"` for location specificity
- **Fallback:** Picsum (seeded by place name hash) → SVG placeholder
- **Rate limits:** Free tier 50 req/hour
- **Status:** ✅ Excellent; double fallback ensures no broken images

### Photon (Location Autocomplete)
- **Endpoint:** `https://photon.komoot.io/api/?q={query}&limit=6&lang=en`
- **Backend:** OpenStreetMap
- **Key required:** ❌ None (public API, CORS-free)
- **Used for:** Destination input autocomplete on home screen
- **Status:** ✅ No key needed

### Nominatim (Coordinate Lookup)
- **Endpoint:** `https://nominatim.openstreetmap.org/search`
- **Backend:** OpenStreetMap
- **Key required:** ❌ None
- **Used for:** Resolving a search query to lat/lng inside "Search Nearby"
- **Status:** ✅ No key needed

### OpenWeatherMap (Weather)
- **Endpoint:** `https://api.openweathermap.org/data/2.5/forecast` (via `weather-proxy`)
- **Used for:** Daily temp range, humidity, rain chance %, wind speed
- **Key required:** ✅ Yes (optional — weather badges simply don't appear without it)
- **Failure mode:** Fully graceful (non-blocking background fetch)
- **Status:** ✅ Non-blocking enhancement

---

## Environment Variables

Set these in the **Netlify dashboard** under `Site Settings → Environment Variables`:

| Variable | Description | Required | Free Tier |
|---|---|---|---|
| `GEMINI_API_KEY` | Google AI Studio API key | ✅ **Yes (primary)** | ✅ 10 RPM / 250 RPD |
| `GROQ_API_KEY` | Groq Cloud API key | ❌ No (Tier 2 fallback) | ✅ ~14,400 req/day |
| `OPENROUTER_API_KEY` | OpenRouter API key | ❌ No (Tier 3 fallback) | ✅ ~50 req/day |
| `UNSPLASH_ACCESS_KEY` | Unsplash developer access key | ❌ No | ✅ 50 req/hr |
| `OPENWEATHER_API_KEY` | OpenWeatherMap API key | ❌ No (optional) | ✅ 1,000 req/day |

> **Security:** Keys are **never** written into any file under the publish directory. `build-env.js` emits `js/app-config.js` containing only boolean capability flags (`hasAI`, `hasImages`, `hasWeather`). Every provider request in production goes through the Netlify serverless functions (`ai-proxy.js`, `unsplash-proxy.js`, `weather-proxy.js`), which read the keys from the server environment.
>
> ⚠️ **If you deployed a build before this change**, `js/env.js` was generated *with your real keys* and served publicly at `https://<your-site>/js/env.js`. **Rotate every key** listed above before redeploying.
>
> The functions also reject requests whose `Origin`/`Referer` isn't this site and apply a per-IP rate limit, so the endpoints can't be used as a free public AI gateway. Add extra allowed hosts (a custom domain, for example) with the optional `ALLOWED_ORIGINS` env var, comma-separated.

### Getting API Keys

| Provider | URL | Free Tier | Setup Time |
|---|---|---|---|
| **Gemini** | https://aistudio.google.com/apikey | ✅ 10 RPM | 2 min |
| **Groq** | https://console.groq.com/keys | ✅ ~14,400 req/day | 2 min |
| **OpenRouter** | https://openrouter.ai/keys | ✅ ~50 req/day | 2 min |
| **Unsplash** | https://unsplash.com/developers | ✅ 50 req/hr | 5 min |
| **OpenWeatherMap** | https://openweathermap.org/api | ✅ 1,000 req/day | 3 min |

**Estimated total setup:** ~15 minutes

---

## Local Development

### Prerequisites
- Node.js 18+ (for `netlify dev`; any static server works otherwise)
- Git

### Option A — `netlify dev` (recommended: exercises the real serverless functions)

```bash
git clone https://github.com/sdukesameer/AI-Trip-Planner.git
cd AI-Trip-Planner

npm install -g netlify-cli

# Provide the keys the way production does — as environment variables.
export GEMINI_API_KEY=...
export GROQ_API_KEY=...            # optional
export OPENROUTER_API_KEY=...      # optional
export UNSPLASH_ACCESS_KEY=...     # optional
export OPENWEATHER_API_KEY=...     # optional

netlify dev      # http://localhost:8888 — functions and weather both work
```

### Option B — plain static server (calls the AI providers directly from the browser)

```bash
# Create js/env.local.js — it is git-ignored and MUST NOT be committed.
cat > js/env.local.js <<'EOF'
export const ENV_KEYS = {
  geminiKey:     'your-gemini-key',
  groqKey:       'your-groq-key',       // optional
  openrouterKey: 'your-openrouter-key', // optional
  unsplashKey:   'your-unsplash-key',   // optional
};
EOF

python3 -m http.server 8000     # or: npx serve .
# Visit http://localhost:8000
```

> `js/env.js` is committed and intentionally empty — **never** put keys in it. Weather needs a serverless
> function, so it only works under Option A. Without either option the app shows a banner explaining
> that no AI provider is configured.

### Development Tips

- **No build step required** — app uses native ES modules
- **Console errors** — check browser DevTools for AI provider fallback logs
- **Service worker** — registration is skipped on `localhost`, so you never fight a stale cache while developing
- **Session storage** — inspect `sessionStorage` in DevTools → Application tab (keys prefixed `atp_`)
- **Local storage** — saved trips visible in `localStorage` → `atp_saved_trips`; theme in `atp_theme`
- **Throttle network** → DevTools → Network → "Slow 3G" to test graceful degradation
- **Weather in local dev** — weather proxy requires a Netlify function; weather badges won't appear locally unless you run `netlify dev`

---

## Deploying to Netlify

### Step 1: Push to GitHub
```bash
git push origin main
```

### Step 2: Connect to Netlify
1. Go to [Netlify](https://app.netlify.com/)
2. Click "New site from Git"
3. Select your repository
4. Netlify auto-detects settings from `netlify.toml` (no further config needed)

### Step 3: Set Environment Variables
1. Go to `Site Settings → Build & Deploy → Environment Variables`
2. Add all 5 keys (see table above)
3. **Critical:** At least `GEMINI_API_KEY` is required; others are optional fallbacks/enhancements

### Step 4: Deploy
```bash
# Push to main; Netlify auto-deploys
# Or manually trigger: Netlify Dashboard → Deployments → "Trigger Deploy"
```

### Build Process
```
git push → Netlify receives webhook → node build-env.js
→ writes js/app-config.js  { hasAI, hasImages, hasWeather }   ← flags only, no secrets
→ resets js/env.js to an empty placeholder
→ deploys static site + serverless functions
```

> **Note:** every API key is read exclusively by the serverless functions from the Netlify
> environment. Nothing under the publish directory (`.`) ever contains a secret — which matters,
> because everything there is downloadable by anyone.

---

## Storage Management

### localStorage Quota

The app uses `atp_saved_trips` in localStorage, capped at a **3 MB (3,072 KB)** soft limit. Each trip takes ~25–35 KB. Up to 5 trips are kept; older trips are dropped automatically when saving would exceed the limit.

#### Breakdown Per Trip
```
Nagpur (8 days)  = 35 KB
Mumbai (5 days)  = 29 KB
Goa (7 days)     = 31 KB
─────────────────────────
Current usage    = 95 KB (3% of 3,072 KB)
Remaining        = 2,977 KB (97%)
Safe threshold   = ~3,800 KB before auto-trim kicks in
```

#### What Gets Stored?
```
├── Locations array (2–5 KB)
│   "Nagpur, Mumbai, Goa"
├── Dates (0.5 KB)
│   "2024-12-01" → "2024-12-15"
├── Itinerary structure (15–20 KB)
│   Days + places + metadata
├── Image URLs — Unsplash/Picsum links only (8–12 KB)
│   https://images.unsplash.com/... (NOT base64, NOT embedded)
└── Metadata (0.5 KB)
    Saved timestamp, trip summary
```

> **Note:** Base64 image data is explicitly stripped before saving. Only `https://` URLs are persisted in `imageCache`.

### Storage Meter in UI

The "My Trips" modal displays a colour-coded bar:
```
💾 Storage Used:  [████░░░░░░░░░░░░░░░░░░] 3% (95 KB / 3,072 KB)
```

Colors:
- 🟢 Green (0–49%): Plenty of space
- 🟡 Amber (50–79%): Getting full
- 🔴 Red (80%+): Delete old trips soon

### Cleanup Strategy

1. **Auto-trim on save:** If the serialised trips JSON exceeds ~3,800 KB, the oldest trip is dropped automatically before saving
2. **Manual deletion:** Click "My Trips" → ✕ next to any trip — removed instantly, meter updates
3. **Clear all:** "My Trips" → 🗑️ Clear All button
4. **Browser limit:** If localStorage is completely full (e.g. other sites), a `QuotaExceededError` toast is shown

---

## Architecture Notes

### Multi-Provider AI Fallback

Both `api.js` (local dev, direct calls) and `ai-proxy.js` (production, server-side) implement the same 5-provider chain:

```
Gemini 2.5 Flash         (best quality)
    ↓ [429 / timeout]
Gemini 2.5 Flash Lite    (faster, cheaper)
    ↓ [fails]
Groq Llama 3.3 70B       (very fast, LPU hardware)
    ↓ [fails]
Groq Llama 3.1 8B        (smaller, still fast)
    ↓ [fails]
OpenRouter Llama 3.1 8B  (free safety net, ~50 req/day)
    ↓ [all fail → throw error shown to user]
```

Each provider is wrapped in try/catch. On failure, logs warning + moves to next. The proxy adds a 9s per-provider timeout (Netlify functions have a 10s hard wall).

**Production (Netlify):** Browser calls `ai-proxy.js` first. If the proxy itself 504s, `api.js` falls through to direct API calls using keys from `js/env.js` (which are empty strings in production, so this last-resort path effectively fails gracefully and shows the error toast).

### Custom Places Flow

Users can pre-seed place names in two ways:

1. **Home screen textarea** ("I already know where I want to go") — parsed before the discovery screen loads
2. **Discovery screen "Paste List" button** — opens a modal to paste names at any point

In both cases, `enrichCustomPlaces()` is called to fetch AI-generated descriptions and categories for the raw names. Enriched places are merged with the famous-places list (fuzzy-deduped) and auto-selected. They appear first in the discovery grid.

### JSON Repair Pipeline

AI responses often have trailing commas or markdown fences. `extractJSON()` applies a 3-stage repair:

1. **Strip markdown fences:** ` ```json { ... } ``` ` → ` { ... } `
2. **Remove trailing commas:** `, ]` → `]`, `, }` → `}`
3. **Truncate to last complete object:** If response is cut off mid-stream, find last `}` and close array

### Session Caching

All AI responses cached in `sessionStorage` with composite keys:
```javascript
"places|Delhi,Mumbai|"           // famous places fetch
"enrich|Red Fort,Qutub|Delhi"   // custom place enrichment
"itin|Delhi|2024-12-01|2024-12-15|auto"  // itinerary
```

Survives screen navigation within same browser tab. Clears on tab close. Keyed so that changing locations/dates/selection always triggers a fresh fetch.

### Progressive Place Grid

On the discovery screen, each location section shows an initial 2 rows of cards (column count matches the CSS grid columns, computed by `getSymmetricCounts()` based on viewport width). The "Load More" button first reveals already-fetched places, then calls `fetchMorePlaces()` to get additional ones from the AI when the local cache is exhausted.

### Zone-First Planning

Earlier versions *asked* the model to "group places within ~5 km" and nothing verified that it had.
It frequently didn't, and the result was days that criss-crossed the city.

The geography is now decided in code, before the model is involved at all:

```
1. Discovery returns each place with real lat/lng
2. Bucket places by city; split the trip's days between cities by place count
3. k-means++ clusters each city's places into one zone per day  (js/planner.js)
4. Balance the clusters so no day gets 9 stops and another gets 1
5. Order the zones — nearest the stay first, then nearest-neighbour between centroids
6. Order each day internally: nearest-neighbour tour + 2-opt improvement
7. THEN the model receives fixed days with fixed places in a fixed order,
   and may only add times, descriptions, fees, opening hours and meal breaks
```

Step 7's prompt states explicitly: *"Do NOT add, remove, reorder or move any place between days."*
The response is then merged back **by name** onto the planner's own list, so even if the model
ignores the instruction, its ordering is discarded and ours survives.

Real example — 12 Delhi landmarks over 3 days:

```
Day 1 (3.6 km spread): Chandni Chowk → Jama Masjid → Red Fort → Raj Ghat     [Old Delhi]
Day 2 (8.9 km spread): Rashtrapati Bhavan → India Gate → Humayun's Tomb      [Central]
Day 3 (3.8 km spread): Hauz Khas → Qutub Minar → Mehrauli Park               [South]
```

Clustering is seeded deterministically, so re-planning the same trip produces the same zones.
`validateItinerary()` then re-checks the finished plan and surfaces any day that still spans
too far, any duplicate place, and any empty day in the UI.

### Travel Times and Costs

Each day's ordered stops go to OSRM in a single request, which returns per-leg road distance,
duration and the route geometry drawn on the map. If OSRM is rate-limited or down, legs fall back
to haversine distance × a per-mode detour factor, and the UI says so rather than presenting an
estimate as measured. Fares come from a per-mode cost model (`js/routing.js`), with public
transport charged per head and taxis charged per vehicle.

### Map Safety

`maps.js` fully tears down the map before reinit:
```javascript
if (map) { map.off(); map.remove(); }
map = null;
markersGrid = [];
polylinesByDay = [];
container.innerHTML = '';
```

Prevents `_leaflet_id` null errors on saved trip load + theme toggle.

### Image Fetching Strategy

For each place, images are fetched with location context:

```javascript
query = "{place name} {city} landmark"
// "Taj Mahal Agra landmark" gets far better results than "Taj Mahal"
```

Results are scored by keyword overlap with place name. Fallback chain: Unsplash → Picsum (seeded by place name hash) → SVG placeholder with place name text.

### Collapsible Commute UI

Commute information (walk/cab/metro) between consecutive places is rendered as a collapsible row. A summary line shows the quickest option; clicking expands to show all modes. This uses a delegated `click` listener on `[data-commute-toggle]` attributes — CSP-safe, works for dynamically rendered rows.

---

## Browser Support

| Browser | Version | Status | Notes |
|---------|---------|--------|-------|
| **Chrome** | 90+ | ✅ Fully supported | ES modules, CSS custom properties, Leaflet |
| **Firefox** | 88+ | ✅ Fully supported | Same as Chrome |
| **Safari** | 14+ | ✅ Fully supported | Tested on macOS + iOS |
| **Edge** | 90+ | ✅ Fully supported | Chromium-based, identical to Chrome |
| **Opera** | 76+ | ✅ Fully supported | Chromium-based |
| **IE 11** | N/A | ❌ Not supported | No ES modules, no CSS custom properties |

**Mobile:** iOS Safari 14+ and Android Chrome 90+ both work great.

### Tested Devices
- ✅ Desktop (1920×1080)
- ✅ Tablet (iPad, 768×1024)
- ✅ Mobile (iPhone 12, 390×844)
- ✅ Small mobile (iPhone SE, 375×667)

---

## Performance Tips

### For Users on Slow Networks

1. **Images load lazily** — only when place card becomes visible
2. **SVG placeholder** — appears instantly if image fetch takes > 2s
3. **Map tiles cached** — subsequent loads use browser cache
4. **Session cache** — revisiting discovery screen doesn't refetch places or images

### For Self-Hosting

1. **Enable Gzip compression** on your web server
2. **Set cache headers** on map tiles (immutable, 1-year expiry)
3. **Lazy-load Leaflet** — only load on itinerary screen (currently always loaded; future optimisation)
4. **Consider CDN** for map tiles if hosting outside US

### Browser DevTools Tips

```javascript
// Check session cache entries
Object.keys(sessionStorage).filter(k => k.startsWith('atp_'))

// View all saved trips
JSON.parse(localStorage.getItem('atp_saved_trips')).map(t => ({
  locations: t.locations,
  days: t.itinerary?.days.length,
  sizeKB: Math.round(JSON.stringify(t).length / 1024)
}))

// Calculate storage used
Math.round(new Blob([localStorage.getItem('atp_saved_trips') || '']).size / 1024) + ' KB'
```

---

## Roadmap

### Phase 1 — High Impact

- [x] **Offline mode** (Service Worker) — *shipped in v2.0.0*
  - App shell + visited assets cached; saved trips open without a connection
  - Still open: IndexedDB storage and background sync of saved trips

- [x] **Calendar export** — *shipped in v2.0.0*
  - `.ics` download with timed `VEVENT`s, `LOCATION` and `GEO` coordinates
  - Still open: direct Google Calendar API push with reminders

- [x] **Travel constraints filters** — *shipped in v2.0.0*
  - Step-free access, travelling-with-kids, budget tier, pace, interests, "avoid" list
  - Still open: dietary filters (vegetarian/vegan restaurant spots)

- [x] **Zone-first planning + real routing** — *shipped in v2.1.0*
  - Deterministic clustering, stay anchor, OSRM road distances, transport modes
  - Still open: self-hosted OSRM so routing isn't dependent on the public demo server

### Phase 2 — Medium Impact

- [ ] **Dynamic pricing**
  - Live hotel rates (Agoda/Booking)
  - Flight/bus costs (Skyscanner)
  - Real-time entry fees
  - Budget breakdown + alerts

- [x] **Trip statistics** — *shipped in v2.1.0*
  - Per-day and trip-wide road distance, travel time and cost; full budget breakdown by category
  - Still open: best photo (Unsplash highest-rated)

- [ ] **Drag-and-drop reordering**
  - v2.1.0 ships move-up/move-down/move-to-day via an action sheet, which works on touch
  - Pointer-based dragging would be faster on desktop

- [ ] **Multi-user trip editing** (beta)
  - Shareable edit link (not just view)
  - Real-time sync (WebSocket)
  - Collaborative place voting

- [ ] **AI packing list generator**
  - Based on weather + activities
  - Luggage weight estimate

### Phase 3 — Polish & Scale

- [ ] **Internationalisation (i18n)**
  - Support 10+ languages
  - Regional currency display (€, £, ¥, etc.)
  - Locale-aware date formats

- [ ] **Social features**
  - Share trip + collect feedback
  - See friends' past itineraries
  - Vote on best places

- [ ] **Analytics & telemetry**
  - Track which AI provider performs best
  - Popular destinations heat map

- [ ] **Weather in local dev**
  - Proxy weather calls through a configurable local endpoint so `npm run dev` shows weather badges without `netlify dev`

---

## Troubleshooting

### "All AI providers failed"

**Symptoms:** Error message after clicking "Plan My Trip" or "Generate Itinerary"

**Causes:**
1. No API keys configured (check Netlify env vars)
2. All providers rate-limited (Gemini free tier is 10 RPM / 250 RPD; consider adding a Groq key)
3. Network issue (check browser DevTools → Network tab)

**Solution:**
- ✅ Ensure at least `GEMINI_API_KEY` is set in Netlify env vars
- ✅ Add `GROQ_API_KEY` for a fast Tier 2 fallback (14,400 req/day free)
- ✅ Try again in 1 minute (rate limit timeout)
- ✅ Check console logs (DevTools → Console) — each failed provider is logged with its error

---

### Images show as grey placeholders

**Symptoms:** Place cards display SVG fallback instead of Unsplash photos

**Causes:**
1. `UNSPLASH_ACCESS_KEY` not configured — app falls back to Picsum automatically, then SVG
2. Unsplash API key invalid or rate-limited (50 req/hr free)
3. Network blocked Unsplash (corporate firewall)

**Solution:**
- ✅ App works fine without Unsplash; Picsum provides seeded placeholder photos
- ✅ Add valid Unsplash key to Netlify env vars for real location photos
- ✅ Check Unsplash developer console for rate limits

---

### Map won't load or shows blank / error message

**Symptoms:** Map container is empty, shows "Map failed to load", or Leaflet errors in console

**Causes:**
1. Leaflet JS not loaded (CDN issue — rare)
2. All itinerary places have no lat/lng coordinates (AI didn't return them)
3. Browser cookies/storage quota exceeded

**Solution:**
- ✅ Hard refresh (Ctrl+Shift+R / Cmd+Shift+R)
- ✅ Clear browser cache: Settings → Privacy → Clear browsing data
- ✅ If coordinates are missing, regenerate the itinerary — the map renders gracefully with only places that have valid coords

---

### Saved trips not persisting

**Symptoms:** Trips disappear after browser restart

**Causes:**
1. **Private/Incognito mode** — localStorage not available
2. **Cookies disabled** — localStorage blocked
3. **Storage quota full** (3 MB soft limit)

**Solution:**
- ✅ Use **normal browsing mode** (not Incognito)
- ✅ Enable cookies: Settings → Privacy → Allow cookies
- ✅ Delete old trips: "My Trips" modal → ✕ button; storage meter shows current usage

---

### PDF export has broken images

**Symptoms:** PDF downloads but place thumbnails are missing or blank

**Causes:**
1. Unsplash images timed out during base64 conversion (slow network)
2. Image URL is a data-URI / SVG placeholder (not supported by jsPDF's `addImage`)
3. CORS issue — Unsplash URLs are fetched client-side for base64 conversion

**Solution:**
- ✅ Ensure Unsplash key is configured for real `https://` image URLs
- ✅ Try again on a faster network
- ✅ App gracefully skips images that fail conversion; PDF will have text-only rows for those places

---

### Weather badges missing

**Symptoms:** Itinerary shows days but no weather icons/temperature badges

**Causes:**
1. `OPENWEATHER_API_KEY` not configured (optional — badges simply don't appear)
2. Trip dates are more than 5 days in the future (OpenWeatherMap free tier is 5-day forecast only)
3. Local dev without `netlify dev` — the `weather-proxy` function isn't available

**Solution:**
- ✅ This is **expected behaviour** — weather is an optional enhancement
- ✅ Weather only appears for the next 5 days from today
- ✅ Run `netlify dev` locally to test weather; or deploy and test on Netlify

---

### Custom places not appearing in discovery grid

**Symptoms:** Places typed in the home screen textarea or pasted in discovery don't show up as cards

**Causes:**
1. Names were fuzzy-matched to existing famous places (they appear as pre-selected cards in the main grid)
2. Enrichment AI call failed — stub objects are created but may not have images yet

**Solution:**
- ✅ Check if the place card exists elsewhere in the grid with a ✓ checkmark (already auto-selected)
- ✅ Use the "Search Nearby" bar to find the place if it isn't appearing
- ✅ Check browser console for enrichment errors

---

### Keyboard shortcuts don't work

**Symptoms:** Ctrl+S or Ctrl+D don't trigger save/download

**Causes:**
1. Not on the itinerary screen (shortcuts are only active on `screen-itinerary`)
2. A modal is open (modals capture focus but don't intercept these shortcuts — close modals first)
3. Browser intercepting the shortcut (rare; some browsers override Ctrl+S)

**Solution:**
- ✅ Ensure the itinerary screen is active with no modals open
- ✅ Click "Save" / "PDF" buttons instead (identical effect)

---

### Mobile layout broken on specific devices

**Symptoms:** Text overflows, buttons misaligned, map too small

**Causes:**
1. Very old Android browser (pre-Chrome 90)
2. Custom OS font size setting
3. Non-standard viewport (e.g. split-screen tablet mode)

**Solution:**
- ✅ Upgrade to latest Chrome or Safari
- ✅ Reset device font size to default
- ✅ Tested breakpoints: 480px, 600px, 900px — report issues with exact device + browser version

---

## Contributing

Love the project? Want to contribute?

1. **Fork** the repository
2. **Create feature branch:** `git checkout -b feature/my-feature`
3. **Make changes** following the code style (Vanilla JS, CSS variables, no build tools)
4. **Test locally:** `npm run dev` and verify all features work
5. **Commit:** `git commit -m "feat: add my feature"`
6. **Push:** `git push origin feature/my-feature`
7. **Open Pull Request** with clear description

### Code Style Guide

- **No TypeScript** — stick to Vanilla JS ES Modules
- **No build tools** — Leaflet and jsPDF via CDN only
- **CSS custom properties** — use `--accent`, `--bg-card` etc. for all colours
- **Comments** — explain "why", not "what"
- **Functions** — keep < 50 lines; split into modules
- **Errors** — always use `showToast()` for user feedback, never `alert()`
- **Accessibility** — always add `aria-*` labels to interactive elements

### Testing Before PR

- [ ] Run `npm run dev` and test all 3 screens
- [ ] Add destination + places + generate itinerary
- [ ] Test custom places via home textarea and discovery paste-list
- [ ] Save trip + reload browser → trip still there, storage meter updates
- [ ] Share link + open in new incognito window → pre-fills locations + custom places
- [ ] Download PDF + verify images + formatting
- [ ] Copy to clipboard + paste in WhatsApp
- [ ] Test dark/light theme toggle (map tiles swap)
- [ ] Test on mobile (DevTools → iPhone 12 emulation)
- [ ] Check browser console for errors

---

## License

MIT License — free to use, modify, and distribute. See LICENSE file.

---

## Acknowledgments

- **Leaflet.js** team for excellent map library
- **Google Gemini** for powerful 2.5 Flash models
- **Groq** for incredible LPU-accelerated Llama inference
- **OpenWeatherMap** for reliable weather data
- **Unsplash** for gorgeous place photography
- **OpenStreetMap** / **Photon** / **Nominatim** for geocoding

---

## Changelog

### v2.1.0 (Current) — zone-first planning, real routing, editable itineraries

#### Planning

- 🧭 **Geography is now decided in code, not requested from the model.** k-means++ clusters places into one zone per day and 2-opt orders each day; the model only schedules and describes what it is given, and its ordering is discarded on merge. See [Zone-First Planning](#zone-first-planning).
- 🏨 **Stay anchor** — give a hotel or area and every day starts and ends there, nearest zone first. Geocoded via OpenStreetMap, with an AI fallback.
- ⚖️ Multi-city day allocation is proportional to place count (a 2-place city no longer gets as many days as a 12-place one)
- 🔍 Plan validation surfaces over-spread days, duplicates and empty days instead of shipping them silently
- 🎲 Clustering is deterministically seeded — re-planning the same trip gives the same zones

#### Transport

- 🛣️ Real road distance, duration and drawn route per day via OSRM, with a labelled straight-line fallback
- 🚇 Transport mode (walk / transit / taxi / self-drive / mixed) changes the plan, the advice and the fares
- 🚕 Per-leg and per-day travel time, distance and fare estimates

#### Editing

- ✏️ Per-stop action sheet: move earlier/later, move to another day, swap for a nearby alternative, add a note, remove
- 🔄 Re-plan a single day, or re-optimise its order without another AI call
- Moving a place into a day re-optimises that day automatically

#### Trip essentials

- 💰 Full budget: tickets + food + local transport + stay, scaled by group size, across 8 currencies
- 🍽️ Meal slots suggested along each day's route
- 🎒 Weather- and activity-aware packing list with saved checkboxes
- 🌐 Local info: emergency numbers, plug type, tipping, transport, etiquette, phrases
- ♿ Accessibility warnings surfaced per place when step-free access is required

#### Fixes

- 🐛 Category filter chips offered categories whose cards hadn't rendered yet, so selecting one showed nothing
- 🐛 Entry fees using Indian digit grouping (`₹12,50,000`) parsed as `12`
- 📱 iOS Safari zoomed the page when focusing a preference dropdown (`.pref-field .input-field` out-specified the 16px mobile rule); same on iPad for date/location inputs
- 📱 Tap targets below 40px: map link, remove button, filter/interest chips, day legend, Leaflet zoom controls
- 📱 Navbar wordmark wrapped to two lines at 320px

### v2.0.0 — security, correctness & UX overhaul

#### Security

- 🔐 **API keys no longer published.** `build-env.js` used to write the real Gemini/Groq/OpenRouter/Unsplash keys into `js/env.js`, which Netlify serves publicly. It now emits `js/app-config.js` with capability flags only. **Rotate any keys used by an earlier deploy.**
- 🔐 XSS fixed: all AI output, place names and share-link payloads are HTML-escaped; share-link data is type-validated and clamped
- 🔐 Content-Security-Policy (no `unsafe-inline` scripts), `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP
- 🔐 Serverless functions now enforce an origin allow-list, per-IP rate limits and payload size caps — the AI proxy was previously an open, unauthenticated gateway to the keys
- 🔐 Inline `onerror=` handlers replaced with a delegated listener so the CSP can forbid inline scripts

#### Bug fixes

- 🐛 Auto-mode dimming never applied — the CSS targeted `.discovery-grid.auto-mode` but the element only had `auto-mode`
- 🐛 Map pins mis-aligned: places without coordinates shifted every later marker, so clicking a row focused the wrong pin
- 🐛 Timezone bugs: `toISOString()` and `valueAsDate` shifted trip dates by a day outside GMT; all calendar maths is now local-date based
- 🐛 "Load More" did nothing for a location that returned no places (its handler was registered after an early `return`)
- 🐛 Grid columns were set inline and never recalculated on resize
- 🐛 `searchNearbyPlaces` built an `AbortController` it never passed to a request, so its timeout never fired
- 🐛 The map's global click listener was re-registered on every generation, firing duplicate events
- 🐛 Text/PDF downloads revoked the blob URL synchronously, which aborts the download in Firefox
- 🐛 The AI could repeat the same place across days; duplicates are now dropped
- 🐛 Entry-fee parsing mis-read `₹1,200` as `1`
- 🐛 Saving the same trip twice created duplicate entries; quota overflow now drops the oldest trips instead of failing
- 🐛 "Clear All" deleted every saved trip with no confirmation
- 🐛 Loading a saved trip left the discovery screen empty, so "Edit Places" was broken
- 🐛 In auto mode, clicking a card was silently ignored — it now switches auto off and selects
- 🐛 The spinner keyframe was injected only by nearby-search, so other spinners never animated

#### Performance

- ⚡ Unsplash lookups run 6-at-a-time instead of strictly sequentially
- ⚡ Auto-fill no longer refetches on every re-render
- ⚡ Proxy responses carry cache headers; the AI chain is budgeted to fit Netlify's 10s limit

#### Features

- ⚙️ Trip preferences: pace, budget, day start time, group size, kids, step-free access, interests, "avoid" list — persisted and fed into the prompt
- 📅 `.ics` calendar export
- 🖨️ Print stylesheet
- 📴 Service worker for offline app shell
- 🏷️ Category + "selected only" filters on the discovery grid
- ✂️ Remove a place from a day; budget, distance and map update live
- 📏 Per-day straight-line distance
- ↩️ Browser back/forward navigation between screens
- 🔗 Web Share API with clipboard fallback
- ♿ Focus-trapped modals, keyboard-operable cards/accordions/autocomplete, ARIA live regions, `prefers-reduced-motion`, skip link
- 📆 Date inputs enforce a minimum, auto-correct an inverted range and cap trips at 30 days

### v1.2.0
- ✅ Gemini 2.5 Flash as primary AI (replaces Groq as primary)
- ✅ Gemini 2.5 Flash Lite added as Tier 1b fallback
- ✅ Custom places: home screen textarea + discovery paste-list with AI enrichment
- ✅ Progressive place grid (2 rows initial, load-more reveals cached then fetches)
- ✅ Collapsible commute rows (summary line + expandable detail)
- ✅ Card detail button (⤢) on discovery cards for quick place info modal
- ✅ Nominatim geocoding inside "Search Nearby" for coordinate resolution
- ✅ Map popup "Details" button opens place modal via delegated event (CSP-safe)
- ✅ Symmetric grid column count forced to match `getSymmetricCounts()` viewport calculation

### v1.1.0
- ✅ Multi-provider AI fallback (Groq → Gemini → OpenRouter)
- ✅ Storage quota management + visual meter
- ✅ Weather integration (OpenWeatherMap)
- ✅ Fuzzy duplicate detection
- ✅ Session caching for performance
- ✅ Keyboard shortcuts (Ctrl+S, Ctrl+D, Esc)
- ✅ Mobile responsive (480px tested)

### v1.0.0 (Initial Release)
- ✅ Basic itinerary generation
- ✅ Interactive map + markers
- ✅ PDF export with jsPDF
- ✅ Save/load trips (localStorage)
- ✅ Dark/light theme

---

## Contact & Support

**Issues?** Open a GitHub issue with:
- Expected behaviour
- Actual behaviour
- Device + browser + version
- Screenshots / console logs

**Questions?** Check the [troubleshooting section](#troubleshooting) or email: sdukesameer@gmail.com

---

*Generated itineraries are for planning purposes only. Always check official sources for current opening hours, entry fees, and closures before visiting.*

**Built with ❤️ by Md Sameer • Deployed on Netlify • Powered by Gemini + Groq + OpenRouter**
