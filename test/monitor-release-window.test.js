// Release-window scheduling, simulated end to end: the real Fatsoma page with one tier's release time and
// status edited, a fake fetch that serves the pre- or post-release page by the simulated clock, and the
// scheduler ticked once a minute (as it is live). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, T0, HOUR, iso } from './monitor-helpers.js';
import { createScheduler, releaseReport } from '../monitor/scheduler.js';
import { defaultPreferences } from '../monitor/preferences.js';
import { releaseWindowConfig } from '../monitor/config.js';

const MIN = 60_000;
const URL_ = 'https://www.fatsoma.com/e/w12de4k1/project-halloween-manchester-s-biggest-halloween-event-10-000-people';
const R = T0 + 5 * HOUR; // simulated release: 14:00 UTC
const BASE = fixture('fatsoma/real-2026-10-13.html');

// Edit the FINAL 20 tier inside the page's (double-encoded) shoebox state.
function page({ releaseAt, status }) {
  const re = /(<script type="fastboot\/shoebox" id="[^"]*eventsw12de4k1[^"]*">)(.*?)(<\/script>)/s;
  const m = BASE.match(re);
  const doc = JSON.parse(JSON.parse(m[2]));
  const tier = doc.included.find(x => x.type === 'ticket-options' && x.attributes.name.includes('FINAL 20'));
  Object.assign(tier.attributes, { 'on-sale-at': iso(releaseAt), 'on-sale-status': status });
  return BASE.replace(re, (_, a, __, c) => a + JSON.stringify(JSON.stringify(doc)) + c);
}
const PRE = page({ releaseAt: R, status: 'not_on_sale' });
const POST = page({ releaseAt: R, status: 'available' });

function harness({ env = {}, respond } = {}) {
  // Same settings as the live watch (.env): Fatsoma live, site interval 60 min.
  const s = setup({ users: [defaultPreferences('everyone')], env: { DROPWATCH_SCHEDULER: 'on', DROPWATCH_LIVE_FATSOMA: 'on', DROPWATCH_INTERVAL_FATSOMA_MINUTES: '60', DROPWATCH_RELEASE_WINDOW: 'on', ...env } });
  const calls = [];
  const fetchImpl = async url => {
    calls.push(s.clock.t);
    if (respond) return respond(s.clock.t);
    return new Response(s.clock.t < R + 30_000 ? PRE : POST, { status: 200, headers: { 'content-type': 'text/html', date: new Date(s.clock.t).toUTCString() } });
  };
  const sch = createScheduler({ store: s.store, engine: s.engine, config: s.config, now: () => s.clock.t, fetchImpl });
  sch.addTarget({ source: 'fatsoma', target: URL_, interval_minutes: 60 });
  const runUntil = async end => { while (s.clock.t <= end) { await sch.tick(); s.clock.t += MIN; } };
  return { s, sch, calls, runUntil, log: () => s.db.request_log };
}
const rel = log => log.filter(r => r.kind === 'release_window');
const minutesFromR = t => Math.round((t - R) / MIN);

test('release window (Fatsoma offsets): checks at -2, +2, +5 and +15 min; the release is detected at +2 and alerted once', async () => {
  const h = harness();
  await h.runUntil(R + 2 * HOUR);

  const extra = rel(h.log()).filter(r => r.requested);
  assert.deepEqual(extra.map(r => r.offset_minutes), [-2, 2, 5, 15], 'Fatsoma: +2, past its ~2-min cache');
  assert.deepEqual(extra.map(r => minutesFromR(Date.parse(r.at))), [-2, 2, 5, 15], 'each check lands on its slot (1-minute ticks)');

  const [before, after1, after5, after15] = extra;
  assert.deepEqual(before.changes, [], 'the pre-release check refreshes the baseline');
  assert.ok(after1.changes.includes('tier_status_changed'), 'the release is caught at +2 min');
  assert.equal(after1.alerts, 1);
  assert.deepEqual([after5.alerts, after15.alerts], [0, 0], 'later checks do not repeat the alert');

  const report = releaseReport(h.log());
  assert.equal(report.length, 1);
  assert.equal(report[0].first_change_minutes_after_release, 2);
  assert.equal(h.s.sent.filter(n => n.kinds.includes('tier_status_changed')).length, 1);
});

