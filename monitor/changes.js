import { EVENT_FIELDS } from './model.js';
import { stableStringify } from './values.js';

// Deterministic comparison of a stored event with a new VALID observation of it. See docs/CHANGE_DETECTION.md.
//
// Rules:
//  - Only fields confirmed in the new observation can change. A field that is missing, uncertain or
//    unavailable keeps its last valid value; that is recorded in field_meta, never as a change.
//  - A page whose markup changed but whose extracted fields did not produces no change (content hash).
//  - A tier that disappears is "not listed in latest", never "sold out".

// field → change kind. `published` is used when a value appears for the first time.
const TRACKED = {
  start_at: { kind: 'date_changed', group: 'date_venue' },
  end_at: { kind: 'end_time_changed', group: null },
  venue_name: { kind: 'venue_changed', group: 'date_venue' },
  city: { kind: 'venue_changed', group: 'date_venue' },
  minimum_price: { kind: 'price_changed', group: 'price', published: 'price_published' },
  maximum_price: { kind: 'price_changed', group: 'price', published: 'price_published' },
  currency: { kind: 'currency_changed', group: null },
  published_availability_status: { kind: 'status_changed', group: 'status', published: 'status_published' },
  published_on_sale_at: { kind: 'on_sale_changed', group: 'on_sale', published: 'on_sale_published' },
  published_presale_at: { kind: 'presale_changed', group: 'presale', published: 'presale_published' },
  cancellation_status: { kind: 'cancellation', group: 'cancellation' },
  title: { kind: 'title_changed', group: null },
};

// Kinds that are worth telling a user about, and the preference group that controls them.
export const NOTIFY_GROUPS = {
  new_event: 'new_event', date_changed: 'date_venue', venue_changed: 'date_venue',
  price_changed: 'price', price_published: 'price', status_changed: 'status',
  on_sale_published: 'on_sale', on_sale_changed: 'on_sale', presale_published: 'presale', presale_changed: 'presale',
  cancellation: 'cancellation', tier_added: 'tiers', tier_status_changed: 'tiers', tier_price_changed: 'tiers', tier_release_changed: 'tiers',
};
export const NOTIFY_TYPES = ['new_event', 'on_sale', 'presale', 'status', 'price', 'date_venue', 'cancellation', 'tiers'];

const same = (a, b) => stableStringify(a ?? null) === stableStringify(b ?? null);

// prev: stored event (or null). next: normalised connector event. Returns { fields, field_meta, diffs }.
export function diffEventFields(prev, next, observedAt) {
  const fields = {};
  const field_meta = {};
  const diffs = [];
  for (const k of EVENT_FIELDS) {
    const state = next.field_states[k] ?? 'unknown';
    const prevVal = prev ? prev[k] ?? null : null;
    const prevMeta = prev?.field_meta?.[k] ?? null;
    if (state === 'confirmed') {
      fields[k] = next.fields[k];
      field_meta[k] = { state: 'confirmed', confirmed_at: observedAt, via: next.provenance?.[k] ?? null };
      if (!prev) continue;
      const t = TRACKED[k];
      if (!t || same(prevVal, next.fields[k])) continue;
      if (prevVal === null) {
        // First appearance. A newly published on-sale/presale time is the important case. A first
        // "scheduled" status is not news.
        if (t.published && !(k === 'cancellation_status')) diffs.push({ field: k, kind: t.published, previous: null, current: next.fields[k] });
        else if (k === 'cancellation_status' && next.fields[k] !== 'scheduled') diffs.push({ field: k, kind: t.kind, previous: null, current: next.fields[k] });
      } else {
        diffs.push({ field: k, kind: t.kind, previous: prevVal, current: next.fields[k] });
      }
    } else {
      // Not confirmed now: retain the last valid value, say why it is not current.
      fields[k] = prevVal;
      field_meta[k] = {
        state: prevVal === null && state === 'missing' ? 'missing' : state,
        confirmed_at: prevMeta?.confirmed_at ?? null,
        via: prevMeta?.via ?? null,
        note: prevVal !== null ? `not ${state === 'uncertain' ? 'consistent' : 'published'} in latest observation; last valid value retained` : undefined,
      };
    }
  }
  // Collapse min/max price into one change per observation.
  const priceDiffs = diffs.filter(d => d.kind === 'price_changed' || d.kind === 'price_published');
  if (priceDiffs.length > 1) {
    const hadPrice = prev?.minimum_price != null || prev?.maximum_price != null;
    const merged = {
      field: 'price', kind: hadPrice ? 'price_changed' : 'price_published',
      previous: hadPrice ? { min: prev?.minimum_price ?? null, max: prev?.maximum_price ?? null } : null,
      current: { min: fields.minimum_price, max: fields.maximum_price },
    };
    return { fields, field_meta, diffs: [...diffs.filter(d => !priceDiffs.includes(d)), merged] };
  }
  return { fields, field_meta, diffs };
}

// prevTiers / nextTiers: arrays keyed by source_tier_id.
export function diffTiers(prevTiers, nextTiers) {
  const diffs = [];
  const prevById = new Map(prevTiers.map(t => [t.source_tier_id, t]));
  const nextIds = new Set(nextTiers.map(t => t.source_tier_id));
  const hadAny = prevTiers.length > 0;
  for (const t of nextTiers) {
    const p = prevById.get(t.source_tier_id);
    if (!p) {
      if (hadAny) diffs.push({ field: `tier:${t.source_tier_id}`, kind: 'tier_added', previous: null, current: tierView(t), tier: t.name });
      continue;
    }
    if (p.listed === false) diffs.push({ field: `tier:${t.source_tier_id}`, kind: 'tier_relisted', previous: null, current: tierView(t), tier: t.name });
    if (p.status !== t.status && t.status !== 'unknown') diffs.push({ field: `tier:${t.source_tier_id}:status`, kind: 'tier_status_changed', previous: p.status, current: t.status, tier: t.name });
    if (t.price !== null && p.price !== t.price) diffs.push({ field: `tier:${t.source_tier_id}:price`, kind: 'tier_price_changed', previous: p.price, current: t.price, tier: t.name, currency: t.currency });
    if (t.release_at && p.release_at !== t.release_at) diffs.push({ field: `tier:${t.source_tier_id}:release_at`, kind: 'tier_release_changed', previous: p.release_at, current: t.release_at, tier: t.name });
  }
  for (const p of prevTiers) {
    if (!nextIds.has(p.source_tier_id) && p.listed !== false) {
      diffs.push({ field: `tier:${p.source_tier_id}`, kind: 'tier_not_listed', previous: tierView(p), current: null, tier: p.name });
    }
  }
  return diffs;
}

const tierView = t => ({ name: t.name, price: t.price, currency: t.currency, status: t.status, release_at: t.release_at });

// Whether a change may be sent to users, and if not, why.
export function eligibility(diff, { confidence, minConfidence, staleOnArrival, fieldState }) {
  if (!NOTIFY_GROUPS[diff.kind]) return { eligible: false, reason: 'change type is recorded but not alerted' };
  if (staleOnArrival) return { eligible: false, reason: 'observation was already stale when received' };
  if (confidence < minConfidence) return { eligible: false, reason: `confidence ${confidence} below ${minConfidence}` };
  if (fieldState && fieldState !== 'confirmed') return { eligible: false, reason: `field is ${fieldState}` };
  if (diff.kind === 'cancellation' && diff.current === 'scheduled' && diff.previous === null) return { eligible: false, reason: 'first scheduled status is not news' };
  return { eligible: true, reason: null };
}
