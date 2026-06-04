// CORTEX 5-layer memory stack. Front layer = latest; deeper layers = more organized/older.
//   1 Stream   — latest captures (temporal front)
//   2 Projects — auto-classified clusters (by meaning)
//   3 Areas    — themes / tags
//   4 Library  — the whole networked graph (counts)
//   5 Archive  — rested notes (untouched > 30 days)
import { getDb, getRecent, listProjects, getNotesByProject, allNotesFull } from './db.mjs';

const DAY = 86400000;
const slim = n => ({ id: n.id, title: n.title, project: n.project || null, tags: n.tags || [], created_at: n.created_at, updated_at: n.updated_at });

export function getLayers() {
  const db = getDb();
  const now = Date.now();
  const total = db.prepare('SELECT COUNT(*) AS c FROM notes').get().c;
  const links = db.prepare('SELECT COUNT(*) AS c FROM links').get().c;

  const stream = getRecent(15).map(slim);

  const projects = listProjects().slice(0, 12).map(p => ({
    project: p.project, count: p.count, updated: p.updated,
    items: getNotesByProject(p.project, 5).map(slim),
  }));

  const tagCounts = new Map();
  for (const n of allNotesFull()) for (const t of (n.tags || [])) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const areas = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tag, count]) => ({ tag, count }));

  const cutoff = now - 30 * DAY;
  const archiveCount = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE updated_at < ?').get(cutoff).c;
  const archiveItems = db.prepare('SELECT id, title, updated_at FROM notes WHERE updated_at < ? ORDER BY updated_at ASC LIMIT 10').all(cutoff);

  return {
    generated_at: now,
    total,
    layers: [
      { n: 1, key: 'stream',   title: 'Stream',   subtitle: 'Latest captures',           count: stream.length, items: stream },
      { n: 2, key: 'projects', title: 'Projects', subtitle: 'Auto-classified by meaning', count: projects.length, items: projects },
      { n: 3, key: 'areas',    title: 'Areas',    subtitle: 'Themes & tags',              count: areas.length, items: areas },
      { n: 4, key: 'library',  title: 'Library',  subtitle: 'The whole graph',            count: total, items: { notes: total, links } },
      { n: 5, key: 'archive',  title: 'Archive',  subtitle: 'Resting (>30d untouched)',   count: archiveCount, items: archiveItems },
    ],
  };
}
