// Hard purchase rules. The server applies them when a watch is created and when a result is
// reported; the Companion applies them again on the device before and after checkout.

export const ACTIVE_STATUSES = ['armed', 'attempting', 'needs_customer'];
export const FINAL_STATUSES = ['secured', 'missed', 'failed', 'revoked'];

export const gbp = n => '£' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A total cap above qty × max adds nothing: the per-ticket max already bounds the basket.
export const effectiveCap = (qty, maxPerTicket, totalCap) => Math.min(totalCap, qty * maxPerTicket);

export const isEligible = (price, terms) =>
  price <= terms.maxPerTicket && price * terms.qty <= terms.totalCap;

// Tickets Dropwatch has already secured for this customer for this event count against the seller limit.
export const securedQty = (watches, sellerId, eventId) =>
  watches
    .filter(w => w.sellerId === sellerId && w.eventId === eventId && w.status === 'secured')
    .reduce((sum, w) => sum + w.terms.qty, 0);

export function validateWatchRequest(event, req, watches) {
  if (!event) return { ok: false, errors: ['That event is not available.'] };
  const errors = [];
  const qty = Number(req.qty);
  const max = Number(req.maxPerTicket);
  const capIn = Number(req.totalCap);
  const cheapest = Math.min(...event.tiers.map(t => t.price));
  const left = event.limit - securedQty(watches, event.sellerId, event.id);

  if (!Number.isInteger(qty) || qty < 1) errors.push('Quantity must be a whole number of at least 1.');
  else if (qty > left) {
    errors.push(left <= 0
      ? `Dropwatch has already secured the seller's limit of ${event.limit} for ${event.name}.`
      : `That would go over the seller's limit of ${event.limit} per customer. You can add up to ${left}.`);
  }
  if (!(max >= cheapest)) errors.push(`Your maximum per ticket is below the cheapest tier (${gbp(cheapest)}).`);
  if (!(capIn > 0)) errors.push('Set a total spend cap.');

  const totalCap = effectiveCap(qty, max, capIn);
  if (capIn > 0 && totalCap < qty * cheapest) {
    errors.push(`Your total cap is below ${qty} × the cheapest tier (${gbp(qty * cheapest)}).`);
  }

  const tierRule = req.tierRule;
  let selectedTier = null;
  if (tierRule === 'selected') {
    const t = event.tiers.find(t => t.name === req.selectedTier);
    if (!t) errors.push('Choose the tier to buy.');
    else if (!isEligible(t.price, { qty, maxPerTicket: max, totalCap })) {
      errors.push(`${t.name} (${gbp(t.price)}) is outside your per-ticket max or total cap.`);
    } else selectedTier = t.name;
  } else if (tierRule !== 'any') {
    errors.push('Choose "Only buy my selected tier" or "Allow any eligible tier".');
  }

  if (watches.some(w => w.sellerId === event.sellerId && w.eventId === event.id && ACTIVE_STATUSES.includes(w.status))) {
    errors.push(`You already have an active watch for ${event.name}. Dropwatch makes one purchase attempt per event.`);
  }

  return { ok: errors.length === 0, errors, terms: { qty, maxPerTicket: max, totalCap, tierRule, selectedTier } };
}

// At release: pick the tier to buy from what the seller is actually offering.
export function chooseTier(terms, allTiers) {
  // Sellers can mix ticket kinds (release tiers, entry-time, bundles, VIP); only the authorised family counts.
  const liveTiers = terms.family ? allTiers.filter(t => !t.family || t.family === terms.family) : allTiers;
  const onSale = liveTiers.filter(t => t.available).sort((a, b) => a.price - b.price);
  if (terms.tierRule === 'selected') {
    const t = liveTiers.find(t => t.name === terms.selectedTier);
    if (!t) return { tier: null, reason: `your selected tier ${terms.selectedTier} is not listed by the seller` };
    if (!t.available) return { tier: null, reason: `your selected tier ${t.name} is sold out and you chose to buy only that tier` };
    if (!isEligible(t.price, terms)) return { tier: null, reason: `${t.name} is now ${gbp(t.price)}, outside your limits` };
    return { tier: t };
  }
  const t = onSale.find(t => isEligible(t.price, terms));
  if (t) return { tier: t };
  if (!onSale.length) return { tier: null, reason: 'every tier is sold out' };
  const next = onSale[0];
  return {
    tier: null,
    reason: next.price > terms.maxPerTicket
      ? `the cheapest tier on sale, ${next.name} at ${gbp(next.price)}, is over your ${gbp(terms.maxPerTicket)} per-ticket limit`
      : `${next.name} would total ${gbp(next.price * terms.qty)}, over your ${gbp(terms.totalCap)} total cap`,
  };
}

// Checks a basket or a confirmed order against the authorised terms. Run before checkout and on the result.
export function checkAgainstTerms(terms, { tierName, qty, unitPrice, total }) {
  const checks = [
    { rule: 'quantity', ok: qty === terms.qty, detail: `${plural(qty, 'ticket')}, ${terms.qty} authorised` },
    {
      rule: 'tier',
      ok: terms.tierRule === 'any' || tierName === terms.selectedTier,
      detail: terms.tierRule === 'any' ? `${tierName} (any eligible tier allowed)` : `${tierName}, ${terms.selectedTier} authorised`,
    },
    { rule: 'per-ticket max', ok: unitPrice <= terms.maxPerTicket, detail: `${gbp(unitPrice)} per ticket, max ${gbp(terms.maxPerTicket)}` },
    { rule: 'total cap', ok: total <= terms.totalCap + 1e-9, detail: `${gbp(total)} total, cap ${gbp(terms.totalCap)}` },
  ];
  return { ok: checks.every(c => c.ok), checks };
}
