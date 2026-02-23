// ============================================================
//  api.js — AI provider abstraction with fallback chain
// ============================================================

// ── AI Provider Definitions (all free-tier models) ───────────
const AI_PROVIDERS = [
    { name: 'Gemini Flash', model: 'gemini-2.0-flash', type: 'gemini' },
    { name: 'Gemini Flash-Lite', model: 'gemini-2.0-flash-lite', type: 'gemini' },
    { name: 'Gemini 1.5 Flash', model: 'gemini-1.5-flash', type: 'gemini' },
    { name: 'Groq Llama 3.3', model: 'llama-3.3-70b-versatile', type: 'groq' },
];

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

const REQUEST_TIMEOUT_MS = 45000; // 45 seconds per attempt

// Track which provider was last used (exported for UI)
let lastProviderUsed = '';
export function getLastProvider() { return lastProviderUsed; }

// ── Core: Smart AI Call with Fallback ────────────────────────
/**
 * Tries each AI provider in sequence. If one times out or errors,
 * falls through to the next. Returns the raw text response.
 */
async function smartAICall(prompt, config, onProviderSwitch) {
    const errors = [];

    for (const provider of AI_PROVIDERS) {
        // Skip Groq if no Groq key
        if (provider.type === 'groq' && !config.groqKey) continue;
        // Skip Gemini if no Gemini key
        if (provider.type === 'gemini' && !config.geminiKey) continue;

        if (onProviderSwitch) onProviderSwitch(provider.name);

        try {
            let text;
            if (provider.type === 'gemini') {
                text = await callGemini(config.geminiKey, provider.model, prompt);
            } else if (provider.type === 'groq') {
                text = await callGroq(config.groqKey, provider.model, prompt);
            }

            lastProviderUsed = provider.name;
            return text;
        } catch (err) {
            console.warn(`[${provider.name}] failed:`, err.message);
            errors.push(`${provider.name}: ${err.message}`);
        }
    }

    throw new Error('All AI providers failed:\n' + errors.join('\n'));
}

// ── Gemini API Call ──────────────────────────────────────────
async function callGemini(apiKey, model, prompt) {
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;
    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${res.status}`);
        }

        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } finally {
        clearTimeout(timeout);
    }
}

// ── Groq API Call (OpenAI-compatible) ────────────────────────
async function callGroq(apiKey, model, prompt) {
    const body = {
        model: model,
        messages: [
            { role: 'system', content: 'You are an expert travel planner. Always respond with valid JSON only, no markdown fences, no explanation.' },
            { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 8192,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const res = await fetch(GROQ_BASE, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${res.status}`);
        }

        const data = await res.json();
        return data.choices?.[0]?.message?.content || '';
    } finally {
        clearTimeout(timeout);
    }
}

