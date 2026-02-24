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
- Multi-provider AI fallback (Gemini → Groq → OpenRouter)
- Location-aware image fetching (Unsplash + Picsum fallback)
- Fuzzy duplicate detection (avoids "Taj Mahal" + "Taj Mahal Museum")
- Session caching (survives navigation, clears on tab close)
- Storage quota management (2% usage on 3 MB localStorage)
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
| 🤖 Multi-provider AI | Gemini 2.5 Flash (quality) → Groq Llama 3.3 (fast) → OpenRouter (safety net) with auto-fallback |
| 🗺️ Interactive Map | Leaflet + CartoDB tiles: pin-drop markers, day-focus overlay, polyline routes, rich popups |
| 🌤️ Daily Weather | OpenWeatherMap integration: temp range, humidity, rain chance, wind speed (optional, non-blocking) |
| 📅 Realistic Scheduling | Days start 10 AM, places ordered by `arrivalTime`, realistic visit durations computed cumulatively |
| 📍 Geographic Clustering | AI groups places within ~5 km radius on the same day; smart routing minimizes backtracking |
| 🔍 Place Discovery | Photon geocode "Search Nearby" + AI enrichment; custom place paste (comma/newline-separated) |
| 📸 Place Images | Unsplash API with context-aware queries (place name + city); Picsum fallback; SVG placeholder |
| 💾 Save & Share | localStorage (up to 5 trips, ~35 KB each); URL hash encoding for sharing; trip load/restore |
| 📄 Rich PDF Export | jsPDF: place thumbnails, colored day banners, commute info, entry fee breakdown, weather badges |
| 📋 Emoji Copy Text | WhatsApp-friendly itinerary with flag emojis, time slots, → arrows, metadata |
| 💰 Budget Estimator | Per-day entry fee tally (tickets only, travel excluded); cost breakdown in accordion headers |
| 🌙 Dark/Light Theme | Persisted in localStorage; Leaflet tiles & CSS vars adapt automatically |
| 📱 Mobile Responsive | Full 480px breakpoint with stacked layouts, optimized touch targets, readable text |
| ⚡ Session Caching | AI responses + images cached in `sessionStorage`; debounced requests, survives screen navigation |
| 💻 Offline Graceful | Images lazy-load with fallback; weather optional; map works without network (pre-cached tiles) |
| 🎯 Auto Place Mode | User selects places manually OR enables "AI picks the best" (smart dedup, geo-context aware) |
| ⌨️ Keyboard Shortcuts | Ctrl+S → Save, Ctrl+D → PDF, Esc → Close all modals |
| 🔐 Secure Keys | No API keys in browser; server-side proxy (Netlify functions) keeps secrets safe |
| 📊 Storage Meter | Visual quota indicator in "My Trips" modal; ~2% usage per trip (well under 3 MB limit) |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Core** | Vanilla HTML5, JavaScript ES Modules (no build step required) |
| **Styling** | Vanilla CSS with CSS custom properties (dark/light theme support) |
| **Maps** | [Leaflet.js](https://leafletjs.com/) 1.9 + CartoDB (dark/light tiles) |
| **AI (primary)** | [Groq API](https://groq.com/) — `llama-3.3-70b-versatile` (fastest) |
| **AI (quality)** | [Google Gemini API](https://ai.google.dev/) — `gemini-2.5-flash` (high quality) |
| **AI (safety net)** | [OpenRouter API](https://openrouter.ai/) — `meta-llama/llama-3.1-8b-instruct:free` |
| **Images** | [Unsplash API](https://unsplash.com/developers) + Picsum fallback |
| **Weather** | [OpenWeatherMap API](https://openweathermap.org/api) (optional, non-blocking) |
| **Geocoding** | [Photon API](https://photon.komoot.io/) (OpenStreetMap-backed, no key required) |
| **PDF Export** | [jsPDF](https://github.com/parallax/jsPDF) 2.5 (CDN) |
| **Deployment** | [Netlify](https://netlify.com/) (static hosting + serverless functions) |

---

## Project Structure

```
AI-Trip-Planner-main/
├── index.html              # Single-page app shell (3 screens)
├── build-env.js            # Netlify build script: env vars → js/env.js
├── netlify.toml            # Netlify config (build command, functions)
│
├── css/
│   ├── style.css           # Global tokens, resets, typography, theme variables
│   └── components.css      # Component-level styles (accordion, map, modals)
│
├── js/
│   ├── env.js              # API keys (git-ignored; generated at build)
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
screen-input  ──[Plan My Trip]──►  screen-progress
    │                                  │
    │◄─────────────────────────────────┘
    │
    ├─[Load Saved Trip] ─┐
    │                    │
    │              ┌─────▼─────────┐
    │              │ screen-itinerary (MAP + ACCORDION)
    │              │ [Download PDF/TXT/Copy/Save/Share]
    │              └─────┬─────────┘
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
  shortDesc?:    string;           // 1-line teaser
  desc?:         string;           // 2–3 sentence description
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

### Groq (Primary AI)
- **Endpoint:** `https://api.groq.com/openai/v1/chat/completions`
- **Model:** `llama-3.3-70b-versatile` (fastest, high quality)
- **Fallback:** `llama-3.1-8b-instant`
- **Rate limits:** Free tier ~30 RPM / 10 rps (very generous)
- **Status:** ✅ **CURRENT BEST CHOICE** (speed + quality)

### Google Gemini (Quality Fallback)
- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- **Models:** `gemini-2.5-flash` (primary), `gemini-2.5-flash-lite` (budget)
- **Rate limits:** Free tier ~15 RPM / 1M TPD
- **Status:** ✅ High quality, slower than Groq

### OpenRouter (Safety Net)
- **Endpoint:** `https://openrouter.ai/api/v1/chat/completions`
- **Model:** `meta-llama/llama-3.1-8b-instruct:free`
- **Rate limits:** Free tier very generous
- **Status:** ✅ Ultimate fallback, always works

### Unsplash (Images)
- **Endpoint:** `https://api.unsplash.com/search/photos`
- **Query strategy:** `"{place name} {city} landmark"` for location specificity
- **Fallback:** Picsum (seeded by place name hash)
- **Rate limits:** Free tier 50 req/hour
- **Status:** ✅ Excellent; Picsum fallback ensures no broken images

### Photon (Geocoding)
- **Endpoint:** `https://photon.komoot.io/api/?q={query}&limit=6&lang=en`
- **Backend:** OpenStreetMap (no proprietary data)
- **Key required:** ❌ None (public API, CORS-free)
- **Status:** ✅ Perfect for location autocomplete

### OpenWeatherMap (Weather)
- **Endpoint:** `https://api.openweathermap.org/data/2.5/forecast` (via `weather-proxy`)
- **Used for:** Daily temp, humidity, rain chance, wind
- **Key required:** ✅ Yes (optional)
- **Failure mode:** Graceful (badges simply don't appear)
- **Status:** ✅ Non-blocking enhancement

---

## Environment Variables

Set these in the **Netlify dashboard** under `Site Settings → Environment Variables`:

| Variable | Description | Required | Free Tier |
|---|---|---|---|
| `GEMINI_API_KEY` | Google AI Studio API key | ❌ No (Groq is primary) | ✅ 15 RPM |
| `GROQ_API_KEY` | Groq Cloud API key | ✅ **Yes (primary)** | ✅ 30 RPM |
| `OPENROUTER_API_KEY` | OpenRouter API key | ❌ No (fallback) | ✅ Yes |
| `UNSPLASH_ACCESS_KEY` | Unsplash developer access key | ❌ No | ✅ 50 req/hr |
| `OPENWEATHER_API_KEY` | OpenWeatherMap API key | ❌ No (optional) | ✅ 1,000 req/day |

> **Security:** Keys are **never** exposed to the browser. `build-env.js` injects them into `js/env.js` at build time. Production requests route through Netlify serverless functions (`ai-proxy.js`, `unsplash-proxy.js`, `weather-proxy.js`), keeping keys server-side.

### Getting API Keys

| Provider | URL | Free Tier | Setup Time |
|---|---|---|---|
| **Groq** | https://console.groq.com/keys | ✅ 30 RPM | 2 min |
| **Gemini** | https://aistudio.google.com/apikey | ✅ 15 RPM | 2 min |
| **OpenRouter** | https://openrouter.ai/keys | ✅ Yes | 2 min |
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
# - PASTE_YOUR_GROQ_KEY_HERE → your Groq API key
# - PASTE_YOUR_GEMINI_KEY_HERE → your Gemini API key (optional)
# - PASTE_YOUR_UNSPLASH_KEY_HERE → your Unsplash key (optional)

# 4. Start dev server (hot reload, no build step)
npm run dev

# Visit http://localhost:3000
```

### Development Tips

- **No build step required** — app uses native ES modules
- **Hot reload** — changes reflected instantly
- **Console errors** — check browser DevTools for AI provider fallback logs
- **Session storage** — inspect `sessionStorage` in DevTools → Application tab
- **Local storage** — saved trips visible in `localStorage` → `atp_saved_trips`
- **Throttle network** → DevTools → Network → "Slow 3G" to test graceful degradation

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
4. Netlify auto-detects settings (no further config needed)

### Step 3: Set Environment Variables
1. Go to `Site Settings → Build & Deploy → Environment Variables`
2. Add all 5 keys (see table above)
3. **Critical:** `GROQ_API_KEY` is required; others are optional

### Step 4: Deploy
```bash
# Push to main; Netlify auto-deploys
# Or manually trigger: Netlify Dashboard → Deployments → "Trigger Deploy"
```

### Build Process
```
git push → Netlify receives webhook → npm run build (= node build-env.js)
→ build-env.js reads env vars → writes js/env.js → deploys
```

> **Note:** `js/env.js` is **never** committed to git (in `.gitignore`). It's generated fresh at build time.

---

## Storage Management

### localStorage Quota

Your app uses **3 MB (3,072 KB) of localStorage** for saving trips. Each trip takes ~25–35 KB.

#### Breakdown Per Trip
```
Nagpur (8 days)  = 35 KB
Mumbai (5 days)  = 29 KB
Goa (7 days)     = 31 KB
─────────────────────────
Current usage    = 95 KB (3% of 3,072 KB)
Remaining        = 2,977 KB (97%)
Safe threshold   = 2,500 KB (81%)
```

#### What Gets Stored?
```
├── Locations array (2–5 KB)
│   "Nagpur, Mumbai, Goa"
├── Dates (0.5 KB)
│   "2024-12-01" → "2024-12-15"
├── Itinerary structure (15–20 KB)
│   Days + places + metadata
├── Image URLs — Unsplash links only (8–12 KB)
│   https://images.unsplash.com/... (NOT base64, NOT embedded)
└── Metadata (0.5 KB)
    Saved timestamp, trip name
```

### Storage Meter in UI

The "My Trips" modal displays:
```
💾 Storage Used:  [████░░░░░░░░░░░░░░░░░░] 2% (95 KB / 3,072 KB)
```

Colors:
- 🟢 Green (0–50%): Plenty of space
- 🟡 Amber (51–80%): Getting full
- 🔴 Red (81%+): Delete old trips soon

### Cleanup Strategy

When approaching quota (81%+):

1. **Auto-prompt:** App warns "Storage nearly full — delete old trips first"
2. **Manual deletion:** Click "My Trips" → ✕ next to trip → removed instantly
3. **Per-save guard:** If saving new trip would exceed quota, oldest trip auto-removed
4. **Browser limit:** If localStorage completely full, alert tells user to clear browser data

### Performance Impact

- **0–50% quota used:** No slowdown
- **51–80%:** Negligible (< 100 ms lookup)
- **81%+:** Slight delay when opening "My Trips" modal

---

## Architecture Notes

### Multi-Provider AI Fallback

`api.js` exports `smartAICall(prompt, config, onProviderSwitch)` which tries providers in order:

```
Gemini 2.5 Flash (Quality)
    ↓ [fails]
Gemini 2.5 Flash Lite (Lite)
    ↓ [fails]
Groq Llama 3.3 70B (Fastest)
    ↓ [fails]
Groq Llama 3.1 8B (Fast)
    ↓ [fails]
OpenRouter Llama 3.1 8B Free (Safety Net)
    ↓ [all fail → throw error]
```

Each provider is wrapped in try/catch. On failure, logs warning + moves to next.

**Production (Netlify):** Requests go through `ai-proxy.js`, which has identical fallback chain but runs server-side (more reliable).

### JSON Repair Pipeline

AI responses often have trailing commas or markdown fences. `extractJSON()` applies 3-stage repair:

1. **Strip markdown fences:** ` ```json { ... } ``` ` → ` { ... } `
2. **Remove trailing commas:** `, ]` → `]`, `, }` → `}`
3. **Truncate to last complete object:** If response is cut off mid-stream, find last `}` and close array

### Session Caching

All AI responses cached in `sessionStorage` with composite key:
```javascript
cacheKey = "places|Delhi,Mumbai|2024-12-01|2024-12-15"
```

Survives screen navigation within same browser tab. Clears on tab close.

**Trade-off:** Caching is in-memory + sessionStorage. Production could add Redis for multi-user, but out of scope.

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
```

Prevents `_leaflet_id` null errors on saved trip load + theme toggle.

### Image Fetching Strategy

For each place, app fetches images using location context:

```javascript
query = "{place name} {city} landmark"
// "Taj Mahal Agra landmark" gets far better results than "Taj Mahal"
```

Results scored by keyword overlap. Unsplash fallback to Picsum if no key.

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
4. **Session cache** — revisiting discovery screen doesn't refetch places

### For Self-Hosting

1. **Enable Gzip compression** on your web server
2. **Set cache headers** on map tiles (immutable, 1-year expiry)
3. **Lazy-load Leaflet** — only load on itinerary screen (currently always loaded; future optimization)
4. **Consider CDN** for map tiles if hosting outside US

### Browser DevTools Tips

```javascript
// Check session cache size
Object.entries(sessionStorage).filter(([k]) => k.startsWith('atp_')).length

// View all saved trips
JSON.parse(localStorage.getItem('atp_saved_trips')).map(t => ({
  locations: t.locations,
  days: t.itinerary?.days.length
}))

// Calculate storage used
Math.round(JSON.stringify(localStorage.getItem('atp_saved_trips')).length / 1024) + ' KB'
```

---

## Roadmap

### Phase 1 — High Impact (Q1 2025)

- [ ] **Offline mode** (Service Worker + IndexedDB)
  - Cache itinerary + images for offline viewing
  - Sync saved trips when back online
  - Impact: 🔴 Essential for field use

- [ ] **Google Calendar export**
  - Create calendar events for each place
  - Set reminders (1 day before, morning of)
  - Include location + commute time
  - Impact: 🔴 High workflow integration

- [ ] **Travel constraints filters**
  - Wheelchair-accessible places only
  - Vegetarian/vegan restaurant spots
  - Budget tier selection (budget/mid/luxury)
  - Impact: 🔴 Accessibility + inclusivity

### Phase 2 — Medium Impact (Q2 2025)

- [ ] **Dynamic pricing**
  - Live hotel rates (Agoda/Booking)
  - Flight/bus costs (Skyscanner)
  - Real-time entry fees
  - Budget breakdown + alerts

- [ ] **Trip statistics dashboard**
  - Total km traveled (from place coords)
  - Average daily budget
  - Best photo (Unsplash highest-rated)
  - Elevation profile (mountain trips)

- [ ] **Multi-user trip editing** (beta)
  - Shareable edit link (not just view)
  - Real-time sync (WebSocket)
  - Collaborative place voting

- [ ] **AI packing list generator**
  - Based on weather + activities
  - Luggage weight estimate
  - Rental vs. buy recommendations

### Phase 3 — Polish & Scale (Q3–Q4 2025)

- [ ] **Internationalization (i18n)**
  - Support 10+ languages
  - Regional currency display (€, £, ¥, etc.)
  - Locale-aware date formats

- [ ] **Social features**
  - Share trip + collect feedback
  - See friends' past itineraries
  - Vote on best places

- [ ] **Content curation**
  - Seasonal trip templates (monsoon safaris, winter treks)
  - Guided tour operator directory
  - User-submitted itineraries

- [ ] **Analytics & telemetry**
  - Track which AI provider performs best
  - Popular destinations heat map
  - Common trip durations

---

## Troubleshooting

### "All AI providers failed"

**Symptoms:** Error message after clicking "Plan My Trip"

**Causes:**
1. No API keys configured (check Netlify env vars)
2. All providers rate-limited (unlikely; Groq free tier is 30 RPM)
3. Network issue (check browser DevTools → Network tab)

**Solution:**
- ✅ Ensure `GROQ_API_KEY` is set in Netlify env vars
- ✅ Try again in 1 minute (rate limit timeout)
- ✅ Check console logs (DevTools → Console): which provider failed?

---

### Images show as gray placeholders

**Symptoms:** Place cards display SVG fallback instead of Unsplash photos

**Causes:**
1. `UNSPLASH_ACCESS_KEY` not configured (app still works, just uses fallback)
2. Unsplash API key invalid or rate-limited
3. Network blocked Unsplash (corporate firewall)

**Solution:**
- ✅ Add valid Unsplash key to Netlify env vars
- ✅ Check Unsplash console (api.unsplash.com) for rate limits
- ✅ App works fine without Unsplash; SVG fallback is acceptable

---

### Map won't load or shows blank

**Symptoms:** Map container is empty or shows "Map failed to load"

**Causes:**
1. Leaflet JS not loaded (rare; CDN issue)
2. Coordinates invalid (place has no lat/lng)
3. Browser cookies/storage quota exceeded

**Solution:**
- ✅ Hard refresh (Ctrl+Shift+R on Windows, Cmd+Shift+R on Mac)
- ✅ Clear browser cache: Settings → Privacy → Clear browsing data
- ✅ Check browser console for errors (DevTools → Console)

---

### Saved trips not persisting

**Symptoms:** Trips disappear after browser restart

**Causes:**
1. **Private/Incognito mode** — localStorage not available
2. **Cookies disabled** — localStorage disabled too
3. **Storage quota full** (3 MB limit)

**Solution:**
- ✅ Use **normal browsing mode** (not Incognito)
- ✅ Enable cookies: Settings → Privacy → Allow cookies
- ✅ Delete old trips: "My Trips" modal → ✕ button
- ✅ Clear browser cache if quota mysteriously full

---

### PDF export has broken images

**Symptoms:** PDF downloads but place thumbnails are missing/blank

**Causes:**
1. Unsplash images timed out (slow network)
2. Image URL is base64 (not allowed in PDF)
3. jsPDF couldn't load image (CORS issue)

**Solution:**
- ✅ Ensure Unsplash key is configured + valid
- ✅ Try again on faster network
- ✅ App gracefully skips broken images; PDF will have text-only fallback

---

### Keyboard shortcuts don't work

**Symptoms:** Ctrl+S or Ctrl+D don't save/download

**Causes:**
1. Not on itinerary screen (shortcuts only active there)
2. Modal open (modals steal focus)
3. Browser intercepting shortcut (rare; some browsers override)

**Solution:**
- ✅ Make sure itinerary screen is active (no modals open)
- ✅ Click "Save" / "PDF" button instead (same effect)
- ✅ Try different browser if still failing

---

### Weather badges missing on saved trip load

**Symptoms:** Loaded trip shows itinerary but no weather info

**Causes:**
1. Weather API key not configured (optional, fails gracefully)
2. API response timed out
3. Weather data for trip dates expired (older than 5 days)

**Solution:**
- ✅ This is **not an error**; weather is optional enhancement
- ✅ Weather only fetches for next 5 days (OpenWeatherMap limit)
- ✅ Regenerate itinerary to fetch fresh weather

---

### Mobile app layout broken on specific devices

**Symptoms:** Text overflows, buttons misaligned, map too tall

**Causes:**
1. Very old Android browser (pre-Chrome 90)
2. Non-standard viewport (tablet + keyboard combo)
3. Custom font size in OS settings

**Solution:**
- ✅ Upgrade to latest Chrome/Safari version
- ✅ Reset device font size to default
- ✅ Try landscape orientation

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
- **CSS custom properties** — use `--accent`, `--bg-card` for all colors
- **Comments** — explain "why", not "what"
- **Functions** — keep < 50 lines; split into modules
- **Errors** — always use `showToast()` for user feedback, never `alert()`
- **Accessibility** — always add `aria-*` labels to interactive elements

### Testing Before PR

- [ ] Run `npm run dev` and test all 3 screens
- [ ] Add destination + places + generate itinerary
- [ ] Save trip + reload browser → trip still there
- [ ] Share link + open in new incognito window → pre-fills
- [ ] Download PDF + verify images + formatting
- [ ] Copy to clipboard + paste in WhatsApp
- [ ] Test dark/light theme toggle
- [ ] Test on mobile (DevTools → iPhone 12 emulation)
- [ ] Check browser console for errors

---

## License

MIT License — free to use, modify, and distribute. See LICENSE file.

---

## Acknowledgments

- **Leaflet.js** team for excellent map library
- **Groq** for incredible Llama 3.3 70B speed
- **OpenWeatherMap** for reliable weather data
- **Unsplash** for gorgeous place photography
- **OpenStreetMap** community for map data

---

## Changelog

### v1.1.0 (Current)
- ✅ Multi-provider AI fallback (Groq → Gemini → OpenRouter)
- ✅ Storage quota management + visual meter
- ✅ Weather integration (OpenWeatherMap)
- ✅ Custom place paste (textarea)
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
- Expected behavior
- Actual behavior
- Device + browser + version
- Screenshots/console logs

**Questions?** Check the [troubleshooting section](#troubleshooting) or email: sdukesameer@gmail.com

**Want to sponsor development?** Reach out! We're always looking for support.

---

*Generated itineraries are for planning purposes only. Always check official sources for current opening hours, entry fees, and closures before visiting.*

**Built with ❤️ by Md Sameer • Deployed on Netlify • Powered by Groq + Gemini + OpenRouter**
