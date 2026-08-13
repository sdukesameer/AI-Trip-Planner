// ============================================================
//  places-osm.js — Place discovery without an AI provider
//
//  Free AI tiers run out. When they do, the app used to simply stop working:
//  no places, no plan, nothing. But nothing about *finding* landmarks actually
//  requires a language model — OpenStreetMap has already mapped them, with
//  coordinates that are surveyed rather than recalled, which matters because
//  planner.js clusters on those coordinates.
//
//  So this is both the fallback when quota is gone AND the more accurate
//  source of geometry. The AI's real value is prose, not latitude.
//
//  Everything here is keyless and free: Nominatim, Overpass, Wikipedia.
// ============================================================

import { fetchWithTimeout, mapLimit } from './util.js';

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const WIKI_API = 'https://en.wikipedia.org/w/api.php';

// Public Overpass instances, tried in order. They are donated infrastructure
// with no SLA, so a single unreachable one must not break discovery.
const OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
];

const OVERPASS_TIMEOUT_MS = 12000;   // per mirror
// Hard ceiling on the whole lookup. Three mirrors times two box sizes is a
// worst case near two minutes, which reads to a user as a hung app — better to
// give up and say so than to keep a spinner turning.
const OVERPASS_BUDGET_MS = 30000;
const MAX_BBOX_SPAN = 0.9;           // ~100 km; an outer sanity bound on the extent
const NARROW_SPAN = 0.25;            // ~28 km; the tourist core, used when the wide box is refused

let _overpassBlockedUntil = 0;

// Landmarks do not move, and the public mirrors are donated infrastructure that
// is regularly busy. A month-long cache turns a flaky dependency into one that
// only has to succeed once per city.
const OSM_CACHE_PREFIX = 'atp-osm-';
const OSM_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function osmCacheGet(key) {
    try {
        const raw = localStorage.getItem(OSM_CACHE_PREFIX + key);
        if (!raw) return null;
        const { places, at } = JSON.parse(raw);
        if (!Array.isArray(places) || Date.now() - at > OSM_CACHE_TTL_MS) return null;
        return places;
    } catch { return null; }
}

function osmCacheSet(key, places) {
    try {
        localStorage.setItem(OSM_CACHE_PREFIX + key, JSON.stringify({ places, at: Date.now() }));
    } catch { /* cache is an optimisation */ }
}

// ── Geocoding ─────────────────────────────────────────────────
const _geoCache = new Map();

/** Photon: `extent` is [west, north, east, south], and may be absent. */
async function viaPhoton(location) {
    const res = await fetchWithTimeout(
        `${PHOTON}?q=${encodeURIComponent(location)}&limit=1`, {}, 9000);
    if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);

    const feature = (await res.json())?.features?.[0];
    if (!feature) throw new Error(`Could not find "${location}" on the map`);

    const [lng, lat] = feature.geometry?.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Geocoder returned no coordinates');

    const props = feature.properties || {};
    const extent = props.extent;
    const kind = String(props.osm_value || props.type || '');
    return Array.isArray(extent) && extent.length === 4
        ? { lat, lng, kind, west: extent[0], north: extent[1], east: extent[2], south: extent[3] }
        : { lat, lng, kind };
}

/** Nominatim: `boundingbox` is [south, north, west, east] as strings. */
async function viaNominatim(location) {
    const res = await fetchWithTimeout(
        `${NOMINATIM}?q=${encodeURIComponent(location)}&format=json&limit=1`, {}, 9000);
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);

    const first = (await res.json())?.[0];
    if (!first) throw new Error(`Could not find "${location}" on the map`);

    const lat = parseFloat(first.lat);
    const lng = parseFloat(first.lon);
    const kind = String(first.type || first.addresstype || '');
    const [south, north, west, east] = (first.boundingbox || []).map(Number);
    return [south, north, west, east].every(Number.isFinite)
        ? { lat, lng, kind, south, north, west, east }
        : { lat, lng, kind };
}

/**
 * Resolve a place name to a centre and a bounding box.
 *
 * Photon first, for two reasons: the app already uses it for autocomplete, so
 * it costs no new dependency, and Nominatim's rate-limit response carries no
 * CORS headers — which means going over its 1 req/sec budget surfaces in the
 * browser as an unexplained "Failed to fetch" rather than a 429.
 */
