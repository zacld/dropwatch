// Runs the whole local system: test seller, Dropwatch server and a Companion signed in to the test seller.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { createTestSeller } from '../test-seller/seller.js';
import { TEST_ACCOUNT } from '../test-seller/seed.js';
import { createDropwatchServer } from '../server/app.js';
import { defaultSellers } from '../server/sellers.js';
import { Companion } from '../companion/companion.js';
import { loadAdapters } from '../companion/adapters/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = join(root, 'data', 'server');
const companionDir = join(root, 'data', 'companion');
mkdirSync(serverDir, { recursive: true });
mkdirSync(companionDir, { recursive: true });

const tokenFile = join(serverDir, 'companion-token.txt');
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('hex'));
const token = readFileSync(tokenFile, 'utf8').trim();

const seller = createTestSeller();
const sellerUrl = await seller.start(Number(process.env.SELLER_PORT ?? 4100));
const server = createDropwatchServer({ dataDir: serverDir, sellers: defaultSellers(sellerUrl), companionToken: token });
const serverUrl = await server.start(Number(process.env.PORT ?? 4000));

const keyFile = join(companionDir, 'server-key.pem');
if (!existsSync(keyFile)) writeFileSync(keyFile, (await (await fetch(`${serverUrl}/api/companion/key`)).json()).publicKey);

// The demo signs the Companion in to the test seller with the seeded test account.
const companion = new Companion({
  serverUrl, token, deviceId: `companion@${hostname()}`, publicKey: readFileSync(keyFile, 'utf8'),
  adapters: loadAdapters({ testSellerUrl: sellerUrl }),
  sessions: { 'test-seller': { ...TEST_ACCOUNT } },
});
companion.start();

console.log(`
Dropwatch is running locally.

  Customer app      ${serverUrl}
  Test seller admin ${sellerUrl}/admin   (move a release to 90 seconds away to watch an attempt)

The Companion is running in this process, signed in to the test seller.
Press Ctrl+C to stop.`);
