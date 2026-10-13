// Fatsoma organiser pages: one request covers the organiser's 12 soonest events (real page saved 13 Oct 2026,
// fixtures/fatsoma/organiser-riffraff-2026-10-13*.html). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, parse, fixture, T0, HOUR, iso } from './monitor-helpers.js';
import { createScheduler } from '../monitor/scheduler.js';
import { defaultPreferences } from '../monitor/preferences.js';

const MIN = 60_000;
const ORG = 'fatsoma/organiser-riffraff-2026-10-13.html';
const ORG2 = 'fatsoma/organiser-riffraff-2026-10-13-v2-derived.html';
const ORG3 = 'fatsoma/organiser-riffraff-2026-10-13-v3-derived.html';
const ORG_URL = 'https://www.fatsoma.com/p/riffraff';
const HALLOWEEN_URL = 'https://www.fatsoma.com/e/w12de4k1/project-halloween-manchester-s-biggest-halloween-event-10-000-people';
const HALLOWEEN = 'fatsoma:2ede4cdd-5e52-4250-af87-f63d73183bc5';
const byVanity = (db, v) => Object.values(db.events).find(e => e.canonical_url?.includes(`/e/${v}/`));
const ingest = (s, file, extra = {}) => s.engine.ingest({ source: 'fatsoma', target: ORG_URL, status: 200, observed_at: iso(s.clock.t), origin: 'fixture', body: fixture(file), ...extra });

test('real organiser page: 12 events, each with exactly its own tiers, none quarantined', () => {
  const r = parse('fatsoma', ORG);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, [], 'empty JSON-LD placeholders are not errors');
  assert.equal(r.events.length, 12);
  assert.deepEqual(r.events.map(e => e.tiers.length), [6, 6, 5, 5, 3, 6, 6, 5, 5, 3, 6, 6]);
  assert.equal(r.events.reduce((n, e) => n + e.quarantined_tiers.length, 0), 0);
  const first = r.events[0];
  assert.match(first.fields.source_event_id, /^[0-9a-f-]{36}$/, 'Fatsoma UUID, the same id the event page uses');
  assert.match(first.fields.canonical_url, /^https:\/\/www\.fatsoma\.com\/e\/gqo3b5it\/after-dark-presents-jwave/);
  assert.equal(first.fields.start_at, '2026-10-13T22:00:00.000Z', '23:00+01:00');
});

test('first check of a new organiser watch is a baseline: 12 events recorded, no alerts', async () => {
  const s = setup({ users: [defaultPreferences('everyone')] });
  const r = await ingest(s, ORG, { baseline: true });
  assert.equal(r.events.length, 12);
  assert.equal(r.changes.filter(c => c.kind === 'new_event').length, 12);
  assert.ok(r.changes.every(c => !c.notify_eligible && /baseline/.test(c.ineligible_reason)));
  assert.equal(s.sent.length, 0);
});

test('two organiser snapshots: a sold-out tier and a new release on one event, a new event, an ended event untouched', async () => {
  const s = setup({ users: [defaultPreferences('everyone')] });
  await ingest(s, ORG, { baseline: true });
  const ended = byVanity(s.db, 'gqo3b5it');
  const endedBefore = JSON.stringify(ended);

  s.clock.t += HOUR;
  const r = await ingest(s, ORG2);
  const offside = byVanity(s.db, 'nrohdgdp').id;
  const forOffside = r.changes.filter(c => c.event_id === offside);
  const sold = forOffside.find(c => c.kind === 'tier_status_changed' && !c.addon);
  assert.deepEqual([sold?.tier, sold?.previous, sold?.current], ['£5 Final Release Tickets', 'on_sale', 'sold_out']);
  assert.ok(forOffside.some(c => c.kind === 'tier_added' && c.tier === 'NEXT RELEASE (derived)' && c.notify_eligible));

  const added = r.changes.filter(c => c.kind === 'new_event');
  assert.equal(added.length, 1);
  assert.equal(added[0].notify_eligible, true, 'an event that appears after the baseline is news');
  assert.match(s.db.events[added[0].event_id].canonical_url, /zz9new01/);

  assert.equal(JSON.stringify(byVanity(s.db, 'gqo3b5it')), endedBefore, 'an event missing from the listing is not touched (not cancelled, not sold out)');
  assert.equal(r.changes.filter(c => c.event_id === ended.id).length, 0);
  assert.deepEqual(r.notifications.map(n => n.event_id).sort(), [added[0].event_id, offside].sort(), 'one alert per affected event');

  s.clock.t += HOUR;
  assert.equal((await ingest(s, ORG2)).notifications.length, 0, 'repeat sends nothing');
});

test('an event seen on its own page and later on the organiser page is one record, with no alert', async () => {
  const s = setup({ users: [defaultPreferences('everyone')] });
  await s.engine.ingest({ source: 'fatsoma', target: HALLOWEEN_URL, status: 200, observed_at: iso(s.clock.t), origin: 'fixture', body: fixture('fatsoma/real-2026-10-13.html') });
  await ingest(s, ORG2, { baseline: true });
  s.clock.t += HOUR;
  const r = await ingest(s, ORG3);
  const halloween = Object.values(s.db.events).filter(e => /w12de4k1/.test(e.canonical_url ?? ''));
  assert.equal(halloween.length, 1);
  assert.equal(halloween[0].id, HALLOWEEN);
  assert.equal(r.changes.filter(c => c.event_id === HALLOWEEN && c.notify_eligible).length, 0);
  assert.equal(r.notifications.length, 0);
});

// ---- scheduler: coverage rule and release windows across a listing ----

