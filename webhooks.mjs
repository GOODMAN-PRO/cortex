// CORTEX webhooks — let users register URLs that fire on note events.
// This module OWNS its `webhooks` table: it is created lazily + idempotently by ensureTable(),
// which runs at the start of every exported function (so the module works regardless of whether
// initDb() in db.mjs has set its tables up — we only need the live DatabaseSync handle).
//
// Events: note.created / note.updated / note.deleted / suggestion.created (or '*' for all).
// Access the DB only via getDb() at call-time (never at import-time), and use the Node 24 globals
// `fetch` + `AbortController`. fireEvent() is fire-and-forget and MUST NOT throw.
import { getDb } from './db.mjs';

// Idempotent table creation. Cheap to call every time (CREATE TABLE IF NOT EXISTS is a no-op once
// the table exists), which keeps each exported function self-contained.
function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '*',
      active INTEGER NOT NULL DEFAULT 1,
      created INTEGER DEFAULT (unixepoch()*1000)
    )
  `);
  return db;
}

// Stored as a comma-joined string; hydrated back to an array on read.
const toEvents = v => (Array.isArray(v) ? v : [v]).map(e => String(e || '').trim()).filter(Boolean);
const fromEvents = s => String(s || '').split(',').map(e => e.trim()).filter(Boolean);
const hydrate = row => (row ? { ...row, events: fromEvents(row.events) } : row);

// Register a webhook. `events` is an array (defaults to ['*'] = all events). Returns the stored row.
export function addWebhook(url, events = ['*']) {
  const db = ensureTable();
  let list = toEvents(events);
  if (!list.length) list = ['*'];
  const info = db
    .prepare('INSERT INTO webhooks (url, events, active) VALUES (?, ?, 1)')
    .run(String(url), list.join(','));
  return hydrate(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(info.lastInsertRowid));
}

// All registered webhooks, newest first, with events parsed back to an array.
export function listWebhooks() {
  const db = ensureTable();
  return db.prepare('SELECT * FROM webhooks ORDER BY id DESC').all().map(hydrate);
}

// Delete a webhook by id. Returns { ok, removed }.
export function removeWebhook(id) {
  const db = ensureTable();
  const info = db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  const removed = Number(info.changes) || 0;
  return { ok: removed > 0, removed };
}

// POST `{ event, payload, ts }` to every active webhook subscribed to `event` (or '*').
// Fire-and-forget: each delivery is wrapped in try/catch with a ~4s AbortController timeout so a
// dead/slow URL can't hang the caller. Returns { fired:N } and MUST NOT throw.
export async function fireEvent(event, payload) {
  let hooks;
  try {
    const db = ensureTable();
    // Match the exact event or a literal '*' subscription. events is a comma list, so guard the
    // boundaries with commas to avoid 'note.create' matching 'note.created' etc.
    hooks = db
      .prepare(
        `SELECT * FROM webhooks
         WHERE active = 1
           AND (
             events = '*'
             OR (',' || events || ',') LIKE '%,*,%'
             OR (',' || events || ',') LIKE ?
           )`,
      )
      .all(`%,${event},%`);
  } catch {
    // If even the lookup fails we still must not throw.
    return { fired: 0 };
  }

  const body = JSON.stringify({ event, payload, ts: Date.now() });

  await Promise.allSettled(
    hooks.map(async hook => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        await fetch(hook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } catch {
        // Dead URL / timeout / network error — fire-and-forget, swallow it.
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  return { fired: hooks.length };
}
