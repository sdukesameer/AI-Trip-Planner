// ============================================================
//  api.js — AI provider abstraction with fallback chain
// ============================================================

// ── AI Provider Definitions ───────────────────────────────────
const AI_PROVIDERS = [
    { name: 'Gemini 2.0 Flash', model: 'gemini-2.0-flash', type: 'gemini' },
    { name: 'Gemini 2.0 Flash-Lite', model: 'gemini-2.0-flash-lite', type: 'gemini' },
    { name: 'Groq Llama 3.3', model: 'llama-3.3-70b-versatile', type: 'groq' },
    { name: 'Groq Mixtral', model: 'mixtral-8x7b-32768', type: 'groq' },
];

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';
const UNSPLASH_BASE = 'https://api.unsplash.com/search/photos';

const REQUEST_TIMEOUT_MS = 45000;

let lastProviderUsed = '';
export function getLastProvider() { return lastProviderUsed; }

// ── Core: Smart AI Call with Fallback ────────────────────────
async function smartAICall(prompt, config, onProviderSwitch) {
    const errors = [];
    for (const provider of AI_PROVIDERS) {
        if (provider.type === 'groq' && !config.groqKey) continue;
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

// ── Groq API Call ────────────────────────────────────────────
async function callGroq(apiKey, model, prompt) {
    const body = {
        model,
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

// ── JSON Extraction + Repair ─────────────────────────────────
function extractJSON(text) {
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

    // Try direct parse first
    try { return JSON.parse(raw); } catch { /* fall through to repair */ }

    // Repair: remove trailing commas before ] or }
    let repaired = raw
        .replace(/,\s*([}\]])/g, '$1')          // trailing commas
        .replace(/(["\w])\s*\n\s*(["\[{])/g, '$1,$2') // missing commas between lines
        .replace(/\t/g, ' ');

    try { return JSON.parse(repaired); } catch (e) {
        // Last resort: try truncating at last complete object
        const lastComplete = Math.max(repaired.lastIndexOf('},'), repaired.lastIndexOf('}\n'));
        if (lastComplete > start) {
            try {
                const truncated = repaired.slice(0, lastComplete + 1) + (repaired[start] === '[' ? ']' : '}');
                return JSON.parse(truncated);
            } catch { /* ignore */ }
        }
        throw new Error('JSON parse failed after repairs: ' + e.message);
    }
}

// ── API Call 1: Famous Places ─────────────────────────────────
export async function fetchFamousPlaces(config, locations, onProviderSwitch) {
    const locStr = locations.join(', ');
    const prompt = `You are a travel expert. For the locations: ${locStr}, return a JSON array of 8 famous tourist places per location, sorted by popularity.
Each item: { "location": "<city>", "name": "<place name>", "shortDesc": "<1 sentence description>", "category": "<Heritage|Nature|Religious|Market|Museum|Entertainment|Food>" }
Return ONLY valid JSON array, no explanation, no markdown.`;
    const text = await smartAICall(prompt, config, onProviderSwitch);
    return extractJSON(text);
}

// ── API Call 1b: Fetch More Places ────────────────────────────
export async function fetchMorePlaces(config, location, existingNames, onProviderSwitch) {
    const exclude = existingNames.slice(0, 20).join(', ');
    const prompt = `You are a travel expert. List 6 more famous tourist places in ${location} that are NOT already in this list: [${exclude}].
Sort by popularity. Each item: { "location": "${location}", "name": "<name>", "shortDesc": "<1 sentence>", "category": "<Heritage|Nature|Religious|Market|Museum|Entertainment|Food>" }
Return ONLY valid JSON array, no explanation.`;
    const text = await smartAICall(prompt, config, onProviderSwitch);
    return extractJSON(text);
}

// ── API Call 1c: Search Nearby Places ────────────────────────
export async function searchNearbyPlaces(config, query, onProviderSwitch) {
    // Geocode via Nominatim first
    const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`;
    let locationLabel = query;
    let coordsLine = '';
    try {
        const geoRes = await fetch(geoUrl, {
            headers: { 'User-Agent': 'AI-Trip-Planner/1.0', 'Accept-Language': 'en' }
        });
        if (geoRes.ok) {
            const geoData = await geoRes.json();
            if (geoData[0]) {
                const { lat, lon, display_name } = geoData[0];
                locationLabel = display_name.split(',').slice(0, 3).join(',');
                coordsLine = `Coordinates: ${parseFloat(lat).toFixed(4)}, ${parseFloat(lon).toFixed(4)}.`;
            }
        }
    } catch { /* ignore geocode errors — AI will do its best */ }

    const prompt = `You are a travel expert. List 6 famous tourist attractions near or in "${locationLabel}". ${coordsLine}
Each item: { "location": "<area or city>", "name": "<place name>", "shortDesc": "<1 sentence description>", "category": "<Heritage|Nature|Religious|Market|Museum|Entertainment|Food>" }
Return ONLY valid JSON array, no explanation.`;
    const text = await smartAICall(prompt, config, onProviderSwitch);
    return extractJSON(text);
}

// ── API Call 2: Fetch Unsplash Images ────────────────────────
// placeItems: string[] OR {name, location}[] — location improves query accuracy
export async function fetchPlaceImages(placeItems, unsplashKey) {
    const items = placeItems.map(p => typeof p === 'string' ? { name: p, location: '' } : p);
    const cache = {};
    const hasKey = unsplashKey && unsplashKey.length > 10;

    if (!hasKey) {
        for (const { name } of items) cache[name] = picsumFallback(name);
        return cache;
    }

    for (const { name, location } of items) {
        try {
            const cleanName = name.replace(/[^a-zA-Z0-9 ]/g, '').trim();
            const cleanLoc = (location || '').replace(/[^a-zA-Z0-9 ]/g, '').trim();
            // Include city name for much more accurate results (e.g. "National Museum New Delhi")
            const queryStr = [cleanName, cleanLoc, 'landmark'].filter(Boolean).join(' ');
            const url = `${UNSPLASH_BASE}?query=${encodeURIComponent(queryStr)}&per_page=1&orientation=landscape&client_id=${unsplashKey}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            cache[name] = data.results?.[0]?.urls?.small || picsumFallback(name);
        } catch (err) {
            console.warn(`[Unsplash] "${name}":`, err.message);
            cache[name] = picsumFallback(name);
        }
    }
    return cache;
}

export function picsumFallback(name) {
    const seed = Math.abs(name.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0)) % 1000;
    return `https://picsum.photos/seed/${seed}/400/300`;
}

// ── API Call 3: Generate Itinerary ───────────────────────────
export async function generateItinerary(config, locations, startDate, endDate, selectedPlaces, autoMode, onProviderSwitch) {
    const totalDays = daysBetween(startDate, endDate) + 1;
    if (totalDays <= 7) {
        return await generateItineraryChunk(config, locations, startDate, endDate, selectedPlaces, autoMode, 1, totalDays, null, onProviderSwitch);
    }

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
        const prevContext = allDays.length > 0
            ? `Trip planned up to Day ${dayOffset - 1}. Last location: ${allDays[allDays.length - 1].location || locations[0]}. Continue from Day ${dayOffset}.`
            : null;

        const chunk = await generateItineraryChunk(config, locations, chunkStartStr, chunkEndStr, selectedPlaces, autoMode, dayOffset, chunkSize, prevContext, onProviderSwitch);
        if (chunk.summary && !summary) summary = chunk.summary;
        chunk.days.forEach((day, idx) => { day.day = dayOffset + idx; });
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

    const dateWeekdays = [];
    const d = new Date(startDate);
    for (let i = 0; i < numDays; i++) {
        dateWeekdays.push(`Day ${startDay + i} = ${formatDate(d)} (${d.toLocaleDateString('en-US', { weekday: 'long' })})`);
        d.setDate(d.getDate() + 1);
    }

    // ── Build a geographic-cluster hint so the AI understands the area structure ──
    // We pass known lat/lng from selectedPlaces to help the AI cluster correctly
    const placeCoords = selectedPlaces
        .filter(p => p.lat && p.lng)
        .map(p => `  ${p.name} @ (${p.lat.toFixed(3)},${p.lng.toFixed(3)})`)
        .join('\n');
    const coordsHint = placeCoords ? `\nKnown coordinates (use these to cluster geographically):\n${placeCoords}\n` : '';

    const prompt = `You are a professional travel itinerary planner. Plan a ${numDays}-day trip to: ${locStr}.
Trip dates: ${startDate} to ${endDate}. Start from Day ${startDay}.
${contextLine}${autoMode ? 'Include the most popular tourist attractions.' : `Must visit: ${placesList}.`}
${coordsHint}
Day-date mapping:
${dateWeekdays.join('\n')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MANDATORY GEOGRAPHIC CLUSTERING — THIS IS MOST IMPORTANT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Group places by physical proximity. Places within ~5 km of each other MUST be in the same day.

EXAMPLE — Delhi:
• India Gate, National War Memorial, Rajpath Lawns → all within 1 km → SAME DAY
• Red Fort, Chandni Chowk, Jama Masjid → all within 1 km → SAME DAY
• Qutub Minar, Mehrauli Archeological Park → same area → SAME DAY
• Humayun's Tomb, Lodhi Garden → ~3 km apart → CAN share a day
DO NOT scatter nearby places across different days. A tourist should cover a geographic zone in one day, not commute back and forth.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DAILY TIME SCHEDULE — TREAT EACH DAY LIKE A REAL PLAN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Start each day at 10:00 AM. Assign a real "arrivalTime" to every place:
  Place 1: arrivalTime = 10:00 AM
  Place 2: arrivalTime = Place1.arrivalTime + Place1.visitDuration + transit_time
  Place 3: arrivalTime = Place2.arrivalTime + Place2.visitDuration + transit_time
  ... and so on until end of day (~6:00 PM max)

Transit time between nearby places (same zone): 15–30 min
Transit time between different zones: 30–60 min

VISIT DURATION guidelines (be realistic):
- Major fort / palace / temple complex: 2.5–3 hrs
- Large museum: 2–2.5 hrs
- Garden / park: 1–1.5 hrs
- Market / bazaar: 1.5–2 hrs
- Small monument / viewpoint / memorial: 30–45 min
- Street food stop: 30–45 min

Max total day time = 8 hrs of visits + transit. Never exceed this.
Max places per day: 4 if all are major sites, up to 6 if mix of quick stops and major sites.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OTHER RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Order places within each day in a geographic loop — do NOT make tourist backtrack
- Check weekday: museums close Mondays, some temples have rest days — add "closedNote" or reschedule
- Multi-city trip: dedicate at least 1 full day per city
- Commute between consecutive places: walk (minutes), cab (₹ range), metro (line/station) or "N/A"
- Return ONLY valid JSON — no markdown fences, no trailing commas, no explanation

FORMAT (follow exactly):
{
  "summary": "<1-2 line trip overview>",
  "days": [{
    "day": ${startDay},
    "date": "<YYYY-MM-DD>",
    "theme": "<creative day theme e.g. 'Mughal Grandeur & Old Delhi'>",
    "location": "<main city/area>",
    "places": [{
      "name": "<place name>",
      "desc": "<2-3 sentences about this place>",
      "category": "<Heritage|Nature|Religious|Market|Museum|Entertainment|Food>",
      "openingHours": "<e.g. 9:00 AM – 5:00 PM or 'Open 24hrs'>",
      "entryFee": "<e.g. ₹40 or 'Free'>",
      "arrivalTime": "<e.g. 10:00 AM>",
      "visitDuration": "<e.g. 2 hrs>",
      "bestTime": "<e.g. Early morning before crowds>",
      "closedNote": "<only include if closed/restricted on this exact date>",
      "lat": <decimal number>,
      "lng": <decimal number>,
      "commute_from_prev": { "walk": "<min or N/A>", "cab": "<₹range or N/A>", "metro": "<route or N/A>" }
    }]
  }]
}`;

    const text = await smartAICall(prompt, config, onProviderSwitch);
    return extractJSON(text);
}

// ── Helpers ───────────────────────────────────────────────────
function daysBetween(d1, d2) {
    return Math.max(0, Math.floor((new Date(d2) - new Date(d1)) / 86400000));
}
function formatDate(date) {
    return date.toISOString().split('T')[0];
}
