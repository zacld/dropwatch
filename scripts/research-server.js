// Serves the research pages locally: node scripts/research-server.js → http://127.0.0.1:4500
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'research');
const port = Number(process.env.PORT ?? 4500);

http.createServer((req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
  const file = normalize(join(dir, path === '/' ? 'source-map.html' : path));
  if (!file.startsWith(dir) || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(port, '127.0.0.1', () => console.log(`Research pages at http://127.0.0.1:${port}`));
