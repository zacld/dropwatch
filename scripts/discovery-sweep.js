// Finds real UK Ticketmaster events for Dropwatch Discovery using the public Discovery API:
//   - every event billing a watchlist artist or naming a priority ecosystem (series or venue)
//   - UK Dance/Electronic events by date window (next weeks, Nov–Dec, NYE, next year)
//   - Halloween and New Year's Eve searches across music
// Reads TICKETMASTER_API_KEY from .env. Read-only: no purchasing APIs.
//   node scripts/discovery-sweep.js   → data/discovery/listings.json + a summary
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)));
const KEY = env.TICKETMASTER_API_KEY;
if (!KEY) throw new Error('Set TICKETMASTER_API_KEY in .env');

export const ARTISTS = ['Silva Bumpa', 'KETTAMA', 'Obskür', 'Josh Baker', 'Prospa', 'PAWSA', 'Max Dean', 'Luke Dean', 'Duke Dumont', 'Calvin Harris', 'David Guetta', 'Franky Rizardo', 'Ewan McVicar', 'ANOTR', 'Jamie Jones', 'Interplanetary Criminal', 'Holy Priest', 'Azyr', 'Toxic Machinery', 'Wilkinson', 'Hedex', 'Kolter', 'Omar+', 'DJ HEARTSTRING', 'CamelPhat', 'Notion', 'bullet tooth', 'Tiësto', 'East End Dubs', 'Robbie Doherty', 'Chris Stussy', 'Egyptian Lover', 'FISHER', 'Dom Dolla', 'Sidney Charles', 'TeeDee', 'Riordan', 'Armin van Buuren', 'Armand van Helden', 'Eliza Rose', 'MK', 'Overmono', 'Fred again..', 'Michael Bibi', 'Sonny Fodera', 'Ben Hemsley', 'Chris Lorenzo', 'Hannah Laing', 'SOSA', 'D.O.D'];
export const ECOSYSTEMS = ['Warehouse Project', 'Depot Mayfield', 'Parklife', 'You&Me', 'Steel City Dance Discs', 'Solid Grooves', 'Paradise', 'Teletech', 'Drumsheds', 'Worried About Henry', 'Creamfields', 'fabric', 'KOKO', 'Amnesia'];
const DANCE = 'KnvZfZ7vAvF';   // Discovery genre id for Dance/Electronic
const MUSIC = 'KZFzniwnSyZfZ7v7nJ'; // segment id for Music

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const iso = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// One query, following pages up to the API's 1,000-result deep-paging limit (or maxPages).
async function query(params, maxPages = 5) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const u = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    Object.entries({ apikey: KEY, countryCode: 'GB', size: '200', locale: '*', sort: 'date,asc', page: String(page), ...params })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    let res = await fetch(u);
    if (res.status === 429) { await sleep(2000); res = await fetch(u); }
    if (!res.ok) break;
    const d = await res.json();
    out.push(...(d._embedded?.events ?? []));
    await sleep(250); // stay well under 5 requests a second
    if (page + 1 >= (d.page?.totalPages ?? 0) || (page + 1) * 200 >= 1000) break;
  }
  return out;
}

const events = new Map();
function add(e, tags = {}) {
  const attractions = (e._embedded?.attractions ?? []).map(a => a.name);
  const rec = events.get(e.id) ?? {
    id: e.id, name: e.name.trim(), url: e.url.split('?')[0], date: e.dates?.start?.localDate, time: e.dates?.start?.localTime ?? null,
    status: e.dates?.status?.code, venue: (e._embedded?.venues ?? []).map(v => `${v.name}, ${v.city?.name}`).join('; '),
    genre: e.classifications?.[0]?.genre?.name ?? null,
    publicSale: e.sales?.public?.startDateTime ?? null,
    presales: (e.sales?.presales ?? []).map(p => ({ name: p.name, start: p.startDateTime, end: p.endDateTime })),
    priceRanges: e.priceRanges ?? null, ticketLimit: e.ticketLimit?.info ?? null,
    fixedTierPricing: /fixed tier pricing|lower[- ]priced tickets are released first/i.test(`${e.pleaseNote ?? ''} ${e.info ?? ''}`),
    attractions, artists: [], ecosystems: [],
  };
  if (tags.artist && !rec.artists.includes(tags.artist)) rec.artists.push(tags.artist);
  if (tags.ecosystem && !rec.ecosystems.includes(tags.ecosystem)) rec.ecosystems.push(tags.ecosystem);
  events.set(e.id, rec);
}

