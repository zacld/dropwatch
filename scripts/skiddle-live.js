// First live Skiddle runs of the Dropwatch buyer, started by the account holder on their own computer.
//
//   node scripts/skiddle-live.js <event-url> [--qty 1] [--ticket "<name>"] [--free]
//
// Opens Chrome with its own Dropwatch profile (data/skiddle-profile). The first time, sign in to your
// Skiddle account in that window when asked; the profile remembers it on this computer.
//
// Modes
//   (default)  dry run: chooses tickets, fills checkout, and stops before the final button. The basket
//              simply expires. Nothing is booked.
//   --free     completes the order only if the checkout total is £0.00. Never pays for anything.
//
// Every run saves screenshots, page snapshots and a report to data/skiddle-live/<time>/ so the plug-in can
// be matched to Skiddle's real pages. Page structure follows what was observed on skiddle.com (5 Oct 2026).

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { ticketFamily } from '../companion/adapters/skiddle.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const eventUrl = args.find(a => a.startsWith('https://www.skiddle.com/'));
if (!eventUrl) {
  console.error('Usage: node scripts/skiddle-live.js <skiddle event url> [--qty 1] [--ticket "<name>"] [--free]');
  process.exit(1);
}
const qty = Number(opt('qty', 1));
const wantTicket = opt('ticket', null);
const freeMode = args.includes('--free');

const runDir = join(root, 'data', 'skiddle-live', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(runDir, { recursive: true });
const report = { eventUrl, mode: freeMode ? 'free' : 'dry-run', qty, steps: [] };
let shot = 0;
const step = (n, msg, data) => {
  console.log(`${n} · ${msg}`);
  report.steps.push({ step: n, msg, at: new Date().toISOString(), ...(data ? { data } : {}) });
};
async function capture(page, label) {
  const base = join(runDir, `${String(++shot).padStart(2, '0')}-${label}`);
  await page.screenshot({ path: base + '.png', fullPage: true }).catch(() => {});
  writeFileSync(base + '.html', await page.content().catch(() => ''));
}
const finish = code => { writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2)); console.log(`\nReport and screenshots: ${runDir}`); return code; };

const context = await chromium.launchPersistentContext(join(root, 'data', 'skiddle-profile'), { channel: 'chrome', headless: false, viewport: { width: 1280, height: 900 } });
const page = context.pages()[0] ?? await context.newPage();
let exitCode = 0;

