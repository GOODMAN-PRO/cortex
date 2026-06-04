// CORTEX semantic layer — free, local embeddings (no API key, no cloud).
// Reuses Helm's MiniLM pipeline (../memory/embed.mjs) for embedText + cosineSimilarity, and stores
// per-note vectors in CORTEX's own `vectors(note_id,...)` table. Degrades gracefully (returns empty)
// if the model isn't provisioned — never throws into a request handler.
import { ensurePipelineLoaded, embedText, cosineSimilarity } from '../memory/embed.mjs';
import { getDb, getNote, createLink } from './db.mjs';

const MODEL = 'all-MiniLM-L6-v2';
const CAP = 4000; // chars fed to the embedder (MiniLM truncates long input anyway)

// In-memory vector cache (id -> number[]). Avoids re-reading + JSON.parsing the entire vectors table
// on every search / related / autoLink call. Populated lazily, kept warm on embed. Stale entries for
// deleted notes are harmless — every read path null-filters via getNote().
let VCACHE = null;
function loadCache() {
  if (VCACHE) return VCACHE;
  VCACHE = new Map();
  for (const r of getDb().prepare('SELECT note_id, vector FROM vectors').all()) {
    try { VCACHE.set(r.note_id, JSON.parse(r.vector)); } catch { /* skip corrupt */ }
  }
  return VCACHE;
}

let ready = null;
async function ensure() { if (ready === null) { try { ready = await ensurePipelineLoaded(); } catch { ready = false; } } return ready; }

const textOf = (title, content) => `${title || ''}\n${content || ''}`.slice(0, CAP);

export async function embedNote(id, title, content) {
  if (!(await ensure())) return false;
  try {
    const vec = await embedText(textOf(title, content));
    getDb().prepare(`
      INSERT INTO vectors (note_id, vector, model, created) VALUES (?, ?, ?, ?)
      ON CONFLICT(note_id) DO UPDATE SET vector=excluded.vector, model=excluded.model, created=excluded.created
    `).run(id, JSON.stringify(vec), MODEL, Date.now());
    loadCache().set(id, vec);   // keep the in-memory cache warm
    return true;
  } catch { return false; }
}

function allVectors(excludeId) {
  const out = [];
  for (const [id, vec] of loadCache()) {
    if (id === excludeId) continue;
    out.push({ id, vec });
  }
  return out;
}

export async function semanticSearch(query, limit = 20) {
  if (!query || !(await ensure())) return [];
  const qv = await embedText(String(query).slice(0, CAP));
  const scored = allVectors().map(v => ({ id: v.id, score: cosineSimilarity(qv, v.vec) }))
    .sort((a, b) => b.score - a.score).slice(0, limit);
  return scored.map(s => { const n = getNote(s.id); return n ? { ...n, score: +s.score.toFixed(4) } : null; }).filter(Boolean);
}

export async function relatedNotes(noteId, limit = 8) {
  if (!(await ensure())) return [];
  const row = getDb().prepare('SELECT vector FROM vectors WHERE note_id = ?').get(noteId);
  if (!row) return [];
  let base; try { base = JSON.parse(row.vector); } catch { return []; }
  return allVectors(noteId).map(v => ({ id: v.id, score: cosineSimilarity(base, v.vec) }))
    .sort((a, b) => b.score - a.score).slice(0, limit)
    .map(s => { const n = getNote(s.id); return n ? { id: n.id, title: n.title, score: +s.score.toFixed(4) } : null; }).filter(Boolean);
}

// Automatically link a note to its most semantically-similar notes. Linking is AUTOMATIC (owner
// preference) — not a review-queue suggestion. Idempotent + FK-safe; normalizes each pair to (min,max)
// so A<->B is a single edge, not two. Returns how many new links it created.
export async function autoLink(noteId, { threshold = 0.42, max = 5 } = {}) {
  if (!(await ensure())) return 0;
  const db = getDb();
  let made = 0, attached = 0;
  for (const r of await relatedNotes(noteId, max + 4)) {
    if (r.score < threshold) break;            // relatedNotes is sorted by score desc
    const a = noteId < r.id ? noteId : r.id, b = noteId < r.id ? r.id : noteId;
    const existed = !!db.prepare('SELECT 1 FROM links WHERE source = ? AND target = ?').get(a, b);
    if (createLink(a, b, 'auto')) { attached++; if (!existed) made++; }
    if (attached >= max) break;                // cap total links per note (new or existing)
  }
  return made;                                  // count only NEW links
}

// Embed any notes that don't yet have a vector (e.g. notes created before this layer existed).
export async function backfillEmbeddings() {
  if (!(await ensure())) return { ok: false, reason: 'embedding model unavailable' };
  const missing = getDb().prepare(`
    SELECT n.id, n.title, n.content FROM notes n
    LEFT JOIN vectors v ON v.note_id = n.id WHERE v.note_id IS NULL
  `).all();
  let done = 0;
  for (const n of missing) { if (await embedNote(n.id, n.title, n.content)) done++; }
  return { ok: true, embedded: done, total: missing.length };
}

export async function isReady() { return await ensure(); }
