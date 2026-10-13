import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWatchRequest, chooseTier, checkAgainstTerms } from '../shared/rules.js';
import { authorisationText, sha256, newSigningKeys, signPayload, verifyPayload } from '../shared/authorisation.js';

const event = {
  id: 'e1', sellerId: 's', name: 'Josh Baker', venue: 'Ibiza', limit: 4,
  tiers: [{ name: 'Early bird', price: 45 }, { name: 'Tier 1', price: 60 }, { name: 'Tier 2', price: 75 }, { name: 'Final', price: 95 }],
};
const req = { qty: 2, maxPerTicket: 70, totalCap: 140, tierRule: 'any' };

test('accepts a valid request and normalises the cap', () => {
  const v = validateWatchRequest(event, { ...req, totalCap: 500 }, []);
  assert.equal(v.ok, true);
  assert.equal(v.terms.totalCap, 140);
});

test('quantity is capped by the seller limit, less tickets Dropwatch already secured', () => {
  assert.equal(validateWatchRequest(event, { ...req, qty: 5 }, []).ok, false);
  const secured = [{ sellerId: 's', eventId: 'e1', status: 'secured', terms: { qty: 3 } }];
  assert.equal(validateWatchRequest(event, { ...req, qty: 2 }, secured).ok, false);
  assert.equal(validateWatchRequest(event, { ...req, qty: 1 }, secured).ok, true);
});

test('one active watch per event', () => {
  const active = [{ sellerId: 's', eventId: 'e1', status: 'armed', terms: { qty: 1 } }];
  const v = validateWatchRequest(event, { ...req, qty: 1 }, active);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(), /active watch/);
});

test('rejects a max below the cheapest tier, a cap too low, and a selected tier outside limits', () => {
  assert.equal(validateWatchRequest(event, { ...req, maxPerTicket: 40 }, []).ok, false);
  assert.equal(validateWatchRequest(event, { ...req, totalCap: 80 }, []).ok, false);
  assert.equal(validateWatchRequest(event, { ...req, tierRule: 'selected', selectedTier: 'Tier 2' }, []).ok, false);
  assert.equal(validateWatchRequest(event, { ...req, tierRule: 'selected', selectedTier: 'Tier 1' }, []).ok, true);
});

test('chooseTier: selected tier only, never another', () => {
  const terms = { qty: 2, maxPerTicket: 70, totalCap: 140, tierRule: 'selected', selectedTier: 'Tier 1' };
  const live = [{ name: 'Early bird', price: 45, available: true }, { name: 'Tier 1', price: 60, available: false }];
  assert.equal(chooseTier(terms, live).tier, null);
  assert.equal(chooseTier(terms, [{ name: 'Tier 1', price: 60, available: true }]).tier.name, 'Tier 1');
  assert.equal(chooseTier(terms, [{ name: 'Tier 1', price: 72, available: true }]).tier, null, 'price rose above max');
});

test('chooseTier: any eligible tier picks the cheapest on sale within both limits', () => {
  const terms = { qty: 2, maxPerTicket: 70, totalCap: 125, tierRule: 'any' };
  const live = [
    { name: 'Early bird', price: 45, available: false },
    { name: 'Tier 1', price: 60, available: true },
    { name: 'Tier 2', price: 65, available: true },
  ];
  assert.equal(chooseTier(terms, live).tier.name, 'Tier 1');
  const capped = chooseTier({ ...terms, totalCap: 110 }, live);
  assert.equal(capped.tier, null);
  assert.match(capped.reason, /total cap/);
});

test('checkAgainstTerms blocks quantity, tier, price and cap breaches', () => {
  const terms = { qty: 2, maxPerTicket: 70, totalCap: 130, tierRule: 'selected', selectedTier: 'Tier 1' };
  assert.equal(checkAgainstTerms(terms, { tierName: 'Tier 1', qty: 2, unitPrice: 60, total: 120 }).ok, true);
  assert.equal(checkAgainstTerms(terms, { tierName: 'Tier 1', qty: 3, unitPrice: 60, total: 180 }).ok, false);
  assert.equal(checkAgainstTerms(terms, { tierName: 'Tier 2', qty: 2, unitPrice: 60, total: 120 }).ok, false);
  assert.equal(checkAgainstTerms(terms, { tierName: 'Tier 1', qty: 2, unitPrice: 71, total: 120 }).ok, false);
  assert.equal(checkAgainstTerms(terms, { tierName: 'Tier 1', qty: 2, unitPrice: 66, total: 132 }).ok, false);
});

test('authorisation text states every limit, and signatures detect tampering', () => {
  const terms = { qty: 2, maxPerTicket: 70, totalCap: 130, tierRule: 'selected', selectedTier: 'Tier 1' };
  const text = authorisationText(event, 'Test Seller', terms);
  for (const s of ['one checkout', '2 tickets', '£70 per ticket', '£130 in total', 'Only buy my selected tier, Tier 1', 'Do not retry']) {
    assert.ok(text.includes(s), s);
  }
  const keys = newSigningKeys();
  const payload = { terms, authorisation: { hash: sha256(text) } };
  const sig = signPayload(payload, keys.privateKey);
  assert.equal(verifyPayload(payload, sig, keys.publicKey), true);
  assert.equal(verifyPayload({ ...payload, terms: { ...terms, maxPerTicket: 90 } }, sig, keys.publicKey), false);
});
