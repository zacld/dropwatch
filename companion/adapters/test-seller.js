import { SoldOut, SellerError } from './base.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Adapter for the local test seller. A real seller adapter drives the customer's own browser session;
// this one calls the test seller's JSON "pages" directly so the workflow can run thousands of times.
export function testSellerAdapter({ baseUrl, pollMs = 1000 }) {
  async function call(session, method, path, body) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', ...(session?.token ? { authorization: `Bearer ${session.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new SellerError(data.message ?? `Seller returned ${res.status}`, { code: data.error });
    return data;
  }

  return {
    id: 'test-seller',
    name: 'Test Seller (local)',
    enabled: true,

    async openSession(session) {
      // Reuse the device's signed-in session; sign in again on-device if it has lapsed.
      try {
        const me = await call(session, 'GET', '/api/me');
        return { signedIn: true, account: me.email, savedCard: me.savedCard };
      } catch (err) {
        if (err.code !== 'signed_out' || !session.email) return { signedIn: false };
        const { token } = await call(null, 'POST', '/api/login', { email: session.email, password: session.password });
        session.token = token;
        const me = await call(session, 'GET', '/api/me');
        return { signedIn: true, account: me.email, savedCard: me.savedCard, refreshed: true };
      }
    },

    findEvent: (session, eventId) => call(session, 'GET', `/api/events/${encodeURIComponent(eventId)}`),

    async enterSale(session, eventId, hooks) {
      let joined;
      for (;;) {
        try {
          joined = await call(session, 'POST', `/api/events/${encodeURIComponent(eventId)}/queue`);
          break;
        } catch (err) {
          if (err.code !== 'waiting_room_closed') throw err;
          await sleep(pollMs);
        }
      }
      hooks.onProgress('Joined the waiting room');
      let view = joined;
      let lastState = null;
      for (;;) {
        if (view.state === 'verification') {
          await hooks.customerAction({ ...view.challenge, message: 'The seller is asking for a security check before the queue. Complete it on this device.' });
        } else if (view.state === 'your_turn') {
          hooks.onProgress("It's your turn: tickets are held for you");
          return { access: view.accessToken, holdExpiresAt: view.holdExpiresAt };
        } else if (view.state === 'blocked' || view.state === 'expired') {
          throw new SellerError(view.reason, { code: view.state });
        } else if (view.state === 'queue' && lastState !== 'queue') {
          hooks.onProgress(`Sale open: place ${view.position} in the queue`);
        }
        lastState = view.state;
        await sleep(pollMs);
        view = await call(session, 'GET', `/api/queue/${joined.ticket}`);
      }
    },

    getTiers: (session, eventId, access) =>
      call(session, 'GET', `/api/events/${encodeURIComponent(eventId)}/tiers?access=${encodeURIComponent(access)}`),

    async reserve(session, eventId, access, tierName, qty) {
      try {
        return await call(session, 'POST', `/api/events/${encodeURIComponent(eventId)}/basket`, { access, tier: tierName, qty });
      } catch (err) {
        if (err.code === 'not_enough') throw new SoldOut(err.message);
        throw err;
      }
    },

    async checkout(session, basket, hooks) {
      let view = await call(session, 'POST', `/api/baskets/${basket.id}/checkout`);
      if (view.state === 'payment_check') {
        await hooks.customerAction({ ...view.challenge, message: 'Your bank or the seller is asking you to approve the payment. Approve it on this device.' }, { allowReject: true });
      }
      while (view.state === 'payment_check') {
        await sleep(pollMs);
        view = await call(session, 'GET', `/api/baskets/${basket.id}`);
      }
      return { state: view.state === 'confirmed' ? 'confirmed' : 'declined', orderRef: view.orderRef };
    },

    async findOrder(session, { eventId, orderRef }) {
      const orders = await call(session, 'GET', '/api/orders');
      const o = orders.find(o => (orderRef ? o.ref === orderRef : o.eventId === eventId));
      return o ? { orderRef: o.ref, tierName: o.tier, qty: o.qty, unitPrice: o.unitPrice, total: o.total } : null;
    },

    async challengeStatus(id) {
      const c = await call(null, 'GET', `/api/challenges/${id}`);
      return c.state;
    },
  };
}
