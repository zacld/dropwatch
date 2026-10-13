import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestSeller } from '../test-seller/seller.js';
import { TEST_ACCOUNT } from '../test-seller/seed.js';
import { createDropwatchServer } from '../server/app.js';
import { defaultSellers } from '../server/sellers.js';
import { Companion } from '../companion/companion.js';
import { loadAdapters } from '../companion/adapters/index.js';
import { runHarness } from '../harness/harness.js';

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dropwatch-test-'));
  const seller = createTestSeller({ events: [], rng: () => 0.99 }); // no checks, no declines
  const sellerUrl = await seller.start();
  const server = createDropwatchServer({ dataDir, sellers: defaultSellers(sellerUrl), companionToken: 't', log: () => {} });
  const serverUrl = await server.start();
  const { publicKey } = await (await fetch(`${serverUrl}/api/companion/key`)).json();
  const companion = new Companion({
    serverUrl, token: 't', deviceId: 'test-device', publicKey,
    adapters: loadAdapters({ testSellerUrl: sellerUrl, pollMs: 10 }),
    sessions: { 'test-seller': { ...TEST_ACCOUNT } }, log: () => {},
  });
  const api = async (method, path, body) => {
    const res = await fetch(serverUrl + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  const addEvent = async id => {
    seller.upsertEvent({
      id, name: 'Kettama', venue: 'Ibiza', limit: 4, saleStart: Date.now() + 200, waitingRoomLeadMs: 150,
      crowd: 10, admitPerSec: 1000, tiers: [{ name: 'Early bird', price: 40, stock: 100 }, { name: 'Tier 1', price: 55, stock: 100 }],
    });
    await server.refreshEvents();
  };
  const arm = async (eventId, extra = {}) => {
    const body = { sellerId: 'test-seller', eventId, qty: 2, maxPerTicket: 50, totalCap: 100, tierRule: 'any', ...extra };
    const p = (await api('POST', '/api/authorisation/preview', body)).data;
    return (await api('POST', '/api/watches', { ...body, authorise: true, textHash: p.textHash })).data;
  };
  const instructions = async () =>
    (await fetch(`${serverUrl}/api/companion/instructions`, { headers: { 'x-companion-token': 't' } })).json();
  const teardown = async () => {
    await server.stop();
    await seller.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { seller, server, companion, api, addEvent, arm, instructions, teardown };
}

test('an authorised watch is bought once, within limits, and confirmed', async () => {
  const s = await setup();
  await s.addEvent('ev-a');
  const w = await s.arm('ev-a');
  const [instr] = await s.instructions();
  const r = await s.companion.runAttempt(instr);
  assert.equal(r.outcome, 'secured');
  assert.equal(r.order.qty, 2);
  assert.equal(r.order.tierName, 'Early bird');
  const again = await s.companion.runAttempt(instr);
  assert.equal(again.outcome, 'not_claimed', 'a second attempt is refused by the lock');
  assert.equal(s.seller.stats.checkoutCalls.length, 1);
  const final = (await s.api('GET', '/api/watches')).data.find(x => x.id === w.id);
  assert.equal(final.status, 'secured');
  assert.equal(final.fee, 4.99);
  await s.teardown();
});

test('a tampered instruction is refused without taking the lock', async () => {
  const s = await setup();
  await s.addEvent('ev-b');
  await s.arm('ev-b');
  const [instr] = await s.instructions();
  instr.payload.terms.maxPerTicket = 500;
  const r = await s.companion.runAttempt(instr);
  assert.equal(r.outcome, 'refused');
  const [still] = await s.instructions();
  assert.equal(still.payload.watchId, instr.payload.watchId, 'watch is still armed');
  await s.teardown();
});

test('the authorisation must be confirmed exactly as shown', async () => {
  const s = await setup();
  await s.addEvent('ev-c');
  const body = { sellerId: 'test-seller', eventId: 'ev-c', qty: 2, maxPerTicket: 50, totalCap: 100, tierRule: 'any', authorise: true, textHash: 'stale' };
  const res = await s.api('POST', '/api/watches', body);
  assert.equal(res.status, 422);
  await s.teardown();
});

test('a revoked watch cannot be attempted', async () => {
  const s = await setup();
  await s.addEvent('ev-d');
  const w = await s.arm('ev-d');
  const [instr] = await s.instructions();
  await s.api('POST', `/api/watches/${w.id}/revoke`);
  const r = await s.companion.runAttempt(instr);
  assert.equal(r.outcome, 'not_claimed');
  assert.equal(s.seller.stats.checkoutCalls.length, 0);
  await s.teardown();
});

test('Ticketmaster is registered but not enabled for automated checkout', async () => {
  const s = await setup();
  const status = (await s.api('GET', '/api/status')).data;
  const tm = status.sellers.find(x => x.id === 'ticketmaster');
  assert.equal(tm.enabled, false);
  const res = await s.api('POST', '/api/authorisation/preview', { sellerId: 'ticketmaster', eventId: 'x', qty: 1, maxPerTicket: 50, totalCap: 50, tierRule: 'any' });
  assert.equal(res.data.ok, false);
  await s.teardown();
});

test('harness: no hard-rule violations or workflow errors across varied releases', async () => {
  const r = await runHarness({ runs: 40, seed: 3, concurrency: 8 });
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.workflowErrors, []);
  assert.ok(r.runs >= 30);
});