async function geocodeArea(location) {
    const key = location.toLowerCase().trim();
    if (_geoCache.has(key)) return _geoCache.get(key);

    let hit;
    try {
        hit = await viaPhoton(location);
    } catch (err) {
        console.warn('[osm] Photon failed, trying Nominatim:', err.message);
        hit = await viaNominatim(location);
    }

    const { lat, lng } = hit;
    let { south = lat - 0.15, north = lat + 0.15, west = lng - 0.15, east = lng + 0.15 } = hit;

    // A whole-state bounding box makes Overpass time out, so clamp the span
    // around the centre rather than refusing outright.
    const clamp = (lo, hi, centre) => (hi - lo <= MAX_BBOX_SPAN
        ? [lo, hi]
        : [centre - MAX_BBOX_SPAN / 2, centre + MAX_BBOX_SPAN / 2]);

    [south, north] = clamp(Math.min(south, north), Math.max(south, north), lat);
    [west, east] = clamp(Math.min(west, east), Math.max(west, east), lng);

    // A settlement's sights cluster around its centre; a region's do not.
    const compact = /^(city|town|village|hamlet|suburb|district|borough|municipality|neighbourhood|locality)$/i
        .test(hit.kind || '');

    const area = { lat, lng, compact, bbox: [south, west, north, east], label: location };
    _geoCache.set(key, area);
    return area;
}

// ── Overpass ──────────────────────────────────────────────────
/**
 * Values are restricted in the query itself rather than filtered afterwards:
 * an unrestricted `["tourism"]` is dominated by hotels and guest houses, and in
 * a city as densely mapped as Delhi that alone is enough to make the public
 * instances time out.
 */
function overpassQuery([s, w, n, e]) {
    const bbox = `${s},${w},${n},${e}`;
    return `[out:json][timeout:25];
(
  nwr["tourism"~"^(attraction|museum|viewpoint|zoo|theme_park|aquarium|gallery|artwork)$"]["name"](${bbox});
  nwr["historic"~"^(fort|castle|monument|memorial|ruins|archaeological_site|palace|church|tomb|city_gate|monastery)$"]["name"](${bbox});
  nwr["natural"~"^(beach|waterfall)$"]["name"](${bbox});
  nwr["amenity"="marketplace"]["name"](${bbox});
);
out center tags 500;`;
}

// Applied to the reply instead of the query. `tourism` in particular is mostly
// accommodation, which is not what anyone means by "places to visit".
const TOURISM_OK = /^(attraction|museum|viewpoint|zoo|theme_park|aquarium|gallery|artwork|picnic_site)$/;
const HISTORIC_SKIP = /^(boundary_stone|milestone|wayside_cross|wayside_shrine|highwater_mark|survey_point|charcoal_pile|tank|aircraft|locomotive|railway_car|ship|vehicle|optical_telegraph)$/;

function isVisitable(tags) {
    if (tags.tourism && TOURISM_OK.test(tags.tourism)) return true;
    if (tags.historic && !HISTORIC_SKIP.test(tags.historic)) return true;
    if (tags.natural === 'beach' || tags.natural === 'waterfall') return true;
    if (tags.amenity === 'marketplace') return true;
    return false;
}

/**
 * One pass over the mirrors for a single bounding box.
 *
 * A 504 is treated as a verdict on the query rather than on the server: it means
 * the area was too expensive to evaluate, and asking a second mirror the same
 * costly question just spends another timeout to be told the same thing. So a
 * 504 stops the loop immediately and lets the caller shrink the box.
 */
async function overpassOnce(bbox, deadline) {
    const body = new URLSearchParams({ data: overpassQuery(bbox) });
    let lastError;
    let throttled = false;

    for (const mirror of OVERPASS_MIRRORS) {
        const host = mirror.split('/')[2];
        if (Date.now() > deadline) {
            return { error: lastError || new Error('Overpass took too long'), timedOut: true };
        }
        try {
            const res = await fetchWithTimeout(mirror, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
            }, Math.min(OVERPASS_TIMEOUT_MS, Math.max(1000, deadline - Date.now())));

            if (res.status === 504) {
                return { error: new Error(`${host}: query too expensive (504)`), tooExpensive: true };
            }
            if (res.status === 429) {
                throttled = true;
                lastError = new Error(`${host}: rate limited (429)`);
                continue;
            }
            if (!res.ok) { lastError = new Error(`${host}: HTTP ${res.status}`); continue; }

            return { elements: (await res.json()).elements || [] };
        } catch (err) {
            lastError = err;
        }
    }
    return { error: lastError || new Error('All Overpass mirrors unavailable'), throttled };
}

/**
 * Query the area, choosing the box order from what we are looking at.
 *
 * No single bounding box suits every destination. A state-sized extent is fine
 * where mapping is sparse — the whole of Goa answers in about three seconds —
 * but Delhi is mapped so densely that half a degree times out while a quarter of
 * a degree returns in three.
 *
 * The geocoder already tells us which case we are in, so use it: a city gets the
 * tight box first, since its landmarks cluster in the centre anyway, while a
 * region gets the wide box first, because clamping a state to its centroid can
 * land inland and miss the entire coast.
 */
