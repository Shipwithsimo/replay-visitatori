// End-to-end check: fake storefront -> recorder -> server -> live view and replay.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const SERVER = 'http://localhost:3100';
const SHOP = 'http://localhost:3200';
const OUT = process.env.SCREENSHOT_DIR || os.tmpdir();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));

const page = (title, body) => `<!doctype html><html><head><title>${title}</title>
<style>body{font-family:sans-serif;margin:0} header{background:#111;color:#fff;padding:20px} .p{height:600px;margin:20px;background:#f0e6d8;padding:20px}</style>
<script>window.ReplayConfig={endpoint:${JSON.stringify(SERVER)},shop:'test-shop.myshopify.com',country:'IT',customer:{name:'Mario Rossi',email:'mario@example.com'}};</script>
<script src="${SERVER}/recorder.js" defer></script></head><body><header>NEGOZIO TEST</header>${body}</body></html>`;

const shop = http.createServer((req, res) => {
  if (req.url === '/cart.js') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ item_count: 2, total_price: 4990, currency: 'EUR' }));
  }
  res.setHeader('Content-Type', 'text/html');
  if (req.url.startsWith('/products/maglia')) {
    return res.end(page('Maglia rossa', '<h1 id="pdp">Maglia rossa</h1><input id="email" placeholder="email"><div class="p">Dettagli</div>'));
  }
  res.end(page('Home', '<h1>Benvenuto</h1><a id="go" href="/products/maglia">Vai alla maglia</a><div class="p">Sezione 1</div><div class="p">Sezione 2</div>'));
});

function check(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('ok -', msg);
}

const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, PORT: '3100', DATA_DIR: dataDir, DEV_NO_AUTH: '1' },
  stdio: 'inherit'
});

try {
  await new Promise((r) => shop.listen(3200, r));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(SERVER + '/healthz')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  const browser = await chromium.launch();
  const visitor = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  visitor.on('console', (m) => console.log('visitor console:', m.text()));
  visitor.on('pageerror', (e) => console.error('visitor error:', e.message));
  await visitor.goto(SHOP + '/');
  await visitor.waitForTimeout(1500);
  await visitor.mouse.move(200, 200);
  await visitor.mouse.move(600, 400, { steps: 10 });
  await visitor.mouse.wheel(0, 500);
  await visitor.waitForTimeout(1500);

  const sessions = await (await fetch(SERVER + '/api/sessions')).json();
  check(sessions.sessions.length === 1, 'one session recorded');
  const s = sessions.sessions[0];
  check(s.online, 'session is online');
  check(s.customer?.name === 'Mario Rossi', 'customer captured');
  check(s.cart?.total === 4990, 'cart captured');

  const dash = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  dash.on('pageerror', (e) => console.error('dashboard error:', e.message));
  await dash.goto(SERVER + '/');
  await dash.waitForSelector('#sessions li');
  check((await dash.textContent('#online-count')) === '1', 'dashboard shows 1 online');
  await dash.click('#sessions li');
  const liveFrame = await dash.waitForSelector('.replayer-wrapper iframe', { timeout: 10000 });
  const frame = await liveFrame.contentFrame();
  await frame.waitForSelector('text=Benvenuto', { timeout: 10000 });
  check(true, 'live view renders the visitor page');

  // Visitor navigates; live view must follow to the new page.
  await visitor.click('#go');
  await visitor.fill('#email', 'segreto@example.com');
  await visitor.waitForTimeout(4000);
  const frame2 = await (await dash.$('.replayer-wrapper iframe')).contentFrame();
  await frame2.waitForSelector('#pdp', { timeout: 10000 });
  check(true, 'live view follows navigation');
  const masked = await frame2.$eval('#email', (el) => el.value);
  check(!masked.includes('segreto'), 'input values are masked (' + JSON.stringify(masked) + ')');
  await dash.waitForSelector('#v-pages li:nth-child(2)', { timeout: 10000 });
  check(true, 'page list shows both pages');
  await dash.screenshot({ path: path.join(OUT, 'live.png') });

  // Replay from the start.
  await dash.click('#btn-replay');
  await dash.waitForSelector('.rr-player', { timeout: 10000 });
  await dash.waitForTimeout(1500);
  check(await dash.$('.rr-controller'), 'replay player with controls');
  await dash.screenshot({ path: path.join(OUT, 'replay.png') });

  await browser.close();
  console.log('\nALL OK. Screenshots in', OUT);
} finally {
  server.kill();
  shop.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
