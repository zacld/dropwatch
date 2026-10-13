import { defineConnector } from './base.js';
import { jsonLd, isEventNode, shoebox, canonicalUrl, pick } from '../html.js';
import { schemaEvent, rollUpAvailability } from './schema-org.js';
import { parseSourceTime } from '../time.js';
import { parseMoney } from '../values.js';

// Fatsoma — priority 2.
// Observed (one public event page): Ember.js with FastBoot rendering; Schema.org Event data and serialised
// application state in the initial HTML, including ticket tiers, prices, release times and statuses. Some
// embedded structured data appeared to carry tickets belonging to OTHER events.
//
// Every ticket tier must prove it belongs to this event. A tier is accepted only when the event's own
// ticket relationship lists it and nothing contradicts that, or when the tier names this event explicitly.
// Anything else is quarantined with a reason and never used for prices, statuses or alerts.
//
// Assumptions to verify against saved real pages: shoebox state is JSON:API shaped; tier prices are in
// minor units (pence). A JSON-LD price that disagrees with the state lowers confidence.

const TIER_STATUS = {
  'on-sale': 'on_sale', onsale: 'on_sale', available: 'on_sale', 'sold-out': 'sold_out', soldout: 'sold_out',
  'not-on-sale': 'not_yet_released', 'not-yet-on-sale': 'not_yet_released', scheduled: 'not_yet_released', pending: 'not_yet_released',
  'off-sale': 'off_sale', ended: 'off_sale', closed: 'off_sale',
};
const ROLL = { on_sale: 'on_sale', sold_out: 'sold_out', not_yet_released: 'not_yet_on_sale', off_sale: 'off_sale' };

