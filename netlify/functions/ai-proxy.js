// netlify/functions/ai-proxy.js
// Keeps API keys server-side. Frontend calls /.netlify/functions/ai-proxy

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, body: 'Invalid JSON' }; }

    const { provider, model, prompt } = body;
    if (!provider || !model || !prompt) {
        return { statusCode: 400, body: 'Missing provider, model, or prompt' };
    }

    try {
        let text = '';

        if (provider === 'gemini') {
            const key = process.env.GEMINI_API_KEY;
            if (!key) return { statusCode: 503, body: 'Gemini not configured' };

            const url = `${GEMINI_BASE}/${model}:generateContent?key=${key}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                return { statusCode: res.status, body: err.error?.message || `HTTP ${res.status}` };
            }
            const data = await res.json();
            text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        } else if (provider === 'groq') {
            const key = process.env.GROQ_API_KEY;
            if (!key) return { statusCode: 503, body: 'Groq not configured' };

            const res = await fetch(GROQ_BASE, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`,
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: 'You are an expert travel planner. Always respond with valid JSON only, no markdown fences, no explanation.' },
                        { role: 'user', content: prompt },
                    ],
                    temperature: 0.7,
                    max_tokens: 8192,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                return { statusCode: res.status, body: err.error?.message || `HTTP ${res.status}` };
            }
            const data = await res.json();
            text = data.choices?.[0]?.message?.content || '';

        } else {
            return { statusCode: 400, body: 'Unknown provider' };
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        };

    } catch (err) {
        return { statusCode: 500, body: err.message };
    }
};
