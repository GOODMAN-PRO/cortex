import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initDb, closeDb, createNote, updateNote, getNote, listNotes,
  searchNotes, deleteNote, createLink, getLinks, getBacklinks, getGraph,
  getVersions, restoreVersion, getRecent, temporalRange, noteAsOf, timeTravel,
  listProjects, getNotesByProject, getSuggestion, listSuggestions, setSuggestionStatus
} from './db.mjs';
import { embedNote, semanticSearch, relatedNotes, backfillEmbeddings, autoLink } from './semantic.mjs';
import { getLayers } from './layers.mjs';
import { runGardener } from './gardener.mjs';
import { exportMarkdown, importObsidian, exportJson } from './vault-sync.mjs';
import { captureText, captureUrl } from './capture.mjs';
import { listTasks, taskStats } from './tasks.mjs';
import { getDaily, dailyRollup } from './daily.mjs';
import { vaultStats } from './insights.mjs';
import { graphMetrics } from './graph-analytics.mjs';
import { findDuplicates, flagDuplicates } from './dedup.mjs';
import { dueForReview, recordReview, reviewStats } from './review.mjs';
import { addWebhook, listWebhooks, removeWebhook, fireEvent } from './webhooks.mjs';
import { addTemplate, listTemplates, applyTemplate } from './templates.mjs';
import { createBackup, listBackups, pruneBackups } from './backup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.CORTEX_PORT || '7002', 10);

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));

initDb();

app.get('/api/health', (req, res) => res.json({ ok: true, version: '1.2.0' }));

app.get('/api/spec', (req, res) => {
  res.json({
    name: 'CORTEX',
    version: '1.2.0',
    description: 'AI-first memory layer & networked-notes brain (local-first, self-maintaining)',
    endpoints: {
      'GET /api/layers': '5-layer memory stack (Stream/Projects/Areas/Library/Archive)',
      'POST /api/notes': 'Create note (optional tz)',
      'GET /api/notes': 'List notes',
      'GET /api/notes/search?q=': 'Full-text (FTS5) search',
      'GET /api/notes/semantic?q=': 'Semantic search by meaning (local embeddings)',
      'GET /api/notes/recent?limit=': 'Latest captures (Stream layer)',
      'GET /api/notes/temporal?from=&to=': 'Notes updated in a time window',
      'GET /api/notes/:id': 'Get note with links + backlinks',
      'GET /api/notes/:id/related': 'Notes most related by meaning',
      'GET /api/notes/:id/asof?at=': 'A note as it existed at a past instant',
      'PUT /api/notes/:id': 'Update note (snapshots a version, re-embeds)',
      'DELETE /api/notes/:id': 'Delete note',
      'GET /api/timetravel?at=': 'The whole vault as it existed at an instant',
      'GET /api/projects': 'Auto-classified projects',
      'GET /api/projects/:name': 'Notes in a project',
      'GET /api/graph': 'Knowledge graph (nodes + edges)',
      'POST /api/links': 'Create link',
      'GET /api/links/:noteId': 'Links for a note',
      'GET /api/versions/:noteId': 'Version history',
      'POST /api/versions/:noteId/restore/:versionId': 'Restore a prior version',
      'GET /api/suggestions?status=': 'Gardener review queue',
      'POST /api/suggestions/:id/accept': 'Accept a suggestion (applies link suggestions)',
      'POST /api/suggestions/:id/reject': 'Reject a suggestion',
      'POST /api/gardener/run': 'Run the self-maintenance pass now',
      'POST /api/ai/ask': 'Assemble retrieval context (by meaning) for an agent question',
      'GET /api/insights': 'Vault analytics (counts, streak, top tags/projects, orphans)',
      'GET /api/graph/metrics': 'Graph structure (hubs, orphans, components, density)',
      'GET /api/tasks': 'Tasks extracted from note checkboxes (status/overdue filters)',
      'GET /api/daily': "Today's daily note (creates if missing); /api/daily/rollup for a summary",
      'POST /api/capture': 'Quick-capture text into a structured note',
      'POST /api/capture/url': 'Capture a web page into a note (free, Playwright)',
      'GET /api/dedup': 'Near-duplicate notes by embedding similarity',
      'GET /api/review/due': 'Notes due for spaced-repetition review (+ POST /api/review)',
      'GET /api/export/json': 'Full vault export (notes + links + graph)',
      'POST /api/export/markdown': 'Export notes to .md files on disk (portability)',
      'POST /api/import/obsidian': 'Import an Obsidian vault (.md + [[wikilinks]])'
    }
  });
});

