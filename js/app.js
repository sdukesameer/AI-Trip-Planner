// ============================================================
//  app.js — State manager & screen router  (v2)
// ============================================================

import {
    fetchFamousPlaces, fetchMorePlaces, searchNearbyPlaces,
    fetchPlaceImages, generateItinerary, getLastProvider, picsumFallback, svgPlaceholder,
    enrichCustomPlaces, fetchWeatherForDays, weatherEmoji
} from './api.js';
import { initMap, plotItinerary, focusDay, focusPlace, resetFocus, setMapTheme } from './maps.js';
import { downloadAsText, downloadAsPDF, copyToClipboard } from './download.js';

// ── Global Locale ──────────────────────────────────────────────
const LOCALE = typeof navigator !== 'undefined' ? (navigator.language || 'en-IN') : 'en-IN';

// ── ENV keys (injected at Netlify build time) ─────────────────
let ENV_KEYS = {};
async function loadEnvKeys() {
    try {
        const m = await import('./env.js');
        if (m?.ENV_KEYS) ENV_KEYS = m.ENV_KEYS;
    } catch { /* local dev without env.js */ }
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
    weatherMap: {},   // date → OWM forecast object
    config: { geminiKey: '', groqKey: '', unsplashKey: '' },
};

// ── Screen management ─────────────────────────────────────────
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id)?.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Modals ────────────────────────────────────────────────────
function openModal(id) { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

// ── Progress ──────────────────────────────────────────────────
const STAGES = ['Fetching famous places…', 'Loading place images…', 'Building smart itinerary…', 'Rendering map & results…'];

function showProgress() { openModal('progress-overlay'); setProgress(0, STAGES[0]); }

function setProgress(step, label) {
    const pct = Math.round((step / STAGES.length) * 100);
    document.getElementById('progress-bar-fill').style.width = pct + '%';
    document.getElementById('progress-pct').textContent = pct + '%';
    document.getElementById('progress-label').textContent = label;
    document.getElementById('progress-step').textContent = `Step ${step + 1} of ${STAGES.length}`;
    document.querySelectorAll('.stage-dot').forEach((dot, idx) => {
        dot.classList.toggle('done', idx < step);
        dot.classList.toggle('active', idx === step);
        dot.classList.remove('pending');
        if (idx > step) dot.classList.add('pending');
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
    if (b) { b.textContent = `🤖 Using: ${name}`; b.style.display = 'block'; }
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    document.getElementById('toast-container').appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 3500);
}

// ── Empty State ───────────────────────────────────────────────
function showEmptyState(containerId, title, subtitle, retryFn = null) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                    padding:60px 24px;text-align:center;gap:16px;">
            <div style="font-size:52px;line-height:1;">${title.match(/^\S+/)?.[0] || '⚠️'}</div>
            <div style="font-family:'Outfit',sans-serif;font-size:20px;font-weight:700;
                        color:var(--text-primary);">${title.replace(/^\S+\s*/, '')}</div>
            <div style="font-size:14px;color:var(--text-secondary);max-width:400px;line-height:1.6;">
                ${subtitle}
            </div>
            ${retryFn ? `<button class="btn btn-primary btn-sm" id="empty-state-retry">🔄 Try Again</button>` : ''}
        </div>`;
    if (retryFn) {
        document.getElementById('empty-state-retry')?.addEventListener('click', retryFn);
    }
}

// ── Weather Badge Injection ────────────────────────────────────
function injectWeatherBadges(weatherMap) {
    document.querySelectorAll('.accordion-item').forEach(item => {
        const dayIdx = parseInt(item.dataset.day, 10);
        const day = state.itinerary?.days?.[dayIdx];
        if (!day) return;
        const wx = weatherMap[day.date];
        if (!wx) return;

        // Don't double-inject
        if (item.querySelector('.weather-badge')) return;

        const emoji = weatherEmoji(wx.icon);
        const rainStr = wx.pop > 10 ? ` · 🌧️ ${wx.pop}%` : '';
        const badge = document.createElement('span');
        badge.className = 'weather-badge';
        badge.title = `${wx.description} · Humidity ${wx.humidity}% · Wind ${wx.wind_kph} km/h`;
        badge.innerHTML = `${emoji} ${wx.temp_min}–${wx.temp_max}°C${rainStr}`;
        badge.style.cssText = [
            'display:inline-flex;align-items:center;gap:4px;',
            'background:rgba(6,182,212,0.12);border:1px solid rgba(6,182,212,0.3);',
            'color:#67e8f9;border-radius:999px;padding:2px 10px;',
            'font-size:11px;font-weight:500;margin-left:8px;vertical-align:middle;',
            'cursor:help;white-space:nowrap;'
        ].join('');

        const titleEl = item.querySelector('.accordion-day-title');
        if (titleEl) titleEl.appendChild(badge);
    });
}

// ── Theme ─────────────────────────────────────────────────────
let currentTheme = localStorage.getItem('atp_theme') || 'dark';

function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('theme-btn');
    if (btn) btn.textContent = theme === 'dark' ? '🌙' : '☀️';
    localStorage.setItem('atp_theme', theme);
    setMapTheme(theme); // swap map tiles
}

function toggleTheme() { applyTheme(currentTheme === 'dark' ? 'light' : 'dark'); }

// ── Location Autocomplete ─────────────────────────────────────
let _acTimer = null;

async function fetchSuggestions(query) {
    if (!query || query.length < 2) return [];
    try {
        // Photon API (OpenStreetMap-based, no CORS issues, no key required)
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6&lang=en`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        const seen = new Set();
        return (data.features || [])
            .map(f => {
                const p = f.properties || {};
                const city = p.city || p.name || p.county || '';
                const parts = [city, p.state, p.country].filter(Boolean);
                const label = parts.join(', ');
                return { label, name: city || label };
            })
            .filter(({ label, name }) => {
                if (!name || seen.has(label)) return false;
                seen.add(label); return true;
            });
    } catch { return []; }
}

function showSuggestions(suggestions) {
    const list = document.getElementById('location-suggestions');
    if (!list) return;
    list.innerHTML = '';
    if (!suggestions.length) { list.classList.add('hidden'); return; }
    suggestions.forEach(({ label, name }) => {
        const li = document.createElement('li');
        li.className = 'location-suggestion-item';
        li.textContent = label;
        // mousedown fires before blur — using it prevents the 150ms delay race condition
        li.addEventListener('mousedown', e => { e.preventDefault(); addLocation(name); hideSuggestions(); });
        list.appendChild(li);
    });
    list.classList.remove('hidden');
}

function hideSuggestions() {
    document.getElementById('location-suggestions')?.classList.add('hidden');
}

// ── Module-level addLocation / renderChips ────────────────────
// (BUG FIX: was nested inside initInputScreen — unreachable from showSuggestions)
function addLocation(val) {
    const v = val.trim();
    if (!v || state.locations.includes(v)) return;
    state.locations.push(v);
    renderChips();
    const inp = document.getElementById('location-input');
    if (inp) inp.value = '';
    hideSuggestions();
}

function renderChips() {
    const chipBox = document.getElementById('chip-box');
    if (!chipBox) return;
    chipBox.innerHTML = '';
    state.locations.forEach((loc, idx) => {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.innerHTML = `<span>${loc}</span><button class="chip-remove" data-idx="${idx}">×</button>`;
        chipBox.appendChild(chip);
    });
    chipBox.querySelectorAll('.chip-remove').forEach(btn => {
        btn.addEventListener('click', () => { state.locations.splice(Number(btn.dataset.idx), 1); renderChips(); });
    });
}