async function overpass(area) {
    if (Date.now() < _overpassBlockedUntil) throw new Error('Overpass is rate-limiting us');
    const deadline = Date.now() + OVERPASS_BUDGET_MS;

    const [s, w, n, e] = area.bbox;
    const half = NARROW_SPAN / 2;
    const narrow = [
        Math.max(s, area.lat - half), Math.max(w, area.lng - half),
        Math.min(n, area.lat + half), Math.min(e, area.lng + half),
    ];

    const oversized = (n - s > NARROW_SPAN) || (e - w > NARROW_SPAN);
    const attempts = !oversized ? [area.bbox]
        : area.compact ? [narrow, area.bbox]
            : [area.bbox, narrow];

    let last;
    for (const bbox of attempts) {
        const result = await overpassOnce(bbox, deadline);
        if (result.elements) return result.elements;
        last = result;
        console.warn(`[osm] Overpass declined ${bbox.map(v => v.toFixed(2)).join(',')}: ${result.error.message}`);
        if (result.throttled || result.timedOut) break;   // escalating would only cost more time
    }

    // Back off only when the mirrors actively pushed back. A slow query is not a
    // reason to lock out every other city for two minutes.
    if (last?.throttled) _overpassBlockedUntil = Date.now() + 120000;
    throw last.error;
}

// ── Classification & ranking ──────────────────────────────────
const CATEGORY_RULES = [
    [t => t.tourism === 'museum' || t.tourism === 'gallery', 'Museum'],
    [t => t.amenity === 'place_of_worship' || /church|tomb/.test(t.historic || ''), 'Religious'],
    [t => t.amenity === 'marketplace' || t.shop, 'Market'],
    [t => t.natural || t.leisure, 'Nature'],
    [t => t.tourism === 'zoo' || t.tourism === 'theme_park' || t.tourism === 'aquarium', 'Entertainment'],
    [t => t.historic, 'Heritage'],
    [t => t.tourism === 'viewpoint', 'Nature'],
    [() => true, 'Heritage'],
];

const categoryOf = tags => CATEGORY_RULES.find(([test]) => test(tags))[1];

const KIND_WEIGHT = {
    fort: 20, castle: 20, palace: 20, museum: 16, archaeological_site: 14,
    waterfall: 14, monument: 12, gallery: 10, attraction: 10, beach: 10,
    place_of_worship: 10, ruins: 10, tomb: 10, marketplace: 8, memorial: 6,
    viewpoint: 6, zoo: 12, theme_park: 12, aquarium: 10,
};

const kindOf = t => t.historic || t.tourism || t.natural || t.amenity || t.leisure || '';

/**
 * Notability score. There is no popularity metric in OSM, so this leans on
 * proxies for "someone thought this was worth documenting properly": a Wikidata
 * or Wikipedia link, a heritage listing, and how richly it is tagged overall.
 */
function notability(tags) {
    let score = 0;
    if (tags.wikidata) score += 50;
    if (tags.wikipedia) score += 30;
    if (tags.heritage) score += 25;
    if (tags.website || tags.image) score += 8;
    if (tags.description) score += 6;
    if (tags['name:en']) score += 4;
    score += Math.min(20, Object.keys(tags).length * 1.2);
    score += KIND_WEIGHT[kindOf(tags)] || 0;
    return score;
}

/** Generic or private-sounding names that are mapped but not visitable. */
const JUNK_NAME = /^(untitled|unnamed|no name|toilet|parking|atm|entrance|gate \d|bench)/i;

function toPlace(el, location) {
    const tags = el.tags || {};
    if (!isVisitable(tags)) return null;

    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const name = String(tags['name:en'] || tags.name || '').trim();
    if (!name || name.length > 90 || JUNK_NAME.test(name)) return null;

    return {
        name,
        location,
        shortDesc: String(tags.description || '').trim().slice(0, 300),
        category: categoryOf(tags),
        lat: Number(lat.toFixed(6)),
        lng: Number(lng.toFixed(6)),
        _score: notability(tags),
        _kind: kindOf(tags),
        _wikiTitle: (tags.wikipedia || '').startsWith('en:') ? tags.wikipedia.slice(3) : '',
    };
}

/**
 * Take the best places while keeping the categories varied.
 *
 * Pure score order returns eight museums for Delhi, which makes for a poor day
 * out and defeats the category filters, so this round-robins across categories
 * before topping up with whatever scored highest.
 */
