import { ISO_CURRENCY, normaliseText, round2 } from './values.js';
import { isValidTimeZone } from './time.js';

// The canonical event model every connector normalises into. See docs/SCHEMA.md.

export const AVAILABILITY = ['on_sale', 'not_yet_on_sale', 'limited', 'sold_out', 'off_sale', 'unknown'];
export const CANCELLATION = ['scheduled', 'cancelled', 'postponed', 'rescheduled', 'moved_online', 'unknown'];
export const TIER_STATUS = ['on_sale', 'not_yet_released', 'sold_out', 'off_sale', 'unknown'];

// How much we know about a field's current value.
//   confirmed    parsed from the source in the latest valid observation
//   missing      a valid observation did not publish it (the previous value, if any, is retained)
//   unknown      never observed
//   unavailable  this access method cannot provide it (e.g. ticket quantities)
//   uncertain    the source gave conflicting values; the previous value is retained
//   stale        confirmed, but longer ago than the freshness window (computed when read)
export const FIELD_STATES = ['confirmed', 'missing', 'unknown', 'unavailable', 'uncertain', 'stale'];

export const EVENT_FIELDS = [
  'source_event_id', 'canonical_url', 'title', 'description', 'artists', 'categories', 'venue_name', 'city', 'country',
  'start_at', 'end_at', 'timezone', 'currency', 'minimum_price', 'maximum_price',
  'published_availability_status', 'published_on_sale_at', 'published_presale_at', 'announced_at', 'cancellation_status',
];
export const REQUIRED_FIELDS = ['source_event_id', 'title', 'start_at'];

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const TIME_FIELDS = ['start_at', 'end_at', 'published_on_sale_at', 'published_presale_at', 'announced_at'];

// Validate and coerce connector output. Returns { fields, field_states, problems, missing_required }.
// Invalid values are dropped (state "missing") and reported, never guessed.
export function normaliseEventFields(raw, { allowedHosts = [] } = {}) {
  const fields = {};
  const field_states = {};
  const problems = [];
  const set = (k, v) => {
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) { fields[k] = null; field_states[k] = 'missing'; }
    else { fields[k] = v; field_states[k] = 'confirmed'; }
  };

  set('source_event_id', raw.source_event_id == null ? null : String(raw.source_event_id).trim() || null);
  set('title', normaliseText(raw.title));
  const desc = normaliseText(raw.description);
  set('description', desc && desc.length > 2000 ? desc.slice(0, 2000) + '…' : desc);
  set('artists', uniq((raw.artists ?? []).map(normaliseText).filter(Boolean)));
  set('categories', uniq((raw.categories ?? []).map(c => normaliseText(c)?.toLowerCase()).filter(Boolean)));
  set('venue_name', normaliseText(raw.venue_name));
  set('city', normaliseText(raw.city));
  set('country', raw.country ? normaliseCountry(raw.country) : null);

  let url = null;
  if (raw.canonical_url) {
    try {
      const u = new URL(raw.canonical_url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
      if (allowedHosts.length && !allowedHosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) problems.push(`canonical_url host ${u.hostname} is not a ${allowedHosts.join('/')} host`);
      else { u.hash = ''; url = u.toString(); }
    } catch { problems.push('canonical_url is not a valid URL'); }
  }
  set('canonical_url', url);

  for (const k of TIME_FIELDS) {
    const v = raw[k];
    if (v && !ISO_UTC.test(v)) { problems.push(`${k} is not a UTC ISO timestamp`); set(k, null); }
    else set(k, v ?? null);
  }
  if (fields.start_at && fields.end_at && fields.end_at < fields.start_at) { problems.push('end_at is before start_at'); set('end_at', null); }
  set('timezone', isValidTimeZone(raw.timezone) ? raw.timezone : null);

  const cur = raw.currency ? String(raw.currency).toUpperCase() : null;
  if (cur && !ISO_CURRENCY.test(cur)) problems.push(`currency ${raw.currency} is not an ISO 4217 code`);
  set('currency', cur && ISO_CURRENCY.test(cur) ? cur : null);
  for (const k of ['minimum_price', 'maximum_price']) {
    const v = raw[k];
    if (v === null || v === undefined) set(k, null);
    else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) { problems.push(`${k} is not a valid amount`); set(k, null); }
    else set(k, round2(v));
  }
  if ((fields.minimum_price != null || fields.maximum_price != null) && !fields.currency) {
    problems.push('price published without a currency; prices dropped');
    set('minimum_price', null); set('maximum_price', null);
  }
  if (fields.minimum_price != null && fields.maximum_price != null && fields.minimum_price > fields.maximum_price) {
    problems.push('minimum_price exceeds maximum_price; prices dropped');
    set('minimum_price', null); set('maximum_price', null);
  }

  set('published_availability_status', enumOr(raw.published_availability_status, AVAILABILITY, problems, 'published_availability_status'));
  set('cancellation_status', enumOr(raw.cancellation_status, CANCELLATION, problems, 'cancellation_status'));

  // Conflicts reported by the connector: keep the field out of this observation.
  for (const k of raw.uncertain_fields ?? []) { fields[k] = null; field_states[k] = 'uncertain'; }

  // An uncertain required field does not reject the observation outright: the engine keeps the last valid
  // value for an event it already knows, and refuses to create a new event from it.
  const missing_required = REQUIRED_FIELDS.filter(k => field_states[k] !== 'confirmed' && field_states[k] !== 'uncertain');
  const uncertain_required = REQUIRED_FIELDS.filter(k => field_states[k] === 'uncertain');
  return { fields, field_states, problems, missing_required, uncertain_required };
}