try {
  // 1 · the account holder's own signed-in session
  await page.goto(eventUrl, { waitUntil: 'domcontentloaded' });
  const signedIn = async () => !(await page.locator('a[href*="login" i]:visible, button:has-text("Log in"):visible, a:has-text("Log in"):visible').count());
  if (!(await signedIn())) {
    console.log('\nSign in to your Skiddle account in the Chrome window, then come back here and press Enter.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('');
    rl.close();
    await page.goto(eventUrl, { waitUntil: 'domcontentloaded' });
  }
  step(1, `Opened the event in your own Skiddle session (signed in: ${await signedIn()})`);

  // 2 · the event, from its structured data
  await page.waitForSelector('form[id$="-ticket-form"]', { timeout: 30_000 }).catch(() => {});
  if (!(await page.locator('form[id$="-ticket-form"]').count())) {
    await capture(page, 'no-ticket-form');
    step(2, `No ticket form on this page (${page.url()}). It may be a queue or waiting room. Stopped.`);
    exitCode = finish(2);
  } else {
    const ld = await page.$$eval('script[type="application/ld+json"]', ss => ss.map(s => { try { return JSON.parse(s.textContent); } catch { return null; } }).flat().find(x => x && /Event/.test(x['@type'] ?? '')));
    step(2, `Found event: ${ld?.name} (${ld?.startDate})`, { offers: ld?.offers });

    // 3 · the ticket rows as the customer sees them
    const rows = await page.$$eval('form[id$="-ticket-form"] li[id^="ticket-"]', lis => lis.map(li => {
      const sel = li.querySelector('select');
      const prices = [...li.innerText.matchAll(/£\s?(\d+(?:\.\d{2})?)/g)].map(m => Number(m[1]));
      return {
        id: li.id.replace('ticket-', ''), name: li.innerText.split('\n').map(s => s.trim()).find(Boolean),
        allIn: prices[0] ?? null, available: !!sel && !sel.disabled,
        qtys: sel ? [...sel.options].map(o => Number(o.value.split('_').pop())) : [],
      };
    }));
    rows.forEach(r => (r.family = ticketFamily(r.name)));
    step(3, `${rows.length} ticket types: ${rows.map(r => `${r.name} £${r.allIn} ${r.available ? 'on sale' : 'unavailable'} [${r.family}]`).join(' · ')}`, { rows });
    const pick = wantTicket ? rows.find(r => r.name.toLowerCase().includes(wantTicket.toLowerCase())) : rows.filter(r => r.available).sort((a, b) => a.allIn - b.allIn)[0];
    if (!pick?.available || !pick.qtys.includes(qty)) {
      step(3, `Cannot choose ${qty} × ${pick?.name ?? wantTicket ?? 'any ticket'}: not available in that quantity. Stopped.`);
      exitCode = finish(3);
    } else if (freeMode && pick.allIn !== 0) {
      step(3, `Free mode, but ${pick.name} costs £${pick.allIn}. Stopped before the basket.`);
      exitCode = finish(3);
    } else {
      step(3, `Selected ${qty} × ${pick.name} at £${pick.allIn} each`);

      // 4 · into the basket (holds the tickets for the checkout timer; nothing is booked)
      await page.selectOption(`#ticket_${pick.id}_select`, `ticket_${pick.id}_${qty}`);
      const pay = page.locator('form[id$="-ticket-form"] button[type="submit"], form[id$="-ticket-form"] button:has-text("Pay")').first();
      await Promise.all([page.waitForURL(u => !String(u).startsWith(eventUrl), { timeout: 30_000 }).catch(() => {}), pay.click()]);
      await page.waitForLoadState('domcontentloaded');
      await capture(page, 'after-ticket-form');
      if (!page.url().includes('/basket/')) {
        step(4, `Unexpected page after choosing tickets: ${page.url()}. Stopped.`);
        exitCode = finish(4);
      } else {
        // 5 · checkout: what it asks for, then the customer's preferences
        const form = page.locator('#checkoutform');
        const total = await page.$eval('input[name="totalcostinput"]', i => Number(i.value)).catch(() => null);
        const timer = await page.locator('#countdown').innerText().catch(() => null);
        const required = await page.$$eval('#checkoutform input, #checkoutform select', els => els
          .filter(e => e.offsetParent !== null && ['text', 'email', 'tel', 'select-one', 'password'].includes(e.type))
          .map(e => ({ name: e.name, empty: !e.value })));
        const radios = await page.$$eval('#checkoutform input[type="radio"]', rs => rs.map(r => ({ name: r.name, value: r.value, visible: r.offsetParent !== null })));
        step(5, `Checkout: total ${total === null ? 'not found' : '£' + total.toFixed(2)} · ${timer ?? 'no timer found'} · empty fields: ${required.filter(f => f.empty).map(f => f.name).join(', ') || 'none'}`, { total, timer, fields: required, radios });

        // Refund protection: the customer's saved answer (No by default). Paid and marketing extras off.
        if (await page.locator('#checkoutform input[name="ticketplan"]:visible').count()) {
          const values = radios.filter(r => r.name === 'ticketplan').map(r => r.value);
          const no = values.find(v => /^(0|no|n|false)$/i.test(v)) ?? values.at(-1); // "NO" is listed second on Skiddle
          await page.check(`#checkoutform input[name="ticketplan"][value="${no}"]`);
          step(5, `Refund protection: answered No (value "${no}")`);
        }
        for (const name of ['smsconfirmation', 'charity', 'newsletteroptin', 'eflyeroptin', 'dataoptin']) {
          const box = page.locator(`#checkoutform input[type="checkbox"][name="${name}"]`);
          if ((await box.count()) && (await box.first().isChecked())) { await box.first().uncheck(); step(5, `Unticked ${name}`); }
        }
        const accept = page.locator('#checkoutform input[name="accept"]');
        if (await accept.count()) { await accept.first().check(); step(5, 'Ticked the terms and conditions'); }
        await capture(page, 'checkout-filled');

        const missing = required.filter(f => f.empty && !/password|email2/.test(f.name));
        const submit = form.locator('button[type="submit"], input[type="submit"]').last();
        const submitLabel = (await submit.count()) ? ((await submit.innerText().catch(() => '')) || (await submit.getAttribute('value'))) : null;
        report.finalButton = submitLabel;

        if (!freeMode) {
          step(6, `Dry run: stopped before the final button ("${submitLabel}"). Nothing booked; the basket will expire.`);
          exitCode = finish(0);
        } else if (total !== 0) {
          step(6, `Free mode, but the checkout total is ${total === null ? 'unknown' : '£' + total.toFixed(2)}. Stopped; nothing booked.`);
          exitCode = finish(6);
        } else if (missing.length) {
          step(6, `Your Skiddle account is missing details checkout needs (${missing.map(f => f.name).join(', ')}). Add them in your account and run again. Nothing booked.`);
          exitCode = finish(6);
        } else {
          // 6 · the single submission, only because the total is £0.00
          step(6, `Total is £0.00: pressing "${submitLabel}" once`);
          await Promise.all([page.waitForURL(u => !String(u).includes('/basket/default.php'), { timeout: 45_000 }).catch(() => {}), submit.click()]);
          await page.waitForLoadState('domcontentloaded');
          await capture(page, 'after-submit');
          const text = await page.locator('body').innerText();
          const ref = text.match(/(?:order|booking)\s*(?:reference|ref|number|id)[:\s#]*([A-Z0-9-]{5,})/i)?.[1] ?? null;
          report.result = { url: page.url(), orderRef: ref };
          step(6, ref ? `Booking confirmed · order ${ref}` : `Submitted. Landed on ${page.url()}; no order reference found on the page (see the screenshot).`);

          // 7 · confirm from the account's order history (read only)
          await page.goto('https://www.skiddle.com/account/', { waitUntil: 'domcontentloaded' }).catch(() => {});
          await capture(page, 'account');
          step(7, `Saved your account page for order-history mapping (${page.url()})`);
          exitCode = finish(ref ? 0 : 7);
        }
      }
    }
  }
} catch (err) {
  await capture(page, 'error');
  step(9, `Stopped on an error: ${err.message}`);
  exitCode = finish(9);
} finally {
  console.log('Closing Chrome in 20 seconds…');
  await page.waitForTimeout(20_000).catch(() => {});
  await context.close();
  process.exit(exitCode);
}
