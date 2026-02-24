// ============================================================
//  maps.js — Leaflet / OpenStreetMap integration
// ============================================================

let map = null;
let markersGrid = [];    // markersGrid[dayIdx][placeIdx] = L.marker
let polylinesByDay = []; // polylinesByDay[dayIdx] = L.polyline
let tileLayer = null;
let currentTheme = 'dark';
let _imageCache = {};

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
export function initMap(containerId, theme = 'dark') {
    currentTheme = theme;
    const container = document.getElementById(containerId);
    if (!container) return Promise.reject(new Error('Map container not found'));

    // Fully destroy previous map instance if it exists
    if (map) {
        try { map.off(); map.remove(); } catch { /* ignore */ }
        map = null;
    }
    // Clear stale marker/polyline refs so clearMarkers() doesn't try to remove from old map
    markersGrid = [];
    polylinesByDay = [];
    container.innerHTML = '';

    return new Promise((resolve) => {
        map = L.map(containerId, { zoomControl: true, attributionControl: true })
            .setView([20.5937, 78.9629], 5);

        tileLayer = L.tileLayer(TILES[currentTheme], {
            attribution: TILE_ATTR, subdomains: 'abcd', maxZoom: 19,
        }).addTo(map);

        setTimeout(() => { try { map.invalidateSize(); } catch { /* ignore */ } resolve(map); }, 300);
    });
}

// ── Switch map tiles for theme ────────────────────────────────
export function setMapTheme(theme) {
    currentTheme = theme;
    if (!map || !tileLayer) return;
    try {
        map.removeLayer(tileLayer);
        tileLayer = L.tileLayer(TILES[theme], {
            attribution: TILE_ATTR, subdomains: 'abcd', maxZoom: 19,
        }).addTo(map);
    } catch { /* ignore if map torn down */ }
}

