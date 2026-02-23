// ============================================================
//  app.js — State manager & screen router
// ============================================================

import { fetchFamousPlaces, fetchPlaceImages, generateItinerary, getLastProvider } from './api.js';
import { initMap, plotItinerary, getDayColor } from './maps.js';
import { downloadAsText, downloadAsPDF, copyToClipboard } from './download.js';

// ── Try to load env keys (injected by Netlify build) ──────────
let ENV_KEYS = {};

async function loadEnvKeys() {
    try {
        const envModule = await import('./env.js');
        if (envModule?.ENV_KEYS) ENV_KEYS = envModule.ENV_KEYS;
    } catch {
        // env.js doesn't exist locally — that's fine
    }
}

// ── Global State ─────────────────────────────────────────────
const state = {
    locations: [],
    startDate: '',
    endDate: '',
    places: [],         // raw array from API
    imageCache: {},     // { "place name": "url" }
    autoMode: false,
    selectedPlaces: [], // array of place objects
    itinerary: null,
    aiProvider: '',     // which AI model generated the itinerary
    config: {
        geminiKey: '',
        groqKey: '',
    }
};

// ── Screen management ─────────────────────────────────────────
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Progress bar ──────────────────────────────────────────────
const STAGES = [
    'Fetching famous places…',
    'Loading place images…',
    'Building smart itinerary…',
    'Rendering map & results…'
];

function showProgress() {
    document.getElementById('progress-overlay').classList.remove('hidden');
    setProgress(0, STAGES[0]);
}

function setProgress(step, label) {
    const pct = Math.round(((step) / STAGES.length) * 100);
    document.getElementById('progress-bar-fill').style.width = pct + '%';
    document.getElementById('progress-pct').textContent = pct + '%';
    document.getElementById('progress-label').textContent = label;
    document.getElementById('progress-step').textContent = `Step ${step + 1} of ${STAGES.length}`;

    // Update stage dots
    document.querySelectorAll('.stage-dot').forEach((dot, idx) => {
        dot.classList.toggle('done', idx < step);
        dot.classList.toggle('active', idx === step);
        dot.classList.remove('pending');
        if (idx > step) dot.classList.add('pending');
    });
}

function hideProgress() {
    document.getElementById('progress-overlay').classList.add('hidden');
    setProgress(0, '');
    const badge = document.getElementById('ai-model-badge');
    if (badge) badge.style.display = 'none';
}

function showAIModelBadge(providerName) {
    const badge = document.getElementById('ai-model-badge');
    if (badge) {
        badge.textContent = `🤖 Using: ${providerName}`;
        badge.style.display = 'block';
    }
}

// ── Toast notifications ───────────────────────────────────────
function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    document.getElementById('toast-container').appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, 3500);
}

// ── Input Screen ──────────────────────────────────────────────
function initInputScreen() {
    // Location chips
    const input = document.getElementById('location-input');
    const chipBox = document.getElementById('chip-box');

    function addLocation(val) {
        const v = val.trim();
        if (!v || state.locations.includes(v)) return;
        state.locations.push(v);
        renderChips();
        input.value = '';
    }

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addLocation(input.value.replace(',', ''));
        }
    });

    document.getElementById('add-location-btn').addEventListener('click', () => {
        addLocation(input.value);
    });

    function renderChips() {
        chipBox.innerHTML = '';
        state.locations.forEach((loc, idx) => {
            const chip = document.createElement('div');
            chip.className = 'chip';
            chip.innerHTML = `<span>${loc}</span><button class="chip-remove" data-idx="${idx}">×</button>`;
            chipBox.appendChild(chip);
        });
        chipBox.querySelectorAll('.chip-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                state.locations.splice(Number(btn.dataset.idx), 1);
                renderChips();
            });
        });
    }

    // Date pickers — default to next week
    const today = new Date();
    const nextWk = new Date(today); nextWk.setDate(today.getDate() + 7);
    const twoWks = new Date(today); twoWks.setDate(today.getDate() + 14);
    document.getElementById('start-date').valueAsDate = nextWk;
    document.getElementById('end-date').valueAsDate = twoWks;

    // Plan button
    document.getElementById('plan-btn').addEventListener('click', startPlanning);

    // Settings modal
    document.getElementById('settings-btn').addEventListener('click', () => {
        loadSavedKeys();
        document.getElementById('settings-modal').classList.remove('hidden');
    });
    document.getElementById('close-settings').addEventListener('click', () => {
        document.getElementById('settings-modal').classList.add('hidden');
    });
    document.getElementById('save-settings-btn').addEventListener('click', saveKeys);

    loadSavedKeys();
}

