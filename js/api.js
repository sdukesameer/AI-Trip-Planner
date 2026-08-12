// ============================================================
//  api.js — AI provider abstraction with fallback chain
// ============================================================

import { mapLimit, fetchWithTimeout, parseYMD, addDays, weekdayName } from './util.js';

// ── AI Provider Definitions (direct calls — local dev only) ───────
const AI_PROVIDERS = [
    // TIER 1: Gemini 2.5 Flash — best quality, TTFT 0.37s. Free: 10 RPM / 250 RPD.
    { name: 'Gemini 2.5 Flash', model: 'gemini-2.5-flash', type: 'gemini' },
    { name: 'Gemini 2.5 Flash Lite', model: 'gemini-2.5-flash-lite', type: 'gemini' },

    // TIER 2: Groq — 1–3s full response, 14,400 req/day free. Catches Gemini 429s.
    { name: 'Llama 3.3 70B Versatile (Groq)', model: 'llama-3.3-70b-versatile', type: 'groq' },
    { name: 'Llama 3.1 8B Instant (Groq)', model: 'llama-3.1-8b-instant', type: 'groq' },

    // TIER 3: OpenRouter — 50 req/day free (cut Apr 2025). Last resort only.
    { name: 'OpenRouter Llama 3.1 8B', model: 'meta-llama/llama-3.1-8b-instruct:free', type: 'openrouter' },
];

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';
const UNSPLASH_BASE = 'https://api.unsplash.com/search/photos';
const PROXY_AI = '/.netlify/functions/ai-proxy';
const PROXY_IMAGES = '/.netlify/functions/unsplash-proxy';
const PROXY_WEATHER = '/.netlify/functions/weather-proxy';

const REQUEST_TIMEOUT_MS = 25000;  // direct provider calls (local dev)
const PROXY_TIMEOUT_MS = 9500;     // the function itself gives up at ~9s
const IMAGE_CONCURRENCY = 6;       // parallel Unsplash lookups
const MAX_ITINERARY_CHUNKS = 8;    // 8 × 7 days = 56-day ceiling on AI calls

// Whether the serverless proxy is reachable. `null` = not probed yet.
// Probing rather than hostname-sniffing means `netlify dev` on localhost works too.
let _proxyAvailable = null;

function looksLikeLocalStatic() {
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '' || window.location.protocol === 'file:';
}

/** `true` proxy reachable, `false` proxy confirmed missing, `null` not probed yet. */
export function proxyAvailability() { return _proxyAvailable; }

let lastProviderUsed = '';
export function getLastProvider() { return lastProviderUsed; }

// ── Proxied AI call (production) ─────────────────────────────
async function callViaProxy(prompt) {
    const res = await fetchWithTimeout(PROXY_AI, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
    }, PROXY_TIMEOUT_MS);

    if (res.status === 404) {
        _proxyAvailable = false;
        throw new Error('Proxy not deployed');
    }
    if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(msg.slice(0, 300));
    }
    _proxyAvailable = true;
    return await res.json();
}

