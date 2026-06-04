#!/usr/bin/env node
// cortex/mcp.mjs — a ZERO-DEPENDENCY Model Context Protocol (MCP) server for CORTEX.
//
// CORTEX is a local-first AI notes / second-brain app (Express server on http://127.0.0.1:7002;
// see workspace/cortex/server.mjs). This file exposes CORTEX to ANY MCP-compatible agent
// (Claude Desktop, Cursor, Cline, Continue, …) as a drop-in plugin — no npm install required.
//
// Transport: MCP stdio. Newline-delimited JSON-RPC 2.0 on STDIN; each response is ONE single-line
// JSON object + "\n" written to STDOUT. STDOUT carries JSON-RPC *only* — every log / diagnostic
// goes to STDERR, or MCP clients will fail to parse the stream and disconnect.
//
// No dependencies: pure `node:readline` over process.stdin + the global `fetch` (Node >= 18).
//
// Run it directly to test:  node workspace/cortex/mcp.mjs   (then type JSON-RPC lines on stdin)
// Configure it in a client: see workspace/cortex/MCP.md.

import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CORTEX_URL = (process.env.CORTEX_URL || 'http://127.0.0.1:7002').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 20_000;
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'cortex', version: '1.0.0' };

// All diagnostics go to stderr — NEVER stdout (stdout is reserved for JSON-RPC frames).
const log = (...args) => { try { process.stderr.write('[cortex-mcp] ' + args.join(' ') + '\n'); } catch { /* ignore */ } };

const NETWORK_HINT = (url) =>
  `CORTEX server not running at ${url} — start it: node workspace/cortex/server.mjs`;

