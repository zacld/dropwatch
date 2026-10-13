import { defineConnector } from './base.js';
import { jsonLd, isEventNode, shoebox, canonicalUrl, pick } from '../html.js';
import { schemaEvent, rollUpAvailability } from './schema-org.js';
import { parseSourceTime } from '../time.js';
import { parseMoney } from '../values.js';

// Fatsoma — priority 2.
// Observed (real public event page saved 13 Oct 2026, fixtures/fatsoma/real-2026-10-13.html): Ember.js with
// FastBoot rendering. The initial HTML carries Schema.org Event data and the event's JSON:API document
// (double-serialised in a shoebox script) with `ticket-options` linked to the event by relationship, each with
// `on-sale-status`, `price-sub-unit`, `transaction-fee-sub-unit` (pence), `on-sale-at`, `off-sale-at`,
// `pre-sale`, `addon` and `amount-available`. Event health ("postponed") is in the state only: the page's
// JSON-LD said EventScheduled at the same time, so the state wins and the conflict is recorded.
// Older synthetic fixtures use `tickets` / `status` / `price`; both shapes are read.
//
// Every ticket tier must prove it belongs to this event. A tier is accepted only when the event's own
// ticket relationship lists it and nothing contradicts that, or when the tier names this event explicitly.
// Anything else is quarantined with a reason and never used for prices, statuses or alerts.

const TIER_STATUS = {
  'on-sale': 'on_sale', onsale: 'on_sale', available: 'on_sale', 'sold-out': 'sold_out', soldout: 'sold_out',
  'not-on-sale': 'not_yet_released', 'not-yet-on-sale': 'not_yet_released', scheduled: 'not_yet_released', pending: 'not_yet_released',
  'off-sale': 'off_sale', ended: 'off_sale', closed: 'off_sale',
};
const ROLL = { on_sale: 'on_sale', sold_out: 'sold_out', not_yet_released: 'not_yet_on_sale', off_sale: 'off_sale' };
const TIER_TYPES = new Set(['tickets', 'ticket-types', 'ticket-options']);
// Event `health` values seen: "postponed". Anything else unrecognised is reported, not guessed.
const HEALTH = { postponed: 'postponed', cancelled: 'cancelled', canceled: 'cancelled', rescheduled: 'rescheduled' };
const LD_STATUS = { EventScheduled: 'scheduled', EventCancelled: 'cancelled', EventPostponed: 'postponed', EventRescheduled: 'rescheduled', EventMovedOnline: 'moved_online' };

