import { connectorById } from './connectors/index.js';
import { retrieveLive } from './retrieve.js';
import { nextAllowedAttempt } from './health.js';
import { MIN_INTERVAL_MINUTES } from './config.js';
import { watchPriority, eventSignals } from './signals.js';

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
  db.trigger_log ??= [];
  const rw = config.releaseWindow ?? { enabled: false, offsetsMinutes: [], maxChecksPerRelease: 0, maxExtraPerSitePerHour: 0, slotToleranceMinutes: 3 };
  const bc = config.bursts ?? { enabled: false, offsetsMinutes: [], externalOffsetsMinutes: [], maxChecksPerTrigger: 0, fallingTriggerHours: 0 };
  const EXTRA = new Set(['release_window', 'burst']); // extra checks: they share one per-site hourly allowance
  const minGap = (config.minRequestGapSeconds ?? 60) * 1000;
  let timer = null;
  let inFlight = false;

  function addTarget({ source, target, interval_minutes }) {
    const c = connectorById(source);
    if (!c) throw new Error(`unknown source ${source}`);
    const floor = MIN_INTERVAL_MINUTES[c.access.method] ?? 60;
    if (!Number.isFinite(floor)) throw new Error(`${c.name} has no permitted live access method`);
    const kind = c.targetKind ? c.targetKind(String(target)) : 'event';
    const t = { id: store.nextId('tgt'), source, target: String(target), kind, interval_minutes: Math.max(floor, Number(interval_minutes) || config.sources[source].intervalMinutes), enabled: true, last_run_at: null, last_result: null };
    db.targets.push(t);
    store.save();
    return t;
  }

  // ---- request accounting (requests actually sent; refusals and missed slots are not requests) ----
  const sent = source => db.request_log.filter(r => r.source === source && r.requested);
  const inLastHour = (source, t, kinds) => sent(source).filter(r => Date.parse(r.at) > t - HOUR && (!kinds || kinds.has(r.kind))).length;
  const lastRequestAt = source => { const s = sent(source); return s.length ? Date.parse(s[s.length - 1].at) : 0; };
  const siteCap = () => 1 + (rw.enabled || bc.enabled ? rw.maxExtraPerSitePerHour : 0);
  const gapOk = (source, t) => t - lastRequestAt(source) >= minGap;
  const record = entry => { db.request_log.push(entry); log?.info('request', entry); };

  // ---- the events a target shows ----
  function eventFor(target) {
    return Object.values(db.events).find(e => e.source === target.source && (samePage(e.canonical_url, target.target) || e.source_metadata?.target === target.target)) ?? null;
  }
  // An organiser (listing) target shows the events its last check listed; an event target shows its event.
  function eventsFor(target) {
    if (target.kind === 'organiser') return (target.covers ?? []).map(id => db.events[id]).filter(Boolean);
    const ev = eventFor(target);
    return ev ? [ev] : [];
  }
  // An event-page target is redundant while an enabled organiser target's latest check listed its event.
  // It resumes on its own if the event drops out of the listing.
  function coveredBy(target) {
    if (target.kind === 'organiser') return null;
    const ev = eventFor(target);
    if (!ev) return null;
    return db.targets.find(o => o.enabled && o.kind === 'organiser' && o.source === target.source && (o.covers ?? []).includes(ev.id)) ?? null;
  }
  function releaseTimes(ev) {
    const times = new Set();
    for (const k of ['published_on_sale_at', 'published_presale_at']) if (ev[k]) times.add(ev[k]);
    for (const tier of Object.values(db.tiers)) if (tier.event_id === ev.id && tier.listed !== false && !tier.addon && tier.release_at) times.add(tier.release_at);
    return [...times];
  }

  // The earliest release slot that is due now for this target, or null. Marks slots that were missed.
  function dueSlot(target, t) {
    const events = eventsFor(target);
    if (!events.length) return null;
    target.release_checks ??= {};
    for (const k of Object.keys(target.release_checks)) if (Date.parse(k.split('|')[0]) < t - 2 * 24 * HOUR) delete target.release_checks[k];
    // Each release time, with when its event was first seen (a release already past then is not a missed slot).
    const known = new Map();
    for (const ev of events) for (const R of releaseTimes(ev)) known.set(R, Math.min(known.get(R) ?? Infinity, Date.parse(ev.first_seen_at ?? iso(t))));
    let best = null;
    for (const [R, firstSeen] of known) {
      const r = Date.parse(R);
      if (r < t - 24 * HOUR || r > t + 24 * HOUR) continue;
      const done = Object.entries(target.release_checks).filter(([k, v]) => k.startsWith(`${R}|`) && v.requested).length;
      for (const off of rw.offsetsBySource?.[target.source] ?? rw.offsetsMinutes) {
        const at = r + off * MIN;
        const key = `${R}|${off}`;
        if (target.release_checks[key] || t < at) continue;
        if (at < firstSeen) continue; // the release was already past when we first saw the event
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

  // ---- burst triggers ----
  // A trigger arms a few extra checks of one watch at fixed offsets after it. One active trigger per type per
  // watch: a repeat while its slots are pending is ignored. Every trigger is logged in db.trigger_log.
  function addTrigger(target, { type, reason, offsets, at, via = 'internal', event_id = null, received_at = null, log_id = null }) {
    target.triggers ??= [];
    const active = target.triggers.find(g => g.type === type && g.offsets.some(o => !g.done?.[o]));
    if (active) return null;
    const g = { id: log_id ?? store.nextId('trg'), type, reason, at: iso(at), offsets: [...offsets], done: {} };
    target.triggers.push(g);
    if (!log_id) db.trigger_log.push({ id: g.id, at: g.at, type, via, reason, target_id: target.id, event_id, received_at, armed: [target.id] });
    return g;
  }

  // Internal triggers from what a check just found: a main tier sold out, or a count projected to run out soon.
  function internalTriggers(target, result, t) {
    if (!bc.enabled || !result?.changes) return;
    const sold = result.changes.find(c => c.kind === 'tier_status_changed' && c.current === 'sold_out' && !c.addon);
    if (sold) addTrigger(target, { type: 'sold_out', reason: `"${sold.tier}" sold out`, offsets: bc.offsetsMinutes, at: t, event_id: sold.event_id });
    const tiersOf = id => Object.values(db.tiers).filter(x => x.event_id === id);
    for (const ev of eventsFor(target)) {
      const f = eventSignals(ev, tiersOf(ev.id), t, config.signals ?? {}).find(x => x.type === 'falling_count' && x.hours_to_zero <= bc.fallingTriggerHours);
      if (!f) continue;
      const recent = (target.triggers ?? []).some(g => g.type === 'falling_count' && t - Date.parse(g.at) < HOUR);
      if (!recent) addTrigger(target, { type: 'falling_count', reason: f.reason, offsets: bc.offsetsMinutes, at: t, event_id: ev.id });
      break;
    }
  }

  // External trigger (e.g. a platform email): arm an immediate verification check on whichever enabled watch shows
  // the event (its organiser page while that lists it, else its own event page). Logged even when nothing is armed.
  function addExternalTrigger({ source = 'fatsoma', url = null, event_id = null, reason = 'external trigger', via = 'manual', received_at = null }) {
    const t = now();
    const ev = event_id ? db.events[event_id] ?? null : url ? Object.values(db.events).find(e => e.source === source && sameEventPage(e.canonical_url, url)) ?? null : null;
    const shows = x => x.enabled && x.source === source && (x.kind === 'organiser'
      ? !!ev && (x.covers ?? []).includes(ev.id)
      : (!!url && sameEventPage(x.target, url)) || (!!ev && eventFor(x)?.id === ev.id));
    const targets = db.targets.filter(shows).filter(x => x.kind === 'organiser' || !coveredBy(x));
    const entry = { id: store.nextId('trg'), at: iso(t), type: 'external', via, reason, url, event_id: ev?.id ?? event_id, received_at, armed: [] };
    if (!bc.enabled) entry.note = 'bursts are off: logged only';
    else if (!targets.length) entry.note = 'no enabled watch shows this event: logged only';
    else {
      for (const target of targets) if (addTrigger(target, { type: 'external', reason, offsets: bc.externalOffsetsMinutes, at: t, via, event_id: ev?.id ?? null, received_at, log_id: entry.id })) entry.armed.push(target.id);
      if (!entry.armed.length) entry.note = 'an external trigger for this watch is already active: logged only';
    }
    db.trigger_log.push(entry);
    store.save();
    log?.info('trigger', entry);
    return entry;
  }

  // The earliest burst slot due now for this target, or null. Marks missed slots and the per-trigger limit.
  function dueBurstSlot(target, t) {
    target.triggers = (target.triggers ?? []).filter(g => t - Date.parse(g.at) <= 3 * HOUR);
    let best = null;
    for (const g of target.triggers) {
      g.done ??= {};
      const sentForTrigger = Object.values(g.done).filter(v => v.requested).length;
      for (const off of g.offsets) {
        if (g.done[off]) continue;
        const at = Date.parse(g.at) + off * MIN;
        if (t < at) continue;
        const note = outcome => { g.done[off] = { outcome, at: iso(t) }; record({ at: iso(t), source: target.source, target_id: target.id, kind: 'burst', trigger_id: g.id, trigger_type: g.type, offset_minutes: off, requested: false, outcome }); };
        if (t - at > rw.slotToleranceMinutes * MIN) { note(`missed: slot was due ${Math.round((t - at) / MIN)} min earlier`); continue; }
        if (sentForTrigger >= bc.maxChecksPerTrigger) { note('skipped: per-trigger limit reached'); continue; }
        if (!best || at < best.at) best = { trigger: g, off, at };
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
      at: iso(t0), source: target.source, target_id: target.id, target_kind: target.kind ?? 'event', kind: meta.kind,
      reason: meta.reason ?? (meta.kind === 'release_window' ? `release ${meta.R} ${meta.off >= 0 ? '+' : ''}${meta.off} min`
        : meta.kind === 'burst' ? `${meta.burst.trigger.type} trigger (${meta.burst.trigger.reason}) +${meta.burst.off} min` : 'rotation'),
      release_at: meta.R ?? null, offset_minutes: meta.off ?? meta.burst?.off ?? null,
      ...(meta.burst ? { trigger_id: meta.burst.trigger.id, trigger_type: meta.burst.trigger.type, minutes_after_trigger: Math.round((t0 - Date.parse(meta.burst.trigger.at)) / 6000) / 10 } : {}),
      minutes_after_release: meta.R ? Math.round((t0 - Date.parse(meta.R)) / 6000) / 10 : null,
      requested: !obs.refused,
      cache_status: obs.headers?.['x-cache-status'] ?? obs.headers?.['x-cache'] ?? null,
    };
    if (obs.refused) {
      entry.outcome = `refused: ${obs.refused}`;
      target.last_result = entry.outcome;
      if (meta.key) target.release_checks[meta.key] = { outcome: entry.outcome, at: entry.at, requested: false };
      if (meta.burst) meta.burst.trigger.done[meta.burst.off] = { outcome: entry.outcome, at: entry.at, requested: false };
      record(entry);
      store.save();
      return { ran: target.id, kind: meta.kind, refused: obs.refused };
    }
    // The first successful check of a newly added watch is its baseline: what is already listed is not "new".
    const r = await engine.ingest({ ...obs, baseline: !target.baseline_at });
    if (r.observation.status === 'valid') {
      target.baseline_at ??= entry.at;
      if (target.kind === 'organiser') { target.covers = r.events.map(e => e.id); target.covers_at = entry.at; }
    }
    Object.assign(entry, {
      observation_id: r.observation.id,
      http_status: obs.status ?? null,
      outcome: `${r.observation.classification}/${r.observation.status}`,
      duration_ms: Math.round(performance.now() - started),
      changes: r.changes.map(x => x.kind),
      alerts: r.notifications.length,
    });
    target.last_result = entry.outcome;
    if (meta.key) target.release_checks[meta.key] = { outcome: entry.outcome, at: entry.at, requested: true };
    if (meta.burst) meta.burst.trigger.done[meta.burst.off] = { outcome: entry.outcome, at: entry.at, requested: true };
    record(entry);
    internalTriggers(target, r, t0);
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
      .filter(x => x.c && x.src?.enabled && x.src.live)
      .filter(({ target }) => {
        const by = coveredBy(target);
        if (by) target.last_result = `covered by organiser page ${by.id}; not checked separately`;
        return !by;
      });

    // 1. Extra checks: release windows (known release times) and bursts (after a trigger), earliest slot first.
    // Same safeguards for both: a shared per-site hourly allowance, the minimum gap, nothing while the site is
    // backing off or paused, and a slot missed by more than the tolerance is logged rather than fired late.
    if (rw.enabled || bc.enabled) {
      const extras = [];
      for (const x of live) {
        if (rw.enabled) { const slot = dueSlot(x.target, t); if (slot) extras.push({ ...x, kind: 'release_window', slot, at: slot.at }); }
        if (bc.enabled) { const slot = dueBurstSlot(x.target, t); if (slot) extras.push({ ...x, kind: 'burst', slot, at: slot.at }); }
      }
      extras.sort((a, b) => a.at - b.at);
      let wait = null;
      for (const { target, c, kind, slot } of extras) {
        const h = db.sources[target.source];
        const skip = reason => {
          if (kind === 'release_window') {
            target.release_checks[slot.key] = { outcome: 'skipped', at: iso(t) };
            record({ at: iso(t), source: target.source, target_id: target.id, kind, release_at: slot.R, offset_minutes: slot.off, requested: false, outcome: `skipped: ${reason}` });
          } else {
            slot.trigger.done[slot.off] = { outcome: 'skipped', at: iso(t) };
            record({ at: iso(t), source: target.source, target_id: target.id, kind, trigger_id: slot.trigger.id, trigger_type: slot.trigger.type, offset_minutes: slot.off, requested: false, outcome: `skipped: ${reason}` });
          }
        };
        if ((h?.paused_until && Date.parse(h.paused_until) > t) || (h?.backoff_level ?? 0) > 0) { skip('site is backing off or paused'); continue; }
        if (inLastHour(target.source, t, EXTRA) >= rw.maxExtraPerSitePerHour || inLastHour(target.source, t) >= siteCap()) { skip('per-site hourly budget reached'); continue; }
        if (!gapOk(target.source, t)) { wait = 'minimum gap between requests'; continue; } // retried next tick, within tolerance
        return request(target, c, kind === 'release_window' ? { kind, ...slot } : { kind, burst: slot });
      }
      if (wait) return { ran: null, reason: wait };
    }

    // 2. Normal monitoring: unchanged rules, plus the hard site budget and minimum gap. When several targets on
    // one site are due, the most overdue goes first (never-checked targets first, then in list order), so a
    // site's single hourly slot rotates fairly instead of always going to the first target in the list.
    // With signal priority on (DROPWATCH_SIGNAL_PRIORITY=on), the due watch whose events show the strongest
    // signal goes first instead; a watch overdue by maxOverdueIntervals is taken regardless, so none starves.
    const dueAt = target => (target.last_run_at ? Date.parse(target.last_run_at) : 0) + target.interval_minutes * MIN;
    let due = live.filter(({ target }) => t >= dueAt(target)).sort((a, b) => dueAt(a.target) - dueAt(b.target));
    const sig = config.signals;
    if (sig?.enabled && due.length) {
      const tiersOf = id => Object.values(db.tiers).filter(x => x.event_id === id);
      due = due.map(x => {
        const interval = x.target.interval_minutes * MIN;
        const elapsed = x.target.last_run_at ? t - Date.parse(x.target.last_run_at) : Infinity;
        const overdue = elapsed >= sig.maxOverdueIntervals * interval;
        const p = watchPriority(eventsFor(x.target), tiersOf, t, sig);
        const score = overdue ? 1e6 + Math.min(elapsed, 1e12) / interval : p.strength + elapsed / interval;
        const reason = overdue
          ? (x.target.last_run_at ? `overdue: not checked for ${Math.round(elapsed / MIN)} min` : 'first check')
          : p.signals.length ? p.signals.map(s => `${s.type}: ${s.reason}`).join('; ') : 'rotation';
        return { ...x, score, reason, signals: p.signals.map(s => s.type) };
      }).sort((a, b) => b.score - a.score || dueAt(a.target) - dueAt(b.target));
    }
    for (const { target, c, src, reason } of due) {
      const h = db.sources[target.source];
      if (t < nextAllowedAttempt(h, src.intervalMinutes)) continue;
      if (inLastHour(target.source, t) >= siteCap() || !gapOk(target.source, t)) continue;
      return request(target, c, { kind: 'scheduled', reason });
    }
    return { ran: null, reason: 'nothing due' };
  }

  return {
    addTarget,
    addExternalTrigger,
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

// Same event page: for /e/<id>/<slug> URLs the id decides (the slug can vary, e.g. in emails); otherwise the path.
function sameEventPage(a, b) {
  try {
    const id = u => { const x = new URL(u); const m = x.pathname.match(/^\/e\/([a-z0-9]+)(\/|$)/i); return m ? x.host.replace(/^www\./, '') + '/e/' + m[1].toLowerCase() : null; };
    const ia = id(a), ib = id(b);
    return ia && ib ? ia === ib : samePage(a, b);
  } catch { return false; }
}

function samePage(a, b) {
  try {
    const p = u => new URL(u).host + new URL(u).pathname.replace(/\/+$/, '').toLowerCase();
    return p(a) === p(b);
  } catch { return false; }
}
