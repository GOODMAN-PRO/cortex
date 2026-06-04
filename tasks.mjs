// CORTEX tasks layer — derive actionable tasks from markdown note content.
// NO separate task store, NO new tables, NO DB writes. Tasks are extracted live from
// each note's markdown by scanning for checkbox lines, every time a function is called.
//
// Recognized checkbox syntax (must be the first non-whitespace on the line):
//   - [ ] open task          (also supports *  and  +  as the bullet marker)
//   - [x] done task          (x or X = done)
//
// Optional due date inside the task text, first match wins, any of:
//   @due(2026-06-30)         -> 2026-06-30
//   due:2026-06-30           -> 2026-06-30
//   ... text (2026-06-30)    -> 2026-06-30   (trailing parenthesized date)
//
// Public API:
//   listTasks(opts)  -> [{ note_id, note_title, text, done, due, line }]
//   taskStats()      -> { total, open, done, overdue, dueToday }
import { allNotesFull } from './db.mjs';

// A markdown checkbox line: optional indent, a bullet (-, *, +), a [ ]/[x]/[X] box,
// then the task text. Capture group 1 = the box char, group 2 = the trailing text.
const CHECKBOX_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;

// Due-date extractors, tried in priority order. Each captures the YYYY-MM-DD in group 1.
const DUE_EXPLICIT_RE = /@due\(\s*(\d{4}-\d{2}-\d{2})\s*\)/;        // @due(YYYY-MM-DD)
const DUE_PREFIX_RE   = /\bdue:\s*(\d{4}-\d{2}-\d{2})\b/i;          // due:YYYY-MM-DD
const DUE_TRAILING_RE = /\((\d{4}-\d{2}-\d{2})\)\s*$/;             // trailing (YYYY-MM-DD)

// Local "today" as YYYY-MM-DD, computed at call-time so the module never goes stale.
function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Pull the first due date out of a task's text, or null. Strip the @due(...)/due:
// markers from the returned text isn't required by the contract, so text is kept verbatim.
function parseDue(text) {
  let m = DUE_EXPLICIT_RE.exec(text);
  if (m) return m[1];
  m = DUE_PREFIX_RE.exec(text);
  if (m) return m[1];
  m = DUE_TRAILING_RE.exec(text);
  if (m) return m[1];
  return null;
}

// Scan every note's markdown content for checkbox lines and build task records.
function extractAll() {
  const out = [];
  const notes = allNotesFull();
  for (const note of notes) {
    const content = typeof note.content === 'string' ? note.content : '';
    if (!content) continue;
    const lines = content.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = CHECKBOX_RE.exec(lines[i]);
      if (!m) continue;
      const done = m[1] === 'x' || m[1] === 'X';
      const text = m[2].trim();
      out.push({
        note_id: note.id,
        note_title: note.title,
        text,
        done,
        due: parseDue(text),
        line: i + 1, // 1-based line number within the note
      });
    }
  }
  return out;
}

// listTasks(opts):
//   opts.status  === 'open' | 'done'  -> filter by completion
//   opts.overdue === true             -> only OPEN tasks with a due date strictly before today
export function listTasks(opts = {}) {
  let tasks = extractAll();

  if (opts.status === 'open') tasks = tasks.filter(t => !t.done);
  else if (opts.status === 'done') tasks = tasks.filter(t => t.done);

  if (opts.overdue === true) {
    const td = today();
    tasks = tasks.filter(t => !t.done && t.due !== null && t.due < td);
  }

  return tasks;
}

// taskStats(): roll-up counts over all extracted tasks.
//   overdue  = open tasks whose due date is before today
//   dueToday = open tasks whose due date is exactly today
export function taskStats() {
  const tasks = extractAll();
  const td = today();
  let open = 0, done = 0, overdue = 0, dueToday = 0;
  for (const t of tasks) {
    if (t.done) { done++; continue; }
    open++;
    if (t.due !== null) {
      if (t.due < td) overdue++;
      else if (t.due === td) dueToday++;
    }
  }
  return { total: tasks.length, open, done, overdue, dueToday };
}
