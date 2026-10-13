import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { router, send, httpError, listen } from '../shared/http.js';
import { validateWatchRequest, checkAgainstTerms, ACTIVE_STATUSES, gbp } from '../shared/rules.js';
import { authorisationText, sha256, newSigningKeys, signPayload } from '../shared/authorisation.js';
import { createStore } from './store.js';
import { loadEvents } from './sellers.js';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
export const SUCCESS_FEE = 4.99;

export function createDropwatchServer({
  dataDir,
  sellers,
  companionToken,
  now = () => Date.now(),
  missedReleaseGraceMs = 10 * 60_000,   // armed but never claimed this long after release → failed
  attemptTimeoutMs = 30 * 60_000,       // attempting with no word from the Companion this long → failed
  earliestClaimMs = 30 * 60_000,        // a claim is accepted at most this long before release
  log = console.log,
}) {
  const store = createStore(join(dataDir, 'dropwatch.json'));
  const db = store.data;
  const keyFile = join(dataDir, 'signing-key.json');
  if (!existsSync(keyFile)) writeFileSync(keyFile, JSON.stringify(newSigningKeys()));
  const keys = JSON.parse(readFileSync(keyFile, 'utf8'));
  const outbox = join(dataDir, 'outbox.jsonl');
  const presence = { lastSeen: 0, deviceId: null };
  let events = [];

  // Sellers sometimes move a release. Armed watches follow the seller's current time, so the
  // Companion joins the waiting room when it actually opens.
  let lastRefresh = 0;
  const refreshEvents = async () => {
    events = await loadEvents(sellers);
    lastRefresh = now();
    let moved = false;
    for (const w of db.watches.filter(w => w.status === 'armed')) {
      const ev = eventOf(w.sellerId, w.eventId);
      if (ev && ev.saleStart !== w.releaseAt) {
        addLog(w, 0, `${w.sellerName} moved the release to ${new Date(ev.saleStart).toLocaleString('en-GB')}`, 'warn');
        w.releaseAt = ev.saleStart;
        w.waitingRoomLeadMs = ev.waitingRoomLeadMs ?? w.waitingRoomLeadMs;
        moved = true;
      }
    }
    if (moved) store.save();
    return events;
  };
  const sellerOf = id => sellers.find(s => s.id === id);
  const eventOf = (sellerId, eventId) => events.find(e => e.sellerId === sellerId && e.id === eventId);
  const watchOf = id => {
    const w = db.watches.find(w => w.id === id);
    if (!w) throw httpError(404, 'no_watch', 'Watch not found.');
    return w;
  };

  const addLog = (w, step, msg, level = 'info', at = now()) => w.log.push({ at, step, msg, level });

  // Push and email are delivered by a provider in production; here every notification is
  // recorded in the app and appended to data/outbox.jsonl.
  function notify(w, kind, title, body) {
    const n = { id: randomUUID(), at: now(), watchId: w.id, kind, title, body, channels: ['push', 'email'] };
    db.notifications.unshift(n);
    db.notifications.length = Math.min(db.notifications.length, 200);
    appendFileSync(outbox, JSON.stringify(n) + '\n');
    addLog(w, 7, `Notified you (push + email): ${title}`, kind === 'secured' ? 'ok' : kind === 'needs_customer' ? 'warn' : 'bad');
    log(`[notify] ${title} — ${body}`);
  }

  function preview(body) {
    const seller = sellerOf(body.sellerId);
    if (!seller) return { ok: false, errors: ['Choose a seller.'] };
    if (!seller.enabled) return { ok: false, errors: [seller.reason] };
    const ev = eventOf(body.sellerId, body.eventId);
    const v = validateWatchRequest(ev, body, db.watches);
    if (!ev) return v;
    if (ev.ticketFamily) v.terms.family = ev.ticketFamily;
    const text = authorisationText(ev, seller.name, v.terms);
    return { ...v, text, textHash: sha256(text), event: ev, seller };
  }

  function instructionFor(w) {
    const payload = {
      watchId: w.id, sellerId: w.sellerId, sellerName: w.sellerName,
      event: { id: w.eventId, name: w.eventName, venue: w.venue, saleStart: w.releaseAt, waitingRoomLeadMs: w.waitingRoomLeadMs },
      terms: w.terms,
      authorisation: { ref: w.authorisation.ref, hash: w.authorisation.hash, text: w.authorisation.text },
      issuedAt: now(),
    };
    return { payload, signature: signPayload(payload, keys.privateKey) };
  }

  const companionAuth = req => {
    const got = Buffer.from(String(req.headers['x-companion-token'] ?? ''));
    const want = Buffer.from(companionToken);
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw httpError(401, 'companion_auth', 'Companion is not paired.');
    presence.lastSeen = now();
    presence.deviceId = req.headers['x-device-id'] ?? presence.deviceId;
  };

  const activeAttempt = (w, attemptId) => {
    if (!w.attempt || w.attempt.id !== attemptId) throw httpError(409, 'not_your_attempt', 'This attempt does not hold the lock.');
    if (!['attempting', 'needs_customer'].includes(w.status)) throw httpError(409, 'attempt_closed', `Watch is already ${w.status}.`);
  };

  // Stalled or missed attempts end as failed. Nothing is ever retried.
  function sweep() {
    const t = now();
    let changed = false;
    for (const w of db.watches) {
      if (w.status === 'armed' && t > w.releaseAt + missedReleaseGraceMs) {
        w.status = 'failed';
        w.result = { outcome: 'failed', reason: 'The Companion was not running at release, so no attempt was made.', at: t };
        notify(w, 'failed', `${w.eventName}: no attempt made`, 'Your Companion was offline at release. Nothing was bought and you were not charged.');
        changed = true;
      }
      const lastHeard = w.log.at(-1)?.at ?? w.attempt?.claimedAt ?? 0;
      if (['attempting', 'needs_customer'].includes(w.status) && t - lastHeard > attemptTimeoutMs) {
        w.status = 'failed';
        w.result = { outcome: 'failed', reason: 'The Companion stopped responding during the attempt. Not retried. Check your seller account for an order.', at: t };
        notify(w, 'failed', `${w.eventName}: attempt outcome unknown`, 'The Companion stopped responding. Dropwatch did not retry. Check your seller account in case an order went through.');
        changed = true;
      }
    }
    if (changed) store.save();
  }

  const view = w => ({ ...w, fee: w.status === 'secured' ? SUCCESS_FEE : 0 });

  const handle = router([
    // ---- customer app ----
    ['GET', '/', ({ res }) => send(res, 200, readFileSync(join(WEB_DIR, 'index.html'), 'utf8'), 'text/html')],
    ['GET', '/api/status', () => ({
      companion: { online: now() - presence.lastSeen < 15_000, lastSeen: presence.lastSeen || null, deviceId: presence.deviceId },
      sellers: sellers.map(({ id, name, enabled, reason }) => ({ id, name, enabled, reason })),
      fee: SUCCESS_FEE,
    })],
    ['GET', '/api/events', async () => {
      await refreshEvents();
      return events.filter(e => e.saleStart > now() - 60 * 60_000);
    }],
    ['POST', '/api/authorisation/preview', async ({ body }) => {
      if (!events.length) await refreshEvents();
      const p = preview(body);
      return { ok: p.ok, errors: p.errors, terms: p.terms, text: p.text ?? null, textHash: p.textHash ?? null };
    }],
    ['GET', '/api/watches', () => {
      sweep();
      return db.watches.slice().reverse().map(view);
    }],
    ['GET', '/api/watches/:id', ({ params }) => view(watchOf(params.id))],
    ['POST', '/api/watches', async ({ body }) => {
      await refreshEvents();
      const p = preview(body);
      if (!p.ok) throw httpError(422, 'invalid', p.errors.join(' '));
      if (body.authorise !== true || body.textHash !== p.textHash) {
        throw httpError(422, 'not_authorised', 'Confirm the authorisation exactly as shown. It changes if any detail changes.');
      }
      const ev = p.event;
      const w = {
        id: String(db.nextId++), sellerId: ev.sellerId, sellerName: p.seller.name, eventId: ev.id, eventName: ev.name,
        venue: ev.venue, releaseAt: ev.saleStart, waitingRoomLeadMs: ev.waitingRoomLeadMs ?? 15 * 60_000,
        tiers: ev.tiers, limit: ev.limit, terms: p.terms,
        authorisation: { ref: 'AU-' + randomBytes(3).readUIntBE(0, 3).toString().padStart(6, '0').slice(-6), text: p.text, hash: p.textHash, acceptedAt: now() },
        status: 'armed', attempt: null, result: null, prompt: null, log: [], createdAt: now(),
      };
      addLog(w, 0, `Authorised (${w.authorisation.ref}) and armed`);
      db.watches.push(w);
      store.save();
      return { httpStatus: 201, body: view(w) };
    }],
    ['POST', '/api/watches/:id/revoke', ({ params }) => {
      const w = watchOf(params.id);
      if (w.status !== 'armed') throw httpError(409, 'not_armed', `This watch is ${w.status} and can no longer be revoked.`);
      w.status = 'revoked';
      w.authorisation.revokedAt = now();
      addLog(w, 0, `Authorisation ${w.authorisation.ref} revoked. Nothing will be bought.`, 'bad');
      store.save();
      return view(w);
    }],
    ['DELETE', '/api/watches/:id', ({ params }) => {
      const w = watchOf(params.id);
      if (ACTIVE_STATUSES.includes(w.status)) throw httpError(409, 'active', 'Revoke the watch before removing it.');
      db.watches = db.watches.filter(x => x !== w);
      store.data.watches = db.watches;
      store.save();
      return { removed: w.id };
    }],
    ['GET', '/api/notifications', () => db.notifications.slice(0, 50)],

    // ---- Companion ----
    ['GET', '/api/companion/key', () => ({ publicKey: keys.publicKey })],
    ['GET', '/api/companion/instructions', async ({ req }) => {
      companionAuth(req);
      if (now() - lastRefresh > 10_000) await refreshEvents();
      sweep();
      return db.watches.filter(w => w.status === 'armed').map(instructionFor);
    }],
    ['POST', '/api/companion/watches/:id/preflight', ({ req, params, body }) => {
      companionAuth(req);
      const w = watchOf(params.id);
      if (w.status !== 'armed') return { ok: true };
      if (body.ok) addLog(w, 0, 'Pre-release check passed: Companion online and signed in to your seller account', 'ok');
      else {
        addLog(w, 0, `Pre-release check failed: ${body.issues.join('; ')}`, 'bad');
        notify(w, 'preflight', `${w.eventName}: fix this before release`, body.issues.join(' '));
      }
      store.save();
      return { ok: true };
    }],
    // The attempt lock. Exactly one claim per watch can ever succeed.
    ['POST', '/api/companion/watches/:id/claim', ({ req, params, body }) => {
      companionAuth(req);
      const w = watchOf(params.id);
      if (w.status !== 'armed' || w.attempt) throw httpError(409, 'locked', `No attempt allowed: watch is ${w.status}${w.attempt ? ' and its single attempt is already used' : ''}.`);
      if (now() < w.releaseAt - w.waitingRoomLeadMs - earliestClaimMs) throw httpError(409, 'too_early', 'Too early to start this attempt.');
      w.attempt = { id: randomUUID(), deviceId: String(body.deviceId ?? 'unknown'), claimedAt: now() };
      w.status = 'attempting';
      addLog(w, 0, `Authorisation ${w.authorisation.ref} checked · attempt lock taken by ${w.attempt.deviceId}`);
      store.save();
      return { attemptId: w.attempt.id };
    }],
    ['POST', '/api/companion/watches/:id/events', ({ req, params, body }) => {
      companionAuth(req);
      const w = watchOf(params.id);
      activeAttempt(w, body.attemptId);
      for (const e of body.entries ?? []) addLog(w, e.step, String(e.msg), e.level ?? 'info', e.at ?? now());
      if (body.status === 'needs_customer' && w.status !== 'needs_customer') {
        w.status = 'needs_customer';
        w.prompt = body.prompt ?? null;
        notify(w, 'needs_customer', `${w.eventName}: the seller needs you`, body.prompt?.message ?? 'Complete the check on your device.');
      } else if (body.status === 'attempting' && w.status === 'needs_customer') {
        w.status = 'attempting';
        w.prompt = null;
      }
      store.save();
      return { status: w.status };
    }],
    ['POST', '/api/companion/watches/:id/result', ({ req, params, body }) => {
      companionAuth(req);
      const w = watchOf(params.id);
      activeAttempt(w, body.attemptId);
      w.prompt = null;
      const outcome = ['secured', 'missed', 'failed'].includes(body.outcome) ? body.outcome : 'failed';
      w.status = outcome;
      w.result = { outcome, reason: body.reason ?? null, order: body.order ?? null, at: now() };
      if (outcome === 'secured') {
        // Independent check of what was actually bought against what the customer authorised.
        const check = checkAgainstTerms(w.terms, body.order);
        w.result.check = check;
        if (!check.ok) {
          w.result.limitBreach = true;
          addLog(w, 6, `ALERT: order breaks authorised limits (${check.checks.filter(c => !c.ok).map(c => c.rule).join(', ')})`, 'bad');
        }
        const o = body.order;
        notify(w, 'secured', `Secured: ${o.qty} × ${o.tierName} for ${w.eventName}`,
          `${gbp(o.total)} paid to ${w.sellerName}, order ${o.orderRef}. Success fee ${gbp(SUCCESS_FEE)} added to your monthly bill.`);
      } else {
        notify(w, outcome, `${w.eventName}: ${outcome === 'missed' ? 'missed' : 'not completed'}`,
          `${body.reason ?? ''} Nothing was bought and you were not charged.`.trim());
      }
      store.save();
      return view(w);
    }],
  ]);

  const server = http.createServer(handle);
  const timer = setInterval(sweep, 30_000);
  timer.unref();
  return {
    server, store, refreshEvents,
    async start(port = 0) {
      await refreshEvents();
      return listen(server, port);
    },
    stop: () => new Promise(r => { clearInterval(timer); server.close(r); }),
  };
}
