// ============================================================
//  app.js — State manager & screen router  (v3)
// ============================================================

import {
    fetchFamousPlaces, fetchMorePlaces, searchNearbyPlaces,
    fetchPlaceImages, scheduleZonePlan, rescheduleDay, getLastProvider, svgPlaceholder,
    enrichCustomPlaces, fetchWeatherForDays, weatherEmoji, proxyAvailability,
    geocodeStay, suggestAlternatives, generatePackingList, generatePracticalInfo
} from './api.js';
import { initMap, plotItinerary, focusDay, focusPlace, resetFocus, setMapTheme, refreshMapSize } from './maps.js';
import { downloadAsText, downloadAsPDF, downloadAsCalendar, copyToClipboard } from './download.js';
import { buildZonePlan, validateItinerary, reoptimiseDay } from './planner.js';
import { attachRoutes, TRANSPORT_MODES, DEFAULT_MODE, formatDuration, routingAvailable } from './routing.js';
import { CURRENCIES, DEFAULT_CURRENCY, formatMoney, estimateTripBudget } from './budget.js';
import {
    esc, safeUrl, debounce, LOCALE, ymd, parseYMD, todayLocal, addDays, diffDays,
    formatWeekdayDate, trapFocus
} from './util.js';

const SCREENS = ['screen-input', 'screen-discovery', 'screen-itinerary'];
const MAX_LOCATIONS = 6;
const MAX_TRIP_DAYS = 30;
const MAX_SAVED_TRIPS = 5;
const STORAGE_MAX_KB = 3072;

const INTEREST_OPTIONS = ['Heritage', 'Nature', 'Religious', 'Market', 'Museum', 'Entertainment', 'Food', 'Photography', 'Nightlife', 'Adventure'];

// ── Global State ─────────────────────────────────────────────
const state = {
    locations: [],
    startDate: '',
    endDate: '',
    places: [],
    imageCache: {},
    autoMode: true,
    selectedPlaces: [],
    itinerary: null,
    aiProvider: '',
    weatherMap: {},
    filter: { category: 'all', selectedOnly: false },
    stay: null,              // {name, lat, lng} — anchors every day
    zoneStats: null,
    planIssues: [],
    packingList: null,
    localInfo: null,
    prefs: {
        pace: 'balanced',
        startTime: '10:00 AM',
        budget: 'moderate',
        travellers: 2,
        withKids: false,
        accessibility: false,
        interests: [],
        avoid: '',
        transport: DEFAULT_MODE,
        currency: DEFAULT_CURRENCY,
    },
    caps: { hasAI: false, hasImages: false, hasWeather: false },
    config: { geminiKey: '', groqKey: '', openrouterKey: '', unsplashKey: '' },
};

// ── Environment / capabilities ────────────────────────────────
async function loadEnvironment() {
    // js/env.local.js is git-ignored and holds real keys for direct-provider
    // local development. It only exists during local development, so don't even
    // ask for it in production (a 404 in the console is confusing noise).
    let keys = {};
    const candidates = isLocalStatic() ? ['./env.local.js', './env.js'] : ['./env.js'];
    for (const path of candidates) {
        try {
            const m = await import(path);
            if (m?.ENV_KEYS && Object.keys(m.ENV_KEYS).length) { keys = m.ENV_KEYS; break; }
        } catch { /* file absent — expected */ }
    }
    const real = v => (typeof v === 'string' && v.length > 10 && !v.startsWith('PASTE_YOUR_') ? v : '');
    state.config = {
        geminiKey: real(keys.geminiKey),
        groqKey: real(keys.groqKey),
        openrouterKey: real(keys.openrouterKey),
        unsplashKey: real(keys.unsplashKey),
    };

    try {
        const m = await import('./app-config.js');
        if (m?.APP_CONFIG) state.caps = { ...state.caps, ...m.APP_CONFIG };
    } catch { /* not generated yet */ }
}

function isLocalStatic() {
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '' || location.protocol === 'file:';
}

function hasDirectKeys() {
    return Boolean(state.config.geminiKey || state.config.groqKey || state.config.openrouterKey);
}

/**
 * Optimistic: only refuse once we've actually established there is nothing to
 * call. `proxyAvailability()` is null until the first request, so `netlify dev`
 * on localhost still works even though the build-time flags say otherwise.
 */
function canUseAI() {
    if (state.caps.hasAI || hasDirectKeys()) return true;
    return proxyAvailability() !== false;
}

function requireAI() {
    if (canUseAI()) return true;
    showToast('AI is not configured. Add keys to js/env.local.js for local development.', 'error');
    return false;
}

/** Local dev with neither serverless functions nor local keys — warn up front. */
function shouldWarnAboutConfig() {
    return isLocalStatic() && !hasDirectKeys() && !state.caps.hasAI;
}

// ── Session cache (survives JS navigation, clears on tab close) ─
const _memCache = new Map();
function cacheGet(key) {
    if (_memCache.has(key)) return _memCache.get(key);
    try {
        const raw = sessionStorage.getItem('atp_' + key);
        if (raw) { const v = JSON.parse(raw); _memCache.set(key, v); return v; }
    } catch { /* ignore */ }
    return null;
}
function cacheSet(key, val) {
    _memCache.set(key, val);
    try { sessionStorage.setItem('atp_' + key, JSON.stringify(val)); } catch { /* storage full */ }
}
function cacheKey(...parts) { return parts.join('|'); }

// ── Screen management (with browser history) ──────────────────
function screenIsReachable(id) {
    if (id === 'screen-discovery') return state.places.length > 0;
    if (id === 'screen-itinerary') return Boolean(state.itinerary);
    return true;
}

function showScreen(id, { push = true } = {}) {
    if (!SCREENS.includes(id)) id = 'screen-input';
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (push && history.state?.screen !== id) {
        history.pushState({ screen: id }, '', location.pathname + location.search);
    }
    if (id === 'screen-itinerary') setTimeout(refreshMapSize, 120);
}

window.addEventListener('popstate', e => {
    const target = e.state?.screen || 'screen-input';
    showScreen(screenIsReachable(target) ? target : 'screen-input', { push: false });
});

// ── Modals (focus-trapped, Escape-closable) ───────────────────
const _modalReleasers = new Map();

function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    _modalReleasers.set(id, trapFocus(el));
}

function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('hidden');
    el.setAttribute('aria-hidden', 'true');
    const release = _modalReleasers.get(id);
    if (release) { release(); _modalReleasers.delete(id); }
    if (!document.querySelector('.modal-overlay:not(.hidden)')) {
        document.body.classList.remove('modal-open');
    }
}

function closeTopModal() {
    const open = [...document.querySelectorAll('.modal-overlay:not(.hidden)')];
    if (open.length) closeModal(open[open.length - 1].id);
}

// ── Progress ──────────────────────────────────────────────────
const STAGES = ['Fetching famous places…', 'Loading place images…', 'Building smart itinerary…', 'Rendering map & results…'];

function showProgress() { openModal('progress-overlay'); setProgress(0, STAGES[0]); }

function setProgress(step, label) {
    const pct = Math.round((step / STAGES.length) * 100);
    const fill = document.getElementById('progress-bar-fill');
    if (fill) { fill.style.width = pct + '%'; fill.parentElement?.setAttribute('aria-valuenow', String(pct)); }
    document.getElementById('progress-pct').textContent = pct + '%';
    document.getElementById('progress-label').textContent = label;
    document.getElementById('progress-step').textContent = `Step ${step + 1} of ${STAGES.length}`;
    document.querySelectorAll('.stage-dot').forEach((dot, idx) => {
        dot.classList.toggle('done', idx < step);
        dot.classList.toggle('active', idx === step);
        dot.classList.toggle('pending', idx > step);
    });
}

function hideProgress() {
    closeModal('progress-overlay');
    setProgress(0, '');
    const badge = document.getElementById('ai-model-badge');
    if (badge) badge.style.display = 'none';
}

function showAIBadge(name) {
    const b = document.getElementById('ai-model-badge');
    if (b) { b.textContent = `🤖 ${name}`; b.style.display = 'block'; }
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    // Cap the stack so a burst of provider-switch messages can't bury the page.
    while (container.children.length >= 4) container.firstElementChild.remove();

    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.setAttribute('role', type === 'error' ? 'alert' : 'status');
    t.textContent = msg;
    container.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 3800);
}

// ── Empty State ───────────────────────────────────────────────
function showEmptyState(containerId, icon, title, subtitle, retryFn = null) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `
        <div class="empty-state">
            <div class="empty-state-icon">${esc(icon)}</div>
            <div class="empty-state-title">${esc(title)}</div>
            <div class="empty-state-sub">${esc(subtitle)}</div>
            ${retryFn ? `<button class="btn btn-primary btn-sm" id="empty-state-retry" type="button">🔄 Try Again</button>` : ''}
        </div>`;
    if (retryFn) document.getElementById('empty-state-retry')?.addEventListener('click', retryFn);
}

// ── Theme ─────────────────────────────────────────────────────
let currentTheme = localStorage.getItem('atp_theme') || 'dark';

function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('theme-btn');
    if (btn) {
        btn.textContent = theme === 'dark' ? '🌙' : '☀️';
        btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0a0a14' : '#f0f4ff');
    localStorage.setItem('atp_theme', theme);
    setMapTheme(theme);
}

const toggleTheme = () => applyTheme(currentTheme === 'dark' ? 'light' : 'dark');

// ── Location Autocomplete ─────────────────────────────────────
let _activeSuggestion = -1;
let _suggestions = [];

async function fetchSuggestions(query) {
    if (!query || query.length < 2) return [];
    try {
        // Photon (OpenStreetMap-based) — no key, CORS-friendly.
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6&lang=en`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        const seen = new Set();
        return (data.features || [])
            .map(f => {
                const p = f.properties || {};
                const city = p.city || p.name || p.county || '';
                const label = [city, p.state, p.country].filter(Boolean).join(', ');
                return { label, name: city || label };
            })
            .filter(({ label, name }) => {
                if (!name || seen.has(label)) return false;
                seen.add(label);
                return true;
            });
    } catch { return []; }
}

function showSuggestions(suggestions) {
    const list = document.getElementById('location-suggestions');
    const input = document.getElementById('location-input');
    if (!list) return;
    _suggestions = suggestions;
    _activeSuggestion = -1;
    list.innerHTML = '';

    if (!suggestions.length) { hideSuggestions(); return; }

    suggestions.forEach(({ label, name }, idx) => {
        const li = document.createElement('li');
        li.className = 'location-suggestion-item';
        li.id = `location-suggestion-${idx}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.textContent = label;
        // mousedown fires before blur, avoiding the hide-before-click race.
        li.addEventListener('mousedown', e => { e.preventDefault(); addLocation(name); });
        list.appendChild(li);
    });
    list.classList.remove('hidden');
    input?.setAttribute('aria-expanded', 'true');
}

function hideSuggestions() {
    const list = document.getElementById('location-suggestions');
    list?.classList.add('hidden');
    if (list) list.innerHTML = '';
    document.getElementById('location-input')?.setAttribute('aria-expanded', 'false');
    document.getElementById('location-input')?.removeAttribute('aria-activedescendant');
    _suggestions = [];
    _activeSuggestion = -1;
}

function moveSuggestion(delta) {
    if (!_suggestions.length) return;
    const items = [...document.querySelectorAll('.location-suggestion-item')];
    _activeSuggestion = (_activeSuggestion + delta + items.length) % items.length;
    items.forEach((li, i) => {
        const active = i === _activeSuggestion;
        li.classList.toggle('active', active);
        li.setAttribute('aria-selected', String(active));
        if (active) {
            li.scrollIntoView({ block: 'nearest' });
            document.getElementById('location-input')?.setAttribute('aria-activedescendant', li.id);
        }
    });
}

// ── Locations ─────────────────────────────────────────────────
function addLocation(val) {
    const v = String(val || '').trim().slice(0, 80);
    if (!v) return;
    if (state.locations.some(l => l.toLowerCase() === v.toLowerCase())) {
        showToast(`"${v}" is already added`, 'info');
        hideSuggestions();
        return;
    }
    if (state.locations.length >= MAX_LOCATIONS) {
        showToast(`Up to ${MAX_LOCATIONS} destinations per trip`, 'error');
        return;
    }
    state.locations.push(v);
    renderChips();
    const inp = document.getElementById('location-input');
    if (inp) { inp.value = ''; inp.focus(); }
    hideSuggestions();
}

