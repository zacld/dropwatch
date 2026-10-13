// A local, Ticketmaster-style test seller. It exists so the full authorised-checkout workflow can be
// proven under realistic release conditions without touching a real ticketing site:
//   - a waiting room that opens before the sale, random queue positions for everyone already waiting,
//     the back of the line for late joiners and for anyone who switches session
//   - an identity check some customers must complete in person before they get a place
//   - crowd demand that sells tiers out in price order while the customer waits
//   - a hold timer once it is the customer's turn and a checkout timer on the basket
//   - per-customer ticket limits, payment verification and payment declines
// It is a JSON API (the "pages") plus small HTML pages for the customer-only steps.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { router, send, httpError, listen } from '../shared/http.js';
import { DEFAULT_EVENTS, TEST_ACCOUNT } from './seed.js';

const SCENARIO_DEFAULTS = {
  waitingRoomLeadMs: 60_000, // waiting room opens this long before the sale
  crowd: 400,                // fans already in the waiting room at sale start
  admitPerSec: 40,           // fans admitted from the queue per second
  fanAvgQty: 2,              // tickets each admitted fan buys
  holdMs: 120_000,           // how long your turn is held once you are admitted
  checkoutMs: 90_000,        // basket timer
  challengeMs: 300_000,      // how long a verification stays open (like a bank approval window)
  pQueueCheck: 0.25,         // chance of an identity check before a place in the queue
  pPaymentCheck: 0.3,        // chance the payment needs customer verification
  pDecline: 0.05,            // chance the payment is declined
};

