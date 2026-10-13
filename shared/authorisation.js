import { createHash, generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from 'node:crypto';
import { gbp } from './rules.js';

// The exact words the customer authorises. The server stores them; the Companion regenerates them
// from the signed instruction and refuses to act if they differ.
export function authorisationText(event, sellerName, terms) {
  const n = terms.qty;
  const tierLine = terms.tierRule === 'any'
    ? 'Buy any eligible tier within my per-ticket max and total cap, cheapest available first.'
    : `Only buy my selected tier, ${terms.selectedTier}. If it sells out, stop. Do not move to another tier.`;
  return `I authorise Dropwatch to attempt one checkout on my behalf for ${event.name} (${event.venue}), `
    + `using my connected ${sellerName} account and saved card. `
    + `Never buy more than ${n} ticket${n === 1 ? '' : 's'}, spend more than ${gbp(terms.maxPerTicket)} per ticket `
    + `or more than ${gbp(terms.totalCap)} in total. If the price exceeds my limit, the purchase must stop. `
    + `Do not retry a failed checkout. ${tierLine}${terms.family ? ` Only buy ${terms.family} tickets.` : ''} If the seller asks for verification, pause and ask me.`;
}

export const sha256 = s => createHash('sha256').update(s).digest('hex');

// Stable JSON with sorted keys, so a signature covers the content rather than key order.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function newSigningKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export const signPayload = (payload, privateKeyPem) =>
  sign(null, Buffer.from(canonical(payload)), createPrivateKey(privateKeyPem)).toString('base64');

export const verifyPayload = (payload, signature, publicKeyPem) => {
  try {
    return verify(null, Buffer.from(canonical(payload)), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
};
