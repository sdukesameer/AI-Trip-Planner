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

AI Trip Planner generates a full day-by-day travel itinerary for any set of destinations (India-focused, internationally extensible) using large language models. It clusters nearby attractions geographically, schedules them in realistic time blocks (10 AM → 6 PM), estimates entry fees, and renders everything on an interactive map with commute suggestions.

**Smart features:**
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
| 📍 Geographic Clustering | AI groups places within ~5 km radius on the same day; smart routing minimises backtracking |
| 🔍 Place Discovery | Photon geocode "Search Nearby" + AI enrichment; Nominatim for coordinate lookup |
| 🎯 Custom Places | Pre-seed from home screen textarea or paste list in discovery screen; AI auto-enriches names |
| 📸 Place Images | Unsplash API with context-aware queries (place name + city); Picsum fallback; SVG placeholder |
| 💾 Save & Share | localStorage (up to 5 trips, ~30 KB each); URL hash encoding for sharing; trip load/restore |
| 📄 Rich PDF Export | jsPDF: place thumbnails, coloured day banners, commute info, entry fee breakdown, weather badges |
| 📋 Emoji Copy Text | WhatsApp-friendly itinerary with flag emojis, time slots, → arrows, metadata |
| 💰 Budget Estimator | Per-day entry fee tally (tickets only, travel excluded); cost breakdown in accordion headers |
| 🌙 Dark/Light Theme | Persisted in localStorage (`atp_theme`); Leaflet tiles & CSS vars adapt automatically |
| 📱 Mobile Responsive | Full 480px breakpoint with stacked layouts, optimised touch targets, readable text |
| ⚡ Session Caching | AI responses cached in `sessionStorage` with composite key; survives screen navigation |
| 🔢 Progressive Place Grid | Initial 2 rows shown per location; "Load More" reveals cached then fetches fresh from API |
| 🔁 Collapsible Commute | Getting-there info collapsed by default per place row; expands to show walk/cab/metro detail |
| 🎯 Auto Place Mode | User selects places manually OR enables "AI picks the best" (smart dedup, geo-context aware) |
| ⌨️ Keyboard Shortcuts | Ctrl+S → Save, Ctrl+D → PDF, Esc → Close all modals |
| 🔐 Secure Keys | No API keys in browser; server-side proxy (Netlify functions) keeps secrets safe |
| 📊 Storage Meter | Visual quota indicator in "My Trips" modal with colour-coded bar (green/amber/red) |

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
| **PDF Export** | [jsPDF](https://github.com/parallax/jsPDF) 2.5.1 (CDN) |
| **Deployment** | [Netlify](https://netlify.com/) (static hosting + serverless functions) |

---

## Project Structure

```
AI-Trip-Planner-main/
├── index.html              # Single-page app shell (3 screens + modals)
├── build-env.js            # Netlify build script: env vars → js/env.js
├── netlify.toml            # Netlify config (build command, functions)
│
├── css/
│   ├── style.css           # Global tokens, resets, typography, theme variables
│   └── components.css      # Component-level styles (accordion, map, modals)
│
├── js/
│   ├── env.js              # API keys (git-ignored; generated at build or edited locally)
│   ├── app.js              # ★ Main orchestrator: state, screen routing, UI logic
│   ├── api.js              # AI providers + JSON repair; place discovery, itinerary gen
│   ├── maps.js             # Leaflet: markers, popups, focus, polylines, theme swap
│   └── download.js         # Export: emoji clipboard + rich PDF with jsPDF
│
├── netlify/functions/
│   ├── ai-proxy.js         # Server-side AI calls (keeps keys safe)
│   ├── unsplash-proxy.js   # Unsplash image search (proxy for key safety)
│   └── weather-proxy.js    # OpenWeatherMap forecast (proxy for key safety)
│
├── manifest.json           # PWA manifest (icons, metadata)
├── package.json            # npm deps (only dev server + build script)
├── .gitignore              # Excludes node_modules, env vars
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

> **Security:** Keys are **never** exposed to the browser. `build-env.js` injects client-side keys (Gemini, Groq, OpenRouter, Unsplash) into `js/env.js` at build time for local dev fallback. Production requests route through Netlify serverless functions (`ai-proxy.js`, `unsplash-proxy.js`, `weather-proxy.js`), keeping keys server-side. The OpenWeather key is server-side only and never appears in `js/env.js`.

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
- Node.js 14+ (for dev server only)
- Git

### Setup

```bash
# 1. Clone repository
git clone https://github.com/sdukesameer/AI-Trip-Planner.git
cd AI-Trip-Planner

# 2. Install dev dependencies
npm install

# 3. Configure local API keys
# Edit js/env.js and replace placeholders with your keys:
# - PASTE_YOUR_GEMINI_KEY_HERE     → your Gemini API key (primary)
# - PASTE_YOUR_GROQ_KEY_HERE       → your Groq API key (optional fallback)
# - PASTE_YOUR_UNSPLASH_KEY_HERE   → your Unsplash key (optional)
# Note: OPENWEATHER_API_KEY is server-side only; weather won't work in local dev

# 4. Start dev server (hot reload, no build step)
npm run dev

# Visit http://localhost:3000
```

### Development Tips

- **No build step required** — app uses native ES modules
- **Hot reload** — changes reflected instantly
- **Console errors** — check browser DevTools for AI provider fallback logs
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
git push → Netlify receives webhook → npm run build (= node build-env.js)
→ build-env.js reads env vars → writes js/env.js (gemini/groq/openrouter/unsplash only)
→ deploys static site + serverless functions
```

> **Note:** `js/env.js` is **never** committed to git (in `.gitignore`). It is generated fresh at build time. The `OPENWEATHER_API_KEY` is only ever read by the serverless `weather-proxy.js` function and is never written to `js/env.js`.

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

### Geographic Clustering

The itinerary prompt includes concrete examples:
```
India Gate + Rajpath + War Memorial → SAME DAY (all within 1 km)
Red Fort + Chandni Chowk + Jama Masjid → SAME DAY (cluster)
Qutub Minar + Mehrauli Park → SAME DAY (5 km apart)
```

AI is instructed to group places within ~5 km and compute `arrivalTime` cumulatively:
```
Place 1: arrivalTime = 10:00 AM
Place 2: arrivalTime = 10:00 + 2 hrs (visit) + 30 min (transit) = 12:30 PM
Place 3: arrivalTime = 12:30 + 1.5 hrs (visit) + 20 min (transit) = 2:20 PM
```

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

- [ ] **Offline mode** (Service Worker + IndexedDB)
  - Cache itinerary + images for offline viewing
  - Sync saved trips when back online
  - Impact: 🔴 Essential for field use

- [ ] **Google Calendar export**
  - Create calendar events for each place with reminders
  - Include location + commute time
  - Impact: 🔴 High workflow integration

- [ ] **Travel constraints filters**
  - Wheelchair-accessible places only
  - Vegetarian/vegan restaurant spots
  - Budget tier selection (budget/mid/luxury)
  - Impact: 🔴 Accessibility + inclusivity

### Phase 2 — Medium Impact

- [ ] **Dynamic pricing**
  - Live hotel rates (Agoda/Booking)
  - Flight/bus costs (Skyscanner)
  - Real-time entry fees
  - Budget breakdown + alerts

- [ ] **Trip statistics dashboard**
  - Total km traveled (from place coords)
  - Average daily budget
  - Best photo (Unsplash highest-rated)

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

### v1.2.0 (Current)
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
