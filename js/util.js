// ============================================================
//  util.js — Shared helpers: escaping, dates, geo, concurrency, a11y
// ============================================================

export const LOCALE = typeof navigator !== 'undefined' ? (navigator.language || 'en-IN') : 'en-IN';

// ── HTML escaping ─────────────────────────────────────────────
// Every string that reaches innerHTML must pass through esc(). AI output and
// share-link payloads are untrusted input, not just decoration.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, ch => ESC_MAP[ch]);
}

/** Escape for use inside a URL query segment, guarding against javascript: URLs. */
export function safeUrl(url) {
    const s = String(url || '').trim();
    if (/^(https?:|data:image\/)/i.test(s)) return s;
    return '';
}

// ── Timing ────────────────────────────────────────────────────
export function debounce(fn, ms) {
    let t = null;
    const wrapped = (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Local-date helpers ────────────────────────────────────────
// Never use toISOString() for calendar dates: it converts to UTC and shifts the
// day for every user east or west of Greenwich.
export function ymd(date) {
    const d = date instanceof Date ? date : new Date(date);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

/** Parse "YYYY-MM-DD" as a *local* midnight Date (new Date(str) parses as UTC). */
export function parseYMD(str) {
    if (str instanceof Date) return new Date(str.getFullYear(), str.getMonth(), str.getDate());
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str || ''));
    if (!m) return new Date(NaN);
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function todayLocal() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

export function addDays(date, n) {
    const d = parseYMD(date);
    d.setDate(d.getDate() + n);
    return d;
}

/** Whole days from d1 → d2 (calendar days, timezone-safe). */
export function diffDays(d1, d2) {
    const a = parseYMD(d1), b = parseYMD(d2);
    return Math.round((b - a) / 86400000);
}

export function weekdayName(date) {
    return parseYMD(date).toLocaleDateString('en-US', { weekday: 'long' });
}

export function formatLongDate(date) {
    const d = parseYMD(date);
    if (isNaN(d)) return String(date || '');
    return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatWeekdayDate(date) {
    const d = parseYMD(date);
    if (isNaN(d)) return String(date || '');
    return d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ── Geo ───────────────────────────────────────────────────────
export function haversineKm(a, b) {
    if (!a || !b) return 0;
    const R = 6371;
    const toRad = deg => (deg * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Straight-line route length for an ordered list of {lat,lng} places. */
export function routeDistanceKm(places = []) {
    const pts = places.filter(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += haversineKm(pts[i - 1], pts[i]);
    return total;
}

// ── Concurrency ───────────────────────────────────────────────
/** Run `fn` over `items` with at most `limit` in flight. Results keep input order. */
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const idx = cursor++;
            try { results[idx] = await fn(items[idx], idx); }
            catch { results[idx] = undefined; }
        }
    });
    await Promise.all(workers);
    return results;
}

/** fetch() with an abort timeout that always clears its timer. */
export async function fetchWithTimeout(url, options = {}, ms = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Request timed out');
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// ── Accessibility: modal focus management ─────────────────────
const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Keep Tab focus inside `container` until the returned function is called.
 * Restores focus to whatever was focused beforehand.
 */
export function trapFocus(container) {
    if (!container) return () => { };
    const previouslyFocused = document.activeElement;

    const onKeydown = e => {
        if (e.key !== 'Tab') return;
        const items = [...container.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    container.addEventListener('keydown', onKeydown);
    const firstFocusable = container.querySelector(FOCUSABLE);
    if (firstFocusable) setTimeout(() => firstFocusable.focus(), 30);

    return () => {
        container.removeEventListener('keydown', onKeydown);
        if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
            previouslyFocused.focus();
        }
    };
}

export const prefersReducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
