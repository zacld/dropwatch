import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, fixture } from './monitor-helpers.js';
import { classifyResponse } from '../monitor/classify.js';
import { parseSourceTime, zonedToUtc } from '../monitor/time.js';
import { parseMoney } from '../monitor/values.js';
import { normaliseEventFields } from '../monitor/model.js';
import { ticketmaster } from '../monitor/connectors/ticketmaster.js';

const one = r => r.events.find(e => !e.rejected);

// ---------- Skiddle ----------

test('skiddle: parses the page\'s own Event JSON-LD and ignores related events', () => {
  const r = parse('skiddle', 'skiddle/event-v1.html');
  assert.equal(r.classification, 'ok');
  assert.equal(r.status, 'valid');
  assert.equal(r.events.length, 1);
  assert.match(r.anomalies.join(), /1 other Event node/);
  const e = one(r).fields;
  assert.equal(e.source_event_id, '40118811');
  assert.equal(e.title, 'KETTAMA: Halloween Warehouse');
  assert.equal(e.venue_name, 'Depot Mayfield');
  assert.equal(e.city, 'Manchester');
  assert.equal(e.country, 'GB');
  assert.equal(e.start_at, '2026-10-31T22:00:00.000Z');
  assert.equal(e.published_on_sale_at, '2026-10-16T09:00:00.000Z', '10:00 BST is 09:00 UTC');
  assert.equal(e.published_availability_status, 'not_yet_on_sale');
  assert.deepEqual([e.currency, e.minimum_price, e.maximum_price], ['GBP', 25.5, 30]);
  assert.deepEqual(e.artists, ['KETTAMA', 'Holy Priest']);
  assert.equal(one(r).tiers.length, 2);
  assert.ok(one(r).tiers.every(t => t.quantity.state === 'unavailable' && t.quantity.value === null), 'quantities are never invented');
});

test('skiddle: an AWS WAF script on a normal page does not make it a challenge', () => {
  const r = parse('skiddle', 'skiddle/event-v1.html');
  assert.equal(r.classification, 'ok');
  assert.deepEqual(r.evidence, []);
  // The same markers with no event content are a challenge, even with HTTP 200.
  assert.equal(classifyResponse({ status: 200, body: fixture('skiddle/waf-challenge.html') }, () => false).classification, 'challenge');
});

test('skiddle: the WAF challenge interstitial is rejected before parsing', () => {
  const r = parse('skiddle', 'skiddle/waf-challenge.html', { status: 202 });
  assert.equal(r.classification, 'challenge');
  assert.equal(r.ok, false);
  assert.equal(r.events.length, 0);
});

test('skiddle: local time without an offset is resolved in Europe/London (BST) and flagged', () => {
  const ev = one(parse('skiddle', 'skiddle/event-naive-time.html'));
  assert.equal(ev.fields.start_at, '2027-07-03T19:00:00.000Z');
  assert.ok(ev.warnings.some(w => /no UTC offset/.test(w)));
  assert.equal(ev.fields.currency, 'GBP', 'currency from the £ symbol');
  assert.equal(ev.fields.minimum_price, 22);
  assert.equal(ev.fields.country, 'GB');
});

test('skiddle: no offers means price and availability are missing, never sold out', () => {
  const ev = one(parse('skiddle', 'skiddle/event-no-offers.html'));
  assert.equal(ev.fields.published_availability_status, null);
  assert.equal(ev.field_states.published_availability_status, 'missing');
  assert.equal(ev.field_states.minimum_price, 'missing');
});

test('skiddle: malformed JSON-LD and missing required fields produce no event', () => {
  const r = parse('skiddle', 'skiddle/malformed.html');
  assert.equal(r.classification, 'ok');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'invalid');
  assert.ok(r.errors.some(e => /json-ld block 0/.test(e)));
  assert.ok(r.errors.some(e => /missing required: title, start_at/.test(e)));
});

test('skiddle: conflicting availability is marked uncertain and lowers confidence', () => {
  const ev = one(parse('skiddle', 'skiddle/event-conflict.html'));
  assert.equal(ev.field_states.published_availability_status, 'uncertain');
  assert.equal(ev.fields.published_availability_status, null);
  assert.ok(ev.confidence < 0.7);
});

