// ============================================================
//  _models.js — Free-tier provider registry
//
//  Three failure modes have taken this app down in production, and this file
//  exists to defend against all three:
//
//  1. Model IDs rot. `gemini-2.5-flash` began returning 404 "no longer
//     available to new users" while the API key was perfectly fine. So model
//     IDs are DISCOVERED from each provider's list endpoint, never hardcoded.
//
//  2. Free quotas run out. A single provider is a single point of failure, so
//     the chain spans every provider the deployment has a key for, and a model
//     that fails is remembered (see markDead) instead of being retried on
//     every subsequent request.
//
//  3. `max_tokens` is charged against the rate limit BEFORE the model runs.
//     Groq's llama-3.1-8b-instant has a 6000 TPM limit, so asking for 8192
//     output tokens returned 413 every single time, forever. Output budgets
//     are therefore clamped per provider — see `tpm`.
// ============================================================

const LIST_TTL_MS = 30 * 60 * 1000;   // model lists change slowly
const listCache = new Map();

// ── Health memory ─────────────────────────────────────────────
// Warm-container only, which is fine: the point is to stop re-trying a model
// that just failed, not to keep permanent state.
const dead = new Map();   // model id → expires-at ms

/** How long to shun a model after a given HTTP status. */
function shunFor(status) {
    if (status === 429) return 10 * 60 * 1000;   // quota — may recover
    if (status === 413) return 60 * 60 * 1000;   // won't fit; needs a smaller ask
    if (status === 404 || status === 400) return 6 * 60 * 60 * 1000;   // retired
    if (status >= 500) return 2 * 60 * 1000;     // provider blip
    return 5 * 60 * 1000;
}

function markDead(model, status) {
    dead.set(model, Date.now() + shunFor(status));
}

function isDead(model) {
    const until = dead.get(model);
    if (!until) return false;
    if (until < Date.now()) { dead.delete(model); return false; }
    return true;
}

