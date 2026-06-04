// CORTEX vault-sync — markdown-on-disk portability (lossless Obsidian replacement).
//
// Three jobs:
//   exportMarkdown(dir) — every note -> <dir>/<safe-id>.md with YAML frontmatter + body.
//   importObsidian(dir) — recursively ingest .md files (frontmatter OR derived title/id),
//                         upsert via createNote, then wire [[wikilinks]] via createLink.
//   exportJson()        — { notes, links, graph } snapshot of the whole vault.
//
// Rules honored: ONE file, node builtins only, DB touched ONLY through getDb() at call-time
// (the server runs initDb() first), nothing executes at import time.
import fs from 'node:fs';
import path from 'node:path';
import { createNote, createLink, getNote, allNotesFull, getGraph, getDb } from './db.mjs';

// ---------------------------------------------------------------------------
// filename / id helpers
// ---------------------------------------------------------------------------

// A filesystem-safe stem for a note id: keep word chars / dash / dot, collapse the rest to '-'.
// Falls back to 'note' so we never emit an empty filename.
function safeId(id) {
  const s = String(id == null ? '' : id)
    .replace(/[^\w.-]+/g, '-')   // anything not [A-Za-z0-9_.-] -> dash
    .replace(/^-+|-+$/g, '')      // trim leading/trailing dashes
    .replace(/-{2,}/g, '-');      // collapse runs
  return s || 'note';
}

// Slug used when a markdown file has no id in frontmatter: derive a stable id from text.
function slugify(s) {
  const out = String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return out || 'note';
}

// ---------------------------------------------------------------------------
// minimal YAML frontmatter (read + write). No external deps — we only support the
// flat scalar/list shapes CORTEX writes plus what Obsidian commonly emits.
// ---------------------------------------------------------------------------

// Quote a scalar for YAML only when it could be misread (has special chars / leading-trailing space).
function yamlScalar(v) {
  const s = v == null ? '' : String(v);
  if (s === '') return '""';
  if (/^[\w./@+-][\w .,/@+:-]*$/.test(s) && !/^\s|\s$/.test(s) && !/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s)) {
    return s;
  }
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Build the `--- ... ---` block. Tags rendered as a flow list (Obsidian-compatible).
function buildFrontmatter(note) {
  const tags = Array.isArray(note.tags) ? note.tags : [];
  const lines = ['---'];
  lines.push(`id: ${yamlScalar(note.id)}`);
  lines.push(`title: ${yamlScalar(note.title)}`);
  lines.push(`tags: [${tags.map(t => yamlScalar(t)).join(', ')}]`);
  lines.push(`project: ${yamlScalar(note.project == null ? '' : note.project)}`);
  lines.push(`created_at: ${note.created_at == null ? '' : note.created_at}`);
  lines.push(`updated_at: ${note.updated_at == null ? '' : note.updated_at}`);
  lines.push('---');
  return lines.join('\n');
}

// Strip surrounding quotes from a YAML scalar and unescape a double-quoted form.
function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

// Parse a tags value that may be a flow list `[a, b]`, an inline CSV, or a single token.
// (Block-style `- item` lists are handled separately in parseFrontmatter.)
function parseTagList(raw) {
  let v = raw.trim();
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  return v.split(',').map(s => unquote(s)).map(s => s.replace(/^#/, '').trim()).filter(Boolean);
}

// Split a markdown document into { data, body }. `data` is null when there's no frontmatter.
// Accepts a leading BOM and CRLF/LF line endings.
function parseFrontmatter(text) {
  let src = text.replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: null, body: src };

  const data = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2];

    if (val === '' ) {
      // Possibly a block list (subsequent `- item` lines) — collect them.
      const items = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(unquote(lines[++i].replace(/^\s*-\s+/, '')).replace(/^#/, '').trim());
      }
      data[key] = items.length ? items.filter(Boolean) : '';
      continue;
    }
    if (key === 'tags') { data[key] = parseTagList(val); continue; }
    data[key] = unquote(val);
  }
  return { data, body: src.slice(m[0].length) };
}

