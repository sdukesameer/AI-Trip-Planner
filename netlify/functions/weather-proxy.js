// netlify/functions/weather-proxy.js
// 5-day / 3-hour OpenWeather forecast, summarised to one reading per day.

const { isAllowedOrigin, rateLimit, json, text } = require('./_shared');

const MAX_CITY_CHARS = 80;

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') return text(405, 'Method Not Allowed');
    if (!isAllowedOrigin(event)) return text(403, 'Forbidden');

    const limit = rateLimit(event, { max: 60, windowMs: 60000 });
    if (!limit.ok) return text(429, 'Too many requests', { 'Retry-After': String(limit.retryAfter) });

    const key = process.env.OPENWEATHER_API_KEY;
    if (!key) return text(503, 'Weather not configured');

    const { city } = event.queryStringParameters || {};
    if (!city || !city.trim()) return text(400, 'Missing city');
    if (city.length > MAX_CITY_CHARS) return text(413, 'City name too long');

    try {
        const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city.trim())}`
            + `&appid=${key}&units=metric&cnt=40`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        let res;
        try { res = await fetch(url, { signal: controller.signal }); }
        finally { clearTimeout(timer); }

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return json(res.status === 404 ? 404 : 502, { error: err.message || `HTTP ${res.status}` });
        }

        const data = await res.json();

        // One reading per date: whichever is closest to local noon.
        const byDate = {};
        (data.list || []).forEach(item => {
            const date = item.dt_txt.slice(0, 10);
            const hour = parseInt(item.dt_txt.slice(11, 13), 10);
            const current = byDate[date];
            if (!current || Math.abs(hour - 12) < Math.abs(parseInt(current.dt_txt.slice(11, 13), 10) - 12)) {
                byDate[date] = item;
            }
        });

        const forecasts = Object.values(byDate)
            .map(item => ({
                date: item.dt_txt.slice(0, 10),
                temp_min: Math.round(item.main.temp_min),
                temp_max: Math.round(item.main.temp_max),
                feels_like: Math.round(item.main.feels_like),
                humidity: item.main.humidity,
                description: item.weather[0]?.description || '',
                icon: item.weather[0]?.icon || '01d',
                wind_kph: Math.round((item.wind?.speed || 0) * 3.6),
                pop: Math.round((item.pop || 0) * 100),
            }))
            .sort((a, b) => a.date.localeCompare(b.date));

        return json(200, forecasts, {
            // Forecasts refresh roughly hourly upstream.
            'Cache-Control': 'public, max-age=1800, s-maxage=3600, stale-while-revalidate=1800',
        });
    } catch (err) {
        return json(502, { error: err.message });
    }
};
