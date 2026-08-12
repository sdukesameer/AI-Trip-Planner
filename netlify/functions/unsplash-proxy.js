// netlify/functions/unsplash-proxy.js
// Keeps the Unsplash access key server-side and caches results at the edge.

const { isAllowedOrigin, rateLimit, json, text } = require('./_shared');

const MAX_QUERY_CHARS = 120;

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') return text(405, 'Method Not Allowed');
    if (!isAllowedOrigin(event)) return text(403, 'Forbidden');

    const limit = rateLimit(event, { max: 120, windowMs: 60000 });
    if (!limit.ok) return text(429, 'Too many requests', { 'Retry-After': String(limit.retryAfter) });

    const key = process.env.UNSPLASH_ACCESS_KEY;
    if (!key) return text(503, 'Unsplash not configured');

    const { query, per_page = '3', orientation = 'landscape' } = event.queryStringParameters || {};
    if (!query || !query.trim()) return text(400, 'Missing query');
    if (query.length > MAX_QUERY_CHARS) return text(413, 'Query too long');

    const perPage = Math.min(10, Math.max(1, parseInt(per_page, 10) || 3));
    const safeOrientation = ['landscape', 'portrait', 'squarish'].includes(orientation) ? orientation : 'landscape';

    try {
        const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query.trim())}`
            + `&per_page=${perPage}&orientation=${safeOrientation}&client_id=${key}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        let res;
        try { res = await fetch(url, { signal: controller.signal }); }
        finally { clearTimeout(timer); }

        if (!res.ok) {
            // Surface the real status (401 bad key, 403 quota) instead of a 200
            // with a body the client has to guess at.
            return json(res.status === 403 ? 429 : 502, { results: [], error: `Unsplash HTTP ${res.status}` });
        }

        const data = await res.json();
        // Only forward the fields the client actually uses.
        const results = (data.results || []).map(r => ({
            urls: { small: r.urls?.small, regular: r.urls?.regular },
            description: r.description,
            alt_description: r.alt_description,
            tags: (r.tags || []).map(t => ({ title: t.title })),
            user: { name: r.user?.name, links: { html: r.user?.links?.html } },
        }));

        return json(200, { results }, {
            // Place photos never change — cache hard so repeat lookups don't
            // burn the 50 requests/hour demo quota.
            'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
        });
    } catch (err) {
        return json(502, { results: [], error: err.message });
    }
};
