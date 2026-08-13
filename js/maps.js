// ============================================================
//  maps.js — Leaflet / OpenStreetMap integration
// ============================================================

import { esc, safeUrl } from './util.js';

let map = null;
let markersGrid = [];    // markersGrid[dayIdx][placeIdx] = L.marker | null
let polylinesByDay = []; // polylinesByDay[dayIdx] = L.polyline | null
let tileLayer = null;
let stayMarker = null;
let currentTheme = 'dark';
let _imageCache = {};
let _detailListenerAdded = false;   // module-level: the map object is recreated per plot

const DAY_COLORS = [
    '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6',
    '#EC4899', '#06B6D4', '#F97316', '#84CC16', '#6366F1',
];

const TILES = {
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>';

export function getDayColor(dayIndex) { return DAY_COLORS[dayIndex % DAY_COLORS.length]; }

// ── Init map ─────────────────────────────────────────────────
// Leaflet comes from a CDN, and CDNs occasionally fail or are blocked by an
// extension. One missing script shouldn't cost the user their map, so wait
// briefly for the original tag and then retry from the other host the CSP
// already permits.
const LEAFLET_FALLBACK = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js';
let _leafletLoader = null;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const tag = document.createElement('script');
        tag.src = src;
        tag.crossOrigin = '';
        tag.onload = resolve;
        tag.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(tag);
    });
}

async function ensureLeaflet() {
    if (typeof L !== 'undefined') return;

    // The tag may simply still be in flight.
    for (let waited = 0; waited < 3000 && typeof L === 'undefined'; waited += 100) {
        await new Promise(r => setTimeout(r, 100));
    }
    if (typeof L !== 'undefined') return;

    _leafletLoader = _leafletLoader || loadScript(LEAFLET_FALLBACK);
    await _leafletLoader;

    if (typeof L === 'undefined') {
        throw new Error('Map library failed to load. Check your connection and reload.');
    }
    console.warn('[maps] Leaflet recovered from the fallback CDN');
}

export async function initMap(containerId, theme = 'dark') {
    await ensureLeaflet();
    currentTheme = theme;
    const container = document.getElementById(containerId);
    if (!container) return Promise.reject(new Error('Map container not found'));

    // Fully destroy previous map instance if it exists
    if (map) {
        try { map.off(); map.remove(); } catch { /* ignore */ }
        map = null;
    }
    markersGrid = [];
    polylinesByDay = [];
    stayMarker = null;
    container.innerHTML = '';

    return new Promise((resolve, reject) => {
        try {
            map = L.map(containerId, { zoomControl: true, attributionControl: true })
                .setView([20.5937, 78.9629], 5);

            tileLayer = L.tileLayer(TILES[currentTheme] || TILES.dark, {
                attribution: TILE_ATTR, subdomains: 'abcd', maxZoom: 19,
            }).addTo(map);

            setTimeout(() => { try { map.invalidateSize(); } catch { /* ignore */ } resolve(map); }, 300);
        } catch (err) {
            reject(err);
        }
    });
}

/** Recompute size after a layout change (screen switch, panel resize). */
export function refreshMapSize() {
    if (!map) return;
    try { map.invalidateSize(); } catch { /* ignore */ }
}

// ── Switch map tiles for theme ────────────────────────────────
export function setMapTheme(theme) {
    currentTheme = theme;
    if (!map || !tileLayer) return;
    try {
        map.removeLayer(tileLayer);
        tileLayer = L.tileLayer(TILES[theme] || TILES.dark, {
            attribution: TILE_ATTR, subdomains: 'abcd', maxZoom: 19,
        }).addTo(map);
    } catch { /* ignore if map torn down */ }
}

// ── Clear all markers/polylines (null-safe) ───────────────────
export function clearMarkers() {
    if (stayMarker && map) {
        try { map.removeLayer(stayMarker); } catch { /* ignore */ }
    }
    stayMarker = null;
    markersGrid.forEach(dayMarkers => {
        dayMarkers.forEach(m => {
            if (!m || !map) return;
            try { map.removeLayer(m); } catch { /* already removed */ }
        });
    });
    polylinesByDay.forEach(p => {
        if (!p || !map) return;
        try { map.removeLayer(p); } catch { /* ignore */ }
    });
    markersGrid = [];
    polylinesByDay = [];
}

// ── Pin-drop icon ─────────────────────────────────────────────
function createPinIcon(number, color) {
    return L.divIcon({
        className: 'leaflet-pin-icon',
        html: `<div class="pin-body" style="background:${color};box-shadow:0 4px 14px ${color}66;">
                 <span class="pin-num">${esc(number)}</span>
               </div>
               <div class="pin-tip" style="border-top-color:${color};"></div>`,
        iconSize: [32, 44],
        iconAnchor: [16, 44],
        popupAnchor: [0, -46],
    });
}

