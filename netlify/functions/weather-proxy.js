// netlify/functions/weather-proxy.js
exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const key = process.env.OPENWEATHER_API_KEY;
    if (!key) return { statusCode: 503, body: 'Weather not configured' };

    const { city } = event.queryStringParameters || {};
    if (!city) return { statusCode: 400, body: 'Missing city' };

    try {
        // Use 5-day/3-hour forecast API (free tier)
        const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${key}&units=metric&cnt=40`;
        const res = await fetch(url);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { statusCode: res.status, body: err.message || `HTTP ${res.status}` };
        }
        const data = await res.json();

        // Summarise: pick the noon-ish reading for each unique date
        const byDate = {};
        (data.list || []).forEach(item => {
            const d = item.dt_txt.slice(0, 10); // YYYY-MM-DD
            const hour = parseInt(item.dt_txt.slice(11, 13), 10);
            // Prefer reading closest to noon (12:00)
            if (!byDate[d] || Math.abs(hour - 12) < Math.abs(parseInt(byDate[d].dt_txt.slice(11, 13), 10) - 12)) {
                byDate[d] = item;
            }
        });

        // Return flat array sorted by date
        const forecasts = Object.values(byDate).map(item => ({
            date: item.dt_txt.slice(0, 10),
            temp_min: Math.round(item.main.temp_min),
            temp_max: Math.round(item.main.temp_max),
            feels_like: Math.round(item.main.feels_like),
            humidity: item.main.humidity,
            description: item.weather[0]?.description || '',
            icon: item.weather[0]?.icon || '01d',
            wind_kph: Math.round((item.wind?.speed || 0) * 3.6),
            pop: Math.round((item.pop || 0) * 100), // chance of rain %
        }));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(forecasts),
        };
    } catch (err) {
        return { statusCode: 500, body: err.message };
    }
};
