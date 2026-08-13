// ============================================================
//  api.js — AI provider abstraction with fallback chain
// ============================================================

import { mapLimit, fetchWithTimeout, parseYMD, addDays, weekdayName } from './util.js';

// ── Endpoints & limits ───────────────────────────────────────
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

// ── AI Provider Definitions (direct calls — local dev only) ───────
// Model IDs are discovered from each provider's list endpoint rather than
// hardcoded: providers retire IDs without notice, and a stale one returns a 404
// that is indistinguishable from a bad key. Production uses the same logic
// server-side in netlify/functions/_models.js — keep the two in step.
//
// `image` is deliberately broad here: discovery once selected
// `gemini-3-pro-image`, an image generator, and every request 404'd.
const EXCLUDED_MODELS = /image|imagen|banana|veo|lyria|sora|dall|tts|audio|speech|voice|music|embed|aqa|rerank|guard|safety|whisper|learnlm|live|realtime|robotics|computer-use|-vl\b|vision/i;

/** Rank against an ordered list of preferred patterns; earlier match wins. */
function pickModels(ids, prefer, take) {
    return ids
        .filter(id => id && !EXCLUDED_MODELS.test(id))
        .map(id => {
            let rank = prefer.findIndex(re => re.test(id));
            if (rank === -1) rank = prefer.length;
            let tie = 0;
            if (/latest/.test(id)) tie -= 2;                       // aliases don't rot
            if (/preview|experimental|\bexp\b/.test(id)) tie += 3;  // retired fastest
            if (/thinking|reasoning/.test(id)) tie += 2;
            return { id, key: rank * 10 + tie };
        })
        .filter(m => m.key < prefer.length * 10)
        .sort((a, b) => a.key - b.key)
        .slice(0, take)
        .map(m => m.id);
}

// Free-tier `pro` quota on Gemini is tiny and 429s almost at once, so the flash
// tiers are the correct choice here, not merely the cheap one.
const LOCAL_SPECS = [
    {
        key: 'geminiKey', type: 'gemini', label: 'Gemini', take: 3,
        prefer: [/^gemini-flash-latest$/, /^gemini-[\d.]+-flash$/, /flash-lite/, /flash/, /gemma/],
        fallback: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.0-flash'],
        async list(k) {
            const res = await fetchWithTimeout(`${GEMINI_BASE}?key=${encodeURIComponent(k)}&pageSize=200`, {}, 6000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return (data.models || [])
                .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                .map(m => String(m.name || '').replace(/^models\//, ''));
        },
    },
    {
        key: 'groqKey', type: 'groq', label: 'Groq', take: 3,
        prefer: [/70b|versatile/, /gpt-oss/, /8b|instant/, /llama|qwen|gemma|mixtral/],
        fallback: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
        async list(k) {
            const res = await fetchWithTimeout('https://api.groq.com/openai/v1/models',
                { headers: { Authorization: `Bearer ${k}` } }, 6000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return ((await res.json()).data || []).map(m => String(m.id || ''));
        },
    },
    {
        key: 'openrouterKey', type: 'openrouter', label: 'OpenRouter', take: 3,
        prefer: [/gpt-oss/, /gemma/, /nemotron.*(super|nano)/, /llama|qwen|mistral|deepseek/],
        fallback: [],
        async list(k) {
            const res = await fetchWithTimeout('https://openrouter.ai/api/v1/models',
                { headers: { Authorization: `Bearer ${k}` } }, 6000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const isZero = v => ['0', '0.0', '-1', ''].includes(String(v ?? ''));
            return ((await res.json()).data || [])
                .filter(m => isZero(m.pricing?.prompt) && isZero(m.pricing?.completion))
                .filter(m => !String(m.id || '').startsWith('openrouter/'))
                .filter(m => (m.context_length || 0) >= 16000)
                .map(m => String(m.id || ''));
        },
    },
];

let _modelCache = null;

async function discoverProviders(config) {
    if (_modelCache) return _modelCache;

    const active = LOCAL_SPECS.filter(spec => config[spec.key]);
    const lists = await Promise.all(active.map(async spec => {
        let ids = spec.fallback;
        try {
            const found = pickModels(await spec.list(config[spec.key]), spec.prefer, spec.take);
            if (found.length) ids = found;
        } catch (err) {
            console.warn(`[models] ${spec.label} list failed:`, err.message);
        }
        return { spec, ids };
    }));

    // Interleaved by provider, so one exhausted free quota doesn't have to be
    // rediscovered three times before moving on to the next provider.
    const providers = [];
    const depth = Math.max(0, ...lists.map(l => l.ids.length));
    for (let i = 0; i < depth; i++) {
        for (const { spec, ids } of lists) {
            if (ids[i]) providers.push({ name: `${ids[i]} (${spec.label})`, model: ids[i], type: spec.type });
        }
    }

    _modelCache = providers;
    return providers;
}

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

// ── Response cache ────────────────────────────────────────────
//
// Free tiers are measured in tokens per day, so re-asking the same question is
// not merely slow, it permanently spends a scarce resource. Identical prompts
// are served from localStorage: the app used to burn quota re-fetching the same
// city every time a user went back a screen.

const CACHE_PREFIX = 'atp-ai-';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // place lists age slowly
const CACHE_MAX_ENTRIES = 60;

/** FNV-1a — short, stable, and good enough to key a cache on. */
function hashPrompt(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36) + str.length.toString(36);
}

function cacheGet(key) {
    try {
        const raw = localStorage.getItem(CACHE_PREFIX + key);
        if (!raw) return null;
        const { text, at } = JSON.parse(raw);
        if (!text || Date.now() - at > CACHE_TTL_MS) {
            localStorage.removeItem(CACHE_PREFIX + key);
            return null;
        }
        return text;
    } catch { return null; }
}

function cacheSet(key, text) {
    try {
        localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ text, at: Date.now() }));
    } catch {
        // Quota exceeded — drop the oldest half rather than losing caching entirely.
        try {
            const entries = Object.keys(localStorage)
                .filter(k => k.startsWith(CACHE_PREFIX))
                .map(k => ({ k, at: JSON.parse(localStorage.getItem(k) || '{}').at || 0 }))
                .sort((a, b) => a.at - b.at);
            entries.slice(0, Math.ceil(entries.length / 2) || 1).forEach(e => localStorage.removeItem(e.k));
            localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ text, at: Date.now() }));
        } catch { /* caching is an optimisation, never a requirement */ }
    }
}