// ── Fallback image ────────────────────────────────────────────
function fallbackImg(name) { return picsumFallback(name); }
function getSvgFallback(name) { return svgPlaceholder(name); }

// Loose place name similarity — strips punctuation, checks word overlap
function placesAreSimilar(a, b) {
    const normalize = str => str
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')   // strip punctuation
        .replace(/\b(the|a|an|of|and|&|mall|centre|center|complex|park|garden|fort|temple|masjid|mandir|market|bazar|bazaar|chowk)\b/g, '') // strip generic suffixes
        .replace(/\s+/g, ' ')
        .trim();

    const na = normalize(a);
    const nb = normalize(b);

    if (na === nb) return true;

    // Token overlap: if 60%+ of the shorter name's tokens appear in the longer
    const tokA = na.split(' ').filter(Boolean);
    const tokB = nb.split(' ').filter(Boolean);
    const [shorter, longer] = tokA.length <= tokB.length ? [tokA, tokB] : [tokB, tokA];
    if (shorter.length === 0) return false;
    const matches = shorter.filter(t => longer.includes(t)).length;
    return matches / shorter.length >= 0.6;
}

// ── Config loading ────────────────────────────────────────────
function loadConfig() {
    const isPlaceholder = v => !v || v.startsWith('PASTE_YOUR_');
    state.config = {
        geminiKey: isPlaceholder(ENV_KEYS.geminiKey) ? '' : ENV_KEYS.geminiKey,
        groqKey: isPlaceholder(ENV_KEYS.groqKey) ? '' : ENV_KEYS.groqKey,
        unsplashKey: isPlaceholder(ENV_KEYS.unsplashKey) ? '' : ENV_KEYS.unsplashKey,
    };
}

// ── Input Screen Init ─────────────────────────────────────────
function initInputScreen() {
    const input = document.getElementById('location-input');

    input.addEventListener('input', () => {
        clearTimeout(_acTimer);
        const q = input.value.trim();
        if (q.length < 2) { hideSuggestions(); return; }
        _acTimer = setTimeout(async () => {
            const suggestions = await fetchSuggestions(q);
            showSuggestions(suggestions);
        }, 350);
    });

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const v = input.value.replace(',', '').trim();
            if (v) addLocation(v);
        }
        if (e.key === 'Escape') hideSuggestions();
    });

    input.addEventListener('blur', () => setTimeout(hideSuggestions, 150));

    document.getElementById('add-location-btn').addEventListener('click', () => addLocation(input.value));

    // Default dates: today and today + 3 days
    const today = new Date();
    const plus3 = new Date(today); plus3.setDate(today.getDate() + 3);
    document.getElementById('start-date').valueAsDate = today;
    document.getElementById('end-date').valueAsDate = plus3;

    let _planningInFlight = false;
    document.getElementById('plan-btn').addEventListener('click', async () => {
        if (_planningInFlight) return;
        _planningInFlight = true;
        const btn = document.getElementById('plan-btn');
        btn.disabled = true;
        btn.innerHTML = '⏳ Planning…';
        try { await startPlanning(); }
        finally {
            _planningInFlight = false;
            btn.disabled = false;
            btn.innerHTML = '✈️ Plan My Trip';
        }
    });

    // Navbar: logo → home
    document.getElementById('home-logo').addEventListener('click', () => showScreen('screen-input'));
    document.getElementById('home-logo').addEventListener('keydown', e => { if (e.key === 'Enter') showScreen('screen-input'); });

    // Theme toggle
    document.getElementById('theme-btn').addEventListener('click', toggleTheme);

    // My Trips
    document.getElementById('mytrips-btn').addEventListener('click', openMyTrips);
    document.getElementById('mytrips-close').addEventListener('click', () => closeModal('mytrips-modal'));
    document.getElementById('mytrips-clear').addEventListener('click', () => { localStorage.removeItem('atp_saved_trips'); renderMyTripsList(); showToast('All saved trips cleared', 'info'); });
    document.getElementById('mytrips-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal('mytrips-modal'); });

    // Place detail modal close / overlay click
    document.getElementById('place-modal-close').addEventListener('click', closePlaceModal);
    document.getElementById('place-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closePlaceModal(); });

    // Map popup "Details" button triggers place modal
    window.addEventListener('map-place-detail', e => {
        try {
            const place = JSON.parse(e.detail);
            openPlaceModal(place);
        } catch { /* ignore */ }
    });

    // Custom places toggle (home page)
    const customToggle = document.getElementById('home-custom-toggle');
    const customBody = document.getElementById('home-custom-body');
    if (customToggle && customBody) {
        customToggle.addEventListener('click', () => {
            const open = customBody.classList.toggle('hidden');
            customToggle.setAttribute('aria-expanded', String(!open));
        });
        // Start collapsed — aria-expanded="false" already set in HTML
        customBody.classList.add('hidden');
    }

    // Delegated commute toggle — CSP-safe, handles dynamically rendered rows
    document.addEventListener('click', e => {
        const btn = e.target.closest('[data-commute-toggle]');
        if (!btn) return;
        const collapsible = btn.closest('[data-commute-collapsible]');
        if (!collapsible) return;
        const isOpen = collapsible.classList.toggle('open');
        btn.setAttribute('aria-expanded', String(isOpen));
    });

    // Check share link in URL hash
    checkShareLink();

    // Global keyboard shortcuts
    document.addEventListener('keydown', e => {
        // Close modals on Escape
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
        }

        // Ctrl/Cmd + S to save trip (if on itinerary screen)
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            const saveBtn = document.getElementById('save-trip-btn');
            if (saveBtn && document.getElementById('screen-itinerary').classList.contains('active')) {
                e.preventDefault();
                saveBtn.click();
            }
        }

        // Ctrl/Cmd + D to download PDF (if on itinerary screen)
        if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
            const dlBtn = document.getElementById('download-pdf-btn');
            if (dlBtn && document.getElementById('screen-itinerary').classList.contains('active')) {
                e.preventDefault();
                dlBtn.click();
            }
        }
    });
}