export function createTestSeller({ rng = Math.random, events = DEFAULT_EVENTS(), now = () => Date.now() } = {}) {
  const accounts = new Map();   // id → { id, email, password, card }
  const sessions = new Map();   // token → accountId
  const evs = new Map();        // id → event + runtime
  const tickets = new Map();    // queue tickets
  const access = new Map();     // access token → ticket id
  const baskets = new Map();
  const orders = [];
  const challenges = new Map();
  const stats = { checkoutCalls: [], basketCalls: [] };

  const addAccount = ({ email, password }) => {
    const acc = { id: randomUUID(), email, password, card: { brand: 'Visa', last4: '4242' } };
    accounts.set(acc.id, acc);
    return acc;
  };
  addAccount(TEST_ACCOUNT);

  function upsertEvent(spec) {
    const ev = {
      ...SCENARIO_DEFAULTS,
      ...spec,
      tiers: spec.tiers.map(t => ({ ...t, taken: 0 })), // taken = held or sold to real accounts
      lateJoins: 0,
    };
    evs.set(ev.id, ev);
    return ev;
  }
  events.forEach(upsertEvent);

  // ---- demand model ----
  const admittedFans = (ev, t) =>
    t < ev.saleStart ? 0 : Math.min(ev.crowd * 1.5, ((t - ev.saleStart) / 1000) * ev.admitPerSec);

  // Remaining stock per tier at time t: the crowd buys the cheapest tier with stock left first.
  function remaining(ev, t = now()) {
    let crowdDemand = Math.floor(admittedFans(ev, t) * ev.fanAvgQty);
    return ev.tiers.map(tier => {
      const free = Math.max(0, tier.stock - tier.taken);
      const crowdTakes = Math.min(free, crowdDemand);
      crowdDemand -= crowdTakes;
      return free - crowdTakes;
    });
  }

  // ---- helpers ----
  const auth = req => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const accountId = sessions.get(token);
    if (!accountId) throw httpError(401, 'signed_out', 'Sign in to your account.');
    return { account: accounts.get(accountId), token };
  };
  const getEvent = id => {
    const ev = evs.get(id);
    if (!ev) throw httpError(404, 'no_event', 'Event not found.');
    return ev;
  };
  const challengeUrl = (base, id) => `${base}/challenge/${id}`;

  function newChallenge(kind, accountId, ttl) {
    const c = { id: randomUUID(), kind, accountId, ttl, state: 'pending', createdAt: now() };
    challenges.set(c.id, c);
    return c;
  }
  function challengeState(c, ttl = c.ttl) {
    if (c.state === 'pending' && now() - c.createdAt > ttl) c.state = 'expired';
    return c.state;
  }

  function soldTo(accountId, eventId) {
    const sold = orders.filter(o => o.accountId === accountId && o.eventId === eventId).reduce((s, o) => s + o.qty, 0);
    const held = [...baskets.values()]
      .filter(b => b.accountId === accountId && b.eventId === eventId && ['held', 'payment_check'].includes(b.state))
      .reduce((s, b) => s + b.qty, 0);
    return sold + held;
  }

  function releaseBasket(b, state) {
    b.state = state;
    const tier = evs.get(b.eventId).tiers.find(t => t.name === b.tier);
    tier.taken -= b.qty;
  }

  function finalisePayment(b) {
    if (rng() < evs.get(b.eventId).pDecline) {
      releaseBasket(b, 'declined');
      return;
    }
    b.state = 'confirmed';
    const order = {
      ref: 'TS-' + Math.floor(100000 + rng() * 899999), accountId: b.accountId, eventId: b.eventId,
      tier: b.tier, qty: b.qty, unitPrice: b.unitPrice, total: b.total, at: now(),
    };
    orders.push(order);
    b.orderRef = order.ref;
  }

  function basketView(b) {
    const ev = evs.get(b.eventId);
    if (b.state === 'held' && now() > b.expiresAt) releaseBasket(b, 'expired');
    if (b.state === 'payment_check') {
      const c = challenges.get(b.challengeId);
      const s = challengeState(c, ev.challengeMs);
      if (s === 'approved') finalisePayment(b);
      else if (s === 'rejected' || s === 'expired') releaseBasket(b, 'declined');
    }
    return {
      id: b.id, state: b.state, tier: b.tier, qty: b.qty, unitPrice: b.unitPrice, total: b.total,
      expiresAt: b.expiresAt, orderRef: b.orderRef ?? null,
      challenge: b.state === 'payment_check' ? { id: b.challengeId, kind: 'payment' } : null,
    };
  }

  // ---- queue ----
  function ticketView(tk, base) {
    const ev = evs.get(tk.eventId);
    const t = now();
    if (tk.challengeId) {
      const c = challenges.get(tk.challengeId);
      const s = challengeState(c, ev.challengeMs);
      if (s === 'pending') return { state: 'verification', challenge: { id: c.id, kind: c.kind, url: challengeUrl(base, c.id) } };
      if (s !== 'approved') return { state: 'blocked', reason: 'Security check was not completed.' };
      tk.challengeId = null;
      tk.readyAt = t;
    }
    if (t < ev.saleStart) return { state: 'waiting_room', saleStart: ev.saleStart };
    if (tk.position == null) {
      // In the room before the sale: random place among the crowd. Later: the back of the line.
      tk.position = tk.readyAt <= ev.saleStart
        ? 1 + Math.floor(rng() * ev.crowd)
        : Math.ceil(admittedFans(ev, t)) + ev.crowd + ++ev.lateJoins;
      tk.turnAt = ev.saleStart + (tk.position / ev.admitPerSec) * 1000;
    }
    if (t < tk.turnAt) {
      return { state: 'queue', position: tk.position, ahead: Math.max(0, Math.ceil(tk.position - admittedFans(ev, t))) };
    }
    if (!tk.accessToken) {
      tk.accessToken = randomUUID();
      tk.holdExpiresAt = t + ev.holdMs;
      access.set(tk.accessToken, tk.id);
    }
    if (t > tk.holdExpiresAt) return { state: 'expired', reason: 'Your turn expired.' };
    return { state: 'your_turn', accessToken: tk.accessToken, holdExpiresAt: tk.holdExpiresAt };
  }

  function checkAccess(token, accountId, eventId) {
    const tk = tickets.get(access.get(token));
    if (!tk || tk.accountId !== accountId || tk.eventId !== eventId) throw httpError(403, 'no_access', 'Join the queue first.');
    if (now() > tk.holdExpiresAt) throw httpError(410, 'turn_expired', 'Your turn expired.');
    return tk;
  }

  // ---- routes ----
  let base = '';
  const handle = router([
    ['POST', '/api/login', ({ body }) => {
      const acc = [...accounts.values()].find(a => a.email === body.email && a.password === body.password);
      if (!acc) throw httpError(401, 'bad_credentials', 'Email or password is wrong.');
      const token = randomUUID();
      sessions.set(token, acc.id);
      return { token };
    }],
    ['GET', '/api/me', ({ req }) => {
      const { account } = auth(req);
      return { signedIn: true, email: account.email, savedCard: account.card };
    }],
    ['GET', '/api/catalogue', () => [...evs.values()].map(ev => ({
      id: ev.id, name: ev.name, venue: ev.venue, startsAt: ev.startsAt, saleStart: ev.saleStart,
      waitingRoomLeadMs: ev.waitingRoomLeadMs, limit: ev.limit, tiers: ev.tiers.map(t => ({ name: t.name, price: t.price })),
    }))],
    ['GET', '/api/events/:id', ({ params }) => {
      const ev = getEvent(params.id);
      return { id: ev.id, name: ev.name, venue: ev.venue, saleStart: ev.saleStart, limit: ev.limit, onSale: now() >= ev.saleStart };
    }],
    ['POST', '/api/events/:id/queue', ({ req, params }) => {
      const { account, token } = auth(req);
      const ev = getEvent(params.id);
      const opensAt = ev.saleStart - ev.waitingRoomLeadMs;
      if (now() < opensAt) throw httpError(409, 'waiting_room_closed', `The waiting room opens at ${new Date(opensAt).toISOString()}.`);
      // One device, one session: the same session keeps its ticket; a new session starts again.
      let tk = [...tickets.values()].find(x => x.eventId === ev.id && x.session === token);
      if (!tk) {
        tk = { id: randomUUID(), eventId: ev.id, accountId: account.id, session: token, readyAt: now(), position: null };
        if (rng() < ev.pQueueCheck) tk.challengeId = newChallenge('identity', account.id, ev.challengeMs).id;
        tickets.set(tk.id, tk);
      }
      return { ticket: tk.id, ...ticketView(tk, base) };
    }],
    ['GET', '/api/queue/:ticket', ({ req, params }) => {
      const { token } = auth(req);
      const tk = tickets.get(params.ticket);
      if (!tk || tk.session !== token) throw httpError(404, 'no_ticket', 'Queue ticket not found for this session.');
      return ticketView(tk, base);
    }],
    ['GET', '/api/events/:id/tiers', ({ req, params, query }) => {
      const { account } = auth(req);
      const ev = getEvent(params.id);
      checkAccess(query.get('access'), account.id, ev.id);
      const left = remaining(ev);
      return ev.tiers.map((t, i) => ({ name: t.name, price: t.price, available: left[i] > 0 }));
    }],
    ['POST', '/api/events/:id/basket', ({ req, params, body }) => {
      const { account } = auth(req);
      const ev = getEvent(params.id);
      checkAccess(body.access, account.id, ev.id);
      stats.basketCalls.push({ accountId: account.id, eventId: ev.id, at: now() });
      const i = ev.tiers.findIndex(t => t.name === body.tier);
      const qty = Number(body.qty);
      if (i < 0) throw httpError(404, 'no_tier', 'Tier not found.');
      if (!Number.isInteger(qty) || qty < 1) throw httpError(400, 'bad_qty', 'Choose a quantity.');
      if (soldTo(account.id, ev.id) + qty > ev.limit) throw httpError(409, 'limit', `The limit is ${ev.limit} per customer.`);
      if (remaining(ev)[i] < qty) throw httpError(409, 'not_enough', `Not enough ${ev.tiers[i].name} tickets left.`);
      const tier = ev.tiers[i];
      tier.taken += qty;
      const b = {
        id: randomUUID(), accountId: account.id, eventId: ev.id, tier: tier.name, qty,
        unitPrice: tier.price, total: tier.price * qty, state: 'held', expiresAt: now() + ev.checkoutMs,
      };
      baskets.set(b.id, b);
      return basketView(b);
    }],
    ['POST', '/api/baskets/:id/checkout', ({ req, params }) => {
      const { account } = auth(req);
      const b = baskets.get(params.id);
      if (!b || b.accountId !== account.id) throw httpError(404, 'no_basket', 'Basket not found.');
      stats.checkoutCalls.push({ basketId: b.id, accountId: account.id, eventId: b.eventId, at: now() });
      basketView(b); // applies expiry
      if (b.state === 'expired') throw httpError(410, 'basket_expired', 'Your basket expired.');
      if (b.state !== 'held') throw httpError(409, 'already_submitted', 'This basket has already been submitted.');
      if (rng() < evs.get(b.eventId).pPaymentCheck) {
        b.state = 'payment_check';
        b.challengeId = newChallenge('payment', account.id, evs.get(b.eventId).challengeMs).id;
      } else finalisePayment(b);
      const view = basketView(b);
      if (view.challenge) view.challenge.url = challengeUrl(base, view.challenge.id);
      return view;
    }],
    ['GET', '/api/baskets/:id', ({ req, params }) => {
      const { account } = auth(req);
      const b = baskets.get(params.id);
      if (!b || b.accountId !== account.id) throw httpError(404, 'no_basket', 'Basket not found.');
      const view = basketView(b);
      if (view.challenge) view.challenge.url = challengeUrl(base, view.challenge.id);
      return view;
    }],
    ['GET', '/api/orders', ({ req }) => {
      const { account } = auth(req);
      return orders.filter(o => o.accountId === account.id);
    }],
    ['GET', '/api/challenges/:id', ({ params }) => {
      const c = challenges.get(params.id);
      if (!c) throw httpError(404, 'no_challenge', 'Not found.');
      return { id: c.id, kind: c.kind, state: challengeState(c) };
    }],
    // Only the customer completes a check. The Companion never calls this; tests call it as the customer.
    ['POST', '/api/challenges/:id', ({ params, body }) => {
      const c = challenges.get(params.id);
      if (!c) throw httpError(404, 'no_challenge', 'Not found.');
      // An expired check can no longer be completed.
      if (challengeState(c) === 'pending') c.state = body.action === 'approve' ? 'approved' : 'rejected';
      return { id: c.id, state: c.state };
    }],
    ['GET', '/challenge/:id', ({ res, params }) => {
      const c = challenges.get(params.id);
      send(res, c ? 200 : 404, challengePage(c), 'text/html');
    }],

    // ---- test controls (not part of a real seller) ----
    ['POST', '/api/admin/events', ({ body }) => {
      const ev = upsertEvent(body);
      return { id: ev.id };
    }],
    ['POST', '/api/admin/events/:id/release-in', ({ params, body }) => {
      const ev = getEvent(params.id);
      ev.saleStart = now() + Number(body.ms ?? 60_000);
      ev.tiers.forEach(t => (t.taken = 0));
      return { id: ev.id, saleStart: ev.saleStart };
    }],
    ['GET', '/api/admin/stats', () => ({ checkoutCalls: stats.checkoutCalls, basketCalls: stats.basketCalls, orders })],
    ['GET', '/admin', ({ res }) => send(res, 200, adminPage([...evs.values()], now()), 'text/html')],
  ]);

  const server = http.createServer(handle);
  return {
    server,
    async start(port = 0) {
      base = await listen(server, port);
      return base;
    },
    stop: () => new Promise(r => server.close(r)),
    upsertEvent,
    stats,
    orders,
  };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function challengePage(c) {
  if (!c) return '<p>Check not found.</p>';
  const what = c.kind === 'identity'
    ? 'Take a selfie to confirm you are the account holder before joining the queue.'
    : 'Approve this payment in your banking app.';
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Security check · Test Seller</title>
<style>body{font:15px system-ui;margin:0;padding:32px 16px;background:#f4f4f6;color:#1d1d24}main{max-width:420px;margin:auto;background:#fff;border-radius:12px;padding:24px;border:1px solid #ddd}button{font:inherit;padding:10px 16px;border-radius:8px;border:0;margin-right:8px;cursor:pointer}.ok{background:#0b62d6;color:#fff}.no{background:#e9e9ee}</style>
<main><p style="font-size:12px;color:#666">TEST SELLER · not a real ticketing site</p><h1 style="font-size:20px">${c.kind === 'identity' ? 'Security check' : 'Payment verification'}</h1>
<p>${what}</p><p id="s">Status: <b>${esc(c.state)}</b></p>
<button class="ok" onclick="go('approve')">I've completed it</button><button class="no" onclick="go('reject')">Cancel</button></main>
<script>async function go(a){const r=await fetch('/api/challenges/${c.id}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:a})});const j=await r.json();document.getElementById('s').innerHTML='Status: <b>'+j.state+'</b>'}</script>`;
}

function adminPage(events, t) {
  const rows = events.map(ev => `<tr><td>${esc(ev.name)}</td><td>${new Date(ev.saleStart).toLocaleString('en-GB')}</td><td>${ev.saleStart > t ? Math.round((ev.saleStart - t) / 1000) + 's' : 'on sale'}</td>
<td><button onclick="rel('${ev.id}',90000)">Release in 90s</button> <button onclick="rel('${ev.id}',180000)">in 3 min</button></td></tr>`).join('');
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test Seller admin</title>
<style>body{font:14px system-ui;padding:24px 16px}table{border-collapse:collapse}td,th{padding:6px 10px;border-bottom:1px solid #ddd;text-align:left}</style>
<h1 style="font-size:18px">Test Seller · release controls</h1><p>Move an event's release so you can watch a Dropwatch attempt. The waiting room opens 60 seconds before release.</p>
<table><tr><th>Event</th><th>Release</th><th>In</th><th></th></tr>${rows}</table>
<script>async function rel(id,ms){await fetch('/api/admin/events/'+id+'/release-in',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ms})});location.reload()}</script>`;
}
