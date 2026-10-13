import { createHash } from 'node:crypto';

// Price, currency, text and hashing helpers shared by every connector.

const SYMBOLS = { '£': 'GBP', '€': 'EUR', '$': 'USD' };
const AMBIGUOUS_SYMBOLS = new Set(['$']); // also AUD, CAD, ... — never trusted without a code
export const ISO_CURRENCY = /^[A-Z]{3}$/;

// Parse a published price. Returns { amount, currency, ambiguousCurrency, warning }.
// `minorUnits: true` means the source gives integer pence/cents (e.g. 1250 → 12.50).
export function parseMoney(input, { currency: declared = null, minorUnits = false } = {}) {
  const out = { amount: null, currency: null, ambiguousCurrency: false, warning: null };
  const code = typeof declared === 'string' && ISO_CURRENCY.test(declared.toUpperCase()) ? declared.toUpperCase() : null;
  if (input === null || input === undefined || input === '') return { ...out, currency: code, warning: 'missing' };

  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) return { ...out, currency: code, warning: 'invalid_price' };
    return { ...out, amount: round2(minorUnits ? input / 100 : input), currency: code, warning: code ? null : 'missing_currency' };
  }

  let s = String(input).trim();
  if (/^free$/i.test(s)) return { ...out, amount: 0, currency: code };
  let cur = code;
  const codeIn = s.match(/\b([A-Z]{3})\b/);
  if (codeIn) { cur = cur ?? codeIn[1]; s = s.replace(codeIn[0], ''); }
  const sym = s.match(/[£€$]/);
  if (sym) {
    const symCur = SYMBOLS[sym[0]];
    if (!cur) { cur = symCur; out.ambiguousCurrency = AMBIGUOUS_SYMBOLS.has(sym[0]); }
    else if (cur !== symCur && !AMBIGUOUS_SYMBOLS.has(sym[0])) return { ...out, currency: cur, warning: 'currency_conflict' };
    s = s.replace(sym[0], '');
  }
  s = s.replace(/\s/g, '');
  // "1,234.50" → 1234.50 ; "12,50" (comma decimal) → 12.50
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d+,\d{2}$/.test(s)) s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return { ...out, currency: cur, warning: 'invalid_price' };
  const n = Number(s);
  return { ...out, amount: round2(minorUnits ? n / 100 : n), currency: cur, warning: cur ? null : 'missing_currency' };
}

export const round2 = n => Math.round(n * 100) / 100;

export function normaliseText(s) {
  if (s === null || s === undefined) return null;
  const t = decodeEntities(String(s)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return t || null;
}

// Key used to spot the same real-world event listed on different platforms.
export function matchKey(text) {
  return String(text ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|presents|live|tickets?|at|ft|feat|featuring|b2b|x)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Deterministic JSON (sorted keys) so equal data always hashes the same.
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export const sha256 = s => createHash('sha256').update(s).digest('hex');
export const hashOf = v => sha256(typeof v === 'string' ? v : stableStringify(v));