/** Keep the cache from growing without bound across sessions. */
function trimCache() {
    try {
        const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
        if (keys.length <= CACHE_MAX_ENTRIES) return;
        keys.map(k => ({ k, at: JSON.parse(localStorage.getItem(k) || '{}').at || 0 }))
            .sort((a, b) => a.at - b.at)
            .slice(0, keys.length - CACHE_MAX_ENTRIES)
            .forEach(e => localStorage.removeItem(e.k));
    } catch { /* ignore */ }
}

/** Signals to the UI that every provider is out of free quota, not merely broken. */
export class QuotaExhaustedError extends Error {
    constructor(message) { super(message); this.name = 'QuotaExhaustedError'; this.exhausted = true; }
}

// ── Proxied AI call (production) ─────────────────────────────
async function callViaProxy(prompt, maxTokens) {
    const res = await fetchWithTimeout(PROXY_AI, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, maxTokens }),
    }, PROXY_TIMEOUT_MS);

    if (res.status === 404) {
        _proxyAvailable = false;
        throw new Error('Proxy not deployed');
    }
    if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const msg = payload?.error || (await res.text().catch(() => `HTTP ${res.status}`));
        if (payload?.exhausted) throw new QuotaExhaustedError(String(msg).slice(0, 300));
        throw new Error(String(msg).slice(0, 300));
    }
    _proxyAvailable = true;
    return await res.json();
}

// ── Core: Smart AI Call with Fallback ────────────────────────
/**
 * @param {string} prompt
 * @param {object} config
 * @param {function} [onProviderSwitch]
 * @param {{maxTokens?: number, cache?: boolean}} [opts]
 *        `maxTokens` matters more than it looks: providers charge it against
 *        the rate limit before the model runs, so an over-large ask is an
 *        instant 413 rather than a longer answer.
 */
