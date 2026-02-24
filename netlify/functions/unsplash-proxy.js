// netlify/functions/unsplash-proxy.js
exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const key = process.env.UNSPLASH_ACCESS_KEY;
    if (!key) return { statusCode: 503, body: 'Unsplash not configured' };

    const { query, per_page = '3', orientation = 'landscape' } = event.queryStringParameters || {};
    if (!query) return { statusCode: 400, body: 'Missing query' };

    try {
        const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${per_page}&orientation=${orientation}&client_id=${key}`;
        const res = await fetch(url);
        const data = await res.json();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        };
    } catch (err) {
        return { statusCode: 500, body: err.message };
    }
};