// ── Planning Flow ─────────────────────────────────────────────
async function startPlanning() {
    if (!state.config.geminiKey && !state.config.groqKey) {
        showToast('AI keys are not configured on the server.', 'error');
        return;
    }
    if (state.locations.length === 0) { showToast('Add at least one location 📍', 'error'); return; }
    const sd = document.getElementById('start-date').value;
    const ed = document.getElementById('end-date').value;
    if (!sd || !ed || new Date(ed) < new Date(sd)) { showToast('Please set valid trip dates 📅', 'error'); return; }
    state.startDate = sd; state.endDate = ed;

    showProgress();
    const onSwitch = name => { showAIBadge(name); showToast(`Trying ${name}…`, 'info'); };

    try {
        setProgress(0, STAGES[0]);

        // Parse custom places early so we can enrich them
        const customTa = document.getElementById('home-custom-places');
        const customNames = customTa && customTa.value.trim()
            ? customTa.value.split(/[,\n]+/).map(s => s.trim()).filter(Boolean)
            : [];

        // Fetch famous places for all locations
        const placesCacheKey = cacheKey('places', state.locations.join(','));
        let famousPlaces = cacheGet(placesCacheKey);
        if (!famousPlaces) {
            famousPlaces = await fetchFamousPlaces(state.config, state.locations, onSwitch);
            cacheSet(placesCacheKey, famousPlaces);
        }

        // Enrich custom places with AI descriptions if any
        let customPlaceObjects = [];
        if (customNames.length) {
            const enrichCacheKey = cacheKey('enrich', customNames.join(','), state.locations.join(','));
            let enriched = cacheGet(enrichCacheKey);
            if (!enriched) {
                try {
                    enriched = await enrichCustomPlaces(state.config, customNames, state.locations[0] || '', onSwitch);
                    cacheSet(enrichCacheKey, enriched);
                } catch {
                    // Fallback: create stub objects
                    enriched = customNames.map(name => ({
                        name, location: state.locations[0] || '',
                        shortDesc: 'A must-visit place on your itinerary.',
                        category: 'Heritage'
                    }));
                }
            }
            // Merge enriched data — if famous places already has it, update shortDesc
            customNames.forEach(name => {
                const enrichedData = enriched.find(e => e.name.toLowerCase() === name.toLowerCase()) || {};
                const existingFamous = famousPlaces.find(p => p.name.toLowerCase() === name.toLowerCase());
                if (existingFamous) {
                    // Update with enriched data if shortDesc missing
                    if (!existingFamous.shortDesc && enrichedData.shortDesc) {
                        existingFamous.shortDesc = enrichedData.shortDesc;
                    }
                    customPlaceObjects.push(existingFamous);
                } else {
                    customPlaceObjects.push({
                        name: enrichedData.name || name,
                        location: enrichedData.location || state.locations[0] || '',
                        shortDesc: enrichedData.shortDesc || 'A must-visit place on your itinerary.',
                        category: enrichedData.category || 'Heritage',
                    });
                }
            });
        }

        // Build final place list: custom places first (pinned), then remaining famous places
        // Use fuzzy dedup so "DB Mall" and "DB City Mall" don't both appear
        const remainingFamous = famousPlaces.filter(famous =>
            !customPlaceObjects.some(custom => placesAreSimilar(custom.name, famous.name))
        );
        state.places = [...customPlaceObjects, ...remainingFamous];
        const customNamesLower = customNames.map(n => n.toLowerCase());

        // Auto-select all custom places
        state.selectedPlaces = [];
        customPlaceObjects.forEach(place => {
            if (!state.selectedPlaces.find(p => p.name === place.name)) {
                state.selectedPlaces.push(place);
            }
        });

        setProgress(1, STAGES[1]);
        // Fetch images for all places with location context
        const allItems = state.places.map(p => ({ name: p.name, location: p.location || state.locations[0] || '' }));
        const missing = allItems.filter(p => !state.imageCache[p.name]);
        if (missing.length) {
            const imgs = await fetchPlaceImages(missing, state.config.unsplashKey);
            Object.assign(state.imageCache, imgs);
        }

        hideProgress();
        renderDiscoveryScreen();

        // After render, visually mark custom places as selected
        if (customPlaceObjects.length) {
            setTimeout(() => {
                document.querySelectorAll('.place-card').forEach(card => {
                    if (customNamesLower.includes(card.dataset.name?.toLowerCase())) {
                        card.classList.add('selected');
                    }
                });
            }, 50);
        }

        showScreen('screen-discovery');

    } catch (err) { hideProgress(); showToast('Error: ' + err.message, 'error'); console.error(err); }
}

// Returns the optimal initial fetch count and load-more count based on viewport columns
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

// ── Discovery Screen ──────────────────────────────────────────
function renderDiscoveryScreen() {
    const grid = document.getElementById('discovery-grid');
    grid.innerHTML = '';

    state.locations.forEach(loc => {
        const locPlaces = state.places.filter(p =>
            p.location?.toLowerCase() === loc.toLowerCase() ||
            p.location?.toLowerCase().includes(loc.toLowerCase()));

        const { cols, initialCount, loadMoreCount } = getSymmetricCounts();

        const section = document.createElement('div');
        section.className = 'discovery-section';
        section.dataset.location = loc;
        section.innerHTML = `<h3 class="section-title">📍 ${loc}</h3>`;

        const cardRow = document.createElement('div');
        cardRow.className = 'place-card-grid';
        cardRow.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        section.appendChild(cardRow);

        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'load-more-btn';
        loadMoreBtn.innerHTML = `⬇️ Load More Places in ${loc}`;
        section.appendChild(loadMoreBtn);
        grid.appendChild(section);

        if (!locPlaces.length) return;

        // Deduplicate
        const seenInSection = [];
        const allLocPlacesDeduped = [];
        locPlaces.forEach(place => {
            if (seenInSection.some(s => placesAreSimilar(s, place.name))) return;
            seenInSection.push(place.name);
            allLocPlacesDeduped.push(place);
        });

        // Pre-selected (custom) places go first
        const preSelected = allLocPlacesDeduped.filter(p => state.selectedPlaces.find(s => s.name === p.name));
        const rest = allLocPlacesDeduped.filter(p => !state.selectedPlaces.find(s => s.name === p.name));
        const ordered = [...preSelected, ...rest];

        let hiddenPlaces = ordered.slice(initialCount);
        let renderedCount = 0;

        // Render what we have
        ordered.slice(0, initialCount).forEach(place => { renderPlaceCard(place, cardRow); renderedCount++; });

        // Auto-fill: if we have fewer than initialCount, keep fetching until 2 rows are full
        async function autoFill() {
            while (renderedCount < initialCount) {
                const needed = initialCount - renderedCount;
                const existingNames = state.places
                    .filter(p => p.location?.toLowerCase().includes(loc.toLowerCase()))
                    .map(p => p.name);
                try {
                    const more = await fetchMorePlaces(state.config, loc, existingNames, name => showAIBadge(name), needed);
                    if (!more || !more.length) break;
                    state.places.push(...more);
                    const imgItems = more.filter(p => !state.imageCache[p.name])
                        .map(p => ({ name: p.name, location: p.location || loc }));
                    if (imgItems.length) {
                        const imgs = await fetchPlaceImages(imgItems, state.config.unsplashKey);
                        Object.assign(state.imageCache, imgs);
                    }
                    more.forEach(place => { renderPlaceCard(place, cardRow); renderedCount++; });
                    if (more.length < needed) break; // API returned less than needed, stop
                } catch { break; }
            }
        }

        // Only auto-fill if config allows AI calls
        if (renderedCount < initialCount && (state.config.geminiKey || state.config.groqKey)) {
            autoFill();
        }

        loadMoreBtn.addEventListener('click', async () => {
            loadMoreBtn.disabled = true;
            loadMoreBtn.innerHTML = '⏳ Loading…';

            if (hiddenPlaces.length >= loadMoreCount) {
                // Full row from cache
                const toReveal = hiddenPlaces.splice(0, loadMoreCount);
                const missing = toReveal.filter(p => !state.imageCache[p.name])
                    .map(p => ({ name: p.name, location: p.location || loc }));
                if (missing.length) {
                    const imgs = await fetchPlaceImages(missing, state.config.unsplashKey);
                    Object.assign(state.imageCache, imgs);
                }
                toReveal.forEach(place => renderPlaceCard(place, cardRow));
                renderedCount += toReveal.length;
                loadMoreBtn.innerHTML = `⬇️ Load More Places in ${loc}`;
                loadMoreBtn.disabled = false;
            } else {
                // Show remaining cache first, then fetch to complete the row
                const fromCache = hiddenPlaces.splice(0);
                if (fromCache.length) {
                    const missing = fromCache.filter(p => !state.imageCache[p.name])
                        .map(p => ({ name: p.name, location: p.location || loc }));
                    if (missing.length) {
                        const imgs = await fetchPlaceImages(missing, state.config.unsplashKey);
                        Object.assign(state.imageCache, imgs);
                    }
                    fromCache.forEach(place => renderPlaceCard(place, cardRow));
                    renderedCount += fromCache.length;
                }
                const stillNeeded = loadMoreCount - fromCache.length;
                if (stillNeeded > 0) {
                    await loadMorePlaces(loc, section, loadMoreBtn, stillNeeded, cardRow);
                    renderedCount += stillNeeded;
                } else {
                    loadMoreBtn.innerHTML = `⬇️ Load More Places in ${loc}`;
                    loadMoreBtn.disabled = false;
                }
            }
        });
    });

    // Auto mode: default true if nothing selected
    if (state.selectedPlaces.length === 0) {
        state.autoMode = true;
        _autoModeManuallySet = false;
    }

    // Rebind auto toggle
    const autoToggle = document.getElementById('auto-toggle');
    autoToggle.checked = state.autoMode;
    const newToggle = autoToggle.cloneNode(true);
    newToggle.checked = state.autoMode;
    autoToggle.replaceWith(newToggle);
    document.getElementById('discovery-grid').classList.toggle('auto-mode', state.autoMode);
    newToggle.addEventListener('change', () => {
        state.autoMode = newToggle.checked;
        _autoModeManuallySet = true; // user explicitly touched the toggle
        // If user manually turns ON auto, clear all selections
        if (state.autoMode) {
            state.selectedPlaces = [];
            document.querySelectorAll('.place-card.selected').forEach(c => c.classList.remove('selected'));
        }
        document.getElementById('discovery-grid').classList.toggle('auto-mode', state.autoMode);
        updateSelectionCount();
    });

    // Rebind Generate / Back
    let _generatingInFlight = false;
    rebind('generate-btn', async () => {
        if (_generatingInFlight) return;
        _generatingInFlight = true;
        const gBtn = document.getElementById('generate-btn');
        if (gBtn) { gBtn.disabled = true; gBtn.innerHTML = '⏳ Building…'; }
        try { await generateItineraryFlow(); }
        finally {
            _generatingInFlight = false;
            if (gBtn) { gBtn.disabled = false; gBtn.innerHTML = '🧠 Generate Itinerary'; }
        }
    });
    rebind('back-to-input', () => showScreen('screen-input'));

    // Nearby search
    rebind('nearby-search-btn', doNearbySearch);
    const nearbyInput = document.getElementById('nearby-input');
    if (nearbyInput) {
        const clone = nearbyInput.cloneNode(true);
        nearbyInput.replaceWith(clone);
        clone.addEventListener('keydown', e => { if (e.key === 'Enter') doNearbySearch(); });
    }

    // Custom paste
    rebind('custom-paste-btn', openCustomPaste);

    updateSelectionCount();
}

