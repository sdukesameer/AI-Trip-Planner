// netlify/functions/ai-proxy.js
// Keeps API keys server-side. Frontend calls /.netlify/functions/ai-proxy

const { isAllowedOrigin, rateLimit, json, text } = require('./_shared');

// Netlify's synchronous function limit is 10s. Budget the whole fallback chain
// inside that so we return a real error instead of a platform 502.
const TOTAL_BUDGET_MS = 9000;
const MIN_ATTEMPT_MS = 1500;
const MAX_PROMPT_CHARS = 12000;

exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };
    if (event.httpMethod !== 'POST') return text(405, 'Method Not Allowed');

    // This endpoint spends real tokens — don't let arbitrary sites use it.
    if (!isAllowedOrigin(event)) return text(403, 'Forbidden');

    const limit = rateLimit(event, { max: 20, windowMs: 60000 });
    if (!limit.ok) return text(429, 'Too many requests — please slow down.', { 'Retry-After': String(limit.retryAfter) });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return text(400, 'Invalid JSON'); }

    const { prompt } = body;
    if (typeof prompt !== 'string' || !prompt.trim()) return text(400, 'Missing prompt');
    if (prompt.length > MAX_PROMPT_CHARS) return text(413, 'Prompt too large');

    const geminiKey = process.env.GEMINI_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;

    if (!geminiKey && !groqKey && !openrouterKey) {
        return json(503, { error: 'No AI provider configured on the server' });
    }

    const startedAt = Date.now();
    const remainingBudget = () => TOTAL_BUDGET_MS - (Date.now() - startedAt);

    const withTimeout = async (fn, ms, name) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        try {
            return await fn(controller.signal);
        } catch (err) {
            if (err.name === 'AbortError') throw new Error(`${name} timed out after ${ms}ms`);
            throw err;
        } finally {
            clearTimeout(timer);
        }
    };

    const SYSTEM = 'You are an expert travel planner. Always respond with valid JSON only, no markdown fences, no explanation.';

    // ── Gemini ────────────────────────────────────────────────
    const gemini = model => async signal => {
        if (!geminiKey) throw new Error('Gemini key missing');
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
                signal,
            }
        );
        if (!res.ok) throw new Error(`${model} [${res.status}]: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text;
    };

    // ── OpenAI-compatible (Groq / OpenRouter) ─────────────────
    const chat = (endpoint, key, model) => async signal => {
        if (!key) throw new Error(`${model} key missing`);
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
                temperature: 0.7,
                max_tokens: 8192,
            }),
            signal,
        });
        if (!res.ok) throw new Error(`${model} [${res.status}]: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        return data?.choices?.[0]?.message?.content;
    };

    const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
    const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';

    // Provider fallback chain (BEST → GOOD → LAST RESORT)
    const providers = [
        // TIER 1: Gemini 2.5 Flash — best quality, ~0.4s TTFT. Free: 10 RPM / 250 RPD.
        { name: 'Gemini 2.5 Flash', fn: gemini('gemini-2.5-flash'), skip: !geminiKey },
        { name: 'Gemini 2.5 Flash Lite', fn: gemini('gemini-2.5-flash-lite'), skip: !geminiKey },

        // TIER 2: Groq — LPU hardware, 1–3s full response, 14,400 req/day free.
        { name: 'Llama 3.3 70B Versatile (Groq)', fn: chat(GROQ, groqKey, 'llama-3.3-70b-versatile'), skip: !groqKey },
        { name: 'Llama 3.1 8B Instant (Groq)', fn: chat(GROQ, groqKey, 'llama-3.1-8b-instant'), skip: !groqKey },

        // TIER 3: OpenRouter — 50 req/day on the free tier. Last resort.
        { name: 'OpenRouter Llama 3.1 8B Free', fn: chat(OPENROUTER, openrouterKey, 'meta-llama/llama-3.1-8b-instruct:free'), skip: !openrouterKey },
    ].filter(p => !p.skip);

    const errors = [];

    for (const provider of providers) {
        const budget = remainingBudget();
        // Don't start an attempt we can't finish — return the accumulated error
        // rather than letting the platform kill the whole invocation.
        if (budget < MIN_ATTEMPT_MS) {
            errors.push(`${provider.name}: skipped (out of time budget)`);
            break;
        }
        try {
            const result = await withTimeout(provider.fn, budget, provider.name);
            if (result) {
                console.log(`[ai-proxy] ✅ ${provider.name} (after ${errors.length} failures)`);
                return json(200, { text: result, providerUsed: provider.name }, { 'Cache-Control': 'no-store' });
            }
            errors.push(`${provider.name}: empty response`);
        } catch (err) {
            console.warn(`[ai-proxy] ❌ ${provider.name}: ${err.message}`);
            errors.push(`${provider.name}: ${err.message}`);
        }
    }

    console.error('[ai-proxy] all providers failed:\n' + errors.join('\n'));
    return json(502, { error: 'All AI providers failed', details: errors.join('\n') });
};
