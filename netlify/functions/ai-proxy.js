// netlify/functions/ai-proxy.js
// Keeps API keys server-side. Frontend calls /.netlify/functions/ai-proxy

exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, body: 'Invalid JSON' }; }

    const { prompt } = body;
    if (!prompt) {
        return { statusCode: 400, body: 'Missing prompt' };
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;

    // Helper to add timeout to any provider call
    const PROVIDER_TIMEOUT_MS = 9000;
    const withTimeout = (promise, ms, name) =>
        Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms)
            )
        ]);

    // ── TIER 1: Gemini 2.5 Flash (Current Working Model) ────────
    async function gemini25Flash(prompt) {
        if (!geminiKey) throw new Error("Gemini Key missing");
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            }
        );
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Gemini 2.5 Flash [${res.status}]: ${err}`);
        }
        const data = await res.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text;
    }

    // ── TIER 1b: Gemini 2.5 Flash Lite (Budget-friendly fallback) ──
    async function gemini25FlashLite(prompt) {
        if (!geminiKey) throw new Error("Gemini Key missing");
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            }
        );
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Gemini 2.5 Flash Lite [${res.status}]: ${err}`);
        }
        const data = await res.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text;
    }

    // ── TIER 2: Groq - Llama 3.3 70B Versatile (STILL WORKING) ────
    async function groq33Versatile(prompt) {
        if (!groqKey) throw new Error("Groq Key missing");
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${groqKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "system", content: "You are an expert travel planner. Always respond with valid JSON only, no markdown fences, no explanation." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.7,
                max_tokens: 8192
            })
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Groq Llama 3.3 70B [${res.status}]: ${err}`);
        }
        const data = await res.json();
        return data?.choices?.[0]?.message?.content;
    }

    // ── TIER 2b: Groq - Llama 3.1 8B Instant (Smaller fallback) ───
    async function groq31Instant(prompt) {
        if (!groqKey) throw new Error("Groq Key missing");
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${groqKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "system", content: "You are an expert travel planner. Always respond with valid JSON only, no markdown fences, no explanation." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.7,
                max_tokens: 8192
            })
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Groq Llama 3.1 8B [${res.status}]: ${err}`);
        }
        const data = await res.json();
        return data?.choices?.[0]?.message?.content;
    }

    // ── TIER 3: OpenRouter Llama 3.1 8B Free (Ultimate safety net) ─
    async function openrouterFree(prompt) {
        if (!openrouterKey) throw new Error("OpenRouter Key missing");
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${openrouterKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "meta-llama/llama-3.1-8b-instruct:free",
                messages: [
                    { role: "system", content: "You are an expert travel planner. Always respond with valid JSON only, no markdown fences, no explanation." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.7,
                max_tokens: 8192
            })
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`OpenRouter [${res.status}]: ${err}`);
        }
        const data = await res.json();
        return data?.choices?.[0]?.message?.content;
    }

    // ── Provider fallback chain (BEST → GOOD → FALLBACK) ──────────
    const providers = [
        // TIER 1: Gemini 2.5 Flash — best quality, TTFT 0.37s, fits in 8s budget.
        //   Free limits: 10 RPM, 250 RPD. Will 429 under load → falls to Groq.
        { name: 'Gemini 2.5 Flash', fn: gemini25Flash },
        { name: 'Gemini 2.5 Flash Lite', fn: gemini25FlashLite },

        // TIER 2: Groq — LPU hardware, 1–3s full response, 14,400 req/day free.
        //   Catches Gemini 429s. Slightly lower quality but very reliable.
        { name: 'Llama 3.3 70B Versatile (Groq)', fn: groq33Versatile },
        { name: 'Llama 3.1 8B Instant (Groq)', fn: groq31Instant },

        // TIER 3: OpenRouter — only 50 req/day on free tier (cut Apr 2025). Last resort.
        { name: 'OpenRouter Llama 3.1 8B Free', fn: openrouterFree },
    ];

    let text = null;
    let providerUsed = null;
    let errorDetails = [];

    // Try each provider in order
    for (const provider of providers) {
        try {
            text = await withTimeout(provider.fn(prompt), PROVIDER_TIMEOUT_MS, provider.name);
            if (text) {
                providerUsed = provider.name;
                console.log(`[ai-proxy] ✅ Success with ${provider.name}`);
                break;
            }
        } catch (err) {
            console.warn(`[ai-proxy] ❌ ${provider.name} failed:`, err.message);
            errorDetails.push(`${provider.name}: ${err.message}`);
        }
    }

    // Return success or fail
    if (!text) {
        const errorMsg = errorDetails.join('\n');
        console.error('[ai-proxy] ❌ All providers failed:\n', errorMsg);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'All AI providers failed', details: errorMsg })
        };
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, providerUsed }),
    };
};
