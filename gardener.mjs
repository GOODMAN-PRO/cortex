// CORTEX Gardener — the self-maintaining agent. Runs on startup + every 6h (+ on demand).
// LINKING IS AUTOMATIC (owner preference): related notes are linked by meaning, not put in a queue.
// The Gardener still only SUGGESTS the things that are judgement calls and shouldn't happen silently
// (resurfacing stale notes); it never rewrites note content.
//   1) auto-classify notes into projects (writes notes.project)
//   2) AUTO-LINK related notes by meaning (creates real links)
//   3) flag stale notes to resurface -> review queue (suggestion)
import { classifyProjects } from './cluster.mjs';
import { getDb, allNotesFull, addSuggestion, clearSuggestions, listProjects } from './db.mjs';
import { autoLink, isReady } from './semantic.mjs';

const STALE_DAYS = 30;

export async function runGardener({ autoLinks = true } = {}) {
  const started = Date.now();
  const result = { ok: true, ran_at: started };

  // 1) auto-classify projects
  result.classify = await classifyProjects();

  // 2) auto-link related notes by meaning (AUTOMATIC — not a review-queue suggestion)
  let linked = 0;
  if (autoLinks && await isReady()) {
    clearSuggestions('link'); // legacy link suggestions are obsolete now that linking is automatic
    for (const n of allNotesFull()) linked += await autoLink(n.id);
  }
  result.links_created = linked;

  // 3) flag stale notes to resurface (still a suggestion — additive judgement, never silent)
  clearSuggestions('stale');
  const cutoff = started - STALE_DAYS * 86400000;
  const stale = getDb().prepare('SELECT id, title FROM notes WHERE updated_at < ? ORDER BY updated_at ASC LIMIT 20').all(cutoff);
  for (const s of stale) addSuggestion('stale', { source: s.id, label: s.title });
  result.stale_flagged = stale.length;

  result.projects = listProjects().length;
  result.took_ms = Date.now() - started;
  return result;
}