export function normaliseTier(raw, { eventCurrency } = {}) {
  const problems = [];
  const currency = (raw.currency ?? eventCurrency ?? '').toUpperCase() || null;
  let price = raw.price;
  if (price != null && (typeof price !== 'number' || !Number.isFinite(price) || price < 0)) { problems.push('tier price invalid'); price = null; }
  if (price != null && !currency) { problems.push('tier price has no currency'); price = null; }
  const status = TIER_STATUS.includes(raw.status) ? raw.status : 'unknown';
  if (raw.status && status === 'unknown' && raw.status !== 'unknown') problems.push(`tier status "${raw.status}" not recognised`);
  let fee = raw.fee ?? null;
  if (fee != null && (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0)) { problems.push('tier fee invalid'); fee = null; }
  const qty = raw.quantity_available;
  return {
    tier: {
      source_tier_id: String(raw.source_tier_id),
      name: normaliseText(raw.name) ?? 'Unnamed ticket',
      price: price == null ? null : round2(price),
      fee: fee == null || price == null ? null : round2(fee),
      currency: currency && ISO_CURRENCY.test(currency) ? currency : null,
      release_at: raw.release_at && ISO_UTC.test(raw.release_at) ? raw.release_at : null,
      off_sale_at: raw.off_sale_at && ISO_UTC.test(raw.off_sale_at) ? raw.off_sale_at : null,
      status,
      presale: raw.presale === true ? true : raw.presale === false ? false : null,
      // Add-ons (extras sold alongside the event's own tickets) are tracked but never drive event-level
      // prices, availability or alerts.
      addon: raw.addon === true,
      access_code_only: raw.access_code_only === true,
      // Only a source that publishes a count (Fatsoma "amount-available") supplies one; never invented.
      quantity: Number.isInteger(qty) && qty >= 0 ? { state: 'confirmed', value: qty } : { state: 'unavailable', value: null },
    },
    problems,
  };
}

function enumOr(v, allowed, problems, name) {
  if (v === null || v === undefined) return null;
  if (allowed.includes(v)) return v;
  problems.push(`${name} "${v}" not recognised`);
  return null;
}

const COUNTRY = { 'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB', ireland: 'IE', spain: 'ES', netherlands: 'NL', germany: 'DE', france: 'FR' };
export function normaliseCountry(c) {
  const s = String(c).trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return COUNTRY[s.toLowerCase()] ?? s;
}

const uniq = a => [...new Set(a)];
