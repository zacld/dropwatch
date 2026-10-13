import { connectorById } from './connectors/index.js';
import { retrieveLive } from './retrieve.js';
import { nextAllowedAttempt } from './health.js';
import { MIN_INTERVAL_MINUTES } from './config.js';

// Conservative polling of configured targets. Off unless DROPWATCH_SCHEDULER=on, and then only for sources
// whose live retrieval is switched on. At most one request per tick, never faster than the source interval
// (with a hard floor), doubled after each failure, and paused after a block, challenge or rate limit.
//
// Release windows (DROPWATCH_RELEASE_WINDOW=on): for a watched event whose stored data has a release time
// (tier release_at, published on-sale or presale time), a few extra checks are made around it (default 2 min
// before, then 1, 5 and 15 min after). They are limited per release and per site per rolling hour, never run
// while the site is backing off or paused, and a slot missed by more than the tolerance (e.g. the PC slept)
// is logged as missed rather than fired late. Every request, normal or extra, is logged in db.request_log.

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = ms => new Date(ms).toISOString();

export function createScheduler({ store, engine, config, now = () => Date.now(), log, fetchImpl }) {
  const db = store.data;
  db.request_log ??= [];
  const rw = config.releaseWindow ?? { enabled: false, offsetsMinutes: [], maxChecksPerRelease: 0, maxExtraPerSitePerHour: 0, slotToleranceMinutes: 3 };
  const minGap = (config.minRequestGapSeconds ?? 60) * 1000;
  let timer = null;
  let inFlight = false;

  function addTarget({ source, target, interval_minutes }) {
    const c = connectorById(source);
    if (!c) throw new Error(`unknown source ${source}`);
    const floor = MIN_INTERVAL_MINUTES[c.access.method] ?? 60;
    if (!Number.isFinite(floor)) throw new Error(`${c.name} has no permitted live access method`);
    const t = { id: store.nextId('tgt'), source, target: String(target), interval_minutes: Math.max(floor, Number(interval_minutes) || config.sources[source].intervalMinutes), enabled: true, last_run_at: null, last_result: null };
    db.targets.push(t);
    store.save();
    return t;
  }

  // ---- request accounting (requests actually sent; refusals and missed slots are not requests) ----
  const sent = source => db.request_log.filter(r => r.source === source && r.requested);
  const inLastHour = (source, t, kind) => sent(source).filter(r => Date.parse(r.at) > t - HOUR && (!kind || r.kind === kind)).length;
  const lastRequestAt = source => { const s = sent(source); return s.length ? Date.parse(s[s.length - 1].at) : 0; };
  const siteCap = () => 1 + (rw.enabled ? rw.maxExtraPerSitePerHour : 0);
  const gapOk = (source, t) => t - lastRequestAt(source) >= minGap;
  const record = entry => { db.request_log.push(entry); log?.info('request', entry); };

  // ---- release times known for a target's event ----
  function eventFor(target) {
    return Object.values(db.events).find(e => e.source === target.source && (e.source_metadata?.target === target.target || samePage(e.canonical_url, target.target))) ?? null;
  }
  function releaseTimes(ev) {
    const times = new Set();
    for (const k of ['published_on_sale_at', 'published_presale_at']) if (ev[k]) times.add(ev[k]);
    for (const tier of Object.values(db.tiers)) if (tier.event_id === ev.id && tier.listed !== false && !tier.addon && tier.release_at) times.add(tier.release_at);
    return [...times];
  }

  // The earliest release slot that is due now for this target, or null. Marks slots that were missed.
  function dueSlot(target, t) {
    const ev = eventFor(target);
    if (!ev) return null;
    target.release_checks ??= {};
    for (const k of Object.keys(target.release_checks)) if (Date.parse(k.split('|')[0]) < t - 2 * 24 * HOUR) delete target.release_checks[k];
    const known = Date.parse(ev.first_seen_at ?? iso(t));
    let best = null;
    for (const R of releaseTimes(ev)) {
      const r = Date.parse(R);
      if (r < t - 24 * HOUR || r > t + 24 * HOUR) continue;
      const done = Object.entries(target.release_checks).filter(([k, v]) => k.startsWith(`${R}|`) && v.requested).length;
      for (const off of rw.offsetsMinutes) {
        const at = r + off * MIN;
        const key = `${R}|${off}`;
        if (target.release_checks[key] || t < at) continue;
        if (at < known) continue; // the release was already past when we first saw the event
        if (t - at > rw.slotToleranceMinutes * MIN) {
          target.release_checks[key] = { outcome: 'missed', at: iso(t) };
          record({ at: iso(t), source: target.source, target_id: target.id, kind: 'release_window', release_at: R, offset_minutes: off, requested: false, outcome: `missed: slot was due ${Math.round((t - at) / MIN)} min earlier` });
          continue;
        }
        if (done >= rw.maxChecksPerRelease) {
          target.release_checks[key] = { outcome: 'skipped', at: iso(t) };
          record({ at: iso(t), source: target.source, target_id: target.id, kind: 'release_window', release_at: R, offset_minutes: off, requested: false, outcome: 'skipped: per-release limit reached' });
          continue;
        }
        if (!best || at < best.at) best = { R, off, at, key };
      }
    }
    return best;
  }

  async function request(target, c, meta) {
    const t0 = now();
    const started = performance.now();
    if (meta.kind === 'scheduled') target.last_run_at = iso(t0);
    const obs = await retrieveLive(c, target.target, config, { fetchImpl, now, log });
    const entry = {
      at: iso(t0), source: target.source, target_id: target.id, kind: meta.kind,
      release_at: meta.R ?? null, offset_minutes: meta.off ?? null,
      minutes_after_release: meta.R ? Math.round((t0 - Date.parse(meta.R)) / 6000) / 10 : null,
      requested: !obs.refused,
    };
    if (obs.refused) {
      entry.outcome = `refused: ${obs.refused}`;
      target.last_result = entry.outcome;
      if (meta.key) target.release_checks[meta.key] = { outcome: entry.outcome, at: entry.at, requested: false };
      record(entry);
      store.save();
      return { ran: target.id, kind: meta.kind, refused: obs.refused };
    }
    const r = await engine.ingest(obs);
    Object.assign(entry, {
      http_status: obs.status ?? null,
      outcome: `${r.observation.classification}/${r.observation.status}`,
      duration_ms: Math.round(performance.now() - started),
      changes: r.changes.map(x => x.kind),
      alerts: r.notifications.length,
    });
    target.last_result = entry.outcome;
    if (meta.key) target.release_checks[meta.key] = { outcome: entry.outcome, at: entry.at, requested: true };
    record(entry);
    store.save();
    return { ran: target.id, kind: meta.kind, observation: r.observation, changes: r.changes, notifications: r.notifications };
  }

  // Returns what it did, for tests and the status endpoint.
  async function tick() {
    if (!config.scheduler.enabled) return { ran: null, reason: 'scheduler off' };
    if (inFlight) return { ran: null, reason: 'previous check still running' };
    inFlight = true;
    try { return await runOne(); } finally { inFlight = false; }
  }

  async function runOne() {
    const t = now();
    const live = db.targets.filter(x => x.enabled).map(target => ({ target, c: connectorById(target.source), src: config.sources[target.source] }))
      .filter(x => x.c && x.src?.enabled && x.src.live);

    // 1. Release-window checks: only for events with a known release time; never while backing off.
    if (rw.enabled) {
      let wait = null;
      for (const { target, c } of live) {
        const slot = dueSlot(target, t);
        if (!slot) continue;
        const h = db.sources[target.source];
        const skip = reason => {
          target.release_checks[slot.key] = { outcome: 'skipped', at: iso(t) };
          record({ at: iso(t), source: target.source, target_id: target.id, kind: 'release_window', release_at: slot.R, offset_minutes: slot.off, requested: false, outcome: `skipped: ${reason}` });
        };
        if ((h?.paused_until && Date.parse(h.paused_until) > t) || (h?.backoff_level ?? 0) > 0) { skip('site is backing off or paused'); continue; }
        if (inLastHour(target.source, t, 'release_window') >= rw.maxExtraPerSitePerHour || inLastHour(target.source, t) >= siteCap()) { skip('per-site hourly budget reached'); continue; }
        if (!gapOk(target.source, t)) { wait = 'minimum gap between requests'; continue; } // retried next tick, within tolerance
        return request(target, c, { kind: 'release_window', ...slot });
      }
      if (wait) return { ran: null, reason: wait };
    }

    // 2. Normal monitoring: unchanged rules, plus the hard site budget and minimum gap.
    for (const { target, c, src } of live) {
      const h = db.sources[target.source];
      const due = (target.last_run_at ? Date.parse(target.last_run_at) : 0) + target.interval_minutes * MIN;
      if (t < due || t < nextAllowedAttempt(h, src.intervalMinutes)) continue;
      if (inLastHour(target.source, t) >= siteCap() || !gapOk(target.source, t)) continue;
      return request(target, c, { kind: 'scheduled' });
    }
    return { ran: null, reason: 'nothing due' };
  }

  return {
    addTarget,
    tick,
    start() {
      if (!config.scheduler.enabled || timer) return;
      timer = setInterval(() => tick().catch(e => log?.error('scheduler', { error: e.message })), config.scheduler.tickSeconds * 1000);
      timer.unref();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

// Summary of release-window activity from the request log: per release, each slot's outcome and how soon
// after the release the first change was detected.
export function releaseReport(requestLog) {
  const windows = new Map();
  for (const r of requestLog.filter(x => x.kind === 'release_window')) {
    const k = `${r.target_id}|${r.release_at}`;
    if (!windows.has(k)) windows.set(k, { target_id: r.target_id, source: r.source, release_at: r.release_at, slots: [], first_change_minutes_after_release: null });
    const w = windows.get(k);
    w.slots.push({ offset_minutes: r.offset_minutes, at: r.at, requested: r.requested, outcome: r.outcome, changes: r.changes ?? [], alerts: r.alerts ?? 0 });
    if (r.requested && r.changes?.length && w.first_change_minutes_after_release === null) w.first_change_minutes_after_release = r.minutes_after_release;
  }
  return [...windows.values()];
}

function samePage(a, b) {
  try {
    const p = u => new URL(u).host + new URL(u).pathname.replace(/\/+$/, '').toLowerCase();
    return p(a) === p(b);
  } catch { return false; }
}