// ── Clear all markers/polylines (null-safe) ───────────────────
export function clearMarkers() {
    markersGrid.forEach(dayMarkers => {
        dayMarkers.forEach(m => {
            if (!m || !map) return;
            try { map.removeLayer(m); } catch { /* marker already removed or map gone */ }
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
                 <span class="pin-num">${number}</span>
               </div>
               <div class="pin-tip" style="border-top-color:${color};"></div>`,
        iconSize: [32, 44],
        iconAnchor: [16, 44],
        popupAnchor: [0, -46],
    });
}

// ── Build rich popup HTML ─────────────────────────────────────
function buildPopup(place, day, color, locations = []) {
    const img = _imageCache[place.name] || '';
    const imgHtml = img
        ? `<img src="${img}" data-popup-img style="width:100%;height:110px;object-fit:cover;border-radius:8px 8px 0 0;display:block;cursor:zoom-in;" title="Click for details">`
        : '';
    const city = place.location || locations[0] || '';
    const gmapQ = encodeURIComponent([place.name, city].filter(Boolean).join(' '));
    const gmapUrl = `https://www.google.com/maps/search/?api=1&query=${gmapQ}`;
    const gmapBtn = `<a href="${gmapUrl}" target="_blank" rel="noopener"
        style="display:inline-block;margin-top:8px;padding:4px 12px;background:${color};color:#fff;border-radius:999px;font-size:11px;text-decoration:none;font-weight:600;">
        🗺️ Google Maps</a>`;
    // "Details" button triggers place-modal via custom event
    const detailBtn = `<button data-place-detail='${JSON.stringify(place).replace(/'/g, "&#39;")}'
    style="display:inline-block;margin-top:8px;margin-left:6px;padding:4px 12px;background:transparent;color:${color};border:1.5px solid ${color};border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;">
    ℹ️ Details</button>`;

    const arrTime = place.arrivalTime ? `<span style="font-size:11px;font-weight:700;color:${color};">${place.arrivalTime}</span>  ` : '';
    const dur = place.visitDuration ? `<span style="font-size:10px;color:#888;">⌛ ${place.visitDuration}</span>` : '';

    return `<div style="font-family:Inter,sans-serif;min-width:200px;max-width:250px;">
      ${imgHtml}
      <div style="padding:10px 12px 10px;">
        <div style="font-weight:800;font-size:13px;margin-bottom:3px;">${arrTime}${place.name}</div>
        <div style="font-size:11px;color:#888;margin-bottom:4px;">Day ${day.day} · ${day.theme || ''} ${dur}</div>
        ${place.openingHours ? `<div style="font-size:11px;color:#aaa;">⏰ ${place.openingHours}</div>` : ''}
        ${place.entryFee ? `<div style="font-size:11px;color:#aaa;">💰 ${place.entryFee}</div>` : ''}
        ${place.desc ? `<div style="font-size:11px;color:#aaa;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${place.desc}</div>` : ''}
        ${place.closedNote ? `<div style="font-size:11px;color:#f59e0b;margin-top:4px;">⚠️ ${place.closedNote}</div>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:4px;">${gmapBtn}${detailBtn}</div>
      </div>
    </div>`;
}

// ── Plot full itinerary ───────────────────────────────────────
export function plotItinerary(itinerary, imageCache, onMarkerClick, locations = []) {
    _imageCache = imageCache || {};
    clearMarkers();
    if (!map) return;

    if (!map._detailListenerAdded) {
        map._detailListenerAdded = true;
        document.addEventListener('click', e => {
            const btn = e.target.closest('[data-place-detail]');
            if (!btn) return;
            try {
                const place = JSON.parse(btn.getAttribute('data-place-detail'));
                window.dispatchEvent(new CustomEvent('map-place-detail', { detail: JSON.stringify(place) }));
            } catch { /* ignore */ }
        });
    }

    const allLatLngs = [];

    itinerary.days.forEach((day, dayIdx) => {
        const color = getDayColor(dayIdx);
        const dayMarkers = [];
        const dayCoords = [];

        day.places.forEach((place, placeIdx) => {
            if (!place.lat || !place.lng) return;
            const latlng = [place.lat, place.lng];
            allLatLngs.push(latlng);
            dayCoords.push(latlng);

            let marker;
            try {
                marker = L.marker(latlng, {
                    icon: createPinIcon(placeIdx + 1, color),
                    zIndexOffset: 100 + placeIdx,
                }).addTo(map);

                marker.bindPopup(buildPopup(place, day, color, locations), {
                    className: 'dark-popup',
                    maxWidth: 270,
                    minWidth: 200,
                });

                marker.on('click', () => { if (onMarkerClick) onMarkerClick(dayIdx, placeIdx); });
                dayMarkers.push(marker);
            } catch (err) {
                console.warn('[maps] Failed to add marker for', place.name, err.message);
            }
        });

        markersGrid.push(dayMarkers);

        let polyline = null;
        if (dayCoords.length > 1) {
            try {
                polyline = L.polyline(dayCoords, {
                    color, weight: 3, opacity: 0.65, dashArray: '8, 6',
                }).addTo(map);
            } catch { /* ignore */ }
        }
        polylinesByDay.push(polyline);
    });

    if (allLatLngs.length > 0) {
        try {
            map.fitBounds(L.latLngBounds(allLatLngs), { padding: [40, 40], maxZoom: 15 });
        } catch { /* ignore */ }
    }
}

// ── Focus a single day (dim others) ──────────────────────────
export function focusDay(dayIdx) {
    markersGrid.forEach((dayMarkers, dIdx) => {
        dayMarkers.forEach(marker => {
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

    const dayMarkers = markersGrid[dayIdx] || [];
    if (dayMarkers.length > 0) {
        try {
            const bounds = L.latLngBounds(dayMarkers.map(m => m.getLatLng()));
            map.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 });
        } catch { /* ignore */ }
    }
}

// ── Reset all focus ───────────────────────────────────────────
export function resetFocus() {
    markersGrid.forEach(dayMarkers => {
        dayMarkers.forEach(marker => {
            try {
                const el = marker.getElement();
                if (el) { el.style.opacity = '1'; el.style.transform = ''; }
            } catch { /* ignore */ }
        });
    });
    polylinesByDay.forEach(pl => {
        if (pl) { try { pl.setStyle({ opacity: 0.65 }); } catch { /* ignore */ } }
    });
    // Reset to full bounds
    const all = markersGrid.flatMap(d => d.map(m => { try { return m.getLatLng(); } catch { return null; } }).filter(Boolean));
    if (all.length > 0 && map) {
        try { map.fitBounds(L.latLngBounds(all), { padding: [40, 40], maxZoom: 15 }); } catch { /* ignore */ }
    }
}

// ── Focus a specific place marker ────────────────────────────
export function focusPlace(dayIdx, placeIdx) {
    const marker = markersGrid[dayIdx]?.[placeIdx];
    if (marker && map) {
        try {
            map.panTo(marker.getLatLng(), { animate: true, duration: 0.5 });
            setTimeout(() => { try { marker.openPopup(); } catch { /* ignore */ } }, 400);
        } catch { /* ignore */ }
    }
}