function loadSavedKeys() {
    const saved = JSON.parse(localStorage.getItem('tripplanner_config') || '{}');
    // Env keys take priority, then localStorage, then empty
    state.config = {
        geminiKey: ENV_KEYS.geminiKey || saved.geminiKey || '',
        groqKey: ENV_KEYS.groqKey || saved.groqKey || '',
    };
    document.getElementById('key-gemini').value = state.config.geminiKey || '';
    document.getElementById('key-groq').value = state.config.groqKey || '';
}

function saveKeys() {
    state.config.geminiKey = document.getElementById('key-gemini').value.trim();
    state.config.groqKey = document.getElementById('key-groq').value.trim();
    localStorage.setItem('tripplanner_config', JSON.stringify(state.config));
    document.getElementById('settings-modal').classList.add('hidden');
    showToast('API keys saved ✓', 'success');
}

// ── Planning Flow ─────────────────────────────────────────────
async function startPlanning() {
    if (!state.config.geminiKey && !state.config.groqKey) {
        showToast('Please add at least one API key in Settings ⚙️', 'error');
        return;
    }
    if (state.locations.length === 0) {
        showToast('Add at least one location 📍', 'error');
        return;
    }
    const sd = document.getElementById('start-date').value;
    const ed = document.getElementById('end-date').value;
    if (!sd || !ed || new Date(ed) < new Date(sd)) {
        showToast('Please set valid trip dates 📅', 'error');
        return;
    }
    state.startDate = sd;
    state.endDate = ed;

    showProgress();

    const onSwitch = (name) => {
        showAIModelBadge(name);
        showToast(`Trying ${name}…`, 'info');
    };

    try {
        // Step 1 — Fetch famous places
        setProgress(0, STAGES[0]);
        const places = await fetchFamousPlaces(state.config, state.locations, onSwitch);
        state.places = places;

        // Step 2 — Fetch images (Unsplash, no API needed)
        setProgress(1, STAGES[1]);
        const names = [...new Set(places.map(p => p.name))];
        const imgs = await fetchPlaceImages(names);
        Object.assign(state.imageCache, imgs);

        hideProgress();
        renderDiscoveryScreen();
        showScreen('screen-discovery');

    } catch (err) {
        hideProgress();
        showToast('Error: ' + err.message, 'error');
        console.error(err);
    }
}

// ── Discovery Screen ──────────────────────────────────────────
function renderDiscoveryScreen() {
    const grid = document.getElementById('discovery-grid');
    grid.innerHTML = '';

    // Group by location
    state.locations.forEach(loc => {
        const locPlaces = state.places.filter(p => p.location?.toLowerCase() === loc.toLowerCase() ||
            p.location?.toLowerCase().includes(loc.toLowerCase()));
        if (!locPlaces.length) return;

        const section = document.createElement('div');
        section.className = 'discovery-section';
        section.innerHTML = `<h3 class="section-title">📍 ${loc}</h3>`;
        const cardRow = document.createElement('div');
        cardRow.className = 'place-card-grid';

        locPlaces.forEach(place => {
            const imgUrl = state.imageCache[place.name] || `https://source.unsplash.com/400x300/?${encodeURIComponent(place.name)},landmark`;
            const card = document.createElement('div');
            card.className = 'place-card';
            card.dataset.name = place.name;
            card.innerHTML = `
        <div class="place-img-wrap">
          <img src="${imgUrl}" alt="${place.name}" loading="lazy" onerror="this.src='https://source.unsplash.com/400x300/?india,landmark'">
          <div class="card-check">✓</div>
          <div class="category-badge">${place.category || ''}</div>
        </div>
        <div class="card-body">
          <div class="card-name">${place.name}</div>
          <div class="card-desc">${place.shortDesc || ''}</div>
        </div>`;
            card.addEventListener('click', () => togglePlaceSelection(card, place));
            cardRow.appendChild(card);
        });
        section.appendChild(cardRow);
        grid.appendChild(section);
    });

    // Auto toggle — replace to clear old listeners
    const autoToggle = document.getElementById('auto-toggle');
    autoToggle.checked = state.autoMode;
    const newToggle = autoToggle.cloneNode(true);
    newToggle.checked = state.autoMode;
    autoToggle.replaceWith(newToggle);
    newToggle.addEventListener('change', () => {
        state.autoMode = newToggle.checked;
        document.getElementById('discovery-grid').classList.toggle('auto-mode', state.autoMode);
        updateSelectionCount();
    });

    // Reset and rebind buttons
    function rebind(id, fn) {
        const el = document.getElementById(id);
        if (!el) return;
        const clone = el.cloneNode(true);
        el.replaceWith(clone);
        clone.addEventListener('click', fn);
    }
    rebind('generate-btn', generateItineraryFlow);
    rebind('back-to-input', () => showScreen('screen-input'));
    updateSelectionCount();
}

