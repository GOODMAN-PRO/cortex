// CORTEX dedup layer — find near-duplicate / highly-overlapping notes by embedding similarity.
// Read-only discovery (findDuplicates) + optional flagging into the suggestions review queue
// (flagDuplicates). Reuses the per-note vectors already cached in the `vectors` table by
// semantic.mjs; computes pairwise cosine similarity locally (no model load, no API key).
import { cosineSimilarity } from '../memory/embed.mjs';
import { getDb, getNote, addSuggestion } from './db.mjs';

const MAX_PAIRS = 100; // cap returned pairs so a large vault can't blow up the response

// Load every cached vector, JSON.parse each, and return the parsed rows (skipping corrupt JSON).
function loadVectors() {
  const rows = getDb().prepare('SELECT note_id, vector FROM vectors').all();
  const out = [];
  for (const r of rows) {
    try {
      const vec = JSON.parse(r.vector);
      if (Array.isArray(vec) && vec.length) out.push({ id: r.note_id, vec });
    } catch { /* skip corrupt/unparseable vector */ }
  }
  return out;
}

// Resolve a note's title without throwing if the note was deleted (vector orphaned).
function titleOf(id) {
  const n = getNote(id);
  return n ? n.title : null;
}

// Read-only: compute pairwise cosine similarity over all cached vectors and return every pair
// scoring >= threshold as { a, b, score, titleA, titleB }, sorted by score desc, capped at 100.
export function findDuplicates(threshold = 0.9) {
  const vectors = loadVectors();
  const pairs = [];
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const score = cosineSimilarity(vectors[i].vec, vectors[j].vec);
      if (score >= threshold) {
        pairs.push({ a: vectors[i].id, b: vectors[j].id, score });
      }
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return pairs.slice(0, MAX_PAIRS).map(p => ({
    a: p.a,
    b: p.b,
    score: +p.score.toFixed(4),
    titleA: titleOf(p.a),
    titleB: titleOf(p.b),
  }));
}

// Flag each near-duplicate pair into the suggestions queue as a 'duplicate' suggestion.
// addSuggestion dedupes pending rows, so re-running won't pile up duplicates.
export function flagDuplicates(threshold = 0.9) {
  const dups = findDuplicates(threshold);
  let flagged = 0;
  for (const p of dups) {
    addSuggestion('duplicate', { source: p.a, target: p.b, score: p.score });
    flagged++;
  }
  return { ok: true, flagged };
}
