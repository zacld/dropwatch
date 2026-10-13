import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createDropwatchServer } from './app.js';
import { defaultSellers } from './sellers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DROPWATCH_DATA ?? join(root, 'data', 'server');
mkdirSync(dataDir, { recursive: true });

// Shared secret the Companion uses to talk to this server (stand-in for device pairing).
const tokenFile = join(dataDir, 'companion-token.txt');
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('hex'));
const companionToken = process.env.DROPWATCH_COMPANION_TOKEN ?? readFileSync(tokenFile, 'utf8').trim();

const app = createDropwatchServer({
  dataDir,
  sellers: defaultSellers(process.env.SELLER_URL ?? 'http://127.0.0.1:4100'),
  companionToken,
});
const base = await app.start(Number(process.env.PORT ?? 4000));
console.log(`Dropwatch server running at ${base}`);
console.log(`Companion pairing token stored in ${tokenFile}`);
