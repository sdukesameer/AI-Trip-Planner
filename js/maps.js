// ============================================================
//  maps.js — Leaflet / OpenStreetMap integration
// ============================================================

let map = null;
let markers = [];
let polylines = [];

const DAY_COLORS = [
    '#3B82F6', // Day 1 — Blue
    '#10B981', // Day 2 — Green
    '#F59E0B', // Day 3 — Amber
    '#EF4444', // Day 4 — Red
    '#8B5CF6', // Day 5 — Purple
    '#EC4899', // Day 6 — Pink
    '#06B6D4', // Day 7 — Cyan
    '#F97316', // Day 8 — Orange
    '#84CC16', // Day 9 — Lime
    '#6366F1', // Day 10 — Indigo
];

export function getDayColor(dayIndex) {
    return DAY_COLORS[dayIndex % DAY_COLORS.length];
}

/**
 * Initialise the Leaflet map in the given container.
 * Uses CartoDB dark tiles to match the app's dark theme.
 */
export function initMap(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return Promise.reject(new Error('Map container not found'));

    // If map already exists, remove it first
    if (map) {
        map.remove();
        map = null;
    }

    // Clear the container's inner HTML to avoid Leaflet re-init errors
    container.innerHTML = '';

    return new Promise((resolve) => {
        map = L.map(containerId, {
            zoomControl: true,
            attributionControl: true,
        }).setView([20.5937, 78.9629], 5); // Default: center of India

        // Dark-themed CartoDB tiles (free, no API key)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 19,
        }).addTo(map);

        // Force Leaflet to recalculate size after container becomes visible
        setTimeout(() => {
            map.invalidateSize();
            resolve(map);
        }, 300);
    });
}

export function clearMarkers() {
    markers.forEach(m => map && map.removeLayer(m));
    polylines.forEach(p => map && map.removeLayer(p));
    markers = [];
    polylines = [];
}

/**
 * Create a numbered circle marker icon for Leaflet.
 */
function createNumberedIcon(number, color) {
    return L.divIcon({
        className: 'leaflet-numbered-icon',
        html: `<div style="
      background: ${color};
      color: #fff;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 12px;
      font-family: 'Inter', sans-serif;
      border: 2.5px solid #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    ">${number}</div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
        popupAnchor: [0, -18],
    });
}

/**
 * Plot all itinerary days on the map with colour-coded markers & route lines.
 * @param {Object} itinerary - The itinerary object with `days` array.
 * @param {Function} onMarkerClick - Callback(dayIdx, placeIdx) when a marker is clicked.
 */
export function plotItinerary(itinerary, onMarkerClick) {
    clearMarkers();
    if (!map) return;

    const allLatLngs = [];

    itinerary.days.forEach((day, dayIdx) => {
        const color = getDayColor(dayIdx);
        const dayCoords = [];

        day.places.forEach((place, placeIdx) => {
            if (!place.lat || !place.lng) return;

            const latlng = [place.lat, place.lng];
            allLatLngs.push(latlng);
            dayCoords.push(latlng);

            const marker = L.marker(latlng, {
                icon: createNumberedIcon(placeIdx + 1, color),
                zIndexOffset: 100,
            }).addTo(map);

            // Popup content
            const popupContent = `
        <div style="font-family:Inter,sans-serif;max-width:220px;">
          <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${place.name}</div>
          <div style="font-size:12px;color:#6B7280;margin-bottom:6px;">Day ${day.day} · ${day.theme || ''}</div>
          <div style="font-size:12px;color:#374151;">${place.desc?.slice(0, 100) || ''}${(place.desc?.length || 0) > 100 ? '...' : ''}</div>
        </div>
      `;
            marker.bindPopup(popupContent, {
                className: 'dark-popup',
                maxWidth: 250,
            });

            marker.on('click', () => {
                if (onMarkerClick) onMarkerClick(dayIdx, placeIdx);
            });

            markers.push(marker);
        });

        // Draw route line connecting places of the same day
        if (dayCoords.length > 1) {
            const polyline = L.polyline(dayCoords, {
                color: color,
                weight: 3,
                opacity: 0.6,
                dashArray: '8, 6',
            }).addTo(map);
            polylines.push(polyline);
        }
    });

    // Fit map to all markers
    if (allLatLngs.length > 0) {
        const bounds = L.latLngBounds(allLatLngs);
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    }
}
