// A local copy of Skiddle's buying flow, built from what was observed on skiddle.com on 5 Oct 2026:
//   event page   – structured data (schema.org offers) + a ticket form posting to /whatson/tickets_check.php,
//                  one row per ticket type (li#ticket-<id>, select name="tickets[]" value ticket_<id>_<qty>),
//                  face value "+bf" and an all-in price, sold-out rows without a select
//   queue        – waiting room before the sale, random places for everyone already waiting, back of the
//                  line for late joiners, place kept by the same browser session
//   checkout     – /basket/default.php: contact details, payment (card / PayPal), complete your order
//                  (required refund-protection choice, opt-in extras, terms), "Time remaining" countdown
//   payment      – card: entered by the customer (handoff); PayPal: billing agreement, may ask for a check;
//                  Skiddle credit: applied with a tick box when it covers the order
//   confirmation – /basket/complete.php with an order reference; /account/orders
// It is not Skiddle and never contacts Skiddle. Test values only.

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const money = n => '£' + n.toFixed(2);
const r2 = n => Math.round(n * 100) / 100;

export const SIM_ACCOUNT = { email: 'fan@dropwatch.test', password: 'local-skiddle-sim-only', name: 'Test Fan' };

const DEFAULTS = {
  limit: 8, bookingFeeRate: 0.14, queue: true, waitingRoomLeadMs: 30 * 60_000,
  crowd: 400, admitPerSec: 4, fanAvgQty: 2, holdMs: 10 * 60_000, checkoutMs: 8 * 60_000,
  handoffMs: 7 * 60_000, pPayPalCheck: 0.1, pDecline: 0.03, refundProtection: 1.65,
};

export function sampleEvent(id, saleStart, overrides = {}) {
  return {
    id, name: 'Kill the Wheel Festival (sim)', venue: 'Antwerp Mansion', city: 'Manchester', date: '2026-11-06T19:00:00Z',
    saleStart, ...overrides,
    tickets: overrides.tickets ?? [
      { id: 900101, name: 'First Release', family: 'General Admission', face: 10, stock: 150 },
      { id: 900102, name: 'Second Release', family: 'General Admission', face: 12.5, stock: 200 },
      { id: 900103, name: 'Third Release', family: 'General Admission', face: 15, stock: 250 },
      { id: 900104, name: 'Final Release', family: 'General Admission', face: 18, stock: 400 },
      { id: 900105, name: 'Pre-8pm entry', family: 'Entry time', face: 8, stock: 100 },
      { id: 900106, name: '4 for 3 First Release', family: 'Bundle', face: 7.5, stock: 100, onlyQty: 4 },
      { id: 900107, name: 'VIP', family: 'VIP', face: 35, stock: 50 },
    ],
  };
}