// ===== 5-LAYER STACK =====
app.get('/api/layers', (req, res) => {
  try { res.json(getLayers()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== NOTES =====
app.post('/api/notes', async (req, res) => {
  try {
    const { id, title, content = '', tags = [], tz = null } = req.body;
    if (!id || !title) return res.status(400).json({ error: 'id and title required' });
    const note = createNote(id, title, content, tags, tz);
    await embedNote(id, title, content);
    await autoLink(id);                 // automatic linking by meaning
    fireEvent('note.created', { id, title }).catch(() => {});
    res.json(note);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notes', (req, res) => {
  try {
    res.json(listNotes(parseInt(req.query.limit) || 50, parseInt(req.query.offset) || 0));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// literal sub-paths must precede /api/notes/:id
app.get('/api/notes/search', (req, res) => {
  try {
    const q = req.query.q || '';
    res.json(q ? searchNotes(q) : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notes/semantic', async (req, res) => {
  try {
    const q = req.query.q || '';
    res.json(q ? await semanticSearch(q, parseInt(req.query.limit) || 20) : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notes/recent', (req, res) => {
  try { res.json(getRecent(parseInt(req.query.limit) || 20)); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notes/temporal', (req, res) => {
  try {
    const from = parseInt(req.query.from) || 0;
    const to = parseInt(req.query.to) || Date.now();
    res.json(temporalRange(from, to, parseInt(req.query.limit) || 500));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notes/:id/related', async (req, res) => {
  try { res.json(await relatedNotes(req.params.id, parseInt(req.query.limit) || 8)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notes/:id/asof', (req, res) => {
  try {
    const at = parseInt(req.query.at) || Date.now();
    const note = noteAsOf(req.params.id, at);
    if (!note) return res.status(404).json({ error: 'note did not exist at that time' });
    res.json(note);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notes/:id', (req, res) => {
  try {
    const note = getNote(req.params.id);
    if (!note) return res.status(404).json({ error: 'Not found' });
    res.json({ ...note, links: getLinks(req.params.id), backlinks: getBacklinks(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notes/:id', async (req, res) => {
  try {
    const { title, content = '', tags = [], tz = null } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const note = updateNote(req.params.id, title, content, tags, tz);
    const linkMatches = content.match(/\[\[([^\]]+)\]\]/g) || [];
    linkMatches.map(m => m.slice(2, -2)).forEach(t => createLink(req.params.id, t));
    await embedNote(req.params.id, title, content);
    await autoLink(req.params.id);      // automatic linking by meaning
    fireEvent('note.updated', { id: req.params.id, title }).catch(() => {});
    res.json(note);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/notes/:id', (req, res) => {
  try { deleteNote(req.params.id); fireEvent('note.deleted', { id: req.params.id }).catch(() => {}); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== TIME TRAVEL =====
app.get('/api/timetravel', (req, res) => {
  try { res.json(timeTravel(parseInt(req.query.at) || Date.now(), parseInt(req.query.limit) || 500)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== PROJECTS =====
app.get('/api/projects', (req, res) => {
  try { res.json(listProjects()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/projects/:name', (req, res) => {
  try { res.json(getNotesByProject(req.params.name, parseInt(req.query.limit) || 100)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== LINKS / GRAPH =====
app.post('/api/links', (req, res) => {
  try {
    const { source, target, type = 'link' } = req.body;
    if (!source || !target) return res.status(400).json({ error: 'source and target required' });
    res.json({ ok: createLink(source, target, type) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/links/:noteId', (req, res) => {
  try { res.json(getLinks(req.params.noteId)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/graph', (req, res) => {
  try { res.json(getGraph()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== VERSIONS =====
app.get('/api/versions/:noteId', (req, res) => {
  try { res.json(getVersions(req.params.noteId)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/versions/:noteId/restore/:versionId', (req, res) => {
  try {
    const note = restoreVersion(req.params.noteId, parseInt(req.params.versionId));
    if (!note) return res.status(404).json({ error: 'Version not found' });
    res.json(note);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== GARDENER + SUGGESTIONS (human-in-the-loop) =====
app.get('/api/suggestions', (req, res) => {
  try { res.json(listSuggestions(req.query.status || 'pending', parseInt(req.query.limit) || 100)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/suggestions/:id/accept', (req, res) => {
  try {
    const s = getSuggestion(parseInt(req.params.id));
    if (!s) return res.status(404).json({ error: 'not found' });
    if (s.kind === 'link' && s.source && s.target) createLink(s.source, s.target, 'suggested');
    res.json({ ok: true, applied: s.kind, suggestion: setSuggestionStatus(s.id, 'accepted') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/suggestions/:id/reject', (req, res) => {
  try {
    const s = getSuggestion(parseInt(req.params.id));
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, suggestion: setSuggestionStatus(s.id, 'rejected') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/gardener/run', async (req, res) => {
  try { res.json(await runGardener()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== POWER MODULES (insights, tasks, daily, capture, dedup, review, import/export) =====
app.get('/api/insights', async (req, res) => { try { res.json(await vaultStats()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/graph/metrics', async (req, res) => { try { res.json(await graphMetrics()); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/tasks', async (req, res) => { try { res.json(await listTasks({ status: req.query.status, overdue: req.query.overdue === 'true' })); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/tasks/stats', async (req, res) => { try { res.json(await taskStats()); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/daily', async (req, res) => { try { res.json(await getDaily(req.query.date)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/daily/rollup', async (req, res) => { try { res.json(await dailyRollup(req.query.date)); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/capture', async (req, res) => {
  try {
    const { text, title, tags } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const note = await captureText(text, { title, tags });
    if (note && note.id) await embedNote(note.id, note.title, note.content);
    res.json(note);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/capture/url', async (req, res) => {
  try {
    const { url, tags } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    const note = await captureUrl(url, { tags });
    if (note && note.id) await embedNote(note.id, note.title, note.content);
    res.json(note);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dedup', async (req, res) => { try { res.json(await findDuplicates(parseFloat(req.query.threshold) || 0.9)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/dedup/flag', async (req, res) => { try { res.json(await flagDuplicates(parseFloat(req.body && req.body.threshold) || 0.9)); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/review/due', async (req, res) => { try { res.json(await dueForReview(parseInt(req.query.limit) || 10)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/review', async (req, res) => {
  try {
    const { noteId, grade } = req.body;
    if (!noteId || grade == null) return res.status(400).json({ error: 'noteId and grade required' });
    res.json(await recordReview(noteId, parseInt(grade)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/review/stats', async (req, res) => { try { res.json(await reviewStats()); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/export/json', async (req, res) => { try { res.json(await exportJson()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/export/markdown', async (req, res) => {
  try { const dir = req.body && req.body.dir; if (!dir) return res.status(400).json({ error: 'dir required' }); res.json(await exportMarkdown(dir)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/import/obsidian', async (req, res) => {
  try {
    const dir = req.body && req.body.dir;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    const r = await importObsidian(dir);
    await backfillEmbeddings(); // embed the freshly imported notes so semantic search covers them
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== WEBHOOKS + TEMPLATES =====
app.get('/api/webhooks', async (req, res) => { try { res.json(await listWebhooks()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/webhooks', async (req, res) => { try { const { url, events } = req.body; if (!url) return res.status(400).json({ error: 'url required' }); res.json(await addWebhook(url, Array.isArray(events) && events.length ? events : ['*'])); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/webhooks/:id', async (req, res) => { try { res.json(await removeWebhook(parseInt(req.params.id))); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/templates', async (req, res) => { try { res.json(await listTemplates()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/templates', async (req, res) => { try { const { name, title_tpl, content_tpl, tags } = req.body; if (!name) return res.status(400).json({ error: 'name required' }); res.json(await addTemplate(name, { title_tpl, content_tpl, tags })); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/templates/:name/apply', async (req, res) => { try { const t = await applyTemplate(req.params.name, (req.body && req.body.vars) || {}); if (!t) return res.status(404).json({ error: 'no such template' }); res.json(t); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== BACKUP (consistent VACUUM INTO snapshots) =====
app.get('/api/backups', async (req, res) => { try { res.json(await listBackups()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/backup', async (req, res) => { try { const r = await createBackup(); await pruneBackups(20); res.json(r); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== AI retrieval =====
app.post('/api/ai/ask', async (req, res) => {
  try {
    const { query, noteId, scope = 'all' } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });
    let context = '', sources = [];
    if (scope === 'single' && noteId) {
      const note = getNote(noteId);
      if (note) { context = `# ${note.title}\n\n${note.content}`; sources = [note.id]; }
    } else if (scope === 'related' && noteId) {
      const note = getNote(noteId);
      if (note) { context = `# ${note.title}\n\n${note.content}`; sources.push(note.id); }
      for (const r of await relatedNotes(noteId, 6)) {
        const bn = getNote(r.id);
        if (bn) { context += `\n---\n# ${bn.title}\n${(bn.content || '').substring(0, 400)}`; sources.push(bn.id); }
      }
    } else {
      let notes = await semanticSearch(query, 8);
      if (!notes.length) notes = listNotes(8);
      context = notes.map(n => `# ${n.title}\n${(n.content || '').substring(0, 400)}`).join('\n---\n');
      sources = notes.map(n => n.id);
    }
    res.json({
      ok: true, query, sources, context,
      instruction: `Answer using ONLY the knowledge base context below. Cite note titles you used. If the answer isn't present, say so.\n\n${context}\n\nQuestion: ${query}`
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/app', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'app.html')); });
app.get('/', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`CORTEX running at http://127.0.0.1:${PORT}  (spec at /api/spec)`);
  try {
    const b = await backfillEmbeddings();
    console.log(`   embeddings: ${b.ok ? `${b.embedded} added (${b.total} were missing)` : `unavailable — ${b.reason}`}`);
    const g = await runGardener();
    console.log(`   gardener: ${g.classify?.projects ?? 0} projects, ${g.link_suggestions} link suggestions, ${g.stale_flagged} stale`);
  } catch (e) { console.log('   startup maintenance error: ' + e.message); }
  // self-maintain every 6h
  setInterval(() => { runGardener().catch(() => {}); }, 6 * 3600 * 1000);
});

process.on('SIGINT', () => { closeDb(); process.exit(0); });