test('skiddle: two Event nodes claiming the page are rejected as ambiguous', () => {
  const html = fixture('skiddle/event-v1.html').replace('Teletech-Halloween/40119922', 'Teletech-Halloween/40118811');
  const r = parse('skiddle', null, { body: html });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /ambiguous/);
});

// ---------- Fatsoma ----------

test('fatsoma: tiers are accepted only with ownership evidence; foreign tiers are quarantined', () => {
  const r = parse('fatsoma', 'fatsoma/event-v1.html');
  const ev = one(r);
  assert.equal(ev.fields.source_event_id, 'k3q9wz7m');
  assert.deepEqual(ev.tiers.map(t => t.source_tier_id), ['t-101', 't-102', 't-103']);
  const q = ev.quarantined_tiers.map(x => `${x.tier.source_tier_id}: ${x.reason}`);
  assert.equal(q.length, 3);
  assert.match(q[0], /t-555: tier names event p8x2aa01.*although this event lists it/);
  assert.match(q[1], /t-999: tier names event p8x2aa01/);
  assert.match(q[2], /JSON-LD offer links to another event/);
  // Foreign £9 / £11 tiers never reach event-level prices or status.
  assert.deepEqual([ev.fields.minimum_price, ev.fields.maximum_price, ev.fields.currency], [12.5, 20, 'GBP']);
  assert.ok(!ev.warnings.some(w => /differs from state/.test(w)), 'own JSON-LD price agrees with state');
});

test('fatsoma: tier prices in minor units, release times converted to UTC, statuses mapped', () => {
  const ev = one(parse('fatsoma', 'fatsoma/event-v1.html'));
  const t = Object.fromEntries(ev.tiers.map(x => [x.name, x]));
  assert.equal(t['Tier 1'].price, 16.5);
  assert.equal(t['Tier 2'].release_at, '2026-10-20T11:00:00.000Z');
  assert.equal(t['Early Bird'].status, 'sold_out');
  assert.equal(t['Tier 2'].status, 'not_yet_released');
  assert.equal(ev.fields.published_availability_status, 'on_sale');
});

test('fatsoma: a tier with no event id that the event does not list is quarantined', () => {
  const html = fixture('fatsoma/event-v1.html').replace('{"event-id":"p8x2aa01","name":"Final Release"', '{"name":"Final Release"');
  const ev = one(parse('fatsoma', null, { body: html }));
  assert.ok(ev.quarantined_tiers.some(q => q.tier.source_tier_id === 't-999' && /not listed by this event and carries no event id/.test(q.reason)));
});

// ---------- DICE ----------

test('dice: reads state; optional fields stay missing when absent', () => {
  const v1 = one(parse('dice', 'dice/event-v1.html'));
  assert.equal(v1.fields.announced_at, '2026-10-01T09:00:00.000Z');
  assert.equal(v1.field_states.published_on_sale_at, 'missing');
  assert.equal(v1.field_states.minimum_price, 'missing');
  assert.equal(v1.fields.published_availability_status, 'not_yet_on_sale');
  const v2 = one(parse('dice', 'dice/event-v2.html'));
  assert.equal(v2.fields.published_presale_at, '2026-10-15T08:00:00.000Z');
  assert.equal(v2.fields.published_on_sale_at, '2026-10-16T09:00:00.000Z');
  assert.deepEqual([v2.fields.minimum_price, v2.fields.maximum_price], [27.5, 38]);
  assert.equal(v2.provenance.published_on_sale_at, 'next-data');
});

test('dice: state and JSON-LD disagreeing on start time makes it uncertain', () => {
  const ev = parse('dice', 'dice/event-conflict.html').events[0];
  assert.equal(ev.field_states.start_at, 'uncertain');
  assert.deepEqual(ev.uncertain_required, ['start_at']);
  assert.ok(ev.confidence < 0.7);
});