// ── JSON Extraction ──────────────────────────────────────────
function extractJSON(text) {
    // Strip markdown code fences if present
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = match ? match[1] : text;
    // Find first [ or {
    const start = raw.search(/[\[{]/);
    const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
    if (start === -1 || end === -1) throw new Error('No JSON found in response');
    return JSON.parse(raw.slice(start, end + 1));
}

// ── API Call 1: Famous Places ─────────────────────────────────
export async function fetchFamousPlaces(config, locations, onProviderSwitch) {
    const locStr = locations.join(', ');
    const prompt = `You are a travel expert. For the locations: ${locStr}, return a JSON array of 6–10 famous tourist places per location.
Each item must have: { "location": "<city>", "name": "<place name>", "shortDesc": "<1 sentence description>", "category": "<Heritage|Nature|Religious|Market|Museum|Entertainment|Food>" }
Return ONLY valid JSON array, no explanation, no markdown.`;

    const text = await smartAICall(prompt, config, onProviderSwitch);
    return extractJSON(text);
}

// ── API Call 2: Batch Image URLs (Unsplash — no API key) ─────
export async function fetchPlaceImages(placeNames) {
    const cache = {};
    for (const name of placeNames) {
        cache[name] = unsplashUrl(name);
    }
    return cache;
}

function unsplashUrl(name) {
    const q = encodeURIComponent(name.replace(/[^a-zA-Z0-9 ]/g, '').trim());
    return `https://source.unsplash.com/400x300/?${q},landmark,travel`;
}

// ── API Call 3: Generate Day-wise Itinerary ──────────────────
/**
 * For trips ≤ 7 days: single API call.
 * For trips > 7 days: chunked into batches of 7 days to avoid timeouts.
 */
export async function generateItinerary(config, locations, startDate, endDate, selectedPlaces, autoMode, onProviderSwitch) {
    const totalDays = daysBetween(startDate, endDate) + 1;

    if (totalDays <= 7) {
        return await generateItineraryChunk(config, locations, startDate, endDate, selectedPlaces, autoMode, 1, totalDays, null, onProviderSwitch);
    }

    // Chunked generation for long trips
    const allDays = [];
    let summary = '';
    let chunkStart = new Date(startDate);
    let dayOffset = 1;

    while (dayOffset <= totalDays) {
        const chunkSize = Math.min(7, totalDays - dayOffset + 1);
        const chunkEnd = new Date(chunkStart);
        chunkEnd.setDate(chunkEnd.getDate() + chunkSize - 1);

        const chunkStartStr = formatDate(chunkStart);
        const chunkEndStr = formatDate(chunkEnd);

        // Context from previous chunk to ensure continuity
        const prevContext = allDays.length > 0
            ? `The trip has been planned up to Day ${dayOffset - 1}. Last location was: ${allDays[allDays.length - 1].location || locations[0]}. Continue from Day ${dayOffset}.`
            : null;

        const chunk = await generateItineraryChunk(
            config, locations, chunkStartStr, chunkEndStr,
            selectedPlaces, autoMode, dayOffset, chunkSize,
            prevContext, onProviderSwitch
        );

        if (chunk.summary && !summary) summary = chunk.summary;

        // Re-number days to be sequential
        chunk.days.forEach((day, idx) => {
            day.day = dayOffset + idx;
        });

        allDays.push(...chunk.days);
        dayOffset += chunkSize;
        chunkStart = new Date(chunkEnd);
        chunkStart.setDate(chunkStart.getDate() + 1);
    }

    return { summary: summary || `${totalDays}-day trip across ${locations.join(' & ')}`, days: allDays };
}

async function generateItineraryChunk(config, locations, startDate, endDate, selectedPlaces, autoMode, startDay, numDays, prevContext, onProviderSwitch) {
    const placesList = selectedPlaces.map(p => `${p.name} (${p.location})`).join(', ');
    const locStr = locations.join(', ');

    const contextLine = prevContext ? `\nContext: ${prevContext}\n` : '';

    const prompt = `You are an expert travel planner. Plan a ${numDays}-day trip to: ${locStr}.
Start date: ${startDate}, End date: ${endDate}. Starting from Day ${startDay}.
${contextLine}${autoMode ? 'Choose the best famous places for each location.' : `The traveller wants to visit: ${placesList}.`}

Rules:
1. Group geographically close places on the same day — minimise travel distance within a day.
2. Max 5–6 places per day; overflow naturally to next day.
3. If visiting multiple cities, dedicate at least 1 full day per city.
4. For each consecutive place pair, provide commute info: walking time (minutes), cab fare (INR range), and metro route (line name + stops) if applicable. If not applicable write "N/A".
5. Give each day a fun theme name (e.g. "Heritage & History", "Spiritual & Greens").
6. Include opening hours and entry fee (INR) where known.
7. Return ONLY valid JSON — no explanation, no markdown fences.

JSON format:
{
  "summary": "<1–2 line trip summary>",
  "days": [
    {
      "day": ${startDay},
      "date": "<formatted date>",
      "theme": "<theme>",
      "location": "<main city for this day>",
      "places": [
        {
          "name": "<place name>",
          "desc": "<2–3 sentence description>",
          "category": "<Heritage|Nature|Religious|Market|Museum|Entertainment|Food>",
          "openingHours": "<e.g. 9AM–6PM or 'Open 24hrs'>",
          "entryFee": "<e.g. ₹40 or 'Free'>",
          "lat": <latitude as number>,
          "lng": <longitude as number>,
          "commute_from_prev": {
            "walk": "<e.g. 12 min walk or N/A>",
            "cab": "<e.g. ₹80–120 or N/A>",
            "metro": "<e.g. Yellow Line → Barakhamba Road or N/A>"
          }
        }
      ]
    }
  ]
}`;

    const text = await smartAICall(prompt, config, onProviderSwitch);
    return extractJSON(text);
}

// ── Helpers ───────────────────────────────────────────────────
function daysBetween(d1, d2) {
    const ms = new Date(d2) - new Date(d1);
    return Math.max(0, Math.floor(ms / 86400000));
}

function formatDate(date) {
    return date.toISOString().split('T')[0];
}
