import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NOTIFY_GROUPS } from './changes.js';
import { matchEvent } from './preferences.js';
import { formatInZone } from './time.js';
import { stableStringify } from './values.js';

// Notification interface: { id, send(notification) → { delivered, error? } }.
// The local implementation records notifications in the store (shown in the app) and appends them to
// an outbox file, matching how the existing checkout server records its notifications
// (data/server/outbox.jsonl). Push/email providers plug in here later.
export function createLocalNotifier(outboxFile) {
  if (outboxFile) mkdirSync(dirname(outboxFile), { recursive: true });
  return {
    id: 'local',
    async send(n) {
      if (outboxFile) appendFileSync(outboxFile, JSON.stringify(n) + '\n');
      return { delivered: true };
    },
  };
}

const money = (v, cur) => (v == null ? 'unknown' : new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur || 'GBP' }).format(v));
const AVAIL_TEXT = { on_sale: 'on sale', not_yet_on_sale: 'not yet on sale', limited: 'limited availability', sold_out: 'sold out', off_sale: 'off sale', unknown: 'status unknown' };
const TIER_TEXT = { on_sale: 'on sale', not_yet_released: 'not yet released', sold_out: 'sold out', off_sale: 'off sale', unknown: 'status unknown' };

// One line per change. Wording always describes what the SOURCE PUBLISHED at the observation time;
// it never says tickets are available now.
export function describeChange(c, ev, sourceName) {
  const tz = ev.timezone ?? 'Europe/London';
  const when = v => formatInZone(v, tz);
  switch (c.kind) {
    case 'new_event': {
      const state = ev.cancellation_status && ev.cancellation_status !== 'scheduled' && ev.cancellation_status !== 'unknown' ? ` Listed as ${ev.cancellation_status}.` : '';
      return `New on ${sourceName}: ${ev.title}${ev.venue_name ? `, ${ev.venue_name}` : ''}${ev.start_at ? `, ${when(ev.start_at)}` : ''}.${state}`;
    }
    case 'on_sale_published': return `${sourceName} published a general sale time: ${when(c.current)}. Not on sale before then.`;
    case 'on_sale_changed': return `${sourceName} moved the published general sale time from ${when(c.previous)} to ${when(c.current)}.`;
    case 'presale_published': return `${sourceName} published a presale time: ${when(c.current)}.`;
    case 'presale_changed': return `${sourceName} moved the published presale time from ${when(c.previous)} to ${when(c.current)}.`;
    case 'status_changed':
    case 'status_published': return `${sourceName} listed the event as ${AVAIL_TEXT[c.current] ?? c.current}${c.previous ? ` (was ${AVAIL_TEXT[c.previous] ?? c.previous})` : ''} when last checked.`;
    case 'price_changed':
    case 'price_published': {
      const cur = ev.currency;
      const fmt = p => (p && typeof p === 'object' ? (p.min === p.max || p.max == null ? money(p.min, cur) : `${money(p.min, cur)}–${money(p.max, cur)}`) : money(p, cur));
      const what = c.field === 'minimum_price' ? 'Lowest published price' : c.field === 'maximum_price' ? 'Highest published price' : 'Published price range';
      return c.previous == null ? `${sourceName} published prices: ${fmt(c.current)}.` : `${what} changed from ${fmt(c.previous)} to ${fmt(c.current)}.`;
    }
    case 'date_changed': return `Start time changed from ${when(c.previous)} to ${when(c.current)}.`;
    case 'venue_changed': return `Venue details changed from "${c.previous}" to "${c.current}".`;
    case 'cancellation': return `${sourceName} now lists the event as ${c.current}${c.previous && c.previous !== 'scheduled' ? ` (was ${c.previous})` : ''}.`;
    case 'tier_added': return `New ticket type listed: ${c.tier}${c.current?.price != null ? ` at ${money(c.current.price, c.current.currency)}` : ''} (${TIER_TEXT[c.current?.status] ?? 'status unknown'} when last checked).`;
    case 'tier_status_changed': return `"${c.tier}" was listed as ${TIER_TEXT[c.current] ?? c.current} (was ${TIER_TEXT[c.previous] ?? c.previous}) when last checked.`;
    case 'tier_price_changed': return `"${c.tier}" price changed from ${money(c.previous, c.currency)} to ${money(c.current, c.currency)}.`;
    case 'tier_release_changed': return `"${c.tier}" release time ${c.previous ? `moved from ${when(c.previous)} to` : 'published:'} ${when(c.current)}.`;
    default: return `${c.kind.replace(/_/g, ' ')}.`;
  }
}

