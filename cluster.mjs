// CORTEX auto-classification — groups notes into "projects" by MEANING, free & local.
// Builds a similarity graph (edge between two notes when cosine >= threshold) and takes CONNECTED
// COMPONENTS via union-find. This is transitive: A-B-C cluster together when A~B and B~C even if A
// and C aren't directly similar — far better topic grouping than greedy centroids, and order-independent.
// Each component is labelled from its members' top terms and written to notes.project. No API key.
import { cosineSimilarity, ensurePipelineLoaded } from '../memory/embed.mjs';
import { getDb, allNotesFull, setProject, getGraph } from './db.mjs';

const STOP = new Set(('the a an and or of to in is it its for on with as at by be this that from your you i we our are was ' +
  'will can not but how what when where which their them they into out over more most than then so if no yes do does ' +
  'done get got use using used via per new old has have had each other about across also my me he she his her im ive ' +
  'note notes idea ideas thing things just like one two three day days').split(' '));

function topTerms(notes, k = 3) {
  const tf = new Map();
  for (const n of notes) {
    const words = `${n.title} ${n.content}`.toLowerCase().match(/[\p{L}][\p{L}\p{N}]{2,}/gu) || [];
    for (const w of words) { if (STOP.has(w)) continue; tf.set(w, (tf.get(w) || 0) + 1); }
  }
  return [...tf.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(e => e[0]);
}

function vectorsFor(notes) {
  const db = getDb();
  const out = [];
  for (const n of notes) {
    const row = db.prepare('SELECT vector FROM vectors WHERE note_id = ?').get(n.id);
    if (row) { try { out.push({ note: n, vec: JSON.parse(row.vector) }); } catch { /* skip corrupt */ } }
  }
  return out;
}

// threshold: cosine required to consider two notes part of the same project. ~0.33 works for MiniLM —
// connects topically-related notes while keeping distinct subjects apart (components handle transitivity).
export async function classifyProjects(threshold = 0.40) {
  if (!(await ensurePipelineLoaded())) return { ok: false, reason: 'embeddings unavailable' };
  const items = vectorsFor(allNotesFull());
  const n = items.length;
  if (!n) return { ok: true, projects: 0, classified: 0, summary: [] };

  // union-find over the similarity graph
  const parent = items.map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosineSimilarity(items[i].vec, items[j].vec) >= threshold) union(i, j);
    }
  }

  // also union notes the user has EXPLICITLY linked — the strongest same-project signal there is.
  const idx = new Map(items.map((it, i) => [it.note.id, i]));
  try { for (const e of getGraph().edges) { const a = idx.get(e.source), b = idx.get(e.target); if (a != null && b != null) union(a, b); } } catch { /* no graph */ }

  // gather components
  const comps = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(items[i].note); }

  // label (largest first so the dominant cluster gets the cleanest label) + persist
  const groups = [...comps.values()].sort((a, b) => b.length - a.length);
  const used = new Map();
  let classified = 0;
  const summary = [];
  for (const members of groups) {
    let label = topTerms(members, members.length > 1 ? 3 : 2).join('-') || 'misc';
    if (used.has(label)) { const c = used.get(label) + 1; used.set(label, c); label = `${label}-${c}`; } else used.set(label, 1);
    for (const m of members) { setProject(m.id, label); classified++; }
    summary.push({ project: label, size: members.length });
  }
  return { ok: true, projects: groups.length, classified, summary };
}
