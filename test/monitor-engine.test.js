import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, T0, HOUR, iso } from './monitor-helpers.js';
import { defaultPreferences, matchEvent, validatePreferences } from '../monitor/preferences.js';
import { createScheduler } from '../monitor/scheduler.js';
import { retrieveLive } from '../monitor/retrieve.js';
import { connectorById } from '../monitor/connectors/index.js';
import { migrate, SCHEMA_VERSION } from '../monitor/store.js';
import { createLogger } from '../monitor/log.js';

const kinds = r => r.changes.map(c => c.kind).sort();
const fan = (over = {}) => ({ ...defaultPreferences('fan'), follows: { artists: ['KETTAMA'], teams: [], categories: [], venues: [], events: [] }, ...over });

test('end to end: fixture → normalised event → persisted observation → change → one deduplicated notification', async () => {
  const s = setup({ users: [fan()] });
  const first = await s.observe('skiddle', 'skiddle/event-v1.html');
  assert.deepEqual(kinds(first), ['new_event']);
  assert.equal(s.sent.length, 1);
  const ev = s.db.events['skiddle:40118811'];
  assert.equal(ev.published_availability_status, 'not_yet_on_sale');
  assert.equal(ev.data_origin, 'fixture');
  assert.equal(s.db.observations.length, 1);

  s.clock.t += HOUR;
  const second = await s.observe('skiddle', 'skiddle/event-v2.html');
  assert.deepEqual(kinds(second), ['price_changed', 'status_changed', 'tier_added', 'tier_price_changed', 'tier_status_changed', 'tier_status_changed']);
  const status = second.changes.find(c => c.kind === 'status_changed');
  assert.deepEqual(
    { event: status.event_id, field: status.field, prev: status.previous, next: status.current, source: status.source, eligible: status.notify_eligible },
    { event: 'skiddle:40118811', field: 'published_availability_status', prev: 'not_yet_on_sale', next: 'on_sale', source: 'skiddle', eligible: true },
  );
  assert.equal(status.observed_at, iso(T0 + HOUR));
  assert.ok(status.confidence >= 0.7);
  assert.equal(second.notifications.length, 1, 'all changes from one observation go out as one notification');
  const n = second.notifications[0];
  assert.equal(n.url, 'https://www.skiddle.com/whats-on/Manchester/Depot-Mayfield/KETTAMA-Halloween-Warehouse/40118811/');
  assert.match(n.body, /when last checked/);
  assert.match(n.body, /Last observed/);
  assert.doesNotMatch(n.body, /available now|buy now|in stock/i);

  s.clock.t += HOUR;
  const third = await s.observe('skiddle', 'skiddle/event-v2.html');
  assert.equal(third.observation.events[0].outcome, 'unchanged');
  assert.equal(third.changes.length, 0);
  assert.equal(s.sent.length, 2, 'repeat observation sends nothing');
  assert.equal(s.db.events['skiddle:40118811'].observation_count, 3);
});

test('markup and styling changes alone produce no change', async () => {
  const s = setup();
  await s.observe('skiddle', 'skiddle/event-v1.html');
  s.clock.t += HOUR;
  const r = await s.observe('skiddle', 'skiddle/event-v1-restyled.html');
  assert.equal(r.observation.events[0].outcome, 'unchanged');
  assert.equal(r.changes.length, 0);
});

test('the same night on two platforms raises one new-event alert', async () => {
  const s = setup({ users: [fan()] });
  await s.observe('skiddle', 'skiddle/event-v1.html');
  const dice = await s.observe('dice', 'dice/event-v1.html');
  assert.deepEqual(kinds(dice), ['new_event']);
  assert.equal(dice.notifications.length, 0);
  assert.equal(s.sent.length, 1);
  assert.equal(s.db.suppressed, 1);
  assert.equal(s.db.events['skiddle:40118811'].match_key, s.db.events['dice:6512f0c0a1b2c3d4e5f60718'].match_key);
});

