// ============================================================
//  _shared.js — Common guards for the serverless functions
// ============================================================

/**
 * These endpoints spend money (AI tokens, Unsplash quota), so they are only
 * meant to be called by this site's own front end. We can't authenticate a
 * static site properly, but we can cheaply reject the drive-by abuse: requests
 * from other origins and floods from a single IP.
 */

const ALLOWED_ORIGIN_SUFFIXES = [
    '.netlify.app',
    '.netlify.live',   // Netlify branch/deploy previews
    'localhost',
    '127.0.0.1',
];

/** Extra origins can be allow-listed with the ALLOWED_ORIGINS env var (comma-separated). */
function extraOrigins() {
    return (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function hostFrom(value) {
    if (!value) return '';
    try { return new URL(value).hostname; } catch { return ''; }
}

/** True when the request looks like it came from this site. */
function isAllowedOrigin(event) {
    const headers = event.headers || {};
    const host = hostFrom(headers.origin) || hostFrom(headers.referer);

    // Same-host requests are always fine (covers the deployed site itself).
    const selfHost = (headers.host || '').split(':')[0];
    if (host && selfHost && host === selfHost) return true;

    if (!host) {
        // No Origin/Referer at all: browsers always send one for cross-origin
        // fetches, so treat this as a non-browser client and reject.
        return false;
    }
    if (extraOrigins().some(o => host === o || host === hostFrom(o))) return true;
    return ALLOWED_ORIGIN_SUFFIXES.some(suffix =>
        host === suffix || host.endsWith(suffix));
}

// ── Rate limiting ─────────────────────────────────────────────
// Best-effort only: Lambda containers are recycled and there may be several in
// flight, so this throttles bursts rather than enforcing a hard global quota.
const buckets = new Map();

function clientIp(event) {
    const h = event.headers || {};
    return (h['x-nf-client-connection-ip'] || h['client-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
}

function rateLimit(event, { max = 20, windowMs = 60000 } = {}) {
    const ip = clientIp(event);
    const now = Date.now();
    const bucket = buckets.get(ip) || { count: 0, resetAt: now + windowMs };

    if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + windowMs; }
    bucket.count++;
    buckets.set(ip, bucket);

    // Keep the map from growing without bound across a warm container's life.
    if (buckets.size > 5000) {
        for (const [key, b] of buckets) if (now > b.resetAt) buckets.delete(key);
    }

    return {
        ok: bucket.count <= max,
        retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
}

const json = (statusCode, payload, extraHeaders = {}) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload),
});

const text = (statusCode, message, extraHeaders = {}) => ({
    statusCode,
    headers: { 'Content-Type': 'text/plain', ...extraHeaders },
    body: message,
});

module.exports = { isAllowedOrigin, rateLimit, clientIp, json, text };
