import { defineConnector } from './base.js';
import { parseSourceTime } from '../time.js';
import { parseMoney } from '../values.js';

// Ticketmaster — priority 4.
// Observed: the public event page returned a bot-detection / access-interruption page. That response is
// classified and rejected; it is never parsed. Event data comes from the official Discovery API when an API
// key is configured, or from saved Discovery API payloads (fixtures) for local development.
//
// dates.status.code is an EVENT-LEVEL sale status ("onsale", "offsale", ...). It is not seat-level inventory
// and is never presented as such. The Inventory Status / offers endpoints are not used (a request to the
// offers endpoint with the project key was refused: "Invalid ApiKey for given resource", 1 Oct 2026).

const STATUS = { onsale: 'on_sale', offsale: 'off_sale' };
const CANCEL = { cancelled: 'cancelled', canceled: 'cancelled', postponed: 'postponed', rescheduled: 'rescheduled' };

const parseJson = body => { try { return JSON.parse(body); } catch { return null; } };
const isDiscoveryEvent = e => e && typeof e === 'object' && e.type === 'event' && e.id && e.dates;

export const ticketmaster = defineConnector({
  id: 'ticketmaster',
  name: 'Ticketmaster',
  parserVersion: 'tm-discovery@1',
  domains: ['ticketmaster.co.uk', 'ticketmaster.com', 'ticketmaster.ie', 'ticketmaster.nl', 'ticketmaster.de', 'ticketmaster.es', 'livenation.co.uk'],
  defaultTimezone: 'Europe/London',
  defaultCurrency: 'GBP',
  access: {
    method: 'official_api',
    liveRetrieval: 'permitted_with_api_key',
    requiresConfig: ['TICKETMASTER_API_KEY'],
    notes: 'Discovery API v2 only. Public event pages returned an access-interruption page and are not retrieved. Commercial display terms of the API still need review.',
  },
  verification: 'real Discovery API payload (1 Oct 2026) plus synthetic variants',
  expectedContent: body => {
    const j = parseJson(body);
    return !!j && (isDiscoveryEvent(j) || (j._embedded?.events ?? []).some(isDiscoveryEvent));
  },

  parse(body, { observation }) {
    const j = parseJson(body);
    const list = isDiscoveryEvent(j) ? [j] : (j?._embedded?.events ?? []).filter(isDiscoveryEvent);
    const observedAt = observation?.observed_at ?? new Date().toISOString();
    return { events: list.map(e => mapEvent(e, observedAt)), anomalies: [], errors: [] };
  },

  // Live retrieval of one event by Discovery id. The key goes in the query string as the API requires;
  // logs use redactedUrl.
  buildRequest(target, config) {
    const key = config.ticketmasterApiKey;
    if (!key) return { error: 'awaiting_configuration', message: 'TICKETMASTER_API_KEY is not set' };
    const id = String(target).match(/^[A-Za-z0-9_-]{5,40}$/) ? target : null;
    if (!id) return { error: 'bad_target', message: 'Ticketmaster targets are Discovery API event ids' };
    const url = `https://app.ticketmaster.com/discovery/v2/events/${encodeURIComponent(id)}.json?locale=*&apikey=${encodeURIComponent(key)}`;
    return { url, redactedUrl: url.replace(/apikey=[^&]+/, 'apikey=REDACTED'), headers: { accept: 'application/json' } };
  },
});

function mapEvent(e, observedAt) {
  const fields = {};
  const provenance = {};
  const warnings = [];
  const put = (k, v, via) => { if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) { fields[k] = v; provenance[k] = via; } };
  const venue = e._embedded?.venues?.[0] ?? {};
  const tz = e.dates?.timezone ?? venue.timezone ?? 'Europe/London';

  put('source_event_id', e.id, 'discovery:id');
  put('canonical_url', e.url ? e.url.split('?')[0] : null, 'discovery:url');
  put('title', e.name, 'discovery:name');
  put('description', e.info ?? e.description ?? null, 'discovery:info');
  put('artists', (e._embedded?.attractions ?? []).map(a => a.name), 'discovery:attractions');
  put('categories', [...new Set((e.classifications ?? []).flatMap(c => [c.segment?.name, c.genre?.name]).filter(n => n && n !== 'Undefined').map(n => n.toLowerCase()))], 'discovery:classifications');
  put('venue_name', venue.name, 'discovery:venue');
  put('city', venue.city?.name, 'discovery:venue');
  put('country', venue.country?.countryCode, 'discovery:venue');
  put('timezone', tz, 'discovery:dates.timezone');

  const s = e.dates?.start ?? {};
  if (s.dateTBA || s.dateTBD) warnings.push('start date is TBA/TBD');
  else if (s.dateTime) put('start_at', parseSourceTime(s.dateTime, tz).utc, 'discovery:dates.start.dateTime');
  else if (s.localDate) {
    const t = parseSourceTime(`${s.localDate}T${s.localTime ?? '00:00:00'}`, tz);
    put('start_at', t.utc, 'discovery:dates.start.localDate');
    if (!s.localTime) warnings.push('start time not published; date only');
  }
  if (e.dates?.end?.dateTime) put('end_at', parseSourceTime(e.dates.end.dateTime, tz).utc, 'discovery:dates.end');

  const pub = e.sales?.public ?? {};
  if (pub.startDateTime && !pub.startTBD && !pub.startTBA) put('published_on_sale_at', parseSourceTime(pub.startDateTime, tz).utc, 'discovery:sales.public');
  const presales = (e.sales?.presales ?? []).map(p => parseSourceTime(p.startDateTime, tz).utc).filter(Boolean).sort();
  if (presales.length) put('published_presale_at', presales[0], 'discovery:sales.presales');

  const code = String(e.dates?.status?.code ?? '').toLowerCase();
  put('cancellation_status', CANCEL[code] ?? (code ? 'scheduled' : null), 'discovery:dates.status');
  const via = 'discovery:dates.status (event-level sale status, not inventory)';
  if (STATUS[code]) {
    // "onsale" before the published public on-sale time means presale/announced, not general sale.
    const pre = code === 'onsale' && fields.published_on_sale_at && fields.published_on_sale_at > observedAt;
    put('published_availability_status', pre ? 'not_yet_on_sale' : STATUS[code], via);
  } else if (CANCEL[code]) put('published_availability_status', 'off_sale', via);
  else if (code) warnings.push(`status code "${code}" not recognised`);

  const pr = (e.priceRanges ?? []).filter(p => p.currency);
  if (pr.length) {
    const cur = pr[0].currency;
    const same = pr.filter(p => p.currency === cur);
    const lo = Math.min(...same.map(p => parseMoney(p.min, { currency: cur }).amount).filter(v => v != null));
    const hi = Math.max(...same.map(p => parseMoney(p.max, { currency: cur }).amount).filter(v => v != null));
    if (Number.isFinite(lo)) put('minimum_price', lo, 'discovery:priceRanges');
    if (Number.isFinite(hi)) put('maximum_price', hi, 'discovery:priceRanges');
    put('currency', cur, 'discovery:priceRanges');
  }
  // Discovery gives no per-ticket tiers or quantities; that is a limit of the access method.
  if (!pr.length) warnings.push('no priceRanges published');
  return { fields, provenance, tiers: [], quarantined: [], warnings, unavailable: [], confidence: 0.9 };
}