function renderChips() {
    const chipBox = document.getElementById('chip-box');
    if (!chipBox) return;
    chipBox.innerHTML = state.locations.map((loc, idx) => `
        <div class="chip">
            <span>${esc(loc)}</span>
            <button class="chip-remove" type="button" data-idx="${idx}"
                    aria-label="Remove ${esc(loc)}">×</button>
        </div>`).join('');
    chipBox.querySelectorAll('.chip-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            state.locations.splice(Number(btn.dataset.idx), 1);
            renderChips();
        });
    });
}

// ── Image fallbacks ───────────────────────────────────────────
// A labelled placeholder, never a random stock photo: showing an unrelated
// image next to "Red Fort" is worse than showing no image at all.
const fallbackImg = name => svgPlaceholder(name);

// Broken remote images swap to a generated SVG. Delegated in the capture phase
// because `error` does not bubble — this replaces the old inline onerror="…",
// which required an unsafe-inline CSP.
document.addEventListener('error', e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.fbApplied) return;
    img.dataset.fbApplied = '1';
    img.src = svgPlaceholder(img.dataset.placeName || img.alt || 'Place');
}, true);

// Loose place-name similarity — strips punctuation, checks word overlap
function placesAreSimilar(a, b) {
    const normalize = str => String(str).toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\b(the|a|an|of|and|mall|centre|center|complex|park|garden|fort|temple|masjid|mandir|market|bazar|bazaar|chowk)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const na = normalize(a), nb = normalize(b);
    if (na === nb) return true;

    const tokA = na.split(' ').filter(Boolean);
    const tokB = nb.split(' ').filter(Boolean);
    const [shorter, longer] = tokA.length <= tokB.length ? [tokA, tokB] : [tokB, tokA];
    if (!shorter.length) return false;
    return shorter.filter(t => longer.includes(t)).length / shorter.length >= 0.6;
}

// ── Preferences ───────────────────────────────────────────────
function loadPrefs() {
    try {
        const saved = JSON.parse(localStorage.getItem('atp_prefs') || '{}');
        state.prefs = { ...state.prefs, ...saved };
        if (!Array.isArray(state.prefs.interests)) state.prefs.interests = [];
    } catch { /* ignore corrupt prefs */ }
}

function savePrefs() {
    try { localStorage.setItem('atp_prefs', JSON.stringify(state.prefs)); } catch { /* ignore */ }
}

const PREF_FIELDS = [
    ['pref-pace', 'pace', v => v],
    ['pref-start-time', 'startTime', v => v],
    ['pref-budget', 'budget', v => v],
    ['pref-travellers', 'travellers', v => Math.max(1, Math.min(20, Number(v) || 1))],
    ['pref-kids', 'withKids', v => v],
    ['pref-accessibility', 'accessibility', v => v],
    ['pref-avoid', 'avoid', v => String(v).slice(0, 200)],
    ['pref-transport', 'transport', v => (TRANSPORT_MODES[v] ? v : DEFAULT_MODE)],
    ['pref-currency', 'currency', v => (CURRENCIES[v] ? v : DEFAULT_CURRENCY)],
];

const money = amount => formatMoney(amount, state.prefs.currency);

/** Bind the preference controls once. Values are pushed by syncPreferencesUI(). */
function initPreferencesUI() {
    const currencySelect = document.getElementById('pref-currency');
    if (currencySelect && !currencySelect.options.length) {
        currencySelect.innerHTML = Object.entries(CURRENCIES)
            .map(([code, c]) => `<option value="${esc(code)}">${esc(c.label)}</option>`).join('');
    }

    const wrap = document.getElementById('interest-chips');
    if (wrap) {
        wrap.addEventListener('click', e => {
            const btn = e.target.closest('.interest-chip');
            if (!btn) return;
            const value = btn.dataset.interest;
            const idx = state.prefs.interests.indexOf(value);
            const on = idx === -1;
            if (on) state.prefs.interests.push(value); else state.prefs.interests.splice(idx, 1);
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-pressed', String(on));
            savePrefs();
        });
    }

    PREF_FIELDS.forEach(([id, key, transform]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', () => {
            state.prefs[key] = transform(el.type === 'checkbox' ? el.checked : el.value);
            savePrefs();
        });
    });

    setupDisclosure('prefs-toggle', 'prefs-body');
    setupDisclosure('home-custom-toggle', 'home-custom-body');
    syncPreferencesUI();
}

/** Push state.prefs into the form controls (also used after loading a share link). */
function syncPreferencesUI() {
    const wrap = document.getElementById('interest-chips');
    if (wrap) {
        wrap.innerHTML = INTEREST_OPTIONS.map(i => {
            const on = state.prefs.interests.includes(i);
            return `<button type="button" class="interest-chip${on ? ' active' : ''}"
                    data-interest="${esc(i)}" aria-pressed="${on}">${esc(i)}</button>`;
        }).join('');
    }
    PREF_FIELDS.forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = Boolean(state.prefs[key]);
        else el.value = state.prefs[key];
    });
}

function setupDisclosure(toggleId, bodyId) {
    const toggle = document.getElementById(toggleId);
    const body = document.getElementById(bodyId);
    if (!toggle || !body) return;
    toggle.addEventListener('click', () => {
        const open = body.classList.toggle('hidden');
        toggle.setAttribute('aria-expanded', String(!open));
    });
    body.classList.add('hidden');
    toggle.setAttribute('aria-expanded', 'false');
}

// ── Date inputs ───────────────────────────────────────────────
function initDateInputs() {
    const startEl = document.getElementById('start-date');
    const endEl = document.getElementById('end-date');
    const today = todayLocal();

    // valueAsDate interprets the value as UTC and shifts the day for anyone not
    // on GMT — set the string directly instead.
    startEl.value = ymd(today);
    endEl.value = ymd(addDays(today, 3));
    startEl.min = ymd(today);
    endEl.min = ymd(today);

    startEl.addEventListener('change', () => {
        if (!startEl.value) return;
        endEl.min = startEl.value;
        if (!endEl.value || parseYMD(endEl.value) < parseYMD(startEl.value)) {
            endEl.value = ymd(addDays(startEl.value, 3));
        }
        updateTripLengthHint();
    });
    endEl.addEventListener('change', updateTripLengthHint);
    updateTripLengthHint();
}

function tripDayCount() {
    const sd = document.getElementById('start-date')?.value;
    const ed = document.getElementById('end-date')?.value;
    if (!sd || !ed) return 0;
    return diffDays(sd, ed) + 1;
}

function updateTripLengthHint() {
    const hint = document.getElementById('trip-length-hint');
    if (!hint) return;
    const days = tripDayCount();
    if (days <= 0) { hint.textContent = ''; return; }
    hint.textContent = days > MAX_TRIP_DAYS
        ? `⚠️ ${days} days — trips are capped at ${MAX_TRIP_DAYS} days`
        : `${days} day${days === 1 ? '' : 's'}`;
    hint.classList.toggle('warn', days > MAX_TRIP_DAYS);
}

// ── Input Screen Init ─────────────────────────────────────────
function initInputScreen() {
    const input = document.getElementById('location-input');

    const runSuggest = debounce(async q => {
        const suggestions = await fetchSuggestions(q);
        if (document.getElementById('location-input')?.value.trim() === q) showSuggestions(suggestions);
    }, 350);

    input.addEventListener('input', () => {
        const q = input.value.trim();
        if (q.length < 2) { runSuggest.cancel(); hideSuggestions(); return; }
        runSuggest(q);
    });

    input.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggestion(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggestion(-1); return; }
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            if (_activeSuggestion >= 0 && _suggestions[_activeSuggestion]) {
                addLocation(_suggestions[_activeSuggestion].name);
            } else {
                const v = input.value.replace(',', '').trim();
                if (v) addLocation(v);
            }
            return;
        }
        if (e.key === 'Escape') hideSuggestions();
    });

    input.addEventListener('blur', () => setTimeout(hideSuggestions, 150));
    document.getElementById('add-location-btn').addEventListener('click', () => addLocation(input.value));

    initDateInputs();
    initPreferencesUI();

    let planning = false;
    const planBtn = document.getElementById('plan-btn');
    planBtn.addEventListener('click', async () => {
        if (planning) return;
        planning = true;
        planBtn.disabled = true;
        planBtn.textContent = '⏳ Planning…';
        try { await startPlanning(); }
        finally {
            planning = false;
            planBtn.disabled = false;
            planBtn.textContent = '✈️ Plan My Trip';
        }
    });
}

// ── Static bindings (bound once — no node cloning) ────────────
function initGlobalBindings() {
    const on = (id, event, fn) => document.getElementById(id)?.addEventListener(event, fn);

    on('home-logo', 'click', () => showScreen('screen-input'));
    on('home-logo', 'keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showScreen('screen-input'); } });
    on('theme-btn', 'click', toggleTheme);

    // My Trips
    on('mytrips-btn', 'click', openMyTrips);
    on('mytrips-close', 'click', () => closeModal('mytrips-modal'));
    on('mytrips-clear', 'click', () => {
        const count = readSavedTrips().length;
        if (!count) { showToast('No saved trips to clear', 'info'); return; }
        if (!confirm(`Delete all ${count} saved trip${count === 1 ? '' : 's'}? This cannot be undone.`)) return;
        localStorage.removeItem('atp_saved_trips');
        renderMyTripsList();
        showToast('All saved trips cleared', 'info');
    });

    // Place detail modal
    on('place-modal-close', 'click', () => closeModal('place-modal'));

    // Custom paste modal
    on('paste-modal-close', 'click', closeCustomPaste);
    on('paste-cancel-btn', 'click', closeCustomPaste);
    on('paste-apply-btn', 'click', applyCustomPaste);

    // Any overlay: click the backdrop to dismiss
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay.id); });
    });

    // Discovery screen
    on('back-to-input', 'click', () => showScreen('screen-input'));
    on('generate-btn', 'click', handleGenerateClick);
    on('nearby-search-btn', 'click', doNearbySearch);
    on('nearby-input', 'keydown', e => { if (e.key === 'Enter') doNearbySearch(); });
    on('custom-paste-btn', 'click', openCustomPaste);
    on('auto-toggle', 'change', e => setAutoMode(e.target.checked, { fromUser: true }));
    on('selected-only-toggle', 'click', () => {
        state.filter.selectedOnly = !state.filter.selectedOnly;
        const btn = document.getElementById('selected-only-toggle');
        btn.classList.toggle('active', state.filter.selectedOnly);
        btn.setAttribute('aria-pressed', String(state.filter.selectedOnly));
        applyCardFilter();
    });
    on('clear-selection-btn', 'click', () => {
        state.selectedPlaces = [];
        document.querySelectorAll('.place-card.selected').forEach(c => {
            c.classList.remove('selected');
            c.setAttribute('aria-pressed', 'false');
        });
        setAutoMode(true);
        updateSelectionCount();
        applyCardFilter();
    });

    // Itinerary screen
    on('back-to-discovery', 'click', () => showScreen('screen-discovery'));
    on('new-trip-btn', 'click', () => {
        state.itinerary = null;
        state.selectedPlaces = [];
        state.places = [];
        showScreen('screen-input');
    });
    on('save-trip-btn', 'click', saveCurrentTrip);
    on('share-trip-btn', 'click', shareTrip);
    on('map-reset-focus', 'click', resetFocus);

    // Budget / packing / local info
    on('budget-badge', 'click', openBudgetModal);
    on('budget-close', 'click', () => closeModal('budget-modal'));
    on('packing-btn', 'click', () => openPackingModal());
    on('packing-close', 'click', () => closeModal('packing-modal'));
    on('packing-regen', 'click', () => openPackingModal(true));
    on('packing-copy', 'click', async () => {
        try {
            await navigator.clipboard.writeText(packingListText());
            showToast('Packing list copied 📋', 'success');
        } catch { showToast('Could not copy', 'error'); }
    });
    on('info-btn', 'click', openInfoModal);
    on('info-close', 'click', () => closeModal('info-modal'));
    on('place-actions-close', 'click', () => closeModal('place-actions-modal'));

    // Changing transport or currency re-costs the trip without a new AI call
    on('pref-transport', 'change', () => { if (state.itinerary) refreshAfterEdit(); });
    on('pref-currency', 'change', () => { if (state.itinerary) renderItineraryScreen(); });
    on('pref-travellers', 'change', () => { if (state.itinerary) refreshAfterEdit({ replot: false }); });
    on('copy-btn', 'click', async () => {
        try {
            await copyToClipboard(state.itinerary, state.locations, state.startDate, state.endDate);
            showToast('Copied to clipboard! 📋', 'success');
        } catch { showToast('Could not copy — try the Text download instead', 'error'); }
    });
    on('download-txt-btn', 'click', () => downloadAsText(state.itinerary, state.locations, state.startDate, state.endDate));
    on('download-ics-btn', 'click', () => {
        downloadAsCalendar(state.itinerary, state.locations, state.startDate);
        showToast('Calendar file downloaded — import it into Google/Apple Calendar 📅', 'success');
    });
    on('print-btn', 'click', () => window.print());
    on('download-pdf-btn', 'click', async () => {
        const btn = document.getElementById('download-pdf-btn');
        btn.disabled = true;
        const label = btn.textContent;
        btn.textContent = '⏳ Building…';
        try {
            await downloadAsPDF(state.itinerary, state.locations, state.startDate, state.endDate, state.imageCache);
        } catch (err) {
            showToast('PDF failed: ' + err.message, 'error');
        } finally { btn.disabled = false; btn.textContent = label; }
    });

    // Map popup → place modal
    window.addEventListener('map-place-detail', e => {
        const { dayIdx, placeIdx } = e.detail || {};
        const place = state.itinerary?.days?.[dayIdx]?.places?.[placeIdx];
        if (place) openPlaceModal(place);
    });

    // Delegated commute toggle — handles dynamically rendered rows
    document.addEventListener('click', e => {
        const btn = e.target.closest('[data-commute-toggle]');
        if (!btn) return;
        const collapsible = btn.closest('[data-commute-collapsible]');
        if (!collapsible) return;
        btn.setAttribute('aria-expanded', String(collapsible.classList.toggle('open')));
    });

    // Global keyboard shortcuts
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { closeTopModal(); return; }
        if (!(e.ctrlKey || e.metaKey)) return;
        const onItinerary = document.getElementById('screen-itinerary')?.classList.contains('active');
        if (!onItinerary) return;
        const key = e.key.toLowerCase();
        if (key === 's') { e.preventDefault(); document.getElementById('save-trip-btn')?.click(); }
        if (key === 'd') { e.preventDefault(); document.getElementById('download-pdf-btn')?.click(); }
    });

    // Re-flow the card grids when the viewport changes column count
    window.addEventListener('resize', debounce(() => {
        const { cols } = getSymmetricCounts();
        document.querySelectorAll('.place-card-grid').forEach(g => g.style.setProperty('--card-cols', cols));
        refreshMapSize();
    }, 200));
}

