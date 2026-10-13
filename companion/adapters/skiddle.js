import { chromium } from 'playwright-core';
import { SoldOut, SellerError } from './base.js';

// Skiddle adapter: drives a real Chrome browser through Skiddle's pages in the customer's own signed-in
// session, following the structure observed on skiddle.com. Development runs point it at the local
// Skiddle copy (sellers/skiddle-sim); it has not been run against skiddle.com.
//
// session = { email, password,        test credentials only (real customers sign in themselves)
//             payment: 'paypal' | 'credit' | 'card',   the customer's chosen payment route
//             refundProtection: false,                 the customer's saved answer to Skiddle's question
//             context, page }                          browser state, kept for the whole attempt

// Skiddle lists different kinds of ticket in one form. Dropwatch only ever buys within one family.
export const ticketFamily = name =>
  /\bvip\b/i.test(name) ? 'VIP'
  : /\b\d+\s*for\s*\d+\b|\bbundle\b|\bgroup\b/i.test(name) ? 'Bundle'
  : /\bpre-?\s*\d|\barrive before\b|\bbefore \d/i.test(name) ? 'Entry time'
  : 'General Admission';

const ROUTE_LABEL = { paypal: 'PayPal agreement', credit: 'Skiddle credit', card: 'card on your device' };

export function skiddleAdapter({ baseUrl, pollMs = 1000, launch = {}, browser: sharedBrowser } = {}) {
  let browserPromise = null;
  const browser = () => (sharedBrowser ? Promise.resolve(sharedBrowser)
    : (browserPromise ??= chromium.launch({ channel: 'chrome', headless: true, ...launch })));
  const abs = path => baseUrl + path;
  const eventPath = id => `/whats-on/city/venue/event/${encodeURIComponent(id)}/`;

  async function pageFor(session) {
    session.context ??= await (await browser()).newContext();
    if (!session.page || session.page.isClosed()) session.page = await session.context.newPage();
    return session.page;
  }

  async function readTiers(page) {
    const rows = await page.$$eval('form[id$="-ticket-form"] li[id^="ticket-"]', lis => lis.map(li => ({
      id: li.id.replace('ticket-', ''),
      name: (li.querySelector('.ticket-name')?.textContent ?? li.innerText.split('\n')[0]).trim(),
      allIn: parseFloat((li.querySelector('.allin')?.textContent ?? '').replace(/[^\d.]/g, '')),
      available: !!li.querySelector('select[name="tickets[]"]'),
      qtys: [...(li.querySelector('select')?.options ?? [])].map(o => Number(o.value.split('_').pop())),
    })));
    return rows.map(r => ({ id: r.id, name: r.name, price: r.allIn, available: r.available, family: ticketFamily(r.name), qtys: r.qtys }));
  }

  return {
    id: 'skiddle',
    name: 'Skiddle',
    enabled: true,

    async openSession(session) {
      const page = await pageFor(session);
      await page.goto(abs('/account/'));
      if (page.url().includes('/login')) {
        if (!session.email) return { signedIn: false };
        await page.fill('#email', session.email);
        await page.fill('#password', session.password);
        await Promise.all([page.waitForNavigation(), page.click('#login')]);
        await page.goto(abs('/account/'));
      }
      const acc = page.locator('#account');
      if (!(await acc.count())) return { signedIn: false };
      const route = session.payment ?? 'paypal';
      const paypal = (await acc.getAttribute('data-paypal')) === 'true';
      const credit = Number(await acc.getAttribute('data-credit'));
      const ready = route === 'paypal' ? paypal : route === 'credit' ? credit > 0 : true;
      return {
        signedIn: true, account: await acc.getAttribute('data-email'),
        savedCard: ready ? { brand: ROUTE_LABEL[route], last4: '', label: route === 'credit' ? `Skiddle credit £${credit.toFixed(2)}` : ROUTE_LABEL[route] } : null,
      };
    },

    async findEvent(session, eventId) {
      const page = await pageFor(session);
      await page.goto(abs(eventPath(eventId)));
      const h1 = page.locator('#tickets').count().then(n => (n ? page.locator('h1').first().textContent() : null));
      return { id: eventId, name: await h1 };
    },

    // Waits in the waiting room and queue in this one browser session, reloading at a polite pace.
    async enterSale(session, eventId, hooks) {
      const page = await pageFor(session);
      let last = null;
      for (;;) {
        await page.goto(abs(eventPath(eventId)));
        if (await page.locator('form[id$="-ticket-form"]').count() && !(await page.locator('#onsale').count())) {
          hooks.onProgress("It's your turn: the ticket page is open");
          return { access: true };
        }
        const q = page.locator('#queue');
        if (await q.count()) {
          const state = await q.getAttribute('data-state');
          if (state === 'expired') throw new SellerError('The time to shop expired.', { code: 'expired' });
          if (state !== last) hooks.onProgress(state === 'waiting' ? 'Joined the waiting room' : `Sale open: ${await q.getAttribute('data-ahead')} people ahead in the queue`);
          last = state;
        } else if (last !== 'early') {
          hooks.onProgress('Event page open: waiting for the waiting room');
          last = 'early';
        }
        await page.waitForTimeout(pollMs);
      }
    },

    getTiers: async session => readTiers(await pageFor(session)),

    async reserve(session, eventId, access, tierName, qty) {
      const page = await pageFor(session);
      const row = (await readTiers(page)).find(t => t.name === tierName);
      if (!row?.available || !row.qtys.includes(qty)) throw new SoldOut(`${tierName}: ${qty} not available`);
      await page.selectOption(`#ticket_${row.id}_select`, `ticket_${row.id}_${qty}`);
      await Promise.all([page.waitForNavigation(), page.click('form[id$="-ticket-form"] button[type="submit"]')]);
      const err = page.locator('#ticket-error');
      if (await err.count()) {
        const msg = (await err.textContent()).trim();
        if (/not enough|sold out/i.test(msg)) throw new SoldOut(msg);
        throw new SellerError(msg, { code: 'basket' });
      }
      if (!page.url().includes('/basket/default.php')) throw new SellerError(`Unexpected page after choosing tickets: ${page.url()}`, { code: 'flow' });
      const lines = await page.$$eval('#summary .line', ls => ls.map(l => ({ qty: Number(l.dataset.qty), allIn: Number(l.dataset.allin), name: l.textContent.replace(/^\d+x\s*/, '').replace(/£[\d.]+$/, '').trim() })));
      return {
        id: 'basket', tier: lines[0]?.name, qty: lines.reduce((a, l) => a + l.qty, 0), unitPrice: lines[0]?.allIn,
        total: Number(await page.locator('#total').getAttribute('data-total')),
        expiresAt: Number(await page.locator('#countdown').getAttribute('data-expires')),
        extraTiers: lines.length - 1,
      };
    },

    // Fills checkout from the customer's preferences and presses Pay exactly once.
    async checkout(session, basket, hooks) {
      const page = await pageFor(session);
      await page.check(`input[name="ticketplan"][value="${session.refundProtection ? 'yes' : 'no'}"]`);
      for (const name of ['charity', 'newsletteroptin', 'smsconfirmation']) {
        const box = page.locator(`input[name="${name}"]`);
        if ((await box.count()) && (await box.isChecked())) await box.uncheck();
      }
      await page.check('input[name="accept"]');
      const route = session.payment ?? 'paypal';
      if (route === 'credit') await page.check('input[name="usecredit"]');
      else await page.check(`input[name="paymentmethod"][value="${route}"]`);

      await Promise.all([page.waitForNavigation(), page.click('#checkout')]); // the single submission
      let asked = false;
      for (;;) {
        if (page.url().includes('/basket/complete.php')) return { state: 'confirmed', orderRef: (await page.locator('#order-ref').textContent()).trim() };
        if (await page.locator('#payment-result').count()) return { state: 'declined' };
        if (await page.locator('#basket-state').count()) return { state: 'declined' };
        const err = page.locator('#checkout-error');
        if (await err.count()) throw new SellerError((await err.textContent()).trim(), { code: 'checkout' });
        const h = page.locator('#handoff');
        if ((await h.count()) && !asked) {
          asked = true;
          const kind = await h.getAttribute('data-kind');
          await hooks.customerAction({
            id: await h.getAttribute('data-id'), kind, url: abs(await h.getAttribute('data-url')),
            message: kind === 'card' ? 'Your tickets are in the basket. Enter your card on your phone to finish.' : 'PayPal is asking you to confirm this payment.',
          }, { allowReject: true });
        }
        await page.waitForTimeout(pollMs);
        await page.reload(); // the pending page is a plain GET: reloading it never resubmits
      }
    },

    async findOrder(session, { eventId, orderRef }) {
      const page = await pageFor(session);
      await page.goto(abs('/account/orders'));
      const orders = await page.$$eval('li.order', os => os.map(o => ({ ref: o.dataset.ref, eventId: o.dataset.event, total: Number(o.dataset.total), lines: JSON.parse(o.dataset.lines) })));
      const o = orders.find(x => (orderRef ? x.ref === orderRef : String(x.eventId) === String(eventId)));
      if (!o) return null;
      return { orderRef: o.ref, tierName: o.lines[0].name, qty: o.lines.reduce((a, l) => a + l.qty, 0), unitPrice: o.lines[0].allIn, total: o.total };
    },

    async challengeStatus(id) {
      return (await (await fetch(abs(`/handoff/${id}.json`))).json()).state;
    },

    async close(session) {
      await session?.context?.close().catch(() => {});
      if (!sharedBrowser && browserPromise) await (await browserPromise).close();
    },
  };
}