// Normalize whatever the frontmatter / derivation produced into a string[] of tags.
function normalizeTags(t) {
  if (Array.isArray(t)) return t.map(x => String(x).replace(/^#/, '').trim()).filter(Boolean);
  if (t == null || t === '') return [];
  return parseTagList(String(t));
}

// ---------------------------------------------------------------------------
// content helpers
// ---------------------------------------------------------------------------

// First markdown `# heading` (ATX, level 1) in the body, if any.
function firstHeading(body) {
  const m = /^[ \t]*#[ \t]+(.+?)[ \t]*#*\s*$/m.exec(body || '');
  return m ? m[1].trim() : null;
}

// Extract [[wikilink]] targets. Handles [[Target]], [[Target|Alias]] and [[Target#section]].
// Returns the raw target token (alias/section stripped), de-duplicated, order-preserving.
function extractWikilinks(body) {
  const out = [];
  const seen = new Set();
  const re = /\[\[([^\]]+?)\]\]/g;
  let m;
  while ((m = re.exec(body || '')) !== null) {
    let target = m[1].split('|')[0].split('#')[0].trim();
    if (!target) continue;
    if (!seen.has(target)) { seen.add(target); out.push(target); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// recursive .md discovery
// ---------------------------------------------------------------------------

function walkMarkdown(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; } // unreadable dir -> skip
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === '.obsidian' || e.name === 'node_modules') continue;
        stack.push(full);
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        found.push(full);
      }
    }
  }
  return found;
}

// ===========================================================================
// EXPORTS
// ===========================================================================

// Write every note to <dir>/<safe-id>.md with YAML frontmatter + content body.
export function exportMarkdown(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const notes = allNotesFull();
  const used = new Set();
  let written = 0;
  for (const note of notes) {
    // Guarantee a unique on-disk filename even if two ids collapse to the same safe stem.
    let stem = safeId(note.id);
    let name = stem;
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${stem}-${n++}`;
    used.add(name.toLowerCase());

    const body = note.content == null ? '' : String(note.content);
    const doc = buildFrontmatter(note) + '\n\n' + body + (body.endsWith('\n') ? '' : '\n');
    fs.writeFileSync(path.join(dir, name + '.md'), doc, 'utf8');
    written++;
  }
  return { ok: true, written, dir };
}

// Recursively import every .md under dir, then resolve [[wikilinks]] into graph edges.
export function importObsidian(dir) {
  const files = walkMarkdown(dir);

  // Pass 1: create/update every note. Track the wikilink targets per source for pass 2,
  // and build lookup maps so [[Title]] / [[file-name]] resolve to real note ids.
  const pending = [];        // { id, targets: string[] }
  const byId = new Set();    // every id we imported (exact match)
  const byTitle = new Map(); // lower(title) -> id
  const bySlug = new Map();  // slug(title|filename) -> id

  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch { continue; }

    const { data, body } = parseFrontmatter(text);
    const base = path.basename(file).replace(/\.md$/i, '');

    const fm = data || {};
    const title = (fm.title != null && String(fm.title).trim())
      ? String(fm.title).trim()
      : (firstHeading(body) || base);
    const id = (fm.id != null && String(fm.id).trim())
      ? String(fm.id).trim()
      : slugify(base);
    const tags = normalizeTags(fm.tags);

    createNote(id, title, body, tags);

    byId.add(id);
    if (title) byTitle.set(title.toLowerCase(), id);
    bySlug.set(slugify(base), id);
    bySlug.set(slugify(title), id);

    pending.push({ id, targets: extractWikilinks(body) });
  }

  // Resolve a wikilink token to an imported note id (exact id, then title, then slug).
  const resolve = (token) => {
    if (byId.has(token)) return token;
    const lower = token.toLowerCase();
    if (byTitle.has(lower)) return byTitle.get(lower);
    const sl = slugify(token);
    if (bySlug.has(sl)) return bySlug.get(sl);
    return null;
  };

  // Pass 2: create links. createLink is FK-safe (returns false if an endpoint is missing),
  // so unresolved or dangling targets are simply skipped.
  let linked = 0;
  for (const { id, targets } of pending) {
    for (const token of targets) {
      const targetId = resolve(token);
      if (!targetId || targetId === id) continue;
      if (createLink(id, targetId)) linked++;
    }
  }

  return { ok: true, imported: pending.length, linked };
}

// Full snapshot: every note (hydrated), every link row, and the {nodes,edges} graph.
export function exportJson() {
  const notes = allNotesFull();
  const links = getDb().prepare('SELECT source, target, type FROM links').all();
  return { notes, links, graph: getGraph() };
}