function renderPlaceCard(place, container, forNearby = false) {
    const imgUrl = state.imageCache[place.name] || fallbackImg(place.name);
    const card = document.createElement('div');
    card.className = 'place-card';
    card.dataset.name = place.name;
    card.innerHTML = `
      <div class="place-img-wrap">
        <img src="${imgUrl}" alt="${place.name}" loading="lazy" onerror="this.onerror=null;this.src='${getSvgFallback(place.name)}'">
        <div class="card-check">✓</div>
        <div class="category-badge">${place.category || ''}</div>
        <button class="card-detail-btn" title="View details">⤢</button>
      </div>
      <div class="card-body">
        <div class="card-name">${place.name}</div>
        <div class="card-desc">${place.shortDesc || place.desc?.slice(0, 80) || ''}</div>
      </div>`;

    // Toggle selection (left-click on card body)
    card.querySelector('.card-body').addEventListener('click', () => togglePlaceSelection(card, place));
    card.querySelector('.place-img-wrap').addEventListener('click', e => {
        if (!e.target.closest('.card-detail-btn')) togglePlaceSelection(card, place);
    });

    // Detail modal (the ⤢ button)
    card.querySelector('.card-detail-btn').addEventListener('click', e => {
        e.stopPropagation();
        openPlaceModal(place);
    });

    container.appendChild(card);
}

// Load more places for a location, either from cache or API if exhausted
async function loadMorePlaces(loc, section, btn, count, cardRow) {
    if (!state.config.geminiKey && !state.config.groqKey) { showToast('No AI keys configured', 'error'); return; }
    const existingNames = state.places.filter(p => p.location?.toLowerCase().includes(loc.toLowerCase())).map(p => p.name);
    const fetchCount = count || getSymmetricCounts().loadMoreCount;
    btn.disabled = true; btn.textContent = '⏳ Loading…';

    const onSwitch = name => showAIBadge(name);
    try {
        const more = await fetchMorePlaces(state.config, loc, existingNames, onSwitch, fetchCount);
        state.places.push(...more);
        const targetRow = cardRow || section.querySelector('.place-card-grid');
        // Reuse existing image cache first, fetch only missing
        const newItems = more
            .filter(p => !state.imageCache[p.name])
            .map(p => ({ name: p.name, location: p.location || loc }));
        if (newItems.length) {
            const imgs = await fetchPlaceImages(newItems, state.config.unsplashKey);
            Object.assign(state.imageCache, imgs);
        }
        more.forEach(place => renderPlaceCard(place, targetRow));
        btn.textContent = `⬇️ Load More Places in ${loc}`;
        btn.disabled = false;
        showToast(`Loaded ${more.length} more places in ${loc}`, 'success');
    } catch (err) {
        btn.textContent = `⬇️ Load More Places in ${loc}`;
        btn.disabled = false;
        showToast('Failed to load more: ' + err.message, 'error');
    }
}