// ── Planning Flow ─────────────────────────────────────────────
function readCustomNames() {
    const ta = document.getElementById('home-custom-places');
    if (!ta || !ta.value.trim()) return [];
    return [...new Set(ta.value.split(/[,\n]+/).map(s => s.trim()).filter(Boolean))].slice(0, 40);
}

async function startPlanning() {
    if (!requireAI()) return;
    if (state.locations.length === 0) {
        const typed = document.getElementById('location-input')?.value.trim();
        if (typed) addLocation(typed);
        if (state.locations.length === 0) { showToast('Add at least one destination 📍', 'error'); return; }
    }

    const sd = document.getElementById('start-date').value;
    const ed = document.getElementById('end-date').value;
    if (!sd || !ed) { showToast('Please set your trip dates 📅', 'error'); return; }
    if (parseYMD(ed) < parseYMD(sd)) { showToast('End date must be on or after the start date 📅', 'error'); return; }
    const days = diffDays(sd, ed) + 1;
    if (days > MAX_TRIP_DAYS) { showToast(`Trips are capped at ${MAX_TRIP_DAYS} days — shorten your dates`, 'error'); return; }

    state.startDate = sd;
    state.endDate = ed;
    _autoFilled.clear();   // a fresh plan may need to top up the same city again

    showProgress();
    const onSwitch = name => showAIBadge(name);

    try {
        setProgress(0, STAGES[0]);
        const customNames = readCustomNames();

        const placesCacheKey = cacheKey('places', state.locations.join(','));
        let famousPlaces = cacheGet(placesCacheKey);
        if (!famousPlaces?.length) {
            famousPlaces = await fetchFamousPlaces(state.config, state.locations, onSwitch);
            cacheSet(placesCacheKey, famousPlaces);
        }
        if (!famousPlaces.length) throw new Error('No places came back for those destinations. Try a different spelling.');

        // Enrich user-supplied place names with AI descriptions
        const customPlaceObjects = [];
        if (customNames.length) {
            const enrichKey = cacheKey('enrich', customNames.join(','), state.locations.join(','));
            let enriched = cacheGet(enrichKey);
            if (!enriched) {
                try {
                    enriched = await enrichCustomPlaces(state.config, customNames, state.locations[0] || '', onSwitch);
                    cacheSet(enrichKey, enriched);
                } catch {
                    enriched = customNames.map(name => ({
                        name, location: state.locations[0] || '',
                        shortDesc: 'A must-visit place on your itinerary.', category: 'Heritage',
                    }));
                }
            }
            customNames.forEach(name => {
                const data = enriched.find(e => e.name.toLowerCase() === name.toLowerCase()) || {};
                const existing = famousPlaces.find(p => p.name.toLowerCase() === name.toLowerCase());
                if (existing) {
                    if (!existing.shortDesc && data.shortDesc) existing.shortDesc = data.shortDesc;
                    customPlaceObjects.push(existing);
                } else {
                    customPlaceObjects.push({
                        name: data.name || name,
                        location: data.location || state.locations[0] || '',
                        shortDesc: data.shortDesc || 'A must-visit place on your itinerary.',
                        category: data.category || 'Heritage',
                    });
                }
            });
        }

        // Custom places pinned first, fuzzy-deduped against the AI list
        const remainingFamous = famousPlaces.filter(f => !customPlaceObjects.some(c => placesAreSimilar(c.name, f.name)));
        state.places = [...customPlaceObjects, ...remainingFamous];
        state.selectedPlaces = [...customPlaceObjects];
        setAutoMode(customPlaceObjects.length === 0);

        setProgress(1, STAGES[1]);
        const missing = state.places
            .filter(p => !state.imageCache[p.name])
            .map(p => ({ name: p.name, location: p.location || state.locations[0] || '' }));
        if (missing.length) {
            Object.assign(state.imageCache, await fetchPlaceImages(missing, state.config.unsplashKey, state.caps));
        }

        hideProgress();
        state.filter = { category: 'all', selectedOnly: false };
        renderDiscoveryScreen();
        showScreen('screen-discovery');
    } catch (err) {
        hideProgress();
        showToast(err.message || 'Something went wrong', 'error');
        console.error(err);
    }
}

// Optimal initial fetch count and load-more count based on viewport columns
function getSymmetricCounts() {
    const vw = window.innerWidth;
    let cols;
    if (vw <= 480) cols = 2;
    else if (vw <= 640) cols = 3;
    else if (vw <= 800) cols = 4;
    else if (vw <= 1000) cols = 5;
    else if (vw <= 1200) cols = 6;
    else cols = 7;
    return { cols, initialCount: cols * 2, loadMoreCount: cols };
}

function showGridSpinner(targetElement, label = 'Loading places…') {
    hideGridSpinner(targetElement);
    const spinner = document.createElement('div');
    spinner.className = 'grid-spinner';
    spinner.setAttribute('role', 'status');
    spinner.innerHTML = `<span class="spinner-ring" aria-hidden="true"></span> ${esc(label)}`;
    targetElement?.appendChild(spinner);
}

function hideGridSpinner(targetElement) {
    targetElement?.querySelector('.grid-spinner')?.remove();
}

// ── Discovery Screen ──────────────────────────────────────────
const _autoFilled = new Set();   // locations already topped up, so re-renders don't refetch

/**
 * @param {{allowAutoFill?: boolean}} opts  Restoring a saved trip re-renders the
 *   grid from stored places only — it must not fire AI calls to top up rows.
 */
function renderDiscoveryScreen({ allowAutoFill = true } = {}) {
    const grid = document.getElementById('discovery-grid');
    grid.innerHTML = '';

    const { cols, initialCount, loadMoreCount } = getSymmetricCounts();

    state.locations.forEach(loc => {
        const locPlaces = state.places.filter(p =>
            p.location?.toLowerCase() === loc.toLowerCase() ||
            p.location?.toLowerCase().includes(loc.toLowerCase()));

        const section = document.createElement('section');
        section.className = 'discovery-section';
        section.dataset.location = loc;
        section.innerHTML = `<h3 class="section-title">📍 ${esc(loc)}</h3>`;

        const cardRow = document.createElement('div');
        cardRow.className = 'place-card-grid';
        cardRow.style.setProperty('--card-cols', cols);
        section.appendChild(cardRow);

        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.type = 'button';
        loadMoreBtn.className = 'load-more-btn';
        loadMoreBtn.textContent = `⬇️ Load More Places in ${loc}`;
        section.appendChild(loadMoreBtn);
        grid.appendChild(section);

        // Fuzzy-dedupe within the section
        const seen = [];
        const deduped = locPlaces.filter(place => {
            if (seen.some(s => placesAreSimilar(s, place.name))) return false;
            seen.push(place.name);
            return true;
        });

        // Selected places float to the top
        const isSelected = p => state.selectedPlaces.some(s => s.name === p.name);
        const ordered = [...deduped.filter(isSelected), ...deduped.filter(p => !isSelected(p))];

        const hiddenPlaces = ordered.slice(initialCount);
        let renderedCount = 0;
        ordered.slice(0, initialCount).forEach(place => { renderPlaceCard(place, cardRow); renderedCount++; });

        const addCards = places => {
            cardRow.querySelector('.grid-note')?.remove();
            places.forEach(place => { renderPlaceCard(place, cardRow); renderedCount++; });
        };

        // Top up a short first screen so the grid isn't a ragged half-row
        async function autoFill() {
            if (_autoFilled.has(loc)) return;
            _autoFilled.add(loc);
            showGridSpinner(cardRow);
            let guard = 0;
            while (renderedCount < initialCount && guard++ < 3) {
                const needed = initialCount - renderedCount;
                const existingNames = state.places
                    .filter(p => p.location?.toLowerCase().includes(loc.toLowerCase()))
                    .map(p => p.name);
                try {
                    const more = await fetchMorePlaces(state.config, loc, existingNames, showAIBadge, needed);
                    const fresh = more.filter(m => !state.places.some(p => placesAreSimilar(p.name, m.name)));
                    if (!fresh.length) break;
                    state.places.push(...fresh);
                    await ensureImages(fresh, loc);
                    hideGridSpinner(cardRow);
                    addCards(fresh);
                    if (fresh.length < needed) break;
                    showGridSpinner(cardRow);
                } catch { break; }
            }
            hideGridSpinner(cardRow);
            renderCategoryFilter();
            applyCardFilter();
        }

        if (renderedCount === 0) {
            cardRow.innerHTML = `<p class="grid-note">No places found for “${esc(loc)}” yet.</p>`;
        }
        if (allowAutoFill && renderedCount < initialCount && canUseAI()) autoFill();

        loadMoreBtn.addEventListener('click', async () => {
            if (!hiddenPlaces.length && !requireAI()) return;
            loadMoreBtn.disabled = true;
            const original = `⬇️ Load More Places in ${loc}`;
            loadMoreBtn.textContent = '⏳ Loading…';

            try {
                // Reveal from the local buffer first, only then ask the model.
                const fromCache = hiddenPlaces.splice(0, loadMoreCount);
                if (fromCache.length) {
                    await ensureImages(fromCache, loc);
                    addCards(fromCache);
                }
                const stillNeeded = loadMoreCount - fromCache.length;
                if (stillNeeded > 0 && canUseAI()) {
                    showGridSpinner(cardRow);
                    const existingNames = state.places
                        .filter(p => p.location?.toLowerCase().includes(loc.toLowerCase()))
                        .map(p => p.name);
                    const more = await fetchMorePlaces(state.config, loc, existingNames, showAIBadge, stillNeeded);
                    const fresh = more.filter(m => !state.places.some(p => placesAreSimilar(p.name, m.name)));
                    hideGridSpinner(cardRow);
                    if (fresh.length) {
                        state.places.push(...fresh);
                        await ensureImages(fresh, loc);
                        addCards(fresh);
                        showToast(`Added ${fresh.length} more place${fresh.length === 1 ? '' : 's'} in ${loc}`, 'success');
                    } else {
                        showToast(`No new places found in ${loc}`, 'info');
                    }
                }
                renderCategoryFilter();
                applyCardFilter();
            } catch (err) {
                showToast('Failed to load more: ' + err.message, 'error');
            } finally {
                hideGridSpinner(cardRow);
                loadMoreBtn.textContent = original;
                loadMoreBtn.disabled = false;
            }
        });
    });

    // Sync auto-mode toggle
    const autoToggle = document.getElementById('auto-toggle');
    if (autoToggle) autoToggle.checked = state.autoMode;
    grid.classList.toggle('auto-mode', state.autoMode);

    renderCategoryFilter();
    applyCardFilter();
    updateSelectionCount();
}