test('the same change is not alerted twice within the de-duplication window', async () => {
  const s = setup({ users: [fan()] });
  await s.observe('skiddle', 'skiddle/event-v1.html');
  s.clock.t += HOUR;
  await s.observe('skiddle', 'skiddle/event-v2.html');
  const before = s.sent.length;
  // The page flips back and forth: v1 → v2 again inside the window. The second v2 is a real change in
  // the data but the same alert, so it is suppressed.
  s.clock.t += HOUR;
  await s.observe('skiddle', 'skiddle/event-v1.html');
  s.clock.t += HOUR;
  const again = await s.observe('skiddle', 'skiddle/event-v2.html');
  assert.ok(again.changes.some(c => c.kind === 'status_changed'));
  assert.equal(again.notifications.length, 0);
  assert.equal(s.sent.length, before + 1, 'only the flip back to v1 alerted');
  assert.ok(s.db.suppressed > 0);
  // After the window the same transition alerts again.
  s.clock.t += 25 * HOUR;
  await s.observe('skiddle', 'skiddle/event-v1.html');
  s.clock.t += HOUR;
  const later = await s.observe('skiddle', 'skiddle/event-v2.html');
  assert.equal(later.notifications.length, 1);
});

test('challenge, CAPTCHA, error and malformed responses never create changes or alerts', async () => {
  const s = setup({ users: [fan({ follows: { artists: [], teams: [], categories: [], venues: [], events: [] } })] });
  await s.observe('skiddle', 'skiddle/event-v1.html');
  await s.observe('ticketmaster', 'ticketmaster/discovery-1AMZkfMGkdrlUIi.json');
  await s.observe('resident-advisor', 'resident-advisor/synthetic-event.html');
  const sentBefore = s.sent.length;
  const snapshot = JSON.stringify(s.db.events);
  const bad = [
    ['skiddle', 'skiddle/waf-challenge.html', 202],
    ['skiddle', 'skiddle/malformed.html', 200],
    ['skiddle', 'skiddle/event-v1.html', 503],
    ['skiddle', 'skiddle/event-v1.html', 429],
    ['ticketmaster', 'ticketmaster/interruption.html', 403],
    ['ticketmaster', 'skiddle/event-v1.html', 200],
    ['resident-advisor', 'resident-advisor/captcha.html', 200],
  ];
  for (const [src, file, status] of bad) {
    s.clock.t += HOUR;
    const r = await s.observe(src, file, { status });
    assert.equal(r.changes.length, 0, `${file} (${status}) made changes`);
    assert.equal(r.notifications.length, 0);
    assert.equal(r.observation.status === 'valid', false);
  }
  assert.equal(s.sent.length, sentBefore);
  assert.equal(JSON.stringify(s.db.events), snapshot, 'stored events untouched');
});

test('conflicting observations keep the last valid value and do not alert', async () => {
  const s = setup({ users: [fan()] });
  await s.observe('skiddle', 'skiddle/event-v2.html');
  s.clock.t += HOUR;
  const r = await s.observe('skiddle', 'skiddle/event-conflict.html');
  assert.equal(r.changes.length, 0);
  const ev = s.db.events['skiddle:40118811'];
  assert.equal(ev.published_availability_status, 'on_sale', 'last valid value retained');
  assert.equal(ev.field_meta.published_availability_status.state, 'uncertain');
  assert.equal(ev.field_meta.published_availability_status.confirmed_at, iso(T0));
  assert.equal(s.db.sources.skiddle.state, 'degraded');
});

test('an uncertain required field: kept for a known event, refused for a new one', async () => {
  const s = setup();
  const fresh = await s.observe('dice', 'dice/event-conflict.html');
  assert.match(fresh.observation.events[0].outcome, /rejected: start_at uncertain/);
  assert.equal(Object.keys(s.db.events).length, 0);
  await s.observe('dice', 'dice/event-v2.html');
  s.clock.t += HOUR;
  const r = await s.observe('dice', 'dice/event-conflict.html');
  const ev = s.db.events['dice:6512f0c0a1b2c3d4e5f60718'];
  assert.equal(ev.start_at, '2026-10-31T22:00:00.000Z');
  assert.equal(ev.field_meta.start_at.state, 'uncertain');
  assert.ok(!r.changes.some(c => c.kind === 'date_changed'));
  assert.ok(r.changes.every(c => !c.notify_eligible), 'low-confidence observation cannot alert');
});

