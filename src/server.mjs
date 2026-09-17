import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

export async function startServer({ monitor, port = 4317, host = '127.0.0.1' }) {
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new TypeError('Shep can only bind to localhost');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port');
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    function send(code, body, type = 'text/plain; charset=utf-8') {
      response.writeHead(code, { 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : body);
    }
    const currentPort = server.address()?.port;
    const authority = request.headers.host;
    const allowedHosts = new Set([`localhost:${currentPort}`, `127.0.0.1:${currentPort}`]);
    if (!allowedHosts.has(authority)) return send(403, 'Host not allowed');
    if ((request.headers.origin && request.headers.origin !== `http://${authority}`)
      || request.headers['sec-fetch-site'] === 'cross-site') return send(403, 'Origin not allowed');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      return send(405, 'Method not allowed');
    }
    let pathname;
    try {
      if (!request.url.startsWith('/') || request.url.startsWith('//')) return send(400, 'Invalid URL');
      pathname = new URL(request.url, `http://${authority}`).pathname;
    } catch {
      return send(400, 'Invalid URL');
    }
    if (pathname === '/api/snapshot') return send(200, JSON.stringify(monitor.getSnapshot()), 'application/json; charset=utf-8');
    const asset = ASSETS.get(pathname);
    if (!asset) return send(404, 'Not found');
    try {
      const content = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
      send(200, content, asset[1]);
    } catch {
      send(503, 'Shep browser files are unavailable. Check the installation.');
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
