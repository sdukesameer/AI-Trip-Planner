// ============================================================
//  _models.js — Runtime model discovery
//
//  Hardcoded model IDs rot. `gemini-2.5-flash` started returning
//  404 "no longer available to new users" in production, which took the whole
//  app down even though the API key was fine.
//
//  Both Google and Groq expose a list-models endpoint, so ask them what exists
//  right now and pick the best match, rather than guessing a name.
//  Results are cached per warm Lambda container.
// ============================================================

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();   // key → { value, expires }

function cached(key, value) {
    cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
}

function getCached(key) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    cache.delete(key);
    return null;
}

async function fetchJSON(url, options = {}, ms = 3500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// Model families we never want for JSON text generation.
const EXCLUDE = /embed|aqa|imagen|veo|image-generation|-image(?:-|$)|tts|audio|realtime|live|guard|whisper|vision-only|learnlm/i;

/**
 * Rank candidate model names. Higher is better.
 * Prefers cheap fast "flash"/"instant" tiers, newer version numbers, and
 * general-purpose over preview/experimental builds.
 */
function scoreModel(name, { preferSmall = true } = {}) {
    const n = name.toLowerCase();
    if (EXCLUDE.test(n)) return -1;

    let score = 0;
    if (preferSmall && /flash|instant|mini|lite/.test(n)) score += 100;
    if (/pro|large|70b/.test(n)) score += 40;

    // Highest version number wins: gemini-3 > gemini-2.5 > gemini-2.0
    const version = n.match(/(\d+(?:\.\d+)?)/);
    if (version) score += Math.min(60, parseFloat(version[1]) * 12);

    // "latest" aliases keep working when the underlying build is retired.
    if (/latest/.test(n)) score += 25;
    // Previews get deprecated fastest — usable, but a last resort.
    if (/preview|exp|experimental|beta/.test(n)) score -= 45;
    // "lite" is cheapest but noticeably weaker at long structured JSON.
    if (/lite/.test(n)) score -= 15;
    if (/thinking/.test(n)) score -= 30;   // slower, and we don't need reasoning traces

    return score;
}

/**
 * Ask Google which models this key can actually call.
 * @returns {Promise<string[]>} up to `limit` model IDs, best first.
 */
async function geminiModels(apiKey, limit = 3) {
    const key = `gemini:${String(apiKey).slice(-6)}`;
    const hit = getCached(key);
    if (hit) return hit;

    try {
        const data = await fetchJSON(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`);
        const usable = (data.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => String(m.name || '').replace(/^models\//, ''))
            .filter(Boolean)
            .map(name => ({ name, score: scoreModel(name) }))
            .filter(m => m.score > 0)
            .sort((a, b) => b.score - a.score)
            .map(m => m.name);

        if (usable.length) {
            console.log('[models] Gemini candidates:', usable.slice(0, limit).join(', '));
            return cached(key, usable.slice(0, limit));
        }
    } catch (err) {
        console.warn('[models] Gemini list failed:', err.message);
    }

    // Listing failed (network, quota). Fall back to a spread of names across
    // generations so at least one is likely to resolve.
    return cached(key, ['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'].slice(0, limit));
}

/** Same idea for Groq, whose model IDs are deprecated frequently. */
async function groqModels(apiKey, limit = 2) {
    const key = `groq:${String(apiKey).slice(-6)}`;
    const hit = getCached(key);
    if (hit) return hit;

    try {
        const data = await fetchJSON('https://api.groq.com/openai/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        const usable = (data.data || [])
            .map(m => String(m.id || ''))
            .filter(Boolean)
            .map(name => ({ name, score: scoreModel(name) }))
            .filter(m => m.score > 0)
            .sort((a, b) => b.score - a.score)
            .map(m => m.name);

        if (usable.length) {
            console.log('[models] Groq candidates:', usable.slice(0, limit).join(', '));
            return cached(key, usable.slice(0, limit));
        }
    } catch (err) {
        console.warn('[models] Groq list failed:', err.message);
    }

    return cached(key, ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'].slice(0, limit));
}

module.exports = { geminiModels, groqModels, scoreModel };
