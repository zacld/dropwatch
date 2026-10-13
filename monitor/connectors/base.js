import { classifyResponse } from '../classify.js';
import { normaliseEventFields, normaliseTier, EVENT_FIELDS } from '../model.js';
import { hashOf, sha256 } from '../values.js';

// The source connector interface. A connector only knows how to recognise and parse one platform's
// payloads. Retrieval (retrieve.js), persistence (store.js), change detection (changes.js) and
// notifications (notify.js) live elsewhere so each connector can be tested and switched off alone.
//
// A connector definition:
//   id, name, parserVersion
//   domains            hosts a canonical URL may point at
//   defaultTimezone    used only when the source publishes a local time with no offset
//   defaultCurrency
//   access             { method, liveRetrieval, requiresConfig, notes }
//                        method: 'public_html' | 'official_api' | 'fixture_only'
//                        liveRetrieval: 'not_assessed' | 'permitted' | 'not_permitted'
//   verification       what the parser has actually been checked against (shown in the matrix)
//   expectedContent(body)  true when the payload holds the content this parser reads
//   parse(body, ctx)   → { events: [RawEvent], anomalies: [], errors: [] }
//   buildRequest?(target, config) → { url, headers } for permitted live retrieval
//
// RawEvent: { fields, provenance: { field: 'json-ld' | ... }, tiers: [], quarantined: [{ tier, reason }],
//             warnings: [], unavailable: [field], confidence }
export function defineConnector(spec) {
  for (const k of ['id', 'name', 'parserVersion', 'access', 'expectedContent', 'parse']) {
    if (!spec[k]) throw new Error(`connector ${spec.id ?? '?'} is missing ${k}`);
  }
  return Object.freeze({ domains: [], defaultTimezone: 'Europe/London', defaultCurrency: null, verification: 'none', ...spec });
}

// observation: { source, target, observed_at, origin, status, headers, body, error }
// Returns a structured result with provenance and confidence. Never throws for bad input.
export function runConnector(connector, observation) {
  const body = observation.body ?? '';
  const base = {
    source: connector.id,
    target: observation.target ?? null,
    origin: observation.origin ?? 'manual',
    observed_at: observation.observed_at,
    parser_version: connector.parserVersion,
    payload_hash: body ? sha256(String(body)) : null,
    payload_bytes: Buffer.byteLength(String(body)),
    events: [],
    errors: [],
    anomalies: [],
  };
  const cls = classifyResponse(observation, b => connector.expectedContent(b));
  Object.assign(base, { classification: cls.classification, evidence: cls.evidence, retry_after: cls.retryAfter ?? null });
  if (cls.classification !== 'ok') return { ...base, ok: false, status: 'rejected' };

  let parsed;
  try {
    parsed = connector.parse(String(body), { observation, connector });
  } catch (e) {
    return { ...base, ok: false, status: 'invalid', errors: [`parser threw: ${e.message}`] };
  }
  base.anomalies.push(...(parsed.anomalies ?? []));
  base.errors.push(...(parsed.errors ?? []));

  for (const raw of parsed.events ?? []) {
    const n = normaliseEventFields(raw.fields ?? {}, { allowedHosts: connector.domains });
    for (const k of raw.unavailable ?? []) if (n.field_states[k] !== 'confirmed') n.field_states[k] = 'unavailable';
    const tiers = [];
    const tierProblems = [];
    for (const t of raw.tiers ?? []) {
      const r = normaliseTier(t, { eventCurrency: n.fields.currency });
      tiers.push({ ...r.tier, provenance: t.provenance ?? null });
      tierProblems.push(...r.problems.map(p => `tier ${t.source_tier_id}: ${p}`));
    }
    const warnings = [...(raw.warnings ?? []), ...n.problems, ...tierProblems];
    const missing_optional = EVENT_FIELDS.filter(k => n.field_states[k] === 'missing' && !n.missing_required.includes(k));
    let confidence = (raw.confidence ?? 0.8) - 0.05 * n.problems.length - 0.02 * tierProblems.length;
    if ((raw.quarantined ?? []).length) confidence -= 0.05;
    confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
    const ev = {
      fields: n.fields,
      field_states: n.field_states,
      provenance: raw.provenance ?? {},
      tiers,
      quarantined_tiers: (raw.quarantined ?? []).map(q => ({ ...q, tier: { ...q.tier } })),
      warnings,
      missing_required: n.missing_required,
      uncertain_required: n.uncertain_required,
      missing_optional,
      confidence,
    };
    // A hash of the meaningful content only. Markup, scripts and styling never reach this.
    ev.content_hash = hashOf({ fields: ev.fields, tiers: ev.tiers.map(({ provenance, ...t }) => t) });
    if (n.missing_required.length) {
      base.errors.push(`event ${n.fields.source_event_id ?? '(no id)'} missing required: ${n.missing_required.join(', ')}`);
      ev.rejected = true;
    }
    base.events.push(ev);
  }

  const valid = base.events.filter(e => !e.rejected);
  if (!valid.length) {
    if (!base.errors.length) base.errors.push('no event found in payload');
    return { ...base, ok: false, status: 'invalid' };
  }
  return { ...base, ok: true, status: 'valid' };
}
