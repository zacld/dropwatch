// Reliability harness: runs many complete releases against the local test seller, end to end through
// the real Dropwatch server API and the real Companion, then checks every hard rule against the
// seller's own record of baskets, checkouts and orders.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestSeller } from '../test-seller/seller.js';
import { TEST_ACCOUNT, DEFAULT_EVENTS } from '../test-seller/seed.js';
import { createDropwatchServer } from '../server/app.js';
import { defaultSellers } from '../server/sellers.js';
import { Companion } from '../companion/companion.js';
import { loadAdapters } from '../companion/adapters/index.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Small seeded PRNG so a run can be reproduced exactly.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Why an attempt did not end in a secured order.
export function classify(outcome, reason = '') {
  if (outcome === 'secured') return 'secured';
  if (/sold out|over your|outside your limits|total cap|not listed/i.test(reason)) return 'market: nothing eligible on sale';
  if (/check was not completed/i.test(reason)) return 'customer: did not complete a seller check';
  if (/did not confirm the payment/i.test(reason)) return 'payment: declined or not approved';
  return 'workflow error';
}

export async function runHarness({ runs = 200, concurrency = 10, seed = 1, customer = {}, log = () => {} } = {}) {
  const rng = mulberry32(seed);
  const pick = arr => arr[Math.floor(rng() * arr.length)];
  const between = (lo, hi) => lo + rng() * (hi - lo);
  const approveRate = customer.approveRate ?? 0.9;      // customer completes a check
  const ignoreRate = customer.ignoreRate ?? 0.03;       // customer never responds (asleep)

  const dataDir = mkdtempSync(join(tmpdir(), 'dropwatch-harness-'));
  const seller = createTestSeller({ rng: mulberry32(seed + 1), events: [] });
  const sellerUrl = await seller.start();
  const token = 'harness-token';
  const server = createDropwatchServer({ dataDir, sellers: defaultSellers(sellerUrl), companionToken: token, log: () => {} });
  const serverUrl = await server.start();
  const { publicKey } = await (await fetch(`${serverUrl}/api/companion/key`)).json();

  const makeCompanion = deviceId => new Companion({
    serverUrl, token, deviceId, publicKey,
    adapters: loadAdapters({ testSellerUrl: sellerUrl, pollMs: 15 }),
    sessions: { 'test-seller': { ...TEST_ACCOUNT } },
    customerWaitMs: 1500, challengePollMs: 15, log: () => {},
  });
  const companion = makeCompanion('harness-device-A');
  const rival = makeCompanion('harness-device-B'); // a second device racing for the same lock

  const api = async (method, path, body) => {
    const res = await fetch(serverUrl + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    return data;
  };

  // The simulated customer: watches for "needs you" and completes (or doesn't complete) the check.
  async function customerLoop(watchId, done) {
    const handled = new Set();
    while (!done.value) {
      const w = await api('GET', `/api/watches/${watchId}`);
      if (w?.status === 'needs_customer' && w.prompt?.url && !handled.has(w.prompt.url)) {
        handled.add(w.prompt.url);
        const id = w.prompt.url.split('/').pop();
        const r = rng();
        if (r >= ignoreRate) {
          await sleep(between(30, 300));
          await fetch(`${sellerUrl}/api/challenges/${id}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: r < ignoreRate + (1 - ignoreRate) * approveRate ? 'approve' : 'reject' }),
          });
        }
      }
      await sleep(20);
    }
  }

  async function oneRun(i) {
    const template = pick(DEFAULT_EVENTS());
    const crowd = Math.round(between(80, 600));
    // Listed with a later release; the release is brought forward once the watch is armed (below).
    const ev = seller.upsertEvent({
      id: `${template.id}-run${i}`, name: template.name, venue: template.venue, limit: template.limit,
      saleStart: Date.now() + 10 * 60_000, waitingRoomLeadMs: 1500,
      crowd, admitPerSec: crowd * between(0.8, 2), fanAvgQty: 2,
      tiers: template.tiers.map(tr => ({ ...tr, stock: Math.round(crowd * 2 * between(0.15, 0.7)) })),
      holdMs: 3000, checkoutMs: 2500, challengeMs: 1200,
      pQueueCheck: 0.25, pPaymentCheck: 0.3, pDecline: 0.05,
    });
    await server.refreshEvents();

    const qty = 1 + Math.floor(rng() * ev.limit);
    const prices = ev.tiers.map(x => x.price);
    const maxPerTicket = pick(prices) + Math.round(between(0, 8));
    const tierRule = rng() < 0.6 ? 'any' : 'selected';
    const eligible = ev.tiers.filter(x => x.price <= maxPerTicket);
    const body = {
      sellerId: 'test-seller', eventId: ev.id, qty, maxPerTicket,
      totalCap: rng() < 0.7 ? qty * maxPerTicket : Math.round(qty * maxPerTicket * between(0.75, 1)),
      tierRule, selectedTier: tierRule === 'selected' ? pick(eligible).name : null,
    };
    const preview = await api('POST', '/api/authorisation/preview', body);
    if (!preview.ok) return { i, skipped: preview.errors };
    const watch = await api('POST', '/api/watches', { ...body, authorise: true, textHash: preview.textHash });

    const instr = (await fetch(`${serverUrl}/api/companion/instructions`, { headers: { 'x-companion-token': token } }).then(r => r.json()))
      .find(x => x.payload.watchId === watch.id);
    // Release in 1.5 s with the waiting room already open: room for the customer to finish an identity
    // check before the sale, as the real 15–30 minute waiting room allows.
    ev.saleStart = Date.now() + 1500;
    const done = { value: false };
    const cust = customerLoop(watch.id, done);
    // Two devices try to run the same instruction at once; the lock must let exactly one through.
    const [a, b] = await Promise.all([companion.runAttempt(instr), rival.runAttempt(instr)]);
    done.value = true;
    await cust;
    const result = a.outcome === 'not_claimed' ? b : a;
    const claims = [a, b].filter(r => r.outcome !== 'not_claimed').length;
    const final = await api('GET', `/api/watches/${watch.id}`);
    log(`run ${i}: ${result.outcome}${result.reason ? ' — ' + result.reason : ''}`);
    return { i, watch: final, event: ev, terms: final.terms, outcome: result.outcome, reason: result.reason, claims };
  }

  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < runs) results.push(await oneRun(next++));
  }));

  // ---- invariants, checked against the seller's records ----
  const done = results.filter(r => !r.skipped);
  const { checkoutCalls, orders } = { checkoutCalls: seller.stats.checkoutCalls, orders: seller.orders };
  const violations = [];
  for (const r of done) {
    const evOrders = orders.filter(o => o.eventId === r.event.id);
    const calls = checkoutCalls.filter(c => c.eventId === r.event.id);
    const t = r.terms;
    if (r.claims !== 1) violations.push(`run ${r.i}: ${r.claims} devices took the attempt lock`);
    if (calls.length > 1) violations.push(`run ${r.i}: ${calls.length} checkout submissions`);
    if (evOrders.length > 1) violations.push(`run ${r.i}: ${evOrders.length} orders`);
    for (const o of evOrders) {
      if (o.qty !== t.qty) violations.push(`run ${r.i}: bought ${o.qty}, authorised ${t.qty}`);
      if (o.qty > r.event.limit) violations.push(`run ${r.i}: over seller limit`);
      if (o.unitPrice > t.maxPerTicket) violations.push(`run ${r.i}: unit price over max`);
      if (o.total > t.totalCap) violations.push(`run ${r.i}: total over cap`);
      if (t.tierRule === 'selected' && o.tier !== t.selectedTier) violations.push(`run ${r.i}: wrong tier`);
    }
    const reportedSecured = r.watch.status === 'secured';
    if (reportedSecured !== (evOrders.length === 1)) violations.push(`run ${r.i}: Dropwatch status ${r.watch.status} but seller has ${evOrders.length} order(s)`);
    if (r.watch.attempt == null) violations.push(`run ${r.i}: no attempt recorded`);
  }

  const byClass = {};
  for (const r of done) {
    const c = classify(r.outcome, r.reason);
    byClass[c] = (byClass[c] ?? 0) + 1;
  }
  const secured = byClass.secured ?? 0;
  const workflowErrors = done.filter(r => classify(r.outcome, r.reason) === 'workflow error');
  // Attempts where the workflow itself decided the result: everything except sell-outs, customer
  // no-shows and payment declines, which no workflow can change.
  const workflowDecided = secured + workflowErrors.length;

  // Queue place per run, read from the release log: a place beyond the crowd means the Companion
  // reached the waiting room after the sale opened, which is a workflow problem, not bad luck.
  const runsDetail = done.map(r => {
    const place = r.watch.log.map(l => l.msg.match(/place (\d+) in the queue/)).find(Boolean);
    return {
      run: r.i, outcome: r.outcome, class: classify(r.outcome, r.reason), reason: r.reason ?? null,
      place: place ? Number(place[1]) : null, crowd: r.event.crowd,
    };
  });
  const lateJoins = runsDetail.filter(d => d.place != null && d.place > d.crowd).length;

  await server.stop();
  await seller.stop();
  rmSync(dataDir, { recursive: true, force: true });

  return {
    seed, runs: done.length, skipped: results.length - done.length,
    outcomes: byClass,
    securedRate: secured / done.length,
    workflowReliability: workflowDecided ? secured / workflowDecided : 1,
    workflowErrors: workflowErrors.map(r => ({ run: r.i, reason: r.reason })),
    checkoutSubmissions: checkoutCalls.length,
    ordersPlaced: orders.length,
    lateJoins,
    violations,
    runsDetail,
  };
}
