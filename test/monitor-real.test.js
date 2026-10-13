// Change detection on REAL saved pages (13 Oct 2026) and documented edits of them ("derived" fixtures).
// Two snapshots in → changes → one alert; repeats, restyles, stale cached copies and flapping send nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, parse, T0, HOUR } from './monitor-helpers.js';
import { defaultPreferences } from '../monitor/preferences.js';
import { contentAsOf } from '../monitor/retrieve.js';

const SK = 'skiddle/real-2026-10-13.html';
const SK2 = 'skiddle/real-2026-10-13-v2-derived.html';
const FA = 'fatsoma/real-2026-10-13.html';
const FA2 = 'fatsoma/real-2026-10-13-v2-derived.html';
const FA_ID = 'fatsoma:2ede4cdd-5e52-4250-af87-f63d73183bc5';
const kinds = r => r.changes.map(c => c.kind).sort();
const alerted = r => r.changes.filter(c => c.notify_eligible).map(c => c.kind).sort();
const one = r => { assert.equal(r.events.length, 1); return r.events[0]; };

test('real skiddle page: event, venue, UTC times, price, availability and on-sale time', () => {
  const r = parse('skiddle', SK);
  assert.equal(r.ok, true);
  const ev = one(r);
  assert.equal(ev.fields.source_event_id, '42839932');
  assert.equal(ev.fields.start_at, '2027-06-05T12:00:00.000Z', '13:00+01:00 in JSON-LD');
  assert.deepEqual([ev.fields.venue_name, ev.fields.city], ['KOKO', 'London']);
  assert.deepEqual([ev.fields.minimum_price, ev.fields.currency, ev.fields.published_availability_status], [31, 'GBP', 'on_sale']);
  assert.equal(ev.fields.published_on_sale_at, '2026-10-11T11:00:00.000Z');
  assert.equal(ev.tiers.length, 1);
});

test('real fatsoma page: double-encoded state, ticket-options, add-ons, fees, counts and postponed health', () => {
  const r = parse('fatsoma', FA);
  assert.equal(r.ok, true, r.errors.join('; '));
  const ev = one(r);
  assert.equal(ev.quarantined_tiers.length, 0, 'every ticket-option is linked to this event by relationship');
  assert.equal(ev.tiers.length, 5);
  assert.equal(ev.tiers.filter(t => t.addon).length, 3);
  const final = ev.tiers.find(t => t.name.startsWith('⚠️ FINAL 20'));
  assert.deepEqual(
    { price: final.price, fee: final.fee, status: final.status, qty: final.quantity, release: final.release_at, presale: final.presale },
    { price: 29.99, fee: 3, status: 'on_sale', qty: { state: 'confirmed', value: 20 }, release: '2026-10-11T16:44:02.000Z', presale: false },
  );
  // Event-level prices exclude add-ons, matching Fatsoma's own price-min / price-max (1999 / 2999).
  assert.deepEqual([ev.fields.minimum_price, ev.fields.maximum_price], [19.99, 29.99]);
  assert.equal(ev.fields.cancellation_status, 'postponed');
  assert.ok(ev.warnings.some(w => /JSON-LD eventStatus says scheduled/.test(w)), 'the JSON-LD/state conflict is recorded');
  assert.equal(ev.fields.announced_at, '2026-09-19T18:47:21.000Z');
  assert.equal(ev.fields.timezone, 'Europe/London');
});

test('fatsoma: two snapshots → one alert for the real changes; the add-on change is recorded, not alerted', async () => {
  const s = setup({ users: [defaultPreferences('everyone')] });
  const first = await s.observe('fatsoma', FA);
  assert.deepEqual(kinds(first), ['new_event']);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].body, /Listed as postponed\./, 'a new-event alert must not hide a postponement');

  s.clock.t += HOUR;
  const second = await s.observe('fatsoma', FA2);
  assert.deepEqual(alerted(second), ['price_changed', 'tier_added', 'tier_status_changed']);
  const addon = second.changes.find(c => c.kind === 'tier_status_changed' && c.addon);
  assert.equal(addon.notify_eligible, false);
  assert.match(addon.ineligible_reason, /add-on/);
  const soldOut = second.changes.find(c => c.kind === 'tier_status_changed' && !c.addon);
  assert.deepEqual([soldOut.tier, soldOut.previous, soldOut.current], ['⚠️ FINAL 20 TICKETS ⚠️', 'on_sale', 'sold_out']);
  assert.equal(second.notifications.length, 1, 'all changes from one snapshot go out as one alert');
  assert.equal(second.notifications[0].lines.length, 3);
  assert.match(second.notifications[0].body, /FINAL RELEASE/);
  assert.equal(s.db.tiers[`${FA_ID}|00000000-derived-0000-0000-final-release`].quantity.value, 50);
});

