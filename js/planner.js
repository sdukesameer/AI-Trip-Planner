// ============================================================
//  planner.js — Deterministic zone-first trip planning
//
//  The model used to be *asked* to "group places within ~5 km" and nothing
//  checked whether it did. Here the geography is decided in code — cluster the
//  candidate places into one zone per day, order each day to minimise walking,
//  and only then hand the fixed assignment to the model to schedule and
//  describe. The model can no longer scatter a zone across the week.
// ============================================================

import { haversineKm, ymd, addDays } from './util.js';

/** Places per day implied by the pace preference. */
export const PACE_PLACES = { relaxed: 3, balanced: 4, packed: 6 };

const hasCoords = p => Number.isFinite(p?.lat) && Number.isFinite(p?.lng);

// ── Deterministic PRNG ────────────────────────────────────────
// Seeded so the same inputs always produce the same zones — re-planning the
// same trip shouldn't silently reshuffle the days.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function seedFrom(places) {
    return places.reduce((acc, p) => (acc * 31 + p.name.charCodeAt(0)) | 0, 7) >>> 0;
}

// ── Distance ──────────────────────────────────────────────────
/**
 * Planar approximation, good to well under a percent at city scale and far
 * cheaper than haversine inside a k-means inner loop.
 */
function planarDist(a, b) {
    const latScale = 111.32;                                   // km per degree of latitude
    const lngScale = latScale * Math.cos((a.lat * Math.PI) / 180);
    const dy = (a.lat - b.lat) * latScale;
    const dx = (a.lng - b.lng) * lngScale;
    return Math.hypot(dx, dy);
}

export function centroidOf(places) {
    const pts = places.filter(hasCoords);
    if (!pts.length) return null;
    return {
        lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
        lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length,
    };
}

/** Largest distance between any two places — how "spread out" a day is. */
export function spreadKm(places) {
    const pts = places.filter(hasCoords);
    let max = 0;
    for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
            max = Math.max(max, haversineKm(pts[i], pts[j]));
        }
    }
    return max;
}

// ── k-means with k-means++ seeding ────────────────────────────
function kmeans(points, k, rand, iterations = 40) {
    if (k <= 1) return [points];
    if (points.length <= k) return points.map(p => [p]);

    // k-means++ : first centre at random, each subsequent centre chosen with
    // probability proportional to squared distance from the nearest centre.
    const centres = [points[Math.floor(rand() * points.length)]];
    while (centres.length < k) {
        const weights = points.map(p => Math.min(...centres.map(c => planarDist(p, c) ** 2)));
        const total = weights.reduce((a, b) => a + b, 0);
        if (total === 0) break;
        let r = rand() * total;
        let idx = 0;
        while (r > weights[idx] && idx < weights.length - 1) { r -= weights[idx]; idx++; }
        centres.push(points[idx]);
    }

    let assignment = new Array(points.length).fill(0);
    let current = centres.map(c => ({ lat: c.lat, lng: c.lng }));

    for (let iter = 0; iter < iterations; iter++) {
        let moved = false;
        points.forEach((p, i) => {
            let best = 0, bestD = Infinity;
            current.forEach((c, ci) => {
                const d = planarDist(p, c);
                if (d < bestD) { bestD = d; best = ci; }
            });
            if (assignment[i] !== best) { assignment[i] = best; moved = true; }
        });

        current = current.map((c, ci) => {
            const members = points.filter((_, i) => assignment[i] === ci);
            return members.length ? centroidOf(members) : c;
        });

        if (!moved && iter > 0) break;
    }

    const clusters = current.map((_, ci) => points.filter((_, i) => assignment[i] === ci));
    return clusters.filter(c => c.length);
}

/**
 * Even out cluster sizes so no day gets 9 stops while another gets 1.
 * Moves the member furthest from its own centroid into the nearest cluster
 * that still has room.
 */
function balanceClusters(clusters, maxPerCluster) {
    if (!maxPerCluster || clusters.length < 2) return clusters;
    const result = clusters.map(c => [...c]);

    for (let pass = 0; pass < 60; pass++) {
        const overIdx = result.findIndex(c => c.length > maxPerCluster);
        if (overIdx === -1) break;

        const donor = result[overIdx];
        const donorCentre = centroidOf(donor);
        // Furthest-from-centre member is the one that least belongs here.
        let worst = 0, worstD = -1;
        donor.forEach((p, i) => {
            const d = planarDist(p, donorCentre);
            if (d > worstD) { worstD = d; worst = i; }
        });
        const moving = donor[worst];

        let target = -1, targetD = Infinity;
        result.forEach((c, ci) => {
            if (ci === overIdx || c.length >= maxPerCluster) return;
            const centre = centroidOf(c);
            const d = centre ? planarDist(moving, centre) : Infinity;
            if (d < targetD) { targetD = d; target = ci; }
        });
        if (target === -1) break;   // everything is full; leave it uneven

        donor.splice(worst, 1);
        result[target].push(moving);
    }
    return result;
}