// ---------------------------------------------------------------------------
// HTTP helper — one request, ~20s AbortController timeout. NEVER throws to the
// caller for the network path: returns a tagged object the tool layer turns into
// an isError result. Real HTTP errors (4xx/5xx) come back as { httpError }.
// ---------------------------------------------------------------------------
async function cortexFetch(method, path, body) {
  const url = CORTEX_URL + path;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    const opts = { method, signal: ac.signal, headers: { accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    res = await fetch(url, opts);
  } catch (e) {
    clearTimeout(timer);
    const timedOut = e && e.name === 'AbortError';
    log(method, path, timedOut ? 'timed out' : `network error: ${e && e.message}`);
    return {
      networkError: true,
      message: timedOut
        ? `CORTEX request timed out after ${REQUEST_TIMEOUT_MS / 1000}s at ${CORTEX_URL}`
        : NETWORK_HINT(CORTEX_URL),
    };
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const detail =
      data && typeof data === 'object' && data.error ? data.error
      : typeof data === 'string' && data ? data.slice(0, 300)
      : `HTTP ${res.status}`;
    log(method, path, `-> ${res.status}: ${detail}`);
    return { httpError: true, status: res.status, message: `CORTEX ${method} ${path} → ${res.status}: ${detail}` };
  }
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Result formatting helpers
// ---------------------------------------------------------------------------
const pretty = (v) => {
  if (v === null || v === undefined) return '(empty)';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

const textResult = (text) => ({ content: [{ type: 'text', text }], isError: false });
const errorResult = (text) => ({ content: [{ type: 'text', text }], isError: true });

// Build a tools/call result from a cortexFetch outcome, formatting the success body via `render`.
function toResult(r, render) {
  if (r.networkError) return errorResult(r.message);
  if (r.httpError) return errorResult(r.message);
  try {
    return textResult(render ? render(r.data) : pretty(r.data));
  } catch (e) {
    return errorResult(`CORTEX returned data this tool could not format: ${e && e.message}`);
  }
}

const qs = (params) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

// Coerce a tags argument (array | "a,b,c" | undefined) into a clean string[].
function toTags(v) {
  if (v === undefined || v === null) return [];
  const parts = (Array.isArray(v) ? v : String(v).split(','))
    .map((x) => String(x).trim())
    .filter(Boolean);
  return parts;
}

const summarizeCount = (arr, label) =>
  Array.isArray(arr) ? `${arr.length} ${label}${arr.length === 1 ? '' : 's'}:\n\n${pretty(arr)}` : pretty(arr);

// ---------------------------------------------------------------------------
// Tool registry — each entry: { name, description, inputSchema, handler }.
// inputSchema is JSON Schema (type:"object", properties, required) so any MCP
// client can render the form and validate. Names are verb_noun and unambiguous.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'cortex_capture',
    description:
      'Quick-capture a raw thought, snippet, or idea into CORTEX as a structured note. Use this for fast inbox-style capture when you have text but no specific title. Returns the created note.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to capture (required).' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags to attach to the note.',
        },
      },
      required: ['text'],
    },
    handler: async (args) => {
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text.trim()) return errorResult('cortex_capture requires a non-empty "text" argument.');
      const r = await cortexFetch('POST', '/api/capture', { text, tags: toTags(args.tags) });
      return toResult(r, (note) => `Captured note:\n\n${pretty(note)}`);
    },
  },
  {
    name: 'cortex_create_note',
    description:
      'Create a titled note in CORTEX with optional content and tags. Use this when you have a clear title for the note (vs. cortex_capture for raw quick capture). The note id is generated automatically. Returns the created note.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The note title (required).' },
        content: { type: 'string', description: 'Optional note body (Markdown; [[wikilinks]] supported).' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags to attach to the note.',
        },
      },
      required: ['title'],
    },
    handler: async (args) => {
      const title = typeof args.title === 'string' ? args.title : '';
      if (!title.trim()) return errorResult('cortex_create_note requires a non-empty "title" argument.');
      const content = typeof args.content === 'string' ? args.content : '';
      const id = `note-${Date.now()}`;
      const r = await cortexFetch('POST', '/api/notes', { id, title, content, tags: toTags(args.tags) });
      return toResult(r, (note) => `Created note:\n\n${pretty(note)}`);
    },
  },
  {
    name: 'cortex_search',
    description:
      'Full-text keyword search across all CORTEX notes (FTS5). Use this when you want exact word/phrase matches. For meaning-based / conceptual lookup use cortex_recall instead. Returns matching notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The keyword query to search for (required).' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const q = typeof args.query === 'string' ? args.query : '';
      if (!q.trim()) return errorResult('cortex_search requires a non-empty "query" argument.');
      const r = await cortexFetch('GET', `/api/notes/search${qs({ q })}`);
      return toResult(r, (rows) => summarizeCount(rows, 'match'));
    },
  },
  {
    name: 'cortex_recall',
    description:
      'Semantic search by meaning across CORTEX notes (local on-device embeddings). Use this to recall notes that are conceptually related to a query even if they share no exact keywords — the best default for "what did I write about X". For exact keyword matches use cortex_search. Returns the most relevant notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A natural-language description of what to recall (required).' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const q = typeof args.query === 'string' ? args.query : '';
      if (!q.trim()) return errorResult('cortex_recall requires a non-empty "query" argument.');
      const r = await cortexFetch('GET', `/api/notes/semantic${qs({ q })}`);
      return toResult(r, (rows) => summarizeCount(rows, 'result'));
    },
  },
  {
    name: 'cortex_recent',
    description:
      'List the most recently captured/updated CORTEX notes (the Stream layer). Use this to see what was added lately. Returns notes newest-first.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Max number of notes to return (default 20).',
        },
      },
      required: [],
    },
    handler: async (args) => {
      let limit = Number.isFinite(args.limit) ? Math.trunc(args.limit) : undefined;
      if (limit !== undefined) limit = Math.min(100, Math.max(1, limit));
      const r = await cortexFetch('GET', `/api/notes/recent${qs({ limit })}`);
      return toResult(r, (rows) => summarizeCount(rows, 'note'));
    },
  },
  {
    name: 'cortex_get',
    description:
      'Fetch a single CORTEX note by its id, including its outgoing links and backlinks. Use this when you already know the note id (e.g. from a search/recall result). Returns the full note.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The note id to fetch (required).' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      if (!id.trim()) return errorResult('cortex_get requires a non-empty "id" argument.');
      const r = await cortexFetch('GET', `/api/notes/${encodeURIComponent(id)}`);
      return toResult(r, (note) => pretty(note));
    },
  },
  {
    name: 'cortex_related',
    description:
      'Find the notes most related by meaning to a given CORTEX note id (semantic neighbors). Use this to explore around a note you already have. Returns related notes ranked by similarity.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The note id to find neighbors for (required).' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      if (!id.trim()) return errorResult('cortex_related requires a non-empty "id" argument.');
      const r = await cortexFetch('GET', `/api/notes/${encodeURIComponent(id)}/related`);
      return toResult(r, (rows) => summarizeCount(rows, 'related note'));
    },
  },
  {
    name: 'cortex_ask',
    description:
      'Ask a question against the CORTEX knowledge base. Assembles the most relevant notes (by meaning) into retrieval context and returns the source note ids plus the gathered context, so the agent can answer grounded in the user\'s own notes. Returns { sources, context }.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question to answer from the knowledge base (required).' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const q = typeof args.query === 'string' ? args.query : '';
      if (!q.trim()) return errorResult('cortex_ask requires a non-empty "query" argument.');
      const r = await cortexFetch('POST', '/api/ai/ask', { query: q });
      return toResult(r, (data) => {
        const sources = (data && data.sources) || [];
        const context = (data && data.context) || '';
        return `Question: ${q}\n\nSources (${sources.length}): ${pretty(sources)}\n\nContext:\n${context || '(no matching context found)'}`;
      });
    },
  },
  {
    name: 'cortex_projects',
    description:
      'List the projects CORTEX has auto-classified from the notes (by meaning + explicit links). Use this to survey the major themes/areas in the knowledge base. Returns the project list.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const r = await cortexFetch('GET', '/api/projects');
      return toResult(r, (rows) => summarizeCount(rows, 'project'));
    },
  },
  {
    name: 'cortex_tasks',
    description:
      'List open tasks extracted from CORTEX note checkboxes (status = open). Use this to see outstanding to-dos captured in the notes. Returns the open tasks.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const r = await cortexFetch('GET', `/api/tasks${qs({ status: 'open' })}`);
      return toResult(r, (rows) => summarizeCount(rows, 'open task'));
    },
  },
  {
    name: 'cortex_layers',
    description:
      'Get the CORTEX 5-layer memory stack: Stream, Projects, Areas, Library, Archive. Use this for a high-level overview of how the knowledge base is organized. Returns the layer breakdown.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const r = await cortexFetch('GET', '/api/layers');
      return toResult(r, (data) => pretty(data));
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// Public-facing tool descriptors (no handler) for tools/list.
const TOOL_DESCRIPTORS = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------
function writeMessage(obj) {
  // Exactly one single-line JSON object + newline to STDOUT. Nothing else ever goes here.
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch (e) {
    log('failed to serialize/write response:', e && e.message);
  }
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: TOOL_DESCRIPTORS });

    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const tool = name && TOOL_BY_NAME.get(name);
      if (!tool) {
        // Unknown tool name is a request-level error (invalid params).
        return rpcError(id, -32602, `Unknown tool: ${name == null ? '(none)' : name}`);
      }
      try {
        const result = await tool.handler(args || {});
        return rpcResult(id, result);
      } catch (e) {
        // Defensive: a tool handler must never crash the server. Surface as an isError result.
        log('tool handler threw for', name, '-', e && e.message);
        return rpcResult(id, errorResult(`Tool "${name}" failed: ${(e && e.message) || e}`));
      }
    }

    default:
      return rpcError(id, -32601, 'Method not found');
  }
}

