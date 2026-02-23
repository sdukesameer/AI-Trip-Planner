# ✈️ AI Trip Planner

An AI-powered travel itinerary planner that creates personalized day-by-day trip plans with interactive maps, place images, commute info, and downloadable itineraries.

![AI Trip Planner](https://source.unsplash.com/1200x400/?travel,adventure)

## ✨ Features

- 🤖 **Smart AI Planning** — Uses Gemini AI (with Groq fallback) to generate intelligent itineraries
- 🗺️ **Interactive Map** — OpenStreetMap with day-color-coded markers and route lines
- 📸 **Place Images** — Beautiful thumbnails for every tourist attraction
- 🚇 **Commute Info** — Walking time, cab fare, and metro routes between places
- 📅 **Multi-Day Support** — Handles trips of any length (chunked generation for 7+ days)
- 📍 **Geo-Grouping** — Smart grouping of nearby places on the same day
- 📥 **Download** — Export as PDF, text, or copy to clipboard
- 🔄 **AI Fallback** — Automatic failover: Gemini Flash → Flash-Lite → 1.5 Flash → Groq

## 🚀 Quick Start

### Local Development

1. Clone the repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/ai-trip-planner.git
   cd ai-trip-planner
   ```

2. Start a local server:
   ```bash
   python3 -m http.server 8080
   ```

3. Open `http://localhost:8080` in your browser

4. Click **⚙️ Settings** and add your API keys:
   - **Gemini API Key** — Get free at [aistudio.google.com](https://aistudio.google.com)
   - **Groq API Key** (optional) — Get free at [console.groq.com](https://console.groq.com)

### Deploy to Netlify

1. Push this repo to GitHub

2. Connect the repo to [Netlify](https://app.netlify.com)

3. Set environment variables in Netlify (Site settings → Environment variables):
   | Variable | Description |
   |----------|-------------|
   | `GEMINI_API_KEY` | Your Google Gemini API key |
   | `GROQ_API_KEY` | Your Groq API key (fallback) |

4. Deploy! The build script (`build-env.js`) automatically injects the keys.

## 🏗️ Architecture

```
ai-trip-planner/
├── index.html          ← Main SPA shell (all 3 screens)
├── css/
│   ├── style.css       ← Global design tokens, layout, animations
│   └── components.css  ← Card, accordion, map, discovery styles
├── js/
│   ├── app.js          ← Screen router, state manager
│   ├── api.js          ← AI provider abstraction + fallback chain
│   ├── maps.js         ← Leaflet/OpenStreetMap integration
│   └── download.js     ← PDF / text export
├── build-env.js        ← Netlify build script (injects API keys)
├── netlify.toml        ← Netlify deployment config
└── .gitignore
```

## 🤖 AI Fallback Chain

The app tries AI providers in this order:

1. **Gemini 2.0 Flash** — Fastest, default
2. **Gemini 2.0 Flash-Lite** — Lighter, still fast
3. **Gemini 1.5 Flash** — Older but reliable
4. **Groq (Llama 3.3 70B)** — Fallback if all Gemini models fail

Each attempt has a **45-second timeout**. If one fails, the next is tried automatically with a toast notification.

## 🗺️ Map

Uses **Leaflet.js** with **OpenStreetMap** tiles (CartoDB dark theme) — completely free, no API key required.

## 📄 License

MIT
