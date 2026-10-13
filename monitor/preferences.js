import { matchKey } from './values.js';
import { NOTIFY_TYPES } from './changes.js';

// User interests and alert preferences. A user who follows nothing sees everything that passes their
// filters (city, dates, price, sources); a user who follows something needs at least one interest match.

export function defaultPreferences(id, name = id) {
  return {
    id, name,
    follows: { artists: [], teams: [], categories: [], venues: [], events: [] },
    cities: [],
    date_from: null,
    date_to: null,
    max_price: null,
    currency: 'GBP',
    notify_types: [...NOTIFY_TYPES],
    sources: [],          // empty = all sources
    channels: ['local'],
  };
}

const list = v => (Array.isArray(v) ? v : String(v ?? '').split(',')).map(s => String(s).trim()).filter(Boolean).slice(0, 100);

export function validatePreferences(input, existing) {
  const errors = [];
  const p = { ...existing, follows: { ...existing.follows } };
  if (input.name !== undefined) p.name = String(input.name).slice(0, 80) || existing.name;
  for (const k of ['artists', 'teams', 'categories', 'venues', 'events']) if (input.follows?.[k] !== undefined) p.follows[k] = list(input.follows[k]);
  if (input.cities !== undefined) p.cities = list(input.cities);
  if (input.sources !== undefined) p.sources = list(input.sources);
  for (const k of ['date_from', 'date_to']) {
    if (input[k] === undefined) continue;
    if (input[k] === null || input[k] === '') p[k] = null;
    else if (Number.isNaN(Date.parse(input[k]))) errors.push(`${k} is not a date`);
    else p[k] = new Date(input[k]).toISOString();
  }
  if (p.date_from && p.date_to && p.date_from > p.date_to) errors.push('date_from is after date_to');
  if (input.max_price !== undefined) {
    if (input.max_price === null || input.max_price === '') p.max_price = null;
    else if (!(Number(input.max_price) >= 0)) errors.push('max_price must be a positive number');
    else p.max_price = Number(input.max_price);
  }
  if (input.currency !== undefined) {
    if (!/^[A-Z]{3}$/.test(String(input.currency).toUpperCase())) errors.push('currency must be a 3-letter code');
    else p.currency = String(input.currency).toUpperCase();
  }
  if (input.notify_types !== undefined) {
    const t = list(input.notify_types);
    const bad = t.filter(x => !NOTIFY_TYPES.includes(x));
    if (bad.length) errors.push(`unknown notify types: ${bad.join(', ')}`);
    p.notify_types = t.filter(x => NOTIFY_TYPES.includes(x));
  }
  return { ok: !errors.length, errors, preferences: p };
}

const contains = (hay, needle) => {
  const h = matchKey(hay);
  const n = matchKey(needle);
  return !!n && (` ${h} `).includes(` ${n} `);
};

// → { match, reasons: [why it matched], notes: [caveats], excluded: reason|null }
export function matchEvent(user, ev) {
  const reasons = [];
  const notes = [];
  const f = user.follows ?? {};
  for (const a of f.artists ?? []) if ((ev.artists ?? []).some(x => contains(x, a)) || contains(ev.title, a)) reasons.push(`artist: ${a}`);
  for (const t of f.teams ?? []) if (contains(ev.title, t)) reasons.push(`team: ${t}`);
  for (const c of f.categories ?? []) if ((ev.categories ?? []).some(x => contains(x, c))) reasons.push(`category: ${c}`);
  for (const v of f.venues ?? []) if (contains(ev.venue_name, v)) reasons.push(`venue: ${v}`);
  if ((f.events ?? []).includes(ev.id)) reasons.push('followed event');
  const followsSomething = Object.values(f).some(a => a?.length);

  const no = excluded => ({ match: false, reasons, notes, excluded });
  if (followsSomething && !reasons.length) return no('no followed artist, team, category, venue or event');
  if (user.sources?.length && !user.sources.includes(ev.source)) return no(`source ${ev.source} not selected`);
  if (user.cities?.length) {
    if (!ev.city) notes.push('city not published');
    else if (!user.cities.some(c => matchKey(c) === matchKey(ev.city))) return no(`city ${ev.city} not in preferences`);
    else reasons.push(`city: ${ev.city}`);
  }
  if (ev.start_at) {
    if (user.date_from && ev.start_at < user.date_from) return no('before date range');
    if (user.date_to && ev.start_at > user.date_to) return no('after date range');
  }
  if (user.max_price != null) {
    if (ev.minimum_price == null) notes.push('price not published');
    else if (ev.currency && ev.currency !== user.currency) notes.push(`price in ${ev.currency}; not compared with your ${user.currency} ceiling`);
    else if (ev.minimum_price > user.max_price) return no(`lowest published price ${ev.minimum_price} above ceiling ${user.max_price}`);
    else reasons.push(`within ${user.currency} ${user.max_price}`);
  }
  return { match: true, reasons, notes, excluded: null };
}
