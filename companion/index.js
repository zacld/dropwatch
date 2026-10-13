// Starts the Dropwatch Companion on this device.
//   node companion/index.js                 run
//   node companion/index.js signin test-seller <email> <password>
// Seller sign-ins are stored only in companion/data/sessions.json on this device.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { Companion } from './companion.js';
import { loadAdapters } from './adapters/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.env.COMPANION_DATA ?? join(root, 'data', 'companion');
mkdirSync(dir, { recursive: true });
const sessionsFile = join(dir, 'sessions.json');
const keyFile = join(dir, 'server-key.pem');
const sessions = existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, 'utf8')) : {};
const saveSessions = () => writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2));

const serverUrl = process.env.DROPWATCH_URL ?? 'http://127.0.0.1:4000';
const adapters = loadAdapters({ testSellerUrl: process.env.SELLER_URL ?? 'http://127.0.0.1:4100' });

const [cmd, sellerId, email, password] = process.argv.slice(2);
if (cmd === 'signin') {
  const adapter = adapters[sellerId];
  if (!adapter?.enabled) throw new Error(`No enabled adapter for ${sellerId}.`);
  sessions[sellerId] = { email, password };
  const s = await adapter.openSession(sessions[sellerId]);
  if (!s.signedIn) throw new Error('Sign-in failed.');
  saveSessions();
  console.log(`Signed in to ${adapter.name} as ${s.account}. Stored on this device only.`);
  process.exit(0);
}

const token = process.env.DROPWATCH_COMPANION_TOKEN
  ?? readFileSync(join(root, 'data', 'server', 'companion-token.txt'), 'utf8').trim();

// Pin the server's signing key on first run; instructions signed by any other key are refused.
if (!existsSync(keyFile)) {
  const { publicKey } = await (await fetch(`${serverUrl}/api/companion/key`)).json();
  writeFileSync(keyFile, publicKey);
}

const companion = new Companion({
  serverUrl, token, deviceId: `companion@${hostname()}`, publicKey: readFileSync(keyFile, 'utf8'),
  adapters, sessions,
});
companion.start();
console.log(`Dropwatch Companion running on ${hostname()}, connected to ${serverUrl}`);
setInterval(saveSessions, 30_000).unref();