async function ensureImages(places, locFallback) {
    const missing = places
        .filter(p => !state.imageCache[p.name])
        .map(p => ({ name: p.name, location: p.location || locFallback || '' }));
    if (!missing.length) return;
    Object.assign(state.imageCache, await fetchPlaceImages(missing, state.config.unsplashKey, state.caps));
}

function renderPlaceCard(place, container) {
    const imgUrl = safeUrl(state.imageCache[place.name]) || fallbackImg(place.name);
    const selected = state.selectedPlaces.some(p => p.name === place.name);

    const card = document.createElement('div');
    card.className = 'place-card' + (selected ? ' selected' : '');
    card.dataset.name = place.name;
    card.dataset.category = place.category || '';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-pressed', String(selected));
    card.setAttribute('aria-label', `${place.name}${place.category ? ', ' + place.category : ''}`);
    card.innerHTML = `
      <div class="place-img-wrap">
        <img src="${esc(imgUrl)}" alt="" data-place-name="${esc(place.name)}" loading="lazy" decoding="async">
        <div class="card-check" aria-hidden="true">✓</div>
        ${place.category ? `<div class="category-badge">${esc(place.category)}</div>` : ''}
        <button class="card-detail-btn" type="button" aria-label="View details for ${esc(place.name)}">⤢</button>
      </div>
      <div class="card-body">
        <div class="card-name">${esc(place.name)}</div>
        <div class="card-desc">${esc(place.shortDesc || (place.desc || '').slice(0, 80))}</div>
      </div>`;

    const toggle = () => togglePlaceSelection(card, place);
    card.addEventListener('click', e => { if (!e.target.closest('.card-detail-btn')) toggle(); });
    card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    card.querySelector('.card-detail-btn').addEventListener('click', e => {
        e.stopPropagation();
        openPlaceModal(place);
    });

    container.appendChild(card);
}

// ── Category filter ───────────────────────────────────────────
function renderCategoryFilter() {
    const wrap = document.getElementById('category-filter');
    if (!wrap) return;

    // Derive from the cards actually on screen. Using state.places would offer
    // categories whose cards are still behind "Load more", so picking one would
    // filter everything away.
    const categories = [...new Set(
        [...document.querySelectorAll('#discovery-grid .place-card')]
            .map(c => c.dataset.category).filter(Boolean)
    )].sort();

    // A filter that is no longer available shouldn't stay stuck on.
    if (state.filter.category !== 'all' && !categories.includes(state.filter.category)) {
        state.filter.category = 'all';
    }
    if (categories.length < 2) { wrap.innerHTML = ''; wrap.classList.add('hidden'); return; }

    wrap.classList.remove('hidden');
    const all = ['all', ...categories];
    wrap.innerHTML = all.map(c => `
        <button type="button" class="filter-chip${state.filter.category === c ? ' active' : ''}"
                data-category="${esc(c)}" aria-pressed="${state.filter.category === c}">
            ${c === 'all' ? 'All' : esc(c)}
        </button>`).join('');

    wrap.querySelectorAll('.filter-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            state.filter.category = btn.dataset.category;
            wrap.querySelectorAll('.filter-chip').forEach(b => {
                const on = b === btn;
                b.classList.toggle('active', on);
                b.setAttribute('aria-pressed', String(on));
            });
            applyCardFilter();
        });
    });
}

function applyCardFilter() {
    const { category, selectedOnly } = state.filter;
    document.querySelectorAll('#discovery-grid .place-card').forEach(card => {
        const matchCat = category === 'all' || card.dataset.category === category;
        const matchSel = !selectedOnly || card.classList.contains('selected');
        card.classList.toggle('filtered-out', !(matchCat && matchSel));
    });
    // Hide any location section left with nothing visible
    document.querySelectorAll('.discovery-section').forEach(section => {
        const visible = section.querySelectorAll('.place-card:not(.filtered-out)').length;
        section.classList.toggle('section-empty', visible === 0 && (category !== 'all' || selectedOnly));
    });
}

// ── Nearby search ─────────────────────────────────────────────
async function doNearbySearch() {
    const inputEl = document.getElementById('nearby-input');
    const query = inputEl?.value?.trim();
    if (!query) { showToast('Enter a place to search', 'info'); return; }
    if (!requireAI()) return;

    const { cols } = getSymmetricCounts();
    const resultsDiv = document.getElementById('nearby-results');
    const searchBtn = document.getElementById('nearby-search-btn');
    resultsDiv.style.setProperty('--card-cols', cols);
    resultsDiv.innerHTML = '';
    showGridSpinner(resultsDiv, 'Searching…');
    searchBtn.disabled = true;

    const locContext = state.locations.join(', ');
    const fullQuery = locContext ? `${query} near ${locContext}` : query;

    try {
        const results = await searchNearbyPlaces(state.config, fullQuery, showAIBadge);
        hideGridSpinner(resultsDiv);

        if (!results.length) {
            resultsDiv.innerHTML = `<p class="grid-note">No results for “${esc(query)}”.</p>`;
            return;
        }

        const fresh = results.filter(r => !state.places.some(p => placesAreSimilar(p.name, r.name)));
        state.places.push(...fresh);

        const toShow = results.slice(0, cols);
        await ensureImages(toShow, locContext);
        resultsDiv.innerHTML = '';
        toShow.forEach(place => renderPlaceCard(place, resultsDiv));

        // Warm the remaining thumbnails in the background for the next render
        const rest = results.slice(cols);
        if (rest.length) ensureImages(rest, locContext).catch(() => { });

        renderCategoryFilter();
        showToast(`Found ${results.length} place${results.length === 1 ? '' : 's'} near “${query}”`, 'success');
    } catch (err) {
        hideGridSpinner(resultsDiv);
        resultsDiv.innerHTML = '';
        showToast('Search failed: ' + err.message, 'error');
    } finally {
        searchBtn.disabled = false;
    }
}

// ── Selection ─────────────────────────────────────────────────
function setAutoMode(on, { fromUser = false } = {}) {
    state.autoMode = Boolean(on);
    const toggle = document.getElementById('auto-toggle');
    if (toggle) toggle.checked = state.autoMode;
    document.getElementById('discovery-grid')?.classList.toggle('auto-mode', state.autoMode);

    if (state.autoMode && fromUser && state.selectedPlaces.length) {
        state.selectedPlaces = [];
        document.querySelectorAll('.place-card.selected').forEach(c => {
            c.classList.remove('selected');
            c.setAttribute('aria-pressed', 'false');
        });
        showToast('Auto mode on — AI will pick the places', 'info');
    }
    updateSelectionCount();
    applyCardFilter();
}

function togglePlaceSelection(card, place) {
    // Selecting a card is an explicit choice: turn auto mode off rather than
    // silently swallowing the click (the old behaviour).
    if (state.autoMode) setAutoMode(false);

    const idx = state.selectedPlaces.findIndex(p => p.name === place.name);
    const nowSelected = idx === -1;
    if (nowSelected) state.selectedPlaces.push(place);
    else state.selectedPlaces.splice(idx, 1);

    // Keep every rendered copy of this place in sync (grid + nearby results)
    document.querySelectorAll(`.place-card[data-name="${CSS.escape(place.name)}"]`).forEach(c => {
        c.classList.toggle('selected', nowSelected);
        c.setAttribute('aria-pressed', String(nowSelected));
    });

    if (!nowSelected && state.selectedPlaces.length === 0) setAutoMode(true);
    updateSelectionCount();
    if (state.filter.selectedOnly) applyCardFilter();
}

function updateSelectionCount() {
    const el = document.getElementById('selection-count');
    if (!el) return;
    const count = state.selectedPlaces.length;
    el.textContent = state.autoMode
        ? '🤖 AI will choose the best places'
        : `${count} place${count !== 1 ? 's' : ''} selected`;
    const clearBtn = document.getElementById('clear-selection-btn');
    if (clearBtn) clearBtn.classList.toggle('hidden', count === 0);
}

// ── Place Detail Modal ────────────────────────────────────────
function openPlaceModal(place) {
    const imgEl = document.getElementById('place-detail-img');
    imgEl.dataset.fbApplied = '';
    imgEl.dataset.placeName = place.name;
    imgEl.alt = place.name;
    imgEl.src = safeUrl(state.imageCache[place.name]) || fallbackImg(place.name);

    document.getElementById('place-detail-name').textContent = place.name;
    document.getElementById('place-detail-category').textContent = place.category || '';

    const metaParts = [];
    if (place.openingHours) metaParts.push('⏰ ' + place.openingHours);
    if (place.entryFee) metaParts.push('💰 ' + place.entryFee);
    if (place.bestTime) metaParts.push('🕐 Best: ' + place.bestTime);
    if (place.visitDuration) metaParts.push('⌛ ~' + place.visitDuration);
    document.getElementById('place-detail-meta').innerHTML = metaParts.map(p => `<span>${esc(p)}</span>`).join('');

    const closedEl = document.getElementById('place-detail-closed');
    if (place.closedNote) { closedEl.textContent = '⚠️ ' + place.closedNote; closedEl.style.display = 'block'; }
    else closedEl.style.display = 'none';

    document.getElementById('place-detail-desc').textContent = place.desc || place.shortDesc || '';

    // A text query beats raw coordinates for Google Maps results
    const city = place.location || state.locations[0] || '';
    const q = encodeURIComponent([place.name, city].filter(Boolean).join(' '));
    document.getElementById('place-detail-gmap').href = `https://www.google.com/maps/search/?api=1&query=${q}`;

    openModal('place-modal');
}

// ── Itinerary Generation ──────────────────────────────────────
let _generating = false;

async function handleGenerateClick() {
    if (_generating) return;
    _generating = true;
    const btn = document.getElementById('generate-btn');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '⏳ Building…';
    try { await generateItineraryFlow(); }
    finally { _generating = false; btn.disabled = false; btn.textContent = label; }
}

