#!/usr/bin/env node
// CORTEX CLI — a terminal client for the local CORTEX notes server.
//
// Usage:  node cli.mjs <command> [args]
//
// No npm dependencies — uses Node 24's global `fetch`. ESM module.
// The server is expected at http://127.0.0.1:7002 (override with CORTEX_URL).
//
// Exit codes: 0 = success, 1 = error / network failure, 2 = usage error.

const BASE = (process.env.CORTEX_URL || 'http://127.0.0.1:7002').replace(/\/+$/, '');
const HOSTPORT = '127.0.0.1:7002';

// ---------- tiny output helpers ----------
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const blank = () => process.stdout.write('\n');

// Pad a string to a visible width (right-pad with spaces). Coerces null/undefined to ''.
function pad(s, w) {
  s = s == null ? '' : String(s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

// Truncate long strings for table display.
function trunc(s, w) {
  s = s == null ? '' : String(s);
  return s.length > w ? s.slice(0, w - 1) + '…' : s;
}

// Friendly relative-ish timestamp from an epoch-ms value.
function when(ms) {
  if (!ms && ms !== 0) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

// ---------- error types ----------
class UsageError extends Error {}

// Friendly, single-line message when the server can't be reached, then exit 1.
function networkDie() {
  out(`CORTEX server not reachable at ${HOSTPORT} - start it with: node server.mjs`);
  process.exit(1);
}

// ---------- HTTP ----------
// Returns parsed JSON on 2xx. Network failures -> networkDie(). HTTP errors -> throw.
async function api(method, path, body) {
  let res;
  try {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    res = await fetch(BASE + path, opts);
  } catch {
    // fetch throws on connection refused / DNS / etc. -> server is down.
    networkDie();
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data && data.error ? data.error : (typeof data === 'string' ? data : res.statusText);
    throw new Error(`server error ${res.status}: ${msg}`);
  }
  return data;
}

const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b);
const qs = (s) => encodeURIComponent(String(s == null ? '' : s));

// ---------- arg parsing ----------
// Pull out `--tags a,b,c` (or `--tags=a,b,c`) from an argv array, returning
// { tags: string[]|null, rest: string[] } with the flag + its value removed.
function extractTags(argv) {
  const rest = [];
  let tags = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tags') {
      const v = argv[i + 1];
      i++; // consume the value
      tags = parseTagList(v);
    } else if (a.startsWith('--tags=')) {
      tags = parseTagList(a.slice('--tags='.length));
    } else {
      rest.push(a);
    }
  }
  return { tags, rest };
}

function parseTagList(v) {
  if (v == null) return [];
  return String(v).split(',').map(t => t.trim()).filter(Boolean);
}

// ---------- commands ----------

async function cmdAdd(argv) {
  const { tags, rest } = extractTags(argv);
  const text = rest.join(' ').trim();
  if (!text) throw new UsageError('add: needs text, e.g.  add "buy milk" --tags chores,home');
  const body = { text };
  if (tags && tags.length) body.tags = tags;
  const note = await post('/api/capture', body);
  if (!note || !note.id) throw new Error('capture returned no note');
  out('Captured note');
  out('  id:    ' + note.id);
  out('  title: ' + (note.title || '(untitled)'));
  if (note.tags && note.tags.length) out('  tags:  ' + note.tags.join(', '));
}

async function cmdNew(argv) {
  const { tags, rest } = extractTags(argv);
  const title = (rest[0] || '').trim();
  const content = rest[1] != null ? String(rest[1]) : '';
  if (!title) throw new UsageError('new: needs a title, e.g.  new "Meeting notes" "agenda..." --tags work');
  const id = `note-${Date.now()}`;
  const body = { id, title, content };
  if (tags && tags.length) body.tags = tags;
  const note = await post('/api/notes', body);
  out('Created note');
  out('  id:    ' + (note.id || id));
  out('  title: ' + (note.title || title));
  if (note.tags && note.tags.length) out('  tags:  ' + note.tags.join(', '));
}

// Shared renderer for a list of note objects as "title  (id)" lines.
function printNoteLines(notes) {
  if (!notes.length) { out('No matches.'); return; }
  const width = Math.min(60, Math.max(...notes.map(n => (n.title || '').length)));
  for (const n of notes) out(`${pad(trunc(n.title || '(untitled)', 60), width)}  (${n.id})`);
}

async function cmdSearch(argv) {
  const q = argv.join(' ').trim();
  if (!q) throw new UsageError('search: needs a query, e.g.  search rust traits');
  const notes = await get('/api/notes/search?q=' + qs(q));
  printNoteLines(Array.isArray(notes) ? notes : []);
}

async function cmdFind(argv) {
  const q = argv.join(' ').trim();
  if (!q) throw new UsageError('find: needs a query, e.g.  find how do embeddings work');
  const notes = await get('/api/notes/semantic?q=' + qs(q));
  const list = Array.isArray(notes) ? notes : [];
  if (!list.length) { out('No matches.'); return; }
  const width = Math.min(60, Math.max(...list.map(n => (n.title || '').length)));
  for (const n of list) {
    // Pad to 6 so a leading '-' on negative scores doesn't shift the title column.
    const score = pad((typeof n.score === 'number' ? n.score : 0).toFixed(3), 6);
    out(`${score}  ${pad(trunc(n.title || '(untitled)', 60), width)}  (${n.id})`);
  }
}

