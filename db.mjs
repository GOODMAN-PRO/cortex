// CORTEX data layer — synchronous node:sqlite (built-in, no deps).
// Switched from callback `sqlite3` to `node:sqlite` DatabaseSync: this makes every db call
// synchronous, which also FIXES the latent bug where server.mjs called these functions without
// `await` (they used to return Promises serialized as `{}`). Same cortex.db file/format.
//
// Tables: notes (+ tz, project), links (graph edges), versions (content history),
// notes_fts (FTS5 full-text), vectors (embedding cache), suggestions (Gardener review queue).
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.CORTEX_DB || path.join(__dirname, 'cortex.db');

let db;

export function initDb() {
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'Untitled',
      content TEXT DEFAULT '',
      tags TEXT DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE IF NOT EXISTS links (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      type TEXT DEFAULT 'link',
      PRIMARY KEY (source, target),
      FOREIGN KEY(source) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY(target) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL,
      content TEXT,
      saved_at INTEGER DEFAULT (unixepoch() * 1000),
      FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_versions_note ON versions(note_id);
    CREATE INDEX IF NOT EXISTS idx_links_source ON links(source);
    CREATE INDEX IF NOT EXISTS idx_links_target ON links(target);
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      id UNINDEXED, title, content, tags, tokenize='porter unicode61'
    );
    CREATE TABLE IF NOT EXISTS vectors (
      note_id TEXT PRIMARY KEY,
      vector TEXT,
      model TEXT,
      created INTEGER DEFAULT (unixepoch() * 1000),
      FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
    );
  `);
  // One-time backfill: populate FTS from any notes that predate the FTS table.
  const ftsCount = db.prepare('SELECT count(*) AS c FROM notes_fts').get().c;
  const noteCount = db.prepare('SELECT count(*) AS c FROM notes').get().c;
  if (ftsCount === 0 && noteCount > 0) {
    db.exec('INSERT INTO notes_fts (id, title, content, tags) SELECT id, title, content, tags FROM notes;');
  }
  migrateColumns();
  db.exec(`
    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      source TEXT, target TEXT, label TEXT, score REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      created INTEGER DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_sugg_status ON suggestions(status);
    CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project);
    CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);
  `);
  return db;
}

// node:sqlite has no "ADD COLUMN IF NOT EXISTS" — add post-original columns idempotently.
function migrateColumns() {
  const cols = db.prepare('PRAGMA table_info(notes)').all().map(c => c.name);
  if (!cols.includes('tz')) db.exec('ALTER TABLE notes ADD COLUMN tz TEXT');
  if (!cols.includes('project')) db.exec('ALTER TABLE notes ADD COLUMN project TEXT');
}

export function getDb() { return db; }

const toTags = v => Array.isArray(v) ? v.join(',') : String(v || '');
const fromTags = s => (s || '').split(',').filter(Boolean);
const hydrate = n => n ? { ...n, tags: fromTags(n.tags) } : n;

function ftsUpsert(id, title, content, tagsStr) {
  db.prepare('DELETE FROM notes_fts WHERE id = ?').run(id);
  db.prepare('INSERT INTO notes_fts (id, title, content, tags) VALUES (?, ?, ?, ?)').run(id, title, content, tagsStr);
}

export function createNote(id, title, content = '', tags = [], tz = null) {
  const now = Date.now();
  const tagsStr = toTags(tags);
  // Upsert that PRESERVES created_at on conflict (the old INSERT OR REPLACE reset it every time).
  db.prepare(`
    INSERT INTO notes (id, title, content, tags, created_at, updated_at, tz)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content,
      tags=excluded.tags, updated_at=excluded.updated_at
  `).run(id, title, content, tagsStr, now, now, tz);
  ftsUpsert(id, title, content, tagsStr);
  return getNote(id);
}

export function updateNote(id, title, content = '', tags = [], tz = null) {
  const now = Date.now();
  const tagsStr = toTags(tags);
  const note = getNote(id);
  if (note) {
    db.prepare('INSERT INTO versions (note_id, content, saved_at) VALUES (?, ?, ?)').run(id, note.content, note.updated_at);
    db.prepare('UPDATE notes SET title=?, content=?, tags=?, updated_at=?, tz=COALESCE(?, tz) WHERE id=?')
      .run(title, content, tagsStr, now, tz, id);
  } else {
    db.prepare('INSERT INTO notes (id, title, content, tags, created_at, updated_at, tz) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, title, content, tagsStr, now, now, tz);
  }
  ftsUpsert(id, title, content, tagsStr);
  return getNote(id);
}

export function getNote(id) {
  return hydrate(db.prepare('SELECT * FROM notes WHERE id = ?').get(id));
}

export function listNotes(limit = 50, offset = 0) {
  return db.prepare('SELECT * FROM notes ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset).map(hydrate);
}

export function allNotesFull() {
  return db.prepare('SELECT * FROM notes').all().map(hydrate);
}

// Full-text search via FTS5. Terms stripped to letters/numbers (no operator leakage), prefix-matched
// with implicit AND, ranked by bm25. Falls back to LIKE if a MATCH expression is ever rejected.
export function searchNotes(query) {
  const terms = String(query || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!terms.length) return [];
  const match = terms.map(t => t + '*').join(' ');
  try {
    return db.prepare(`
      SELECT n.* FROM notes_fts JOIN notes n ON n.id = notes_fts.id
      WHERE notes_fts MATCH ? ORDER BY rank LIMIT 50
    `).all(match).map(hydrate);
  } catch {
    const q = `%${query}%`;
    return db.prepare(`SELECT * FROM notes WHERE title LIKE ? OR content LIKE ? OR tags LIKE ? ORDER BY updated_at DESC LIMIT 50`)
      .all(q, q, q).map(hydrate);
  }
}

export function deleteNote(id) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  db.prepare('DELETE FROM notes_fts WHERE id = ?').run(id);
}

// FK-safe: links require both endpoints to exist (foreign_keys=ON would otherwise throw).
export function createLink(sourceId, targetId, type = 'link') {
  const exists = id => !!db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id);
  if (!exists(sourceId) || !exists(targetId)) return false;
  db.prepare('INSERT OR IGNORE INTO links (source, target, type) VALUES (?, ?, ?)').run(sourceId, targetId, type);
  return true;
}

export function getLinks(noteId) {
  return db.prepare('SELECT * FROM links WHERE source = ? OR target = ?').all(noteId, noteId);
}

export function getBacklinks(noteId) {
  return db.prepare('SELECT source FROM links WHERE target = ?').all(noteId).map(r => r.source);
}

export function getGraph() {
  const nodes = db.prepare('SELECT id, title, project FROM notes').all();
  const edges = db.prepare('SELECT source, target, type FROM links').all();
  return { nodes, edges };
}

export function getVersions(noteId) {
  return db.prepare('SELECT * FROM versions WHERE note_id = ? ORDER BY saved_at DESC LIMIT 20').all(noteId);
}

export function restoreVersion(noteId, versionId) {
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId);
  if (!version) return null;
  const note = getNote(noteId);
  if (!note) return null;
  return updateNote(noteId, note.title, version.content, note.tags);
}

// ===== Phase 3: temporal =====

// Latest captures (the front "Stream" layer), newest-first by creation time.
export function getRecent(limit = 20) {
  return db.prepare('SELECT * FROM notes ORDER BY created_at DESC LIMIT ?').all(limit).map(hydrate);
}

export function temporalRange(from, to, limit = 500) {
  return db.prepare('SELECT * FROM notes WHERE updated_at BETWEEN ? AND ? ORDER BY updated_at DESC LIMIT ?')
    .all(from, to, limit).map(hydrate);
}

// A note's content AS OF an instant: current if `at` is recent enough, else the version whose validity
// window contains `at` (largest saved_at <= at). null if the note didn't exist yet.
export function noteAsOf(id, at) {
  const note = getNote(id);
  if (!note) return null;
  if (at < note.created_at) return null;
  if (at >= note.updated_at) return { ...note, as_of: at };
  const v = db.prepare('SELECT content, saved_at FROM versions WHERE note_id = ? AND saved_at <= ? ORDER BY saved_at DESC LIMIT 1').get(id, at);
  return { ...note, content: v ? v.content : note.content, as_of: at };
}

// The whole vault as it existed at `at` (time-travel).
export function timeTravel(at, limit = 500) {
  const ids = db.prepare('SELECT id FROM notes WHERE created_at <= ? ORDER BY created_at DESC LIMIT ?').all(at, limit).map(r => r.id);
  return ids.map(id => noteAsOf(id, at)).filter(Boolean);
}

// ===== Phase 4: projects / classification =====

export function setProject(id, project) {
  db.prepare('UPDATE notes SET project = ? WHERE id = ?').run(project, id);
}

export function listProjects() {
  return db.prepare(`
    SELECT project, COUNT(*) AS count, MAX(updated_at) AS updated
    FROM notes WHERE project IS NOT NULL AND project != ''
    GROUP BY project ORDER BY updated DESC
  `).all();
}

export function getNotesByProject(project, limit = 100) {
  return db.prepare('SELECT * FROM notes WHERE project = ? ORDER BY updated_at DESC LIMIT ?').all(project, limit).map(hydrate);
}

// ===== Phase 4: suggestions (human-in-the-loop review queue) =====

export function addSuggestion(kind, { source = null, target = null, label = null, score = null }) {
  const dup = db.prepare(`SELECT id FROM suggestions WHERE kind=? AND IFNULL(source,'')=IFNULL(?, '') AND IFNULL(target,'')=IFNULL(?, '') AND status='pending'`).get(kind, source, target);
  if (dup) return dup.id;
  return db.prepare('INSERT INTO suggestions (kind, source, target, label, score) VALUES (?, ?, ?, ?, ?)').run(kind, source, target, label, score).lastInsertRowid;
}

export function getSuggestion(id) {
  return db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
}

export function listSuggestions(status = 'pending', limit = 100) {
  return db.prepare('SELECT * FROM suggestions WHERE status = ? ORDER BY score DESC, created DESC LIMIT ?').all(status, limit);
}

export function setSuggestionStatus(id, status) {
  db.prepare('UPDATE suggestions SET status = ? WHERE id = ?').run(status, id);
  return getSuggestion(id);
}

export function clearSuggestions(kind) {
  if (kind) db.prepare("DELETE FROM suggestions WHERE kind = ? AND status = 'pending'").run(kind);
  else db.prepare("DELETE FROM suggestions WHERE status = 'pending'").run();
}

export function closeDb() {
  if (db) { try { db.close(); } catch { /* already closed */ } }
}