// ── Route optimisation ────────────────────────────────────────
/** Nearest-neighbour tour from `start`, then 2-opt until no improvement. */
export function optimiseOrder(places, start = null) {
    const pts = places.filter(hasCoords);
    const noCoords = places.filter(p => !hasCoords(p));
    if (pts.length < 3) return [...pts, ...noCoords];

    const remaining = [...pts];
    const tour = [];
    let cursor = start && hasCoords(start) ? start : remaining[0];
    if (!start || !hasCoords(start)) { tour.push(remaining.shift()); cursor = tour[0]; }

    while (remaining.length) {
        let best = 0, bestD = Infinity;
        remaining.forEach((p, i) => {
            const d = planarDist(cursor, p);
            if (d < bestD) { bestD = d; best = i; }
        });
        cursor = remaining[best];
        tour.push(cursor);
        remaining.splice(best, 1);
    }

    // 2-opt: repeatedly reverse a segment when doing so shortens the tour.
    const legLength = t => {
        let total = start && hasCoords(start) ? planarDist(start, t[0]) : 0;
        for (let i = 1; i < t.length; i++) total += planarDist(t[i - 1], t[i]);
        return total;
    };

    let improved = true;
    let guard = 0;
    while (improved && guard++ < 50) {
        improved = false;
        for (let i = 0; i < tour.length - 1; i++) {
            for (let j = i + 1; j < tour.length; j++) {
                const candidate = [...tour.slice(0, i), ...tour.slice(i, j + 1).reverse(), ...tour.slice(j + 1)];
                if (legLength(candidate) < legLength(tour) - 1e-9) {
                    tour.splice(0, tour.length, ...candidate);
                    improved = true;
                }
            }
        }
    }

    return [...tour, ...noCoords];
}

/** Order zones into a sensible visiting sequence, starting nearest the anchor. */
function orderZones(zones, anchor) {
    const withCentres = zones.map(z => ({ zone: z, centre: centroidOf(z) })).filter(z => z.centre);
    const orphan = zones.filter(z => !centroidOf(z));
    if (!withCentres.length) return zones;

    const remaining = [...withCentres];
    const ordered = [];
    let cursor = anchor && hasCoords(anchor) ? anchor : remaining[0].centre;

    while (remaining.length) {
        let best = 0, bestD = Infinity;
        remaining.forEach((z, i) => {
            const d = planarDist(cursor, z.centre);
            if (d < bestD) { bestD = d; best = i; }
        });
        cursor = remaining[best].centre;
        ordered.push(remaining[best].zone);
        remaining.splice(best, 1);
    }
    return [...ordered, ...orphan];
}

// ── City grouping ─────────────────────────────────────────────
function cityOf(place, locations) {
    const loc = String(place.location || '').toLowerCase();
    const hit = locations.find(l => loc.includes(l.toLowerCase()) || l.toLowerCase().includes(loc));
    return hit || locations[0] || '';
}

/** Split the trip's days across cities, proportional to how many places each has. */
function allocateDays(cityBuckets, totalDays) {
    const cities = Object.keys(cityBuckets);
    if (cities.length <= 1) return { [cities[0] || '']: totalDays };
    if (totalDays <= cities.length) {
        // Fewer days than cities — one day each, dropping the thinnest cities.
        const ranked = cities.sort((a, b) => cityBuckets[b].length - cityBuckets[a].length);
        const out = {};
        ranked.slice(0, totalDays).forEach(c => { out[c] = 1; });
        return out;
    }

    const totalPlaces = cities.reduce((s, c) => s + cityBuckets[c].length, 0) || 1;
    const alloc = {};
    const want = {};
    cities.forEach(c => {
        alloc[c] = 1;                                     // everyone gets at least a day
        want[c] = (cityBuckets[c].length / totalPlaces) * totalDays - 1;
    });
    let left = totalDays - cities.length;

    // Hand each remaining day to whichever city is furthest short of its fair
    // share. Round-robin would give a 2-place city as many days as a 12-place one.
    while (left > 0) {
        const neediest = cities.reduce((a, b) => (want[b] > want[a] ? b : a));
        alloc[neediest]++;
        want[neediest] -= 1;
        left--;
    }
    return alloc;
}

// ── Main entry point ──────────────────────────────────────────
/**
 * Turn a flat list of candidate places into a fixed day-by-day plan.
 *
 * @param {object[]} places      candidates (ideally with lat/lng)
 * @param {object}   opts
 * @param {string}   opts.startDate  YYYY-MM-DD
 * @param {number}   opts.totalDays
 * @param {string[]} opts.locations  cities in the trip
 * @param {object}   [opts.stay]     {name, lat, lng} — day start/end anchor
 * @param {string}   [opts.pace]     relaxed | balanced | packed
 * @param {boolean}  [opts.autoMode] trim to the pace budget (auto) or keep all (manual)
 * @returns {{days: object[], stats: object}}
 */
