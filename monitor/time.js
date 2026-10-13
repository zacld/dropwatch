// Timestamp handling for source data. Everything is stored as UTC ISO strings; the source timezone is
// kept alongside. A local time with no offset is resolved in the source's default timezone and flagged
// as assumed, because the page never told us the offset.

const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

const fmtCache = new Map();
function partsIn(utcMs, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

// Offset of `tz` from UTC at the given instant, in milliseconds.
export function tzOffsetMs(utcMs, tz) {
  const p = partsIn(utcMs, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(utcMs / 1000) * 1000;
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}

// Wall-clock time in `tz` → UTC ms. Reports times that fall in a DST gap (do not exist) or overlap
// (happen twice; the earlier instant is used).
export function zonedToUtc({ y, mo, d, h = 0, mi = 0, s = 0 }, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const candidates = new Set();
  for (const probe of [wall - 36e5 * 14, wall, wall + 36e5 * 14]) candidates.add(wall - tzOffsetMs(probe, tz));
  const matches = [...candidates].filter(t => {
    const p = partsIn(t, tz);
    return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi && p.s === s;
  }).sort((a, b) => a - b);
  if (matches.length) return { utcMs: matches[0], warning: matches.length > 1 ? 'ambiguous_local_time' : null };
  // Gap: clocks skipped this wall time. Use the offset from before the jump and say so.
  return { utcMs: wall - tzOffsetMs(wall - 36e5 * 3, tz), warning: 'nonexistent_local_time' };
}

const toIso = ms => new Date(ms).toISOString();

// Parse a timestamp as a source published it.
// Returns { utc, timezone, offsetExplicit, assumedTimezone, warning } — utc is null when unparseable.
export function parseSourceTime(value, defaultTz) {
  const out = { utc: null, timezone: null, offsetExplicit: false, assumedTimezone: false, warning: null };
  if (value === null || value === undefined || value === '') return { ...out, warning: 'missing' };
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000; // seconds vs milliseconds
    return { ...out, utc: toIso(ms), offsetExplicit: true, timezone: defaultTz ?? null };
  }
  const str = String(value).trim();
  let m = str.match(ISO_WITH_OFFSET);
  if (m) {
    const ms = Date.parse(str.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (Number.isNaN(ms)) return { ...out, warning: 'invalid_time' };
    return { ...out, utc: toIso(ms), offsetExplicit: true, timezone: defaultTz ?? null };
  }
  m = str.match(ISO_NAIVE);
  if (m) {
    if (!isValidTimeZone(defaultTz)) return { ...out, warning: 'no_timezone_for_local_time' };
    const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
    const parts = { y: +y, mo: +mo, d: +d, h: +h, mi: +mi, s: +s };
    if (parts.mo < 1 || parts.mo > 12 || parts.d < 1 || parts.d > 31 || parts.h > 23 || parts.mi > 59) return { ...out, warning: 'invalid_time' };
    const r = zonedToUtc(parts, defaultTz);
    return { ...out, utc: toIso(r.utcMs), timezone: defaultTz, assumedTimezone: true, warning: r.warning };
  }
  return { ...out, warning: 'invalid_time' };
}

// Format a UTC ISO time in a timezone for human-facing text, e.g. "Sat 31 Oct 2026, 22:00 GMT".
export function formatInZone(utcIso, tz = 'Europe/London') {
  if (!utcIso) return 'unknown time';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: isValidTimeZone(tz) ? tz : 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(utcIso));
}