export const fatsoma = defineConnector({
  id: 'fatsoma',
  name: 'Fatsoma',
  parserVersion: 'fatsoma-shoebox@2',
  domains: ['fatsoma.com'],
  defaultTimezone: 'Europe/London',
  defaultCurrency: 'GBP',
  access: { method: 'public_html', liveRetrieval: 'not_assessed', requiresConfig: [], notes: 'Initial-HTML JSON-LD and FastBoot shoebox state only.' },
  verification: 'one real saved page (13 Oct 2026) plus synthetic fixtures',
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
    const included = doc.included ?? [];
    const byType = (t, id) => included.find(i => i.type === t && String(i.id) === String(id));
    const locRef = doc.data.relationships?.location?.data ?? doc.data.relationships?.venue?.data;
    const loc = locRef ? byType(locRef.type, locRef.id) : null;
    const tz = a['time-zone'] ?? a.timezone ?? loc?.attributes?.timezone ?? 'Europe/London';
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
    time('announced_at', a['announced-at']);
    const health = typeof a.health === 'string' ? a.health.toLowerCase() : null;
    if (health && !HEALTH[health] && !['healthy', 'ok', 'active', 'live', 'scheduled'].includes(health)) warnings.push(`event health "${a.health}" not recognised; treated as scheduled`);
    const cancelled = a.cancelled === true || a.status === 'cancelled' || HEALTH[health] === 'cancelled';
    const postponed = a.postponed === true || a.status === 'postponed' || HEALTH[health] === 'postponed';
    const rescheduled = HEALTH[health] === 'rescheduled';
    put('cancellation_status', cancelled ? 'cancelled' : postponed ? 'postponed' : rescheduled ? 'rescheduled' : 'scheduled');
    if (health) provenance.cancellation_status = 'shoebox health';
    put('categories', [].concat(a.category ?? a.categories ?? []).map(String));

    if (loc) {
      put('venue_name', loc.attributes?.name);
      put('city', loc.attributes?.city ?? loc.attributes?.town);
      put('country', loc.attributes?.country ?? loc.attributes?.['country-code']);
    }
    put('artists', (doc.data.relationships?.artists?.data ?? []).map(r => byType(r.type, r.id)?.attributes?.name).filter(Boolean));

    // ---- ticket tiers with ownership validation ----
    const rels = doc.data.relationships ?? {};
    const claimed = new Set([...(rels.tickets?.data ?? []), ...(rels['ticket-options']?.data ?? [])].map(r => String(r.id)));
    const tiers = [];
    const quarantined = [];
    for (const t of included.filter(i => TIER_TYPES.has(i.type))) {
      const ta = t.attributes ?? {};
      if (ta.visible === false) continue; // hidden by the promoter; not shown on the page
      const owner = ta['event-id'] ?? t.relationships?.event?.data?.id;
      const listed = claimed.has(String(t.id));
      let reason = null;
      if (owner !== undefined && String(owner) !== eventId) reason = `tier names event ${owner}, not ${eventId}${listed ? ' (although this event lists it)' : ''}`;
      else if (!listed && owner === undefined) reason = 'tier is not listed by this event and carries no event id';
      const cur = ta.currency ?? a.currency ?? 'GBP';
      const m = parseMoney(ta.price ?? ta['face-value'] ?? ta['price-sub-unit'], { currency: cur, minorUnits: true });
      const feeRaw = ta['transaction-fee-sub-unit'] ?? ta['booking-fee'];
      const fee = feeRaw == null ? null : parseMoney(feeRaw, { currency: cur, minorUnits: true }).amount;
      const timeOf = raw => (raw ? parseSourceTime(raw, tz).utc ?? null : null);
      const rawStatus = String(ta['on-sale-status'] ?? ta.status ?? '').toLowerCase().replace(/_/g, '-');
      const status = TIER_STATUS[rawStatus] ?? 'unknown';
      const tier = {
        source_tier_id: String(t.id), name: ta.name ?? 'Ticket', price: m.amount, fee, currency: m.currency,
        release_at: timeOf(pick(ta, 'release-at', 'on-sale-at', 'sale-starts-at')), off_sale_at: timeOf(ta['off-sale-at']),
        status, presale: typeof ta['pre-sale'] === 'boolean' ? ta['pre-sale'] : null, addon: ta.addon === true,
        quantity_available: Number.isInteger(ta['amount-available']) ? ta['amount-available'] : null,
        access_code_only: ta['accessible-via-access-code'] === true, provenance: 'shoebox',
      };
      if (rawStatus && status === 'unknown') warnings.push(`tier ${t.id}: status "${ta['on-sale-status'] ?? ta.status}" not recognised`);
      if (reason) { quarantined.push({ tier, reason }); anomalies.push(`quarantined tier ${t.id}: ${reason}`); }
      else tiers.push(tier);
    }
    for (const id of claimed) if (!included.some(i => String(i.id) === id && TIER_TYPES.has(i.type))) warnings.push(`event lists tier ${id} but its data is not on the page`);

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

    // Event-level values come only from accepted tiers, and not from add-ons (Fatsoma's own price-min/max
    // exclude them too: 1999/2999 on the observed page, where add-ons were 599–700).
    const main = tiers.filter(t => !t.addon);
    const prices = main.filter(t => t.price != null).map(t => t.price);
    if (prices.length) {
      put('minimum_price', Math.min(...prices));
      put('maximum_price', Math.max(...prices));
      put('currency', main.find(t => t.currency)?.currency);
    }
    const rolled = rollUpAvailability(main.map(t => ROLL[t.status] ?? null));
    if (rolled) put('published_availability_status', rolled);
    const releases = main.filter(t => !t.presale).map(t => t.release_at).filter(Boolean).sort();
    if (releases.length) put('published_on_sale_at', releases[0]);
    const presales = main.filter(t => t.presale).map(t => t.release_at).filter(Boolean).sort();
    if (presales.length) put('published_presale_at', presales[0]);

    let confidence = 0.8;
    // Fatsoma's own summary price (minor units) must agree with the tiers we accepted.
    if (Number.isInteger(a['price-min']) && fields.minimum_price != null && Math.round(fields.minimum_price * 100) !== a['price-min']) {
      warnings.push(`state price-min ${a['price-min']} differs from accepted tiers' lowest ${fields.minimum_price}`);
      confidence -= 0.1;
    }
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
      // JSON-LD Offers include add-ons, so compare with the AggregateOffer's lowPrice when there is one.
      const agg = ownOffers.find(o => String(o?.['@type'] ?? '').includes('AggregateOffer'));
      const ldLow = agg ? parseMoney(agg.lowPrice ?? agg.price, { currency: agg.priceCurrency ?? 'GBP' }).amount : null;
      if (ldLow != null && fields.minimum_price != null && ldLow !== fields.minimum_price) {
        warnings.push(`JSON-LD lowest price ${ldLow} differs from state ${fields.minimum_price}`);
        confidence -= 0.1;
      }
      // The state is authoritative for status; a disagreeing JSON-LD status is recorded, not used.
      const ldStatus = LD_STATUS[String(node.eventStatus ?? '').split('/').pop()];
      if (ldStatus && fields.cancellation_status && ldStatus !== fields.cancellation_status) {
        warnings.push(`JSON-LD eventStatus says ${ldStatus}; page state says ${fields.cancellation_status} (state used)`);
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
