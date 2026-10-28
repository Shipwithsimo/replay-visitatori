import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'replay.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    visitor_id TEXT,
    shop TEXT,
    started_at INTEGER,
    last_seen INTEGER,
    url TEXT,
    title TEXT,
    referrer TEXT,
    ua TEXT,
    lang TEXT,
    vw INTEGER,
    vh INTEGER,
    country TEXT,
    customer TEXT,
    cart TEXT,
    page_count INTEGER DEFAULT 0,
    event_count INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions(last_seen);

  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    ts INTEGER,
    url TEXT,
    title TEXT
  );
  CREATE INDEX IF NOT EXISTS pages_session ON pages(session_id, ts);

  CREATE TABLE IF NOT EXISTS batches (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    first_ts INTEGER,
    has_snapshot INTEGER,
    events TEXT
  );
  CREATE INDEX IF NOT EXISTS batches_session ON batches(session_id, seq);
`);

const upsertSession = db.prepare(`
  INSERT INTO sessions (id, visitor_id, shop, started_at, last_seen)
  VALUES (@id, @visitor_id, @shop, @now, @now)
  ON CONFLICT(id) DO UPDATE SET last_seen = @now
`);
const updateMeta = db.prepare(`
  UPDATE sessions SET url=@url, title=@title, referrer=COALESCE(referrer, @referrer), ua=@ua,
    lang=@lang, vw=@vw, vh=@vh, country=@country, customer=@customer,
    page_count = page_count + 1
  WHERE id=@id
`);
const updateCart = db.prepare(`UPDATE sessions SET cart=@cart WHERE id=@id`);
const addCount = db.prepare(`UPDATE sessions SET event_count = event_count + @n WHERE id=@id`);
const insertPage = db.prepare(`
  INSERT OR IGNORE INTO pages (id, session_id, ts, url, title) VALUES (@id, @session_id, @ts, @url, @title)
`);
const insertBatch = db.prepare(`
  INSERT INTO batches (session_id, first_ts, has_snapshot, events) VALUES (?, ?, ?, ?)
`);

// Meta (4) is always emitted right before a FullSnapshot (2).
const META = 4;

export const ingest = db.transaction((p, now) => {
  upsertSession.run({ id: p.sid, visitor_id: p.vid, shop: p.shop, now });
  if (p.meta) {
    const m = p.meta;
    updateMeta.run({
      id: p.sid,
      url: m.url, title: m.title, referrer: m.referrer || null, ua: m.ua, lang: m.lang,
      vw: m.vw, vh: m.vh, country: m.country,
      customer: m.customer ? JSON.stringify(m.customer) : null
    });
    insertPage.run({ id: p.pid, session_id: p.sid, ts: now, url: m.url, title: m.title });
  }
  if (p.cart) updateCart.run({ id: p.sid, cart: JSON.stringify(p.cart) });
  if (p.events.length) {
    const hasSnapshot = p.events.some((e) => e.type === META) ? 1 : 0;
    insertBatch.run(p.sid, p.events[0].timestamp, hasSnapshot, JSON.stringify(p.events));
    addCount.run({ id: p.sid, n: p.events.length });
  }
});

function rowToSession(r) {
  return {
    ...r,
    customer: r.customer ? JSON.parse(r.customer) : null,
    cart: r.cart ? JSON.parse(r.cart) : null
  };
}

export function listSessions({ since = 0, limit = 200 } = {}) {
  return db
    .prepare(`SELECT * FROM sessions WHERE last_seen >= ? AND event_count > 0 ORDER BY last_seen DESC LIMIT ?`)
    .all(since, limit)
    .map(rowToSession);
}

export function getSession(id) {
  const r = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
  if (!r) return null;
  const pages = db.prepare(`SELECT ts, url, title FROM pages WHERE session_id = ? ORDER BY ts`).all(id);
  return { ...rowToSession(r), pages };
}

export function allEvents(id) {
  const rows = db.prepare(`SELECT events FROM batches WHERE session_id = ? ORDER BY seq`).all(id);
  return rows.flatMap((r) => JSON.parse(r.events));
}

// Everything from the most recent Meta + FullSnapshot onwards: enough to
// rebuild the page as it is right now and keep streaming from there.
export function eventsFromLastSnapshot(id) {
  const last = db
    .prepare(`SELECT MAX(seq) AS seq FROM batches WHERE session_id = ? AND has_snapshot = 1`)
    .get(id);
  if (!last || last.seq == null) return [];
  const rows = db
    .prepare(`SELECT events FROM batches WHERE session_id = ? AND seq >= ? ORDER BY seq`)
    .all(id, last.seq);
  const events = rows.flatMap((r) => JSON.parse(r.events));
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === META) { start = i; break; }
  }
  return events.slice(start);
}

export const purgeOlderThan = db.transaction((cutoff) => {
  const ids = db.prepare(`SELECT id FROM sessions WHERE last_seen < ?`).all(cutoff).map((r) => r.id);
  const delBatches = db.prepare(`DELETE FROM batches WHERE session_id = ?`);
  const delPages = db.prepare(`DELETE FROM pages WHERE session_id = ?`);
  const delSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);
  for (const id of ids) {
    delBatches.run(id);
    delPages.run(id);
    delSession.run(id);
  }
  return ids.length;
});
