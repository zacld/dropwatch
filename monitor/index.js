// Dropwatch Monitor server.  npm run monitor
import { loadDotEnv, loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createMonitorApp } from './app.js';

loadDotEnv();
const config = loadConfig();
const log = createLogger({ level: config.logLevel, base: { svc: 'monitor' } });
const app = createMonitorApp({ config, log });
const url = await app.start(config.port);
log.info('started', { url, dataDir: config.dataDir, scheduler: config.scheduler.enabled, devRoutes: config.devRoutes });
console.log(`Dropwatch Monitor running at ${url}`);
