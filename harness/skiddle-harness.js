// Runs the real Companion + Skiddle plug-in (driving Chrome) against the local Skiddle copy, end to end
// through the Dropwatch server, and checks every rule against the copy's own records.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createSkiddleSim, sampleEvent, SIM_ACCOUNT } from '../sellers/skiddle-sim/server.js';
import { createDropwatchServer } from '../server/app.js';
import { defaultSellers } from '../server/sellers.js';
import { Companion } from '../companion/companion.js';
import { skiddleAdapter } from '../companion/adapters/skiddle.js';
import { mulberry32, classify } from './harness.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function runSkiddleHarness({
  runs = 12, concurrency = 3, seed = 7, headless = true, slowMo = 0, routes = ['paypal', 'credit', 'card'],
  customer = { approveRate: 0.9, delayMs: [400, 2000] }, log = () => {},
  scenario = {},
} = {}) {
  const rng = mulberry32(seed);
  const between = (a, b) => a + rng() * (b - a);
  const dataDir = mkdtempSync(join(tmpdir(), 'dropwatch-skiddle-'));
  const sim = createSkiddleSim({ rng: mulberry32(seed + 1) });
  const simUrl = await sim.start();
  const server = createDropwatchServer({ dataDir, sellers: defaultSellers('http://127.0.0.1:1', simUrl), companionToken: 't', log: () => {} });
  const serverUrl = await server.start();
  const { publicKey } = await (await fetch(`${serverUrl}/api/companion/key`)).json();
  const browser = await chromium.launch({ channel: 'chrome', headless, slowMo });

  const api = async (method, path, body) => {
    const res = await fetch(serverUrl + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    return data;
  };

  // The customer: completes card entry or PayPal confirmation on their phone, most of the time.
  async function customerLoop(watchId, done) {
    const seen = new Set();
    while (!done.value) {
      const w = await api('GET', `/api/watches/${watchId}`);
      if (w.status === 'needs_customer' && w.prompt?.url && !seen.has(w.prompt.url)) {
        seen.add(w.prompt.url);
        await sleep(between(...customer.delayMs));
        await fetch(w.prompt.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: rng() < customer.approveRate ? 'approve' : 'reject' }) });
      }
      await sleep(200);
    }
  }

  async function oneRun(i) {
    const route = routes[i % routes.length];
    // Each run is a different customer with their own browser session.
    const email = `fan${i}@dropwatch.test`;
    sim.accounts.set(email, { id: `acc-${i}`, email, password: SIM_ACCOUNT.password, name: `Fan ${i}`, paypalAgreement: route === 'paypal', credit: route === 'credit' ? 100 : 0 });
    const id = String(700000 + i);
    const ev = sim.upsertEvent(sampleEvent(id, Date.now() + 10 * 60_000, {
      waitingRoomLeadMs: 4000, crowd: Math.round(between(40, 160)), admitPerSec: between(20, 60), holdMs: 60_000,
      checkoutMs: 45_000, handoffMs: 30_000, pPayPalCheck: 0.15, pDecline: 0.03, ...scenario,
    }));
    await server.refreshEvents();
    const body = { sellerId: 'skiddle', eventId: id, qty: 2, maxPerTicket: 18, totalCap: 36, tierRule: 'any' };
    const preview = await api('POST', '/api/authorisation/preview', body);
    const watch = await api('POST', '/api/watches', { ...body, authorise: true, textHash: preview.textHash });
    const instr = (await fetch(`${serverUrl}/api/companion/instructions`, { headers: { 'x-companion-token': 't' } }).then(r => r.json()))
      .find(x => x.payload.watchId === watch.id);

    const session = { email, password: SIM_ACCOUNT.password, payment: route, refundProtection: false };
    const adapter = skiddleAdapter({ baseUrl: simUrl, pollMs: 500, browser });
    const companion = new Companion({
      serverUrl, token: 't', deviceId: `cloud-buyer-${i}`, publicKey,
      adapters: { skiddle: adapter }, sessions: { skiddle: session }, customerWaitMs: 40_000, challengePollMs: 300, log: () => {},
    });
    // Release 5 s from now, waiting room already open: the buyer joins it as a customer would.
    ev.saleStart = Date.now() + 5000;
    const done = { value: false };
    const cust = customerLoop(watch.id, done);
    const started = Date.now();
    const result = await companion.runAttempt(instr);
    done.value = true;
    await cust;
    await adapter.close(session);
    const final = await api('GET', `/api/watches/${watch.id}`);
    log(`run ${i} [${route}]: ${result.outcome}${result.reason ? ' — ' + result.reason : ''} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return { i, route, event: ev, watch: final, outcome: result.outcome, reason: result.reason, seconds: (Date.now() - started) / 1000, email };
  }

  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => { while (next < runs) results.push(await oneRun(next++)); }));

  // ---- rules, checked against the Skiddle copy's own records ----
  const violations = [];
  for (const r of results) {
    const t = r.watch.terms;
    const subs = sim.stats.checkoutSubmissions.filter(s => String(s.eventId) === String(r.event.id));
    const evOrders = sim.orders.filter(o => String(o.eventId) === String(r.event.id));
    if (subs.length > 1) violations.push(`run ${r.i}: ${subs.length} checkout submissions`);
    if (evOrders.length > 1) violations.push(`run ${r.i}: ${evOrders.length} orders`);
    for (const o of evOrders) {
      const qty = o.lines.reduce((a, l) => a + l.qty, 0);
      if (qty !== t.qty) violations.push(`run ${r.i}: bought ${qty}, authorised ${t.qty}`);
      if (o.lines.some(l => l.allIn > t.maxPerTicket)) violations.push(`run ${r.i}: price over max`);
      if (o.total > t.totalCap) violations.push(`run ${r.i}: total over cap`);
      if (o.lines.some(l => l.family !== 'General Admission')) violations.push(`run ${r.i}: bought outside General Admission (${o.lines.map(l => l.name)})`);
      if (o.extras?.refundProtection || o.extras?.donation || o.extras?.sms) violations.push(`run ${r.i}: paid extras added`);
    }
    if ((r.watch.status === 'secured') !== (evOrders.length === 1)) violations.push(`run ${r.i}: status ${r.watch.status} but ${evOrders.length} order(s)`);
  }
  const byClass = {}, byRoute = {};
  for (const r of results) {
    const c = classify(r.outcome, r.reason);
    byClass[c] = (byClass[c] ?? 0) + 1;
    byRoute[r.route] ??= { runs: 0, secured: 0, handoffs: 0 };
    byRoute[r.route].runs++;
    if (r.outcome === 'secured') byRoute[r.route].secured++;
    if (r.watch.log.some(l => /Paused:/.test(l.msg))) byRoute[r.route].handoffs++;
  }

  await browser.close();
  await server.stop();
  await sim.stop();
  rmSync(dataDir, { recursive: true, force: true });
  return {
    runs: results.length, outcomes: byClass, byRoute,
    workflowErrors: results.filter(r => classify(r.outcome, r.reason) === 'workflow error').map(r => ({ run: r.i, route: r.route, reason: r.reason })),
    medianSeconds: results.map(r => r.seconds).sort((a, b) => a - b)[Math.floor(results.length / 2)],
    violations, detail: results.map(r => ({ run: r.i, route: r.route, outcome: r.outcome, reason: r.reason ?? null, log: r.watch.log.map(l => `${l.step} ${l.msg}`) })),
  };
}