/** The model occasionally repeats a place across days — keep the first one. */
function dedupeItineraryPlaces(itin) {
    const seen = new Set();
    itin.days.forEach(day => {
        day.places = (day.places || []).filter(p => {
            const key = String(p?.name || '').toLowerCase().trim();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    });
    itin.days = itin.days.filter(d => d.places.length > 0);
    return itin;
}

async function generateItineraryFlow() {
    if (!requireAI()) return;
    if (!state.autoMode && state.selectedPlaces.length === 0) {
        showToast('Select at least one place, or enable Auto mode 🤖', 'error');
        return;
    }

    showProgress();
    const onSwitch = name => showAIBadge(name);
    const totalDays = diffDays(state.startDate, state.endDate) + 1;

    try {
        // ── 1. Resolve the stay so it can anchor every day ────────
        setProgress(2, 'Locating your stay…');
        await resolveStay(onSwitch);

        // ── 2. Cluster into zones — this is done in code, not by the model ──
        setProgress(2, 'Grouping places into zones…');
        const candidates = state.autoMode ? state.places : state.selectedPlaces;
        const plan = buildZonePlan(candidates, {
            startDate: state.startDate,
            totalDays,
            locations: state.locations,
            stay: state.stay,
            pace: state.prefs.pace,
            autoMode: state.autoMode,
        });
        state.zoneStats = plan.stats;

        if (!plan.days.some(d => d.places.length)) {
            hideProgress();
            state.itinerary = null;
            showEmptyState('itinerary-accordion', '📭', 'Nothing to plan',
                'No places were available for these destinations. Go back and pick some.',
                () => showScreen('screen-discovery'));
            showScreen('screen-itinerary');
            return;
        }

        // ── 3. Ask the model only to schedule and describe those zones ──
        setProgress(2, STAGES[2]);
        const itinKey = cacheKey(
            'itin2', state.locations.join(','), state.startDate, state.endDate,
            JSON.stringify(state.prefs), state.stay?.name || '',
            plan.days.map(d => d.places.map(p => p.name).join('>')).join('|')
        );

        let itin = cacheGet(itinKey);
        if (!itin) {
            itin = await scheduleZonePlan(state.config, plan, {
                locations: state.locations, prefs: state.prefs, stay: state.stay,
            }, onSwitch);
            cacheSet(itinKey, itin);
        }

        if (!itin || !Array.isArray(itin.days) || itin.days.length === 0) {
            hideProgress();
            state.itinerary = null;
            showEmptyState('itinerary-accordion', '🤖', 'AI returned an unexpected response',
                'The schedule could not be built. Try again or adjust your destinations.',
                () => generateItineraryFlow());
            showScreen('screen-itinerary');
            return;
        }

        dedupeItineraryPlaces(itin);
        state.itinerary = itin;
        state.aiProvider = getLastProvider();
        state.weatherMap = {};
        state.packingList = null;
        state.localInfo = null;

        // ── 4. Real road distances and times ──────────────────────
        setProgress(3, 'Calculating travel times…');
        await attachRoutes(itin, {
            mode: state.prefs.transport, travellers: state.prefs.travellers, stay: state.stay,
        });

        state.planIssues = validateItinerary(itin);

        // Weather is a nice-to-have — never block the render on it.
        fetchWeatherForDays(itin.days).then(weatherMap => {
            state.weatherMap = weatherMap;
            if (Object.keys(weatherMap).length) injectWeatherBadges(weatherMap);
        }).catch(() => { });

        const wanted = itin.days.flatMap(d => d.places.map(p => ({ name: p.name, location: d.location || state.locations[0] || '' })));
        const dedupedMissing = [...new Map(wanted.filter(p => !state.imageCache[p.name]).map(p => [p.name, p])).values()];
        if (dedupedMissing.length) {
            Object.assign(state.imageCache, await fetchPlaceImages(dedupedMissing, state.config.unsplashKey, state.caps));
        }

        setProgress(3, STAGES[3]);
        renderItineraryScreen();
        showScreen('screen-itinerary');
        await renderMap();
        hideProgress();
    } catch (err) {
        hideProgress();
        const slow = /timed out|502|504/i.test(err.message || '');
        showToast(slow ? 'AI is taking longer than usual. Please try again in a moment ⏳' : (err.message || 'Generation failed'), 'error');
        console.error(err);
    }
}

/** Look up the stay's coordinates once per name, so it can anchor the plan. */
async function resolveStay(onSwitch) {
    const raw = document.getElementById('stay-input')?.value.trim().slice(0, 120) || '';
    if (!raw) { state.stay = null; return; }
    if (state.stay?.name === raw) return;

    const key = cacheKey('stay', raw, state.locations[0] || '');
    let resolved = cacheGet(key);
    if (!resolved) {
        resolved = await geocodeStay(state.config, raw, state.locations[0] || '', onSwitch);
        if (resolved) cacheSet(key, resolved);
    }
    // Keep the name even if geocoding failed — the model can still use it.
    state.stay = resolved || { name: raw, lat: undefined, lng: undefined };
}

/** Recompute routes, budget, validation and re-render after an edit. */
async function refreshAfterEdit({ replot = true } = {}) {
    if (!state.itinerary) return;
    await attachRoutes(state.itinerary, {
        mode: state.prefs.transport, travellers: state.prefs.travellers, stay: state.stay,
    });
    state.planIssues = validateItinerary(state.itinerary);
    renderItineraryScreen();
    if (replot) await renderMap();
}

async function renderMap() {
    try {
        const theme = document.documentElement.getAttribute('data-theme') || 'dark';
        await initMap('map-container', theme);
        const plotted = plotItinerary(state.itinerary, state.imageCache, dayIdx => {
            expandDay(dayIdx);
            document.querySelector(`.accordion-item[data-day="${dayIdx}"]`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, state.locations, state.stay);

        const note = document.getElementById('map-note');
        if (note) {
            const total = state.itinerary.days.reduce((s, d) => s + d.places.length, 0);
            const missing = total - (plotted || 0);
            note.textContent = missing > 0 ? `${missing} of ${total} places have no coordinates and aren't pinned.` : '';
            note.classList.toggle('hidden', missing <= 0);
        }
    } catch (mapErr) {
        console.error('[Map error]', mapErr);
        const c = document.getElementById('map-container');
        if (c) {
            c.innerHTML = `<div class="map-placeholder">
                <div class="map-placeholder-icon">⚠️</div>
                <div class="map-placeholder-title">Map failed to load</div>
                <div class="map-placeholder-sub">${esc(mapErr.message)}</div>
            </div>`;
        }
    }
}

// ── Itinerary Screen ──────────────────────────────────────────
const DAY_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316', '#84CC16', '#6366F1'];

function renderItineraryScreen() {
    const itin = state.itinerary;
    const accordion = document.getElementById('itinerary-accordion');
    if (!itin) return;
    accordion.innerHTML = '';

    const totalPlaces = itin.days.reduce((s, d) => s + d.places.length, 0);
    document.getElementById('itin-summary').textContent =
        `${itin.days.length} Day${itin.days.length === 1 ? '' : 's'} · ${state.locations.join(' & ')} · ${totalPlaces} Place${totalPlaces === 1 ? '' : 's'}`;

    const providerTag = document.getElementById('ai-provider-tag');
    if (providerTag) {
        providerTag.textContent = state.aiProvider ? `🤖 ${state.aiProvider}` : '';
        providerTag.classList.toggle('hidden', !state.aiProvider);
    }

    // Budget badge opens the full breakdown
    const budget = estimateTripBudget(itin, {
        currency: state.prefs.currency, travellers: state.prefs.travellers, budget: state.prefs.budget,
    });
    const budgetEl = document.getElementById('budget-badge');
    if (budgetEl) {
        budgetEl.classList.remove('hidden');
        budgetEl.innerHTML = `💰 <strong>${esc(money(budget.total))}</strong><span class="badge-note">est. total · tap for breakdown</span>`;
        budgetEl.setAttribute('aria-label', `Estimated trip budget ${money(budget.total)}. Open breakdown.`);
    }

    // Trip-wide travel summary
    const travelEl = document.getElementById('travel-badge');
    if (travelEl) {
        const totalKm = itin.days.reduce((s, d) => s + (d.travelSummary?.km || 0), 0);
        const totalMin = itin.days.reduce((s, d) => s + (d.travelSummary?.minutes || 0), 0);
        const estimated = itin.days.some(d => d.travelSummary?.estimated);
        travelEl.classList.toggle('hidden', totalKm <= 0);
        travelEl.innerHTML = `${esc(TRANSPORT_MODES[state.prefs.transport]?.label || '')} · ${totalKm.toFixed(0)} km · ${esc(formatDuration(totalMin))}`;
        travelEl.title = estimated
            ? 'Straight-line estimate — the routing service was unavailable'
            : 'Real road distances and driving times';
    }

    renderPlanNotice();

    itin.days.forEach((day, dayIdx) => {
        const color = DAY_COLORS[dayIdx % DAY_COLORS.length];
        const item = document.createElement('div');
        item.className = 'accordion-item';
        item.dataset.day = dayIdx;

        const dayBudget = budget.perDay.find(d => d.day === day.day);
        const budgetTag = dayBudget && dayBudget.total > 0
            ? `<span class="day-cost-tag" title="Tickets ${money(dayBudget.tickets)} · Food ${money(dayBudget.food)} · Transport ${money(dayBudget.transport)}">${esc(money(dayBudget.total))}</span>` : '';
        const travel = day.travelSummary;
        const travelTag = travel && travel.km > 0
            ? `<span class="day-dist-tag" title="${travel.estimated ? 'Estimated' : 'Road'} travel between stops${travel.fare ? ` · approx ${money(travel.fare)}` : ''}">🚕 ${travel.km} km · ${esc(formatDuration(travel.minutes))}</span>` : '';
        const zoneTag = day.zoneName ? `<span class="day-zone-tag">📍 ${esc(day.zoneName)}</span>` : '';

        item.innerHTML = `
      <div class="accordion-header" role="button" tabindex="0" aria-expanded="false"
           aria-controls="day-body-${dayIdx}" style="border-left:4px solid ${color}">
        <div class="accordion-header-left">
          <div class="day-badge" style="background:${color}">Day ${esc(day.day)}</div>
          <div class="accordion-title-block">
            <div class="accordion-day-title">${esc(day.theme || 'Explore')} ${budgetTag}${travelTag}</div>
            <div class="accordion-day-meta">${esc(formatWeekdayDate(day.date))}${day.location ? ' · ' + esc(day.location) : ''} · ${day.places.length} place${day.places.length === 1 ? '' : 's'} ${zoneTag}</div>
          </div>
        </div>
        <div class="accordion-chevron" aria-hidden="true">▾</div>
      </div>
      <div class="accordion-body hidden" id="day-body-${dayIdx}">
        ${state.stay ? `<div class="day-anchor">🏨 Start from ${esc(state.stay.name)}</div>` : ''}
        ${day.places.map((p, pIdx) => renderPlaceRow(p, pIdx, color, dayIdx)).join('')}
        ${renderMeals(day)}
        ${state.stay ? `<div class="day-anchor">🏨 Back to ${esc(state.stay.name)}</div>` : ''}
        <div class="day-footer">
          <button class="btn btn-ghost btn-sm" type="button" data-replan-day="${dayIdx}">🔄 Re-plan this day</button>
          <button class="btn btn-ghost btn-sm" type="button" data-optimise-day="${dayIdx}">🧭 Optimise order</button>
        </div>
      </div>`;

        const header = item.querySelector('.accordion-header');
        const toggleDay = () => {
            const isOpen = !item.querySelector('.accordion-body').classList.contains('hidden');
            if (isOpen) collapseDay(dayIdx);
            else { expandDay(dayIdx); focusDay(dayIdx); }
        };
        header.addEventListener('click', toggleDay);
        header.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDay(); }
        });

        item.querySelectorAll('.place-row').forEach((row, pIdx) => {
            const place = day.places[pIdx];
            if (!place) return;
            row.addEventListener('click', e => {
                if (e.target.closest('.place-actions-btn') || e.target.closest('.place-gmap-link')) return;
                if (!focusPlace(dayIdx, pIdx)) showToast('No map coordinates for this place', 'info');
            });
            const imgEl = row.querySelector('.place-row-img');
            if (imgEl) imgEl.addEventListener('click', e => { e.stopPropagation(); openPlaceModal(place); });
            row.querySelector('.place-actions-btn')?.addEventListener('click', e => {
                e.stopPropagation();
                openPlaceActions(dayIdx, pIdx);
            });
        });

        item.querySelector('[data-replan-day]')?.addEventListener('click', e => {
            e.stopPropagation();
            replanDay(dayIdx);
        });
        item.querySelector('[data-optimise-day]')?.addEventListener('click', e => {
            e.stopPropagation();
            optimiseDayOrder(dayIdx);
        });

        accordion.appendChild(item);
    });

    expandDay(0);

    // Legend
    const legend = document.getElementById('day-legend');
    if (legend) {
        legend.innerHTML = '';
        itin.days.forEach((day, idx) => {
            const color = DAY_COLORS[idx % DAY_COLORS.length];
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'day-legend-item';
            el.innerHTML = `<span class="day-dot" style="background:${color}"></span><span>Day ${esc(day.day)}${day.location ? ' · ' + esc(day.location) : ''}</span>`;
            el.addEventListener('click', () => { expandDay(idx); focusDay(idx); });
            legend.appendChild(el);
        });
    }

    if (state.weatherMap && Object.keys(state.weatherMap).length) {
        injectWeatherBadges(state.weatherMap);
    }
}

/** Meal breaks the model slotted into the day. */
function renderMeals(day) {
    if (!day.meals?.length) return '';
    const icon = { breakfast: '🥐', lunch: '🍽️', dinner: '🍛' };
    return `<div class="meal-strip">
        ${day.meals.map(m => `
          <div class="meal-chip" title="${esc(m.area || '')}">
            <span class="meal-icon" aria-hidden="true">${icon[String(m.type).toLowerCase()] || '🍴'}</span>
            <span class="meal-body">
              <span class="meal-title">${esc(m.type || 'Meal')}${m.time ? ` · ${esc(m.time)}` : ''}</span>
              <span class="meal-sub">${esc(m.suggestion || '')}${m.approxCost ? ` · ${esc(m.approxCost)}` : ''}</span>
            </span>
          </div>`).join('')}
    </div>`;
}

function renderPlaceRow(place, pIdx, dayColor, dayIdx) {
    const img = safeUrl(state.imageCache[place.name]) || fallbackImg(place.name);
    const commute = place.commute_from_prev;

    let commuteHTML = '';
    if (pIdx > 0) {
        const rows = [];
        const add = (cls, label, value) => {
            if (value && value !== 'N/A') rows.push({ cls, label, value });
        };

        // Measured leg first — it's the number we actually trust.
        const travel = place.travel;
        const measured = travel
            ? `${travel.km} km · ${formatDuration(travel.minutes)}${travel.fare ? ` · ~${money(travel.fare)}` : ''}`
            : '';
        if (measured) {
            rows.push({
                cls: 'route',
                label: travel.estimated ? '📐 Estimated' : '🛣️ By road',
                value: measured,
            });
        }
        if (commute) {
            add('walk', '🚶 Walk', commute.walk);
            add('metro', '🚇 Metro', commute.metro);
            add('cab', '🚕 Cab', commute.cab);
        }

        if (rows.length) {
            commuteHTML = `
    <div class="commute-collapsible" data-commute-collapsible>
      <button class="commute-summary-btn" type="button" data-commute-toggle aria-expanded="false">
        <span class="commute-arrow" aria-hidden="true">→</span>
        <span class="commute-summary-text">${esc(measured || `Getting there · ${rows[0].value}`)}</span>
        <span class="commute-chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="commute-detail-body">
        ${rows.map(r => `<div class="commute-detail-row"><span class="commute-badge ${r.cls}">${esc(r.label)}</span><span class="commute-detail-text">${esc(r.value)}</span></div>`).join('')}
      </div>
    </div>`;
        }
    }

    const city = place.location || state.locations[0] || '';
    const gmapQ = encodeURIComponent([place.name, city].filter(Boolean).join(' '));
    const timeTag = place.arrivalTime
        ? `<span class="arrival-time-tag" style="background:${dayColor}18;color:${dayColor};border-color:${dayColor}44;">${esc(place.arrivalTime)}</span>`
        : '';
    const durationTag = place.visitDuration ? `<span class="visit-dur-tag">⌛ ~${esc(place.visitDuration)}</span>` : '';

    return `
    ${commuteHTML}
    <div class="place-row" title="Click to focus on map">
      <div class="place-row-num" style="background:${dayColor}22;color:${dayColor};">${pIdx + 1}</div>
      <img class="place-row-img" src="${esc(img)}" alt="" data-place-name="${esc(place.name)}" loading="lazy" decoding="async">
      <div class="place-row-info">
        <div class="place-row-name">${timeTag} ${esc(place.name)} ${durationTag}</div>
        ${place.openingHours || place.entryFee || place.bestTime ? `
          <div class="place-row-meta">
            ${place.openingHours ? `<span>⏰ ${esc(place.openingHours)}</span>` : ''}
            ${place.entryFee ? `<span>💰 ${esc(place.entryFee)}</span>` : ''}
            ${place.bestTime ? `<span>🌅 ${esc(place.bestTime)}</span>` : ''}
          </div>` : ''}
        ${place.closedNote ? `<div class="place-closed-note">⚠️ ${esc(place.closedNote)}</div>` : ''}
        ${place.accessibility && /not/i.test(place.accessibility) && state.prefs.accessibility
            ? `<div class="place-closed-note">♿ ${esc(place.accessibility)}</div>` : ''}
        <div class="place-row-desc">${esc(place.desc || '')}</div>
        ${place.note ? `<div class="place-note">📝 ${esc(place.note)}</div>` : ''}
      </div>
      <div class="place-row-actions">
        <a class="place-gmap-link" href="https://www.google.com/maps/search/?api=1&query=${gmapQ}"
           target="_blank" rel="noopener" title="Open in Google Maps"
           aria-label="Open ${esc(place.name)} in Google Maps">🗺️</a>
        <button class="place-actions-btn" type="button"
                title="Edit this stop" aria-label="Edit ${esc(place.name)}">⋯</button>
      </div>
    </div>`;
}

// ── Itinerary editing ─────────────────────────────────────────
function removePlaceFromDay(dayIdx, placeIdx) {
    const day = state.itinerary?.days?.[dayIdx];
    if (!day) return null;
    const [removed] = day.places.splice(placeIdx, 1);
    if (!removed) return null;

    if (day.places.length === 0) state.itinerary.days.splice(dayIdx, 1);

    if (state.itinerary.days.length === 0) {
        state.itinerary = null;
        showEmptyState('itinerary-accordion', '📭', 'Itinerary is empty',
            'You removed every place. Go back and pick some more.', () => showScreen('screen-discovery'));
        showToast(`Removed ${removed.name}`, 'info');
        return removed;
    }
    return removed;
}

function movePlaceWithinDay(dayIdx, placeIdx, delta) {
    const places = state.itinerary?.days?.[dayIdx]?.places;
    const target = placeIdx + delta;
    if (!places || target < 0 || target >= places.length) return false;
    [places[placeIdx], places[target]] = [places[target], places[placeIdx]];
    return true;
}

function movePlaceToDay(fromDay, placeIdx, toDay) {
    const days = state.itinerary?.days;
    if (!days?.[fromDay] || !days?.[toDay] || fromDay === toDay) return false;
    const [place] = days[fromDay].places.splice(placeIdx, 1);
    if (!place) return false;
    days[toDay].places.push(place);
    // A day that just gained a stop should be re-ordered, not appended to.
    reoptimiseDay(days[toDay], state.stay);
    if (days[fromDay].places.length === 0) days.splice(fromDay, 1);
    return true;
}

async function optimiseDayOrder(dayIdx) {
    const day = state.itinerary?.days?.[dayIdx];
    if (!day || day.places.length < 3) { showToast('Not enough stops to reorder', 'info'); return; }
    const before = day.places.map(p => p.name).join('|');
    reoptimiseDay(day, state.stay);
    const changed = day.places.map(p => p.name).join('|') !== before;
    await refreshAfterEdit();
    expandDay(dayIdx);
    showToast(changed ? 'Reordered to cut down travel 🧭' : 'Already the shortest route 👍', changed ? 'success' : 'info');
}

async function replanDay(dayIdx) {
    if (!requireAI()) return;
    const day = state.itinerary?.days?.[dayIdx];
    if (!day) return;

    showToast('Re-planning that day…', 'info');
    try {
        const updated = await rescheduleDay(state.config, day, {
            locations: state.locations, prefs: state.prefs, stay: state.stay,
        }, showAIBadge);
        state.itinerary.days[dayIdx] = { ...day, ...updated, day: day.day, date: day.date };
        await refreshAfterEdit();
        expandDay(dayIdx);
        showToast('Day re-planned ✨', 'success');
    } catch (err) {
        showToast('Could not re-plan: ' + err.message, 'error');
    }
}

// ── Place actions sheet ───────────────────────────────────────
let _actionTarget = { dayIdx: 0, placeIdx: 0 };

function openPlaceActions(dayIdx, placeIdx) {
    const day = state.itinerary?.days?.[dayIdx];
    const place = day?.places?.[placeIdx];
    if (!place) return;
    _actionTarget = { dayIdx, placeIdx };

    document.getElementById('place-actions-title').textContent = place.name;
    const otherDays = state.itinerary.days
        .map((d, i) => ({ d, i }))
        .filter(({ i }) => i !== dayIdx);

    document.getElementById('place-actions-body').innerHTML = `
      <div class="action-list">
        <button class="action-item" type="button" data-action="up" ${placeIdx === 0 ? 'disabled' : ''}>
          <span aria-hidden="true">⬆️</span> Move earlier in the day</button>
        <button class="action-item" type="button" data-action="down" ${placeIdx === day.places.length - 1 ? 'disabled' : ''}>
          <span aria-hidden="true">⬇️</span> Move later in the day</button>
        <button class="action-item" type="button" data-action="swap">
          <span aria-hidden="true">🔄</span> Swap for something nearby</button>
        <button class="action-item" type="button" data-action="note">
          <span aria-hidden="true">📝</span> ${place.note ? 'Edit your note' : 'Add a note'}</button>
        <button class="action-item danger" type="button" data-action="remove">
          <span aria-hidden="true">🗑️</span> Remove from trip</button>
      </div>
      ${otherDays.length ? `
      <div class="action-section">
        <div class="action-section-title">Move to another day</div>
        <div class="action-day-grid">
          ${otherDays.map(({ d, i }) => `
            <button class="action-day" type="button" data-move-to="${i}">
              <strong>Day ${esc(d.day)}</strong><span>${esc(d.zoneName || d.theme || d.location || '')}</span>
            </button>`).join('')}
        </div>
      </div>` : ''}
      ${place.note ? `<div class="action-note">📝 ${esc(place.note)}</div>` : ''}
      <div id="swap-results"></div>`;

    const body = document.getElementById('place-actions-body');
    body.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => handlePlaceAction(btn.dataset.action));
    });
    body.querySelectorAll('[data-move-to]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const to = Number(btn.dataset.moveTo);
            const targetDayNo = state.itinerary.days[to]?.day;
            if (movePlaceToDay(_actionTarget.dayIdx, _actionTarget.placeIdx, to)) {
                closeModal('place-actions-modal');
                await refreshAfterEdit();
                showToast(`Moved to Day ${targetDayNo}`, 'success');
            }
        });
    });

    openModal('place-actions-modal');
}

