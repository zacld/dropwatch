import { decodeEntities } from './values.js';

// Extraction of data that is already present in a page's initial HTML: JSON-LD, Next.js page data,
// Ember FastBoot shoebox state, canonical links. No JavaScript is executed and nothing else is fetched.

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

export function scripts(html) {
  return [...String(html).matchAll(SCRIPT_RE)].map(m => ({ attrs: parseAttrs(m[1]), text: m[2] }));
}

function tryJson(text) {
  try { return { value: JSON.parse(text.trim()), error: null }; } catch (e) { return { value: null, error: e.message }; }
}

// Every JSON-LD node in the page, with @graph and arrays flattened. Invalid blocks are reported.
export function jsonLd(html) {
  const nodes = [];
  const errors = [];
  scripts(html).filter(s => (s.attrs.type ?? '').toLowerCase() === 'application/ld+json').forEach((s, i) => {
    if (!s.text.trim()) return; // empty placeholder (Fatsoma organiser pages render 12 of them): nothing to parse
    const { value, error } = tryJson(s.text);
    if (error) { errors.push(`json-ld block ${i}: ${error}`); return; }
    const walk = v => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        if (Array.isArray(v['@graph'])) v['@graph'].forEach(walk);
        else nodes.push(v);
      }
    };
    walk(value);
  });
  return { nodes, errors };
}

const typesOf = n => [].concat(n?.['@type'] ?? []).map(String);
export const isEventNode = n => typesOf(n).some(t => /Event$/.test(t)); // Event, MusicEvent, SportsEvent, ...

export function nextData(html) {
  const s = scripts(html).find(s => s.attrs.id === '__NEXT_DATA__');
  if (!s) return { value: null, error: null };
  return tryJson(s.text);
}

// Ember FastBoot shoebox: <script type="fastboot/shoebox" id="shoebox-...">{json}</script>
// Real Fatsoma pages (observed 13 Oct 2026) serialise the document twice: the script holds a JSON string whose
// content is the JSON:API document. Decode string layers until an object or array appears.
export function shoebox(html) {
  const out = {};
  const errors = [];
  for (const s of scripts(html)) {
    if ((s.attrs.type ?? '').toLowerCase() !== 'fastboot/shoebox') continue;
    let { value, error } = tryJson(s.text);
    for (let depth = 0; !error && typeof value === 'string' && depth < 3; depth++) ({ value, error } = tryJson(value));
    if (error) errors.push(`${s.attrs.id ?? 'shoebox'}: ${error}`);
    else out[s.attrs.id ?? `shoebox-${Object.keys(out).length}`] = value;
  }
  return { entries: out, errors };
}

export function canonicalUrl(html) {
  const m = String(html).match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i);
  if (m) return parseAttrs(m[0].slice(5)).href ?? null;
  const og = String(html).match(/<meta\b[^>]*property=["']og:url["'][^>]*>/i);
  return og ? parseAttrs(og[0].slice(5)).content ?? null : null;
}

export function title(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() : null;
}

// Depth-first search for objects matching a predicate; yields { value, path }.
export function* findDeep(v, pred, path = [], seen = new Set()) {
  if (!v || typeof v !== 'object' || seen.has(v)) return;
  seen.add(v);
  if (!Array.isArray(v) && pred(v)) yield { value: v, path };
  for (const [k, child] of Object.entries(v)) yield* findDeep(child, pred, [...path, k], seen);
}

// First present value among candidate key names (sources rename fields; keep every name optional).
export function pick(obj, ...keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}
