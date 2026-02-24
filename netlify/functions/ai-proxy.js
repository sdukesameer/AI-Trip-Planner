// netlify/functions/ai-proxy.js
// Keeps API keys server-side. Frontend calls /.netlify/functions/ai-proxy

exports.handler = async (event) => {
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

    async function geminiFlash(prompt) {
        if (!geminiKey) throw new Error("Gemini Key missing");
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
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
            throw new Error(`Gemini Flash [${res.status}]: ${err}`);
        }
        const data = await res.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text;
    }

    async function geminiPro(prompt) {
        if (!geminiKey) throw new Error("Gemini Key missing");
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-pro:generateContent?key=${geminiKey}`,
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
            throw new Error(`Gemini Pro [${res.status}]: ${err}`);
        }
        const data = await res.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text;
    }

    async function groq(prompt) {
        if (!groqKey) throw new Error("Groq Key missing");
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${groqKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "llama3-70b-8192",
                messages: [
                    { role: "system", content: "You are an expert travel planner. Always respond with valid JSON only, no markdown fences, no explanation." },
                    { role: "user", content: prompt }
                ]
            })
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Groq [${res.status}]: ${err}`);
        }
        const data = await res.json();
        return data?.choices?.[0]?.message?.content;
    }

    async function openrouter(prompt) {
        if (!openrouterKey) throw new Error("OpenRouter Key missing");
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${openrouterKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "mistralai/mistral-7b-instruct:free",
                messages: [
                    { role: "system", content: "You are an expert travel planner. Always respond with valid JSON only, no markdown fences, no explanation." },
                    { role: "user", content: prompt }
                ]
            })
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`OpenRouter [${res.status}]: ${err}`);
        }
        const data = await res.json();
        return data?.choices?.[0]?.message?.content;
    }

    const providers = [
        { name: 'Gemini Flash', fn: geminiFlash },
        { name: 'Gemini Pro', fn: geminiPro },
        { name: 'Groq', fn: groq },
        { name: 'OpenRouter', fn: openrouter }
    ];

    let text = null;
    let providerUsed = null;
    let errorDetails = [];

    for (const provider of providers) {
        try {
            text = await provider.fn(prompt);
            if (text) {
                providerUsed = provider.name;
                break;
            }
        } catch (err) {
            console.warn(`[Proxy Fallback] ${provider.name} failed:`, err.message);
            errorDetails.push(err.message);
        }
    }

    if (!text) {
        return { statusCode: 500, body: 'All AI providers failed:\n' + errorDetails.join('\n') };
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, providerUsed }),
    };
};
