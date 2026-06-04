// CORTEX HTTP smoke-test suite — hits the LIVE API at http://127.0.0.1:7002 and asserts behavior
// across every endpoint, then prints a summary and exits non-zero if anything failed.
//
// Run: node "C:/Users/User/helm/workspace/cortex/test/smoke.mjs"   (server must be up)
//
// ESM, Node 24, global fetch — zero npm. Self-cleaning: every note/webhook it creates is removed
// at the end (and best-effort even on crash). All created note ids are prefixed `smoke-` so cleanup
// is reliable. Temp dirs are created with fs.mkdtemp and removed afterwards.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:7002';

// ---- counters ---------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ok   ${label}`); }
function fail(label, detail) {
  failed++;
  failures.push({ label, detail });
  console.log(`  FAIL ${label}${detail ? `  -> ${detail}` : ''}`);
}
// assert truthy
function check(cond, label, detail) { if (cond) ok(label); else fail(label, detail); }

// ---- fetch helper -----------------------------------------------------------
// j(method, path, body) -> { status, ok, body }  (body is parsed JSON, or raw text on parse failure)
async function j(method, p, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, ok: res.ok, body: parsed };
}

const isArr = Array.isArray;
const wait = ms => new Promise(r => setTimeout(r, ms));

// Track everything we create so teardown is reliable even if an assertion throws.
const createdNotes = new Set();   // note ids (smoke-*, plus any cap-*/daily-* we touch)
const createdWebhooks = new Set();// webhook ids
const tmpDirs = [];               // temp dirs to rm -rf

async function makeNote(id, title, content = '', tags = []) {
  const r = await j('POST', '/api/notes', { id, title, content, tags });
  if (r.ok && r.body && r.body.id) createdNotes.add(r.body.id);
  return r;
}