test('a field missing from a later valid observation is not a change and never "sold out"', async () => {
  const s = setup({ users: [fan()] });
  await s.observe('skiddle', 'skiddle/event-v2.html');
  s.clock.t += HOUR;
  const noOffers = fixture('skiddle/event-v2.html').replace(/,\s*"offers": \[[\s\S]*?\n  \]/, '');
  const r = await s.observe('skiddle', null, { body: noOffers });
  const ev = s.db.events['skiddle:40118811'];
  assert.equal(ev.published_availability_status, 'on_sale');
  assert.equal(ev.field_meta.published_availability_status.state, 'missing');
  assert.equal(ev.minimum_price, 25.5);
  assert.ok(!r.changes.some(c => ['status_changed', 'price_changed'].includes(c.kind)));
  // Tiers that disappear are "not listed", not sold out, and do not alert.
  const notListed = r.changes.filter(c => c.kind === 'tier_not_listed');
  assert.equal(notListed.length, 3);
  assert.ok(notListed.every(c => !c.notify_eligible));
  const tier = s.db.tiers['skiddle:40118811|sk-40118811-2'];
  assert.equal(tier.listed, false);
  assert.equal(tier.status, 'on_sale', 'status is not rewritten');
  assert.equal(r.notifications.length, 0);
});

test('stale observations are stored as history but never alert', async () => {
  const s = setup({ users: [fan()] });
  const r = await s.observe('skiddle', 'skiddle/event-v1.html', { at: T0 - 48 * HOUR });
  assert.equal(r.changes[0].kind, 'new_event');
  assert.equal(r.changes[0].notify_eligible, false);
  assert.match(r.changes[0].ineligible_reason, /stale/);
  assert.equal(r.notifications.length, 0);
  assert.equal(s.engine.eventView(s.db.events['skiddle:40118811']).freshness, 'stale');
  assert.equal(s.engine.eventView(s.db.events['skiddle:40118811']).field_meta.title.state, 'stale');
});

test('the real Ticketmaster payload, observed 1 Oct, is stale on 13 Oct and does not alert', async () => {
  const s = setup({ users: [fan()] });
  const r = await s.engine.ingest({ source: 'ticketmaster', status: 200, observed_at: '2026-10-01T20:43:00.000Z', origin: 'fixture', body: fixture('ticketmaster/discovery-1AMZkfMGkdrlUIi.json') });
  assert.equal(r.notifications.length, 0);
  assert.match(r.observation.note, /no alerts/);
  // Received just now, but the data is 12 days old: the source is stale, not healthy.
  assert.equal(s.engine.sourcesView().find(x => x.source === 'ticketmaster').state, 'stale');
});

test('observations arriving out of order are ignored', async () => {
  const s = setup();
  await s.observe('skiddle', 'skiddle/event-v2.html', { at: T0 });
  const r = await s.observe('skiddle', 'skiddle/event-v1.html', { at: T0 - HOUR });
  assert.match(r.observation.events[0].outcome, /out of order/);
  assert.equal(r.changes.length, 0);
  assert.equal(s.db.events['skiddle:40118811'].published_availability_status, 'on_sale');
});