export function buildZonePlan(places, opts) {
    const { startDate, totalDays, locations = [], stay = null, pace = 'balanced', autoMode = true } = opts;
    const perDay = PACE_PLACES[pace] || PACE_PLACES.balanced;
    const rand = mulberry32(seedFrom(places));

    // 1 — bucket by city
    const buckets = {};
    places.forEach(p => {
        const city = cityOf(p, locations);
        (buckets[city] = buckets[city] || []).push(p);
    });

    // 2 — split the trip's days between cities
    const dayAlloc = allocateDays(buckets, totalDays);
    const cityOrder = locations.filter(l => dayAlloc[l] > 0);
    Object.keys(dayAlloc).forEach(c => { if (!cityOrder.includes(c)) cityOrder.push(c); });

    const days = [];
    let dayCursor = 0;

    cityOrder.forEach(city => {
        const cityDays = dayAlloc[city] || 0;
        if (!cityDays) return;

        let pool = buckets[city] || [];
        // In auto mode keep the plan to the pace budget; the list is popularity
        // ordered, so trimming the tail drops the least-known places.
        if (autoMode && pool.length > cityDays * perDay) pool = pool.slice(0, cityDays * perDay);
        if (!pool.length) { dayCursor += cityDays; return; }

        const geo = pool.filter(hasCoords);
        const flat = pool.filter(p => !hasCoords(p));

        // 3 — cluster this city's places into one zone per day
        let zones;
        if (geo.length && cityDays > 1) {
            zones = balanceClusters(kmeans(geo, Math.min(cityDays, geo.length), rand), Math.ceil(pool.length / cityDays) + 1);
        } else {
            zones = geo.length ? [geo] : [];
        }
        while (zones.length < cityDays) zones.push([]);

        // 4 — visit zones in a sensible order, nearest the stay first
        zones = orderZones(zones, stay);

        // 5 — spread coordinate-less places evenly; they can't be clustered
        flat.forEach((p, i) => zones[i % zones.length].push(p));

        // 6 — order each day to minimise backtracking
        zones.slice(0, cityDays).forEach((zone, i) => {
            const ordered = optimiseOrder(zone, stay);
            const date = ymd(addDays(startDate, dayCursor + i));
            days.push({
                day: dayCursor + i + 1,
                date,
                location: city,
                places: ordered,
                zoneCentre: centroidOf(ordered),
                spreadKm: Number(spreadKm(ordered).toFixed(1)),
            });
        });
        dayCursor += cityDays;
    });

    // Any trailing days with nothing assigned still need to exist
    while (days.length < totalDays) {
        days.push({
            day: days.length + 1,
            date: ymd(addDays(startDate, days.length)),
            location: locations[0] || '',
            places: [],
            zoneCentre: null,
            spreadKm: 0,
        });
    }

    const planned = days.reduce((s, d) => s + d.places.length, 0);
    return {
        days: days.slice(0, totalDays),
        stats: {
            placesPlanned: planned,
            placesAvailable: places.length,
            withoutCoords: places.filter(p => !hasCoords(p)).length,
            worstSpreadKm: Math.max(0, ...days.map(d => d.spreadKm || 0)),
        },
    };
}

// ── Local scheduling (no AI) ──────────────────────────────────
//
// The geography, grouping and ordering are all computed here already. What the
// model adds is prose and opening hours — valuable, but not structural. So when
// every provider is out of quota we can still hand back a usable itinerary
// instead of an error screen.
//
// Nothing here is invented: times come from the traveller's own start time and
// typical visit lengths. Fields we genuinely cannot know (entry fees, opening
// hours, named restaurants) are left empty rather than guessed at, because a
// confidently wrong opening time is worse than a blank one.

/** Typical time on site, in minutes, by category. */
const VISIT_MINUTES = {
    Heritage: 120, Museum: 105, Religious: 60, Nature: 75,
    Market: 90, Entertainment: 120, Food: 60,
};
const DEFAULT_VISIT_MINUTES = 90;
const TRANSIT_MINUTES = 25;   // within a zone; routing.js replaces this with real legs

/** "10:00 AM" / "10:00" → minutes since midnight. */
function parseClock(value, fallback = 600) {
    const m = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(String(value || '').trim());
    if (!m) return fallback;
    let hours = Number(m[1]) % 12;
    if (!m[3]) hours = Number(m[1]) % 24;
    else if (m[3].toLowerCase() === 'pm') hours += 12;
    return Math.min(24 * 60 - 1, hours * 60 + Number(m[2]));
}

