// Source health. Each attempt updates one record per source; the state shown is derived from it.
// Blocking, challenges and rate limits PAUSE a source. Nothing here ever increases request frequency.

export const SOURCE_STATES = [
  'healthy', 'degraded', 'blocked', 'rate_limited', 'challenge_detected', 'parse_error', 'stale', 'disabled', 'awaiting_configuration',
];

const HOUR = 3_600_000;
const PAUSE = { challenge: 24 * HOUR, captcha: 24 * HOUR, blocked: 24 * HOUR, rate_limited: 6 * HOUR };
const STATE_FOR = {
  challenge: 'challenge_detected', captcha: 'challenge_detected', blocked: 'blocked', rate_limited: 'rate_limited',
  unexpected_content: 'parse_error', not_found: 'degraded', server_error: 'degraded', network_error: 'degraded',
  timeout: 'degraded', empty: 'degraded',
};

export function initialHealth(connector) {
  return {
    source: connector.id,
    name: connector.name,
    parser_version: connector.parserVersion,
    state: 'awaiting_configuration',
    last_attempt_at: null,
    last_success_at: null,        // last attempt that produced a valid observation
    last_valid_parse_at: null,
    last_failure_at: null,
    consecutive_failures: 0,
    failures_total: 0,
    observations_total: 0,
    last_classification: null,
    last_evidence: [],
    last_errors: [],
    last_anomalies: [],
    last_origin: null,             // fixture | manual | live — health from fixtures is labelled as such
    last_data_observed_at: null,   // when the data in the last valid observation was observed (may be older than receipt)
    last_live_success_at: null,
    missing_required_fields: [],
    missing_optional_fields: [],
    paused_until: null,
    backoff_level: 0,
  };
}

const iso = ms => new Date(ms).toISOString();

export function recordResult(h, result, { now, intervalMinutes = 360 }) {
  const t = now;
  h.parser_version = result.parser_version ?? h.parser_version;
  h.last_attempt_at = iso(t);
  h.observations_total += 1;
  h.last_classification = result.classification;
  h.last_evidence = result.evidence ?? [];
  h.last_errors = result.errors ?? [];
  h.last_anomalies = (result.anomalies ?? []).slice(0, 20);
  h.last_origin = result.origin ?? null;

  if (result.ok) {
    const valid = result.events.filter(e => !e.rejected);
    h.last_success_at = iso(t);
    h.last_valid_parse_at = iso(t);
    h.last_data_observed_at = result.observed_at ?? iso(t);
    if (result.origin === 'live') h.last_live_success_at = iso(t);
    h.consecutive_failures = 0;
    h.backoff_level = 0;
    h.paused_until = null;
    h.missing_required_fields = [...new Set(result.events.flatMap(e => e.missing_required))];
    h.missing_optional_fields = [...new Set(valid.flatMap(e => e.missing_optional))];
    const troubled = valid.length < result.events.length || valid.some(e => Object.values(e.field_states).includes('uncertain'));
    h.state = troubled ? 'degraded' : 'healthy';
    return h;
  }

  h.last_failure_at = iso(t);
  h.consecutive_failures += 1;
  h.failures_total += 1;
  if (result.classification === 'ok') {
    // Fetched fine, parse failed: the page changed shape or the parser is wrong.
    h.state = 'parse_error';
    h.missing_required_fields = [...new Set(result.events.flatMap(e => e.missing_required))];
  } else {
    h.state = STATE_FOR[result.classification] ?? 'degraded';
  }
  const pause = PAUSE[result.classification];
  if (pause) {
    const retryAfterMs = Number(result.retry_after) > 0 ? Number(result.retry_after) * 1000 : 0;
    h.paused_until = iso(t + Math.max(pause, retryAfterMs));
  }
  h.backoff_level = Math.min(h.backoff_level + 1, 5);
  return h;
}

export function recordDisabled(h, now) {
  h.last_attempt_at = iso(now);
  h.state = 'disabled';
  return h;
}

// Earliest time a LIVE attempt may be made: never sooner than the interval, doubled per failure, and
// never during a pause.
export function nextAllowedAttempt(h, intervalMinutes) {
  const last = h.last_attempt_at ? Date.parse(h.last_attempt_at) : 0;
  const backoff = intervalMinutes * 60_000 * 2 ** (h.backoff_level ?? 0);
  return Math.max(last + backoff, h.paused_until ? Date.parse(h.paused_until) : 0);
}

// The state as shown now: kill switch, configuration and freshness are applied on read.
export function currentHealth(h, connector, { now, cfg }) {
  const src = cfg.sources[connector.id] ?? {};
  const needsConfig = (connector.access.requiresConfig ?? []).filter(k => k === 'TICKETMASTER_API_KEY' && !cfg.ticketmasterApiKey);
  let state = h.state;
  if (!src.enabled) state = 'disabled';
  else if (!h.last_attempt_at) state = needsConfig.length ? 'awaiting_configuration' : 'stale';
  else if (['healthy', 'degraded'].includes(state) && h.last_success_at && now - Date.parse(h.last_data_observed_at ?? h.last_success_at) > cfg.staleAfterHours * HOUR) state = 'stale';
  const live = connector.access.liveRetrieval === 'not_permitted' ? 'not_permitted'
    : needsConfig.length ? 'awaiting_configuration'
    : src.live ? 'enabled' : 'off';
  return {
    ...h,
    state,
    enabled: !!src.enabled,
    live_retrieval: live,
    access: connector.access,
    verification: connector.verification,
    missing_config: needsConfig,
    data_age_minutes: h.last_success_at ? Math.round((now - Date.parse(h.last_data_observed_at ?? h.last_success_at)) / 60_000) : null,
    paused: !!(h.paused_until && Date.parse(h.paused_until) > now),
  };
}
