// CORTEX insights — vault analytics / dashboard stats.
// Pure computation over the data layer (db.mjs). No DB writes, no new tables, no extra deps.
// Everything is derived at call-time from allNotesFull(), getGraph(), and listProjects().
import { allNotesFull, getGraph, listProjects } from './db.mjs';

// Count words in a note's content. Whitespace-delimited tokens; empty/blank -> 0.
function wordCount(text) {
  const m = String(text || '').match(/\S+/g);
  return m ? m.length : 0;
}

// Local-time 'YYYY-MM-DD' for an epoch-ms timestamp (buckets days in the machine's timezone).
function localDay(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

export function vaultStats() {
  const notes = allNotesFull();
  const { edges } = getGraph();
  const projects = listProjects();

  const totalNotes = notes.length;
  const totalLinks = edges.length;

  // --- word stats ---
  let totalWords = 0;
  for (const n of notes) totalWords += wordCount(n.content);
  const avgWordsPerNote = totalNotes ? totalWords / totalNotes : 0;
  const avgLinksPerNote = totalNotes ? totalLinks / totalNotes : 0;

  // --- orphans: notes that are neither a source nor a target of any link ---
  const linked = new Set();
  for (const e of edges) { linked.add(e.source); linked.add(e.target); }
  let orphanCount = 0;
  for (const n of notes) if (!linked.has(n.id)) orphanCount++;

  // --- top tags (tags is a hydrated array from db.mjs) ---
  const tagCounts = new Map();
  for (const n of notes) {
    for (const raw of (Array.isArray(n.tags) ? n.tags : [])) {
      const tag = String(raw).trim();
      if (!tag) continue;
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }
  const topTags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 10);

  // --- top projects (from listProjects: [{project, count, updated}]) ---
  const topProjects = projects
    .map(p => ({ project: p.project, count: p.count }))
    .sort((a, b) => b.count - a.count || String(a.project).localeCompare(String(b.project)))
    .slice(0, 10);

  // --- notesPerDay: last 30 days (incl. today) by created_at, local-time buckets ---
  const createdByDay = new Map();
  for (const n of notes) {
    if (n.created_at == null) continue;
    const day = localDay(n.created_at);
    createdByDay.set(day, (createdByDay.get(day) || 0) + 1);
  }
  const notesPerDay = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const day = localDay(d.getTime());
    notesPerDay.push({ date: day, count: createdByDay.get(day) || 0 });
  }

  // --- current streak: consecutive days ending today with >=1 created note ---
  let currentStreakDays = 0;
  {
    const cur = new Date(today);
    while (createdByDay.get(localDay(cur.getTime()))) {
      currentStreakDays++;
      cur.setDate(cur.getDate() - 1);
    }
  }

  // --- longest note (by word count) ---
  let longestNoteId = null;
  let longestNoteTitle = null;
  let longestWords = -1;
  for (const n of notes) {
    const w = wordCount(n.content);
    if (w > longestWords) {
      longestWords = w;
      longestNoteId = n.id;
      longestNoteTitle = n.title;
    }
  }

  // --- newest / oldest note by created_at ---
  let newestNote = null;
  let oldestNote = null;
  for (const n of notes) {
    if (n.created_at == null) continue;
    const slim = { id: n.id, title: n.title, created_at: n.created_at };
    if (!newestNote || n.created_at > newestNote.created_at) newestNote = slim;
    if (!oldestNote || n.created_at < oldestNote.created_at) oldestNote = slim;
  }

  return {
    totalNotes,
    totalLinks,
    totalWords,
    avgWordsPerNote,
    avgLinksPerNote,
    orphanCount,
    topTags,
    topProjects,
    notesPerDay,
    currentStreakDays,
    longestNoteId,
    longestNoteTitle,
    newestNote,
    oldestNote,
  };
}
