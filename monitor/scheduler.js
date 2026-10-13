import { connectorById } from './connectors/index.js';
import { retrieveLive } from './retrieve.js';
import { nextAllowedAttempt } from './health.js';
import { MIN_INTERVAL_MINUTES } from './config.js';

// Conservative polling of configured targets. Off unless DROPWATCH_SCHEDULER=on, and then only for sources
// whose live retrieval is switched on. At most one request per tick, never faster than the source interval
// (with a hard floor), doubled after each failure, and paused after a block, challenge or rate limit.

export function createScheduler({ store, engine, config, now = () => Date.now(), log, fetchImpl }) {
  const db = store.data;
  let timer = null;

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

  // Returns what it did, for tests and the status endpoint.
  async function tick() {
    if (!config.scheduler.enabled) return { ran: null, reason: 'scheduler off' };
    const t = now();
    for (const target of db.targets.filter(x => x.enabled)) {
      const c = connectorById(target.source);
      const src = config.sources[target.source];
      if (!c || !src?.enabled || !src.live) continue;
      const h = db.sources[target.source];
      const due = (target.last_run_at ? Date.parse(target.last_run_at) : 0) + target.interval_minutes * 60_000;
      if (t < due || t < nextAllowedAttempt(h, src.intervalMinutes)) continue;
      target.last_run_at = new Date(t).toISOString();
      const obs = await retrieveLive(c, target.target, config, { fetchImpl, now, log });
      if (obs.refused) {
        target.last_result = `refused: ${obs.refused}`;
        store.save();
        return { ran: target.id, refused: obs.refused };
      }
      const r = await engine.ingest(obs);
      target.last_result = `${r.observation.classification}/${r.observation.status}`;
      store.save();
      return { ran: target.id, observation: r.observation };
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
