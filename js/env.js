// ============================================================
//  env.js — SAFE PLACEHOLDER. Never put real keys here.
//
//  This file is committed to git and served publicly in production,
//  so any key written here is readable by anyone on the internet.
//
//  For LOCAL development against the AI providers directly, create
//  js/env.local.js (git-ignored) — it takes precedence over this file:
//
//    export const ENV_KEYS = {
//      geminiKey:     '...',   // https://aistudio.google.com/app/apikey
//      groqKey:       '...',   // https://console.groq.com/keys
//      openrouterKey: '...',   // https://openrouter.ai/dashboard/apikeys
//      unsplashKey:   '...',   // https://unsplash.com/developers
//    };
//
//  In production none of this is needed: requests go through the
//  Netlify functions, which read the keys from the server environment.
//  The OpenWeather key is server-side only and has no client equivalent.
// ============================================================
export const ENV_KEYS = {};