// Turns eligible changes from one ingest into per-user notifications, de-duplicated per user.
export async function dispatchNotifications({ store, notifier, changes, events, sourceNames, now, dedupeHours, log }) {
  const db = store.data;
  const sent = [];
  const windowMs = dedupeHours * 3_600_000;
  const recentKeys = new Map();
  for (const n of db.notifications) for (const k of n.dedupe_keys ?? []) recentKeys.set(k, Date.parse(n.created_at));

  const byEvent = new Map();
  for (const c of changes.filter(c => c.notify_eligible)) {
    if (!byEvent.has(c.event_id)) byEvent.set(c.event_id, []);
    byEvent.get(c.event_id).push(c);
  }
  for (const [eventId, list] of byEvent) {
    const ev = events[eventId];
    for (const user of Object.values(db.users)) {
      const m = matchEvent(user, ev);
      if (!m.match) continue;
      const wanted = list.filter(c => user.notify_types.includes(NOTIFY_GROUPS[c.kind]));
      const fresh = [];
      const keys = [];
      for (const c of wanted) {
        // New-event alerts de-duplicate on the real-world event, so the same night listed on two
        // platforms only announces once.
        const subject = c.kind === 'new_event' ? `match:${ev.match_key}` : eventId;
        const key = `${user.id}|${subject}|${c.kind}|${c.field}|${stableStringify(c.current)}`;
        const at = recentKeys.get(key);
        if (at !== undefined && now - at < windowMs) { db.suppressed += 1; continue; }
        fresh.push(c);
        keys.push(key);
      }
      if (!fresh.length) continue;
      const sourceName = sourceNames[ev.source] ?? ev.source;
      const observedAt = fresh[0].observed_at;
      // An event with a single ticket type reports the same fact twice (event status and tier status, event
      // price and tier price). Say it once; both changes stay recorded and de-duplicated.
      const singleTier = Object.values(db.tiers).filter(x => x.event_id === eventId && x.listed !== false && !x.addon).length === 1;
      const shown = singleTier ? fresh.filter(c =>
        !(c.kind === 'tier_status_changed' && fresh.some(o => o.kind === 'status_changed')) &&
        !(c.kind === 'tier_price_changed' && fresh.some(o => o.kind === 'price_changed'))) : fresh;
      const lines = shown.map(c => describeChange(c, ev, sourceName));
      const n = {
        id: store.nextId('ntf'),
        user_id: user.id,
        event_id: eventId,
        change_ids: fresh.map(c => c.id),
        kinds: [...new Set(fresh.map(c => c.kind))],
        title: shown.some(c => c.kind === 'new_event') ? `New: ${ev.title}` : `${ev.title}: ${shown.length === 1 ? shown[0].kind.replace(/_/g, ' ') : `${shown.length} updates`}`,
        lines,
        body: `${lines.join(' ')} Last observed ${formatInZone(observedAt, ev.timezone ?? 'Europe/London')} on ${sourceName}.${ev.data_origin === 'fixture' ? ' (Sample data.)' : ''}`,
        url: ev.canonical_url,
        observed_at: observedAt,
        source: ev.source,
        data_origin: ev.data_origin,
        match_reasons: m.reasons,
        match_notes: m.notes,
        channel: notifier.id,
        created_at: new Date(now).toISOString(),
        dedupe_keys: keys,
      };
      const r = await notifier.send(n);
      n.delivered = !!r.delivered;
      db.notifications.push(n);
      for (const k of keys) recentKeys.set(k, now);
      sent.push(n);
      log?.info('notification', { user: user.id, event: eventId, kinds: n.kinds });
    }
  }
  return sent;
}