// ── Core: Smart AI Call with Fallback ────────────────────────
async function smartAICall(prompt, config, onProviderSwitch) {
    const errors = [];
    const hasDirectKeys = Boolean(config?.geminiKey || config?.groqKey || config?.openrouterKey);

    // Try the proxy unless we already know it isn't there. Keys stay server-side.
    if (_proxyAvailable !== false) {
        if (onProviderSwitch) onProviderSwitch('Connecting to AI…');
        try {
            const data = await callViaProxy(prompt);
            lastProviderUsed = data.providerUsed || 'AI';
            if (onProviderSwitch) onProviderSwitch(lastProviderUsed);
            return data.text || '';
        } catch (err) {
            console.warn('[proxy] failed:', err.message);
            errors.push(`Server: ${err.message}`);
            if (!hasDirectKeys) {
                // Nothing else to try — surface the real reason instead of a
                // misleading "all providers failed".
                throw new Error(
                    _proxyAvailable === false
                        ? 'AI service is not configured. Deploy the Netlify functions, or add keys to js/env.local.js for local development.'
                        : `AI service is unavailable right now. (${err.message})`
                );
            }
            if (onProviderSwitch) onProviderSwitch('Retrying directly…');
        }
    }

    // Local dev: call APIs directly using keys from js/env.local.js
    for (const provider of AI_PROVIDERS) {
        if (provider.type === 'groq' && !config.groqKey) continue;
        if (provider.type === 'gemini' && !config.geminiKey) continue;
        if (provider.type === 'openrouter' && !config.openrouterKey) continue;

        if (onProviderSwitch) onProviderSwitch(provider.name);
        try {
            let text;
            if (provider.type === 'gemini') text = await callGemini(config.geminiKey, provider.model, prompt);
            else if (provider.type === 'groq') text = await callGroq(config.groqKey, provider.model, prompt);
            else text = await callOpenRouter(config.openrouterKey, provider.model, prompt);

            if (!text) throw new Error('Empty response');
            lastProviderUsed = provider.name;
            return text;
        } catch (err) {
            console.warn(`[${provider.name}] failed:`, err.message);
            errors.push(`${provider.name}: ${err.message}`);
        }
    }
    throw new Error('All AI providers failed:\n' + errors.join('\n'));
}

// ── Gemini API Call (v1beta with working models) ───────────────
async function callGemini(apiKey, model, prompt) {
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }, REQUEST_TIMEOUT_MS);

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── OpenAI-compatible chat call (Groq / OpenRouter) ───────────
async function callChatCompletions(endpoint, apiKey, model, prompt) {
    const res = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: 'You are an expert travel planner. Always respond with valid JSON only, no markdown fences, no explanation.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.7,
            max_tokens: 8192,
        }),
    }, REQUEST_TIMEOUT_MS);

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
}

const callGroq = (key, model, prompt) => callChatCompletions(GROQ_BASE, key, model, prompt);
const callOpenRouter = (key, model, prompt) => callChatCompletions(OPENROUTER_BASE, key, model, prompt);