async function handlePlaceAction(action) {
    const { dayIdx, placeIdx } = _actionTarget;
    const day = state.itinerary?.days?.[dayIdx];
    const place = day?.places?.[placeIdx];
    if (!place) return;

    if (action === 'up' || action === 'down') {
        if (movePlaceWithinDay(dayIdx, placeIdx, action === 'up' ? -1 : 1)) {
            _actionTarget.placeIdx += action === 'up' ? -1 : 1;
            await refreshAfterEdit();
            expandDay(dayIdx);
            openPlaceActions(_actionTarget.dayIdx, _actionTarget.placeIdx);
        }
        return;
    }

    if (action === 'remove') {
        closeModal('place-actions-modal');
        const removed = removePlaceFromDay(dayIdx, placeIdx);
        if (removed && state.itinerary) {
            await refreshAfterEdit();
            showToast(`Removed ${removed.name}`, 'info');
        }
        return;
    }

    if (action === 'note') {
        const note = prompt(`Note for ${place.name}:`, place.note || '');
        if (note === null) return;
        place.note = note.trim().slice(0, 300);
        closeModal('place-actions-modal');
        renderItineraryScreen();
        expandDay(dayIdx);
        showToast(place.note ? 'Note saved 📝' : 'Note cleared', 'success');
        return;
    }

    if (action === 'swap') {
        if (!requireAI()) return;
        const results = document.getElementById('swap-results');
        results.innerHTML = `<div class="grid-spinner"><span class="spinner-ring" aria-hidden="true"></span> Finding nearby alternatives…</div>`;
        try {
            const alternatives = await suggestAlternatives(
                state.config, place, day.places, place.location || day.location || state.locations[0] || '', showAIBadge);
            if (!alternatives.length) {
                results.innerHTML = `<p class="grid-note">No alternatives found nearby.</p>`;
                return;
            }
            results.innerHTML = `
              <div class="action-section">
                <div class="action-section-title">Replace with</div>
                ${alternatives.map((alt, i) => `
                  <button class="action-item" type="button" data-swap="${i}">
                    <span aria-hidden="true">📍</span>
                    <span class="swap-body"><strong>${esc(alt.name)}</strong><span>${esc(alt.shortDesc || alt.category || '')}</span></span>
                  </button>`).join('')}
              </div>`;
            results.querySelectorAll('[data-swap]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const alt = alternatives[Number(btn.dataset.swap)];
                    // Keep the schedule slot, replace the subject.
                    day.places[placeIdx] = {
                        ...alt,
                        desc: alt.shortDesc || '',
                        arrivalTime: place.arrivalTime,
                        visitDuration: place.visitDuration,
                    };
                    closeModal('place-actions-modal');
                    await ensureImages([alt], day.location);
                    await refreshAfterEdit();
                    expandDay(dayIdx);
                    showToast(`Swapped in ${alt.name}`, 'success');
                });
            });
        } catch (err) {
            results.innerHTML = `<p class="grid-note">Could not fetch alternatives: ${esc(err.message)}</p>`;
        }
    }
}

