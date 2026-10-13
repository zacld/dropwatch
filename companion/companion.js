import { authorisationText, sha256, verifyPayload } from '../shared/authorisation.js';
import { chooseTier, checkAgainstTerms, gbp } from '../shared/rules.js';
import { SoldOut } from './adapters/base.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ends an attempt with a specific outcome.
class Outcome extends Error {
  constructor(outcome, reason) {
    super(reason);
    this.outcome = outcome;
  }
}

// The Dropwatch Companion: runs on the customer's device, where they are signed in to their seller
// accounts. It receives signed, customer-authorised instructions from the Dropwatch server and carries
// out each one at most once.
export class Companion {
  constructor({
    serverUrl, token, deviceId, publicKey, adapters, sessions,
    pollMs = 2000, preflightLeadMs = 10 * 60_000, customerWaitMs = 10 * 60_000, challengePollMs = 1000,
    log = console.log,
  }) {
    Object.assign(this, { serverUrl, token, deviceId, publicKey, adapters, sessions, pollMs, preflightLeadMs, customerWaitMs, challengePollMs, log });
    this.state = new Map(); // watchId → { preflight: bool, started: bool }
    this.running = false;
  }

  async api(method, path, body) {
    const res = await fetch(this.serverUrl + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-companion-token': this.token, 'x-device-id': this.deviceId },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message ?? `Server returned ${res.status}`);
      err.code = data.error;
      throw err;
    }
    return data;
  }

  // Refuse anything that is not exactly what the customer authorised.
  verify({ payload, signature }) {
    if (!verifyPayload(payload, signature, this.publicKey)) return 'Instruction signature is not valid.';
    const text = authorisationText(payload.event, payload.sellerName, payload.terms);
    if (sha256(text) !== payload.authorisation.hash || text !== payload.authorisation.text) {
      return 'Instruction does not match the authorisation the customer gave.';
    }
    const adapter = this.adapters[payload.sellerId];
    if (!adapter) return `This Companion has no adapter for ${payload.sellerName}.`;
    if (!adapter.enabled) return `${adapter.name} is not enabled: ${adapter.reason}`;
    if (!this.sessions[payload.sellerId]) return `Not signed in to ${payload.sellerName} on this device.`;
    return null;
  }

  // ---- scheduling ----
  start() {
    this.running = true;
    const loop = async () => {
      while (this.running) {
        try {
          await this.tick();
        } catch (err) {
          this.log(`[companion] ${err.message}`);
        }
        await sleep(this.pollMs);
      }
    };
    this.loopDone = loop();
  }

  async stop() {
    this.running = false;
    await this.loopDone;
  }

  async tick() {
    const instructions = await this.api('GET', '/api/companion/instructions');
    const t = Date.now();
    for (const instr of instructions) {
      const { watchId, event } = instr.payload;
      const st = this.state.get(watchId) ?? { preflight: false, started: false };
      this.state.set(watchId, st);
      const joinAt = event.saleStart - event.waitingRoomLeadMs;
      if (!st.preflight && t >= joinAt - this.preflightLeadMs) {
        st.preflight = true;
        await this.preflight(instr);
      }
      if (!st.started && t >= joinAt) {
        st.started = true;
        this.runAttempt(instr).catch(err => this.log(`[companion] attempt ${watchId}: ${err.message}`));
      }
    }
  }

  async preflight(instr) {
    const { watchId, sellerId, sellerName } = instr.payload;
    const issues = [];
    const problem = this.verify(instr);
    if (problem) issues.push(problem);
    else {
      try {
        const s = await this.adapters[sellerId].openSession(this.sessions[sellerId]);
        if (!s.signedIn) issues.push(`Sign in to ${sellerName} on this device.`);
        else if (!s.savedCard) issues.push(`Add a saved card to your ${sellerName} account.`);
      } catch (err) {
        issues.push(`Could not reach ${sellerName}: ${err.message}`);
      }
    }
    await this.api('POST', `/api/companion/watches/${watchId}/preflight`, { ok: issues.length === 0, issues });
    return issues;
  }