function harness({ env = {}, pages }) {
  const s = setup({ users: [defaultPreferences('everyone')], env: { DROPWATCH_SCHEDULER: 'on', DROPWATCH_LIVE_FATSOMA: 'on', DROPWATCH_INTERVAL_FATSOMA_MINUTES: '60', ...env } });
  const calls = [];
  const fetchImpl = async url => {
    const kind = url.includes('/p/') ? 'organiser' : 'event';
    calls.push({ t: s.clock.t, kind });
    return new Response(pages(kind, s.clock.t), { status: 200, headers: { 'content-type': 'text/html', 'x-cache-status': 'HIT' } });
  };
  const sch = createScheduler({ store: s.store, engine: s.engine, config: s.config, now: () => s.clock.t, fetchImpl });
  const runUntil = async end => { while (s.clock.t <= end) { await sch.tick(); s.clock.t += MIN; } };
  return { s, sch, calls, runUntil };
}

test('an event-page watch pauses while its organiser page lists the event, and resumes when it drops out', async () => {
  let listing = ORG2;
  const h = harness({ pages: kind => fixture(kind === 'organiser' ? listing : 'fatsoma/real-2026-10-13.html') });
  const org = h.sch.addTarget({ source: 'fatsoma', target: ORG_URL, interval_minutes: 60 });
  const ev = h.sch.addTarget({ source: 'fatsoma', target: HALLOWEEN_URL, interval_minutes: 60 });
  assert.deepEqual([org.kind, ev.kind], ['organiser', 'event']);

  await h.runUntil(T0 + 4 * HOUR);                       // Halloween not in the listing: both watches run
  assert.ok(h.calls.some(c => c.kind === 'event'));
  assert.equal(h.s.sent.length, 0, 'first checks of both watches are baselines');

  listing = ORG3;                                       // Halloween enters the 12-event window
  const t3 = h.s.clock.t;
  await h.runUntil(t3 + 6 * HOUR);
  const firstCovered = h.calls.find(c => c.t >= t3 && c.kind === 'organiser').t;
  assert.equal(h.calls.filter(c => c.kind === 'event' && c.t > firstCovered).length, 0, 'no separate event-page requests while covered');
  assert.match(h.s.db.targets.find(x => x.id === ev.id).last_result, /covered by organiser page/);

  listing = ORG2;                                       // Halloween drops out of the window again
  const t4 = h.s.clock.t;
  await h.runUntil(t4 + 4 * HOUR);
  assert.ok(h.calls.some(c => c.kind === 'event' && c.t > t4), 'event-page watch resumed');

  for (const c of h.calls) assert.ok(h.calls.filter(x => x.t > c.t - HOUR && x.t <= c.t).length <= 1, 'still one request per hour per site');
  const logged = h.s.db.request_log.filter(r => r.requested);
  assert.ok(logged.every(r => r.cache_status === 'HIT' && ['organiser', 'event'].includes(r.target_kind)));
});

test('release windows apply to every event an organiser page lists', async () => {
  const R = T0 + 5 * HOUR;
  // OFFSIDE 14 Oct's "NEXT RELEASE" tier: not yet on sale with a published time R, then on sale.
  const variant = status => fixture(ORG2).replace(/(<script type="fastboot\/shoebox" id="[^"]*v1events-filterstatusactivepageid[^"]*">)(.*?)(<\/script>)/s, (_, a, body, c) => {
    const doc = JSON.parse(JSON.parse(body));
    const tier = doc.included.find(x => x.id === '00000000-derived-0000-0000-offside-next1');
    Object.assign(tier.attributes, { 'on-sale-at': iso(R), 'on-sale-status': status });
    return a + JSON.stringify(JSON.stringify(doc)) + c;
  });
  const PRE = variant('not_on_sale');
  const POST = variant('available');
  const h = harness({ env: { DROPWATCH_RELEASE_WINDOW: 'on' }, pages: (kind, t) => (t < R + 30_000 ? PRE : POST) });
  h.sch.addTarget({ source: 'fatsoma', target: ORG_URL, interval_minutes: 60 });
  await h.runUntil(R + 30 * MIN);
  const extra = h.s.db.request_log.filter(r => r.kind === 'release_window' && r.requested);
  assert.deepEqual(extra.map(r => r.offset_minutes), [-2, 1, 5, 15]);
  const caught = extra.find(r => r.changes?.includes('tier_status_changed'));
  assert.equal(caught?.offset_minutes, 1);
  assert.equal(caught.alerts, 1);
});

test('several watches on one site share its hourly slot in rotation; none is starved', async () => {
  const h = harness({ pages: () => fixture('fatsoma/real-2026-10-13.html') });
  const urls = ['https://www.fatsoma.com/e/aaaaaaaa/one', 'https://www.fatsoma.com/e/bbbbbbbb/two', 'https://www.fatsoma.com/e/cccccccc/three'];
  const ids = urls.map(u => h.sch.addTarget({ source: 'fatsoma', target: u, interval_minutes: 60 }).id);
  await h.runUntil(T0 + 9 * HOUR - MIN);
  const order = h.s.db.request_log.filter(r => r.requested).map(r => ids.indexOf(r.target_id));
  assert.deepEqual(order, [0, 1, 2, 0, 1, 2, 0, 1, 2], 'each watch checked every 3 hours');
});

test('only Fatsoma event and organiser pages can be watched', () => {
  const h = harness({ pages: () => '' });
  assert.equal(h.sch.addTarget({ source: 'fatsoma', target: ORG_URL }).kind, 'organiser');
  assert.throws(() => h.sch.addTarget({ source: 'fatsoma', target: 'https://www.fatsoma.com/search?q=x' }), /event page .* or an organiser page/);
});
