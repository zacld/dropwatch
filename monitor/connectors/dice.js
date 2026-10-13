import { defineConnector } from './base.js';
import { jsonLd, isEventNode, nextData, canonicalUrl, findDeep, pick } from '../html.js';
import { schemaEvent } from './schema-org.js';
import { parseSourceTime } from '../time.js';
import { parseMoney } from '../values.js';

// DICE — priority 3.
// Observed (one public event page): Next.js with server-rendered content; serialised application state held
// sale-start, presale and announcement dates, prices and event status; the JSON-LD was less detailed.
//
// Every field is optional and looked up under several candidate names: a field seen once is not assumed
// to exist on every page. Where the state and the JSON-LD disagree on a field, the field is uncertain.
// Assumption to verify: state prices are in minor units.

const STATUS = {
  'on-sale': 'on_sale', on_sale: 'on_sale', onsale: 'on_sale', 'sold-out': 'sold_out', sold_out: 'sold_out', soldout: 'sold_out',
  'off-sale': 'off_sale', off_sale: 'off_sale', announced: 'not_yet_on_sale', 'not-on-sale': 'not_yet_on_sale', upcoming: 'not_yet_on_sale',
};
const CANCEL = { cancelled: 'cancelled', canceled: 'cancelled', postponed: 'postponed', rescheduled: 'rescheduled' };

const looksLikeEvent = o => (o.id || o.perm_name) && typeof o.name === 'string' && (o.dates || o.date || o.venues || o.venue || o.sale_start_date);

export const dice = defineConnector({
  id: 'dice',
  name: 'DICE',
  parserVersion: 'dice-nextdata@1',
  domains: ['dice.fm'],
  defaultTimezone: 'Europe/London',
  defaultCurrency: 'GBP',
  access: { method: 'public_html', liveRetrieval: 'not_assessed', requiresConfig: [], notes: 'Initial-HTML Next.js state and JSON-LD only. Permitted reuse of embedded state is not established.' },
  verification: 'synthetic fixtures modelled on one observed page',
  expectedContent: body => {
    const nd = nextData(body).value;
    return (nd && !findDeep(nd, looksLikeEvent).next().done) || jsonLd(body).nodes.some(isEventNode);
  },

  parse(body, { observation }) {
    const anomalies = [];
    const warnings = [];
    const canonical = canonicalUrl(body) ?? observation?.target ?? null;
    const nd = nextData(body);
    if (nd.error) anomalies.push(`__NEXT_DATA__ unreadable: ${nd.error}`);
    const ld = jsonLd(body);
    const ldNode = ld.nodes.find(isEventNode) ?? null;

    const candidates = nd.value ? [...findDeep(nd.value, looksLikeEvent)].map(x => x.value) : [];
    const slug = canonical ? canonical.replace(/\/+$/, '').split('/').pop() : null;
    let ev = candidates.find(c => slug && (c.perm_name === slug || String(c.url ?? '').endsWith(slug))) ?? (candidates.length === 1 ? candidates[0] : null);
    if (!ev && candidates.length > 1) anomalies.push(`${candidates.length} event-like objects in state; none matched the page URL`);

    const fields = {};
    const provenance = {};
    const put = (k, v, via = 'next-data') => { if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) { fields[k] = v; provenance[k] = via; } };

    if (ev) {
      const tz = pick(ev, 'dates.timezone', 'timezone', 'venues.0.timezone') ?? 'Europe/London';
      const time = (k, raw) => {
        if (raw === undefined || raw === null) return;
        const t = parseSourceTime(raw, tz);
        if (!t.utc) { warnings.push(`${k}: could not parse "${raw}"`); return; }
        if (t.assumedTimezone) warnings.push(`${k}: no UTC offset published; interpreted in ${tz}`);
        put(k, t.utc);
      };
      put('source_event_id', String(ev.id ?? ev.perm_name));
      put('title', ev.name);
      put('description', pick(ev, 'about.description', 'description'));
      put('canonical_url', canonical ?? ev.url);
      put('timezone', tz);
      time('start_at', pick(ev, 'dates.event_start_date', 'date', 'start_date'));
      time('end_at', pick(ev, 'dates.event_end_date', 'date_end', 'end_date'));
      time('published_on_sale_at', pick(ev, 'dates.sale_start_date', 'sale_start_date', 'on_sale_date'));
      time('published_presale_at', pick(ev, 'dates.presale_start_date', 'presale.start_date', 'presale_start_date'));
      time('announced_at', pick(ev, 'dates.announcement_date', 'announcement_date', 'announced_at'));
      const venue = pick(ev, 'venues.0', 'venue') ?? {};
      put('venue_name', typeof venue === 'string' ? venue : venue.name);
      put('city', pick(venue, 'city.name', 'city'));
      put('country', pick(venue, 'city.country_alpha2', 'country_code', 'country'));
      put('artists', [].concat(pick(ev, 'lineup', 'artists', 'summary_lineup.top_artists') ?? []).map(x => (typeof x === 'string' ? x : x?.name ?? x?.details)).filter(Boolean));
      put('categories', [].concat(ev.tags ?? ev.genre_tags ?? []).map(t => (typeof t === 'string' ? t : t?.name)).filter(Boolean).map(s => s.replace(/^.*:/, '')));

      const status = String(ev.status ?? '').toLowerCase();
      if (CANCEL[status]) put('cancellation_status', CANCEL[status]);
      else if (status) put('cancellation_status', 'scheduled');
      const avail = ev.sold_out === true ? 'sold_out' : STATUS[status];
      if (avail) put('published_availability_status', avail);
      else if (status && !CANCEL[status]) warnings.push(`status "${ev.status}" not recognised`);

      const price = ev.price ?? {};
      const cur = price.currency ?? ev.currency ?? null;
      const lo = parseMoney(pick(price, 'amount_from', 'amount', 'min'), { currency: cur, minorUnits: true });
      const hi = parseMoney(pick(price, 'amount_to', 'max'), { currency: cur, minorUnits: true });
      if (lo.amount != null && lo.currency) { put('minimum_price', lo.amount); put('currency', lo.currency); }
      if (hi.amount != null && hi.currency) put('maximum_price', hi.amount);
    }

    // JSON-LD: a fallback when the state is absent, and a cross-check when it is present.
    let confidence = ev ? 0.8 : 0.6;
    const uncertain = [];
    if (ldNode) {
      const r = schemaEvent(ldNode, { timezone: fields.timezone ?? 'Europe/London', currency: 'GBP' });
      for (const [k, v] of Object.entries(r.fields)) {
        if (fields[k] === undefined) { fields[k] = v; provenance[k] = 'json-ld'; }
        else if (['start_at', 'venue_name'].includes(k) && v !== fields[k]) {
          warnings.push(`${k} conflict: state "${fields[k]}", JSON-LD "${v}"`);
          uncertain.push(k);
        }
      }
      if (!fields.source_event_id && slug) { fields.source_event_id = slug; provenance.source_event_id = 'canonical url'; }
      warnings.push(...r.warnings);
    }
    if (uncertain.length) { fields.uncertain_fields = uncertain; confidence -= 0.25; }
    if (!ev && !ldNode) return { events: [], anomalies, errors: ['no event found in state or JSON-LD'] };
    return { events: [{ fields, provenance, tiers: [], quarantined: [], warnings, unavailable: [], confidence }], anomalies, errors: ld.errors };
  },
});
