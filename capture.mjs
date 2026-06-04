// CORTEX capture — frictionless capture that lands a structured note.
//
// Two entry points:
//   captureText(text, opts)  — turn raw text into a note (title inferred from first line).
//   captureUrl(url, opts)    — fetch a web page's text via Helm's Playwright browser tool
//                              (free, local, no API key) and store it as a note.
//
// DB is touched ONLY through db.mjs's createNote at call-time (no standalone execution).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNote } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// browser.mjs lives at ../tools/impl/browser.mjs relative to this file.
const BROWSER_CLI = path.resolve(__dirname, '..', 'tools', 'impl', 'browser.mjs');

// Deterministic-ish id suffix: no Math.random. A monotonic counter guarantees uniqueness
// within a process even when two captures land in the same millisecond, and text length
// mixes a little input-derived entropy in (as the spec asks).
let __counter = 0;
function makeId(text) {
  const len = (text || '').length;
  const suffix = (len.toString(36) + (__counter++).toString(36));
  return `cap-${Date.now()}-${suffix}`;
}

// First non-empty line, stripped of a leading markdown heading marker, trimmed to ~80 chars.
function deriveTitle(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const noHeading = trimmed.replace(/^#+\s*/, '').trim();
    const candidate = noHeading || trimmed;
    return candidate.length > 80 ? candidate.slice(0, 80).trim() : candidate;
  }
  return 'Untitled';
}

/**
 * Build a note from raw text.
 * @param {string} text - the raw note body.
 * @param {{ title?: string, tags?: string[] }} [opts]
 * @returns {object} the created note (as returned by db.createNote).
 */
export function captureText(text, opts = {}) {
  const body = text == null ? '' : String(text);
  const id = makeId(body);
  const title = opts.title || deriveTitle(body);
  const tags = opts.tags || [];
  return createNote(id, title, body, tags);
}

/**
 * Fetch a web page's text via Helm's browser tool and store it as a note.
 * @param {string} url - the page to read.
 * @param {{ title?: string, tags?: string[] }} [opts]
 * @returns {object|{ok:false,error:string}} the created note, or an error object on failure.
 */
export function captureUrl(url, opts = {}) {
  if (!url) return { ok: false, error: 'url is required' };
  try {
    const res = spawnSync(
      process.execPath,
      [BROWSER_CLI, 'read', '--url', url],
      { encoding: 'utf8' }
    );

    if (res.error) return { ok: false, error: res.error.message };
    if (res.status !== 0) {
      return { ok: false, error: (res.stderr || '').trim() || `browser exited with code ${res.status}` };
    }

    // browser.mjs prints a single JSON object on stdout; tolerate extra log noise by
    // parsing the last non-empty line if a straight parse fails.
    const stdout = (res.stdout || '').trim();
    let page;
    try {
      page = JSON.parse(stdout);
    } catch {
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last) return { ok: false, error: 'browser returned no parseable output' };
      page = JSON.parse(last);
    }

    if (page && page.ok === false) {
      return { ok: false, error: page.error || 'browser read failed' };
    }

    const pageTitle = (page && page.title) ? String(page.title) : url;
    const pageText = (page && page.text) ? String(page.text) : '';

    // Source URL on the first line, then the extracted text, capped to ~8000 chars total.
    const MAX = 8000;
    const header = `${url}\n\n`;
    const budget = Math.max(0, MAX - header.length);
    const content = header + pageText.slice(0, budget);
    const tags = ['web', ...(opts.tags || [])];

    const id = makeId(content);
    const title = opts.title || pageTitle;
    return createNote(id, title, content, tags);
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}