async function doNearbySearch() {
    const query = document.getElementById('nearby-input')?.value?.trim();
    if (!query) { showToast('Enter a place to search', 'info'); return; }
    if (!state.config.geminiKey && !state.config.groqKey) { showToast('No AI keys configured', 'error'); return; }

    const resultsDiv = document.getElementById('nearby-results');
    resultsDiv.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">🔍 Searching…</div>';

    // Include selected locations in query for more accurate results
    const locContext = state.locations.length ? state.locations.join(', ') : '';
    const fullQuery = locContext ? `${query} near ${locContext}` : query;

    const onSwitch = name => showAIBadge(name);
    try {
        const results = await searchNearbyPlaces(state.config, fullQuery, onSwitch);
        resultsDiv.innerHTML = '';
        const { cols } = getSymmetricCounts();
        resultsDiv.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        // For nearby search: show exactly 1 row (cols tiles)
        const nearbyToShow = results.slice(0, cols);
        const nearbyHidden = results.slice(cols);
        if (!nearbyToShow.length) { resultsDiv.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">No results found.</div>'; return; }

        // Fetch images with location context
        // Fetch images for visible results only first
        const imgItems = nearbyToShow.filter(p => !state.imageCache[p.name]).map(p => ({ name: p.name, location: p.location || locContext }));
        if (imgItems.length) {
            const imgs = await fetchPlaceImages(imgItems, state.config.unsplashKey);
            Object.assign(state.imageCache, imgs);
        }
        // Cache hidden results' images in background
        if (nearbyHidden.length) {
            fetchPlaceImages(nearbyHidden.filter(p => !state.imageCache[p.name]).map(p => ({ name: p.name, location: p.location || locContext })), state.config.unsplashKey)
                .then(imgs => Object.assign(state.imageCache, imgs)).catch(() => { });
        }

        nearbyToShow.forEach(place => {
            const isDup = state.places.some(p => placesAreSimilar(p.name, place.name));
            if (!isDup) state.places.push(place);
            renderPlaceCard(place, resultsDiv, true);
        });
        nearbyHidden.forEach(place => {
            const isDup = state.places.some(p => placesAreSimilar(p.name, place.name));
            if (!isDup) state.places.push(place);
        });
        showToast(`Found ${results.length} places near "${query}"`, 'success');
    } catch (err) {
        resultsDiv.innerHTML = '';
        showToast('Search failed: ' + err.message, 'error');
    }
}

// Track if user has manually overridden auto-mode via the toggle
let _autoModeManuallySet = false;

function togglePlaceSelection(card, place) {
    // If auto mode is manually forced ON by user, block card selection
    if (_autoModeManuallySet && state.autoMode) return;

    const idx = state.selectedPlaces.findIndex(p => p.name === place.name);
    if (idx === -1) {
        state.selectedPlaces.push(place);
        card.classList.add('selected');
    } else {
        state.selectedPlaces.splice(idx, 1);
        card.classList.remove('selected');
    }

    // Smart auto-mode sync (only if user hasn't manually overridden)
    if (!_autoModeManuallySet) {
        const autoToggle = document.getElementById('auto-toggle');
        if (state.selectedPlaces.length === 0) {
            state.autoMode = true;
            if (autoToggle) autoToggle.checked = true;
            document.getElementById('discovery-grid').classList.add('auto-mode');
        } else {
            state.autoMode = false;
            if (autoToggle) autoToggle.checked = false;
            document.getElementById('discovery-grid').classList.remove('auto-mode');
        }
    }
    updateSelectionCount();
}

function updateSelectionCount() {
    const el = document.getElementById('selection-count');
    if (!el) return;
    const count = state.selectedPlaces.length;
    el.textContent = state.autoMode ? '🤖 AI will choose the best places' : `${count} place${count !== 1 ? 's' : ''} selected`;
}

// ── Place Detail Modal ────────────────────────────────────────
function openPlaceModal(place) {
    const img = state.imageCache[place.name] || fallbackImg(place.name);
    const imgEl = document.getElementById('place-detail-img');
    imgEl.src = img;
    imgEl.onerror = () => { imgEl.onerror = null; imgEl.src = getSvgFallback(place.name); };
    document.getElementById('place-detail-name').textContent = place.name;
    document.getElementById('place-detail-category').textContent = place.category || '';

    const metaEl = document.getElementById('place-detail-meta');
    const metaParts = [];
    if (place.openingHours) metaParts.push('\u23f0 ' + place.openingHours);
    if (place.entryFee) metaParts.push('\ud83d\udcb0 ' + place.entryFee);
    if (place.bestTime) metaParts.push('\ud83d\udd50 Best: ' + place.bestTime);
    if (place.visitDuration) metaParts.push('\u231b ~' + place.visitDuration);
    metaEl.innerHTML = metaParts.map(p => `<span>${p}</span>`).join('');

    const closedEl = document.getElementById('place-detail-closed');
    if (place.closedNote) { closedEl.textContent = '\u26a0\ufe0f ' + place.closedNote; closedEl.style.display = 'block'; }
    else closedEl.style.display = 'none';

    document.getElementById('place-detail-desc').textContent = place.desc || place.shortDesc || '';

    // Text query (name + city) gives far better Google Maps results than raw coordinates
    const gmapEl = document.getElementById('place-detail-gmap');
    const city = place.location || (state.locations[0] || '');
    const gmapQ = encodeURIComponent([place.name, city].filter(Boolean).join(' '));
    gmapEl.href = `https://www.google.com/maps/search/?api=1&query=${gmapQ}`;

    openModal('place-modal');
}

function closePlaceModal() { closeModal('place-modal'); }

// ── Itinerary Generation ──────────────────────────────────────
async function generateItineraryFlow() {
    if (!state.autoMode && state.selectedPlaces.length === 0) {
        showToast('Select at least one place, or enable Auto mode 🤖', 'error'); return;
    }
    showProgress();
    const onSwitch = name => { showAIBadge(name); showToast(`Trying ${name}…`, 'info'); };

    try {
        setProgress(2, STAGES[2]);
        const itinKey = cacheKey('itin', state.locations.join(','), state.startDate, state.endDate, state.autoMode ? 'auto' : state.selectedPlaces.map(p => p.name).join(','));
        let itin = cacheGet(itinKey);
        if (!itin) {
            itin = await generateItinerary(state.config, state.locations, state.startDate, state.endDate, state.autoMode ? state.places : state.selectedPlaces, state.autoMode, onSwitch);
            cacheSet(itinKey, itin);
        }
        // Guard: validate AI returned a usable structure
        if (!itin || !Array.isArray(itin.days) || itin.days.length === 0) {
            hideProgress();
            showEmptyState('itinerary-accordion',
                '🤖 AI returned an unexpected response',
                'The itinerary could not be built. Try again or adjust your destinations.',
                () => generateItineraryFlow()
            );
            showScreen('screen-itinerary');
            return;
        }

        // Guard: strip any days with no places array
        itin.days = itin.days.filter(d => Array.isArray(d.places) && d.places.length > 0);
        if (itin.days.length === 0) {
            hideProgress();
            showEmptyState('itinerary-accordion',
                '📭 No places found',
                'AI generated days with no places. Try adding specific places or changing dates.',
                () => generateItineraryFlow()
            );
            showScreen('screen-itinerary');
            return;
        }

        state.itinerary = itin;
        state.aiProvider = getLastProvider();

        // Fetch weather in background (non-blocking — won't delay render)
        fetchWeatherForDays(itin.days).then(weatherMap => {
            state.weatherMap = weatherMap;
            if (Object.keys(weatherMap).length) injectWeatherBadges(weatherMap);
        }).catch(() => { /* weather is optional */ });

        // Fetch images for itinerary places with location context for accurate thumbnails
        const allPlaceObjs = itin.days.flatMap(d => d.places.map(p => ({ name: p.name, location: d.location || state.locations[0] || '' })));
        const missingObjs = allPlaceObjs.filter(p => !state.imageCache[p.name]);
        const dedupedMissing = [...new Map(missingObjs.map(p => [p.name, p])).values()];
        if (dedupedMissing.length) {
            Object.assign(state.imageCache, await fetchPlaceImages(dedupedMissing, state.config.unsplashKey));
        }

        setProgress(3, STAGES[3]);
        renderItineraryScreen();
        showScreen('screen-itinerary');

        try {
            const currentThemeVal = document.documentElement.getAttribute('data-theme') || 'dark';
            await initMap('map-container', currentThemeVal);
            plotItinerary(itin, state.imageCache, (dayIdx) => {
                expandDay(dayIdx);
                document.querySelector(`[data-day="${dayIdx}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, state.locations);
        } catch (mapErr) {
            console.error('[Map error]', mapErr);
            const mapContainer = document.getElementById('map-container');
            if (mapContainer) {
                mapContainer.innerHTML = `<div class="map-placeholder" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;padding:20px;background:var(--bg-elevated);border-radius:12px;border:1px solid var(--border);">
                    <div class="map-placeholder-icon" style="font-size:40px;margin-bottom:12px;">⚠️</div>
                    <div class="map-placeholder-title" style="font-weight:600;font-size:18px;color:var(--text-primary);margin-bottom:8px;">Map failed to load</div>
                    <div class="map-placeholder-sub" style="font-size:13px;color:var(--text-secondary);max-width:300px;">${mapErr.message}</div>
                </div>`;
            }
        }

        hideProgress();

    } catch (err) {
        hideProgress();
        const msg = err.message?.includes('timed out') || err.message?.includes('502')
            ? 'AI is taking longer than usual. Please try again in a moment ⏳'
            : 'Error generating itinerary: ' + err.message;
        showToast(msg, 'error');
        console.error(err);
    }
}

// ── Itinerary Screen ──────────────────────────────────────────
const DAY_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316', '#84CC16', '#6366F1'];

function renderItineraryScreen() {
    const itin = state.itinerary;
    const accordion = document.getElementById('itinerary-accordion');
    accordion.innerHTML = '';

    const totalPlaces = itin.days.reduce((s, d) => s + d.places.length, 0);
    document.getElementById('itin-summary').textContent = `${itin.days.length} Days · ${state.locations.join(' & ')} · ${totalPlaces} Places`;

    // AI provider tag
    const providerTag = document.getElementById('ai-provider-tag');
    if (providerTag && state.aiProvider) {
        providerTag.style.display = 'inline-block';
        providerTag.innerHTML = `<span style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:999px;padding:4px 12px;font-size:11px;color:var(--accent);">🤖 ${state.aiProvider}</span>`;
    }

    // Budget estimator — tickets only label
    const budgetEl = document.getElementById('budget-badge');
    const { total: budgetTotal, perDay } = estimateBudget(itin);
    if (budgetEl && budgetTotal > 0) {
        budgetEl.style.display = 'inline-flex';
        budgetEl.title = perDay.map(d => `Day ${d.day}: \u20b9${d.cost}`).join(' \u00b7 ');
        budgetEl.innerHTML = `\ud83c\udfdf\ufe0f Tickets: <strong style="margin-left:4px;">\u20b9${budgetTotal.toLocaleString('en-IN')}</strong><span style="font-size:10px;margin-left:6px;opacity:.7;">(travel excl. \u00b7 hover for per-day)</span>`;
    }

    itin.days.forEach((day, dayIdx) => {
        const color = DAY_COLORS[dayIdx % DAY_COLORS.length];
        const item = document.createElement('div');
        item.className = 'accordion-item';
        item.dataset.day = dayIdx;

        const dayBudget = perDay.find(d => d.day === day.day);
        const dayBudgetStr = (dayBudget && dayBudget.cost > 0) ? `<span class="day-cost-tag">₹${dayBudget.cost}</span>` : '';

        item.innerHTML = `
      <div class="accordion-header" style="border-left:4px solid ${color}">
        <div class="accordion-header-left">
          <div class="day-badge" style="background:${color}">Day ${day.day}</div>
          <div class="accordion-title-block">
            <div class="accordion-day-title">${day.theme || 'Explore'} ${dayBudgetStr}</div>
            <div class="accordion-day-meta">${day.date}${day.location ? ' · ' + day.location : ''} · ${day.places.length} places</div>
          </div>
        </div>
        <div class="accordion-chevron">▾</div>
      </div>
      <div class="accordion-body hidden">
        ${day.places.map((p, pIdx) => renderPlaceRow(p, pIdx, color, dayIdx)).join('')}
      </div>`;

        // Click header → expand + focus day on map
        item.querySelector('.accordion-header').addEventListener('click', () => {
            const isOpen = !item.querySelector('.accordion-body').classList.contains('hidden');
            if (isOpen) { collapseDay(dayIdx); }
            else { expandDay(dayIdx); focusDay(dayIdx); }
        });

        // Click individual place rows → focus on map; thumbnail click → detail modal
        item.querySelectorAll('.place-row').forEach((row, pIdx) => {
            const place = day.places[pIdx];
            row.addEventListener('click', () => focusPlace(dayIdx, pIdx));
            const imgEl = row.querySelector('.place-row-img');
            if (imgEl && place) {
                imgEl.addEventListener('click', e => { e.stopPropagation(); openPlaceModal(place); });
                imgEl.style.cursor = 'zoom-in';
            }
        });

        accordion.appendChild(item);
    });

    expandDay(0);

    // Rebind action buttons
    rebind('download-txt-btn', () => downloadAsText(state.itinerary, state.locations, state.startDate, state.endDate));
    rebind('download-pdf-btn', async () => await downloadAsPDF(state.itinerary, state.locations, state.startDate, state.endDate, state.imageCache));
    rebind('copy-btn', async () => { await copyToClipboard(state.itinerary, state.locations, state.startDate, state.endDate); showToast('Copied to clipboard! \ud83d\udccb', 'success'); });
    rebind('back-to-discovery', () => showScreen('screen-discovery'));
    rebind('new-trip-btn', () => { state.itinerary = null; state.selectedPlaces = []; showScreen('screen-input'); });
    rebind('save-trip-btn', saveCurrentTrip);
    rebind('share-trip-btn', shareTrip);
    rebind('map-reset-focus', resetFocus);

    // Inject any already-loaded weather (e.g. saved trip reload)
    if (state.weatherMap && Object.keys(state.weatherMap).length) {
        setTimeout(() => injectWeatherBadges(state.weatherMap), 50);
    }

    // Legend
    const legend = document.getElementById('day-legend');
    if (legend) {
        legend.innerHTML = '';
        itin.days.forEach((day, idx) => {
            const color = DAY_COLORS[idx % DAY_COLORS.length];
            const it = document.createElement('div');
            it.className = 'day-legend-item';
            it.innerHTML = `<div class="day-dot" style="background:${color}"></div><span>Day ${day.day}${day.location ? ' · ' + day.location : ''}</span>`;
            it.addEventListener('click', () => { expandDay(idx); focusDay(idx); });
            it.style.cursor = 'pointer';
            legend.appendChild(it);
        });
    }
}

function renderPlaceRow(place, pIdx, dayColor, dayIdx) {
    const img = state.imageCache[place.name] || fallbackImg(place.name);
    const commute = place.commute_from_prev;
    // Build collapsible commute row
    let commuteHTML = '';
    if (pIdx > 0 && commute) {
        const rows = [];
        if (commute.walk && commute.walk !== 'N/A') rows.push(`<div class="commute-detail-row"><span class="commute-badge walk">\ud83d\udeb6 Walk</span><span class="commute-detail-text">${commute.walk}</span></div>`);
        if (commute.metro && commute.metro !== 'N/A') rows.push(`<div class="commute-detail-row"><span class="commute-badge metro">\ud83d\ude87 Metro</span><span class="commute-detail-text">${commute.metro}</span></div>`);
        if (commute.cab && commute.cab !== 'N/A') rows.push(`<div class="commute-detail-row"><span class="commute-badge cab">\ud83d\ude95 Cab</span><span class="commute-detail-text">${commute.cab}</span></div>`);
        if (rows.length) {
            const quickest = rows[0].match(/class="commute-detail-text">([^<]+)/)?.[1] || '';
            commuteHTML = `
    <div class="commute-collapsible" data-commute-collapsible>
      <button class="commute-summary-btn" data-commute-toggle aria-expanded="false">
        <span class="commute-arrow">\u2192</span>
        <span class="commute-summary-text">Getting there &middot; ${quickest}</span>
        <span class="commute-chevron">&and;</span>
      </button>
      <div class="commute-detail-body">${rows.join('')}</div>
    </div>`;
        }
    }

    const closedNote = place.closedNote ? `<div class="place-closed-note">⚠️ ${place.closedNote}</div>` : '';
    // Text-based Google Maps query (name + city) is more useful than coordinates
    const city = place.location || (state.locations[0] || '');
    const gmapQ = encodeURIComponent([place.name, city].filter(Boolean).join(' '));
    const gmapUrl = `https://www.google.com/maps/search/?api=1&query=${gmapQ}`;

    // Arrival time pill: shown at start of place name line
    const timeTag = place.arrivalTime
        ? `<span class="arrival-time-tag" style="background:${dayColor}18;color:${dayColor};border-color:${dayColor}44;">${place.arrivalTime}</span>`
        : '';
    const durationTag = place.visitDuration
        ? `<span class="visit-dur-tag">⌛ ~${place.visitDuration}</span>`
        : '';

    return `
    ${commuteHTML}
    <div class="place-row" style="cursor:pointer" title="Click to focus on map">
      <div class="place-row-num" style="background:${dayColor}22;color:${dayColor};">${pIdx + 1}</div>
      <img class="place-row-img" src="${img}" alt="${place.name}"
           onerror="this.onerror=null;this.src='${getSvgFallback(place.name)}'" loading="lazy">
      <div class="place-row-info">
        <div class="place-row-name">${timeTag} ${place.name} ${durationTag}</div>
        ${place.openingHours || place.entryFee || place.bestTime ? `
          <div class="place-row-meta">
            ${place.openingHours ? `<span>⏰ ${place.openingHours}</span>` : ''}
            ${place.entryFee ? `<span>💰 ${place.entryFee}</span>` : ''}
            ${place.bestTime ? `<span>🌅 ${place.bestTime}</span>` : ''}
          </div>` : ''}
        ${closedNote}
        <div class="place-row-desc">${place.desc || ''}</div>
      </div>
      <a class="place-gmap-link" href="${gmapUrl}" target="_blank" rel="noopener" title="Open in Google Maps" onclick="event.stopPropagation()">🗺️</a>
    </div>`;
}

function expandDay(dayIdx) {
    document.querySelectorAll('.accordion-item').forEach((item, idx) => {
        if (idx === dayIdx) {
            item.querySelector('.accordion-body').classList.remove('hidden');
            item.querySelector('.accordion-chevron').style.transform = 'rotate(180deg)';
            item.classList.add('open');
        }
    });
}

function collapseDay(dayIdx) {
    document.querySelectorAll('.accordion-item').forEach((item, idx) => {
        if (idx === dayIdx) {
            item.querySelector('.accordion-body').classList.add('hidden');
            item.querySelector('.accordion-chevron').style.transform = 'rotate(0deg)';
            item.classList.remove('open');
        }
    });
}

// ── Budget Estimator ──────────────────────────────────────────
function estimateBudget(itin) {
    let total = 0;
    const perDay = itin.days.map(day => {
        let dayCost = 0;
        day.places.forEach(place => {
            const fee = place.entryFee || '';
            const match = fee.match(/[\u20B9\u20b9]?\s*(\d+)/);
            if (match) { const n = parseInt(match[1], 10); dayCost += n; total += n; }
        });
        return { day: day.day, cost: dayCost };
    });
    return { total, perDay };
}

// ── Save trip ─────────────────────────────────────────────────
function saveCurrentTrip() {
    const trips = JSON.parse(localStorage.getItem('atp_saved_trips') || '[]');

    // Strip imageCache of data-URLs and large base64 blobs — keep only http(s) URLs
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
        summary: state.itinerary?.summary || '',
        itinerary: state.itinerary,
        imageCache: safeImageCache,   // only safe URLs, no base64
    };

    trips.unshift(trip);
    const trimmed = trips.slice(0, 5);
    const serialized = JSON.stringify(trimmed);

    // Guard: localStorage limit is ~5 MB; warn if we're approaching it
    const sizeKB = Math.round((serialized.length * 2) / 1024); // UTF-16 = 2 bytes/char
    if (sizeKB > 3800) { // Leave 1–2 MB buffer
        // Try saving without oldest trip
        const smaller = JSON.stringify(trimmed.slice(0, -1));
        if (smaller.length * 2 / 1024 < 4500) {
            localStorage.setItem('atp_saved_trips', smaller);
            showToast('Trip saved (oldest removed to free space) 💾', 'success');
            return;
        }
        showToast('Storage nearly full — delete old trips first', 'error');
        return;
    }

    try {
        localStorage.setItem('atp_saved_trips', serialized);
        const storage = calculateStorageUsed();
        showToast(`Trip saved! 💾 (${storage.percentUsed}% · ${storage.usedKB} KB / ${storage.maxKB} KB)`, 'success');
    } catch (e) {
        if (e.name === 'QuotaExceededError') {
            const storage = calculateStorageUsed();
            showToast(`Storage full! (${storage.percentUsed}%) Delete old trips from My Trips 🗑️`, 'error');
        } else {
            showToast('Could not save trip: ' + e.message, 'error');
        }
    }
}

// Estimate storage usage of saved trips and warn if approaching limit
function calculateStorageUsed() {
    try {
        const tripsJSON = localStorage.getItem('atp_saved_trips') || '[]';
        const sizeBytes = new Blob([tripsJSON]).size;
        const sizeKB = Math.round(sizeBytes / 1024);
        const maxKB = 3072; // 3 MB localStorage limit
        const percentUsed = Math.round((sizeKB / maxKB) * 100);

        return {
            usedKB: sizeKB,
            maxKB: maxKB,
            percentUsed: percentUsed,
            remainingKB: maxKB - sizeKB,
        };
    } catch (err) {
        console.warn('[Storage calc error]', err.message);
        return { usedKB: 0, maxKB: 3072, percentUsed: 0, remainingKB: 3072 };
    }
}

function getStorageColor(percentUsed) {
    if (percentUsed < 50) return '#10b981';  // green
    if (percentUsed < 80) return '#f59e0b';  // amber
    return '#ef4444';                         // red
}

// ── Share trip (encode key params in URL hash) ─────────────────
function shareTrip() {
    const customTa = document.getElementById('home-custom-places');
    const customPlaces = customTa ? customTa.value.trim() : '';

    const shareData = { l: state.locations, s: state.startDate, e: state.endDate, c: customPlaces };
    const encoded = btoa(encodeURIComponent(JSON.stringify(shareData)));
    const url = `${location.origin}${location.pathname}#share=${encoded}`;
    navigator.clipboard.writeText(url).then(() => showToast('Share link copied! 🔗', 'success')).catch(() => showToast('Could not copy to clipboard', 'error'));
}

function checkShareLink() {
    const hash = location.hash;
    if (!hash.startsWith('#share=')) return;
    try {
        const data = JSON.parse(decodeURIComponent(atob(hash.slice(7))));
        if (data.l?.length) { state.locations = data.l; renderChips(); }
        if (data.s) document.getElementById('start-date').value = data.s;
        if (data.e) document.getElementById('end-date').value = data.e;
        if (data.c) {
            const customTa = document.getElementById('home-custom-places');
            if (customTa) {
                customTa.value = data.c;
                // Expand toggle so user sees it
                const customToggle = document.getElementById('home-custom-toggle');
                const customBody = document.getElementById('home-custom-body');
                if (customToggle && customBody) {
                    customBody.classList.remove('hidden');
                    customToggle.setAttribute('aria-expanded', 'true');
                }
            }
        }
        showToast('Trip link loaded! Click "Plan My Trip" 🗺️', 'success');
        history.replaceState(null, '', location.pathname); // clear hash
    } catch { /* ignore malformed hash */ }
}

// ── My Trips ──────────────────────────────────────────────────
function openMyTrips() {
    renderMyTripsList();
    openModal('mytrips-modal');
}

function renderMyTripsList() {
    const list = document.getElementById('mytrips-list');
    const trips = JSON.parse(localStorage.getItem('atp_saved_trips') || '[]');

    // Calculate storage
    const storage = calculateStorageUsed();
    const barColor = getStorageColor(storage.percentUsed);

    // Build list HTML with storage meter at top
    let html = `
    <div style="background:var(--bg-elevated);padding:12px 16px;border-radius:10px;margin-bottom:16px;display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600;color:var(--text-secondary);">
            <span>💾 Storage Used</span>
            <span style="color:${barColor};">${storage.percentUsed}%</span>
        </div>
        <div style="height:6px;background:var(--border);border-radius:999px;overflow:hidden;">
            <div class="storage-bar" style="height:100%;background:linear-gradient(90deg,#10b981,#f59e0b,#ef4444);width:${storage.percentUsed}%;transition:width 0.3s;"></div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);display:flex;justify-content:space-between;">
            <span>${storage.usedKB} KB used</span>
            <span>${storage.remainingKB} KB free</span>
            <span style="font-weight:600;color:${barColor};">${storage.maxKB} KB max</span>
        </div>
    </div>
    `;

    if (!trips.length) {
        html += '<div style="padding:20px;text-align:center;color:var(--text-muted);">No saved trips yet.<br>Plan a trip and click 💾 Save!</div>';
        list.innerHTML = html;
        return;
    }

    list.innerHTML = html;
    trips.forEach((trip, idx) => {
        const item = document.createElement('div');
        item.className = 'saved-trip-item';
        const date = new Date(trip.savedAt).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
        const tripSizeKB = Math.round(new Blob([JSON.stringify(trip)]).size / 1024);
        item.innerHTML = `
        <div style="flex:1;">
            <div class="saved-trip-name">${trip.locations.join(' + ')}</div>
            <div class="saved-trip-meta">${trip.startDate} → ${trip.endDate} · Saved ${date} · <span style="color:var(--accent);">${tripSizeKB} KB</span></div>
            ${trip.summary ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px;">${trip.summary.slice(0, 80)}…</div>` : ''}
        </div>
        <button class="saved-trip-del" data-idx="${idx}" title="Delete">✕</button>`;

        // Load this trip
        item.querySelector('.saved-trip-name').addEventListener('click', () => loadSavedTrip(trip));
        item.querySelector('.saved-trip-meta').addEventListener('click', () => loadSavedTrip(trip));

        // Delete
        item.querySelector('.saved-trip-del').addEventListener('click', e => {
            e.stopPropagation();
            trips.splice(idx, 1);
            localStorage.setItem('atp_saved_trips', JSON.stringify(trips));
            renderMyTripsList();  // Re-render to update storage meter
        });

        list.appendChild(item);
    });
}

function loadSavedTrip(trip) {
    state.locations = trip.locations;
    state.startDate = trip.startDate;
    state.endDate = trip.endDate;
    state.itinerary = trip.itinerary;
    state.imageCache = { ...(trip.imageCache || {}) };  // shallow copy so we can extend
    state.aiProvider = '';
    closeModal('mytrips-modal');
    renderChips();
    renderItineraryScreen();
    showScreen('screen-itinerary');
    showToast('Trip loaded! \ud83d\uddfa\ufe0f', 'success');
    try {
        const theme = document.documentElement.getAttribute('data-theme') || 'dark';
        initMap('map-container', theme).then(() =>
            plotItinerary(trip.itinerary, state.imageCache, (dayIdx) => expandDay(dayIdx), state.locations)
        );
    } catch { /* ignore */ }
}

// ── Helpers ───────────────────────────────────────────────────
function rebind(id, fn) {
    const el = document.getElementById(id);
    if (!el) return;
    const clone = el.cloneNode(true);
    el.replaceWith(clone);
    clone.addEventListener('click', fn);
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
function applyCustomPaste() {
    const raw = document.getElementById('custom-paste-input')?.value || '';
    if (!raw.trim()) { closeCustomPaste(); return; }
    const names = raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
    let added = 0;
    names.forEach(name => {
        const existing = state.places.find(p => p.name.toLowerCase() === name.toLowerCase());
        const place = existing || { name, location: state.locations[0] || '', shortDesc: '', category: 'Heritage' };
        if (!existing) state.places.push(place);
        if (!state.selectedPlaces.find(p => p.name === place.name)) {
            state.selectedPlaces.push(place);
            added++;
        }
    });
    closeCustomPaste();
    showToast(`Added ${added} custom place${added !== 1 ? 's' : ''} to selection`, 'success');
    updateSelectionCount();
    // Refresh grid to show new cards
    renderDiscoveryScreen();
    setTimeout(() => {
        document.querySelectorAll('.place-card').forEach(card => {
            if (state.selectedPlaces.find(p => p.name === card.dataset.name)) card.classList.add('selected');
        });
    }, 50);
}

// ── Card detail button style (injected since it's inside img-wrap) ─
function injectCardDetailBtnStyle() {
    const style = document.createElement('style');
    style.textContent = `.card-detail-btn{position:absolute;top:8px;left:8px;background:rgba(0,0,0,0.55);backdrop-filter:blur(4px);border:none;border-radius:7px;color:#fff;font-size:13px;width:26px;height:26px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;z-index:2}.card-detail-btn:hover{background:rgba(99,102,241,.7)}`;
    document.head.appendChild(style);
}

// -- Init --
function injectCustomPasteModal() {
    if (document.getElementById('custom-paste-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'custom-paste-modal';
    modal.className = 'modal-overlay hidden';
    modal.innerHTML = [
        '<div class="modal-card" style="max-width:500px;width:100%;">',
        '<div class="modal-header"><div class="modal-title">📝 Paste Custom Places</div>',
        '<button class="modal-close" id="paste-modal-close">✕</button></div>',
        '<p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">',
        'Paste place names (one per line or comma-separated). They will be added to your selection.</p>',
        '<textarea id="custom-paste-input" class="input-field" style="min-height:140px;resize:vertical;font-size:13px;"',
        ' placeholder="Red Fort&#10;Qutub Minar&#10;India Gate"></textarea>',
        '<div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end;">',
        '<button class="btn btn-ghost btn-sm" id="paste-cancel-btn">Cancel</button>',
        '<button class="btn btn-primary btn-sm" id="paste-apply-btn">Add Places</button>',
        '</div></div>'
    ].join('');
    document.body.appendChild(modal);
    modal.querySelector('#paste-modal-close').addEventListener('click', closeCustomPaste);
    modal.querySelector('#paste-cancel-btn').addEventListener('click', closeCustomPaste);
    modal.querySelector('#paste-apply-btn').addEventListener('click', applyCustomPaste);
    modal.addEventListener('click', e => { if (e.target === modal) closeCustomPaste(); });

    // Inject paste button next to nearby search
    const searchBtn = document.getElementById('nearby-search-btn');
    if (searchBtn && !document.getElementById('custom-paste-btn')) {
        const btn = document.createElement('button');
        btn.id = 'custom-paste-btn';
        btn.className = 'btn btn-ghost btn-sm';
        btn.title = 'Paste a list of place names';
        btn.textContent = '📝 Paste List';
        btn.style.whiteSpace = 'nowrap';
        searchBtn.after(btn);
        btn.addEventListener('click', openCustomPaste);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadEnvKeys();
    loadConfig();
    applyTheme(currentTheme);
    injectCardDetailBtnStyle();
    initInputScreen();
    showScreen('screen-input');
    // Inject custom paste modal after all screens are set up
    injectCustomPasteModal();
});