test('dice: falls back to JSON-LD when there is no application state', () => {
  const html = fixture('dice/event-v1.html').replace(/<script id="__NEXT_DATA__"[\s\S]*?<\/script>/, '');
  const ev = one(parse('dice', null, { body: html }));
  assert.equal(ev.fields.start_at, '2026-10-31T22:00:00.000Z');
  assert.equal(ev.provenance.start_at, 'json-ld');
  assert.ok(ev.confidence <= 0.6);
});

// ---------- Ticketmaster ----------

test('ticketmaster: real Discovery payload normalises; status is event-level, not inventory', () => {
  const ev = one(parse('ticketmaster', 'ticketmaster/discovery-1AMZkfMGkdrlUIi.json', { observed_at: '2026-10-01T20:43:00.000Z' }));
  assert.equal(ev.fields.source_event_id, '1AMZkfMGkdrlUIi');
  assert.equal(ev.fields.start_at, '2027-07-03T13:00:00.000Z');
  assert.equal(ev.fields.venue_name, 'Finsbury Park');
  assert.deepEqual(ev.fields.artists, ['Josh Baker', 'KETTAMA', 'Prospa']);
  assert.equal(ev.fields.published_presale_at, '2026-09-29T09:00:00.000Z');
  assert.equal(ev.fields.published_availability_status, 'on_sale');
  assert.match(ev.provenance.published_availability_status, /not inventory/);
  assert.equal(ev.tiers.length, 0);
  assert.equal(ev.fields.minimum_price, null);
});

test('ticketmaster: "onsale" before the public on-sale time is not general sale', () => {
  const ev = one(parse('ticketmaster', 'ticketmaster/discovery-1AMZkfMGkdrlUIi.json', { observed_at: '2026-09-29T12:00:00.000Z' }));
  assert.equal(ev.fields.published_availability_status, 'not_yet_on_sale');
});

test('ticketmaster: interruption page is a challenge; other HTML is never parsed', () => {
  assert.equal(parse('ticketmaster', 'ticketmaster/interruption.html', { status: 403 }).classification, 'challenge');
  assert.equal(parse('ticketmaster', 'ticketmaster/interruption.html', { status: 200 }).classification, 'challenge');
  const r = parse('ticketmaster', 'skiddle/event-v1.html');
  assert.equal(r.classification, 'unexpected_content');
  assert.equal(r.events.length, 0);
});

test('ticketmaster: live request needs a key and redacts it', () => {
  assert.equal(ticketmaster.buildRequest('1AMZkfMGkdrlUIi', {}).error, 'awaiting_configuration');
  const req = ticketmaster.buildRequest('1AMZkfMGkdrlUIi', { ticketmasterApiKey: 'SECRETKEY123' });
  assert.match(req.url, /apikey=SECRETKEY123/);
  assert.doesNotMatch(req.redactedUrl, /SECRETKEY123/);
  assert.equal(ticketmaster.buildRequest('../../etc', { ticketmasterApiKey: 'k' }).error, 'bad_target');
});

// ---------- Resident Advisor ----------

test('resident advisor: CAPTCHA recognised and rejected; synthetic parse is low confidence', () => {
  const c = parse('resident-advisor', 'resident-advisor/captcha.html', { status: 403 });
  assert.equal(c.classification, 'captcha');
  assert.equal(c.ok, false);
  const s = one(parse('resident-advisor', 'resident-advisor/synthetic-event.html'));
  assert.equal(s.fields.source_event_id, '2299999');
  assert.ok(s.confidence <= 0.5);
});

// ---------- classification ----------

test('classification: rate limits, blocks, errors and transport failures', () => {
  const okBody = fixture('skiddle/event-v1.html');
  assert.deepEqual(classifyResponse({ status: 429, headers: { 'retry-after': '120' }, body: '' }), { classification: 'rate_limited', evidence: ['HTTP 429, Retry-After 120'], retryAfter: '120' });
  assert.equal(classifyResponse({ status: 403, body: 'Forbidden' }).classification, 'blocked');
  assert.equal(classifyResponse({ status: 404, body: 'nope' }).classification, 'not_found');
  assert.equal(classifyResponse({ status: 503, body: okBody }).classification, 'server_error');
  assert.equal(classifyResponse({ status: 200, body: '   ' }).classification, 'empty');
  assert.equal(classifyResponse({ error: 'fetch failed: ECONNRESET' }).classification, 'network_error');
  assert.equal(classifyResponse({ error: 'This operation was aborted' }).classification, 'timeout');
  assert.equal(classifyResponse({ status: 200, body: '<title>Just a moment...</title>' }, () => false).classification, 'challenge');
});