async function fetchJSON(url, options = {}, ms = 4000) {
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

// ── Model selection ───────────────────────────────────────────
// Anything that cannot return structured text. `image` is deliberately broad:
// discovery once picked `gemini-3-pro-image`, which is an image generator.
const EXCLUDE = /image|imagen|banana|veo|lyria|sora|dall|tts|audio|speech|voice|music|embed|aqa|rerank|guard|safety|whisper|learnlm|live|realtime|robotics|computer-use|-vl\b|vision/i;

/**
 * Rank by an ordered list of preferred patterns: the earlier a pattern matches,
 * the higher the score. Explicit and debuggable, unlike a bag of magic weights.
 *
 * @param {string[]} ids      candidate model IDs
 * @param {RegExp[]} prefer   priority order, best first
 * @param {number}   take     how many to keep
 */
function pick(ids, prefer, take) {
    return ids
        .filter(id => id && !EXCLUDE.test(id))
        .map(id => {
            let rank = prefer.findIndex(re => re.test(id));
            if (rank === -1) rank = prefer.length;
            // Within the same tier, prefer stable aliases and penalise previews,
            // which are retired faster than anything else.
            let tie = 0;
            if (/latest/.test(id)) tie -= 2;
            if (/preview|experimental|\bexp\b/.test(id)) tie += 3;
            if (/thinking|reasoning/.test(id)) tie += 2;   // slow, and we want JSON not traces
            return { id, key: rank * 10 + tie };
        })
        .filter(m => m.key < prefer.length * 10)   // drop anything matching nothing
        .sort((a, b) => a.key - b.key)
        .slice(0, take)
        .map(m => m.id);
}

// ── Provider specs ────────────────────────────────────────────
//
// Every one of these has a genuinely free tier that needs no card on file.
// A provider is simply skipped when its env var is absent, so a deployment can
// add or drop providers without a code change.
const SPECS = [
    {
        id: 'gemini',
        env: 'GEMINI_API_KEY',
        label: 'Gemini',
        take: 3,
        // Free-tier `pro` quota is tiny and 429s almost immediately, so the
        // flash tiers are genuinely the right choice here, not just the cheap one.
        prefer: [/^gemini-flash-latest$/, /^gemini-[\d.]+-flash$/, /flash-lite|flash_lite/, /flash/, /gemma/],
        // Aliases, because they keep working when the build behind them retires.
        fallback: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.0-flash'],
        async list(key) {
            const data = await fetchJSON(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`);
            return (data.models || [])
                .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                .map(m => String(m.name || '').replace(/^models\//, ''));
        },
    },
    {
        id: 'groq',
        env: 'GROQ_API_KEY',
        label: 'Groq',
        take: 3,
        // Free quota is per-model, so a spread of sizes means one model running
        // dry doesn't end the day. Big model first for quality.
        prefer: [/70b|versatile/, /gpt-oss/, /8b|instant/, /llama|qwen|gemma|mixtral/],
        fallback: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
        tpm: 5600,   // smallest free per-minute budget across Groq's models
        openai: 'https://api.groq.com/openai/v1',
        async list(key) {
            const data = await fetchJSON('https://api.groq.com/openai/v1/models', {
                headers: { Authorization: `Bearer ${key}` },
            });
            return (data.data || []).map(m => String(m.id || ''));
        },
    },
    {
        id: 'cerebras',
        env: 'CEREBRAS_API_KEY',
        label: 'Cerebras',
        take: 2,
        prefer: [/70b/, /gpt-oss/, /qwen|llama/],
        fallback: ['llama-3.3-70b'],
        openai: 'https://api.cerebras.ai/v1',
        async list(key) {
            const data = await fetchJSON('https://api.cerebras.ai/v1/models', {
                headers: { Authorization: `Bearer ${key}` },
            });
            return (data.data || []).map(m => String(m.id || ''));
        },
    },
    {
        id: 'mistral',
        env: 'MISTRAL_API_KEY',
        label: 'Mistral',
        take: 2,
        prefer: [/small-latest/, /small/, /medium|large/],
        fallback: ['mistral-small-latest'],
        openai: 'https://api.mistral.ai/v1',
        async list(key) {
            const data = await fetchJSON('https://api.mistral.ai/v1/models', {
                headers: { Authorization: `Bearer ${key}` },
            });
            return (data.data || [])
                .filter(m => m.capabilities ? m.capabilities.completion_chat !== false : true)
                .map(m => String(m.id || ''));
        },
    },
    {
        id: 'openrouter',
        env: 'OPENROUTER_API_KEY',
        label: 'OpenRouter',
        take: 3,
        // Which models are free changes constantly — `llama-3.1-8b-instruct:free`
        // simply stopped existing, which is why this list is derived from
        // pricing at runtime rather than written down.
        prefer: [/gpt-oss/, /gemma/, /nemotron.*(super|nano)/, /llama|qwen|mistral|deepseek/],
        fallback: [],
        openai: 'https://openrouter.ai/api/v1',
        async list(key) {
            const data = await fetchJSON('https://openrouter.ai/api/v1/models', {
                headers: { Authorization: `Bearer ${key}` },
            });
            const isZero = v => ['0', '0.0', '-1', ''].includes(String(v ?? ''));
            return (data.data || [])
                .filter(m => isZero(m.pricing?.prompt) && isZero(m.pricing?.completion))
                // `openrouter/*` are meta-routers that can silently bill; the
                // rest are genuinely free endpoints.
                .filter(m => !String(m.id || '').startsWith('openrouter/'))
                .filter(m => (m.context_length || 0) >= 16000)
                .map(m => String(m.id || ''));
        },
    },
];

/**
 * Discover usable model IDs for one provider, cached per warm container.
 * Falls back to stable alias IDs when the list endpoint itself is unreachable.
 */
async function modelsFor(spec, key) {
    const cacheKey = `${spec.id}:${String(key).slice(-6)}`;
    const hit = listCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.value;

    let ids = spec.fallback;
    try {
        const found = pick(await spec.list(key), spec.prefer, spec.take);
        if (found.length) {
            ids = found;
            console.log(`[models] ${spec.label}: ${found.join(', ')}`);
        } else {
            console.warn(`[models] ${spec.label}: list returned nothing usable, using fallbacks`);
        }
    } catch (err) {
        console.warn(`[models] ${spec.label} list failed (${err.message}), using fallbacks`);
    }

    listCache.set(cacheKey, { value: ids, expires: Date.now() + LIST_TTL_MS });
    return ids;
}

/**
 * Build the full ordered fallback chain across every configured provider.
 *
 * Interleaved by provider rather than grouped, so one provider's exhausted
 * quota doesn't have to be discovered three times before moving on.
 *
 * @returns {Promise<Array<{name, model, providerId, spec, key}>>}
 */
async function buildChain(env = process.env) {
    const active = SPECS.filter(s => env[s.env]);
    if (!active.length) return [];

    const lists = await Promise.all(active.map(async spec => ({
        spec,
        key: env[spec.env],
        ids: await modelsFor(spec, env[spec.env]),
    })));

    const chain = [];
    const depth = Math.max(0, ...lists.map(l => l.ids.length));
    for (let i = 0; i < depth; i++) {
        for (const { spec, key, ids } of lists) {
            if (!ids[i]) continue;
            chain.push({
                name: `${ids[i]} (${spec.label})`,
                model: ids[i],
                providerId: spec.id,
                spec,
                key,
            });
        }
    }
    return chain.filter(c => !isDead(c.model));
}

module.exports = { buildChain, markDead, isDead, pick, EXCLUDE, SPECS };