async function smartAICall(prompt, config, onProviderSwitch, opts = {}) {
    const { maxTokens = 2048, cache = true } = opts;
    const cacheKey = cache ? hashPrompt(prompt) : null;

    if (cacheKey) {
        const hit = cacheGet(cacheKey);
        if (hit) {
            lastProviderUsed = 'Cached';
            if (onProviderSwitch) onProviderSwitch('Cached');
            return hit;
        }
    }

    const remember = text => {
        if (cacheKey && text) { cacheSet(cacheKey, text); trimCache(); }
        return text;
    };

    const errors = [];
    const hasDirectKeys = Boolean(config?.geminiKey || config?.groqKey || config?.openrouterKey);
    let exhausted = false;

    // Try the proxy unless we already know it isn't there. Keys stay server-side.
    if (_proxyAvailable !== false) {
        if (onProviderSwitch) onProviderSwitch('Connecting to AI…');
        try {
            const data = await callViaProxy(prompt, maxTokens);
            lastProviderUsed = data.providerUsed || 'AI';
            if (onProviderSwitch) onProviderSwitch(lastProviderUsed);
            return remember(data.text || '');
        } catch (err) {
            console.warn('[proxy] failed:', err.message);
            errors.push(`Server: ${err.message}`);
            exhausted = Boolean(err.exhausted);
            if (!hasDirectKeys) {
                // Nothing else to try — surface the real reason instead of a
                // misleading "all providers failed".
                if (exhausted) throw err;
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
    for (const provider of await discoverProviders(config)) {
        if (onProviderSwitch) onProviderSwitch(provider.name);
        try {
            let text;
            if (provider.type === 'gemini') text = await callGemini(config.geminiKey, provider.model, prompt, maxTokens);
            else if (provider.type === 'groq') text = await callGroq(config.groqKey, provider.model, prompt, maxTokens);
            else text = await callOpenRouter(config.openrouterKey, provider.model, prompt, maxTokens);

            if (!text) throw new Error('Empty response');
            lastProviderUsed = provider.name;
            return remember(text);
        } catch (err) {
            console.warn(`[${provider.name}] failed:`, err.message);
            if (/quota|rate limit|429|413/i.test(err.message)) exhausted = true;
            errors.push(`${provider.name}: ${err.message}`);
        }
    }

    const detail = 'All AI providers failed:\n' + errors.join('\n');
    throw exhausted ? new QuotaExhaustedError(detail) : new Error(detail);
}

// ── Gemini API Call (v1beta with working models) ───────────────
async function callGemini(apiKey, model, prompt, maxTokens = 2048) {
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            // Native JSON mode removes a whole class of parse failures.
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: maxTokens,
                responseMimeType: 'application/json',
            },
        }),
    }, REQUEST_TIMEOUT_MS);

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── OpenAI-compatible chat call (Groq / OpenRouter) ───────────
async function callChatCompletions(endpoint, apiKey, model, prompt, maxTokens = 2048) {
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
            // Not a ceiling on ambition: providers reserve this against the
            // per-minute limit up front, so 8192 made every call to a
            // 6000-TPM model fail with 413 before it ever ran.
            max_tokens: maxTokens,
        }),
    }, REQUEST_TIMEOUT_MS);

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
}

const callGroq = (key, model, prompt, max) => callChatCompletions(GROQ_BASE, key, model, prompt, max);
const callOpenRouter = (key, model, prompt, max) => callChatCompletions(OPENROUTER_BASE, key, model, prompt, max);

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
    const text = await smartAICall(prompt, config, onProviderSwitch,
        { maxTokens: placeTokens(perLocation * locations.length) });
    return normalizePlaces(extractJSON(text), locations[0]);
}

/**
 * Output budget for a list of `n` places.
 *
 * Deliberately generous but bounded: too small truncates the JSON mid-array
 * (the salvage path then silently returns half a screen of results), while too
 * large is reserved against the provider's per-minute limit and 413s outright.
 */
const placeTokens = n => Math.min(4096, 400 + Math.max(1, n) * 90);

