// Phase 3 (bursts) and Phase 4 (external/email triggers). Simulated with the real Fatsoma event page and edits of
// it; the scheduler ticks once a minute as it does live. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, fixture, T0, HOUR, iso } from './monitor-helpers.js';
import { createScheduler } from '../monitor/scheduler.js';
import { detectionReport, triggerReport } from '../monitor/reports.js';
import { parseEmail, fatsomaEventLinks } from '../monitor/sources/email.js';
import { defaultPreferences } from '../monitor/preferences.js';
import { loadConfig } from '../monitor/config.js';
import { createMonitorApp } from '../monitor/app.js';

const MIN = 60_000;
const URL_ = 'https://www.fatsoma.com/e/w12de4k1/project-halloween-manchester-s-biggest-halloween-event-10-000-people';
const ORG_URL = 'https://www.fatsoma.com/p/riffraff';
const V2 = fixture('fatsoma/real-2026-10-13-v2-derived.html'); // FINAL 20 sold out, add-on sold out, FINAL RELEASE added

// Edit the event's tiers inside the page's double-encoded shoebox state.
function edit(html, fn) {
  return html.replace(/(<script type="fastboot\/shoebox" id="[^"]*eventsw12de4k1[^"]*">)(.*?)(<\/script>)/s, (_, a, body, c) => {
    const doc = JSON.parse(JSON.parse(body));
    fn(doc, name => doc.included.find(x => x.type === 'ticket-options' && x.attributes.name.includes(name)));
    return a + JSON.stringify(JSON.stringify(doc)) + c;
  });
}
const S = T0 + 2.5 * HOUR;       // FINAL 20 sells out
const W = T0 + 3 * HOUR + 4 * MIN; // next wave (FINAL RELEASE) appears
// Before S: FINAL 20 on sale, FINAL RELEASE not yet listed. S..W: FINAL 20 sold out. After W: FINAL RELEASE on sale.
const BEFORE = edit(V2, (doc, tier) => {
  Object.assign(tier('FINAL 20').attributes, { 'on-sale-status': 'available', 'amount-available': 20 });
  Object.assign(tier('Queue Jump').attributes, { 'on-sale-status': 'available', 'amount-available': 20 });
  doc.included = doc.included.filter(x => x.id !== '00000000-derived-0000-0000-final-release');
  doc.data.relationships['ticket-options'].data = doc.data.relationships['ticket-options'].data.filter(x => x.id !== '00000000-derived-0000-0000-final-release');
});
const SOLD = edit(BEFORE, (doc, tier) => Object.assign(tier('FINAL 20').attributes, { 'on-sale-status': 'sold_out', 'amount-available': 0 }));
const pageAt = t => (t < S ? BEFORE : t < W ? SOLD : V2);

function harness({ env = {}, respond, organiser = null } = {}) {
  const s = setup({ users: [defaultPreferences('everyone')], env: { DROPWATCH_SCHEDULER: 'on', DROPWATCH_LIVE_FATSOMA: 'on', DROPWATCH_INTERVAL_FATSOMA_MINUTES: '60', DROPWATCH_SIGNAL_BURSTS: 'on', ...env } });
  const calls = [];
  const fetchImpl = async url => {
    calls.push({ t: s.clock.t, url });
    if (respond) return respond(s.clock.t, url);
    const body = url.includes('/p/') ? organiser : pageAt(s.clock.t);
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html', 'x-cache-status': 'MISS' } });
  };
  const sch = createScheduler({ store: s.store, engine: s.engine, config: s.config, now: () => s.clock.t, fetchImpl });
  const runUntil = async end => { while (s.clock.t <= end) { await sch.tick(); s.clock.t += MIN; } };
  return { s, sch, calls, runUntil };
}
const bursts = db => db.request_log.filter(r => r.kind === 'burst');
const minutesAfter = (iso_, base) => Math.round((Date.parse(iso_) - base) / MIN);