test('rescheduling and postponement are detected and alerted', async () => {
  const s = setup({ users: [fan({ follows: { artists: ['KETTAMA', 'Josh Baker'], teams: [], categories: [], venues: [], events: [] } })] });
  await s.observe('skiddle', 'skiddle/event-v2.html');
  s.clock.t += HOUR;
  const r = await s.observe('skiddle', 'skiddle/event-v3-rescheduled.html');
  const date = r.changes.find(c => c.kind === 'date_changed');
  assert.deepEqual([date.previous, date.current], ['2026-10-31T22:00:00.000Z', '2026-11-07T22:00:00.000Z']);
  const cancel = r.changes.find(c => c.kind === 'cancellation');
  assert.deepEqual([cancel.previous, cancel.current, cancel.notify_eligible], ['scheduled', 'rescheduled', true]);
  assert.equal(r.notifications.length, 1);

  await s.observe('ticketmaster', 'ticketmaster/discovery-1AMZkfMGkdrlUIi.json');
  s.clock.t += HOUR;
  const tm = await s.engine.ingest({ source: 'ticketmaster', status: 200, observed_at: iso(s.clock.t), origin: 'fixture', body: fixture('ticketmaster/discovery-1AMZkfMGkdrlUIi-v2-synthetic.json') });
  assert.deepEqual(kinds(tm), ['cancellation', 'price_published', 'status_changed']);
  assert.equal(tm.changes.find(c => c.kind === 'status_changed').current, 'off_sale');
});

test('newly published on-sale and presale times are detected; alert never claims tickets are on sale', async () => {
  const s = setup({ users: [fan()] });
  await s.observe('dice', 'dice/event-v1.html');
  s.clock.t += HOUR;
  const r = await s.observe('dice', 'dice/event-v2.html');
  assert.deepEqual(kinds(r), ['on_sale_published', 'presale_published', 'price_published']);
  const body = r.notifications[0].body;
  assert.match(body, /published a general sale time: Fri, 16 Oct 2026, 10:00 BST\. Not on sale before then/);
  assert.match(body, /published a presale time/);
});

test('fatsoma tier releases are tracked; quarantined tiers never alert', async () => {
  const s = setup({ users: [fan({ follows: { artists: ['Toxic Machinery'], teams: [], categories: [], venues: [], events: [] } })] });
  await s.observe('fatsoma', 'fatsoma/event-v1.html');
  assert.equal(s.db.quarantined['fatsoma:k3q9wz7m'].length, 3);
  s.clock.t += HOUR;
  const r = await s.observe('fatsoma', 'fatsoma/event-v2.html');
  assert.deepEqual(r.changes.map(c => `${c.tier}:${c.previous}->${c.current}`).sort(), ['Tier 1:on_sale->sold_out', 'Tier 2:not_yet_released->on_sale']);
  assert.ok(!JSON.stringify(r.changes).includes('t-555') && !JSON.stringify(r.changes).includes('t-999'));
  assert.equal(r.notifications.length, 1);
});

test('low-confidence sources are recorded but not alerted', async () => {
  const s = setup({ users: [defaultPreferences('everyone')] });
  const r = await s.observe('resident-advisor', 'resident-advisor/synthetic-event.html');
  assert.equal(r.changes[0].notify_eligible, false);
  assert.match(r.changes[0].ineligible_reason, /confidence/);
});

test('source health: challenge pauses the source; a later valid observation recovers it', async () => {
  const s = setup();
  await s.observe('skiddle', 'skiddle/waf-challenge.html', { status: 202 });
  let h = s.db.sources.skiddle;
  assert.equal(h.state, 'challenge_detected');
  assert.equal(h.consecutive_failures, 1);
  assert.equal(h.paused_until, iso(T0 + 24 * HOUR));
  s.clock.t += HOUR;
  await s.observe('skiddle', 'skiddle/event-v1.html', { status: 429 });
  assert.equal(s.db.sources.skiddle.state, 'rate_limited');
  assert.equal(s.db.sources.skiddle.consecutive_failures, 2);
  s.clock.t += HOUR;
  await s.observe('skiddle', 'skiddle/malformed.html');
  assert.equal(s.db.sources.skiddle.state, 'parse_error');
  s.clock.t += HOUR;
  await s.observe('skiddle', 'skiddle/event-v1.html');
  h = s.db.sources.skiddle;
  assert.equal(h.state, 'healthy');
  assert.equal(h.consecutive_failures, 0);
  assert.equal(h.paused_until, null);
  assert.equal(h.last_valid_parse_at, iso(s.clock.t));
  assert.equal(h.last_origin, 'fixture');
  // Freshness on read: a day later with no observation the source is stale.
  s.clock.t += 25 * HOUR;
  const view = s.engine.sourcesView().find(x => x.source === 'skiddle');
  assert.equal(view.state, 'stale');
  assert.equal(view.live_retrieval, 'off');
  assert.equal(s.engine.sourcesView().find(x => x.source === 'ticketmaster').state, 'awaiting_configuration');
  assert.equal(s.engine.sourcesView().find(x => x.source === 'resident-advisor').live_retrieval, 'not_permitted');
});

