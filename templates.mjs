// CORTEX templates — reusable note templates with {{variable}} substitution.
// Self-contained module: OWNS its own `templates` table, created lazily + idempotently
// via ensureTable() at the start of every exported function. Uses the live synchronous
// node:sqlite handle from getDb() (DatabaseSync; .prepare(sql).run/get/all).
//
// A template = { id, name (unique), title_tpl, content_tpl, tags, created }.
// applyTemplate() expands {{key}} tokens in the title/content using caller-supplied vars
// plus the built-ins {{date}} (local YYYY-MM-DD) and {{datetime}} (local YYYY-MM-DD HH:MM).
// It returns the rendered { title, content, tags } — it does NOT create a note; the caller does.
import { getDb } from './db.mjs';

const toTags = v => Array.isArray(v) ? v.join(',') : String(v || '');
const fromTags = s => (s || '').split(',').filter(Boolean);
const hydrate = r => r ? { ...r, tags: fromTags(r.tags) } : r;

let seeded = false;

// Built-in templates, seeded once when the table is first created empty.
// INSERT OR IGNORE keeps re-runs from duplicating (name is UNIQUE).
const BUILTINS = [
  {
    name: 'Meeting',
    title_tpl: 'Meeting - {{date}}',
    content_tpl: [
      '# Meeting - {{date}}',
      '',
      '## Attendees',
      '- ',
      '',
      '## Agenda',
      '- ',
      '',
      '## Notes',
      '',
      '## Action items',
      '- [ ] ',
    ].join('\n'),
    tags: 'meeting',
  },
  {
    name: 'Book',
    title_tpl: '{{title}}',
    content_tpl: [
      '# {{title}}',
      '',
      '## Summary',
      '',
      '## Key ideas',
      '- ',
      '',
      '## Quotes',
      '> ',
    ].join('\n'),
    tags: 'book,reading',
  },
];

// Create the table if missing, and seed built-ins exactly once per process when empty.
function ensureTable() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    title_tpl TEXT DEFAULT '',
    content_tpl TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    created INTEGER DEFAULT (unixepoch()*1000)
  )`);
  if (!seeded) {
    seeded = true;
    const empty = db.prepare('SELECT COUNT(*) AS c FROM templates').get().c === 0;
    if (empty) {
      const ins = db.prepare(
        'INSERT OR IGNORE INTO templates (name, title_tpl, content_tpl, tags) VALUES (?, ?, ?, ?)'
      );
      for (const t of BUILTINS) ins.run(t.name, t.title_tpl, t.content_tpl, t.tags);
    }
  }
}

// Two-digit zero-pad for local date/time formatting.
const pad = n => String(n).padStart(2, '0');

// Built-in token values resolved at apply time (local timezone).
function builtins(d = new Date()) {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const datetime = `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { date, datetime };
}

// Replace every {{key}} (optional inner whitespace) using the provided map.
// Unknown tokens are left untouched so nothing is silently dropped.
function substitute(tpl, map) {
  return String(tpl || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(map, key) && map[key] != null
      ? String(map[key])
      : whole
  );
}

// Upsert a template by name. Returns the stored row (tags hydrated to array).
export function addTemplate(name, { title_tpl = '', content_tpl = '', tags = '' } = {}) {
  ensureTable();
  const db = getDb();
  const key = String(name || '').trim();
  if (!key) throw new Error('addTemplate: name is required');
  db.prepare(`
    INSERT INTO templates (name, title_tpl, content_tpl, tags)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      title_tpl = excluded.title_tpl,
      content_tpl = excluded.content_tpl,
      tags = excluded.tags
  `).run(key, String(title_tpl || ''), String(content_tpl || ''), toTags(tags));
  return getTemplate(key);
}

// All templates, newest-named-first by creation; tags parsed to arrays.
export function listTemplates() {
  ensureTable();
  return getDb().prepare('SELECT * FROM templates ORDER BY created DESC, name ASC').all().map(hydrate);
}

// One template by name, or null if it doesn't exist.
export function getTemplate(name) {
  ensureTable();
  const row = getDb().prepare('SELECT * FROM templates WHERE name = ?').get(String(name || ''));
  return row ? hydrate(row) : null;
}

// Render a template's title/content with vars + built-ins. Returns { title, content, tags }
// (tags as an array), or null if the named template doesn't exist. Does NOT create a note.
export function applyTemplate(name, vars = {}) {
  ensureTable();
  const tpl = getTemplate(name);
  if (!tpl) return null;
  const map = { ...builtins(), ...(vars || {}) };
  return {
    title: substitute(tpl.title_tpl, map),
    content: substitute(tpl.content_tpl, map),
    tags: tpl.tags,
  };
}