// ── API Call 1b: Fetch More Places ────────────────────────────
export async function fetchMorePlaces(config, location, existingNames, onProviderSwitch, count = 6) {
    const exclude = existingNames.slice(0, 25).join(', ');
    const prompt = `You are a travel expert. List ${count} more famous tourist places in ${location} that are NOT already in this list: [${exclude}].
Sort by popularity. Each item: ${PLACE_SCHEMA.replace('"<city>"', `"${location}"`)}
${COORD_RULE}
Return ONLY valid JSON array, no explanation.`;
    const text = await smartAICall(prompt, config, onProviderSwitch, { maxTokens: placeTokens(count) });
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

    const text = await smartAICall(prompt, config, onProviderSwitch, { maxTokens: placeTokens(6) });
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
        const parsed = extractJSON(await smartAICall(prompt, config, onProviderSwitch, { maxTokens: 256 }));
        if (Number.isFinite(Number(parsed?.lat)) && Number.isFinite(Number(parsed?.lng))) {
            return { name: stayName.trim(), lat: Number(parsed.lat), lng: Number(parsed.lng), source: 'ai' };
        }
    } catch { /* the stay anchor is optional */ }

    return null;
}

// ── API Call 2: Place photos ──────────────────────────────────
//
// Chain: Wikipedia → Unsplash → generated SVG.
//
// Wikipedia first because it returns a photo *of that specific landmark*,
// whereas an Unsplash keyword search returns something merely evocative — and
// the old Picsum fallback returned a completely unrelated stock photo, which is
// actively misleading on a travel itinerary.

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKI_CONCURRENCY = 3;          // anonymous API bursts get 429'd
const WIKI_BACKOFF_MS = 90000;
let _wikiBackoffUntil = 0;

// Article kinds that match a landmark's name but aren't the landmark.
const WIKI_WRONG_KIND = /\b(metro|railway|bus|train)\s+station\b|\bairport\b|\(disambiguation\)|\bmetro\b|\bdiscography\b|\bfilm\b|\b\d{4} film\b/i;
const WIKI_STOPWORDS = new Set(['the', 'of', 'a', 'an', 'and', 'in', 'at', 'de', 'la']);

const wikiTokens = str => String(str).toLowerCase()
    .replace(/\([^)]*\)/g, ' ')       // drop "(Delhi)" style qualifiers
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !WIKI_STOPWORDS.has(t));

