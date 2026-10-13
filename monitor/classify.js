// Classifies a retrieved response before any parsing. A challenge, CAPTCHA, block or error page is
// never handed to a parser, so it can never become an event or a change.
//
// Several sites load a bot-protection script on ordinary pages (an AWS WAF integration script was
// observed on a normal Skiddle event page). A marker alone therefore only counts when the page does
// not also contain the content the connector expects, or the HTTP status itself signals a challenge.

export const CLASSIFICATIONS = [
  'ok', 'challenge', 'captcha', 'blocked', 'rate_limited', 'not_found', 'server_error',
  'empty', 'unexpected_content', 'network_error', 'timeout', 'disabled',
];

const CAPTCHA = [
  [/g-recaptcha|grecaptcha\.(?:render|execute)/i, 'reCAPTCHA widget'],
  [/h-captcha|hcaptcha\.com/i, 'hCaptcha widget'],
  [/cf-turnstile|challenges\.cloudflare\.com\/turnstile/i, 'Cloudflare Turnstile'],
  [/captcha-delivery\.com|datadome/i, 'DataDome CAPTCHA'],
  [/px-captcha|perimeterx/i, 'PerimeterX/HUMAN challenge'],
  [/\b(?:please )?(?:complete|solve) (?:the|this) (?:captcha|security check)\b/i, 'CAPTCHA prompt text'],
  [/<title>[^<]*captcha[^<]*<\/title>/i, 'CAPTCHA page title'],
];
const CHALLENGE = [
  [/window\.gokuProps|AwsWafIntegration\.(?:checkForceRefresh|forceRefreshToken)/i, 'AWS WAF challenge bootstrap'],
  [/cf-chl-|<title>Just a moment\.\.\.<\/title>|cf_chl_opt/i, 'Cloudflare challenge'],
  [/Pardon (?:the|our) Interruption/i, '"Pardon the interruption" page'],
  [/_Incapsula_Resource|Incapsula incident ID/i, 'Imperva/Incapsula interstitial'],
  [/<title>\s*Access Denied\s*<\/title>|Reference #\d+\.[0-9a-f]+/i, 'Akamai access denied'],
  [/(?:verify|confirm) (?:that )?you are (?:a )?human|are you a robot/i, 'human-verification text'],
  [/unusual (?:traffic|activity) from your (?:computer|network|device)/i, 'unusual-traffic text'],
];

// response: { status, headers?, body, error? }  expected(body) → true when the connector's content is present
export function classifyResponse(response, expected = () => true) {
  const evidence = [];
  if (response.error) {
    const timeout = /abort|timeout/i.test(String(response.error));
    return { classification: timeout ? 'timeout' : 'network_error', evidence: [String(response.error)] };
  }
  const status = Number(response.status ?? 200);
  const body = String(response.body ?? '');
  const captcha = CAPTCHA.filter(([re]) => re.test(body)).map(([, label]) => label);
  const challenge = CHALLENGE.filter(([re]) => re.test(body)).map(([, label]) => label);
  const hasContent = body.trim().length > 0 && safe(() => expected(body));

  if (status === 429) {
    const retryAfter = header(response, 'retry-after');
    return { classification: 'rate_limited', evidence: [`HTTP 429${retryAfter ? `, Retry-After ${retryAfter}` : ''}`], retryAfter };
  }
  if (captcha.length && (!hasContent || status >= 400 || status === 202)) return { classification: 'captcha', evidence: captcha };
  if (challenge.length && (!hasContent || status >= 400 || status === 202)) return { classification: 'challenge', evidence: challenge };
  if (status === 202 && !hasContent) return { classification: 'challenge', evidence: ['HTTP 202 with no event content (typical of an interstitial)'] };
  if (status === 401 || status === 403 || status === 451) return { classification: 'blocked', evidence: [`HTTP ${status}`] };
  if (status === 404 || status === 410) return { classification: 'not_found', evidence: [`HTTP ${status}`] };
  if (status >= 500) return { classification: 'server_error', evidence: [`HTTP ${status}`] };
  if (status >= 400) return { classification: 'blocked', evidence: [`HTTP ${status}`] };
  if (!body.trim()) return { classification: 'empty', evidence: ['empty body'] };
  if (!hasContent) return { classification: 'unexpected_content', evidence: ['expected event content not found'] };
  if (captcha.length || challenge.length) evidence.push(`protection script present but content served: ${[...captcha, ...challenge].join(', ')}`);
  return { classification: 'ok', evidence };
}

function header(r, name) {
  const h = r.headers ?? {};
  return typeof h.get === 'function' ? h.get(name) : h[name] ?? h[name.toLowerCase()] ?? null;
}
function safe(f) { try { return !!f(); } catch { return false; } }
