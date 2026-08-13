// netlify/functions/ai-proxy.js
// Keeps API keys server-side. Frontend calls /.netlify/functions/ai-proxy

const { isAllowedOrigin, rateLimit, json, text } = require('./_shared');
const { buildChain, markDead } = require('./_models');

// Netlify's synchronous function limit is 10s. Budget the whole fallback chain
// inside that so we return a real error instead of a platform 502.
const TOTAL_BUDGET_MS = 9000;
const MIN_ATTEMPT_MS = 1200;
const MAX_PROMPT_CHARS = 12000;

const DEFAULT_MAX_TOKENS = 2048;
const TOKEN_CEILING = 4096;

const SYSTEM = 'You are an expert travel planner. Always respond with valid JSON only, no markdown fences, no explanation.';

/** Rough token estimate. Good enough for fitting inside a rate limit. */
const estimateTokens = str => Math.ceil(String(str).length / 3.5);

/** Pull the real budget out of a provider's 413/429 complaint, e.g. "Limit 6000". */
function parseLimit(message) {
    const m = /limit\s+(\d+)/i.exec(String(message));
    return m ? Number(m[1]) : null;
}

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

    // The caller knows how much output it needs; a place list needs far less
    // than a four-day schedule. Asking for less is not just cheaper — providers
    // charge max_tokens against the rate limit up front.
    const requestedTokens = Math.min(TOKEN_CEILING,
        Math.max(256, Number(body.maxTokens) || DEFAULT_MAX_TOKENS));

    const promptTokens = estimateTokens(prompt);

    const chain = await buildChain(process.env);
    if (!chain.length) {
        const anyKey = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY']
            .some(k => process.env[k]);
        return json(503, {
            error: anyKey
                ? 'Every configured AI model is rate-limited or unavailable right now.'
                : 'No AI provider configured on the server',
            exhausted: anyKey,
        });
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

    /** Thrown with a status so the caller can decide how long to shun a model. */
    class ProviderError extends Error {
        constructor(message, status) { super(message); this.status = status; }
    }

    // ── Gemini (native API) ───────────────────────────────────
    const callGemini = (model, key, maxTokens) => async signal => {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    systemInstruction: { parts: [{ text: SYSTEM }] },
                    // Native JSON mode: removes a whole class of parse failures.
                    generationConfig: {
                        temperature: 0.7,
                        maxOutputTokens: maxTokens,
                        responseMimeType: 'application/json',
                    },
                }),
                signal,
            }
        );
        if (!res.ok) throw new ProviderError(`[${res.status}] ${(await res.text()).slice(0, 200)}`, res.status);
        const data = await res.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text;
    };

    // ── OpenAI-compatible (Groq / Cerebras / Mistral / OpenRouter) ──
    const callChat = (base, model, key, maxTokens) => async signal => {
        const res = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
                // OpenRouter attributes free-tier usage by these.
                'HTTP-Referer': 'https://ai-trip-genie.netlify.app',
                'X-Title': 'AI Trip Planner',
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
                temperature: 0.7,
                max_tokens: maxTokens,
            }),
            signal,
        });
        if (!res.ok) throw new ProviderError(`[${res.status}] ${(await res.text()).slice(0, 200)}`, res.status);
        const data = await res.json();
        return data?.choices?.[0]?.message?.content;
    };

    const invoke = (link, maxTokens) => link.providerId === 'gemini'
        ? callGemini(link.model, link.key, maxTokens)
        : callChat(link.spec.openai, link.model, link.key, maxTokens);

    const errors = [];
    let sawQuotaError = false;

    for (const link of chain) {
        const budget = remainingBudget();
        // Don't start an attempt we can't finish — return the accumulated error
        // rather than letting the platform kill the whole invocation.
        if (budget < MIN_ATTEMPT_MS) {
            errors.push(`${link.name}: skipped (out of time budget)`);
            break;
        }

        // Providers count max_tokens against the per-minute limit before the
        // model even runs, so an over-large ask is an instant, permanent 413.
        let maxTokens = requestedTokens;
        if (link.spec.tpm) {
            maxTokens = Math.max(512, Math.min(maxTokens, link.spec.tpm - promptTokens - 200));
        }

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const result = await withTimeout(invoke(link, maxTokens), remainingBudget(), link.name);
                if (result) {
                    console.log(`[ai-proxy] ✅ ${link.name} (${maxTokens} max tokens, after ${errors.length} failures)`);
                    return json(200, { text: result, providerUsed: link.name }, { 'Cache-Control': 'no-store' });
                }
                errors.push(`${link.name}: empty response`);
                break;
            } catch (err) {
                const status = err.status || 0;

                // A 413 tells us the real budget — refit and try this same model
                // once more rather than writing it off.
                const cap = status === 413 ? parseLimit(err.message) : null;
                if (cap && attempt === 0) {
                    const refit = cap - promptTokens - 200;
                    if (refit >= 400) {
                        console.warn(`[ai-proxy] ↻ ${link.name}: refitting ${maxTokens} → ${refit} tokens`);
                        maxTokens = refit;
                        continue;
                    }
                }

                if (status === 429 || status === 413) sawQuotaError = true;
                markDead(link.model, status);
                console.warn(`[ai-proxy] ❌ ${link.name}: ${err.message}`);
                errors.push(`${link.name}: ${err.message}`);
                break;
            }
        }
    }

    console.error('[ai-proxy] all providers failed:\n' + errors.join('\n'));
    // `exhausted` lets the front end say "quota is used up, using offline data"
    // rather than the misleading "something went wrong".
    return json(502, {
        error: sawQuotaError
            ? 'All AI providers are out of free quota right now.'
            : 'All AI providers failed',
        exhausted: sawQuotaError,
        details: errors.join('\n'),
    });
};