test('kill switch: a disabled source ingests nothing', async () => {
  const s = setup({ env: { DROPWATCH_SOURCE_SKIDDLE: 'off' } });
  const r = await s.observe('skiddle', 'skiddle/event-v1.html');
  assert.equal(r.observation.classification, 'disabled');
  assert.equal(Object.keys(s.db.events).length, 0);
  assert.equal(s.engine.sourcesView().find(x => x.source === 'skiddle').state, 'disabled');
});

test('preferences: interests, cities, dates, price ceilings and currency', () => {
  const ev = { id: 'x', source: 'skiddle', title: 'KETTAMA: Halloween Warehouse', artists: ['KETTAMA'], venue_name: 'Depot Mayfield', city: 'Manchester', start_at: '2026-10-31T22:00:00.000Z', minimum_price: 25.5, currency: 'GBP', categories: ['music'] };
  const u = defaultPreferences('u');
  assert.equal(matchEvent(u, ev).match, true, 'following nothing matches everything');
  assert.equal(matchEvent({ ...u, follows: { ...u.follows, artists: ['Overmono'] } }, ev).match, false);
  assert.equal(matchEvent({ ...u, follows: { ...u.follows, venues: ['depot mayfield'] } }, ev).match, true);
  assert.equal(matchEvent({ ...u, follows: { ...u.follows, teams: ['Arsenal'] } }, { ...ev, title: 'Arsenal v Spurs' }).match, true);
  assert.equal(matchEvent({ ...u, cities: ['Leeds'] }, ev).match, false);
  assert.equal(matchEvent({ ...u, date_to: '2026-10-30T00:00:00.000Z' }, ev).match, false);
  assert.equal(matchEvent({ ...u, max_price: 20 }, ev).match, false);
  assert.equal(matchEvent({ ...u, max_price: 30 }, ev).match, true);
  const unknownPrice = matchEvent({ ...u, max_price: 20 }, { ...ev, minimum_price: null });
  assert.deepEqual([unknownPrice.match, unknownPrice.notes], [true, ['price not published']]);
  assert.match(matchEvent({ ...u, max_price: 20 }, { ...ev, currency: 'EUR' }).notes[0], /not compared/);
  const v = validatePreferences({ max_price: -1, currency: 'pounds', notify_types: ['status', 'bogus'], date_from: '2026-12-01', date_to: '2026-11-01' }, u);
  assert.equal(v.ok, false);
  assert.equal(v.errors.length, 4);
});

test('per-user notification types and filters are respected', async () => {
  const onlyStatus = { ...fan(), id: 'status-only', notify_types: ['status'] };
  const cheap = { ...fan(), id: 'cheap', max_price: 20 };
  const s = setup({ users: [onlyStatus, cheap] });
  await s.observe('skiddle', 'skiddle/event-v1.html');
  assert.equal(s.sent.length, 0, 'status-only user gets no new-event alert; cheap user is priced out');
  s.clock.t += HOUR;
  const r = await s.observe('skiddle', 'skiddle/event-v2.html');
  assert.equal(r.notifications.length, 1);
  assert.equal(r.notifications[0].user_id, 'status-only');
  assert.deepEqual(r.notifications[0].kinds, ['status_changed']);
});

