import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { privatePath } from './files.js';

// A browser app is a folder with an index.html in it: plain HTML, CSS and JavaScript that opens straight
// in one of her browser tabs. This serves that folder on this PC only (127.0.0.1), on a free port.
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.woff2': 'font/woff2',
};

export async function serveFolder(root) {
  const base = await realpath(root);
  const publicFile = (file) => {
    const relative = path.relative(base, file);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) &&
      !privatePath(file) && !relative.split(path.sep).some((part) => part.startsWith('.'));
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      let file = path.resolve(base, rel);
      if (!publicFile(file)) { res.writeHead(403).end('File is unavailable'); return; }
      if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, 'index.html');
      file = await realpath(file);
      if (!publicFile(file)) { res.writeHead(403).end('File is unavailable'); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export async function verifyBrowserApp(root) {
  const site = await serveFolder(root);
  try {
    const result = await fetch(site.url, { signal: AbortSignal.timeout(5000) });
    if (!result.ok) throw new Error(`Expected a working index.html in the project folder (HTTP ${result.status}).`);
    const html = await result.text();
    if (!html.trim()) throw new Error('The project index.html is empty.');
    return Buffer.byteLength(html);
  } finally {
    await site.close();
  }
}