test('the site budget holds in every rolling hour, normal checks stay hourly, and no request is closer than the gap', async () => {
  const h = harness();
  await h.runUntil(R + 3 * HOUR);
  for (const t of h.calls) {
    const inHour = h.calls.filter(x => x > t - HOUR && x <= t).length;
    assert.ok(inHour <= 5, `${inHour} requests in the hour up to ${iso(t)}`);
  }
  for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i] - h.calls[i - 1] >= 60_000, 'requests closer than the minimum gap');
  const normal = h.log().filter(r => r.kind === 'scheduled' && r.requested);
  for (let i = 1; i < normal.length; i++) assert.ok(Date.parse(normal[i].at) - Date.parse(normal[i - 1].at) >= HOUR, 'normal checks faster than hourly');
  // Outside the release window there is one request an hour, as before.
  assert.equal(h.calls.filter(t => t < R - 10 * MIN).length, 5, 'T0..T0+4h: hourly only');
});

test('allowance off: only normal hourly checks around the same release', async () => {
  const h = harness({ env: { DROPWATCH_RELEASE_WINDOW: 'off' } });
  await h.runUntil(R + 2 * HOUR);
  assert.equal(rel(h.log()).length, 0);
  assert.ok(h.calls.filter(t => t > R - HOUR && t <= R + HOUR).length <= 2);
});

test('no extra checks while the site is erroring or paused', async () => {
  const h = harness({ respond: t => (t < T0 + 3 * HOUR ? new Response(PRE, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('down', { status: 503 })) });
  await h.runUntil(R + 30 * MIN);
  const extra = rel(h.log());
  assert.equal(extra.filter(r => r.requested).length, 0, 'no release-window request while backing off');
  assert.ok(extra.some(r => r.outcome === 'skipped: site is backing off or paused'));
});

test('a hard per-site hourly budget caps the extras even when more slots are configured', async () => {
  const h = harness({ env: { DROPWATCH_RELEASE_OFFSETS_MINUTES: '-3,-2,1,2,3,4,5,6', DROPWATCH_RELEASE_MAX_CHECKS: '8', DROPWATCH_RELEASE_MAX_EXTRA_PER_HOUR: '3' } });
  await h.runUntil(R + 30 * MIN);
  const extra = rel(h.log());
  assert.equal(extra.filter(r => r.requested).length, 3);
  assert.ok(extra.filter(r => r.outcome === 'skipped: per-site hourly budget reached').length >= 1);
});

test('the minimum gap between requests delays a release check (within its tolerance) instead of being broken', async () => {
  const h = harness({ env: { DROPWATCH_MIN_REQUEST_GAP_SECONDS: '300' } });
  await h.runUntil(R + 30 * MIN);
  for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i] - h.calls[i - 1] >= 5 * MIN, `requests ${(h.calls[i] - h.calls[i - 1]) / MIN} min apart`);
  const extra = rel(h.log());
  // -2 runs at R-2; +2 waits for the 5-min gap until R+3 (1 min after its slot, within tolerance); +5 then waits
  // until R+8 (its slot + 3: still inside tolerance).
  assert.deepEqual(extra.filter(r => r.requested).map(r => [r.offset_minutes, minutesFromR(Date.parse(r.at))]), [[-2, -2], [2, 3], [5, 8], [15, 15]]);
});

test('slots missed while the PC slept are logged as missed, never fired late', async () => {
  const h = harness();
  await h.sch.tick();                    // baseline at T0: the release time becomes known
  h.s.clock.t = R + 10 * MIN;            // asleep from 09:00 to 14:10
  await h.runUntil(R + 20 * MIN);
  const extra = rel(h.log());
  assert.deepEqual(extra.filter(r => r.outcome.startsWith('missed')).map(r => r.offset_minutes), [-2, 2, 5]);
  assert.deepEqual(extra.filter(r => r.requested).map(r => r.offset_minutes), [15]);
});

test('overlapping ticks never run two checks at once', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const h = harness({ respond: async () => { await gate; return new Response(PRE, { status: 200, headers: { 'content-type': 'text/html' } }); } });
  const first = h.sch.tick();
  const second = await h.sch.tick();
  assert.equal(second.reason, 'previous check still running');
  release();
  await first;
  assert.equal(h.calls.length, 1);
});

test('release-window settings are clamped to hard ceilings', () => {
  const c = releaseWindowConfig({ DROPWATCH_RELEASE_WINDOW: 'on', DROPWATCH_RELEASE_MAX_CHECKS: '50', DROPWATCH_RELEASE_MAX_EXTRA_PER_HOUR: '99', DROPWATCH_RELEASE_OFFSETS_MINUTES: '-500,1,1,2,3,4,5,6,7,8,9,10', DROPWATCH_RELEASE_SLOT_TOLERANCE_MINUTES: '0' });
  assert.equal(c.maxChecksPerRelease, 8);
  assert.equal(c.maxExtraPerSitePerHour, 8);
  assert.deepEqual(c.offsetsMinutes, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(c.slotToleranceMinutes, 1);
  assert.equal(releaseWindowConfig({}).enabled, false, 'off unless switched on');
});
