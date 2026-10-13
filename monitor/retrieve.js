import { readFileSync } from 'node:fs';

// Retrieval, kept apart from parsing. Three ways in:
//   fixtureObservation  a saved file from fixtures/ (sample data)
//   manualObservation   a page or payload the operator saved themselves
//   retrieveLive        ONE ordinary HTTP request, only when the source's live retrieval is switched on and
//                       its access method is not marked not_permitted.
// No cookies, no sessions, no identity rotation, no retries on block/challenge/rate-limit, no headless
// browser. A refusal is returned as a classified response so the engine records it as source health.

export function fixtureObservation(file, { source, target = null, status = 200, observed_at, fixture = null } = {}) {
  return { source, target, status, observed_at, origin: 'fixture', fixture: fixture ?? file, body: readFileSync(file, 'utf8') };
}

export function manualObservation(file, { source, target = null, status = 200, observed_at }) {
  return { source, target, status, observed_at, origin: 'manual', body: readFileSync(file, 'utf8') };
}

export async function retrieveLive(connector, target, config, { fetchImpl = fetch, now = () => Date.now(), log } = {}) {
  const base = { source: connector.id, target, origin: 'live', observed_at: new Date(now()).toISOString() };
  const src = config.sources[connector.id];
  if (!src?.enabled) return { ...base, error: 'disabled', refused: 'source disabled by kill switch' };
  if (connector.access.liveRetrieval === 'not_permitted') return { ...base, refused: 'live retrieval not permitted for this source' };
  if (!src.live) return { ...base, refused: `live retrieval is off (set DROPWATCH_LIVE_${connector.id.toUpperCase().replace(/-/g, '_')}=on)` };

  let req;
  if (connector.buildRequest) {
    req = connector.buildRequest(target, config);
    if (req.error) return { ...base, refused: req.message, awaiting_configuration: req.error === 'awaiting_configuration' };
  } else {
    let u;
    try { u = new URL(target); } catch { return { ...base, refused: 'target is not a URL' }; }
    if (u.protocol !== 'https:' || !connector.domains.some(d => u.hostname === d || u.hostname.endsWith('.' + d))) {
      return { ...base, refused: `target host ${u.hostname} is not a ${connector.name} host` };
    }
    req = { url: u.toString(), redactedUrl: u.toString(), headers: { accept: 'text/html,application/xhtml+xml' } };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), config.requestTimeoutMs);
  try {
    log?.info('retrieve', { source: connector.id, url: req.redactedUrl ?? req.url });
    const res = await fetchImpl(req.url, { headers: { 'user-agent': config.userAgent, ...req.headers }, redirect: 'follow', signal: ac.signal });
    const finalHost = new URL(res.url || req.url).hostname;
    if (!connector.buildRequest && !connector.domains.some(d => finalHost === d || finalHost.endsWith('.' + d))) {
      return { ...base, status: res.status, error: `redirected off-site to ${finalHost}` };
    }
    const text = await readLimited(res, config.maxResponseBytes);
    const headers = {};
    for (const h of ['content-type', 'retry-after', 'date', 'age', 'cache-control', 'etag', 'last-modified', 'x-cache', 'x-cache-status']) headers[h] = res.headers.get(h);
    const observedAt = new Date(now()).toISOString();
    return { ...base, observed_at: observedAt, content_as_of: contentAsOf(headers, observedAt), status: res.status, headers, body: text };
  } catch (e) {
    return { ...base, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// When the content was generated, as opposed to when we received it. CDN caches serve copies that are
// minutes old (Skiddle, observed 13 Oct 2026: max-age=300, stale-while-revalidate=120, Age 166), and two
// edges can disagree, so ordering by fetch time alone can replay an older copy as a "change back".
// Uses the origin Date minus Age when both are present; otherwise the fetch time.
export function contentAsOf(headers, observedAt) {
  const date = Date.parse(headers?.date ?? '');
  const age = Number(headers?.age);
  const fetched = Date.parse(observedAt);
  if (!Number.isFinite(date)) return Number.isFinite(age) && age >= 0 ? new Date(fetched - age * 1000).toISOString() : observedAt;
  const generated = date - (Number.isFinite(age) && age >= 0 ? age * 1000 : 0);
  return new Date(Math.min(generated, fetched)).toISOString();
}

async function readLimited(res, max) {
  if (!res.body?.getReader) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel(); throw new Error(`response larger than ${max} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}