// today as local YYYY-MM-DD (matches server's daily.mjs / tasks.mjs local-time logic)
function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// =============================================================================
// TESTS
// =============================================================================
async function run() {
  // ---- health + spec -------------------------------------------------------
  {
    const h = await j('GET', '/api/health');
    check(h.ok && h.body && h.body.ok === true, 'GET /api/health -> {ok:true}', JSON.stringify(h.body));

    const s = await j('GET', '/api/spec');
    check(s.ok && s.body && typeof s.body.endpoints === 'object' && Object.keys(s.body.endpoints).length > 0,
      'GET /api/spec has endpoints map', JSON.stringify(s.body).slice(0, 120));
  }

  // ---- notes CRUD ----------------------------------------------------------
  const nA = 'smoke-note-a';
  const nB = 'smoke-note-b';
  {
    // create requires id + title
    const bad = await j('POST', '/api/notes', { title: 'no id' });
    check(bad.status === 400, 'POST /api/notes without id -> 400', `status ${bad.status}`);

    const cre = await makeNote(nA, 'Smoke Alpha', 'first body about zebraqux marker', ['smoke']);
    check(cre.ok && cre.body.id === nA && cre.body.title === 'Smoke Alpha' && isArr(cre.body.tags),
      'POST /api/notes creates note', JSON.stringify(cre.body).slice(0, 120));

    await makeNote(nB, 'Smoke Beta', 'second note [[smoke-note-a]] references alpha', ['smoke']);

    const list = await j('GET', '/api/notes');
    check(list.ok && isArr(list.body) && list.body.some(n => n.id === nA),
      'GET /api/notes lists created note', `len ${isArr(list.body) ? list.body.length : 'n/a'}`);

    // GET one with links + backlinks
    const one = await j('GET', `/api/notes/${nA}`);
    check(one.ok && one.body.id === nA && isArr(one.body.links) && isArr(one.body.backlinks),
      'GET /api/notes/:id has links+backlinks arrays', JSON.stringify(one.body).slice(0, 120));

    const missing = await j('GET', '/api/notes/smoke-does-not-exist');
    check(missing.status === 404, 'GET /api/notes/:id unknown -> 404', `status ${missing.status}`);

    // update
    const upd = await j('PUT', `/api/notes/${nA}`, { title: 'Smoke Alpha v2', content: 'updated body zebraqux still here', tags: ['smoke', 'edited'] });
    check(upd.ok && upd.body.title === 'Smoke Alpha v2', 'PUT /api/notes/:id updates note', JSON.stringify(upd.body).slice(0, 120));

    const updBad = await j('PUT', `/api/notes/${nA}`, { content: 'no title' });
    check(updBad.status === 400, 'PUT /api/notes/:id without title -> 400', `status ${updBad.status}`);
  }

  // ---- search (FTS) --------------------------------------------------------
  {
    // distinctive word "zebraqux" should locate the note via FTS5
    const r = await j('GET', '/api/notes/search?q=zebraqux');
    check(r.ok && isArr(r.body) && r.body.some(n => n.id === nA),
      'GET /api/notes/search finds note by word (FTS)', `hits ${isArr(r.body) ? r.body.length : 'n/a'}`);

    const empty = await j('GET', '/api/notes/search?q=');
    check(empty.ok && isArr(empty.body) && empty.body.length === 0, 'GET /api/notes/search empty q -> []', JSON.stringify(empty.body));
  }

  // ---- semantic search -----------------------------------------------------
  // create a note about "ocean tides" and search "sea water movement" -> it should rank.
  const nOcean = 'smoke-ocean';
  {
    await makeNote(nOcean, 'Ocean tides', 'The ocean tides rise and fall as the moon pulls the sea; coastal water levels swell and recede twice a day.', ['smoke']);
    await wait(150); // give the embed a beat (embedNote awaited in handler, but be safe)
    const r = await j('GET', `/api/notes/semantic?q=${encodeURIComponent('sea water movement')}`);
    const hit = isArr(r.body) && r.body.find(n => n.id === nOcean);
    check(r.ok && isArr(r.body) && r.body.length > 0, 'GET /api/notes/semantic returns ranked results', `len ${isArr(r.body) ? r.body.length : 'n/a'}`);
    check(!!hit, 'GET /api/notes/semantic ranks the ocean-tides note for "sea water movement"',
      hit ? `score ${hit.score}` : `not in top ${isArr(r.body) ? r.body.length : 0}`);
    if (hit) check(typeof hit.score === 'number', 'semantic result carries a numeric score', String(hit && hit.score));
  }

  // ---- related / recent / temporal -----------------------------------------
  {
    const rel = await j('GET', `/api/notes/${nOcean}/related`);
    check(rel.ok && isArr(rel.body), 'GET /api/notes/:id/related -> array', JSON.stringify(rel.body).slice(0, 120));
    if (isArr(rel.body) && rel.body.length) {
      const e = rel.body[0];
      check(e && typeof e.id === 'string' && typeof e.title === 'string' && typeof e.score === 'number',
        'related entry has {id,title,score}', JSON.stringify(e));
    }

    const rec = await j('GET', '/api/notes/recent?limit=50');
    check(rec.ok && isArr(rec.body) && rec.body.some(n => n.id === nOcean),
      'GET /api/notes/recent includes a fresh note', `len ${isArr(rec.body) ? rec.body.length : 'n/a'}`);

    const from = Date.now() - 3600_000;
    const to = Date.now() + 3600_000;
    const temp = await j('GET', `/api/notes/temporal?from=${from}&to=${to}`);
    check(temp.ok && isArr(temp.body) && temp.body.some(n => n.id === nOcean),
      'GET /api/notes/temporal?from&to finds notes in window', `len ${isArr(temp.body) ? temp.body.length : 'n/a'}`);
  }

  // ---- versions + asof + timetravel ----------------------------------------
  // Build a version-bearing note: create with v1 content, PUT to v2 (snapshots v1 into versions).
  const nVer = 'smoke-version';
  {
    const cre = await makeNote(nVer, 'Versioned', 'ORIGINAL-CONTENT-v1');
    const createdAt = cre.body.created_at;

    await wait(20);
    const upd = await j('PUT', `/api/notes/${nVer}`, { title: 'Versioned', content: 'CHANGED-CONTENT-v2' });
    check(upd.ok && upd.body.content === 'CHANGED-CONTENT-v2', 'PUT creates a new version (content changed)', JSON.stringify(upd.body).slice(0, 80));

    const vers = await j('GET', `/api/versions/${nVer}`);
    check(vers.ok && isArr(vers.body) && vers.body.length >= 1, 'GET /api/versions/:id lists version(s)', `len ${isArr(vers.body) ? vers.body.length : 'n/a'}`);
    const v1 = isArr(vers.body) && vers.body.find(v => v.content === 'ORIGINAL-CONTENT-v1');
    check(!!v1, 'version history retains original content', v1 ? `vid ${v1.id}` : 'original not found');

    // restore old version -> note content reverts to v1
    if (v1) {
      const restored = await j('POST', `/api/versions/${nVer}/restore/${v1.id}`);
      check(restored.ok && restored.body && restored.body.content === 'ORIGINAL-CONTENT-v1',
        'POST /api/versions/:id/restore/:vid restores old content', JSON.stringify(restored.body).slice(0, 80));
    }

    // restore unknown version id -> 404
    const badRestore = await j('POST', `/api/versions/${nVer}/restore/99999999`);
    check(badRestore.status === 404, 'restore unknown version -> 404', `status ${badRestore.status}`);

    // asof at created_at returns the ORIGINAL content.
    // (note's created_at is preserved across PUT; the first version's saved_at == that create time,
    //  so noteAsOf(id, created_at) resolves to the original snapshot.)
    const asof = await j('GET', `/api/notes/${nVer}/asof?at=${createdAt}`);
    check(asof.ok && asof.body && asof.body.content === 'ORIGINAL-CONTENT-v1',
      'GET /api/notes/:id/asof?at=<created_at> returns original', asof.body ? JSON.stringify(asof.body.content) : `status ${asof.status}`);

    // asof before the note existed -> 404
    const asofBefore = await j('GET', `/api/notes/${nVer}/asof?at=${createdAt - 10_000_000}`);
    check(asofBefore.status === 404, 'asof before note existed -> 404', `status ${asofBefore.status}`);

    // timetravel for the whole vault at "now" returns an array
    const tt = await j('GET', `/api/timetravel?at=${Date.now()}`);
    check(tt.ok && isArr(tt.body) && tt.body.length > 0, 'GET /api/timetravel?at= returns vault array', `len ${isArr(tt.body) ? tt.body.length : 'n/a'}`);
  }

  // ---- links + graph -------------------------------------------------------
  {
    const link = await j('POST', '/api/links', { source: nA, target: nB, type: 'link' });
    check(link.ok && link.body && link.body.ok === true, 'POST /api/links creates link', JSON.stringify(link.body));

    // FK-safe: link to a non-existent target -> {ok:false}
    const badLink = await j('POST', '/api/links', { source: nA, target: 'smoke-nope-target' });
    check(badLink.ok && badLink.body && badLink.body.ok === false, 'POST /api/links unknown endpoint -> {ok:false}', JSON.stringify(badLink.body));

    const linkBadReq = await j('POST', '/api/links', { source: nA });
    check(linkBadReq.status === 400, 'POST /api/links missing target -> 400', `status ${linkBadReq.status}`);

    const links = await j('GET', `/api/links/${nA}`);
    check(links.ok && isArr(links.body) && links.body.some(l => l.target === nB || l.source === nB),
      'GET /api/links/:id returns the link', JSON.stringify(links.body).slice(0, 120));

    const g = await j('GET', '/api/graph');
    check(g.ok && g.body && isArr(g.body.nodes) && isArr(g.body.edges) && g.body.nodes.some(n => n.id === nA),
      'GET /api/graph has nodes+edges', `nodes ${g.body && isArr(g.body.nodes) ? g.body.nodes.length : 'n/a'}`);

    const gm = await j('GET', '/api/graph/metrics');
    check(gm.ok && gm.body && typeof gm.body.nodeCount === 'number' && typeof gm.body.edgeCount === 'number'
      && isArr(gm.body.hubs) && gm.body.components && typeof gm.body.density === 'number',
      'GET /api/graph/metrics has structure (nodeCount/edges/hubs/components/density)', JSON.stringify(gm.body).slice(0, 120));
  }

  // ---- gardener + projects -------------------------------------------------
  {
    const gard = await j('POST', '/api/gardener/run');
    check(gard.ok && gard.body && gard.body.ok === true, 'POST /api/gardener/run -> ok', JSON.stringify(gard.body).slice(0, 120));

    const proj = await j('GET', '/api/projects');
    check(proj.ok && isArr(proj.body), 'GET /api/projects -> array', `len ${isArr(proj.body) ? proj.body.length : 'n/a'}`);
    if (isArr(proj.body) && proj.body.length) {
      const p = proj.body[0];
      check(p && typeof p.project === 'string' && typeof p.count === 'number', 'project entry has {project,count}', JSON.stringify(p));
    }
  }

  // ---- suggestions ---------------------------------------------------------
  {
    const sug = await j('GET', '/api/suggestions');
    check(sug.ok && isArr(sug.body), 'GET /api/suggestions -> array', `len ${isArr(sug.body) ? sug.body.length : 'n/a'}`);
    // if any pending exist, rejecting one should work
    if (isArr(sug.body) && sug.body.length) {
      const id = sug.body[0].id;
      const rej = await j('POST', `/api/suggestions/${id}/reject`);
      check(rej.ok && rej.body && rej.body.ok === true && rej.body.suggestion && rej.body.suggestion.status === 'rejected',
        'POST /api/suggestions/:id/reject works', JSON.stringify(rej.body).slice(0, 120));
    } else {
      ok('GET /api/suggestions (no pending to reject — skipped reject)');
    }
    // rejecting a non-existent suggestion -> 404
    const rej404 = await j('POST', '/api/suggestions/99999999/reject');
    check(rej404.status === 404, 'reject unknown suggestion -> 404', `status ${rej404.status}`);
  }

  // ---- tasks ---------------------------------------------------------------
  const nTask = 'smoke-task';
  {
    await makeNote(nTask, 'Smoke tasks', 'Todo list:\n- [ ] do thing @due(2026-06-10)\n- [x] already done thing');
    const tasks = await j('GET', '/api/tasks');
    const mine = isArr(tasks.body) && tasks.body.find(t => t.note_id === nTask && /do thing/.test(t.text));
    check(tasks.ok && isArr(tasks.body) && !!mine, 'GET /api/tasks finds checkbox task', mine ? `due ${mine.due}` : 'task not found');
    if (mine) check(mine.due === '2026-06-10' && mine.done === false, 'task parsed due + open state', JSON.stringify(mine));

    const stats = await j('GET', '/api/tasks/stats');
    check(stats.ok && stats.body && typeof stats.body.total === 'number' && typeof stats.body.open === 'number'
      && typeof stats.body.done === 'number', 'GET /api/tasks/stats has counts', JSON.stringify(stats.body));
  }

  // ---- daily ---------------------------------------------------------------
  {
    const d = await j('GET', '/api/daily');
    const expectedId = `daily-${today()}`;
    check(d.ok && d.body && d.body.id === expectedId, `GET /api/daily returns ${expectedId}`, d.body ? d.body.id : `status ${d.status}`);
    if (d.body && d.body.id) createdNotes.add(d.body.id); // clean up the daily note we materialized

    const roll = await j('GET', '/api/daily/rollup');
    check(roll.ok && roll.body && typeof roll.body.date === 'string' && isArr(roll.body.created)
      && typeof roll.body.createdCount === 'number', 'GET /api/daily/rollup has shape', JSON.stringify(roll.body).slice(0, 120));
  }

  // ---- capture -------------------------------------------------------------
  {
    const cap = await j('POST', '/api/capture', { text: 'Smoke capture: a quick thought worth keeping.' });
    const id = cap.body && cap.body.id;
    check(cap.ok && id && /^cap-/.test(id), 'POST /api/capture returns note with cap- id', id || JSON.stringify(cap.body).slice(0, 80));
    if (id) createdNotes.add(id); // capture ids aren't smoke-prefixed; track explicitly for cleanup

    const capBad = await j('POST', '/api/capture', {});
    check(capBad.status === 400, 'POST /api/capture without text -> 400', `status ${capBad.status}`);
  }

  // ---- dedup ---------------------------------------------------------------
  {
    const d = await j('GET', '/api/dedup');
    check(d.ok && isArr(d.body), 'GET /api/dedup -> array', `len ${isArr(d.body) ? d.body.length : 'n/a'}`);
  }

  // ---- review --------------------------------------------------------------
  {
    const due = await j('GET', '/api/review/due');
    check(due.ok && isArr(due.body), 'GET /api/review/due -> array', `len ${isArr(due.body) ? due.body.length : 'n/a'}`);

    const rev = await j('POST', '/api/review', { noteId: nA, grade: 5 });
    check(rev.ok && rev.body && rev.body.note_id === nA && typeof rev.body.due === 'number',
      'POST /api/review records a review', JSON.stringify(rev.body).slice(0, 120));

    const revBad = await j('POST', '/api/review', { noteId: nA });
    check(revBad.status === 400, 'POST /api/review without grade -> 400', `status ${revBad.status}`);

    const rstats = await j('GET', '/api/review/stats');
    check(rstats.ok && rstats.body && typeof rstats.body.tracked === 'number'
      && typeof rstats.body.dueNow === 'number' && typeof rstats.body.reviewedToday === 'number',
      'GET /api/review/stats has counts', JSON.stringify(rstats.body));
  }

  // ---- insights ------------------------------------------------------------
  {
    const ins = await j('GET', '/api/insights');
    check(ins.ok && ins.body && typeof ins.body.totalNotes === 'number',
      'GET /api/insights has totalNotes', JSON.stringify(ins.body).slice(0, 100));
  }

  // ---- export / import -----------------------------------------------------
  {
    const ej = await j('GET', '/api/export/json');
    check(ej.ok && ej.body && isArr(ej.body.notes) && isArr(ej.body.links) && ej.body.graph
      && isArr(ej.body.graph.nodes), 'GET /api/export/json snapshot (notes+links+graph)',
      `notes ${ej.body && isArr(ej.body.notes) ? ej.body.notes.length : 'n/a'}`);

    // export markdown to a temp dir
    const expDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-export-'));
    tmpDirs.push(expDir);
    const em = await j('POST', '/api/export/markdown', { dir: expDir });
    check(em.ok && em.body && em.body.ok === true && typeof em.body.written === 'number' && em.body.written > 0,
      'POST /api/export/markdown writes files', JSON.stringify(em.body));
    // verify files actually landed on disk
    const wrote = fs.existsSync(expDir) && fs.readdirSync(expDir).filter(f => f.endsWith('.md')).length > 0;
    check(wrote, 'export/markdown produced .md files on disk', `dir ${expDir}`);

    const emBad = await j('POST', '/api/export/markdown', {});
    check(emBad.status === 400, 'POST /api/export/markdown without dir -> 400', `status ${emBad.status}`);

    // import an obsidian vault: write 2 linked .md files to another temp dir
    const impDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-import-'));
    tmpDirs.push(impDir);
    fs.writeFileSync(path.join(impDir, 'smoke-import-one.md'),
      '---\nid: smoke-import-one\ntitle: Smoke Import One\ntags: [smoke]\n---\n\nLinks to [[smoke-import-two]].\n', 'utf8');
    fs.writeFileSync(path.join(impDir, 'smoke-import-two.md'),
      '---\nid: smoke-import-two\ntitle: Smoke Import Two\ntags: [smoke]\n---\n\nBack to [[smoke-import-one]].\n', 'utf8');
    createdNotes.add('smoke-import-one');
    createdNotes.add('smoke-import-two');

    const imp = await j('POST', '/api/import/obsidian', { dir: impDir });
    check(imp.ok && imp.body && imp.body.ok === true && typeof imp.body.imported === 'number' && imp.body.imported >= 2,
      'POST /api/import/obsidian imported >= 2', JSON.stringify(imp.body));
    check(imp.body && typeof imp.body.linked === 'number' && imp.body.linked >= 1,
      'import/obsidian wired wikilinks (linked >= 1)', JSON.stringify(imp.body));

    const impBad = await j('POST', '/api/import/obsidian', {});
    check(impBad.status === 400, 'POST /api/import/obsidian without dir -> 400', `status ${impBad.status}`);
  }

  // ---- webhooks ------------------------------------------------------------
  {
    const add = await j('POST', '/api/webhooks', { url: 'http://127.0.0.1:7002/api/health' });
    const id = add.body && add.body.id;
    check(add.ok && id && add.body.url === 'http://127.0.0.1:7002/api/health' && isArr(add.body.events),
      'POST /api/webhooks registers a webhook', JSON.stringify(add.body).slice(0, 120));
    if (id) createdWebhooks.add(id);

    const list = await j('GET', '/api/webhooks');
    check(list.ok && isArr(list.body) && list.body.some(w => w.id === id),
      'GET /api/webhooks lists it', `len ${isArr(list.body) ? list.body.length : 'n/a'}`);

    const addBad = await j('POST', '/api/webhooks', {});
    check(addBad.status === 400, 'POST /api/webhooks without url -> 400', `status ${addBad.status}`);

    if (id) {
      const del = await j('DELETE', `/api/webhooks/${id}`);
      check(del.ok && del.body && del.body.ok === true && del.body.removed >= 1,
        'DELETE /api/webhooks/:id removes it', JSON.stringify(del.body));
      if (del.ok && del.body && del.body.ok === true) createdWebhooks.delete(id);
    }
  }

  // ---- templates -----------------------------------------------------------
  {
    const tpls = await j('GET', '/api/templates');
    const hasMeeting = isArr(tpls.body) && tpls.body.some(t => t.name === 'Meeting');
    check(tpls.ok && isArr(tpls.body) && tpls.body.length > 0 && hasMeeting,
      'GET /api/templates has seeded templates (Meeting)', `len ${isArr(tpls.body) ? tpls.body.length : 'n/a'}`);

    const apply = await j('POST', '/api/templates/Meeting/apply', { vars: {} });
    check(apply.ok && apply.body && typeof apply.body.title === 'string' && typeof apply.body.content === 'string',
      'POST /api/templates/:name/apply returns {title,content}', JSON.stringify(apply.body).slice(0, 120));

    const applyMissing = await j('POST', '/api/templates/no-such-template-xyz/apply', { vars: {} });
    check(applyMissing.status === 404, 'apply unknown template -> 404', `status ${applyMissing.status}`);
  }

  // ---- delete the two original notes via the DELETE endpoint (assert it works) ----
  {
    const del = await j('DELETE', `/api/notes/${nB}`);
    check(del.ok && del.body && del.body.ok === true, 'DELETE /api/notes/:id -> {ok:true}', JSON.stringify(del.body));
    if (del.ok) createdNotes.delete(nB);
    // confirm it's gone
    const gone = await j('GET', `/api/notes/${nB}`);
    check(gone.status === 404, 'deleted note is gone (404)', `status ${gone.status}`);
  }
}