export const fatsoma = defineConnector({
  id: 'fatsoma',
  name: 'Fatsoma',
  parserVersion: 'fatsoma-shoebox@1',
  domains: ['fatsoma.com'],
  defaultTimezone: 'Europe/London',
  defaultCurrency: 'GBP',
  access: { method: 'public_html', liveRetrieval: 'not_assessed', requiresConfig: [], notes: 'Initial-HTML JSON-LD and FastBoot shoebox state only.' },
  verification: 'synthetic fixtures modelled on one observed page',
  expectedContent: body => Object.values(shoebox(body).entries).some(e => e?.data?.type === 'events') || jsonLd(body).nodes.some(isEventNode),

  parse(body, { observation }) {
    const anomalies = [];
    const errors = [];
    const sb = shoebox(body);
    anomalies.push(...sb.errors.map(e => `shoebox unreadable: ${e}`));
    const ld = jsonLd(body);
    errors.push(...ld.errors);
    const canonical = canonicalUrl(body) ?? observation?.target ?? null;

    const docs = Object.values(sb.entries).filter(d => d?.data?.type === 'events' && d.data.id);
    if (docs.length !== 1) {
      return { events: [], anomalies, errors: [...errors, docs.length ? 'more than one event document in state' : 'no event document in FastBoot state'] };
    }
    const doc = docs[0];
    const eventId = String(doc.data.id);
    const a = doc.data.attributes ?? {};
    const tz = a['time-zone'] ?? a.timezone ?? 'Europe/London';
    const included = doc.included ?? [];
    const fields = { source_event_id: eventId };
    const provenance = { source_event_id: 'shoebox' };
    const warnings = [];
    const put = (k, v, via = 'shoebox') => { if (v !== undefined && v !== null && v !== '') { fields[k] = v; provenance[k] = via; } };
    const time = (k, raw) => {
      if (raw === undefined || raw === null) return;
      const t = parseSourceTime(raw, tz);
      if (!t.utc) { warnings.push(`${k}: could not parse "${raw}"`); return; }
      if (t.assumedTimezone) warnings.push(`${k}: no UTC offset published; interpreted in ${tz}`);
      put(k, t.utc);
    };

    put('title', a.name ?? a.title);
    put('description', a.description);
    put('canonical_url', canonical);
    time('start_at', pick(a, 'starts-at', 'start-date', 'starts_at'));
    time('end_at', pick(a, 'ends-at', 'end-date', 'ends_at'));
    put('timezone', tz);
    const cancelled = a.cancelled === true || a.status === 'cancelled';
    const postponed = a.postponed === true || a.status === 'postponed';
    put('cancellation_status', cancelled ? 'cancelled' : postponed ? 'postponed' : 'scheduled');
    put('categories', [].concat(a.category ?? a.categories ?? []).map(String));

    const byType = (t, id) => included.find(i => i.type === t && String(i.id) === String(id));
    const locRef = doc.data.relationships?.location?.data ?? doc.data.relationships?.venue?.data;
    const loc = locRef ? byType(locRef.type, locRef.id) : null;
    if (loc) {
      put('venue_name', loc.attributes?.name);
      put('city', loc.attributes?.city ?? loc.attributes?.town);
      put('country', loc.attributes?.country ?? loc.attributes?.['country-code']);
    }
    put('artists', (doc.data.relationships?.artists?.data ?? []).map(r => byType(r.type, r.id)?.attributes?.name).filter(Boolean));

    // ---- ticket tiers with ownership validation ----
    const claimed = new Set((doc.data.relationships?.tickets?.data ?? []).map(r => String(r.id)));
    const tiers = [];
    const quarantined = [];
    for (const t of included.filter(i => i.type === 'tickets' || i.type === 'ticket-types')) {
      const ta = t.attributes ?? {};
      const owner = ta['event-id'] ?? t.relationships?.event?.data?.id;
      const listed = claimed.has(String(t.id));
      let reason = null;
      if (owner !== undefined && String(owner) !== eventId) reason = `tier names event ${owner}, not ${eventId}${listed ? ' (although this event lists it)' : ''}`;
      else if (!listed && owner === undefined) reason = 'tier is not listed by this event and carries no event id';
      const m = parseMoney(ta.price ?? ta['face-value'], { currency: ta.currency ?? 'GBP', minorUnits: true });
      const release = pick(ta, 'release-at', 'on-sale-at', 'sale-starts-at');
      const rt = release ? parseSourceTime(release, tz) : null;
      const status = TIER_STATUS[String(ta.status ?? '').toLowerCase()] ?? 'unknown';
      const tier = {
        source_tier_id: String(t.id), name: ta.name ?? 'Ticket', price: m.amount, currency: m.currency,
        release_at: rt?.utc ?? null, status, provenance: 'shoebox',
      };
      if (ta.status && status === 'unknown') warnings.push(`tier ${t.id}: status "${ta.status}" not recognised`);
      if (reason) { quarantined.push({ tier, reason }); anomalies.push(`quarantined tier ${t.id}: ${reason}`); }
      else tiers.push(tier);
    }
    for (const id of claimed) if (!included.some(i => String(i.id) === id && (i.type === 'tickets' || i.type === 'ticket-types'))) warnings.push(`event lists tier ${id} but its data is not on the page`);

    // JSON-LD offers that point at a different event page are the observed mis-association; record them.
    const node = ld.nodes.filter(isEventNode).find(n => !n.url || sameEvent(n.url, canonical)) ?? null;
    for (const n of ld.nodes.filter(isEventNode)) {
      for (const o of [].concat(n.offers ?? []).flatMap(o => [o, ...[].concat(o?.offers ?? [])])) {
        if (o?.url && canonical && !sameEvent(o.url, canonical)) {
          quarantined.push({ tier: { source_tier_id: `jsonld:${o.url}`, name: o.name ?? 'Offer', price: null, currency: o.priceCurrency ?? null, release_at: null, status: 'unknown', provenance: 'json-ld' }, reason: `JSON-LD offer links to another event (${o.url})` });
          anomalies.push(`JSON-LD offer for another event ignored: ${o.url}`);
        }
      }
    }

    // Event-level values come only from accepted tiers.
    const prices = tiers.filter(t => t.price != null).map(t => t.price);
    if (prices.length) {
      put('minimum_price', Math.min(...prices));
      put('maximum_price', Math.max(...prices));
      put('currency', tiers.find(t => t.currency)?.currency);
    }
    const rolled = rollUpAvailability(tiers.map(t => ROLL[t.status] ?? null));
    if (rolled) put('published_availability_status', rolled);
    const releases = tiers.map(t => t.release_at).filter(Boolean).sort();
    if (releases.length) put('published_on_sale_at', releases[0]);

    let confidence = 0.8;
    if (node) {
      // Cross-check against this event's own offers only.
      const ownOffers = [].concat(node.offers ?? []).filter(o => !o?.url || sameEvent(o.url, canonical));
      const ldr = schemaEvent({ ...node, offers: ownOffers }, { timezone: tz, currency: 'GBP' });
      fields.title ??= ldr.fields.title;
      fields.venue_name ??= ldr.fields.venue_name;
      fields.city ??= ldr.fields.city;
      if (ldr.fields.start_at && fields.start_at && ldr.fields.start_at !== fields.start_at) {
        warnings.push(`start time conflict: state ${fields.start_at}, JSON-LD ${ldr.fields.start_at}`);
        fields.uncertain_fields = ['start_at'];
        confidence -= 0.25;
      }
      if (ldr.fields.minimum_price != null && fields.minimum_price != null && ldr.fields.minimum_price !== fields.minimum_price) {
        warnings.push(`JSON-LD lowest price ${ldr.fields.minimum_price} differs from state ${fields.minimum_price} (check minor-unit assumption)`);
        confidence -= 0.1;
      }
    }
    return { events: [{ fields, provenance, tiers, quarantined, warnings, unavailable: [], confidence }], anomalies, errors };
  },
});

function sameEvent(a, b) {
  try {
    const p = u => new URL(u).pathname.replace(/\/+$/, '').toLowerCase();
    return p(a) === p(b);
  } catch { return false; }
}