/** Levenshtein distance, capped early — inputs here are single short words. */
function editDistance(a, b) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 3) return 99;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++) {
            row[j] = Math.min(
                prev[j] + 1,
                row[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        prev = row;
    }
    return prev[b.length];
}

/**
 * Transliterated names rarely agree on spelling — Wikipedia files "Qutub Minar"
 * under "Qutb Minar". An exact token match would reject the real article and
 * hand the win to "Mini Qutub Minar", so allow a small edit distance.
 */
function tokenMatches(a, b) {
    if (a === b) return true;
    const longest = Math.max(a.length, b.length);
    if (longest < 4) return false;
    return editDistance(a, b) <= (longest >= 6 ? 2 : 1);
}

/**
 * Best image for a named place from Wikipedia, in one request:
 * `generator=search` finds candidate articles, `prop=pageimages` returns their
 * lead photos. Ranking has to be strict — a plain "does the title contain the
 * name" test happily returns "Mini Qutub Minar" for "Qutub Minar", and
 * "Hauz Khas metro station" for "Hauz Khas".
 */
async function wikipediaImage(name, city) {
    if (Date.now() < _wikiBackoffUntil) return null;

    const query = [name, city].filter(Boolean).join(' ');
    const url = `${WIKI_API}?action=query&format=json&origin=*`
        + `&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=6&gsrnamespace=0`
        + `&prop=pageimages&piprop=thumbnail&pithumbsize=800&pilimit=6`;

    const res = await fetchWithTimeout(url, {}, 8000);
    if (res.status === 429 || res.status === 403) {
        // Back off for the whole session rather than hammering a limiter.
        _wikiBackoffUntil = Date.now() + WIKI_BACKOFF_MS;
        throw new Error(`rate limited (${res.status})`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const pages = Object.values(data?.query?.pages || {}).filter(p => p.thumbnail?.source);
    if (!pages.length) return null;

    const wanted = wikiTokens(name);
    const cityTokens = new Set(wikiTokens(city));
    if (!wanted.length) return null;

    const scored = pages.map(p => {
        const title = String(p.title || '');
        const titleTokens = wikiTokens(title);
        const titleSet = new Set(titleTokens);

        const coverage = wanted.filter(w => titleTokens.some(t => tokenMatches(w, t))).length / wanted.length;
        // Words the article adds that we didn't ask for — "mini", "station".
        // The city name doesn't count; "Jama Masjid, Delhi" is the right article.
        const extra = titleTokens.filter(t =>
            !wanted.some(w => tokenMatches(w, t)) && !cityTokens.has(t)).length;

        let score = coverage * 2 - extra * 0.4;
        const sameLength = titleTokens.length === wanted.length;
        if (sameLength && coverage === 1) score += 1;                   // same place, maybe spelled differently
        if (WIKI_WRONG_KIND.test(title)) score -= 2;
        score -= (p.index ?? 9) * 0.02;                                 // slight nod to search rank

        return { url: p.thumbnail.source, title, coverage, score };
    })
        // Require most of the name to appear, so "Red Fort" can't match "Fort Worth".
        .filter(p => p.coverage >= 0.6 && p.score > 0.8)
        .sort((a, b) => b.score - a.score);

    return scored[0]?.url || null;
}

export async function fetchPlaceImages(placeItems, unsplashKey, { hasImages = false } = {}) {
    const items = placeItems.map(p => (typeof p === 'string' ? { name: p, location: '' } : p));
    const cache = {};
    if (!items.length) return cache;

    const directKey = unsplashKey && unsplashKey.length > 10 ? unsplashKey : '';
    const canProxy = _proxyAvailable !== false && (hasImages || !looksLikeLocalStatic());

    const unsplashLookup = async (query) => {
        if (canProxy) {
            try {
                const proxyUrl = `${PROXY_IMAGES}?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`;
                const res = await fetchWithTimeout(proxyUrl, {}, 10000);
                if (res.status === 404) _proxyAvailable = false;
                else if (res.ok) {
                    const data = await res.json();
                    return data.results || [];
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

    // Pass 1 — Wikipedia, at a gentler concurrency than Unsplash: the anonymous
    // API returns 429 for bursts, and one 429 backs the whole session off.
    await mapLimit(items, WIKI_CONCURRENCY, async ({ name, location }) => {
        try {
            const wiki = await wikipediaImage(name, (location || '').split(',')[0].trim());
            if (wiki) cache[name] = wiki;
        } catch (err) {
            console.warn(`[wikipedia] "${name}":`, err.message);
        }
    });

    // Pass 2 — anything Wikipedia couldn't place falls through to Unsplash,
    // which is pretty and thematically right but not necessarily this place.
    const remaining = items.filter(({ name }) => !cache[name]);
    await mapLimit(remaining, IMAGE_CONCURRENCY, async ({ name, location }) => {
        const cityOnly = (location || '').split(',')[0].trim();

        if (directKey || canProxy) {
            try {
                const cleanName = name.replace(/[^a-zA-Z0-9 ]/g, '').trim();
                const cleanCity = cityOnly.replace(/[^a-zA-Z0-9 ]/g, '').trim();
                let results = await unsplashLookup([cleanName, cleanCity].filter(Boolean).join(' '));
                if (!results.length && cleanCity) results = await unsplashLookup(cleanName);

                const nameWords = cleanName.toLowerCase().split(' ').filter(w => w.length > 3);
                const best = results
                    .map(r => {
                        const haystack = [r.description || '', r.alt_description || '', r.tags?.map(t => t.title).join(' ') || '']
                            .join(' ').toLowerCase();
                        return { url: r.urls?.regular || r.urls?.small, score: nameWords.filter(w => haystack.includes(w)).length };
                    })
                    .filter(r => r.url)
                    .sort((a, b) => b.score - a.score)[0];

                if (best) { cache[name] = best.url; return; }
            } catch (err) {
                console.warn(`[unsplash] "${name}":`, err.message);
            }
        }

        // Last resort: a labelled placeholder, honest about having no photo.
        cache[name] = svgPlaceholder(name);
    });

    return cache;
}

const PLACEHOLDER_PALETTE = [
    ['#4338ca', '#7c3aed'], ['#0f766e', '#059669'], ['#b45309', '#d97706'],
    ['#9f1239', '#e11d48'], ['#1d4ed8', '#0ea5e9'], ['#7e22ce', '#c026d3'],
];

/**
 * A generated card showing the place's name — used when no real photo exists.
 * Wraps to two lines so long names stay readable instead of overflowing.
 */
export function svgPlaceholder(name) {
    const clean = String(name || 'Place').replace(/[<>&"']/g, '').trim();
    const hash = Math.abs([...clean].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));
    const [from, to] = PLACEHOLDER_PALETTE[hash % PLACEHOLDER_PALETTE.length];

    // Break onto a second line at the nearest space past the midpoint.
    const label = clean.length > 30 ? clean.slice(0, 29) + '…' : clean;
    let line1 = label, line2 = '';
    if (label.length > 16) {
        const cut = label.lastIndexOf(' ', Math.ceil(label.length / 2) + 6);
        if (cut > 4) { line1 = label.slice(0, cut); line2 = label.slice(cut + 1); }
    }
    const size = line1.length > 20 ? 26 : 30;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
</linearGradient></defs>
<rect width="400" height="300" fill="url(#g)"/>
<circle cx="330" cy="60" r="90" fill="#ffffff" opacity="0.07"/>
<circle cx="60" cy="255" r="70" fill="#ffffff" opacity="0.05"/>
<text x="200" y="${line2 ? 138 : 152}" text-anchor="middle" fill="#ffffff" opacity="0.95"
      font-family="Inter, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="700">${escapeXml(line1)}</text>
${line2 ? `<text x="200" y="176" text-anchor="middle" fill="#ffffff" opacity="0.95"
      font-family="Inter, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="700">${escapeXml(line2)}</text>` : ''}
<text x="200" y="${line2 ? 214 : 190}" text-anchor="middle" fill="#ffffff" opacity="0.55"
      font-family="Inter, Helvetica, Arial, sans-serif" font-size="13">No photo available</text>
</svg>`;

    return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' '))}`;
}

function escapeXml(str) {
    return String(str).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
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

    // Three days per call, not four: the reply has to fit inside the output
    // budget, and a truncated reply loses whole days rather than degrading.
    const chunks = [];
    for (let i = 0; i < days.length; i += 3) chunks.push(days.slice(i, i + 3));

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
      "accessibility": "<'Step-free' | 'Partly accessible' | 'Not wheelchair accessible'>"
    }],
    "meals": [{ "type": "<Breakfast|Lunch|Dinner>", "time": "<e.g. 1:00 PM>", "suggestion": "<specific restaurant or dish>", "area": "<where>", "approxCost": "<${currency}per person>" }]
  }]
}`;

    // Travel between stops is no longer asked for here: routing.js measures it
    // against OSRM, which beats a recalled estimate and costs no tokens.
    const placeCount = days.reduce((n, d) => n + d.places.length, 0);
    const text = await smartAICall(prompt, config, onProviderSwitch, {
        maxTokens: Math.min(4096, 500 + placeCount * 150 + days.length * 120),
    });
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
    const text = await smartAICall(prompt, config, onProviderSwitch, { maxTokens: placeTokens(3) });
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
    const parsed = extractJSON(await smartAICall(prompt, config, onProviderSwitch, { maxTokens: 1200 }));
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
    return extractJSON(await smartAICall(prompt, config, onProviderSwitch, { maxTokens: 1200 }));
}

export async function enrichCustomPlaces(config, placeNames, locationHint, onProviderSwitch) {
    if (!placeNames.length) return [];
    const prompt = `You are a travel expert. For each of the following places, return a JSON array with a short description and category.
Places: ${placeNames.map((n, i) => `${i + 1}. ${n}`).join(', ')}
Location context: ${locationHint || 'India'}

For each place return: { "name": "<exact name as given>", "shortDesc": "<1 engaging sentence about this place>", "category": "<Heritage|Nature|Religious|Market|Museum|Entertainment|Food>", "location": "<city or area it belongs to>" }
Return ONLY a valid JSON array. No explanation, no markdown.`;
    const text = await smartAICall(prompt, config, onProviderSwitch, { maxTokens: placeTokens(placeNames.length) });
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