const now = new Date();
const days = n => new Date(now.getTime() + n * 864e5);
const year = now.getUTCFullYear();

// Watchlist artists: keep only events that bill the artist (Discovery keyword search is loose).
for (const term of ARTISTS) {
  for (const e of await query({ keyword: term }, 1)) {
    const attractions = (e._embedded?.attractions ?? []).map(a => a.name);
    if (attractions.some(a => norm(a) === norm(term)) || norm(e.name).includes(norm(term))) add(e, { artist: term });
  }
}
// Ecosystems: keep only events whose name or venue names the series or venue.
for (const term of ECOSYSTEMS) {
  for (const e of await query({ keyword: term }, 1)) {
    const venues = (e._embedded?.venues ?? []).map(v => v.name).join(' ');
    if (norm(`${e.name} ${venues}`).includes(norm(term))) add(e, { ecosystem: term });
  }
}
// Date windows for UK Dance/Electronic.
const windows = [
  [now, days(31)],
  [new Date(Date.UTC(year, 10, 1)), new Date(Date.UTC(year, 11, 30, 23, 59, 59))],
  [new Date(Date.UTC(year + 1, 0, 1)), new Date(Date.UTC(year + 1, 11, 31, 23, 59, 59))],
];
for (const [a, b] of windows) for (const e of await query({ genreId: DANCE, startDateTime: iso(a), endDateTime: iso(b) })) add(e);
// Seasonal searches across music.
for (const e of await query({ segmentId: MUSIC, keyword: 'Halloween', startDateTime: iso(new Date(Date.UTC(year, 9, 15))), endDateTime: iso(new Date(Date.UTC(year, 10, 3, 23, 59, 59))) })) add(e);
for (const kw of ["New Year's Eve", 'NYE', 'New Years Eve'])
  for (const e of await query({ segmentId: MUSIC, keyword: kw, startDateTime: iso(new Date(Date.UTC(year, 11, 30))), endDateTime: iso(new Date(Date.UTC(year + 1, 0, 1, 23, 59, 59))) })) add(e);
// All UK Dance/Electronic on 31 Dec, whatever it is called.
for (const e of await query({ genreId: DANCE, startDateTime: iso(new Date(Date.UTC(year, 11, 31))), endDateTime: iso(new Date(Date.UTC(year + 1, 0, 1, 12))) })) add(e);

const today = now.toISOString().slice(0, 10);
const all = [...events.values()]
  .filter(r => r.date && r.date >= today && !['cancelled', 'canceled', 'postponed'].includes(r.status))
  .filter(r => !/^(venue premium|parking|car park|vip upgrade)/i.test(r.name))
  .sort((a, b) => a.date.localeCompare(b.date));
const nextRelease = r => [r.publicSale, ...r.presales.map(p => p.start)].filter(t => t && Date.parse(t) > now.getTime()).sort()[0] ?? null;
mkdirSync(join(root, 'data', 'discovery'), { recursive: true });
writeFileSync(join(root, 'data', 'discovery', 'listings.json'), JSON.stringify({ checkedAt: now.toISOString(), events: all }, null, 1));

const count = f => all.filter(f).length;
console.log(`${all.length} upcoming UK events`);
console.log(`  billing a watchlist artist: ${count(r => r.artists.length)} · at a priority ecosystem: ${count(r => r.ecosystems.length)}`);
console.log(`  with a ticket release still to come: ${count(nextRelease)} · fixed tier pricing: ${count(r => r.fixedTierPricing)} · with prices: ${count(r => r.priceRanges)}`);