test('scheduler: off by default; refuses live retrieval unless enabled; pauses after rate limiting', async () => {
  let calls = 0;
  const callTimes = [];
  let clockRef = null;
  const fetchImpl = async () => { calls++; callTimes.push(clockRef()); return new Response('', { status: 429, headers: { 'retry-after': '3600' } }); };
  const off = setup();
  const sOff = createScheduler({ store: off.store, engine: off.engine, config: off.config, now: () => off.clock.t, fetchImpl });
  assert.equal((await sOff.tick()).reason, 'scheduler off');

  const s = setup({ env: { DROPWATCH_SCHEDULER: 'on', DROPWATCH_LIVE_SKIDDLE: 'on', DROPWATCH_INTERVAL_SKIDDLE_MINUTES: '5' } });
  assert.equal(s.config.sources.skiddle.intervalMinutes, 60, 'interval floor for page sources');
  clockRef = () => s.clock.t;
  const sch = createScheduler({ store: s.store, engine: s.engine, config: s.config, now: () => s.clock.t, fetchImpl });
  assert.throws(() => sch.addTarget({ source: 'resident-advisor', target: 'https://ra.co/events/1' }), /no permitted live access/);
  sch.addTarget({ source: 'skiddle', target: 'https://www.skiddle.com/whats-on/x/y/z/40118811/', interval_minutes: 1 });
  const first = await sch.tick();
  assert.equal(first.observation.classification, 'rate_limited');
  assert.equal(calls, 1);
  assert.equal(s.db.sources.skiddle.state, 'rate_limited');
  // A tick every minute for 12 hours. Each rate limit pauses the source for at least 6 hours
  // (Retry-After was 1 hour), so the gap between requests never shrinks below that.
  for (let i = 0; i < 12 * 60; i++) { s.clock.t += 60_000; await sch.tick(); }
  assert.ok(calls <= 3, `made ${calls} requests in 12 hours while rate limited`);
  for (let i = 1; i < callTimes.length; i++) assert.ok(callTimes[i] - callTimes[i - 1] >= 6 * HOUR, 'requests closer than the pause');
});

test('live retrieval: refuses off-site URLs, disabled live access, and keeps keys out of logs', async () => {
  const lines = [];
  const log = createLogger({ sink: l => lines.push(l) });
  const s = setup({ env: { DROPWATCH_LIVE_SKIDDLE: 'on', DROPWATCH_LIVE_TICKETMASTER: 'on', TICKETMASTER_API_KEY: 'TOPSECRETKEY' } });
  const fetchImpl = async url => new Response(fixture('ticketmaster/discovery-1AMZkfMGkdrlUIi.json'), { status: 200, headers: { 'content-type': 'application/json' } });
  assert.match((await retrieveLive(connectorById('skiddle'), 'https://evil.example/whats-on/1/', s.config, { fetchImpl })).refused, /not a Skiddle host/);
  assert.match((await retrieveLive(connectorById('dice'), 'https://dice.fm/event/x', s.config, { fetchImpl })).refused, /live retrieval is off/);
  assert.match((await retrieveLive(connectorById('resident-advisor'), 'https://ra.co/events/1', s.config, { fetchImpl })).refused, /not permitted/);
  const obs = await retrieveLive(connectorById('ticketmaster'), '1AMZkfMGkdrlUIi', s.config, { fetchImpl, log, now: () => s.clock.t });
  assert.equal(obs.status, 200);
  assert.equal(obs.origin, 'live');
  const r = await s.engine.ingest(obs);
  assert.equal(r.observation.status, 'valid');
  assert.ok(lines.length > 0);
  assert.ok(lines.every(l => !l.includes('TOPSECRETKEY')), 'API key must not be logged');
  assert.equal(s.db.sources.ticketmaster.last_live_success_at, iso(s.clock.t));
});

test('store: older data files are migrated', () => {
  const d = migrate({ events: {}, tiers: {}, observations: [], changes: [], notifications: [], sources: {}, users: {}, targets: [], seq: 5 });
  assert.equal(d.schema_version, SCHEMA_VERSION);
  assert.deepEqual(d.quarantined, {});
  assert.equal(d.seq, 5);
  assert.throws(() => migrate({ schema_version: SCHEMA_VERSION + 1 }), /newer/);
});