// ---------- time, money, model ----------

test('time: offsets, epochs, DST gap and overlap', () => {
  assert.equal(parseSourceTime('2026-07-04T20:00:00+01:00').utc, '2026-07-04T19:00:00.000Z');
  assert.equal(parseSourceTime('2026-07-04T20:00:00+0100').utc, '2026-07-04T19:00:00.000Z');
  assert.equal(parseSourceTime('2026-12-04T20:00:00', 'Europe/London').utc, '2026-12-04T20:00:00.000Z');
  assert.equal(parseSourceTime('2026-07-04T20:00:00', 'Europe/Madrid').utc, '2026-07-04T18:00:00.000Z');
  assert.equal(parseSourceTime(1792000000).utc, new Date(1792000000 * 1000).toISOString());
  assert.equal(parseSourceTime('2026-07-04T20:00:00', 'Not/AZone').utc, null);
  assert.equal(parseSourceTime('next friday', 'Europe/London').warning, 'invalid_time');
  // 29 Mar 2026 01:30 does not exist in London; 25 Oct 2026 01:30 happens twice.
  assert.equal(zonedToUtc({ y: 2026, mo: 3, d: 29, h: 1, mi: 30 }, 'Europe/London').warning, 'nonexistent_local_time');
  const amb = zonedToUtc({ y: 2026, mo: 10, d: 25, h: 1, mi: 30 }, 'Europe/London');
  assert.equal(amb.warning, 'ambiguous_local_time');
  assert.equal(new Date(amb.utcMs).toISOString(), '2026-10-25T00:30:00.000Z', 'earlier (BST) instant');
});

test('money: formats, symbols, codes, minor units and rejection', () => {
  assert.deepEqual(parseMoney('£1,234.50'), { amount: 1234.5, currency: 'GBP', ambiguousCurrency: false, warning: null });
  assert.equal(parseMoney('12,50 EUR').amount, 12.5);
  assert.equal(parseMoney('12,50 EUR').currency, 'EUR');
  assert.equal(parseMoney('$20').ambiguousCurrency, true);
  assert.equal(parseMoney('Free', { currency: 'GBP' }).amount, 0);
  assert.equal(parseMoney(1650, { currency: 'gbp', minorUnits: true }).amount, 16.5);
  assert.equal(parseMoney('thirty pounds', { currency: 'GBP' }).warning, 'invalid_price');
  assert.equal(parseMoney(-5, { currency: 'GBP' }).warning, 'invalid_price');
  assert.equal(parseMoney('£10', { currency: 'EUR' }).warning, 'currency_conflict');
  assert.equal(parseMoney('10.00').warning, 'missing_currency');
});

test('model: prices need a currency, ranges must be ordered, URLs must belong to the source', () => {
  const base = { source_event_id: '1', title: 'x', start_at: '2026-11-01T20:00:00.000Z' };
  const a = normaliseEventFields({ ...base, minimum_price: 10 });
  assert.equal(a.fields.minimum_price, null);
  assert.ok(a.problems.some(p => /without a currency/.test(p)));
  const b = normaliseEventFields({ ...base, minimum_price: 50, maximum_price: 10, currency: 'GBP' });
  assert.equal(b.fields.minimum_price, null);
  const c = normaliseEventFields({ ...base, canonical_url: 'https://evil.example/e/1' }, { allowedHosts: ['skiddle.com'] });
  assert.equal(c.fields.canonical_url, null);
  const d = normaliseEventFields({ ...base, start_at: '2026-11-01 20:00' });
  assert.deepEqual(d.missing_required, ['start_at']);
  const e = normaliseEventFields({ ...base, published_availability_status: 'maybe' });
  assert.equal(e.fields.published_availability_status, null);
});