// ── Plan quality notice ───────────────────────────────────────
function renderPlanNotice() {
    const el = document.getElementById('plan-notice');
    if (!el) return;
    const notes = [];

    if (state.zoneStats?.withoutCoords > 0) {
        notes.push(`${state.zoneStats.withoutCoords} place${state.zoneStats.withoutCoords === 1 ? '' : 's'} had no coordinates and couldn't be zone-grouped.`);
    }
    state.planIssues.filter(i => i.type === 'spread').forEach(i => notes.push(i.message));
    if (!routingAvailable()) {
        notes.push('Live routing is unavailable — travel times are straight-line estimates.');
    }

    el.classList.toggle('hidden', notes.length === 0);
    el.innerHTML = notes.length ? `⚠️ ${notes.map(esc).join(' ')}` : '';
}

function expandDay(dayIdx) {
    const item = document.querySelector(`.accordion-item[data-day="${dayIdx}"]`);
    if (!item) return;
    item.querySelector('.accordion-body').classList.remove('hidden');
    item.querySelector('.accordion-chevron').style.transform = 'rotate(180deg)';
    item.querySelector('.accordion-header').setAttribute('aria-expanded', 'true');
    item.classList.add('open');
}

function collapseDay(dayIdx) {
    const item = document.querySelector(`.accordion-item[data-day="${dayIdx}"]`);
    if (!item) return;
    item.querySelector('.accordion-body').classList.add('hidden');
    item.querySelector('.accordion-chevron').style.transform = 'rotate(0deg)';
    item.querySelector('.accordion-header').setAttribute('aria-expanded', 'false');
    item.classList.remove('open');
}

// ── Weather badges ────────────────────────────────────────────
function injectWeatherBadges(weatherMap) {
    document.querySelectorAll('.accordion-item').forEach(item => {
        const day = state.itinerary?.days?.[Number(item.dataset.day)];
        if (!day) return;
        const wx = weatherMap[day.date];
        if (!wx || item.querySelector('.weather-badge')) return;

        const badge = document.createElement('span');
        badge.className = 'weather-badge';
        badge.title = `${wx.description} · Humidity ${wx.humidity}% · Wind ${wx.wind_kph} km/h`;
        badge.textContent = `${weatherEmoji(wx.icon)} ${wx.temp_min}–${wx.temp_max}°C${wx.pop > 10 ? ` · 🌧️ ${wx.pop}%` : ''}`;
        item.querySelector('.accordion-day-title')?.appendChild(badge);
    });
}

// ── Budget breakdown modal ────────────────────────────────────
function openBudgetModal() {
    if (!state.itinerary) return;
    const b = estimateTripBudget(state.itinerary, {
        currency: state.prefs.currency, travellers: state.prefs.travellers, budget: state.prefs.budget,
    });
    const max = Math.max(...b.breakdown.map(x => x.amount), 1);

    document.getElementById('budget-body').innerHTML = `
      <div class="budget-total">
        <div class="budget-total-amount">${esc(money(b.total))}</div>
        <div class="budget-total-sub">${b.travellers} traveller${b.travellers === 1 ? '' : 's'} · ${esc(money(b.perPerson))} per person</div>
      </div>
      <div class="budget-bars">
        ${b.breakdown.map(row => `
          <div class="budget-row">
            <div class="budget-row-head">
              <span>${esc(row.label)}${row.note ? ` <span class="budget-note">${esc(row.note)}</span>` : ''}</span>
              <strong>${esc(money(row.amount))}</strong>
            </div>
            <div class="budget-track"><div class="budget-fill" style="width:${Math.round((row.amount / max) * 100)}%"></div></div>
          </div>`).join('')}
      </div>
      <div class="budget-days">
        <div class="action-section-title">Per day</div>
        ${b.perDay.map(d => `
          <div class="budget-day-row">
            <span>Day ${esc(d.day)}</span>
            <span class="budget-day-parts">🎟️ ${esc(money(d.tickets))} · 🍽️ ${esc(money(d.food))} · 🚕 ${esc(money(d.transport))}</span>
            <strong>${esc(money(d.total))}</strong>
          </div>`).join('')}
      </div>
      <p class="modal-hint" style="margin-top:14px;">
        Ticket prices come from the itinerary. Food, transport and stay are modelled from your
        ${esc(state.prefs.budget)} budget setting and group size — treat them as a rough guide, not a quote.
      </p>`;
    openModal('budget-modal');
}

// ── Packing list ──────────────────────────────────────────────
async function openPackingModal(force = false) {
    openModal('packing-modal');
    const body = document.getElementById('packing-body');
    const copyBtn = document.getElementById('packing-copy');
    const regenBtn = document.getElementById('packing-regen');

    if (state.packingList && !force) { renderPackingList(); return; }
    if (!state.itinerary) { body.innerHTML = '<p class="grid-note">Generate an itinerary first.</p>'; return; }
    if (!requireAI()) { body.innerHTML = '<p class="grid-note">AI is not configured.</p>'; return; }

    copyBtn.classList.add('hidden');
    regenBtn.classList.add('hidden');
    body.innerHTML = `<div class="grid-spinner"><span class="spinner-ring" aria-hidden="true"></span> Building a list for your dates, weather and activities…</div>`;

    try {
        state.packingList = await generatePackingList(state.config, {
            locations: state.locations, startDate: state.startDate, endDate: state.endDate,
            days: state.itinerary.days, weather: state.weatherMap, prefs: state.prefs,
        }, showAIBadge);
        renderPackingList();
    } catch (err) {
        body.innerHTML = `<p class="grid-note">Could not build the list: ${esc(err.message)}</p>`;
    }
}

function renderPackingList() {
    const body = document.getElementById('packing-body');
    const groups = state.packingList || [];
    if (!groups.length) { body.innerHTML = '<p class="grid-note">Nothing to show.</p>'; return; }

    const checked = JSON.parse(localStorage.getItem('atp_packing_checked') || '[]');
    body.innerHTML = groups.map(g => `
      <div class="packing-group">
        <div class="packing-group-title">${esc(g.name)}</div>
        ${(g.items || []).map(item => {
        const id = `pack-${g.name}-${item}`.replace(/[^\w-]/g, '');
        return `<label class="packing-item">
                      <input type="checkbox" data-pack="${esc(item)}" ${checked.includes(item) ? 'checked' : ''}>
                      <span>${esc(item)}</span>
                    </label>`;
    }).join('')}
      </div>`).join('');

    body.querySelectorAll('[data-pack]').forEach(box => {
        box.addEventListener('change', () => {
            const current = new Set(JSON.parse(localStorage.getItem('atp_packing_checked') || '[]'));
            if (box.checked) current.add(box.dataset.pack); else current.delete(box.dataset.pack);
            try { localStorage.setItem('atp_packing_checked', JSON.stringify([...current])); } catch { /* full */ }
            box.closest('.packing-item')?.classList.toggle('done', box.checked);
        });
        box.closest('.packing-item')?.classList.toggle('done', box.checked);
    });

    document.getElementById('packing-copy').classList.remove('hidden');
    document.getElementById('packing-regen').classList.remove('hidden');
}

function packingListText() {
    return (state.packingList || [])
        .map(g => `${g.name}\n${(g.items || []).map(i => `  • ${i}`).join('\n')}`)
        .join('\n\n');
}

// ── Local info ────────────────────────────────────────────────
async function openInfoModal() {
    openModal('info-modal');
    const body = document.getElementById('info-body');

    if (state.localInfo) { renderLocalInfo(); return; }
    if (!requireAI()) { body.innerHTML = '<p class="grid-note">AI is not configured.</p>'; return; }
    if (!state.locations.length) { body.innerHTML = '<p class="grid-note">Add a destination first.</p>'; return; }

    body.innerHTML = `<div class="grid-spinner"><span class="spinner-ring" aria-hidden="true"></span> Looking up local information…</div>`;
    try {
        const key = cacheKey('info', state.locations.join(','));
        state.localInfo = cacheGet(key);
        if (!state.localInfo) {
            state.localInfo = await generatePracticalInfo(state.config, state.locations, showAIBadge);
            cacheSet(key, state.localInfo);
        }
        renderLocalInfo();
    } catch (err) {
        body.innerHTML = `<p class="grid-note">Could not load local info: ${esc(err.message)}</p>`;
    }
}

function renderLocalInfo() {
    const info = state.localInfo || {};
    const body = document.getElementById('info-body');
    const list = (title, items) => items?.length
        ? `<div class="info-block"><div class="info-block-title">${esc(title)}</div><ul class="info-list">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>` : '';

    const em = info.emergency || {};
    body.innerHTML = `
      ${Object.keys(em).length ? `
      <div class="info-block">
        <div class="info-block-title">🚨 Emergency</div>
        <div class="info-grid">
          ${Object.entries(em).filter(([, v]) => v && v !== 'N/A').map(([k, v]) => `
            <div class="info-cell"><span>${esc(k.replace(/_/g, ' '))}</span><a href="tel:${esc(String(v).replace(/[^\d+]/g, ''))}">${esc(v)}</a></div>`).join('')}
        </div>
      </div>` : ''}
      <div class="info-grid two">
        ${info.currency ? `<div class="info-cell"><span>💱 Currency</span><strong>${esc(info.currency)}</strong></div>` : ''}
        ${info.plug ? `<div class="info-cell"><span>🔌 Power</span><strong>${esc(info.plug)}</strong></div>` : ''}
      </div>
      ${info.transport ? `<div class="info-block"><div class="info-block-title">🚕 Getting around</div><p>${esc(info.transport)}</p></div>` : ''}
      ${info.tipping ? `<div class="info-block"><div class="info-block-title">💵 Tipping</div><p>${esc(info.tipping)}</p></div>` : ''}
      ${list('🛡️ Safety', info.safety)}
      ${list('🙏 Etiquette', info.etiquette)}
      ${info.phrases?.length ? `
      <div class="info-block">
        <div class="info-block-title">🗣️ Useful phrases</div>
        ${info.phrases.map(p => `<div class="phrase-row"><strong>${esc(p.local)}</strong><span>${esc(p.meaning)}</span></div>`).join('')}
      </div>` : ''}
      <p class="modal-hint" style="margin-top:12px;">AI-generated — verify emergency numbers before you travel.</p>`;
}

// ── Saved trips ───────────────────────────────────────────────
function readSavedTrips() {
    try {
        const trips = JSON.parse(localStorage.getItem('atp_saved_trips') || '[]');
        return Array.isArray(trips) ? trips : [];
    } catch { return []; }
}

function writeSavedTrips(trips) {
    localStorage.setItem('atp_saved_trips', JSON.stringify(trips));
}