test('sell-out → burst: the next wave is caught at +5 min instead of the next hourly check, and alerted once', async () => {
  const h = harness();
  h.sch.addTarget({ source: 'fatsoma', target: URL_, interval_minutes: 60 });
  await h.runUntil(T0 + 5 * HOUR);

  const sent = bursts(h.s.db).filter(r => r.requested);
  assert.deepEqual(sent.map(r => r.offset_minutes), [2, 5, 15]);
  assert.deepEqual(sent.map(r => minutesAfter(r.at, T0 + 3 * HOUR)), [2, 5, 15], 'after the 3h check that saw the sell-out');
  assert.match(sent[0].reason, /^sold_out trigger \("⚠️ FINAL 20 TICKETS ⚠️" sold out\) \+2 min$/);
  const caught = sent.find(r => r.changes?.includes('tier_added'));
  assert.equal(caught.offset_minutes, 5);
  assert.equal(caught.alerts, 1);

  const row = detectionReport(h.s.db).find(r => r.kind === 'tier_added');
  assert.equal(row.found_by.kind, 'burst');
  assert.equal(row.window_minutes, 3, 'appeared between the +2 and +5 burst checks');
  const trig = triggerReport(h.s.db).find(r => r.type === 'sold_out');
  assert.ok(trig.first_change.kinds.includes('tier_added'), trig.first_change.kinds.join(','));
  assert.equal(trig.first_change.minutes_after_trigger, 5);
  assert.equal(h.s.sent.filter(n => n.kinds.includes('tier_added')).length, 1, 'one alert for the new wave');
});

test('bursts off: the same wave waits for the next hourly check', async () => {
  const h = harness({ env: { DROPWATCH_SIGNAL_BURSTS: 'off' } });
  h.sch.addTarget({ source: 'fatsoma', target: URL_, interval_minutes: 60 });
  await h.runUntil(T0 + 5 * HOUR);
  assert.equal(bursts(h.s.db).length, 0);
  assert.equal(h.s.db.trigger_log.length, 0);
  const row = detectionReport(h.s.db).find(r => r.kind === 'tier_added');
  assert.equal(minutesAfter(row.observed_at, W), 56, 'found at 4:00, 56 min after it appeared');
});

test('bursts and release windows share one allowance of 4 extra checks per hour per site', async () => {
  const R = T0 + 3 * HOUR + 10 * MIN;
  // A pending tier with a published release at R, plus the sell-out at S: up to 7 extra slots in one hour.
  const withPending = html => edit(html, (doc, tier) => {
    const t = tier('Second Release');
    Object.assign(t.attributes, { 'on-sale-at': iso(R), 'on-sale-status': 'not_on_sale' });
  });
  const h = harness({ env: { DROPWATCH_RELEASE_WINDOW: 'on' }, respond: t => new Response(withPending(pageAt(t)), { status: 200, headers: { 'content-type': 'text/html' } }) });
  h.sch.addTarget({ source: 'fatsoma', target: URL_, interval_minutes: 60 });
  await h.runUntil(T0 + 5 * HOUR);
  const extras = h.s.db.request_log.filter(r => ['burst', 'release_window'].includes(r.kind));
  const sentExtra = extras.filter(r => r.requested).map(r => Date.parse(r.at));
  for (const t of sentExtra) assert.ok(sentExtra.filter(x => x > t - HOUR && x <= t).length <= 4, 'more than 4 extra checks in an hour');
  for (const c of h.calls) assert.ok(h.calls.filter(x => x.t > c.t - HOUR && x.t <= c.t).length <= 5, 'site total above 1 + 4');
  assert.ok(extras.some(r => r.outcome === 'skipped: per-site hourly budget reached'), 'surplus slots skipped, not added');
  assert.ok(extras.some(r => r.kind === 'burst' && r.requested) && extras.some(r => r.kind === 'release_window' && r.requested), 'both kinds used the shared allowance');
});

test('the shared allowance holds even with no ordinary check in the hour (email trigger plus a release window)', async () => {
  // Ordinary checks every 2 h, so none falls in the window. External trigger (4 slots) and a release 10 min later
  // (4 slots) would be 8 extra checks; only 4 may go in any hour.
  const X = T0 + 70 * MIN;
  const R = X + 10 * MIN;
  const page = edit(BEFORE, (doc, tier) => Object.assign(tier('Second Release').attributes, { 'on-sale-at': iso(R), 'on-sale-status': 'not_on_sale' }));
  const h = harness({ env: { DROPWATCH_RELEASE_WINDOW: 'on', DROPWATCH_INTERVAL_FATSOMA_MINUTES: '120' }, respond: () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }) });
  h.sch.addTarget({ source: 'fatsoma', target: URL_, interval_minutes: 120 });
  await h.runUntil(X - MIN);
  h.sch.addExternalTrigger({ url: URL_, via: 'email' });
  await h.runUntil(X + 60 * MIN);
  const extra = h.s.db.request_log.filter(r => ['burst', 'release_window'].includes(r.kind) && r.requested).map(r => Date.parse(r.at));
  assert.equal(h.calls.filter(c => c.t > X - 30 * MIN && c.t <= X + 60 * MIN && !extra.includes(c.t)).length, 0, 'no ordinary check in the window');
  for (const t of extra) assert.ok(extra.filter(x => x > t - HOUR && x <= t).length <= 4, `${extra.filter(x => x > t - HOUR && x <= t).length} extra checks in an hour`);
  assert.equal(extra.length, 4);
});