  // ---- the attempt ----
  async runAttempt(instr) {
    const { payload } = instr;
    const { watchId, terms, sellerName } = payload;
    const ev = payload.event;

    const problem = this.verify(instr);
    if (problem) {
      this.log(`[companion] refused watch ${watchId}: ${problem}`);
      return { outcome: 'refused', reason: problem };
    }

    let attemptId;
    try {
      ({ attemptId } = await this.api('POST', `/api/companion/watches/${watchId}/claim`, { deviceId: this.deviceId }));
    } catch (err) {
      return { outcome: 'not_claimed', reason: err.message };
    }

    const adapter = this.adapters[payload.sellerId];
    const session = this.sessions[payload.sellerId];
    const send = (entries, extra = {}) =>
      this.api('POST', `/api/companion/watches/${watchId}/events`, { attemptId, entries, ...extra });
    const step = (n, msg, level = 'info') => send([{ step: n, msg, level, at: Date.now() }]);

    // The customer, not the Companion, completes any seller or bank check.
    const customerAction = async (challenge, { allowReject = false } = {}) => {
      await send([{ step: 5, msg: `Paused: ${challenge.message}`, level: 'warn', at: Date.now() }], {
        status: 'needs_customer', prompt: { kind: challenge.kind, url: challenge.url, message: challenge.message },
      });
      const deadline = Date.now() + this.customerWaitMs;
      for (;;) {
        const s = await adapter.challengeStatus(challenge.id);
        if (s === 'approved') {
          await send([{ step: 5, msg: 'You completed the check · continuing the same attempt', at: Date.now() }], { status: 'attempting' });
          return s;
        }
        if (s === 'rejected' || s === 'expired' || Date.now() > deadline) {
          await send([{ step: 5, msg: s === 'rejected' ? 'You cancelled the check' : 'The check was not completed in time', level: 'bad', at: Date.now() }], { status: 'attempting' });
          if (allowReject) return s;
          throw new Outcome('failed', 'The seller check was not completed, so the attempt stopped.');
        }
        await sleep(this.challengePollMs);
      }
    };

    let checkoutSubmitted = false;
    let basket = null;
    const report = (outcome, reason, order = null) =>
      this.api('POST', `/api/companion/watches/${watchId}/result`, { attemptId, outcome, reason, order });

    try {
      // 1 · the customer's own signed-in account on this device
      const s = await adapter.openSession(session);
      if (!s.signedIn) throw new Outcome('failed', `Not signed in to ${sellerName} on this device.`);
      if (!s.savedCard) throw new Outcome('failed', `No saved card on your ${sellerName} account.`);
      await step(1, `Opened your ${sellerName} account on this device (${s.account}, ${s.savedCard.label ?? `${s.savedCard.brand} •••• ${s.savedCard.last4}`})`);

      // 2 · the event
      const found = await adapter.findEvent(session, ev.id);
      await step(2, `Found event: ${found.name ?? ev.name}`);

      // waiting room and queue, as the customer's own single session
      const { access } = await adapter.enterSale(session, ev.id, {
        onProgress: msg => step(2, msg),
        customerAction,
      });

      // 3 · choose the tier from what is actually on sale. If it sells out in the moment before it reaches the
      // basket, "any eligible tier" re-reads the list and takes the next one. Nothing has been submitted yet,
      // so this is not a retry of checkout.
      for (let pick = 1; !basket; pick++) {
        const tiers = await adapter.getTiers(session, ev.id, access);
        const soldOut = tiers.filter(t => !t.available && (!terms.family || !t.family || t.family === terms.family)).map(t => t.name);
        if (soldOut.length) await step(3, `Sold out: ${soldOut.join(', ')}`, 'warn');
        const choice = chooseTier(terms, tiers);
        if (!choice.tier) throw new Outcome('missed', `Stopped before checkout: ${choice.reason}.`);
        await step(3, terms.tierRule === 'any'
          ? `Selected ${choice.tier.name} at ${gbp(choice.tier.price)}, the cheapest eligible tier on sale`
          : `Selected ${choice.tier.name} at ${gbp(choice.tier.price)}, your selected tier`);
        try {
          basket = await adapter.reserve(session, ev.id, access, choice.tier.name, terms.qty);
        } catch (err) {
          if (!(err instanceof SoldOut)) throw err;
          if (terms.tierRule !== 'any' || pick >= 3) throw new Outcome('missed', `Stopped before checkout: ${choice.tier.name} sold out before it could be added to the basket.`);
          await step(3, `${choice.tier.name} sold out before it reached the basket · checking the next eligible tier`, 'warn');
        }
      }

      // 4 · hard limit check on the actual basket
      const check = checkAgainstTerms(terms, { tierName: basket.tier, qty: basket.qty, unitPrice: basket.unitPrice, total: basket.total });
      await step(4, `Limit check: ${check.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.detail}`).join(' · ')}`, check.ok ? 'ok' : 'bad');
      if (!check.ok) throw new Outcome('failed', 'The basket did not match your authorised limits, so checkout was not attempted.');

      // 5 · checkout, exactly once
      checkoutSubmitted = true;
      await step(5, `Checkout attempted once (${s.savedCard.label ?? 'saved card'}): ${basket.qty} × ${basket.tier} = ${gbp(basket.total)}`);
      const paid = await adapter.checkout(session, basket, { customerAction });

      // 6 · confirmation, read back from the customer's account
      if (paid.state !== 'confirmed') throw new Outcome('failed', 'The seller did not confirm the payment. Dropwatch did not retry.');
      const order = await adapter.findOrder(session, { eventId: ev.id, orderRef: paid.orderRef });
      if (!order) throw new Outcome('failed', 'Payment went through but the order is not in your account yet. Not retried. Check your account.');
      const after = checkAgainstTerms(terms, order);
      await step(6, `Booking confirmed · order ${order.orderRef}`, after.ok ? 'ok' : 'bad');
      return { outcome: 'secured', watch: await report('secured', null, order), order };
    } catch (err) {
      let outcome = 'failed';
      let reason = err.message;
      if (err instanceof Outcome) outcome = err.outcome;
      else if (checkoutSubmitted) {
        // Never retry after submitting. Look for the order once and report what is known.
        const order = await adapter.findOrder(session, { eventId: ev.id }).catch(() => null);
        if (order && basket && order.qty === basket.qty) {
          await step(6, `Booking confirmed · order ${order.orderRef}`, 'ok');
          return { outcome: 'secured', watch: await report('secured', null, order), order };
        }
        reason = `Checkout outcome unclear (${err.message}). Dropwatch did not retry. Check your ${sellerName} account.`;
      } else {
        reason = `Stopped before checkout: ${err.message}`;
      }
      await step(outcome === 'missed' ? 3 : 6, reason, outcome === 'missed' ? 'warn' : 'bad').catch(() => {});
      await report(outcome, reason);
      return { outcome, reason };
    }
  }
}