export function createSkiddleSim({ rng = Math.random, now = () => Date.now(), events = [] } = {}) {
  const accounts = new Map();
  const sessions = new Map();     // sid → { accountId, queue: {eventId: ticket}, admitted: {eventId: until}, basket }
  const evs = new Map();
  const orders = [];
  const handoffs = new Map();
  const stats = { checkoutSubmissions: [], basketCreations: [] };

  const addAccount = a => {
    const acc = { id: randomUUID(), paypalAgreement: true, credit: 0, ...a };
    accounts.set(acc.email, acc);
    return acc;
  };
  addAccount({ ...SIM_ACCOUNT });

  function upsertEvent(spec) {
    const ev = { ...DEFAULTS, ...spec, lateJoins: 0 };
    ev.tickets = spec.tickets.map(t => ({ taken: 0, ...t, allIn: r2(t.face * (1 + ev.bookingFeeRate)) }));
    evs.set(String(ev.id), ev);
    return ev;
  }
  events.forEach(upsertEvent);

  // ---- demand: the crowd buys the cheapest General Admission release with stock left ----
  const admitted = (ev, t) => (t < ev.saleStart ? 0 : Math.min(ev.crowd * 1.5, ((t - ev.saleStart) / 1000) * ev.admitPerSec));
  function remaining(ev, t = now()) {
    let crowd = Math.floor(admitted(ev, t) * ev.fanAvgQty);
    return ev.tickets.map(tk => {
      const free = Math.max(0, tk.stock - tk.taken);
      if (tk.family !== 'General Admission') return free;
      const take = Math.min(free, crowd);
      crowd -= take;
      return free - take;
    });
  }

  // ---- sessions (cookie) ----
  function session(req, res) {
    const m = /(?:^|;\s*)sk_session=([^;]+)/.exec(req.headers.cookie ?? '');
    let sid = m?.[1];
    if (!sid || !sessions.has(sid)) {
      sid = randomUUID();
      sessions.set(sid, { accountId: null, queue: {}, admitted: {}, basket: null });
      res.setHeader('set-cookie', `sk_session=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    }
    return { sid, s: sessions.get(sid) };
  }
  const accountOf = s => [...accounts.values()].find(a => a.id === s.accountId) ?? null;

  // ---- html ----
  const page = (s, title, body) => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font:15px system-ui;margin:0;background:#f5f6f8;color:#1b1b1f}header{background:#0d0d14;color:#fff;padding:12px 16px;display:flex;justify-content:space-between}
header a{color:#7fe0d6}main{max-width:820px;margin:0 auto;padding:16px}.box{background:#fff;border:1px solid #ddd;border-radius:10px;padding:16px;margin-bottom:14px}
li{list-style:none;border-bottom:1px solid #eee;padding:10px 0;display:flex;justify-content:space-between;gap:10px;align-items:center}ul{padding:0;margin:0}
.soldout{color:#999;font-weight:700}.bookingfee{color:#666;font-size:13px;margin:0}.err{color:#b00020;font-weight:700}button{font:inherit;padding:10px 16px;border-radius:8px;border:0;background:#3cb8b0;color:#fff;font-weight:700;cursor:pointer}
.sim{font-size:12px;color:#888}</style></head><body><header><b>Skiddle (local copy)</b><span>${
      accountOf(s) ? `<a href="/account/" id="account-link">Hi, ${esc(accountOf(s).name.split(' ')[0])}</a> · <a href="/logout">Log out</a>` : '<a href="/login" id="login-link">Log in</a>'
    }</span></header><main><p class="sim">Local test copy for Dropwatch development. Not skiddle.com.</p>${body}</main></body></html>`;

  function eventPage(ev, s, t) {
    const left = remaining(ev, t);
    const onSale = t >= ev.saleStart;
    const ld = {
      '@context': 'https://schema.org', '@type': 'MusicEvent', name: ev.name, startDate: ev.date,
      location: { '@type': 'Place', name: ev.venue, address: ev.city },
      offers: ev.tickets.map((tk, i) => ({
        '@type': 'Offer', name: tk.name, price: tk.face.toFixed(2), priceCurrency: 'GBP',
        availability: !onSale ? 'PreOrder' : left[i] > 0 ? 'InStock' : 'SoldOut', validFrom: new Date(ev.saleStart).toISOString(),
      })),
    };
    const rows = ev.tickets.map((tk, i) => {
      const max = Math.min(ev.limit, left[i]);
      const control = !onSale ? '<span class="soon">Not on sale yet</span>'
        : left[i] <= 0 ? '<span class="soldout">SOLD OUT</span>'
        : `<select name="tickets[]" id="ticket_${tk.id}_select">${(tk.onlyQty ? [0, tk.onlyQty] : [...Array(max + 1).keys()]).filter(q => q <= max).map(q => `<option value="ticket_${tk.id}_${q}">${q}</option>`).join('')}</select>`;
      return `<li id="ticket-${tk.id}"><div><span class="ticket-name">${esc(tk.name)}</span><p class="bookingfee">${money(tk.face)} +bf</p></div><div><span class="allin">${money(tk.allIn)}</span> ${control}</div></li>`;
    }).join('');
    return page(s, `Tickets: ${ev.name}`, `<script type="application/ld+json">${JSON.stringify(ld)}</script>
<div class="box"><h1>${esc(ev.name)}</h1><p>${esc(ev.venue)}, ${esc(ev.city)} · ${new Date(ev.date).toUTCString()}</p>
${onSale ? '' : `<p id="onsale" data-sale-start="${ev.saleStart}">Tickets on sale ${new Date(ev.saleStart).toISOString()}</p>`}</div>
<div class="box" id="tickets"><form id="${randomUUID()}-ticket-form" action="/whatson/tickets_check.php" method="post"><input type="hidden" name="eventcode" value="${ev.id}">
<ul>${rows}</ul><p>Limit ${ev.limit} per customer.</p><button type="submit" id="pay-button">£0.00 - Pay</button></form></div>`);
  }

  function queueView(ev, s, t) {
    let tk = s.queue[ev.id];
    if (!tk) tk = s.queue[ev.id] = { joinedAt: t, position: null };
    if (t < ev.saleStart) return { state: 'waiting' };
    if (tk.position == null) {
      tk.position = tk.joinedAt <= ev.saleStart ? 1 + Math.floor(rng() * ev.crowd) : Math.ceil(admitted(ev, t)) + ev.crowd + ++ev.lateJoins;
      tk.turnAt = ev.saleStart + (tk.position / ev.admitPerSec) * 1000;
    }
    if (t < tk.turnAt) {
      const ahead = Math.max(0, Math.ceil(tk.position - admitted(ev, t)));
      const total = ev.tickets.filter(x => x.family === 'General Admission').reduce((a, x) => a + x.stock, 0);
      const ga = remaining(ev, t).filter((_, i) => ev.tickets[i].family === 'General Admission').reduce((a, b) => a + b, 0);
      return { state: 'queue', ahead, wait: Math.ceil(ahead / ev.admitPerSec / 60), left: Math.round((100 * ga) / total) };
    }
    if (s.admitted[ev.id] && t > s.admitted[ev.id]) return { state: 'expired' };
    s.admitted[ev.id] ??= t + ev.holdMs;
    return { state: 'turn' };
  }

  function checkoutPage(s, err = '') {
    const b = s.basket, acc = accountOf(s), t = now();
    if (!b) return page(s, 'Your shopping basket', '<div class="box">Your basket is empty.</div>');
    if (b.state === 'open' && t > b.expiresAt) release(b, 'expired');
    if (b.state !== 'open') return page(s, 'Your shopping basket', `<div class="box" id="basket-state" data-state="${b.state}">${b.state === 'expired' ? 'Your basket has expired.' : 'This basket has already been submitted.'}</div>`);
    const lines = b.lines.map(l => `<li class="line" data-ticket="${l.ticketId}" data-qty="${l.qty}" data-allin="${l.allIn}">${l.qty}x ${esc(l.name)} <span>${money(l.allIn * l.qty)}</span></li>`).join('');
    const secs = Math.max(0, Math.round((b.expiresAt - t) / 1000));
    return page(s, 'Your shopping basket', `${err ? `<p class="err" id="checkout-error">${esc(err)}</p>` : ''}
<div class="box"><div id="countdown" data-expires="${b.expiresAt}">Time remaining to finish purchase: ${Math.floor(secs / 60)} mins ${secs % 60} secs</div></div>
<form id="checkoutform" action="/basket/checkout3d-v2.php" method="post">
<div class="box"><h2>1. your contact details</h2>
<label>Full Name: * <input name="name" value="${esc(acc?.name ?? '')}"></label><br><label>Email Address: * <input name="email" value="${esc(acc?.email ?? '')}"></label>
<label><input type="checkbox" name="smsconfirmation" value="1"> Send a WhatsApp confirmation to me (50p)</label></div>
<div class="box"><h2>2. payment details</h2>
<label><input type="radio" name="paymentmethod" value="card"> Credit/Debit card</label>
<label><input type="radio" name="paymentmethod" value="paypal"> PayPal/Pay-in-3</label>
${acc?.paypalAgreement ? `<p id="paypal-saved">PayPal is saved for Skiddle payments (${esc(acc.email.replace(/^(.).*@/, '$1***@'))})</p>` : ''}
${acc?.credit > 0 ? `<label><input type="checkbox" name="usecredit" value="1"> Use my Skiddle credit (<span id="credit">${money(acc.credit)}</span> available)</label>` : ''}
<div id="card-fields">Card number, expiry and security code are entered in secure fields on your device.</div></div>
<div class="box"><h2>3. complete your order</h2><ul id="summary">${lines}</ul>
<p>Total: <b id="total" data-total="${b.total}">${money(b.total)}</b></p>
<fieldset id="ticketplan"><legend>would you like to protect your tickets? *</legend>
<label><input type="radio" name="ticketplan" value="yes"> YES, please protect my booking (${money(DEFAULTS.refundProtection * b.qty)})</label>
<label><input type="radio" name="ticketplan" value="no"> NO, I do not want to protect my booking</label></fieldset>
<label><input type="checkbox" name="charity" value="1" checked> Yes, I would like to donate £1.00</label><br>
<label><input type="checkbox" name="newsletteroptin" value="1" checked> Send me news and offers</label><br>
<label><input type="checkbox" name="accept" value="1"> I accept the terms and conditions *</label><br>
<button type="submit" id="checkout">Pay</button></div></form>`);
  }

  function release(b, state) {
    b.state = state;
    const ev = evs.get(String(b.eventId));
    for (const l of b.lines) ev.tickets.find(x => x.id === l.ticketId).taken -= l.qty;
  }

  function charge(s, b, acc, method, useCredit) {
    if (method !== 'credit' && rng() < evs.get(String(b.eventId)).pDecline) {
      release(b, 'declined');
      return { ok: false, reason: 'Your payment was declined.' };
    }
    if (useCredit) acc.credit = r2(acc.credit - b.total);
    b.state = 'complete';
    const order = {
      ref: 'SK' + Math.floor(10_000_000 + rng() * 89_999_999), accountId: acc?.id ?? null, sid: b.sid, eventId: b.eventId,
      lines: b.lines.map(l => ({ ...l })), total: b.total, extras: b.extras, method, at: now(),
    };
    orders.push(order);
    b.orderRef = order.ref;
    return { ok: true, order };
  }

  const handoffState = h => (h.state === 'pending' && now() > h.expiresAt ? (h.state = 'expired') : h.state);

  // ---- request handling ----
  async function body(req) {
    let raw = '';
    for await (const c of req) raw += c;
    if ((req.headers['content-type'] ?? '').includes('json')) return raw ? JSON.parse(raw) : {};
    const p = new URLSearchParams(raw), o = {};
    for (const [k, v] of p) (k.endsWith('[]') ? (o[k] ??= []).push(v) : (o[k] = v));
    return o;
  }
  const send = (res, code, html, type = 'text/html') => { res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }); res.end(html); };
  const redirect = (res, to) => { res.writeHead(302, { location: to }); res.end(); };
  const json = (res, code, data) => send(res, code, JSON.stringify(data), 'application/json');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      const p = url.pathname, t = now();
      // admin + test endpoints (not part of Skiddle)
      if (p === '/admin/events' && req.method === 'POST') return json(res, 200, { id: upsertEvent(await body(req)).id });
      if (p === '/admin/stats') return json(res, 200, { ...stats, orders });
      if (p === '/api/catalogue') {
        return json(res, 200, [...evs.values()].map(ev => ({
          id: String(ev.id), name: ev.name, venue: `${ev.venue}, ${ev.city}`, startsAt: ev.date, saleStart: ev.saleStart,
          waitingRoomLeadMs: ev.waitingRoomLeadMs, limit: ev.limit, ticketFamily: 'General Admission',
          url: `/whats-on/${ev.city}/${ev.venue.replace(/\W+/g, '-')}/${ev.name.replace(/\W+/g, '-')}/${ev.id}/`,
          tiers: ev.tickets.filter(x => x.family === 'General Admission').map(x => ({ name: x.name, price: x.allIn })),
        })));
      }
      const m = p.match(/^\/handoff\/([\w-]+)(\.json)?$/);
      if (m) {
        const h = handoffs.get(m[1]);
        if (!h) return send(res, 404, 'Not found');
        if (req.method === 'POST') {
          const b = await body(req);
          if (handoffState(h) === 'pending') h.state = b.action === 'approve' ? 'approved' : 'rejected';
          return json(res, 200, { state: h.state });
        }
        if (m[2]) return json(res, 200, { id: h.id, kind: h.kind, state: handoffState(h), expiresAt: h.expiresAt });
        return send(res, 200, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Complete payment</title><body style="font:15px system-ui;padding:24px">
<p style="color:#888;font-size:12px">LOCAL SKIDDLE COPY · customer's device</p><h1>${h.kind === 'card' ? 'Enter your card' : 'Approve with PayPal'}</h1><p>${h.kind === 'card' ? 'Type your card details and approve with your bank.' : 'PayPal is asking you to confirm this payment.'}</p>
<p id="s">Status: ${handoffState(h)}</p><button onclick="go('approve')">Done</button> <button onclick="go('reject')">Cancel</button>
<script>async function go(a){const r=await fetch('/handoff/${h.id}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:a})});document.getElementById('s').textContent='Status: '+(await r.json()).state}</script>`);
      }

      const { sid, s } = session(req, res);
      if (p === '/login' && req.method === 'GET') return send(res, 200, page(s, 'Log in', `<div class="box"><form method="post" action="/login"><input type="hidden" name="next" value="${esc(url.searchParams.get('next') ?? '/')}">
<label>Email <input name="email" id="email"></label><br><label>Password <input type="password" name="password" id="password"></label><br><button type="submit" id="login">Log in</button></form></div>`));
      if (p === '/login' && req.method === 'POST') {
        const b = await body(req);
        const acc = accounts.get(b.email);
        if (!acc || acc.password !== b.password) return send(res, 401, page(s, 'Log in', '<p class="err">Email or password is wrong.</p>'));
        s.accountId = acc.id;
        return redirect(res, b.next || '/');
      }
      if (p === '/logout') { s.accountId = null; return redirect(res, '/'); }
      if (p === '/account/') {
        if (!accountOf(s)) return redirect(res, '/login?next=/account/');
        const a = accountOf(s);
        return send(res, 200, page(s, 'My account', `<div class="box" id="account" data-email="${esc(a.email)}" data-paypal="${a.paypalAgreement}" data-credit="${a.credit}"><h1>${esc(a.name)}</h1><a href="/account/orders">Order history</a></div>`));
      }
      if (p === '/account/orders') {
        if (!accountOf(s)) return redirect(res, '/login?next=/account/orders');
        const mine = orders.filter(o => o.accountId === s.accountId);
        return send(res, 200, page(s, 'Order history', `<div class="box"><h1>Order history</h1><ul>${mine.map(o => `<li class="order" data-ref="${o.ref}" data-event="${o.eventId}" data-total="${o.total}" data-lines='${esc(JSON.stringify(o.lines.map(l => ({ name: l.name, qty: l.qty, allIn: l.allIn }))))}'>${o.ref}: ${o.lines.map(l => `${l.qty}x ${esc(l.name)}`).join(', ')} · ${money(o.total)}</li>`).join('')}</ul></div>`));
      }
      const ev = (() => { const mm = p.match(/^\/whats-on\/[^/]+\/[^/]+\/[^/]+\/(\d+)\/?$/); return mm ? evs.get(mm[1]) : null; })();
      if (ev) {
        if (ev.queue && t >= ev.saleStart - ev.waitingRoomLeadMs && !(s.admitted[ev.id] > t)) return redirect(res, `/queue/${ev.id}?return=${encodeURIComponent(p)}`);
        return send(res, 200, eventPage(ev, s, t));
      }
      const q = p.match(/^\/queue\/(\d+)$/);
      if (q) {
        const qev = evs.get(q[1]);
        if (!qev) return send(res, 404, 'Not found');
        const v = queueView(qev, s, t);
        if (v.state === 'turn') return redirect(res, url.searchParams.get('return') ?? '/');
        return send(res, 200, page(s, 'Skiddle Queue', `<div class="box" id="queue" data-state="${v.state}" data-ahead="${v.ahead ?? ''}" data-left="${v.left ?? ''}">${
          v.state === 'expired' ? 'Your time to shop has expired.'
          : v.state === 'waiting' ? `You're in the waiting room. Tickets go on sale at <span id="sale-time">${new Date(qev.saleStart).toISOString()}</span>.`
          : `There are <b id="ahead">${v.ahead}</b> people in front of you. Expected wait: ${v.wait} minutes. ${v.left}% of tickets remaining.`}</div>`));
      }
      if (p === '/whatson/tickets_check.php' && req.method === 'POST') {
        const b = await body(req);
        const tev = evs.get(String(b.eventcode));
        if (!tev) return send(res, 404, 'Not found');
        if (tev.queue && !(s.admitted[tev.id] > t)) return redirect(res, `/queue/${tev.id}`);
        if (s.basket?.state === 'open' && t <= s.basket.expiresAt) release(s.basket, 'replaced');
        const picks = (b['tickets[]'] ?? []).map(v => v.match(/^ticket_(\d+)_(\d+)$/)).filter(Boolean).map(mm => ({ id: Number(mm[1]), qty: Number(mm[2]) })).filter(x => x.qty > 0);
        const qty = picks.reduce((a, x) => a + x.qty, 0);
        const already = orders.filter(o => o.eventId === tev.id && (o.accountId ? o.accountId === s.accountId : o.sid === sid)).reduce((a, o) => a + o.lines.reduce((c, l) => c + l.qty, 0), 0);
        const back = msg => send(res, 409, eventPage(tev, s, t).replace('<div class="box" id="tickets">', `<p class="err" id="ticket-error">${esc(msg)}</p><div class="box" id="tickets">`));
        if (!qty) return back('Please choose at least one ticket.');
        if (qty + already > tev.limit) return back(`The limit is ${tev.limit} tickets per customer.`);
        const left = remaining(tev, t);
        for (const x of picks) {
          const i = tev.tickets.findIndex(k => k.id === x.id);
          if (i < 0 || left[i] < x.qty) return back('Sorry, there are not enough tickets left of that type.');
        }
        const lines = picks.map(x => { const k = tev.tickets.find(tt => tt.id === x.id); k.taken += x.qty; return { ticketId: k.id, name: k.name, family: k.family, qty: x.qty, allIn: k.allIn }; });
        s.basket = { id: randomUUID(), sid, eventId: tev.id, lines, qty, total: r2(lines.reduce((a, l) => a + l.allIn * l.qty, 0)), state: 'open', expiresAt: t + tev.checkoutMs };
        stats.basketCreations.push({ eventId: tev.id, sid, at: t });
        return redirect(res, '/basket/default.php');
      }
      if (p === '/basket/default.php') return send(res, 200, checkoutPage(s));
      if (p === '/basket/checkout3d-v2.php' && req.method === 'POST') {
        const b = await body(req), bk = s.basket, acc = accountOf(s);
        if (!bk) return redirect(res, '/basket/default.php');
        stats.checkoutSubmissions.push({ eventId: bk.eventId, sid, basket: bk.id, at: t });
        if (bk.state !== 'open') return send(res, 409, checkoutPage(s));
        if (t > bk.expiresAt) { release(bk, 'expired'); return send(res, 410, checkoutPage(s)); }
        if (!b.ticketplan) return send(res, 422, checkoutPage(s, 'Please choose whether to protect your tickets.'));
        if (!b.accept) return send(res, 422, checkoutPage(s, 'Please accept the terms and conditions.'));
        if (!b.name || !b.email) return send(res, 422, checkoutPage(s, 'Please complete your contact details.'));
        bk.extras = { refundProtection: b.ticketplan === 'yes', donation: !!b.charity, sms: !!b.smsconfirmation };
        const evx = evs.get(String(bk.eventId));
        if (b.usecredit && acc) {
          if (acc.credit < bk.total) return send(res, 422, checkoutPage(s, "Your Skiddle credit doesn't cover this order."));
          const r = charge(s, bk, acc, 'credit', true);
          return redirect(res, `/basket/complete.php?order=${r.order.ref}`);
        }
        const method = b.paymentmethod;
        if (method !== 'card' && method !== 'paypal') return send(res, 422, checkoutPage(s, 'Please choose a payment method.'));
        // Card details and any PayPal confirmation happen on the customer's own device.
        const needsCustomer = method === 'card' || !acc?.paypalAgreement || rng() < evx.pPayPalCheck;
        if (!needsCustomer) {
          const r = charge(s, bk, acc, 'paypal', false);
          return r.ok ? redirect(res, `/basket/complete.php?order=${r.order.ref}`) : send(res, 402, page(s, 'Payment', `<div class="box" id="payment-result" data-result="declined">${esc(r.reason)}</div>`));
        }
        const h = { id: randomUUID(), kind: method === 'card' ? 'card' : 'paypal', state: 'pending', expiresAt: Math.min(bk.expiresAt, t + evx.handoffMs), basket: bk.id };
        handoffs.set(h.id, h);
        bk.state = 'awaiting_customer';
        bk.handoff = h.id;
        bk.method = method;
        return redirect(res, '/basket/pending.php');
      }
      if (p === '/basket/pending.php') {
        const bk = s.basket, acc = accountOf(s);
        if (!bk?.handoff) return redirect(res, '/basket/default.php');
        const h = handoffs.get(bk.handoff);
        const st = handoffState(h);
        if (bk.state === 'awaiting_customer' && st === 'approved') {
          if (bk.method === 'paypal' && acc) acc.paypalAgreement = true;
          const r = charge(s, bk, acc, bk.method, false);
          if (!r.ok) return send(res, 402, page(s, 'Payment', `<div class="box" id="payment-result" data-result="declined">${esc(r.reason)}</div>`));
        }
        if (bk.state === 'complete') return redirect(res, `/basket/complete.php?order=${bk.orderRef}`);
        if (bk.state === 'awaiting_customer' && (st === 'rejected' || st === 'expired')) release(bk, 'not_completed');
        if (bk.state !== 'awaiting_customer') return send(res, 200, page(s, 'Payment', `<div class="box" id="payment-result" data-result="${bk.state}">Payment was not completed.</div>`));
        return send(res, 200, page(s, 'Complete your payment', `<div class="box" id="handoff" data-id="${h.id}" data-kind="${h.kind}" data-url="/handoff/${h.id}" data-expires="${h.expiresAt}">Waiting for you to ${h.kind === 'card' ? 'enter your card' : 'confirm with PayPal'} on your device.</div>`));
      }
      if (p === '/basket/complete.php') {
        const ref = url.searchParams.get('order');
        const o = orders.find(x => x.ref === ref);
        if (!o) return send(res, 404, page(s, 'Order', '<div class="box">Order not found.</div>'));
        return send(res, 200, page(s, 'Thank you', `<div class="box" id="confirmation" data-ref="${o.ref}" data-total="${o.total}"><h1>Thank you for your order</h1>Your order reference is <b id="order-ref">${o.ref}</b>.</div>`));
      }
      if (p === '/') return send(res, 200, page(s, 'Skiddle (local copy)', `<div class="box"><h1>Events</h1><ul>${[...evs.values()].map(e => `<li><a href="/whats-on/${e.city}/v/e/${e.id}/">${esc(e.name)}</a></li>`).join('')}</ul></div>`));
      return send(res, 404, page(s, 'Not found', '<div class="box">Page not found.</div>'));
    } catch (err) {
      send(res, 500, `Error: ${esc(err.message)}`, 'text/plain');
    }
  });

  return {
    server, upsertEvent, stats, orders, accounts, handoffs,
    async start(port = 0) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      return `http://127.0.0.1:${server.address().port}`;
    },
    stop: () => new Promise(r => server.close(r)),
  };
}
