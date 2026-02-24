export const ENV_KEYS = {
    // Required: Get a free key at https://aistudio.google.com/app/apikey (15 RPM free)
    geminiKey: 'PASTE_YOUR_GEMINI_KEY_HERE',

    // Optional: Only used if Gemini fails. Get a free key at https://console.groq.com/keys
    groqKey: 'PASTE_YOUR_GROQ_KEY_HERE',

    // Optional: Only used if Gemini and Groq both fail. Get a free key at https://openrouter.ai/dashboard/apikeys
    openrouterKey: 'PASTE_YOUR_OPENROUTER_KEY_HERE',

    // Optional: Used to fetch high-quality place photos. Get a free key at https://unsplash.com/developers (50 req/hr free).
    // If empty, the app falls back to placeholder SVG images automatically.
    unsplashKey: 'PASTE_YOUR_UNSPLASH_KEY_HERE',

    // Optional: Used for daily weather forecasts. Get a free key at https://openweathermap.org/api
    openWeatherKey: 'PASTE_YOUR_OPENWEATHER_KEY_HERE'
};