function saveCurrentTrip() {
    if (!state.itinerary) { showToast('Nothing to save yet', 'info'); return; }
    const trips = readSavedTrips();

    // Only keep remote image URLs — base64 blobs would blow the quota instantly.
    const safeImageCache = {};
    for (const [k, v] of Object.entries(state.imageCache || {})) {
        if (typeof v === 'string' && v.startsWith('http')) safeImageCache[k] = v;
    }

    const trip = {
        id: Date.now().toString(),
        savedAt: new Date().toISOString(),
        locations: state.locations,
        startDate: state.startDate,
        endDate: state.endDate,
        summary: state.itinerary.summary || '',
        itinerary: state.itinerary,
        imageCache: safeImageCache,
        prefs: state.prefs,
        stay: state.stay,
        packingList: state.packingList,
        localInfo: state.localInfo,
    };

    // Re-saving the same trip updates it in place instead of piling up copies.
    const sameTrip = t =>
        t.startDate === trip.startDate && t.endDate === trip.endDate &&
        JSON.stringify(t.locations) === JSON.stringify(trip.locations);
    const existingIdx = trips.findIndex(sameTrip);
    if (existingIdx !== -1) trips.splice(existingIdx, 1);
    trips.unshift(trip);

    // Drop the oldest trips until it fits, rather than failing outright.
    let candidate = trips.slice(0, MAX_SAVED_TRIPS);
    let dropped = 0;
    while (candidate.length) {
        try {
            writeSavedTrips(candidate);
            const storage = calculateStorageUsed();
            showToast(
                dropped
                    ? `Trip saved 💾 — removed ${dropped} old trip${dropped === 1 ? '' : 's'} to free space`
                    : `Trip saved! 💾 (${storage.percentUsed}% · ${storage.usedKB} KB / ${storage.maxKB} KB)`,
                'success'
            );
            return;
        } catch (e) {
            if (e.name !== 'QuotaExceededError' || candidate.length === 1) {
                showToast(
                    e.name === 'QuotaExceededError'
                        ? 'This trip is too large for browser storage. Try a shorter trip.'
                        : 'Could not save trip: ' + e.message,
                    'error'
                );
                return;
            }
            candidate = candidate.slice(0, -1);
            dropped++;
        }
    }
}

function calculateStorageUsed() {
    try {
        const json = localStorage.getItem('atp_saved_trips') || '[]';
        const sizeKB = Math.round(new Blob([json]).size / 1024);
        return {
            usedKB: sizeKB,
            maxKB: STORAGE_MAX_KB,
            percentUsed: Math.min(100, Math.round((sizeKB / STORAGE_MAX_KB) * 100)),
            remainingKB: Math.max(0, STORAGE_MAX_KB - sizeKB),
        };
    } catch {
        return { usedKB: 0, maxKB: STORAGE_MAX_KB, percentUsed: 0, remainingKB: STORAGE_MAX_KB };
    }
}

function getStorageColor(pct) {
    if (pct < 50) return 'var(--success)';
    if (pct < 80) return 'var(--warning)';
    return 'var(--danger)';
}

// ── Share ─────────────────────────────────────────────────────
function shareTrip() {
    const customTa = document.getElementById('home-custom-places');
    const shareData = {
        l: state.locations,
        s: state.startDate,
        e: state.endDate,
        c: customTa ? customTa.value.trim().slice(0, 1000) : '',
        p: state.prefs,
        h: state.stay?.name || '',
    };
    const encoded = btoa(encodeURIComponent(JSON.stringify(shareData)));
    const url = `${location.origin}${location.pathname}#share=${encoded}`;

    if (navigator.share) {
        navigator.share({ title: 'AI Trip Planner', text: `My ${state.locations.join(' & ')} trip plan`, url })
            .catch(() => copyShareUrl(url));
        return;
    }
    copyShareUrl(url);
}

function copyShareUrl(url) {
    navigator.clipboard?.writeText(url)
        .then(() => showToast('Share link copied! 🔗', 'success'))
        .catch(() => showToast('Could not copy the link', 'error'));
}

function checkShareLink() {
    if (!location.hash.startsWith('#share=')) return;
    try {
        const data = JSON.parse(decodeURIComponent(atob(location.hash.slice(7))));

        // Treat everything in the URL as untrusted: validate types and clamp sizes.
        if (Array.isArray(data.l)) {
            const seen = new Set();
            state.locations = data.l
                .filter(x => typeof x === 'string' && x.trim())
                .map(x => x.trim().slice(0, 80))
                .filter(x => { const k = x.toLowerCase(); return seen.has(k) ? false : seen.add(k); })
                .slice(0, MAX_LOCATIONS);
            renderChips();
        }
        const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
        if (isDate(data.s)) document.getElementById('start-date').value = data.s;
        if (isDate(data.e)) document.getElementById('end-date').value = data.e;

        if (typeof data.c === 'string' && data.c.trim()) {
            const ta = document.getElementById('home-custom-places');
            if (ta) {
                ta.value = data.c.slice(0, 1000);
                document.getElementById('home-custom-body')?.classList.remove('hidden');
                document.getElementById('home-custom-toggle')?.setAttribute('aria-expanded', 'true');
            }
        }
        if (typeof data.h === 'string' && data.h.trim()) {
            const stayInput = document.getElementById('stay-input');
            if (stayInput) stayInput.value = data.h.slice(0, 120);
        }
        if (data.p && typeof data.p === 'object') {
            const p = data.p;
            if (['relaxed', 'balanced', 'packed'].includes(p.pace)) state.prefs.pace = p.pace;
            if (['shoestring', 'moderate', 'comfort'].includes(p.budget)) state.prefs.budget = p.budget;
            if (TRANSPORT_MODES[p.transport]) state.prefs.transport = p.transport;
            if (CURRENCIES[p.currency]) state.prefs.currency = p.currency;
            if (Array.isArray(p.interests)) {
                state.prefs.interests = p.interests.filter(i => INTEREST_OPTIONS.includes(i));
            }
            syncPreferencesUI();
        }
        updateTripLengthHint();
        showToast('Trip link loaded! Click "Plan My Trip" 🗺️', 'success');
    } catch { /* malformed hash — ignore */ }
    history.replaceState({ screen: 'screen-input' }, '', location.pathname + location.search);
}

// ── My Trips ──────────────────────────────────────────────────
function openMyTrips() {
    renderMyTripsList();
    openModal('mytrips-modal');
}

function renderMyTripsList() {
    const list = document.getElementById('mytrips-list');
    const trips = readSavedTrips();
    const storage = calculateStorageUsed();
    const barColor = getStorageColor(storage.percentUsed);

    list.innerHTML = `
    <div class="storage-meter">
        <div class="storage-meter-head">
            <span>💾 Storage Used</span>
            <span style="color:${barColor};">${storage.percentUsed}%</span>
        </div>
        <div class="storage-track">
            <div class="storage-bar" style="width:${storage.percentUsed}%;background:${barColor};"></div>
        </div>
        <div class="storage-meter-foot">
            <span>${storage.usedKB} KB used</span>
            <span>${storage.remainingKB} KB free</span>
            <span>${storage.maxKB} KB max</span>
        </div>
    </div>`;

    if (!trips.length) {
        list.insertAdjacentHTML('beforeend',
            '<p class="grid-note" style="text-align:center;padding:20px;">No saved trips yet.<br>Plan a trip and click 💾 Save!</p>');
        return;
    }

    trips.forEach((trip, idx) => {
        const item = document.createElement('div');
        item.className = 'saved-trip-item';
        const date = new Date(trip.savedAt).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
        const sizeKB = Math.round(new Blob([JSON.stringify(trip)]).size / 1024);
        item.innerHTML = `
        <button class="saved-trip-open" type="button">
            <span class="saved-trip-name">${esc((trip.locations || []).join(' + '))}</span>
            <span class="saved-trip-meta">${esc(trip.startDate)} → ${esc(trip.endDate)} · Saved ${esc(date)} · <span class="saved-trip-size">${sizeKB} KB</span></span>
            ${trip.summary ? `<span class="saved-trip-summary">${esc(trip.summary.slice(0, 90))}${trip.summary.length > 90 ? '…' : ''}</span>` : ''}
        </button>
        <button class="saved-trip-del" type="button" aria-label="Delete this saved trip" title="Delete">✕</button>`;

        item.querySelector('.saved-trip-open').addEventListener('click', () => loadSavedTrip(trip));
        item.querySelector('.saved-trip-del').addEventListener('click', e => {
            e.stopPropagation();
            const current = readSavedTrips();
            current.splice(idx, 1);
            writeSavedTrips(current);
            renderMyTripsList();
            showToast('Trip deleted', 'info');
        });

        list.appendChild(item);
    });
}

async function loadSavedTrip(trip) {
    if (!trip?.itinerary?.days?.length) { showToast('That saved trip is corrupted', 'error'); return; }

    state.locations = trip.locations || [];
    state.startDate = trip.startDate || '';
    state.endDate = trip.endDate || '';
    state.itinerary = trip.itinerary;
    state.imageCache = { ...(trip.imageCache || {}) };
    state.aiProvider = '';
    state.weatherMap = {};
    state.stay = trip.stay || null;
    state.packingList = trip.packingList || null;
    state.localInfo = trip.localInfo || null;
    state.planIssues = validateItinerary(trip.itinerary);
    state.zoneStats = null;
    if (trip.prefs) state.prefs = { ...state.prefs, ...trip.prefs };
    // Rebuild the discovery pool from the itinerary so "Edit Places" still works.
    state.places = trip.itinerary.days.flatMap(d =>
        d.places.map(p => ({ name: p.name, location: p.location || d.location || '', shortDesc: p.desc || '', category: p.category || '' })));
    state.selectedPlaces = [...state.places];
    state.autoMode = false;

    closeModal('mytrips-modal');
    renderChips();
    syncPreferencesUI();
    document.getElementById('start-date').value = state.startDate;
    document.getElementById('end-date').value = state.endDate;
    const stayInput = document.getElementById('stay-input');
    if (stayInput) stayInput.value = state.stay?.name || '';
    updateTripLengthHint();

    // Rebuild the discovery grid too, so "← Edit Places" isn't a blank screen.
    state.filter = { category: 'all', selectedOnly: false };
    renderDiscoveryScreen({ allowAutoFill: false });
    renderItineraryScreen();
    showScreen('screen-itinerary');
    showToast('Trip loaded! 🗺️', 'success');
    await renderMap();

    fetchWeatherForDays(state.itinerary.days).then(w => {
        state.weatherMap = w;
        if (Object.keys(w).length) injectWeatherBadges(w);
    }).catch(() => { });
}

// ── Custom Paste Places ───────────────────────────────────────
function openCustomPaste() {
    openModal('custom-paste-modal');
    setTimeout(() => document.getElementById('custom-paste-input')?.focus(), 50);
}

function closeCustomPaste() {
    closeModal('custom-paste-modal');
    const inp = document.getElementById('custom-paste-input');
    if (inp) inp.value = '';
}

async function applyCustomPaste() {
    const raw = document.getElementById('custom-paste-input')?.value || '';
    if (!raw.trim()) { closeCustomPaste(); return; }

    const names = [...new Set(raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean))].slice(0, 40);
    const added = [];

    names.forEach(name => {
        const existing = state.places.find(p => p.name.toLowerCase() === name.toLowerCase());
        const place = existing || { name, location: state.locations[0] || '', shortDesc: '', category: 'Heritage' };
        if (!existing) state.places.push(place);
        if (!state.selectedPlaces.some(p => p.name === place.name)) {
            state.selectedPlaces.push(place);
            added.push(place);
        }
    });

    closeCustomPaste();
    if (!added.length) { showToast('Those places are already selected', 'info'); return; }

    setAutoMode(false);
    await ensureImages(added, state.locations[0]);
    renderDiscoveryScreen();
    showToast(`Added ${added.length} custom place${added.length !== 1 ? 's' : ''}`, 'success');
}

// ── Service worker (offline shell) ────────────────────────────
function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || isLocalStatic()) return;
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => console.warn('[sw] registration failed', err.message));
    });
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    loadPrefs();
    applyTheme(currentTheme);
    initGlobalBindings();
    initInputScreen();
    showScreen('screen-input', { push: false });
    // Must run before the history entry is normalised — that replaceState drops
    // the hash, and the share payload lives in it.
    checkShareLink();
    if (!history.state?.screen) {
        history.replaceState({ screen: 'screen-input' }, '', location.pathname + location.search);
    }
    registerServiceWorker();

    await loadEnvironment();
    if (shouldWarnAboutConfig()) {
        document.getElementById('config-warning')?.classList.remove('hidden');
    }
});