test('no duplicates: repeat, restyle and stale cached copy of a snapshot send nothing', async () => {
  const s = setup({ users: [defaultPreferences('everyone')] });
  await s.observe('fatsoma', FA);
  s.clock.t += HOUR;
  await s.observe('fatsoma', FA2);
  const sentAfterChange = s.sent.length;

  s.clock.t += HOUR;
  const repeat = await s.observe('fatsoma', FA2);
  assert.equal(repeat.observation.events[0].outcome, 'unchanged');

  s.clock.t += HOUR;
  const restyled = (await import('node:fs')).readFileSync(new URL('../fixtures/' + FA2, import.meta.url), 'utf8')
    .replace('<body', '<!-- deploy 2026-10-13b --><body').replace(/<\/head>/, '<style>.x{color:red}</style></head>');
  const markup = await s.observe('fatsoma', null, { body: restyled });
  assert.equal(markup.observation.events[0].outcome, 'unchanged');

  // A CDN edge serves the OLD page after the new one: received now, generated 2.5 h ago.
  s.clock.t += HOUR;
  const stale = await s.observe('fatsoma', FA, { contentAsOf: s.clock.t - 2.5 * HOUR });
  assert.match(stale.observation.events[0].outcome, /^stale copy/);
  assert.equal(stale.changes.length, 0);

  assert.equal(s.sent.length, sentAfterChange, 'nothing further was sent');
});

test('no duplicates when a source flaps: the same transition inside the window alerts once', async () => {
  const s = setup({ users: [defaultPreferences('everyone')] });
  await s.observe('fatsoma', FA);
  s.clock.t += HOUR;
  const a = await s.observe('fatsoma', FA2);                 // FINAL 20 sold out
  assert.equal(a.notifications.length, 1);
  s.clock.t += HOUR;
  const b = await s.observe('fatsoma', FA);                  // back on sale (a different fact: alerted)
  assert.ok(b.changes.some(c => c.kind === 'tier_status_changed' && c.current === 'on_sale' && !c.addon));
  s.clock.t += HOUR;
  const c = await s.observe('fatsoma', FA2);                 // sold out again, 3 h after the first alert
  assert.ok(c.changes.some(x => x.kind === 'tier_status_changed' && x.current === 'sold_out'));
  assert.equal(c.notifications.length, 0, 'same tier, same new state, inside the 24 h window: suppressed');
  assert.ok(s.db.suppressed > 0);
});

test('skiddle: a price change keeps the tier identity (price_changed, not removed + added)', async () => {
  const s = setup({ users: [defaultPreferences('everyone')] });
  await s.observe('skiddle', SK);
  s.clock.t += HOUR;
  const r = await s.observe('skiddle', SK2);
  assert.deepEqual(kinds(r), ['price_changed', 'status_changed', 'tier_price_changed', 'tier_status_changed']);
  assert.ok(!r.changes.some(c => c.kind === 'tier_added' || c.kind === 'tier_not_listed'));
  const price = r.changes.find(c => c.kind === 'tier_price_changed');
  assert.deepEqual([price.previous, price.current], [31, 35]);
  assert.equal(r.notifications.length, 1);
  assert.match(r.notifications[0].body, /sold out/);
  assert.equal(r.notifications[0].lines.length, 2, 'single-tier event: event and tier lines are not repeated');
  assert.equal(r.notifications[0].change_ids.length, 4, 'all four changes are still recorded against the alert');
  s.clock.t += HOUR;
  assert.equal((await s.observe('skiddle', SK2)).notifications.length, 0);
});

test('content_as_of: origin Date minus CDN Age, never later than receipt', () => {
  // The real Skiddle response: Age 166 on a CloudFront hit.
  assert.equal(contentAsOf({ date: 'Tue, 13 Oct 2026 11:49:30 GMT', age: '166' }, '2026-10-13T11:49:31.000Z'), '2026-10-13T11:46:44.000Z');
  assert.equal(contentAsOf({ age: '60' }, '2026-10-13T12:00:00.000Z'), '2026-10-13T11:59:00.000Z');
  assert.equal(contentAsOf({}, '2026-10-13T12:00:00.000Z'), '2026-10-13T12:00:00.000Z');
  assert.equal(contentAsOf({ date: 'Tue, 13 Oct 2026 13:00:00 GMT' }, '2026-10-13T12:00:00.000Z'), '2026-10-13T12:00:00.000Z', 'a fast origin clock is capped at receipt time');
});
