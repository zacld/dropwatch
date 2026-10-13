import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONNECTORS } from './connectors/index.js';
import { signalConfig } from './signals.js';

// Runtime configuration from environment variables (and .env, which never overrides the real environment).
// See .env.example for every option.

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadDotEnv(file = join(ROOT, '.env'), env = process.env) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const envKey = id => id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const flag = (v, fallback) => (v === undefined || v === '' ? fallback : /^(1|on|true|yes)$/i.test(v));
const num = (v, fallback) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v));

// Minimum polling intervals. Configuration can lengthen these, never shorten them.
export const MIN_INTERVAL_MINUTES = { official_api: 30, public_html: 60, fixture_only: Infinity };

// Release-window checks: a few extra requests around a KNOWN release time of a watched event. Each setting is
// clamped to a hard ceiling so configuration can tune the allowance but never turn it into heavy polling.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const parseOffsets = (raw, fallback) => {
  const o = String(raw ?? fallback).split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n >= -60 && n <= 120);
  return [...new Set(o.length ? o : fallback.split(',').map(Number))].sort((a, b) => a - b).slice(0, 8);
};
// Per-site defaults where a site's caching makes the generic +1 min check too early. Fatsoma pages may be served
// from cache for up to ~2 min (max-age=60, stale-while-revalidate=59, observed 13 Oct 2026), so +2.
const SOURCE_OFFSET_DEFAULTS = { fatsoma: '-2,2,5,15' };
export function releaseWindowConfig(env = process.env) {
  const offsetsBySource = {};
  // Precedence: DROPWATCH_RELEASE_OFFSETS_<SITE>_MINUTES, then an explicit DROPWATCH_RELEASE_OFFSETS_MINUTES,
  // then the site's built-in default, then the generic default.
  for (const c of CONNECTORS) {
    const raw = env[`DROPWATCH_RELEASE_OFFSETS_${envKey(c.id)}_MINUTES`] ?? env.DROPWATCH_RELEASE_OFFSETS_MINUTES;
    if (raw !== undefined || SOURCE_OFFSET_DEFAULTS[c.id]) offsetsBySource[c.id] = parseOffsets(raw, SOURCE_OFFSET_DEFAULTS[c.id] ?? '-2,1,5,15');
  }
  return {
    enabled: flag(env.DROPWATCH_RELEASE_WINDOW, false),
    offsetsMinutes: parseOffsets(env.DROPWATCH_RELEASE_OFFSETS_MINUTES, '-2,1,5,15'),
    offsetsBySource,
    maxChecksPerRelease: clamp(num(env.DROPWATCH_RELEASE_MAX_CHECKS, 4), 0, 8),
    maxExtraPerSitePerHour: clamp(num(env.DROPWATCH_RELEASE_MAX_EXTRA_PER_HOUR, 4), 0, 8),
    slotToleranceMinutes: clamp(num(env.DROPWATCH_RELEASE_SLOT_TOLERANCE_MINUTES, 3), 1, 15),
  };
}

export function loadConfig(env = process.env, overrides = {}) {
  const sources = {};
  for (const c of CONNECTORS) {
    const k = envKey(c.id);
    const floor = MIN_INTERVAL_MINUTES[c.access.method] ?? 60;
    sources[c.id] = {
      enabled: flag(env[`DROPWATCH_SOURCE_${k}`], true),       // kill switch: off disables the connector entirely
      live: flag(env[`DROPWATCH_LIVE_${k}`], false),           // live retrieval is opt-in per source
      intervalMinutes: Math.max(floor, num(env[`DROPWATCH_INTERVAL_${k}_MINUTES`], 360)),
    };
  }
  return {
    port: num(env.DROPWATCH_MONITOR_PORT, 4200),
    dataDir: env.DROPWATCH_MONITOR_DATA || join(ROOT, 'data', 'monitor'),
    staleAfterHours: num(env.DROPWATCH_STALE_AFTER_HOURS, 24),
    maxObservationAgeHours: num(env.DROPWATCH_MAX_OBSERVATION_AGE_HOURS, 6),
    minAlertConfidence: num(env.DROPWATCH_MIN_ALERT_CONFIDENCE, 0.7),
    alertDedupeHours: num(env.DROPWATCH_ALERT_DEDUPE_HOURS, 24),
    requestTimeoutMs: num(env.DROPWATCH_REQUEST_TIMEOUT_MS, 15_000),
    maxResponseBytes: num(env.DROPWATCH_MAX_RESPONSE_BYTES, 5_000_000),
    userAgent: env.DROPWATCH_USER_AGENT || `DropwatchMonitor/0.1 (+${env.DROPWATCH_CONTACT || 'contact not configured'})`,
    scheduler: { enabled: flag(env.DROPWATCH_SCHEDULER, false), tickSeconds: Math.max(30, num(env.DROPWATCH_SCHEDULER_TICK_SECONDS, 60)) },
    // Never two requests to the same site closer than this, whatever the schedule (floor 30 s).
    minRequestGapSeconds: Math.max(30, num(env.DROPWATCH_MIN_REQUEST_GAP_SECONDS, 60)),
    releaseWindow: releaseWindowConfig(env),
    signals: signalConfig(env),
    ticketmasterApiKey: env.TICKETMASTER_API_KEY || null,
    devRoutes: flag(env.DROPWATCH_DEV_ROUTES, false),
    logLevel: env.DROPWATCH_LOG_LEVEL || 'info',
    sources,
    ...overrides,
  };
}
