// CORTEX daily journal — daily notes + a daily rollup.
// Pure ESM over node builtins + ./db.mjs. DB is only touched via db.mjs exports at call-time,
// so importing this module never opens the database on its own.
import { createNote, getNote, temporalRange, listSuggestions, getRecent } from './db.mjs';

// Format a Date as a local 'YYYY-MM-DD' string (not UTC — we want the user's calendar day).
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Local-midnight [startMs, endMs] bounds for a 'YYYY-MM-DD' day.
// startMs = 00:00:00.000 local that day; endMs = 23:59:59.999 local (inclusive upper bound).
function dayBounds(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d, 23, 59, 59, 999);
  return [start.getTime(), end.getTime()];
}

// Resolve a dateStr argument, defaulting to today in local time.
function resolveDate(dateStr) {
  return (typeof dateStr === 'string' && dateStr) ? dateStr : toDateStr(new Date());
}

// Get (or lazily create) the daily journal note for a day. id = `daily-${dateStr}`.
export function getDaily(dateStr) {
  const date = resolveDate(dateStr);
  const id = `daily-${date}`;
  const existing = getNote(id);
  if (existing) return existing;
  return createNote(id, date, `# ${date}\n\n`);
}

// Roll up a day: notes created that day, pending suggestion count, and the recent stream.
export function dailyRollup(dateStr) {
  const date = resolveDate(dateStr);
  const [startMs, endMs] = dayBounds(date);
  // temporalRange filters by updated_at, so pull the window then narrow to created_at within bounds.
  const created = temporalRange(startMs, endMs)
    .filter(n => n.created_at >= startMs && n.created_at <= endMs)
    .map(n => ({ id: n.id, title: n.title }));
  const pendingSuggestions = listSuggestions('pending').length;
  return {
    date,
    created,
    createdCount: created.length,
    pendingSuggestions,
    recent: getRecent(5),
  };
}