function togglePlaceSelection(card, place) {
    if (state.autoMode) return;
    const idx = state.selectedPlaces.findIndex(p => p.name === place.name);
    if (idx === -1) {
        state.selectedPlaces.push(place);
        card.classList.add('selected');
    } else {
        state.selectedPlaces.splice(idx, 1);
        card.classList.remove('selected');
    }
    updateSelectionCount();
}

function updateSelectionCount() {
    const count = state.autoMode ? 'Auto' : state.selectedPlaces.length;
    const el = document.getElementById('selection-count');
    if (el) el.textContent = state.autoMode ? '🤖 AI will choose the best places' : `${count} place${count !== 1 ? 's' : ''} selected`;
}

// ── Itinerary Generation ──────────────────────────────────────
async function generateItineraryFlow() {
    if (!state.autoMode && state.selectedPlaces.length === 0) {
        showToast('Select at least one place, or enable Auto mode 🤖', 'error');
        return;
    }
    showProgress();

    const onSwitch = (name) => {
        showAIModelBadge(name);
        showToast(`Trying ${name}…`, 'info');
    };

    try {
        setProgress(2, STAGES[2]);
        const itin = await generateItinerary(
            state.config,
            state.locations,
            state.startDate,
            state.endDate,
            state.autoMode ? state.places : state.selectedPlaces,
            state.autoMode,
            onSwitch
        );
        state.itinerary = itin;
        state.aiProvider = getLastProvider();

        // Fetch images for any new places not already cached
        const allPlaceNames = itin.days.flatMap(d => d.places.map(p => p.name));
        const missing = [...new Set(allPlaceNames.filter(n => !state.imageCache[n]))];
        if (missing.length) {
            const newImgs = await fetchPlaceImages(missing);
            Object.assign(state.imageCache, newImgs);
        }

        setProgress(3, STAGES[3]);
        renderItineraryScreen();
        showScreen('screen-itinerary');

        // Init Leaflet map (always works — no API key needed)
        try {
            await initMap('map-container');
            plotItinerary(itin, (dayIdx, placeIdx) => {
                expandDay(dayIdx);
                const dayEl = document.querySelector(`[data-day="${dayIdx}"]`);
                if (dayEl) dayEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        } catch (mapErr) {
            console.warn('Map rendering failed:', mapErr);
        }

        hideProgress();

    } catch (err) {
        hideProgress();
        showToast('Error generating itinerary: ' + err.message, 'error');
        console.error(err);
    }
}

// ── Itinerary Screen ──────────────────────────────────────────
const DAY_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316', '#84CC16', '#6366F1'];

function renderItineraryScreen() {
    const itin = state.itinerary;
    const accordion = document.getElementById('itinerary-accordion');
    accordion.innerHTML = '';

    // Summary bar
    const totalPlaces = itin.days.reduce((s, d) => s + d.places.length, 0);
    document.getElementById('itin-summary').textContent =
        `${itin.days.length} Days · ${state.locations.join(' & ')} · ${totalPlaces} Places`;

    // Show which AI model generated this
    const providerTag = document.getElementById('ai-provider-tag');
    if (providerTag && state.aiProvider) {
        providerTag.style.display = 'inline-block';
        providerTag.innerHTML = `<span style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:999px;padding:4px 12px;font-size:11px;color:var(--accent);">🤖 Generated by ${state.aiProvider}</span>`;
    }

    itin.days.forEach((day, dayIdx) => {
        const color = DAY_COLORS[dayIdx % DAY_COLORS.length];
        const item = document.createElement('div');
        item.className = 'accordion-item';
        item.dataset.day = dayIdx;

        item.innerHTML = `
      <div class="accordion-header" style="border-left: 4px solid ${color}">
        <div class="accordion-header-left">
          <div class="day-badge" style="background:${color}">Day ${day.day}</div>
          <div class="accordion-title-block">
            <div class="accordion-day-title">${day.theme || 'Explore'}</div>
            <div class="accordion-day-meta">${day.date}${day.location ? ' · ' + day.location : ''} · ${day.places.length} places</div>
          </div>
        </div>
        <div class="accordion-chevron">▾</div>
      </div>
      <div class="accordion-body hidden">
        ${day.places.map((place, pIdx) => renderPlaceRow(place, pIdx, color)).join('')}
      </div>
    `;

        item.querySelector('.accordion-header').addEventListener('click', () => {
            const isOpen = !item.querySelector('.accordion-body').classList.contains('hidden');
            if (isOpen) collapseDay(dayIdx); else expandDay(dayIdx);
        });

        accordion.appendChild(item);
    });

    // Expand Day 1 by default
    expandDay(0);

    // Rebind all buttons (prevent duplicate listeners on re-render)
    function rebindItin(id, fn) {
        const el = document.getElementById(id);
        if (!el) return;
        const clone = el.cloneNode(true);
        el.replaceWith(clone);
        clone.addEventListener('click', fn);
    }
    rebindItin('download-txt-btn', () => downloadAsText(state.itinerary, state.locations, state.startDate, state.endDate));
    rebindItin('download-pdf-btn', async () => await downloadAsPDF(state.itinerary, state.locations, state.startDate, state.endDate));
    rebindItin('copy-btn', async () => {
        await copyToClipboard(state.itinerary, state.locations, state.startDate, state.endDate);
        showToast('Copied to clipboard! 📋', 'success');
    });
    rebindItin('back-to-discovery', () => showScreen('screen-discovery'));
    rebindItin('new-trip-btn', () => {
        state.itinerary = null;
        state.selectedPlaces = [];
        showScreen('screen-input');
    });

    // Populate day legend
    const legend = document.getElementById('day-legend');
    if (legend) {
        legend.innerHTML = '';
        itin.days.forEach((day, idx) => {
            const color = DAY_COLORS[idx % DAY_COLORS.length];
            const item = document.createElement('div');
            item.className = 'day-legend-item';
            item.innerHTML = `<div class="day-dot" style="background:${color}"></div><span>Day ${day.day}${day.location ? ' · ' + day.location : ''}</span>`;
            legend.appendChild(item);
        });
    }
}

function renderPlaceRow(place, pIdx, dayColor) {
    const img = state.imageCache[place.name] ||
        `https://source.unsplash.com/160x120/?${encodeURIComponent(place.name)},landmark`;
    const commute = place.commute_from_prev;
    const commuteHTML = (pIdx > 0 && commute) ? `
    <div class="commute-row">
      ${commute.walk && commute.walk !== 'N/A' ? `<span class="commute-badge walk">🚶 ${commute.walk}</span>` : ''}
      ${commute.cab && commute.cab !== 'N/A' ? `<span class="commute-badge cab">🚕 ${commute.cab}</span>` : ''}
      ${commute.metro && commute.metro !== 'N/A' ? `<span class="commute-badge metro">🚇 ${commute.metro}</span>` : ''}
    </div>` : '';

    return `
    ${commuteHTML}
    <div class="place-row">
      <div class="place-row-num" style="background:${dayColor}22;color:${dayColor};">${pIdx + 1}</div>
      <img class="place-row-img" src="${img}" alt="${place.name}"
           onerror="this.src='https://source.unsplash.com/160x120/?india,landmark'" loading="lazy">
      <div class="place-row-info">
        <div class="place-row-name">${place.name}</div>
        ${place.openingHours || place.entryFee ? `
          <div class="place-row-meta">
            ${place.openingHours ? `<span>⏰ ${place.openingHours}</span>` : ''}
            ${place.entryFee ? `<span>💰 ${place.entryFee}</span>` : ''}
          </div>` : ''}
        <div class="place-row-desc">${place.desc || ''}</div>
      </div>
    </div>`;
}

function expandDay(dayIdx) {
    document.querySelectorAll('.accordion-item').forEach((item, idx) => {
        const body = item.querySelector('.accordion-body');
        const chevron = item.querySelector('.accordion-chevron');
        if (idx === dayIdx) {
            body.classList.remove('hidden');
            chevron.style.transform = 'rotate(180deg)';
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

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    await loadEnvKeys();
    loadSavedKeys();
    initInputScreen();
    showScreen('screen-input');
});
