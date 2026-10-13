import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { router, send, httpError, listen } from '../shared/http.js';
import { ROOT } from './config.js';
import { createMonitorStore } from './store.js';
import { createEngine } from './engine.js';
import { createScheduler } from './scheduler.js';
import { createLocalNotifier } from './notify.js';
import { defaultPreferences, validatePreferences, matchEvent } from './preferences.js';
import { fixtureObservation } from './retrieve.js';
import { connectorById } from './connectors/index.js';
import { matchKey } from './values.js';
import { silentLogger } from './log.js';

// Dropwatch Monitor HTTP server: opportunity feed, event detail and history, preferences, notifications,
// source health. Read-only toward ticketing sites; it never buys anything.

const WEB = join(ROOT, 'web', 'monitor.html');
export const FIXTURE_DIR = join(ROOT, 'fixtures');
export const manifest = () => JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));

export function createMonitorApp({ config, store, now = () => Date.now(), log = silentLogger, notifier, fetchImpl } = {}) {
  store ??= createMonitorStore(join(config.dataDir, 'monitor.json'));
  notifier ??= createLocalNotifier(store && config.dataDir ? join(config.dataDir, 'outbox.jsonl') : null);
  const engine = createEngine({ store, config, notifier, now, log });
  const scheduler = createScheduler({ store, engine, config, now, log, fetchImpl });
  const db = store.data;
  if (!Object.keys(db.users).length) { db.users.demo = defaultPreferences('demo', 'You (demo user)'); store.save(); }
  let demoStep = 0;

  const userOf = id => {
    const u = db.users[id ?? 'demo'];
    if (!u) throw httpError(404, 'no_user', 'User not found.');
    return u;
  };

  // Ingest one manifest fixture as an observation. Real fixtures keep their real observation time;
  // synthetic ones are stamped with the ingest time and labelled as sample data.
  async function ingestFixture(id) {
    const f = manifest().fixtures.find(x => x.id === id);
    if (!f) throw httpError(404, 'no_fixture', `No fixture ${id}.`);
    const obs = fixtureObservation(join(FIXTURE_DIR, f.file), {
      source: f.source, status: f.status, fixture: f.id,
      observed_at: f.observed_at ?? new Date(now()).toISOString(),
    });
    return engine.ingest(obs);
  }

  const summary = r => ({
    observation: r.observation,
    changes: r.changes,
    notifications: r.notifications,
  });

  function feed(query) {
    const user = db.users[query.get('user') ?? 'demo'] ?? null;
    const q = matchKey(query.get('q') ?? '');
    const city = (query.get('city') ?? '').toLowerCase();
    const source = query.get('source') ?? '';
    const from = query.get('from') ?? '';
    const to = query.get('to') ?? '';
    const maxPrice = query.get('max_price') ? Number(query.get('max_price')) : null;
    const onlyMatching = query.get('only_matching') === '1';
    const events = Object.values(db.events).map(engine.eventView).filter(e => {
      if (q && !matchKey([e.title, e.venue_name, e.city, ...(e.artists ?? [])].join(' ')).includes(q)) return false;
      if (city && (e.city ?? '').toLowerCase() !== city) return false;
      if (source && e.source !== source) return false;
      if (from && e.start_at && e.start_at < new Date(from).toISOString()) return false;
      if (to && e.start_at && e.start_at > new Date(to + 'T23:59:59Z').toISOString()) return false;
      if (maxPrice != null && e.minimum_price != null && e.minimum_price > maxPrice) return false;
      return true;
    });
    // The same night on several platforms is one opportunity with several sources.
    const groups = new Map();
    for (const e of events) {
      if (!groups.has(e.match_key)) groups.set(e.match_key, []);
      groups.get(e.match_key).push(e);
    }
    const items = [...groups.entries()].map(([key, evs]) => {
      evs.sort((a, b) => (b.last_successful_observation_at ?? '').localeCompare(a.last_successful_observation_at ?? ''));
      const match = user ? matchEvent(user, evs[0]) : null;
      const latest = db.changes.filter(c => evs.some(e => e.id === c.event_id)).slice(-3).reverse();
      return { key, events: evs, match, latest_changes: latest };
    }).filter(i => !onlyMatching || i.match?.match)
      .sort((a, b) => (a.events[0].start_at ?? '9').localeCompare(b.events[0].start_at ?? '9'));
    return { items, total: items.length, generated_at: new Date(now()).toISOString() };
  }

  const handle = router([
    ['GET', '/', ({ res }) => send(res, 200, readFileSync(WEB, 'utf8'), 'text/html')],
    ['GET', '/api/health', () => {
      const sources = engine.sourcesView();
      return {
        ok: true,
        time: new Date(now()).toISOString(),
        scheduler: config.scheduler.enabled ? 'on' : 'off',
        dev_routes: !!config.devRoutes,
        sources: sources.map(s => ({ source: s.source, state: s.state, enabled: s.enabled, live_retrieval: s.live_retrieval, last_success_at: s.last_success_at, last_origin: s.last_origin, consecutive_failures: s.consecutive_failures })),
        counts: { events: Object.keys(db.events).length, changes: db.changes.length, notifications: db.notifications.length, suppressed: db.suppressed, observations: db.observations.length },
      };
    }],
    ['GET', '/api/sources', () => engine.sourcesView()],
    ['GET', '/api/feed', ({ query }) => feed(query)],
    ['GET', '/api/events/:id', ({ params }) => {
      const e = db.events[params.id];
      if (!e) throw httpError(404, 'no_event', 'Event not found.');
      return {
        event: engine.eventView(e),
        tiers: Object.values(db.tiers).filter(t => t.event_id === e.id),
        quarantined: db.quarantined[e.id] ?? [],
        changes: db.changes.filter(c => c.event_id === e.id).reverse(),
        observations: db.observations.filter(o => (e.observation_ids ?? []).includes(o.id)).reverse(),
        also_listed_on: Object.values(db.events).filter(x => x.match_key === e.match_key && x.id !== e.id).map(x => ({ id: x.id, source: x.source, url: x.canonical_url })),
      };
    }],
    ['GET', '/api/changes', ({ query }) => db.changes.slice(-Number(query.get('limit') ?? 100)).reverse()],
    ['GET', '/api/observations', ({ query }) => db.observations.slice(-Number(query.get('limit') ?? 100)).reverse()],
    ['GET', '/api/notifications', ({ query }) => db.notifications.filter(n => n.user_id === (query.get('user') ?? 'demo')).slice(-100).reverse()],
    ['GET', '/api/users/:id', ({ params }) => userOf(params.id)],
    ['PUT', '/api/users/:id', ({ params, body }) => {
      const existing = db.users[params.id] ?? defaultPreferences(params.id);
      const v = validatePreferences(body, existing);
      if (!v.ok) throw httpError(422, 'invalid', v.errors.join(' '));
      db.users[params.id] = v.preferences;
      store.save();
      return v.preferences;
    }],
    ['GET', '/api/targets', () => db.targets],
    ['POST', '/api/targets', ({ body }) => {
      const c = connectorById(body.source);
      if (!c) throw httpError(422, 'invalid', 'Unknown source.');
      if (!config.sources[c.id]?.live) throw httpError(409, 'live_off', `Live retrieval is off for ${c.name}.`);
      try { return { httpStatus: 201, body: scheduler.addTarget(body) }; } catch (e) { throw httpError(422, 'invalid', e.message); }
    }],

    // Development only: load fixtures through the full pipeline.
    ['GET', '/api/dev/fixtures', () => { devOnly(); const m = manifest(); return { fixtures: m.fixtures, steps: m.demo.steps, next_step: demoStep }; }],
    ['POST', '/api/dev/ingest', async ({ body }) => { devOnly(); return summary(await ingestFixture(String(body.fixture))); }],
    ['POST', '/api/dev/next-step', async () => {
      devOnly();
      const steps = manifest().demo.steps;
      if (demoStep >= steps.length) return { done: true, step: demoStep };
      const s = steps[demoStep++];
      return { done: false, step: demoStep, of: steps.length, explains: s.explains, fixture: s.fixture, ...summary(await ingestFixture(s.fixture)) };
    }],
  ]);
  function devOnly() { if (!config.devRoutes) throw httpError(404, 'not_found', 'Development routes are off.'); }

  const server = http.createServer(handle);
  return {
    server, store, engine, scheduler, ingestFixture,
    async start(port = config.port) {
      scheduler.start();
      return listen(server, port);
    },
    stop: () => new Promise(r => { scheduler.stop(); server.close(r); }),
  };
}
