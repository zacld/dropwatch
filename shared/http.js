// Minimal JSON HTTP helpers shared by the Dropwatch server and the test seller (no dependencies).

export async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    const err = new Error('Request body is not valid JSON.');
    err.status = 400;
    throw err;
  }
}

export function send(res, status, data, type = 'application/json') {
  const body = type === 'application/json' ? JSON.stringify(data) : data;
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(body);
}

// routes: [[method, '/api/things/:id', handler(ctx)]] → handler gets { req, res, params, query, body }
export function router(routes) {
  const compiled = routes.map(([method, path, handler]) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    return { method, re, keys, handler };
  });
  return async (req, res) => {
    const url = new URL(req.url, 'http://local');
    for (const r of compiled) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      try {
        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readJson(req) : {};
        const out = await r.handler({ req, res, params, query: url.searchParams, body });
        // Handlers return data, or { httpStatus, body } to set the status code.
        const envelope = out && typeof out.httpStatus === 'number';
        if (!res.writableEnded) send(res, envelope ? out.httpStatus : 200, envelope ? out.body : out ?? {});
      } catch (err) {
        if (!res.writableEnded) send(res, err.status ?? 500, { error: err.code ?? 'error', message: err.message });
      }
      return;
    }
    send(res, 404, { error: 'not_found', message: `No route for ${req.method} ${url.pathname}` });
  };
}

export function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export async function listen(server, port, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return `http://${host}:${server.address().port}`;
}
