// Local demonstration of the monitoring engine with sample data.
//   npm run monitor:demo   → http://127.0.0.1:4200
// Starts from an empty data/monitor-demo store, follows a few artists for the demo user, loads the initial
// fixtures through the full pipeline, and enables the "next step" button that replays later observations.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadDotEnv, loadConfig, ROOT } from '../monitor/config.js';
import { createLogger } from '../monitor/log.js';
import { createMonitorApp, manifest } from '../monitor/app.js';

loadDotEnv();
const dataDir = join(ROOT, 'data', 'monitor-demo');
rmSync(dataDir, { recursive: true, force: true });
const config = loadConfig(process.env, { dataDir, devRoutes: true, scheduler: { enabled: false, tickSeconds: 60 } });
// The demo never makes live requests.
for (const s of Object.values(config.sources)) s.live = false;
const log = createLogger({ level: process.env.DROPWATCH_LOG_LEVEL ?? 'warn', base: { svc: 'monitor-demo' } });
const app = createMonitorApp({ config, log });

app.store.data.users.demo = {
  ...app.store.data.users.demo,
  follows: { artists: ['KETTAMA', 'Prospa', 'Josh Baker', 'Toxic Machinery'], teams: [], categories: [], venues: ['Depot Mayfield'], events: [] },
  cities: ['Manchester', 'London', 'Sheffield'],
  max_price: 40,
};
app.store.save();

for (const id of manifest().demo.initial) await app.ingestFixture(id);
const url = await app.start(Number(process.env.DROPWATCH_MONITOR_PORT ?? 4200));
console.log(`
Dropwatch Monitor demo (sample data only, no live requests)

  Dashboard   ${url}
  Health      ${url}/api/health

Use "Replay next observation" in the dashboard to step through later fixture observations.
Press Ctrl+C to stop.`);
