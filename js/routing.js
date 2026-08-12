// ============================================================
//  routing.js — Real road routing + transport cost/time model
//
//  Uses the public OSRM demo server for road geometry, distance and duration.
//  That server has no SLA and rate-limits, so every call degrades to a
//  straight-line estimate rather than failing the itinerary.
// ============================================================

import { haversineKm, fetchWithTimeout, mapLimit } from './util.js';

const OSRM_BASE = 'https://router.project-osrm.org/route/v1';
const ROUTE_TIMEOUT_MS = 9000;
const ROUTE_CONCURRENCY = 3;

/**
 * Transport modes. `profile` maps to an OSRM profile; the demo server reliably
 * serves `driving`, so walking/cycling fall back to speed-based estimates.
 */
export const TRANSPORT_MODES = {
    walk: { label: '🚶 Walking', profile: 'foot', kmh: 4.5, costPerKm: 0, base: 0, detour: 1.15 },
    transit: { label: '🚇 Public transport', profile: 'driving', kmh: 20, costPerKm: 3, base: 10, detour: 1.3 },
    cab: { label: '🚕 Taxi / ride-hailing', profile: 'driving', kmh: 24, costPerKm: 16, base: 50, detour: 1.25 },
    drive: { label: '🚗 Self-drive', profile: 'driving', kmh: 26, costPerKm: 9, base: 0, detour: 1.25 },
    mixed: { label: '🔀 Mixed', profile: 'driving', kmh: 22, costPerKm: 11, base: 25, detour: 1.25 },
};

export const DEFAULT_MODE = 'mixed';

const modeConfig = mode => TRANSPORT_MODES[mode] || TRANSPORT_MODES[DEFAULT_MODE];

let _osrmAvailable = true;   // flipped off after a hard failure, for the session

export function routingAvailable() { return _osrmAvailable; }

const hasCoords = p => Number.isFinite(p?.lat) && Number.isFinite(p?.lng);

// ── Straight-line fallback ────────────────────────────────────
/**
 * Estimate a leg without the network. Road distance is longer than the
 * crow-flies distance, so apply a per-mode detour factor.
 */
function estimateLeg(from, to, mode) {
    const cfg = modeConfig(mode);
    const straight = haversineKm(from, to);
    const km = straight * cfg.detour;
    return {
        km: Number(km.toFixed(2)),
        minutes: Math.max(1, Math.round((km / cfg.kmh) * 60)),
        geometry: null,
        estimated: true,
    };
}

// ── OSRM ──────────────────────────────────────────────────────
/**
 * One request per day: OSRM returns per-leg distance/duration for a whole
 * ordered list of waypoints, so a 5-stop day costs a single round trip.
 */
async function osrmRoute(points, mode) {
    const cfg = modeConfig(mode);
    const coords = points.map(p => `${p.lng},${p.lat}`).join(';');
    const url = `${OSRM_BASE}/${cfg.profile}/${coords}?overview=full&geometries=geojson&steps=false&annotations=false`;

    const res = await fetchWithTimeout(url, {}, ROUTE_TIMEOUT_MS);
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error(data.code || 'No route');

    const route = data.routes[0];
    return {
        legs: (route.legs || []).map(leg => ({
            km: Number((leg.distance / 1000).toFixed(2)),
            minutes: Math.max(1, Math.round(leg.duration / 60)),
            estimated: false,
        })),
        // GeoJSON is [lng,lat]; Leaflet wants [lat,lng].
        geometry: (route.geometry?.coordinates || []).map(([lng, lat]) => [lat, lng]),
        totalKm: Number((route.distance / 1000).toFixed(2)),
        totalMinutes: Math.max(1, Math.round(route.duration / 60)),
    };
}

// ── Cost model ────────────────────────────────────────────────
/**
 * @param {number} km
 * @param {string} mode
 * @param {number} travellers  transit is charged per head; a cab is shared
 */
export function estimateFare(km, mode, travellers = 1) {
    const cfg = modeConfig(mode);
    if (!cfg.costPerKm && !cfg.base) return 0;
    const perVehicle = cfg.base + km * cfg.costPerKm;
    const perHead = mode === 'transit';
    return Math.round(perHead ? perVehicle * Math.max(1, travellers) : perVehicle);
}

// ── Public API ────────────────────────────────────────────────
/**
 * Attach real travel legs to each day of an itinerary.
 *
 * Adds `travel` to every place after the first ({km, minutes, mode, fare}) and
 * `travelSummary` + `routeGeometry` to each day. Never throws: on any failure
 * the day still gets straight-line estimates.
 */
export async function attachRoutes(itinerary, { mode = DEFAULT_MODE, travellers = 1, stay = null } = {}) {
    const days = itinerary?.days || [];

    await mapLimit(days, ROUTE_CONCURRENCY, async day => {
        // The stay anchors the start of the day when we know where it is.
        const stops = [...(stay && hasCoords(stay) ? [stay] : []), ...day.places.filter(hasCoords)];
        if (stops.length < 2) {
            day.travelSummary = { km: 0, minutes: 0, fare: 0, mode, estimated: true, legs: 0 };
            day.routeGeometry = null;
            return;
        }

        let legs = null;
        let geometry = null;

        if (_osrmAvailable) {
            try {
                const routed = await osrmRoute(stops, mode);
                legs = routed.legs;
                geometry = routed.geometry;
            } catch (err) {
                console.warn('[routing] OSRM unavailable, estimating instead:', err.message);
                // A single failure is usually a rate limit — stop hammering it
                // for the rest of the session.
                if (/HTTP (429|5\d\d)|timed out/i.test(err.message)) _osrmAvailable = false;
            }
        }

        if (!legs) {
            legs = [];
            for (let i = 1; i < stops.length; i++) legs.push(estimateLeg(stops[i - 1], stops[i], mode));
        }

        // Walk the legs back onto the places. Leg 0 is stay→first place when a
        // stay exists, so the offset shifts by one.
        const offset = stay && hasCoords(stay) ? 1 : 0;
        let coordIdx = 0;
        day.places.forEach((place, idx) => {
            if (!hasCoords(place)) { place.travel = null; return; }
            const legIdx = coordIdx + offset - 1;
            place.travel = legIdx >= 0 && legs[legIdx]
                ? { ...legs[legIdx], mode, fare: estimateFare(legs[legIdx].km, mode, travellers) }
                : null;
            coordIdx++;
        });

        const totalKm = legs.reduce((s, l) => s + l.km, 0);
        const totalMin = legs.reduce((s, l) => s + l.minutes, 0);
        day.travelSummary = {
            km: Number(totalKm.toFixed(1)),
            minutes: totalMin,
            fare: estimateFare(totalKm, mode, travellers),
            mode,
            estimated: legs.some(l => l.estimated),
            legs: legs.length,
        };
        day.routeGeometry = geometry;
    });

    return itinerary;
}

/** "1 hr 25 min" / "40 min" */
export function formatDuration(minutes) {
    const m = Math.max(0, Math.round(minutes || 0));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h} hr ${rem} min` : `${h} hr`;
}