// =============================================================================
// TEARDOWN — remove every note + webhook + temp dir we created.
// =============================================================================
async function cleanup() {
  console.log('\n-- cleanup --');
  let delNotes = 0, delHooks = 0;
  for (const id of createdNotes) {
    try { const r = await j('DELETE', `/api/notes/${id}`); if (r.ok) delNotes++; } catch { /* ignore */ }
  }
  for (const id of createdWebhooks) {
    try { const r = await j('DELETE', `/api/webhooks/${id}`); if (r.ok) delHooks++; } catch { /* ignore */ }
  }
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`  removed ${delNotes} note(s), ${delHooks} webhook(s), ${tmpDirs.length} temp dir(s)`);

  // Safety net: sweep any leftover smoke-* notes (e.g. from a previous crashed run).
  try {
    const all = await j('GET', '/api/notes?limit=1000');
    if (all.ok && isArr(all.body)) {
      let swept = 0;
      for (const n of all.body) {
        if (typeof n.id === 'string' && n.id.startsWith('smoke-')) {
          const r = await j('DELETE', `/api/notes/${n.id}`); if (r.ok) swept++;
        }
      }
      if (swept) console.log(`  swept ${swept} leftover smoke-* note(s)`);
    }
  } catch { /* ignore */ }
}

// =============================================================================
async function main() {
  console.log(`CORTEX smoke test -> ${BASE}\n`);
  // Fail fast with a clear message if the server isn't up.
  try {
    await j('GET', '/api/health');
  } catch (e) {
    console.error(`Cannot reach CORTEX at ${BASE} — is the server running?  (${e.message})`);
    process.exit(2);
  }

  try {
    await run();
  } catch (e) {
    fail('UNCAUGHT EXCEPTION in test run', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await cleanup();
  }

  console.log('');
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f.label}${f.detail ? `  (${f.detail})` : ''}`);
    console.log('');
  }
  console.log(`CORTEX smoke: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
