// Phase 2: signals choose which due watch gets a site's next check; they never alert or add requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, T0, HOUR, iso } from './monitor-helpers.js';
import { createScheduler } from '../monitor/scheduler.js';
import { eventSignals, signalConfig } from '../monitor/signals.js';
import { detectionReport } from '../monitor/reports.js';
import { releaseWindowConfig } from '../monitor/config.js';
import { defaultPreferences } from '../monitor/preferences.js';

const MIN = 60_000;
const cfg = signalConfig({ DROPWATCH_SIGNAL_PRIORITY: 'on' });
const at = ms => iso(T0 + ms);
const tier = (over = {}) => ({ name: 'Tier', status: 'on_sale', addon: false, listed: true, history: [], ...over });
const types = s => s.map(x => x.type).sort();

test('signals: falling count, sold-out follow-up, release soon, event soon, quiet; a flat low count is not urgent', () => {
  const now = T0 + 10 * HOUR;
  const ev = { first_seen_at: at(0), start_at: at(30 * 24 * HOUR) };
  // 100 → 40 in 6 h: 10/h, ~4 h left.
  const falling = tier({ name: 'Second', history: [{ at: at(4 * HOUR), status: 'on_sale', qty: 100 }, { at: at(10 * HOUR), status: 'on_sale', qty: 40 }] });
  assert.deepEqual(types(eventSignals(ev, [falling], now, cfg)), ['falling_count']);

  const flatLow = tier({ name: 'FINAL 20', history: [{ at: at(0), status: 'on_sale', qty: 20 }] });
  assert.deepEqual(eventSignals(ev, [flatLow], now, cfg), [], 'unchanged low count: no signal (and not quiet yet)');
  assert.deepEqual(types(eventSignals({ ...ev, first_seen_at: at(-5 * 24 * HOUR) }, [{ ...flatLow, history: [{ at: at(-5 * 24 * HOUR), status: 'on_sale', qty: 20 }] }], now, cfg)), ['quiet']);

  const soldOut = tier({ name: 'First', status: 'sold_out', history: [{ at: at(8 * HOUR), status: 'on_sale', qty: 3 }, { at: at(9.5 * HOUR), status: 'sold_out', qty: 0 }] });
  const s1 = eventSignals(ev, [soldOut], now, cfg);
  assert.deepEqual([s1[0].type, s1[0].strength], ['sold_out_followup', 3]);
  const s2 = eventSignals(ev, [soldOut, tier({ name: 'Next' })], now, cfg);
  assert.equal(s2[0].type, 'sold_out_followup_other_on_sale');

  const pending = tier({ name: 'Third', status: 'not_yet_released', release_at: at(11 * HOUR) });
  assert.deepEqual(types(eventSignals(ev, [pending], now, cfg)), ['release_soon']);
  assert.deepEqual(types(eventSignals({ ...ev, start_at: at(34 * HOUR) }, [], now, cfg)), ['event_soon']);
  assert.deepEqual(eventSignals(ev, [tier({ name: 'Add-on', addon: true, status: 'sold_out', history: soldOut.history })], now, cfg), [], 'add-ons never signal');
});

test('tier history keeps a point per change; each change records the window it appeared in', async () => {
  const s = setup({ users: [defaultPreferences('everyone')] });
  await s.observe('fatsoma', 'fatsoma/real-2026-10-13.html');
  s.clock.t += HOUR;
  await s.observe('fatsoma', 'fatsoma/real-2026-10-13.html');           // unchanged: no new point
  s.clock.t += HOUR;
  const r = await s.observe('fatsoma', 'fatsoma/real-2026-10-13-v2-derived.html');
  const final = Object.values(s.db.tiers).find(t => t.name.startsWith('⚠️ FINAL 20'));
  assert.deepEqual(final.history.map(p => [p.status, p.qty]), [['on_sale', 20], ['sold_out', 0]]);
  const sold = r.changes.find(c => c.kind === 'tier_status_changed' && !c.addon);
  assert.deepEqual([sold.appeared_after, sold.observed_at], [iso(T0 + HOUR), iso(T0 + 2 * HOUR)], 'between the previous valid check and this one');
});

// ---- scheduler priority ----
const HOT = 'https://www.fatsoma.com/e/w12de4k1/project-halloween-manchester-s-biggest-halloween-event-10-000-people';
const QUIET = 'https://www.fatsoma.com/e/q0000000/quiet-night';
function withFinalTier(html, attrs) {
  return html.replace(/(<script type="fastboot\/shoebox" id="[^"]*events[a-z0-9]{8}[^"]*">)(.*?)(<\/script>)/s, (_, a, body, c) => {
    const doc = JSON.parse(JSON.parse(body));
    Object.assign(doc.included.find(x => x.type === 'ticket-options' && x.attributes.name.includes('FINAL 20')).attributes, attrs);
    return a + JSON.stringify(JSON.stringify(doc)) + c;
  });
}
const REAL = fixture('fatsoma/real-2026-10-13.html');
const QUIET_PAGE = REAL.replaceAll('w12de4k1', 'q0000000').replaceAll('project-halloween-manchester-s-biggest-halloween-event-10-000-people', 'quiet-night').replaceAll('2ede4cdd-5e52-4250-af87-f63d73183bc5', '2ede4cdd-0000-0000-0000-000000000001');

