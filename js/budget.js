// ============================================================
//  budget.js — Currency handling and full trip cost breakdown
//
//  The old estimator only counted ticket prices and assumed rupees. This
//  covers tickets, food, local transport and stay, scaled by group size and
//  expressed in the traveller's chosen currency.
// ============================================================

export const CURRENCIES = {
    INR: { symbol: '₹', code: 'INR', locale: 'en-IN', label: '₹ Indian Rupee' },
    USD: { symbol: '$', code: 'USD', locale: 'en-US', label: '$ US Dollar' },
    EUR: { symbol: '€', code: 'EUR', locale: 'de-DE', label: '€ Euro' },
    GBP: { symbol: '£', code: 'GBP', locale: 'en-GB', label: '£ British Pound' },
    AED: { symbol: 'AED', code: 'AED', locale: 'en-AE', label: 'AED UAE Dirham' },
    JPY: { symbol: '¥', code: 'JPY', locale: 'ja-JP', label: '¥ Japanese Yen' },
    AUD: { symbol: 'A$', code: 'AUD', locale: 'en-AU', label: 'A$ Australian Dollar' },
    SGD: { symbol: 'S$', code: 'SGD', locale: 'en-SG', label: 'S$ Singapore Dollar' },
};

export const DEFAULT_CURRENCY = 'INR';

export const currencyOf = code => CURRENCIES[code] || CURRENCIES[DEFAULT_CURRENCY];

/** Format an amount without decimals — these are all rough estimates. */
export function formatMoney(amount, code = DEFAULT_CURRENCY) {
    const c = currencyOf(code);
    const n = Math.round(Number(amount) || 0);
    try {
        return new Intl.NumberFormat(c.locale, {
            style: 'currency', currency: c.code, maximumFractionDigits: 0, minimumFractionDigits: 0,
        }).format(n);
    } catch {
        return `${c.symbol}${n.toLocaleString()}`;
    }
}

/**
 * Pull the first number out of a fee string.
 * Handles "₹1,200", "Rs. 50", "$12.50", "40–100", "Free", "" and nonsense.
 * Returns 0 for anything free or unparseable.
 */
export function parseAmount(value) {
    const s = String(value ?? '').trim();
    if (!s) return 0;
    if (/^(free|no charge|nil|none|n\/?a)\b/i.test(s)) return 0;

    // Strip digit-group separators before parsing. Repeated because Indian
    // grouping chains them ("12,50,000") and a single global pass leaves the
    // later commas behind.
    let cleaned = s;
    let previous;
    do {
        previous = cleaned;
        cleaned = cleaned.replace(/(\d),(\d{2,3})(?!\d)/, '$1$2');
    } while (cleaned !== previous);

    const match = cleaned.match(/\d+(?:\.\d+)?/);
    if (!match) return 0;
    const n = Number(match[0]);
    return Number.isFinite(n) && n >= 0 && n < 10_000_000 ? n : 0;
}

// Per-person daily food, and per-night stay, by budget tier.
// Indexed in INR then converted with rough purchasing-power ratios — these are
// deliberately coarse "order of magnitude" figures, not live rates.
const DAILY_FOOD_INR = { shoestring: 400, moderate: 1200, comfort: 3000 };
const NIGHTLY_STAY_INR = { shoestring: 900, moderate: 3500, comfort: 12000 };
const INR_PER_UNIT = { INR: 1, USD: 84, EUR: 91, GBP: 106, AED: 23, JPY: 0.55, AUD: 55, SGD: 62 };

const convertFromINR = (inr, code) => inr / (INR_PER_UNIT[code] || 1);

/**
 * Whole-trip cost estimate.
 *
 * @param {object} itinerary
 * @param {object} opts
 * @param {string} opts.currency    currency code
 * @param {number} opts.travellers
 * @param {string} opts.budget      shoestring | moderate | comfort
 * @param {boolean} opts.includeStay
 */
export function estimateTripBudget(itinerary, opts = {}) {
    const {
        currency = DEFAULT_CURRENCY,
        travellers = 1,
        budget = 'moderate',
        includeStay = true,
    } = opts;

    const heads = Math.max(1, Number(travellers) || 1);
    const days = itinerary?.days || [];
    const nights = Math.max(0, days.length - 1);

    const foodPerPersonPerDay = Math.round(convertFromINR(DAILY_FOOD_INR[budget] ?? DAILY_FOOD_INR.moderate, currency));
    const stayPerNight = Math.round(convertFromINR(NIGHTLY_STAY_INR[budget] ?? NIGHTLY_STAY_INR.moderate, currency));

    const perDay = days.map(day => {
        // Tickets are per person.
        const tickets = (day.places || []).reduce((sum, p) => sum + parseAmount(p.entryFee), 0) * heads;

        // Prefer the model's own meal estimates when it gave them.
        const mealCosts = (day.meals || []).map(m => parseAmount(m.approxCost)).filter(n => n > 0);
        const food = mealCosts.length
            ? mealCosts.reduce((a, b) => a + b, 0) * heads
            : foodPerPersonPerDay * heads;

        // Routing already accounts for group size where it matters.
        const transport = Math.round(day.travelSummary?.fare || 0);

        return {
            day: day.day,
            date: day.date,
            tickets: Math.round(tickets),
            food: Math.round(food),
            transport,
            total: Math.round(tickets + food + transport),
        };
    });

    const totals = perDay.reduce(
        (acc, d) => ({
            tickets: acc.tickets + d.tickets,
            food: acc.food + d.food,
            transport: acc.transport + d.transport,
        }),
        { tickets: 0, food: 0, transport: 0 }
    );

    const stay = includeStay ? stayPerNight * nights : 0;
    const grandTotal = totals.tickets + totals.food + totals.transport + stay;

    return {
        currency,
        travellers: heads,
        nights,
        perDay,
        breakdown: [
            { key: 'tickets', label: '🎟️ Entry tickets', amount: totals.tickets },
            { key: 'food', label: '🍽️ Food', amount: totals.food },
            { key: 'transport', label: '🚕 Local transport', amount: totals.transport },
            ...(includeStay ? [{ key: 'stay', label: '🏨 Stay', amount: stay, note: `${nights} night${nights === 1 ? '' : 's'}` }] : []),
        ],
        total: grandTotal,
        perPerson: Math.round(grandTotal / heads),
        // Ticket totals come from real listed prices; the rest are modelled.
        confidence: totals.tickets > 0 ? 'partial' : 'estimated',
    };
}