async function cmdRecent(argv) {
  const n = parseInt(argv[0], 10);
  const limit = Number.isFinite(n) && n > 0 ? n : 10;
  const notes = await get('/api/notes/recent?limit=' + limit);
  const list = Array.isArray(notes) ? notes : [];
  if (!list.length) { out('No notes yet.'); return; }
  const width = Math.min(50, Math.max(...list.map(x => (x.title || '').length)));
  for (const x of list) {
    out(`${when(x.created_at)}  ${pad(trunc(x.title || '(untitled)', 50), width)}  (${x.id})`);
  }
}

async function cmdOpen(argv) {
  const id = (argv[0] || '').trim();
  if (!id) throw new UsageError('open: needs a note id, e.g.  open note-1700000000000');
  const note = await get('/api/notes/' + qs(id));
  out(note.title || '(untitled)');
  out('─'.repeat(Math.min(60, Math.max(8, (note.title || '').length))));
  out('id:    ' + note.id);
  if (note.tags && note.tags.length) out('tags:  ' + note.tags.join(', '));
  if (note.project) out('proj:  ' + note.project);
  out('saved: ' + when(note.updated_at));
  blank();
  out((note.content || '').trim() || '(no content)');
  const backlinks = Array.isArray(note.backlinks) ? note.backlinks : [];
  if (backlinks.length) {
    blank();
    out(`Backlinks (${backlinks.length}):`);
    for (const b of backlinks) out('  ← ' + b);
  }
}

async function cmdAsk(argv) {
  const q = argv.join(' ').trim();
  if (!q) throw new UsageError('ask: needs a question, e.g.  ask what did I decide about pricing');
  const r = await post('/api/ai/ask', { query: q });
  const sources = Array.isArray(r.sources) ? r.sources : [];
  out('Question: ' + q);
  blank();
  out(`Sources (${sources.length}):`);
  if (sources.length) for (const s of sources) out('  • ' + s);
  else out('  (none)');
  blank();
  out('Assembled context');
  out('─'.repeat(40));
  out((r.context || '').trim() || '(no context assembled — the knowledge base may be empty)');
}

async function cmdProjects() {
  const projects = await get('/api/projects');
  const list = Array.isArray(projects) ? projects : [];
  if (!list.length) { out('No projects yet. Run `garden` to auto-classify notes.'); return; }
  const width = Math.min(40, Math.max(...list.map(p => (p.project || '').length)));
  for (const p of list) out(`${pad(p.project || '(unnamed)', width)}  (${p.count})`);
}

async function cmdTasks() {
  const tasks = await get('/api/tasks?status=open');
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) { out('No open tasks.'); return; }
  for (const t of list) {
    const due = t.due ? `  @${t.due}` : '';
    out(`[ ] ${t.text}${due}  (${t.note_title || t.note_id})`);
  }
}

async function cmdLayers() {
  const data = await get('/api/layers');
  const layers = data && Array.isArray(data.layers) ? data.layers : [];
  if (!layers.length) { out('No layers returned.'); return; }
  out(`CORTEX memory stack  (${data.total ?? 0} notes total)`);
  blank();
  const width = Math.max(...layers.map(l => (l.title || '').length));
  for (const l of layers) {
    out(`${l.n}. ${pad(l.title || '', width)}  ${pad(String(l.count), 4)}  ${l.subtitle || ''}`);
  }
}

async function cmdGarden() {
  out('Running gardener…');
  const r = await post('/api/gardener/run', {});
  const projects = (r.classify && r.classify.projects != null) ? r.classify.projects : (r.projects ?? 0);
  out('Gardener pass complete');
  out('  projects classified: ' + projects);
  out('  link suggestions:    ' + (r.link_suggestions ?? 0));
  out('  stale flagged:       ' + (r.stale_flagged ?? 0));
  if (r.took_ms != null) out('  took:                ' + r.took_ms + 'ms');
}

// ---------- usage ----------
const USAGE = `CORTEX CLI — terminal client for the local notes brain (${HOSTPORT})

Usage: node cli.mjs <command> [args]

Capture
  add "<text>" [--tags a,b]              quick-capture text into a note
  new "<title>" ["<content>"] [--tags]   create a note with an explicit title

Find
  search <query...>                      full-text search        -> "title  (id)"
  find <query...>                        semantic search         -> "score  title  (id)"
  recent [n]                             latest captures (default 10)
  open <id>                              show a note (title, tags, content, backlinks)
  ask <query...>                         assemble AI retrieval context for a question

Overview
  projects                               auto-classified projects -> "project (count)"
  tasks                                  open tasks from note checkboxes
  layers                                 the 5-layer memory stack with counts

Maintain
  garden                                 run the self-maintenance pass now

  help                                   show this message

Env: CORTEX_URL overrides the server base URL (default ${BASE}).`;

function printUsage() { out(USAGE); }

// ---------- dispatch ----------
const COMMANDS = {
  add: cmdAdd,
  new: cmdNew,
  search: cmdSearch,
  find: cmdFind,
  recent: cmdRecent,
  open: cmdOpen,
  ask: cmdAsk,
  projects: cmdProjects,
  tasks: cmdTasks,
  layers: cmdLayers,
  garden: cmdGarden,
};

async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(cmd ? 0 : 0); // `help` and no-args both exit 0 per spec
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    out(`Unknown command: ${cmd}\n`);
    printUsage();
    process.exit(2);
  }

  try {
    await handler(rest);
    process.exit(0);
  } catch (err) {
    if (err instanceof UsageError) {
      out('Usage: ' + err.message);
      process.exit(2);
    }
    out('Error: ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
  }
}

main();