function harness(env) {
  const s = setup({ users: [defaultPreferences('everyone')], env: { DROPWATCH_SCHEDULER: 'on', DROPWATCH_LIVE_FATSOMA: 'on', DROPWATCH_INTERVAL_FATSOMA_MINUTES: '60', ...env } });
  const calls = [];
  // The hot event sells 4 tickets an hour from its FINAL tier; the quiet event never changes.
  const fetchImpl = async url => {
    calls.push({ t: s.clock.t, which: url.includes('q0000000') ? 'quiet' : 'hot' });
    const left = Math.max(0, 20 - 4 * Math.floor((s.clock.t - T0) / HOUR));
    const body = url.includes('q0000000') ? QUIET_PAGE : withFinalTier(REAL, { 'amount-available': left, 'on-sale-status': left ? 'available' : 'sold_out' });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html', 'x-cache-status': 'MISS' } });
  };
  const sch = createScheduler({ store: s.store, engine: s.engine, config: s.config, now: () => s.clock.t, fetchImpl });
  sch.addTarget({ source: 'fatsoma', target: HOT, interval_minutes: 60 });
  sch.addTarget({ source: 'fatsoma', target: QUIET, interval_minutes: 60 });
  const runUntil = async end => { while (s.clock.t <= end) { await sch.tick(); s.clock.t += MIN; } };
  return { s, sch, calls, runUntil };
}
const gaps = (calls, which) => { const t = calls.filter(c => c.which === which).map(c => c.t); return t.slice(1).map((x, i) => x - t[i]); };

test('priority off: watches simply alternate', async () => {
  const h = harness({});
  await h.runUntil(T0 + 8 * HOUR);
  assert.deepEqual(h.calls.map(c => c.which).slice(0, 6), ['hot', 'quiet', 'hot', 'quiet', 'hot', 'quiet']);
});

test('priority on: a falling count wins the slot; the quiet watch is still checked within the overdue cap; budget unchanged', async () => {
  const h = harness({ DROPWATCH_SIGNAL_PRIORITY: 'on' });
  await h.runUntil(T0 + 12 * HOUR);
  const hot = h.calls.filter(c => c.which === 'hot').length;
  const quiet = h.calls.filter(c => c.which === 'quiet').length;
  assert.ok(hot > quiet, `hot ${hot} vs quiet ${quiet}`);
  assert.ok(gaps(h.calls, 'quiet').every(g => g <= 3 * HOUR + 2 * MIN), 'never starved beyond 3 intervals');
  for (const c of h.calls) assert.ok(h.calls.filter(x => x.t > c.t - HOUR && x.t <= c.t).length <= 1, 'still one request per hour per site');
  const reasons = h.s.db.request_log.filter(r => r.requested).map(r => r.reason);
  assert.ok(reasons.some(r => /^falling_count: "⚠️ FINAL 20 TICKETS ⚠️" \d+ → \d+ left/.test(r)), reasons.join(' | '));
  assert.ok(reasons.some(r => /^overdue: not checked for/.test(r)));
  // Signals never alert: every alert traces back to a real recorded change.
  const changeIds = new Set(h.s.db.changes.map(c => c.id));
  assert.ok(h.s.db.notifications.every(n => n.change_ids.every(id => changeIds.has(id))));
});

test('detection report: window, the check that found the change and why, and the alert', async () => {
  const h = harness({ DROPWATCH_SIGNAL_PRIORITY: 'on' });
  await h.runUntil(T0 + 8 * HOUR);
  const rows = detectionReport(h.s.db);
  const sold = rows.find(r => r.kind === 'tier_status_changed' && r.current === 'sold_out');
  assert.ok(sold, 'the hot tier sold out during the run');
  assert.ok(sold.window_minutes > 0 && sold.window_minutes <= 120);
  assert.equal(sold.found_by.kind, 'scheduled');
  assert.match(sold.found_by.reason, /falling_count|overdue|rotation/);
  assert.equal(sold.found_by.cache_status, 'MISS');
  assert.equal(sold.alert_delay_seconds, 0);
});

test('release offsets: Fatsoma defaults to +2 (cache); a general setting overrides it; a site setting overrides both', () => {
  assert.deepEqual(releaseWindowConfig({}).offsetsBySource.fatsoma, [-2, 2, 5, 15]);
  assert.deepEqual(releaseWindowConfig({}).offsetsMinutes, [-2, 1, 5, 15]);
  assert.deepEqual(releaseWindowConfig({ DROPWATCH_RELEASE_OFFSETS_MINUTES: '-1,3' }).offsetsBySource.fatsoma, [-1, 3]);
  assert.deepEqual(releaseWindowConfig({ DROPWATCH_RELEASE_OFFSETS_MINUTES: '-1,3', DROPWATCH_RELEASE_OFFSETS_FATSOMA_MINUTES: '4' }).offsetsBySource.fatsoma, [4]);
  assert.equal(signalConfig({}).enabled, false, 'signal priority is off unless switched on');
});
