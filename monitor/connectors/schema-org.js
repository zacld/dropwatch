import { parseSourceTime } from '../time.js';
import { parseMoney, normaliseText, hashOf } from '../values.js';

// Reads a Schema.org Event node (JSON-LD) into canonical fields. Shared by connectors whose pages
// publish JSON-LD; each connector decides which node is the page's own event.

const AVAIL = {
  instock: 'on_sale', onlineonly: 'on_sale', instoreonly: 'on_sale', limitedavailability: 'limited',
  soldout: 'sold_out', outofstock: 'sold_out', preorder: 'not_yet_on_sale', presale: 'not_yet_on_sale',
  discontinued: 'off_sale',
};
const TIER_AVAIL = { on_sale: 'on_sale', limited: 'on_sale', sold_out: 'sold_out', not_yet_on_sale: 'not_yet_released', off_sale: 'off_sale' };
const STATUS = {
  eventscheduled: 'scheduled', eventcancelled: 'cancelled', eventpostponed: 'postponed',
  eventrescheduled: 'rescheduled', eventmovedonline: 'moved_online',
};

const lastSegment = v => (v ? String(v).split(/[/#]/).filter(Boolean).pop().toLowerCase() : null);
export const availabilityOf = v => (v ? AVAIL[lastSegment(v)] ?? null : null);
export const eventStatusOf = v => (v ? STATUS[lastSegment(v)] ?? null : null);
const arr = v => (v === undefined || v === null ? [] : [].concat(v));

// Event-level status from per-ticket statuses (tiers legitimately differ; that is not a conflict).
export function rollUpAvailability(values) {
  const v = values.filter(Boolean);
  if (!v.length) return null;
  if (v.includes('on_sale')) return 'on_sale';
  if (v.includes('limited')) return 'limited';
  if (v.every(x => x === 'sold_out')) return 'sold_out';
  if (v.every(x => x === 'not_yet_on_sale')) return 'not_yet_on_sale';
  if (v.every(x => x === 'off_sale')) return 'off_sale';
  if (v.every(x => ['sold_out', 'off_sale'].includes(x))) return 'sold_out';
  if (v.includes('not_yet_on_sale')) return 'not_yet_on_sale';
  return 'unknown';
}

export function schemaEvent(node, { timezone = 'Europe/London', currency = null, via = 'json-ld' } = {}) {
  const fields = {};
  const provenance = {};
  const warnings = [];
  const put = (k, v) => { if (v !== null && v !== undefined && !(Array.isArray(v) && !v.length)) { fields[k] = v; provenance[k] = via; } };
  const time = (k, raw) => {
    if (raw === undefined || raw === null || raw === '') return;
    const t = parseSourceTime(raw, timezone);
    if (!t.utc) { warnings.push(`${k}: could not parse "${raw}"`); return; }
    if (t.assumedTimezone) warnings.push(`${k}: no UTC offset published; interpreted in ${timezone}`);
    if (t.warning && t.warning !== 'missing') warnings.push(`${k}: ${t.warning}`);
    put(k, t.utc);
  };

  put('title', normaliseText(node.name));
  put('description', normaliseText(node.description));
  put('canonical_url', node.url ?? null);
  time('start_at', node.startDate);
  time('end_at', node.endDate);
  put('cancellation_status', eventStatusOf(node.eventStatus));
  if (node.eventStatus && !eventStatusOf(node.eventStatus)) warnings.push(`eventStatus "${node.eventStatus}" not recognised`);
  if (node.previousStartDate) warnings.push('source lists a previousStartDate (event moved)');

  const place = arr(node.location).find(l => l && typeof l === 'object') ?? null;
  if (place) {
    put('venue_name', normaliseText(place.name));
    const addr = place.address;
    if (addr && typeof addr === 'object') {
      put('city', normaliseText(addr.addressLocality));
      const c = addr.addressCountry;
      put('country', typeof c === 'object' ? c?.name ?? c?.identifier : c);
    }
  }
  put('artists', arr(node.performer).map(p => normaliseText(typeof p === 'string' ? p : p?.name)).filter(Boolean));

  // Offers: individual Offer nodes become tiers; an AggregateOffer gives a range and, possibly,
  // its own availability which must agree with the individual offers.
  const offers = [];
  let aggregate = null;
  for (const o of arr(node.offers)) {
    if (!o || typeof o !== 'object') continue;
    if (String(o['@type']).includes('AggregateOffer')) {
      aggregate = o;
      offers.push(...arr(o.offers).filter(x => x && typeof x === 'object'));
    } else offers.push(o);
  }
  const priced = [];
  const tiers = [];
  const seenIds = new Map();
  let curSeen = null;
  for (const o of offers) {
    const m = parseMoney(o.price ?? o.lowPrice, { currency: o.priceCurrency ?? currency });
    if (m.warning && m.warning !== 'missing') warnings.push(`offer "${o.name ?? '?'}": ${m.warning}`);
    if (m.amount !== null && m.currency) { priced.push(m.amount); curSeen ??= m.currency; }
    const avail = availabilityOf(o.availability);
    let release = null;
    if (o.validFrom) {
      const t = parseSourceTime(o.validFrom, timezone);
      if (t.utc) release = t.utc; else warnings.push(`offer validFrom unparseable: "${o.validFrom}"`);
      if (t.assumedTimezone) warnings.push(`offer validFrom: no UTC offset published; interpreted in ${timezone}`);
    }
    // Offers without an id (Skiddle's have none) get one from what identifies the ticket, never from its
    // price or status: otherwise a price change looks like one tier removed and another added.
    let tierId = String(o.sku ?? o['@id'] ?? o.identifier ?? `offer-${hashOf([o.name ?? '', o.url ?? '', o.category ?? '']).slice(0, 12)}`);
    const n = seenIds.get(tierId) ?? 0;
    seenIds.set(tierId, n + 1);
    if (n) tierId = `${tierId}#${n + 1}`;
    tiers.push({
      source_tier_id: tierId,
      name: o.name ?? 'Ticket',
      price: m.currency ? m.amount : null,
      currency: m.currency,
      release_at: release,
      status: avail ? TIER_AVAIL[avail] : 'unknown',
      url: o.url ?? null,
      provenance: via,
      _availability: avail,
    });
  }
  const aggLow = aggregate ? parseMoney(aggregate.lowPrice, { currency: aggregate.priceCurrency ?? currency }) : null;
  const aggHigh = aggregate ? parseMoney(aggregate.highPrice, { currency: aggregate.priceCurrency ?? currency }) : null;
  if (priced.length) {
    put('minimum_price', Math.min(...priced));
    put('maximum_price', Math.max(...priced));
    put('currency', curSeen);
  } else if (aggLow?.amount != null && aggLow.currency) {
    put('minimum_price', aggLow.amount);
    if (aggHigh?.amount != null) put('maximum_price', aggHigh.amount);
    put('currency', aggLow.currency);
  }

  const offerAvail = tiers.map(t => t._availability).filter(Boolean);
  const rolled = rollUpAvailability(offerAvail);
  const aggAvail = availabilityOf(aggregate?.availability);
  const uncertain = [];
  if (rolled && aggAvail && rolled !== aggAvail && !(rolled === 'limited' && aggAvail === 'on_sale')) {
    warnings.push(`availability conflict: offers say ${rolled}, AggregateOffer says ${aggAvail}`);
    uncertain.push('published_availability_status');
  } else put('published_availability_status', rolled ?? aggAvail);

  const releases = tiers.map(t => t.release_at).filter(Boolean).sort();
  const aggFrom = aggregate?.validFrom ? parseSourceTime(aggregate.validFrom, timezone).utc : null;
  put('published_on_sale_at', releases[0] ?? aggFrom);

  for (const t of tiers) delete t._availability;
  return { fields, provenance, warnings, tiers, uncertain };
}