// ── Build rich popup HTML ─────────────────────────────────────
// Everything interpolated here comes from the model, so it is escaped.
function buildPopup(place, day, color, locations = [], dayIdx, placeIdx) {
    const img = safeUrl(_imageCache[place.name] || '');
    const imgHtml = img
        ? `<img src="${esc(img)}" alt="${esc(place.name)}" data-popup-img style="width:100%;height:110px;object-fit:cover;border-radius:8px 8px 0 0;display:block;cursor:zoom-in;" title="Click for details">`
        : '';
    const city = place.location || locations[0] || '';
    const gmapQ = encodeURIComponent([place.name, city].filter(Boolean).join(' '));
    const gmapUrl = `https://www.google.com/maps/search/?api=1&query=${gmapQ}`;
    const gmapBtn = `<a href="${gmapUrl}" target="_blank" rel="noopener"
        style="display:inline-block;margin-top:8px;padding:4px 12px;background:${color};color:#fff;border-radius:999px;font-size:11px;text-decoration:none;font-weight:600;">
        🗺️ Google Maps</a>`;
    // Reference the place by index instead of serialising it into an attribute.
    const detailBtn = `<button type="button" data-place-detail data-day-idx="${dayIdx}" data-place-idx="${placeIdx}"
        style="display:inline-block;margin-top:8px;margin-left:6px;padding:4px 12px;background:transparent;color:${color};border:1.5px solid ${color};border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;">
        ℹ️ Details</button>`;

    const arrTime = place.arrivalTime ? `<span style="font-size:11px;font-weight:700;color:${color};">${esc(place.arrivalTime)}</span>&nbsp;&nbsp;` : '';
    const dur = place.visitDuration ? `<span style="font-size:10px;color:#888;">⌛ ${esc(place.visitDuration)}</span>` : '';

    return `<div style="font-family:Inter,sans-serif;min-width:200px;max-width:250px;">
      ${imgHtml}
      <div style="padding:10px 12px 10px;">
        <div style="font-weight:800;font-size:13px;margin-bottom:3px;">${arrTime}${esc(place.name)}</div>
        <div style="font-size:11px;color:#888;margin-bottom:4px;">Day ${esc(day.day)} · ${esc(day.theme || '')} ${dur}</div>
        ${place.openingHours ? `<div style="font-size:11px;color:#aaa;">⏰ ${esc(place.openingHours)}</div>` : ''}
        ${place.entryFee ? `<div style="font-size:11px;color:#aaa;">💰 ${esc(place.entryFee)}</div>` : ''}
        ${place.desc ? `<div style="font-size:11px;color:#aaa;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(place.desc)}</div>` : ''}
        ${place.closedNote ? `<div style="font-size:11px;color:#f59e0b;margin-top:4px;">⚠️ ${esc(place.closedNote)}</div>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:4px;">${gmapBtn}${detailBtn}</div>
      </div>
    </div>`;
}

// ── Stay / hotel marker ───────────────────────────────────────
function createStayIcon() {
    return L.divIcon({
        className: 'leaflet-stay-icon',
        html: `<div class="stay-pin" title="Your stay">🏨</div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
        popupAnchor: [0, -18],
    });
}

// ── Plot full itinerary ───────────────────────────────────────
export function plotItinerary(itinerary, imageCache, onMarkerClick, locations = [], stay = null) {
    _imageCache = imageCache || {};
    clearMarkers();
    if (!map || !itinerary?.days) return;

    // Bound once for the lifetime of the module — `map` is recreated on every
    // generation, so a flag stored on it would re-add this listener each time.
    if (!_detailListenerAdded) {
        _detailListenerAdded = true;
        document.addEventListener('click', e => {
            const btn = e.target.closest('[data-place-detail]');
            const popupImg = e.target.closest('[data-popup-img]');
            const target = btn || popupImg;
            if (!target) return;
            const holder = btn || popupImg.closest('.leaflet-popup-content')?.querySelector('[data-place-detail]');
            if (!holder) return;
            window.dispatchEvent(new CustomEvent('map-place-detail', {
                detail: { dayIdx: Number(holder.dataset.dayIdx), placeIdx: Number(holder.dataset.placeIdx) },
            }));
        });
    }

    const allLatLngs = [];

    itinerary.days.forEach((day, dayIdx) => {
        const color = getDayColor(dayIdx);
        const dayMarkers = [];
        const dayCoords = [];

        (day.places || []).forEach((place, placeIdx) => {
            // Push a null placeholder for coordinate-less places so that
            // markersGrid[dayIdx][placeIdx] always lines up with the accordion rows.
            if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng)) {
                dayMarkers.push(null);
                return;
            }
            const latlng = [place.lat, place.lng];
            allLatLngs.push(latlng);
            dayCoords.push(latlng);

            try {
                const marker = L.marker(latlng, {
                    icon: createPinIcon(placeIdx + 1, color),
                    zIndexOffset: 100 + placeIdx,
                    keyboard: true,
                    title: place.name,
                    alt: `Day ${day.day} stop ${placeIdx + 1}: ${place.name}`,
                }).addTo(map);

                marker.bindPopup(buildPopup(place, day, color, locations, dayIdx, placeIdx), {
                    className: 'dark-popup', maxWidth: 270, minWidth: 200,
                });
                marker.on('click', () => { if (onMarkerClick) onMarkerClick(dayIdx, placeIdx); });
                dayMarkers.push(marker);
            } catch (err) {
                console.warn('[maps] Failed to add marker for', place.name, err.message);
                dayMarkers.push(null);
            }
        });

        markersGrid.push(dayMarkers);

        // Prefer the real road geometry from the router; the dashed straight
        // line is the fallback that says "this is only an approximation".
        let polyline = null;
        const road = Array.isArray(day.routeGeometry) && day.routeGeometry.length > 1 ? day.routeGeometry : null;
        if (road) {
            try {
                polyline = L.polyline(road, { color, weight: 4, opacity: 0.75, lineJoin: 'round' }).addTo(map);
                road.forEach(pt => allLatLngs.push(pt));
            } catch { /* ignore */ }
        } else if (dayCoords.length > 1) {
            try {
                polyline = L.polyline(dayCoords, { color, weight: 3, opacity: 0.6, dashArray: '8, 6' }).addTo(map);
            } catch { /* ignore */ }
        }
        polylinesByDay.push(polyline);
    });

    // The stay sits outside the day loop — it belongs to the whole trip.
    if (stay && Number.isFinite(stay.lat) && Number.isFinite(stay.lng)) {
        try {
            stayMarker = L.marker([stay.lat, stay.lng], { icon: createStayIcon(), zIndexOffset: 50 })
                .addTo(map)
                .bindPopup(`<div style="padding:10px 12px;font-family:Inter,sans-serif;">
                    <div style="font-weight:800;font-size:13px;">🏨 ${esc(stay.name)}</div>
                    <div style="font-size:11px;color:#888;">Your stay — each day starts and ends here</div>
                </div>`, { className: 'dark-popup' });
            allLatLngs.push([stay.lat, stay.lng]);
        } catch { /* ignore */ }
    }

    if (allLatLngs.length > 0) {
        try {
            map.fitBounds(L.latLngBounds(allLatLngs), { padding: [40, 40], maxZoom: 15 });
        } catch { /* ignore */ }
    }
    return markersGrid.flat().filter(Boolean).length;
}

// ── Focus a single day (dim others) ──────────────────────────
export function focusDay(dayIdx) {
    markersGrid.forEach((dayMarkers, dIdx) => {
        dayMarkers.forEach(marker => {
            if (!marker) return;
            try {
                const el = marker.getElement();
                if (!el) return;
                el.style.opacity = dIdx === dayIdx ? '1' : '0.2';
                el.style.transform = el.style.transform.replace(/scale\([^)]+\)/g, '');
                if (dIdx !== dayIdx) el.style.transform += ' scale(0.8)';
            } catch { /* ignore */ }
        });
    });
    polylinesByDay.forEach((pl, dIdx) => {
        if (pl) { try { pl.setStyle({ opacity: dIdx === dayIdx ? 0.7 : 0.1 }); } catch { /* ignore */ } }
    });

    const dayMarkers = (markersGrid[dayIdx] || []).filter(Boolean);
    if (dayMarkers.length > 0 && map) {
        try {
            map.fitBounds(L.latLngBounds(dayMarkers.map(m => m.getLatLng())), { padding: [60, 60], maxZoom: 15 });
        } catch { /* ignore */ }
    }
}

// ── Reset all focus ───────────────────────────────────────────
export function resetFocus() {
    markersGrid.forEach(dayMarkers => {
        dayMarkers.forEach(marker => {
            if (!marker) return;
            try {
                const el = marker.getElement();
                if (el) { el.style.opacity = '1'; el.style.transform = ''; }
            } catch { /* ignore */ }
        });
    });
    polylinesByDay.forEach(pl => {
        if (pl) { try { pl.setStyle({ opacity: 0.65 }); } catch { /* ignore */ } }
    });

    const all = markersGrid.flat().filter(Boolean)
        .map(m => { try { return m.getLatLng(); } catch { return null; } })
        .filter(Boolean);
    if (all.length > 0 && map) {
        try { map.fitBounds(L.latLngBounds(all), { padding: [40, 40], maxZoom: 15 }); } catch { /* ignore */ }
    }
}

// ── Focus a specific place marker ────────────────────────────
export function focusPlace(dayIdx, placeIdx) {
    const marker = markersGrid[dayIdx]?.[placeIdx];
    if (!marker || !map) return false;
    try {
        map.panTo(marker.getLatLng(), { animate: true, duration: 0.5 });
        setTimeout(() => { try { marker.openPopup(); } catch { /* ignore */ } }, 400);
        return true;
    } catch { return false; }
}
