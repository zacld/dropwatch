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
//   node monitor/cli.js release-report [--hours 48]
//       Read-only: requests made per site and kind, and each release window's checks, outcomes and how many
//       minutes after the release the first change was detected. Safe while the monitor is running.
//   node monitor/cli.js detection-report [--hours 48] [--all]
//       Read-only: each alerted change (--all: also recorded-only changes) with the window it appeared in, which
//       check found it and why that check ran (signal, rotation, release window), and the alert time.
import { loadDotEnv, loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createMonitorApp } from './app.js';
import { manualObservation, retrieveLive } from './retrieve.js';
import { connectorById } from './connectors/index.js';
import { createMonitorStore } from './store.js';
import { createEngine } from './engine.js';
import { defaultPreferences } from './preferences.js';
import { releaseReport } from './scheduler.js';
import { detectionReport } from './reports.js';
import { join } from 'node:path';

loadDotEnv();
const [cmd, ...rest] = process.argv.slice(2);
const opt = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const config = loadConfig(process.env, { scheduler: { enabled: false, tickSeconds: 60 } });
const log = createLogger({ level: config.logLevel, base: { svc: 'monitor-cli' }, sink: l => process.stderr.write(l + '\n') });
const app = ['compare', 'release-report', 'detection-report'].includes(cmd) ? null : createMonitorApp({ config, log });
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
} else if (cmd === 'release-report') {
  // Read-only: loads the store but never saves it.
  const db = createMonitorStore(join(config.dataDir, 'monitor.json')).data;
  const since = Date.now() - Number(opt('hours') ?? 48) * 3_600_000;
  const log = (db.request_log ?? []).filter(r => Date.parse(r.at) >= since);
  console.log(`Release windows: ${config.releaseWindow.enabled ? 'ON' : 'off'} (offsets ${config.releaseWindow.offsetsMinutes.join(', ')} min; max ${config.releaseWindow.maxChecksPerRelease} per release; max ${config.releaseWindow.maxExtraPerSitePerHour} extra per site per hour)`);
  console.log(`\nRequests in the last ${opt('hours') ?? 48} h:`);
  const counts = {};
  for (const r of log) { const k = `${r.source} ${r.kind} ${r.requested ? 'sent' : r.outcome.split(':')[0]}`; counts[k] = (counts[k] ?? 0) + 1; }
  for (const [k, n] of Object.entries(counts)) console.log(`  ${k.padEnd(40)} ${n}`);
  if (!log.length) console.log('  none');
  const windows = releaseReport(log);
  console.log(`\nRelease windows: ${windows.length}`);
  for (const w of windows) {
    const t = db.targets.find(x => x.id === w.target_id);
    console.log(`\n  ${w.source} ${t?.target ?? w.target_id}\n  release ${w.release_at}  first change detected: ${w.first_change_minutes_after_release === null ? 'none' : `+${w.first_change_minutes_after_release} min`}`);
    for (const s of w.slots) console.log(`    ${String(s.offset_minutes).padStart(4)} min  ${s.at}  ${s.requested ? 'sent   ' : 'no req '} ${s.outcome}${s.changes.length ? `  changes: ${s.changes.join(', ')}` : ''}${s.alerts ? `  alerts: ${s.alerts}` : ''}`);
  }
} else if (cmd === 'detection-report') {
  // Read-only: loads the store but never saves it.
  const db = createMonitorStore(join(config.dataDir, 'monitor.json')).data;
  const hours = Number(opt('hours') ?? 48);
  const rows = detectionReport(db, { sinceMs: Date.now() - hours * 3_600_000, includeRecordOnly: rest.includes('--all') });
  console.log(`Signal priority: ${config.signals.enabled ? 'ON' : 'off'} | changes in the last ${hours} h: ${rows.length}`);
  for (const r of rows) {
    console.log(`\n  ${r.observed_at}  ${r.title ?? r.event_id}`);
    console.log(`    ${r.kind}${r.tier ? ` [${r.tier}]` : ''}: ${JSON.stringify(r.previous)} → ${JSON.stringify(r.current)}`);
    console.log(`    appeared between ${r.appeared_after ?? '(first observation)'} and ${r.observed_at}${r.window_minutes !== null ? ` (${r.window_minutes} min window)` : ''}`);
    console.log(`    found by: ${r.found_by.kind}${r.found_by.reason ? ` (${r.found_by.reason})` : ''}${r.found_by.cache_status ? `, cache ${r.found_by.cache_status}` : ''}`);
    console.log(`    ${r.alerted_at ? `alerted ${r.alerted_at} (+${r.alert_delay_seconds} s)` : `not alerted${r.ineligible_reason ? `: ${r.ineligible_reason}` : ''}`}`);
  }
} else if (cmd === 'status') {
  print(app.engine.sourcesView().map(s => ({ source: s.source, state: s.state, enabled: s.enabled, live: s.live_retrieval, last_success_at: s.last_success_at, last_origin: s.last_origin, failures: s.consecutive_failures, paused_until: s.paused_until })));
} else {
  console.log('commands: ingest | fixture | fetch | status | compare | release-report | detection-report   (see the top of monitor/cli.js)');
}
