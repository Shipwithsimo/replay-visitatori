import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as store from './db.js';
import { authConfig, checkPassword, isAuthorized, loginCookie, requireAuth } from './auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Package `exports` hide dist files from require.resolve, so point at them directly.
const mod = (p) => path.join(ROOT, 'node_modules', p);
const PORT = Number(process.env.PORT || 3000);
const ONLINE_MS = 30_000;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const read = (p) => fs.readFileSync(p, 'utf8');
const recorderJs =
  read(mod('@rrweb/record/dist/record.umd.min.cjs')) + ';\n' + read(path.join(ROOT, 'recorder/tracker.js'));

const app = express();
app.disable('x-powered-by');

// ---- Storefront ingestion -------------------------------------------------

function originAllowed(req) {
  if (!ALLOWED_ORIGINS.length) return true;
  const origin = (req.headers.origin || '').toLowerCase();
  return ALLOWED_ORIGINS.includes(origin);
}

app.get('/recorder.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'public, max-age=300').send(recorderJs);
});

app.options('/ingest', (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.sendStatus(204);
});

app.post('/ingest', express.text({ type: '*/*', limit: '20mb' }), (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (!originAllowed(req)) return res.sendStatus(403);
  let p;
  try {
    p = JSON.parse(req.body);
  } catch {
    return res.sendStatus(400);
  }
  if (!p || typeof p.sid !== 'string' || !Array.isArray(p.events) || p.sid.length > 64) return res.sendStatus(400);
  const now = Date.now();
  store.ingest(p, now);
  live.publish(p.sid, p.events);
  res.sendStatus(204);
});

// ---- Dashboard ------------------------------------------------------------

app.use(express.urlencoded({ extended: false }));

app.get('/', (req, res) => {
  const shop = String(req.query.shop || '');
  if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    res.set('Content-Security-Policy', `frame-ancestors https://${shop} https://admin.shopify.com;`);
  }
  const embedded = Boolean(req.query.host || req.query.embedded);
  if (!embedded && !isAuthorized(req)) return res.redirect('/login');
  const html = read(path.join(ROOT, 'public/dashboard.html'))
    .replace('__API_KEY__', authConfig.apiKey)
    .replace('__EMBEDDED__', embedded ? 'true' : 'false')
    .replace('__APP_BRIDGE__', embedded ? '<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>' : '');
  res.type('html').send(html);
});

app.get('/login', (req, res) => {
  res.type('html').send(read(path.join(ROOT, 'public/login.html')).replace('__ERROR__', req.query.e ? 'Password errata' : ''));
});

app.post('/login', (req, res) => {
  if (!checkPassword(req.body.password)) return res.redirect('/login?e=1');
  res.set('Set-Cookie', loginCookie()).redirect('/');
});

app.use('/static', express.static(path.join(ROOT, 'public'), { maxAge: '5m' }));
app.get('/vendor/rrweb.js', (req, res) => res.type('application/javascript').sendFile(mod('rrweb/dist/rrweb.umd.min.cjs')));
app.get('/vendor/rrweb.css', (req, res) => res.type('text/css').sendFile(mod('rrweb/dist/style.min.css')));
app.get('/vendor/player.js', (req, res) =>
  res.type('application/javascript').sendFile(mod('rrweb-player/dist/rrweb-player.umd.min.cjs'))
);
app.get('/vendor/player.css', (req, res) => res.type('text/css').sendFile(mod('rrweb-player/dist/style.min.css')));

app.get('/api/sessions', requireAuth, (req, res) => {
  const days = Math.min(Number(req.query.days || 1), RETENTION_DAYS);
  const now = Date.now();
  const sessions = store.listSessions({ since: now - days * 86_400_000, limit: 500 }).map((s) => ({
    ...s,
    online: now - s.last_seen < ONLINE_MS,
    watchers: live.watchers(s.id)
  }));
  res.json({ now, sessions });
});

app.get('/api/sessions/:id', requireAuth, (req, res) => {
  const s = store.getSession(req.params.id);
  if (!s) return res.sendStatus(404);
  res.json({ ...s, online: Date.now() - s.last_seen < ONLINE_MS });
});

app.get('/api/sessions/:id/events', requireAuth, (req, res) => {
  res.json(store.allEvents(req.params.id));
});

app.get('/healthz', (req, res) => res.send('ok'));

// ---- Live streaming -------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const live = {
  subs: new Map(),
  publish(sid, events) {
    const set = this.subs.get(sid);
    if (!set || !events.length) return;
    const msg = JSON.stringify({ type: 'events', events });
    for (const ws of set) if (ws.readyState === 1) ws.send(msg);
  },
  add(sid, ws) {
    if (!this.subs.has(sid)) this.subs.set(sid, new Set());
    this.subs.get(sid).add(ws);
  },
  remove(sid, ws) {
    const set = this.subs.get(sid);
    if (!set) return;
    set.delete(ws);
    if (!set.size) this.subs.delete(sid);
  },
  watchers(sid) {
    return this.subs.get(sid)?.size || 0;
  }
};

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/live' || !isAuthorized(req, url.searchParams.get('token'))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  const sid = url.searchParams.get('session') || '';
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({ type: 'backlog', events: store.eventsFromLastSnapshot(sid) }));
    live.add(sid, ws);
    const ping = setInterval(() => ws.readyState === 1 && ws.ping(), 25_000);
    ws.on('close', () => {
      clearInterval(ping);
      live.remove(sid, ws);
    });
  });
});

// ---- Retention ------------------------------------------------------------

function purge() {
  const n = store.purgeOlderThan(Date.now() - RETENTION_DAYS * 86_400_000);
  if (n) console.log(`purged ${n} old sessions`);
}
purge();
setInterval(purge, 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`replay server on :${PORT}`);
  if (!authConfig.noAuth && !authConfig.hasPassword && !authConfig.apiKey) {
    console.warn('WARNING: set DASHBOARD_PASSWORD or SHOPIFY_API_KEY/SECRET, otherwise nobody can open the dashboard');
  }
});