test('per-trigger limit and one active trigger per watch', async () => {
  const h = harness({ env: { DROPWATCH_BURST_MAX_CHECKS: '2' }, respond: () => new Response(BEFORE, { status: 200, headers: { 'content-type': 'text/html' } }) });
  h.sch.addTarget({ source: 'fatsoma', target: URL_, interval_minutes: 60 });
  await h.runUntil(T0 + 2 * MIN);
  const first = h.sch.addExternalTrigger({ url: URL_, via: 'email' });
  const second = h.sch.addExternalTrigger({ url: URL_, via: 'email' });   // a second email moments later
  assert.equal(first.armed.length, 1);
  assert.deepEqual(second.armed, []);
  assert.match(second.note, /already active/);
  await h.runUntil(T0 + 30 * MIN);
  const b = bursts(h.s.db).filter(r => r.trigger_id === first.id);
  assert.deepEqual(b.filter(r => r.requested).map(r => r.offset_minutes), [0, 2]);
  assert.ok(b.filter(r => r.outcome === 'skipped: per-trigger limit reached').length === 2);
});

test('no bursts while the site is erroring or paused', async () => {
  const h = harness({ respond: t => (t < T0 + 3 * HOUR + 30_000 ? new Response(pageAt(t), { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('down', { status: 503 })) });
  h.sch.addTarget({ source: 'fatsoma', target: URL_, interval_minutes: 60 });
  await h.runUntil(T0 + 3 * HOUR + 30 * MIN);
  const b = bursts(h.s.db);
  assert.ok(b.length > 0, 'the sell-out armed a burst');
  assert.equal(b.filter(r => r.requested && r.offset_minutes > 2).length, 0, 'nothing after the site started failing');
  assert.ok(b.some(r => r.outcome === 'skipped: site is backing off or paused'));
});

test('a fast-falling count arms a burst, at most once an hour per watch', async () => {
  // FINAL 20 loses 8 an hour: 20 → 12 → 4 (projected under 2 h to sell out at the 2h check).
  const h = harness({ respond: t => {
    const left = Math.max(1, 20 - 8 * Math.floor((t - T0) / HOUR));
    return new Response(edit(BEFORE, (doc, tier) => Object.assign(tier('FINAL 20').attributes, { 'amount-available': left })), { status: 200, headers: { 'content-type': 'text/html' } });
  } });
  h.sch.addTarget({ source: 'fatsoma', target: URL_, interval_minutes: 60 });
  await h.runUntil(T0 + 4 * HOUR);
  const falling = h.s.db.trigger_log.filter(e => e.type === 'falling_count');
  assert.ok(falling.length >= 1);
  for (let i = 1; i < falling.length; i++) assert.ok(Date.parse(falling[i].at) - Date.parse(falling[i - 1].at) >= HOUR);
  assert.match(falling[0].reason, /FINAL 20.*left/);
});

test('external trigger: an immediate verification check, then +2/+5/+15; unknown event or bursts off: logged only', async () => {
  const h = harness({ respond: () => new Response(BEFORE, { status: 200, headers: { 'content-type': 'text/html' } }) });
  h.sch.addTarget({ source: 'fatsoma', target: URL_, interval_minutes: 60 });
  await h.runUntil(T0 + 10 * MIN);                       // baseline check
  const t1 = h.s.clock.t;
  const e = h.sch.addExternalTrigger({ url: URL_, via: 'email', reason: 'email: tickets on sale', received_at: iso(t1 - 2 * MIN) });
  assert.deepEqual(e.armed, [h.s.db.targets[0].id]);
  await h.runUntil(t1 + 20 * MIN);
  const sent = bursts(h.s.db).filter(r => r.requested && r.trigger_id === e.id);
  assert.deepEqual(sent.map(r => r.offset_minutes), [0, 2, 5, 15]);
  assert.ok(minutesAfter(sent[0].at, t1) <= 1, 'verification check within a minute');
  assert.equal(h.s.sent.length, 0, 'a trigger never alerts by itself (nothing changed on the page)');

  const unknown = h.sch.addExternalTrigger({ url: 'https://www.fatsoma.com/e/zzzzzzzz/not-watched', via: 'email' });
  assert.deepEqual(unknown.armed, []);
  assert.match(unknown.note, /no enabled watch/);
  const off = harness({ env: { DROPWATCH_SIGNAL_BURSTS: 'off' } });
  off.sch.addTarget({ source: 'fatsoma', target: URL_ });
  assert.match(off.sch.addExternalTrigger({ url: URL_ }).note, /bursts are off/);
});

test('an external trigger matches the event by its Fatsoma id, whatever the slug or tracking parameters', async () => {
  const h = harness({ respond: () => new Response(BEFORE, { status: 200, headers: { 'content-type': 'text/html' } }) });
  const target = h.sch.addTarget({ source: 'fatsoma', target: URL_, interval_minutes: 60 });
  await h.runUntil(T0 + 2 * MIN);
  const e = h.sch.addExternalTrigger({ url: 'https://fatsoma.com/e/W12DE4K1/some-other-slug?utm_source=email', via: 'email' });
  assert.deepEqual(e.armed, [target.id]);
  assert.equal(e.event_id, 'fatsoma:2ede4cdd-5e52-4250-af87-f63d73183bc5');
});

test('an external trigger for an event listed on a watched organiser page arms the organiser watch', async () => {
  const h = harness({ organiser: fixture('fatsoma/organiser-riffraff-2026-10-13-v3-derived.html') });
  const org = h.sch.addTarget({ source: 'fatsoma', target: ORG_URL, interval_minutes: 60 });
  h.sch.addTarget({ source: 'fatsoma', target: URL_, interval_minutes: 60 });
  await h.runUntil(T0 + 5 * MIN);                        // organiser baseline lists Halloween
  const e = h.sch.addExternalTrigger({ url: URL_, via: 'email' });
  assert.deepEqual(e.armed, [org.id]);
});

const EML = [
  'From: =?UTF-8?Q?Fatsoma?= <noreply@example-mail.fatsoma.com>',
  'To: watcher@example.com',
  'Subject: =?UTF-8?B?8J+OgyBUaWNrZXRzIGFyZSBvbiBzYWxl?=',
  'Date: Tue, 13 Oct 2026 18:00:05 +0100',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'New tickets for PROJECT HALLOWEEN are on sale: https://www.fatsoma.com/e/w12de4k1/project-halloween-manch=',
  'ester-s-biggest-halloween-event-10-000-people =E2=9C=A8',
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('<a href="https://click.example-tracker.com/ls/click?upn=abc">Buy</a> <a href="https://fatsoma.com/e/w12de4k1/x?utm_source=email&amp;utm_medium=x">page</a>').toString('base64'),
  '--b1--',
  '',
].join('\r\n');

test('email reader: decodes the message and finds direct event links; tracking links are reported, not followed', () => {
  const email = parseEmail(EML);
  assert.equal(email.subject, '🎃 Tickets are on sale');
  assert.equal(email.date, '2026-10-13T17:00:05.000Z');
  assert.deepEqual(email.parts, ['text/plain', 'text/html']);
  const links = fatsomaEventLinks(email);
  assert.deepEqual(links.events.map(e => e.vanity), ['w12de4k1']);
  assert.match(links.events[0].url, /^https:\/\/www\.fatsoma\.com\/e\/w12de4k1\//);
  assert.deepEqual(links.unresolved_link_hosts, ['click.example-tracker.com']);
});

test('api: POST /api/triggers with a raw email arms a check on the watched event', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dropwatch-triggers-'));
  const app = createMonitorApp({ config: loadConfig({ DROPWATCH_LIVE_FATSOMA: 'on', DROPWATCH_SIGNAL_BURSTS: 'on' }, { dataDir }) });
  const base = await app.start(0);
  try {
    await app.engine.ingest({ source: 'fatsoma', target: URL_, status: 200, observed_at: new Date().toISOString(), origin: 'fixture', body: BEFORE });
    app.scheduler.addTarget({ source: 'fatsoma', target: URL_ });
    const res = await fetch(base + '/api/triggers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'fatsoma', email: EML }) });
    const data = await res.json();
    assert.equal(res.status, 201);
    assert.equal(data.triggers.length, 1);
    assert.equal(data.triggers[0].via, 'email');
    assert.equal(data.triggers[0].received_at, '2026-10-13T17:00:05.000Z');
    assert.equal(data.triggers[0].armed.length, 1);
    const log = await (await fetch(base + '/api/triggers')).json();
    assert.equal(log.length, 1);
  } finally {
    await app.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