// A message with no `id` (and not null) is a notification → never reply.
const isNotification = (msg) => msg != null && !('id' in msg);

async function dispatch(msg) {
  // Notifications (e.g. notifications/initialized) get no response.
  if (isNotification(msg)) {
    if (msg && msg.method) log('notification:', msg.method);
    return;
  }

  // Basic JSON-RPC shape sanity. If we can't find an id we can't correlate a reply.
  const id = msg && 'id' in msg ? msg.id : null;

  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    writeMessage(rpcError(id, -32600, 'Invalid Request'));
    return;
  }

  let response;
  try {
    response = await handleRequest(msg);
  } catch (e) {
    log('internal error handling', msg.method, '-', e && e.message);
    response = rpcError(id, -32603, `Internal error: ${(e && e.message) || e}`);
  }
  if (response) writeMessage(response);
}

// ---------------------------------------------------------------------------
// stdin loop — newline-delimited JSON. Tolerate malformed lines (skip them).
// Requests are dispatched concurrently; each request yields exactly one reply.
//
// We track in-flight dispatches so that when stdin closes we DRAIN pending work
// (e.g. a tool call awaiting an HTTP response) before exiting — otherwise a fast
// batch piped into the process could be cut off mid-request. We deliberately do
// not call process.exit() on a clean close: once stdin ends and all dispatches
// settle, there's nothing left to keep the event loop alive and Node exits 0 on
// its own. (A long-lived client keeps stdin open, so the server simply waits.)
// ---------------------------------------------------------------------------
const inFlight = new Set();
let stdinClosed = false;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return; // ignore blank lines (keep-alives / framing)
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log('skipping malformed (non-JSON) input line');
    return; // tolerate malformed input — do not crash, do not reply
  }
  // Dispatch concurrently; track the promise so close can wait for it. dispatch
  // handles its own errors and writes at most one reply.
  const p = dispatch(msg)
    .catch((e) => log('dispatch error:', e && e.message))
    .finally(() => {
      inFlight.delete(p);
      if (stdinClosed && inFlight.size === 0) log('all pending requests drained');
    });
  inFlight.add(p);
});

rl.on('close', () => {
  stdinClosed = true;
  log(`stdin closed — draining ${inFlight.size} in-flight request(s)`);
  // Let pending dispatches finish writing their replies, then the event loop
  // empties and the process exits 0 naturally. No forced process.exit().
});

// Never let an unexpected error take the process down silently.
process.on('uncaughtException', (e) => log('uncaughtException:', e && e.stack ? e.stack : e));
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && (e.message || e)));

log(`CORTEX MCP server ready (stdio). Target: ${CORTEX_URL}. Tools: ${TOOLS.length}.`);
