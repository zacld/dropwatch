// Platform emails as trigger input (Phase 4 of docs/PLAN_FATSOMA_DETECTION.md). An email never alerts: it only
// arms an immediate verification check of the event it names (scheduler.addExternalTrigger).
//
// Reads one raw RFC 822 message (an .eml file): headers, multipart bodies, quoted-printable and base64 parts,
// encoded-word subjects. Extracts direct Fatsoma event links. Tracking/redirect links (common in marketing
// emails) are NOT followed, because that would be a request; they are reported so the first real Fatsoma email
// can show whether its links are direct. Unverified against real Fatsoma emails until one has been received.

export function parseEmail(raw) {
  const { headers, body } = splitMessage(String(raw));
  const parts = [];
  collectParts(headers, body, parts);
  const text = parts.map(p => p.text).join('\n');
  const date = Date.parse(headers.date ?? '');
  return {
    subject: decodeWords(headers.subject ?? ''),
    from: decodeWords(headers.from ?? ''),
    date: Number.isFinite(date) ? new Date(date).toISOString() : null,
    parts: parts.map(p => p.type),
    text,
  };
}

const EVENT_LINK = /https?:\/\/(?:www\.)?fatsoma\.com\/e\/([a-z0-9]{6,12})(?:\/[^\s"'<>)\]]*)?/gi;
const ANY_LINK = /https?:\/\/[^\s"'<>)\]]+/gi;

export function fatsomaEventLinks(email) {
  const direct = new Map();
  for (const m of email.text.matchAll(EVENT_LINK)) {
    const url = m[0].replace(/[.,;]+$/, '');
    if (!direct.has(m[1].toLowerCase())) direct.set(m[1].toLowerCase(), { vanity: m[1].toLowerCase(), url: url.replace(/^http:/, 'https:').replace('://fatsoma.com', '://www.fatsoma.com') });
  }
  const other = [...new Set([...email.text.matchAll(ANY_LINK)].map(m => m[0]))]
    .filter(u => !/fatsoma\.com\/e\//i.test(u))
    .map(u => { try { return new URL(u).host; } catch { return null; } })
    .filter(Boolean);
  return { events: [...direct.values()], unresolved_link_hosts: [...new Set(other)] };
}

// ---- minimal MIME ----
function splitMessage(raw) {
  const i = raw.search(/\r?\n\r?\n/);
  const head = i < 0 ? raw : raw.slice(0, i);
  const body = i < 0 ? '' : raw.slice(i).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return { headers, body };
}

function param(header, name) {
  const m = String(header ?? '').match(new RegExp(`${name}\\s*=\\s*(?:"([^"]+)"|([^;\\s]+))`, 'i'));
  return m ? m[1] ?? m[2] : null;
}

function collectParts(headers, body, out, depth = 0) {
  const type = String(headers['content-type'] ?? 'text/plain').split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/') && depth < 5) {
    const boundary = param(headers['content-type'], 'boundary');
    if (!boundary) return;
    for (const chunk of body.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith('--')) break;
      const part = splitMessage(chunk.replace(/^\r?\n/, ''));
      collectParts(part.headers, part.body, out, depth + 1);
    }
    return;
  }
  if (!type.startsWith('text/')) return;
  const enc = String(headers['content-transfer-encoding'] ?? '').toLowerCase();
  let text = body;
  if (enc === 'base64') text = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  else if (enc === 'quoted-printable') text = decodeQP(body);
  if (type === 'text/html') text = text.replace(/&amp;/g, '&');
  out.push({ type, text });
}

function decodeQP(s) {
  const bytes = [];
  const src = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '=' && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3))) { bytes.push(parseInt(src.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(...Buffer.from(src[i], 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeWords(s) {
  return String(s).replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, mode, data) =>
    mode.toUpperCase() === 'B' ? Buffer.from(data, 'base64').toString('utf8') : decodeQP(data.replace(/_/g, ' ')));
}
