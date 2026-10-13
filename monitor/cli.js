// Command line for the monitor store (data/monitor by default).
//
//   node monitor/cli.js ingest  --source skiddle --file saved-page.html [--url <page url>] [--observed-at ISO] [--status 200]
//       Ingest a page or API payload you saved yourself (origin "manual").
//   node monitor/cli.js fixture --id skiddle-v1
//       Ingest one fixture from fixtures/manifest.json (origin "fixture", sample data).
//   node monitor/cli.js fetch   --source ticketmaster --target <discovery event id>
//       ONE live request. Refused unless DROPWATCH_LIVE_<SOURCE>=on and the source permits live retrieval.
//   node monitor/cli.js status
//       Source health and counts.
//   node monitor/cli.js compare --source fatsoma --before a.html --after b.html [--url <page url>]
//       Two snapshots of one event → detected changes → alerts, then the "after" snapshot again to show it
//       sends nothing. Uses a throwaway in-memory store; your monitor data is not touched.
import { loadDotEnv, loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createMonitorApp } from './app.js';
import { manualObservation, retrieveLive } from './retrieve.js';
import { connectorById } from './connectors/index.js';
import { createMonitorStore } from './store.js';
import { createEngine } from './engine.js';
import { defaultPreferences } from './preferences.js';

loadDotEnv();
const [cmd, ...rest] = process.argv.slice(2);
const opt = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const config = loadConfig(process.env, { scheduler: { enabled: false, tickSeconds: 60 } });
const log = createLogger({ level: config.logLevel, base: { svc: 'monitor-cli' }, sink: l => process.stderr.write(l + '\n') });
const app = cmd === 'compare' ? null : createMonitorApp({ config, log });
const print = v => console.log(JSON.stringify(v, null, 2));
const brief = r => ({
  observation: { id: r.observation.id, classification: r.observation.classification, status: r.observation.status, outcome: r.observation.outcome, events: r.observation.events, errors: r.observation.errors },
  changes: r.changes.map(c => ({ kind: c.kind, field: c.field, previous: c.previous, current: c.current, notify_eligible: c.notify_eligible, reason: c.ineligible_reason })),
  notifications: r.notifications.map(n => n.body),
});

if (cmd === 'ingest') {
  const source = opt('source');
  if (!connectorById(source) || !opt('file')) throw new Error('usage: ingest --source <id> --file <path>');
  print(brief(await app.engine.ingest(manualObservation(opt('file'), { source, target: opt('url') ?? null, status: Number(opt('status') ?? 200), observed_at: opt('observed-at') }))));
} else if (cmd === 'fixture') {
  print(brief(await app.ingestFixture(opt('id'))));
} else if (cmd === 'fetch') {
  const c = connectorById(opt('source'));
  if (!c || !opt('target')) throw new Error('usage: fetch --source <id> --target <url or id>');
  const obs = await retrieveLive(c, opt('target'), config, { log });
  if (obs.refused) { console.error(`Refused: ${obs.refused}`); process.exitCode = 2; }
  else print(brief(await app.engine.ingest(obs)));
} else if (cmd === 'compare') {
  const source = opt('source');
  if (!connectorById(source) || !opt('before') || !opt('after')) throw new Error('usage: compare --source <id> --before <file> --after <file> [--url <page url>]');
  const store = createMonitorStore(null);
  store.data.users.everyone = defaultPreferences('everyone');
  const outbox = [];
  let t = Date.now() - 2 * 3_600_000;
  const engine = createEngine({ store, config: { ...config, sources: { ...config.sources, [source]: { ...config.sources[source], enabled: true } } }, notifier: { id: 'compare', async send(n) { outbox.push(n); return { delivered: true }; } }, now: () => t });
  const step = async (label, file) => {
    const r = await engine.ingest(manualObservation(file, { source, target: opt('url') ?? null, observed_at: new Date(t).toISOString() }));
    console.log(`\n${label}: ${file}`);
    console.log(`  outcome: ${r.observation.events.map(e => e.outcome).join('; ') || r.observation.outcome}`);
    for (const c of r.changes) console.log(`  ${c.notify_eligible ? 'ALERT ' : 'record'} ${c.kind}${c.tier ? ` [${c.tier}]` : ''}: ${JSON.stringify(c.previous)} → ${JSON.stringify(c.current)}${c.ineligible_reason ? `  (${c.ineligible_reason})` : ''}`);
    for (const n of r.notifications) console.log(`  >> alert sent: ${n.title}\n     ${n.lines.join('\n     ')}`);
    if (!r.notifications.length) console.log('  >> no alert sent');
    t += 3_600_000;
  };
  await step('Snapshot 1 (before)', opt('before'));
  await step('Snapshot 2 (after)', opt('after'));
  await step('Snapshot 2 again (duplicate check)', opt('after'));
  console.log(`\n${outbox.length} alert(s) in total; ${store.data.suppressed} suppressed as duplicates.`);
} else if (cmd === 'status') {
  print(app.engine.sourcesView().map(s => ({ source: s.source, state: s.state, enabled: s.enabled, live: s.live_retrieval, last_success_at: s.last_success_at, last_origin: s.last_origin, failures: s.consecutive_failures, paused_until: s.paused_until })));
} else {
  console.log('commands: ingest | fixture | fetch | status | compare   (see the top of monitor/cli.js)');
}
