// Structured JSON logs, one line per entry. Secrets are removed before anything is written: keys that look
// like credentials, and credential-looking query parameters inside strings.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const SECRET_KEY = /(api[-_]?key|apikey|token|secret|password|passwd|cookie|authori[sz]ation|session)/i;
const SECRET_PARAM = /([?&](?:apikey|api_key|key|token|access_token|signature|sig)=)[^&\s"']+/gi;

export function redact(v, depth = 0) {
  if (depth > 6) return '[depth]';
  if (typeof v === 'string') return v.replace(SECRET_PARAM, '$1REDACTED');
  if (Array.isArray(v)) return v.map(x => redact(x, depth + 1));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? 'REDACTED' : redact(x, depth + 1)]));
  }
  return v;
}

export function createLogger({ level = 'info', sink = line => process.stdout.write(line + '\n'), base = {} } = {}) {
  const min = LEVELS[level] ?? 20;
  const write = lvl => (msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...redact({ ...base, ...fields }) }));
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

export const silentLogger = createLogger({ level: 'silent' });