// ── JSON Extraction + Repair ─────────────────────────────────
function extractJSON(text) {
    if (!text || typeof text !== 'string') throw new Error('Empty AI response');

    // Strip markdown fences
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    let raw = fenceMatch ? fenceMatch[1] : text;

    // Find outermost JSON boundaries
    const start = raw.search(/[\[{]/);
    const lastBrace = raw.lastIndexOf('}');
    const lastBracket = raw.lastIndexOf(']');
    const end = Math.max(lastBrace, lastBracket);
    if (start === -1 || end === -1) throw new Error('No JSON found in response');
    raw = raw.slice(start, end + 1);

    try { return JSON.parse(raw); } catch { /* fall through to repair */ }

    // Repair pass 1: trailing commas and stray tabs (safe, string-preserving).
    let repaired = raw.replace(/,\s*([}\]])/g, '$1').replace(/\t/g, ' ');
    try { return JSON.parse(repaired); } catch { /* keep repairing */ }

    // Repair pass 2: missing commas between adjacent values on separate lines.
    // Only applied when pass 1 failed, since it can corrupt multi-line strings.
    const commaFixed = repaired.replace(/(["\d\]}])\s*\n\s*(["\[{])/g, '$1,\n$2');
    try { return JSON.parse(commaFixed); } catch { /* keep repairing */ }

    // Repair pass 3: the response was truncated mid-object (token limit).
    // Close it off after the last complete element.
    const isArray = repaired.trimStart()[0] === '[';
    for (const cut of [repaired.lastIndexOf('},'), repaired.lastIndexOf('}')]) {
        if (cut <= 0) continue;
        const candidate = repaired.slice(0, cut + 1) + (isArray ? ']' : '}');
        try { return JSON.parse(candidate); } catch { /* try next */ }
        // Nested one level deeper (truncated inside a "places" array)
        try { return JSON.parse(repaired.slice(0, cut + 1) + (isArray ? ']' : ']}]}')); } catch { /* give up */ }
    }

    throw new Error('The AI returned malformed data. Please try again.');
}

// ── Normalisation ─────────────────────────────────────────────
const CATEGORIES = ['Heritage', 'Nature', 'Religious', 'Market', 'Museum', 'Entertainment', 'Food'];

function normalizeCategory(cat) {
    const c = String(cat || '').trim();
    const hit = CATEGORIES.find(k => k.toLowerCase() === c.toLowerCase());
    return hit || (c ? 'Heritage' : '');
}

/** Coerce whatever the model returned into a clean array of place objects. */
function normalizePlaces(data, fallbackLocation = '') {
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.places) ? data.places : []);
    const seen = new Set();
    return arr
        .filter(p => p && typeof p.name === 'string' && p.name.trim())
        .map(p => ({
            name: String(p.name).trim().slice(0, 120),
            location: String(p.location || fallbackLocation || '').trim().slice(0, 120),
            shortDesc: String(p.shortDesc || p.desc || '').trim().slice(0, 300),
            category: normalizeCategory(p.category),
            lat: Number.isFinite(Number(p.lat)) ? Number(p.lat) : undefined,
            lng: Number.isFinite(Number(p.lng)) ? Number(p.lng) : undefined,
        }))
        .filter(p => {
            const k = p.name.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
}

// Coordinates are no longer decoration — the planner clusters on them, so every
// discovery call has to ask for them explicitly.
const PLACE_SCHEMA = `{ "location": "<city>", "name": "<place name>", "shortDesc": "<1 sentence description>", "category": "<Heritage|Nature|Religious|Market|Museum|Entertainment|Food>", "lat": <decimal latitude>, "lng": <decimal longitude> }`;
const COORD_RULE = `"lat" and "lng" MUST be the real-world decimal coordinates of the place, accurate to 3+ decimal places. Never guess a city-centre coordinate for a specific landmark — accuracy here decides how the days are grouped.`;

// ── API Call 1: Famous Places ─────────────────────────────────
export async function fetchFamousPlaces(config, locations, onProviderSwitch, perLocation = 8) {
    const locStr = locations.join(', ');
    const prompt = `You are a travel expert. For the locations: ${locStr}, return a JSON array of ${perLocation} famous tourist places per location, sorted by popularity.
Each item: ${PLACE_SCHEMA}
${COORD_RULE}
Return ONLY valid JSON array, no explanation, no markdown.`;
    const text = await smartAICall(prompt, config, onProviderSwitch);
    return normalizePlaces(extractJSON(text), locations[0]);
}

// ── API Call 1b: Fetch More Places ────────────────────────────
export async function fetchMorePlaces(config, location, existingNames, onProviderSwitch, count = 6) {
    const exclude = existingNames.slice(0, 25).join(', ');
    const prompt = `You are a travel expert. List ${count} more famous tourist places in ${location} that are NOT already in this list: [${exclude}].
Sort by popularity. Each item: ${PLACE_SCHEMA.replace('"<city>"', `"${location}"`)}
${COORD_RULE}
Return ONLY valid JSON array, no explanation.`;
    const text = await smartAICall(prompt, config, onProviderSwitch);
    return normalizePlaces(extractJSON(text), location);
}

// ── API Call 1c: Search Nearby Places ────────────────────────
export async function searchNearbyPlaces(config, query, onProviderSwitch) {
    let locationLabel = query;
    let coordsLine = '';
    try {
        const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`;
        const geoRes = await fetchWithTimeout(geoUrl, { headers: { 'Accept-Language': 'en' } }, 8000);
        if (geoRes.ok) {
            const geoData = await geoRes.json();
            if (geoData[0]) {
                const { lat, lon, display_name } = geoData[0];
                locationLabel = display_name.split(',').slice(0, 3).join(',');
                coordsLine = `Coordinates: ${parseFloat(lat).toFixed(4)}, ${parseFloat(lon).toFixed(4)}.`;
            }
        }
    } catch { /* geocoding is a nicety, not a requirement */ }

    const prompt = `You are a travel expert. List 6 famous tourist attractions near or in "${locationLabel}". ${coordsLine}
Each item: ${PLACE_SCHEMA.replace('"<city>"', '"<area or city>"')}
${COORD_RULE}
Return ONLY valid JSON array, no explanation.`;

    const text = await smartAICall(prompt, config, onProviderSwitch);
    return normalizePlaces(extractJSON(text), locationLabel);
}

// ── Geocode the stay / hotel so it can anchor each day ────────
export async function geocodeStay(config, stayName, cityHint, onProviderSwitch) {
    if (!stayName?.trim()) return null;

    // Prefer OpenStreetMap: a named hotel is exactly what it is good at, and it
    // costs no AI tokens.
    try {
        const q = [stayName, cityHint].filter(Boolean).join(', ');
        const res = await fetchWithTimeout(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
            { headers: { 'Accept-Language': 'en' } }, 8000);
        if (res.ok) {
            const data = await res.json();
            if (data[0]) {
                return { name: stayName.trim(), lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), source: 'osm' };
            }
        }
    } catch { /* fall through to the model */ }

    try {
        const prompt = `Return ONLY JSON: { "name": "${stayName.replace(/"/g, '')}", "lat": <decimal>, "lng": <decimal> }
These are the coordinates of "${stayName}" in ${cityHint || 'India'}. If you are unsure of the exact address, return the coordinates of the neighbourhood it is in. No explanation.`;
        const parsed = extractJSON(await smartAICall(prompt, config, onProviderSwitch));
        if (Number.isFinite(Number(parsed?.lat)) && Number.isFinite(Number(parsed?.lng))) {
            return { name: stayName.trim(), lat: Number(parsed.lat), lng: Number(parsed.lng), source: 'ai' };
        }
    } catch { /* the stay anchor is optional */ }

    return null;
}

// ── API Call 2: Fetch Unsplash Images ────────────────────────
export async function fetchPlaceImages(placeItems, unsplashKey, { hasImages = false } = {}) {
    const items = placeItems.map(p => (typeof p === 'string' ? { name: p, location: '' } : p));
    const cache = {};
    if (!items.length) return cache;

    const directKey = unsplashKey && unsplashKey.length > 10 ? unsplashKey : '';
    const canProxy = _proxyAvailable !== false && (hasImages || !looksLikeLocalStatic());

    if (!directKey && !canProxy) {
        for (const { name } of items) cache[name] = picsumFallback(name);
        return cache;
    }

    const lookup = async (query) => {
        if (canProxy) {
            try {
                const proxyUrl = `${PROXY_IMAGES}?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`;
                const res = await fetchWithTimeout(proxyUrl, {}, 10000);
                if (res.status === 404) _proxyAvailable = false;
                else if (res.ok) {
                    const data = await res.json();
                    if (data.results?.length) return data.results;
                    return [];
                }
            } catch { /* fall through to a direct call if we have a key */ }
        }
        if (!directKey) return [];
        const url = `${UNSPLASH_BASE}?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape&client_id=${directKey}`;
        const res = await fetchWithTimeout(url, {}, 10000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data.results || [];
    };

    // Run lookups concurrently — the old sequential loop made a 14-place grid
    // wait for 14 round trips in series.
    await mapLimit(items, IMAGE_CONCURRENCY, async ({ name, location }) => {
        try {
            const cleanName = name.replace(/[^a-zA-Z0-9 ]/g, '').trim();
            const cityOnly = (location || '').split(',')[0].replace(/[^a-zA-Z0-9 ]/g, '').trim();
            const specificQuery = [cleanName, cityOnly].filter(Boolean).join(' ');

            let results = await lookup(specificQuery);
            if (!results.length && cityOnly) results = await lookup(cleanName);

            // Prefer photos whose description/tags actually mention the place.
            const nameWords = cleanName.toLowerCase().split(' ').filter(w => w.length > 3);
            const scored = results
                .map(r => {
                    const haystack = [r.description || '', r.alt_description || '', r.tags?.map(t => t.title).join(' ') || '']
                        .join(' ').toLowerCase();
                    return { url: r.urls?.small, score: nameWords.filter(w => haystack.includes(w)).length };
                })
                .filter(r => r.url)
                .sort((a, b) => b.score - a.score);

            cache[name] = scored[0]?.url || picsumFallback(name);
        } catch (err) {
            console.warn(`[Unsplash] "${name}":`, err.message);
            cache[name] = picsumFallback(name);
        }
    });

    return cache;
}

export function picsumFallback(name) {
    const seed = Math.abs(name.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0)) % 1000;
    return `https://picsum.photos/seed/${seed}/400/300`;
}

export function svgPlaceholder(name) {
    const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6'];
    const color = colors[Math.abs(name.charCodeAt(0) || 0) % colors.length];
    const label = encodeURIComponent(String(name).slice(0, 20).replace(/[<>&"']/g, ''));
    return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect fill='${color.slice(1)}' width='400' height='300'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='0.3em' fill='%23fff' font-family='Arial' font-size='24'%3E${label}%3C/text%3E%3C/svg%3E`;
}

// ── API Call 3: Schedule a pre-clustered zone plan ────────────
/** Turn the preferences panel into prompt constraints. */
function buildPreferenceLines(prefs = {}) {
    const lines = [];
    const currency = prefs.currency || '₹';
    if (prefs.startTime) lines.push(`- Each day starts at ${prefs.startTime}.`);
    const budget = { shoestring: 'Budget traveller: favour free/low-cost options, street food, public transport.', moderate: 'Mid-range budget: mix of paid attractions and casual dining.', comfort: 'Comfort budget: premium experiences and private cabs are fine.' }[prefs.budget];
    if (budget) lines.push(`- ${budget}`);
    const transport = {
        walk: 'The traveller prefers to walk wherever possible — prioritise walking directions.',
        transit: 'The traveller uses public transport (metro/bus) — give specific lines and stations.',
        cab: 'The traveller uses taxis/ride-hailing — give realistic fare ranges.',
        drive: 'The traveller is self-driving — mention parking availability at each stop.',
        mixed: 'Mixed transport — recommend the most sensible option for each leg.',
    }[prefs.transport];
    if (transport) lines.push(`- ${transport}`);
    if (prefs.interests?.length) lines.push(`- Interests to emphasise in descriptions: ${prefs.interests.join(', ')}.`);
    if (prefs.travellers > 1) lines.push(`- Group of ${prefs.travellers} travellers — quote costs per person in ${currency}.`);
    if (prefs.withKids) lines.push('- Travelling with children: flag long walks, note kid-friendly facilities.');
    if (prefs.accessibility) lines.push('- Step-free access required: state clearly when a place is NOT wheelchair accessible.');
    if (prefs.avoid) lines.push(`- Avoid recommending: ${prefs.avoid}.`);
    return lines.length ? `\nTRAVELLER PREFERENCES:\n${lines.join('\n')}\n` : '';
}

/**
 * The days, their places and their order are already fixed by planner.js.
 * The model's only job here is to describe and schedule them — it cannot move a
 * place to another day, which is what used to wreck the geography.
 */
export async function scheduleZonePlan(config, plan, opts, onProviderSwitch) {
    const { locations = [], prefs = {}, stay = null } = opts;
    const days = plan.days.filter(d => d.places.length);
    if (!days.length) return { summary: '', days: [] };

    const chunks = [];
    for (let i = 0; i < days.length; i += 4) chunks.push(days.slice(i, i + 4));

    const scheduled = [];
    let summary = '';

    for (const chunk of chunks.slice(0, MAX_ITINERARY_CHUNKS)) {
        const result = await scheduleChunk(config, chunk, { locations, prefs, stay }, onProviderSwitch);
        if (result.summary && !summary) summary = result.summary;
        scheduled.push(...(result.days || []));
    }

    // Merge the model's schedule back onto our places, matching by name. Our
    // order and coordinates always win.
    const byDay = new Map(scheduled.map(d => [Number(d.day), d]));
    const merged = plan.days.map(planDay => {
        const ai = byDay.get(Number(planDay.day)) || {};
        const aiPlaces = new Map((ai.places || []).map(p => [String(p.name || '').toLowerCase().trim(), p]));

        return {
            day: planDay.day,
            date: planDay.date,
            location: planDay.location,
            theme: ai.theme || 'Explore',
            zoneName: ai.zoneName || '',
            spreadKm: planDay.spreadKm,
            meals: Array.isArray(ai.meals) ? ai.meals.slice(0, 3) : [],
            places: planDay.places.map(place => {
                const detail = aiPlaces.get(place.name.toLowerCase().trim()) || {};
                return {
                    ...place,
                    desc: detail.desc || place.shortDesc || '',
                    category: place.category || detail.category || '',
                    openingHours: detail.openingHours || '',
                    closedDays: detail.closedDays || '',
                    entryFee: detail.entryFee || '',
                    arrivalTime: detail.arrivalTime || '',
                    visitDuration: detail.visitDuration || '',
                    bestTime: detail.bestTime || '',
                    closedNote: detail.closedNote || '',
                    accessibility: detail.accessibility || '',
                    commute_from_prev: detail.commute_from_prev || null,
                };
            }),
        };
    });

    return {
        summary: summary || `${plan.days.length}-day trip across ${locations.join(' & ')}`,
        days: merged.filter(d => d.places.length),
    };
}

async function scheduleChunk(config, days, { locations, prefs, stay }, onProviderSwitch) {
    const currency = prefs.currency || '₹';
    const startTime = prefs.startTime || '10:00 AM';
    const stayLine = stay
        ? `\nThe traveller is staying at: ${stay.name}. Each day begins and ends there.\n`
        : '';

    const dayBlocks = days.map(d => {
        const list = d.places.map((p, i) => `    ${i + 1}. ${p.name}${p.category ? ` [${p.category}]` : ''}`).join('\n');
        return `Day ${d.day} — ${d.date} (${weekdayName(d.date)}) — ${d.location}
  Places, already grouped by neighbourhood and ordered to minimise travel. Keep this exact order:
${list}`;
    }).join('\n\n');

    const prompt = `You are a professional travel guide writing the day-by-day detail for an itinerary in ${locations.join(', ')}.

The geographic planning is ALREADY DONE. Below, each day lists its places in a fixed order.
${stayLine}${buildPreferenceLines(prefs)}
${dayBlocks}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ABSOLUTE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Do NOT add, remove, reorder or move any place between days. Return exactly the places listed for each day, in the given order, using the EXACT names shown.
2. Schedule each day starting at ${startTime}:
   place[0].arrivalTime = ${startTime}
   place[n].arrivalTime = place[n-1].arrivalTime + place[n-1].visitDuration + transit time
   Transit within a neighbourhood: 15–30 min. Keep the whole day under ~8 hours.
3. Realistic visit durations: major fort/palace/temple complex 2–3 hrs · large museum 2 hrs · garden/park 1–1.5 hrs · market 1.5 hrs · small monument/viewpoint 30–45 min.
4. Check the weekday shown for each day. Many museums close on Mondays and some sites have weekly rest days. If a place is closed on that exact date, say so in "closedNote". Always fill "closedDays" with the weekly closing day (or "None").
5. Insert meal breaks in "meals" — lunch always, breakfast/dinner when they fit. Suggest a real, specific place near that day's route.
6. All money in ${currency}.
7. Return ONLY valid JSON. No markdown fences, no trailing commas, no commentary.

FORMAT (follow exactly):
{
  "summary": "<1-2 line overview of the whole trip>",
  "days": [{
    "day": <number as given>,
    "theme": "<creative day theme, e.g. 'Mughal Grandeur & Old Delhi'>",
    "zoneName": "<the neighbourhood/area this day covers, e.g. 'Old Delhi'>",
    "places": [{
      "name": "<EXACT name as given above>",
      "desc": "<2-3 engaging sentences>",
      "openingHours": "<e.g. 9:00 AM – 5:00 PM or 'Open 24hrs'>",
      "closedDays": "<e.g. Monday, or None>",
      "entryFee": "<e.g. ${currency}40 or 'Free'>",
      "arrivalTime": "<e.g. 10:00 AM>",
      "visitDuration": "<e.g. 2 hrs>",
      "bestTime": "<e.g. Early morning before crowds>",
      "closedNote": "<only if closed or restricted on this exact date, else omit>",
      "accessibility": "<'Step-free' | 'Partly accessible' | 'Not wheelchair accessible'>",
      "commute_from_prev": { "walk": "<minutes or N/A>", "cab": "<${currency}range or N/A>", "metro": "<line/station or N/A>" }
    }],
    "meals": [{ "type": "<Breakfast|Lunch|Dinner>", "time": "<e.g. 1:00 PM>", "suggestion": "<specific restaurant or dish>", "area": "<where>", "approxCost": "<${currency}per person>" }]
  }]
}`;

    const text = await smartAICall(prompt, config, onProviderSwitch);
    return extractJSON(text);
}

// ── Re-schedule a single day after edits ─────────────────────
export async function rescheduleDay(config, day, opts, onProviderSwitch) {
    const plan = { days: [{ ...day, places: day.places }] };
    const result = await scheduleZonePlan(config, plan, opts, onProviderSwitch);
    return result.days[0] || day;
}

// ── Suggest swap candidates near a place ─────────────────────
export async function suggestAlternatives(config, place, dayPlaces, cityHint, onProviderSwitch) {
    const exclude = dayPlaces.map(p => p.name).join(', ');
    const near = Number.isFinite(place.lat) && Number.isFinite(place.lng)
        ? `within about 4 km of (${place.lat.toFixed(3)}, ${place.lng.toFixed(3)})`
        : `in the same area of ${cityHint}`;

    const prompt = `You are a travel expert. Suggest 3 alternative places to visit ${near}, in ${cityHint}, that a tourist could visit instead of "${place.name}".
Do NOT suggest any of these (already in the plan): [${exclude}].
Each item: ${PLACE_SCHEMA.replace('"<city>"', `"${cityHint}"`)}
${COORD_RULE}
Return ONLY a valid JSON array of 3 items.`;
    const text = await smartAICall(prompt, config, onProviderSwitch);
    return normalizePlaces(extractJSON(text), cityHint).slice(0, 3);
}

// ── Packing list ──────────────────────────────────────────────
export async function generatePackingList(config, { locations, startDate, endDate, days, weather, prefs }, onProviderSwitch) {
    const categories = [...new Set(days.flatMap(d => d.places.map(p => p.category)).filter(Boolean))];
    const wx = Object.values(weather || {});
    const weatherLine = wx.length
        ? `Forecast: ${wx.map(w => `${w.date} ${w.temp_min}–${w.temp_max}°C ${w.description}${w.pop > 30 ? ` (${w.pop}% rain)` : ''}`).join('; ')}`
        : 'No forecast available — assume typical seasonal weather.';

    const prompt = `You are an experienced traveller. Build a packing list for this trip.
Destinations: ${locations.join(', ')}
Dates: ${startDate} to ${endDate} (${days.length} days)
Activities: ${categories.join(', ') || 'general sightseeing'}
Travellers: ${prefs.travellers || 1}${prefs.withKids ? ' (including children)' : ''}
${weatherLine}

Return ONLY JSON:
{ "groups": [ { "name": "<e.g. Clothing|Documents|Health|Electronics|Day bag>", "items": ["<item>", "..."] } ] }
6 groups maximum, 8 items maximum per group. Be specific to these destinations, this weather and these activities — not a generic list.`;
    const parsed = extractJSON(await smartAICall(prompt, config, onProviderSwitch));
    return Array.isArray(parsed?.groups) ? parsed.groups.slice(0, 6) : [];
}

// ── Practical / local info ───────────────────────────────────
export async function generatePracticalInfo(config, locations, onProviderSwitch) {
    const prompt = `Give practical on-the-ground information for a tourist visiting ${locations.join(', ')}.

Return ONLY JSON:
{
  "emergency": { "police": "<number>", "ambulance": "<number>", "fire": "<number>", "tourist_helpline": "<number or N/A>" },
  "currency": "<local currency + code>",
  "plug": "<socket types and voltage>",
  "tipping": "<1 sentence on local tipping norms>",
  "transport": "<1-2 sentences: best way to get around, which apps/cards to use>",
  "safety": ["<short practical tip>", "..."],
  "etiquette": ["<short custom or dress-code note>", "..."],
  "phrases": [{ "local": "<phrase in the local language>", "meaning": "<english>" }]
}
Maximum 4 safety tips, 4 etiquette notes and 5 phrases. No explanation.`;
    return extractJSON(await smartAICall(prompt, config, onProviderSwitch));
}

export async function enrichCustomPlaces(config, placeNames, locationHint, onProviderSwitch) {
    if (!placeNames.length) return [];
    const prompt = `You are a travel expert. For each of the following places, return a JSON array with a short description and category.
Places: ${placeNames.map((n, i) => `${i + 1}. ${n}`).join(', ')}
Location context: ${locationHint || 'India'}

For each place return: { "name": "<exact name as given>", "shortDesc": "<1 engaging sentence about this place>", "category": "<Heritage|Nature|Religious|Market|Museum|Entertainment|Food>", "location": "<city or area it belongs to>" }
Return ONLY a valid JSON array. No explanation, no markdown.`;
    const text = await smartAICall(prompt, config, onProviderSwitch);
    return normalizePlaces(extractJSON(text), locationHint);
}

// ── Weather API ───────────────────────────────────────────────
const _weatherCache = new Map();
let _weatherAvailable = true;

export async function fetchWeatherForDays(days) {
    if (!_weatherAvailable) return {};

    const cutoff = addDays(new Date(), 5);
    const results = {};
    const cityDates = {};

    days.forEach(day => {
        if (!day.location || !day.date) return;
        if (parseYMD(day.date) > cutoff) return;   // free tier only covers 5 days
        const cleanCity = day.location.split(/[&,]/)[0].trim();
        if (!cleanCity) return;
        (cityDates[cleanCity] = cityDates[cleanCity] || []).push(day.date);
    });

    await Promise.all(Object.entries(cityDates).map(async ([city, dates]) => {
        let forecasts = _weatherCache.get(city);
        if (!forecasts) {
            try {
                const res = await fetchWithTimeout(`${PROXY_WEATHER}?city=${encodeURIComponent(city)}`, {}, 8000);
                // 503 = key not configured. A non-JSON 404 means the function
                // isn't deployed at all; a JSON 404 is just an unknown city, so
                // only the former should switch weather off for the session.
                const isJson = (res.headers.get('content-type') || '').includes('json');
                if (res.status === 503 || (res.status === 404 && !isJson)) { _weatherAvailable = false; return; }
                if (!res.ok) return;
                forecasts = await res.json();
                if (!Array.isArray(forecasts)) return;
                _weatherCache.set(city, forecasts);
            } catch { return; }
        }
        dates.forEach(date => {
            const match = forecasts.find(f => f.date === date);
            if (match) results[date] = match;
        });
    }));

    return results;
}

export function weatherEmoji(icon = '') {
    const map = {
        '01': '☀️', '02': '🌤️', '03': '🌥️', '04': '☁️',
        '09': '🌧️', '10': '🌦️', '11': '⛈️', '13': '❄️', '50': '🌫️',
    };
    return map[String(icon).slice(0, 2)] || '🌡️';
}