function diversify(places, limit) {
    const byCategory = new Map();
    for (const p of places) {
        if (!byCategory.has(p.category)) byCategory.set(p.category, []);
        byCategory.get(p.category).push(p);
    }

    // Strongest categories first, so a city known for forts leads with forts.
    const groups = [...byCategory.values()].sort((a, b) => b[0]._score - a[0]._score);

    const picked = [];
    for (let round = 0; picked.length < limit && round < 40; round++) {
        let addedThisRound = false;
        for (const group of groups) {
            if (picked.length >= limit) break;
            if (!group[round]) continue;
            picked.push(group[round]);
            addedThisRound = true;
        }
        if (!addedThisRound) break;
    }
    return picked;
}

// ── Wikipedia enrichment ──────────────────────────────────────
/**
 * Add a one-line description to places that have none. Batched: one request
 * covers up to 20 titles, versus one search per place.
 */
async function addDescriptions(places) {
    const needing = places.filter(p => !p.shortDesc && p._wikiTitle);
    if (!needing.length) return places;

    const byTitle = new Map(needing.map(p => [p._wikiTitle, p]));
    const titles = [...byTitle.keys()].slice(0, 40);

    await mapLimit(chunk(titles, 20), 2, async batch => {
        try {
            const url = `${WIKI_API}?action=query&format=json&origin=*&prop=extracts&exintro=1`
                + `&explaintext=1&exsentences=2&redirects=1&titles=${encodeURIComponent(batch.join('|'))}`;
            const res = await fetchWithTimeout(url, {}, 9000);
            if (!res.ok) return;

            const data = await res.json();
            const pages = data?.query?.pages || {};
            // Redirects mean the returned title may differ from the one we asked for.
            const normalised = new Map((data?.query?.normalized || []).map(n => [n.to, n.from]));
            const redirects = new Map((data?.query?.redirects || []).map(r => [r.to, r.from]));

            for (const page of Object.values(pages)) {
                const extract = String(page.extract || '').trim();
                if (!extract) continue;
                const original = redirects.get(page.title) || normalised.get(page.title) || page.title;
                const place = byTitle.get(original) || byTitle.get(page.title);
                if (place) place.shortDesc = extract.slice(0, 280);
            }
        } catch { /* a description is a nicety; the coordinates are the point */ }
    });

    return places;
}

const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
};

// ── Public API ────────────────────────────────────────────────
/**
 * Discover notable places in a location without using any AI quota.
 *
 * @param {string} location
 * @param {{limit?: number, exclude?: string[], describe?: boolean}} opts
 * @returns {Promise<Array>} places shaped exactly like the AI discovery path
 */
export async function discoverPlacesOSM(location, { limit = 10, exclude = [], describe = true } = {}) {
    const cacheKey = location.toLowerCase().trim();
    const skip = new Set(exclude.map(n => String(n).toLowerCase().trim()));

    // Cached candidates are stored ranked and un-truncated, so exclusions and a
    // different `limit` can still be applied without another network round trip.
    let candidates = osmCacheGet(cacheKey);

    if (!candidates) {
        const area = await geocodeArea(location);
        const elements = await overpass(area);

        const seen = new Set();
        candidates = elements
            .map(el => toPlace(el, location))
            .filter(Boolean)
            .filter(p => {
                const key = p.name.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((a, b) => b._score - a._score)
            .slice(0, 60);

        if (!candidates.length) throw new Error(`No mapped attractions found near ${location}`);
        osmCacheSet(cacheKey, candidates);
    }

    const picked = diversify(candidates.filter(p => !skip.has(p.name.toLowerCase())), limit);
    if (describe) await addDescriptions(picked);

    return picked.map(({ _score, _kind, _wikiTitle, ...place }) => ({
        ...place,
        shortDesc: place.shortDesc || describeKind(_kind, location),
        source: 'osm',
    }));
}

/** A plain-language stand-in when neither OSM nor Wikipedia offered a description. */
function describeKind(kind, location) {
    const phrases = {
        fort: 'A historic fort', castle: 'A historic fort', palace: 'A historic palace',
        museum: 'A museum', gallery: 'An art gallery', archaeological_site: 'An archaeological site',
        monument: 'A landmark monument', memorial: 'A memorial', ruins: 'Historic ruins',
        tomb: 'A historic tomb', place_of_worship: 'A place of worship', beach: 'A beach',
        waterfall: 'A waterfall', viewpoint: 'A scenic viewpoint', marketplace: 'A local market',
        zoo: 'A zoo', theme_park: 'A theme park', aquarium: 'An aquarium', attraction: 'A visitor attraction',
    };
    return `${phrases[kind] || 'A notable spot'} in ${location}.`;
}

/** Whether the keyless path is currently usable (used to decide on a fallback). */
export function osmAvailable() {
    return Date.now() >= _overpassBlockedUntil;
}