function formatClock(minutes) {
    const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
    const h24 = Math.floor(total / 60);
    const mins = String(total % 60).padStart(2, '0');
    const suffix = h24 < 12 ? 'AM' : 'PM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${mins} ${suffix}`;
}

function formatDuration(minutes) {
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const hourPart = `${hours} hr${hours === 1 ? '' : 's'}`;
    return rest ? `${hourPart} ${rest} min` : hourPart;
}

/** The category that best characterises a day, for its theme label. */
function dominantCategory(places) {
    const counts = {};
    places.forEach(p => { if (p.category) counts[p.category] = (counts[p.category] || 0) + 1; });
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : '';
}

const THEME_BY_CATEGORY = {
    Heritage: 'Heritage & landmarks', Museum: 'Museums & galleries',
    Religious: 'Temples & sacred sites', Nature: 'Parks & the outdoors',
    Market: 'Markets & street life', Entertainment: 'Sights & entertainment',
    Food: 'Food & flavours',
};

/**
 * Build a complete itinerary from a zone plan without calling any AI.
 *
 * @param {{days: Array}} plan       output of buildZonePlan
 * @param {{prefs?: object, locations?: string[]}} opts
 * @returns {{summary: string, days: Array, offline: boolean}}
 */
export function scheduleLocally(plan, { prefs = {}, locations = [] } = {}) {
    const startMinutes = parseClock(prefs.startTime, 600);

    const days = (plan.days || []).filter(d => d.places.length).map(planDay => {
        let clock = startMinutes;
        let lunchInserted = false;
        const meals = [];

        const places = planDay.places.map((place, index) => {
            if (index > 0) clock += TRANSIT_MINUTES;

            // Slot lunch into the natural gap rather than mid-visit — but never
            // before the day has started, or an afternoon start begins with lunch.
            if (!lunchInserted && index > 0 && clock >= 12 * 60 + 30) {
                meals.push({
                    type: 'Lunch',
                    time: formatClock(clock),
                    suggestion: 'A local spot near your next stop',
                    area: planDay.location || '',
                    approxCost: '',
                });
                clock += 60;
                lunchInserted = true;
            }

            const minutes = VISIT_MINUTES[place.category] || DEFAULT_VISIT_MINUTES;
            const arrivalTime = formatClock(clock);
            clock += minutes;

            return {
                ...place,
                desc: place.shortDesc || '',
                category: place.category || '',
                arrivalTime,
                visitDuration: formatDuration(minutes),
                // Left blank on purpose: a guessed opening time or entry fee
                // would look authoritative and be wrong.
                openingHours: '',
                closedDays: '',
                entryFee: '',
                bestTime: '',
                closedNote: '',
                accessibility: '',
                commute_from_prev: null,
            };
        });

        const category = dominantCategory(places);
        return {
            day: planDay.day,
            date: planDay.date,
            location: planDay.location,
            theme: THEME_BY_CATEGORY[category] || 'Exploring',
            zoneName: '',
            spreadKm: planDay.spreadKm,
            meals,
            places,
        };
    });

    const where = locations.filter(Boolean).join(' & ') || 'your destinations';
    return {
        summary: `${days.length}-day trip across ${where}, grouped by area to keep travel between stops short.`,
        days,
        offline: true,
    };
}

// ── Validation ────────────────────────────────────────────────
/**
 * Sanity-check a finished itinerary and describe what looks wrong, so the UI
 * can tell the user rather than quietly shipping a bad plan.
 */
export function validateItinerary(itinerary, { maxSpreadKm = 25 } = {}) {
    const issues = [];
    const seen = new Map();

    (itinerary?.days || []).forEach((day, idx) => {
        const spread = spreadKm(day.places || []);
        if (spread > maxSpreadKm) {
            issues.push({
                day: day.day ?? idx + 1,
                type: 'spread',
                message: `Day ${day.day ?? idx + 1} spans ~${spread.toFixed(0)} km — expect a lot of travel.`,
            });
        }
        (day.places || []).forEach(p => {
            const key = String(p.name || '').toLowerCase();
            if (seen.has(key)) {
                issues.push({ day: day.day, type: 'duplicate', message: `"${p.name}" appears on more than one day.` });
            } else seen.set(key, day.day);
        });
        if (!day.places?.length) {
            issues.push({ day: day.day ?? idx + 1, type: 'empty', message: `Day ${day.day ?? idx + 1} has no places.` });
        }
    });

    return issues;
}

/** Re-run ordering on an edited day (used after drag/move edits). */
export function reoptimiseDay(day, stay = null) {
    day.places = optimiseOrder(day.places || [], stay);
    day.spreadKm = Number(spreadKm(day.places).toFixed(1));
    return day;
}
