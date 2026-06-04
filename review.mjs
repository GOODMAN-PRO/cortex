// CORTEX spaced-repetition resurfacing (SM-2-lite).
// Owns its own `review_state` table — created lazily/idempotently via ensureTable() at the
// top of every exported function. Talks to the DB only through getDb() at call-time, and reuses
// getNote() from the data layer. Synchronous node:sqlite throughout. No external deps.
//
// Timestamps are millisecond epochs (Date.now()), matching notes.created_at / updated_at in db.mjs.
import { getDb, getNote } from './db.mjs';

const DAY_MS = 86400000;

// Idempotent: safe to call on every invocation. CREATE TABLE IF NOT EXISTS is a no-op once it exists.
function ensureTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS review_state (
      note_id TEXT PRIMARY KEY,
      ease REAL DEFAULT 2.5,
      interval_days INTEGER DEFAULT 0,
      due INTEGER,
      reps INTEGER DEFAULT 0,
      last_reviewed INTEGER
    )
  `);
}

// Notes that are due for review: never-reviewed (no review_state row) OR due <= now.
// LEFT JOIN from notes guarantees we only ever surface notes that still exist. Never-reviewed
// rows sort first (NULL due treated as 0), then by soonest due.
export function dueForReview(limit = 10) {
  ensureTable();
  const now = Date.now();
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
  return getDb().prepare(`
    SELECT n.id AS id,
           n.title AS title,
           r.due AS due,
           COALESCE(r.reps, 0) AS reps,
           r.last_reviewed AS last_reviewed
    FROM notes n
    LEFT JOIN review_state r ON r.note_id = n.id
    WHERE r.note_id IS NULL OR r.due <= ?
    ORDER BY (r.note_id IS NULL) DESC, COALESCE(r.due, 0) ASC, n.created_at ASC
    LIMIT ?
  `).all(now, cap);
}

// Record a review with an SM-2 grade (0..5). Updates ease (clamped >= 1.3), interval, reps, due,
// last_reviewed. A failing grade (< 3) resets the schedule: interval -> 1 day, reps -> 0.
// Upserts the row and returns the updated review_state row.
export function recordReview(noteId, grade) {
  ensureTable();

  // Only track existing notes — mirror the FK-safety pattern in db.mjs (createLink).
  if (!getNote(noteId)) return null;

  const g = Math.max(0, Math.min(5, Math.round(Number(grade) || 0)));
  const now = Date.now();
  const db = getDb();

  const prev = db.prepare('SELECT * FROM review_state WHERE note_id = ?').get(noteId);
  const prevEase = prev ? prev.ease : 2.5;
  const prevInterval = prev ? prev.interval_days : 0;
  const prevReps = prev ? prev.reps : 0;

  // SM-2 ease update, clamped at the 1.3 floor.
  let ease = prevEase + (0.1 - (5 - g) * (0.08 + (5 - g) * 0.02));
  if (ease < 1.3) ease = 1.3;

  let interval;
  let reps;
  if (g < 3) {
    // Lapse: relearn from scratch.
    interval = 1;
    reps = 0;
  } else {
    reps = prevReps + 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.round(prevInterval * ease);
    if (interval < 1) interval = 1;
  }

  const due = now + interval * DAY_MS;

  db.prepare(`
    INSERT INTO review_state (note_id, ease, interval_days, due, reps, last_reviewed)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(note_id) DO UPDATE SET
      ease = excluded.ease,
      interval_days = excluded.interval_days,
      due = excluded.due,
      reps = excluded.reps,
      last_reviewed = excluded.last_reviewed
  `).run(noteId, ease, interval, due, reps, now);

  return db.prepare('SELECT * FROM review_state WHERE note_id = ?').get(noteId);
}

// Snapshot of the review system:
//   tracked        — review_state rows whose note still exists
//   dueNow         — tracked notes with due <= now (excludes never-reviewed; those aren't tracked yet)
//   reviewedToday  — tracked notes last_reviewed since the start of today (local time)
export function reviewStats() {
  ensureTable();
  const now = Date.now();
  const db = getDb();

  const tracked = db.prepare(`
    SELECT COUNT(*) AS c FROM review_state r
    JOIN notes n ON n.id = r.note_id
  `).get().c;

  const dueNow = db.prepare(`
    SELECT COUNT(*) AS c FROM review_state r
    JOIN notes n ON n.id = r.note_id
    WHERE r.due <= ?
  `).get(now).c;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const reviewedToday = db.prepare(`
    SELECT COUNT(*) AS c FROM review_state r
    JOIN notes n ON n.id = r.note_id
    WHERE r.last_reviewed >= ?
  `).get(startOfToday.getTime()).c;

  return { tracked, dueNow, reviewedToday };
}
