# CORTEX

> **The second brain that maintains itself.** A local-first, AI-native notes engine that auto-organizes your knowledge by *meaning* — and replaces Obsidian without sending a byte to the cloud.

CORTEX is a personal knowledge base built around one idea: your notes should connect, cluster, and resurface themselves, while you stay in control of every change. It does this with **on-device embeddings** (the MiniLM `all-MiniLM-L6-v2` model) — so semantic search, auto-classification, related-notes, and dedup all run **100% locally, for free, with no API keys and no account**.

The design law, learned from the failures of cloud auto-organizers: **AI suggests, the human decides.** CORTEX never silently rewrites a note. Every automated action lands in a review queue you approve or reject.

- **100% local** — Express + Node's built-in `node:sqlite`, bound to `127.0.0.1`. Your data lives in a single `cortex.db` file next to the server.
- **Free, no API keys** — embeddings run on-device via Helm's bundled MiniLM pipeline. No OpenAI, no subscription, nothing to configure.
- **AI-native** — semantic search, meaning-based clustering into projects, related-note suggestions, and a self-maintaining "Gardener" agent are core, not bolt-ons.
- **Obsidian-grade portability** — notes import from and export to plain Markdown with YAML frontmatter and `[[wikilinks]]`. No lock-in.

---

## Quick start

```bash
node server.mjs
```

Then open:

| URL | What it is |
| --- | --- |
| http://127.0.0.1:7002/app | **The app** (note UI on real data) |
| http://127.0.0.1:7002/ | Landing page |
| http://127.0.0.1:7002/api/spec | Machine-readable API spec (JSON) |
| http://127.0.0.1:7002/api/health | Health check → `{ ok: true, version }` |

On startup the server:
1. Initializes `cortex.db` (creates tables, runs idempotent column/FTS migrations).
2. **Backfills embeddings** for any notes that don't have a vector yet, and logs how many were added (or why embeddings are unavailable).
3. Runs the **Gardener** once, then schedules it to re-run **every 6 hours**.

> First-run note on embeddings: CORTEX reuses Helm's local MiniLM pipeline (`../memory/embed.mjs`). If the model weights aren't provisioned, the semantic features **degrade gracefully to empty results rather than throwing** — they never fall back silently to a weaker method inside a request handler. Provision the model once with `node ../memory/embed.mjs download` (from the `cortex/` directory) to enable semantic search, clustering, related notes, and dedup.

---

## The 5-layer model

CORTEX organizes everything into a five-layer stack, served as one object from **`GET /api/layers`** (see `layers.mjs`). The front layers are the newest/least-processed; the deeper layers are more organized or older.

| # | Layer | What it holds | How it's computed |
| --- | --- | --- | --- |
| 1 | **Stream** | Latest captures | 15 most recent notes by `created_at` |
| 2 | **Projects** | Topic clusters, auto-classified **by meaning** | Up to 12 projects from embedding-based clustering (`cluster.mjs`), each with a sample of its notes |
| 3 | **Areas** | Themes & tags | Top 12 tags by frequency across all notes |
| 4 | **Library** | The whole networked graph | Total note count + total link count |
| 5 | **Archive** | Resting notes | Notes untouched for **> 30 days** (`updated_at` older than the cutoff) |

**Stream → Projects → Areas → Library → Archive** is the lifecycle: a note enters as raw Stream, gets clustered into a Project by meaning, is grouped by your tags into Areas, lives in the Library graph, and eventually rests in the Archive if you stop touching it.

---

## Key features

Every feature below maps to real code in this repo.

### Search by meaning *and* by keyword
- **Semantic search** (`GET /api/notes/semantic`, `semantic.mjs`) — embeds your query with MiniLM and ranks notes by **cosine similarity** over the cached per-note vectors. Finds "car won't start" when you search "automobile breaking down".
- **Full-text search** (`GET /api/notes/search`, `db.mjs`) — SQLite **FTS5** over title/content/tags with the `porter unicode61` tokenizer, prefix-matched with implicit AND, ranked by **bm25**. Falls back to `LIKE` only if an FTS expression is ever rejected.

### Auto-classification into projects
`cluster.mjs` groups notes into projects **by meaning, with no API key**. It builds a similarity graph (an edge between two notes when their cosine ≥ `0.40`), then takes **connected components via union-find** — so clustering is transitive (A–B–C group together when A~B and B~C) and order-independent. It **also unions notes you've explicitly linked**, treating a manual link as the strongest same-project signal. Each component is labelled from its members' top terms and written to `notes.project`. Surfaced via `GET /api/projects` and `GET /api/projects/:name`.

### The Gardener — a self-maintaining agent (the headline)
`gardener.mjs` is the agent that keeps the vault from rotting. It runs **on startup, every 6 hours, and on demand** (`POST /api/gardener/run`). Each pass:
1. **Auto-classifies** notes into projects (via `cluster.mjs`).
2. **Auto-links by meaning** — every note is automatically linked to its most semantically-similar notes (cosine **≥ 0.42**, top 5 per note, deduped), both the moment a note is saved and during the Gardener pass. Auto-links are tagged `type:"auto"`. Linking is automatic — not a suggestion.
3. **Flags stale notes** (untouched > 30 days) to resurface.

Crucially, **it never edits note content silently.** Linking is automatic (additive + reversible); only the judgement calls — stale-note resurfacing and possible duplicates — land in a **human-in-the-loop review queue** (`suggestions` table): `GET /api/suggestions` to list, `POST /api/suggestions/:id/accept` `POST /api/suggestions/:id/reject`. Accepting is the only thing that mutates the graph.

### Temporal intelligence / time travel
Built on the version history every edit produces (`db.mjs`):
- **Stream** — `GET /api/notes/recent`, newest captures by creation time.
- **Time-window queries** — `GET /api/notes/temporal?from=&to=`, notes updated in a window.
- **A note as of a past instant** — `GET /api/notes/:id/asof?at=`, reconstructs the note's content at that timestamp from its version snapshots.
- **The whole vault as of an instant** — `GET /api/timetravel?at=`, time-travels every note that existed then.
- Notes can carry an optional IANA **timezone** (`tz`) captured at write time.

### Tasks from checkboxes
`tasks.mjs` derives tasks live from your Markdown — **no task store, no extra tables, no DB writes.** It scans every note for checkbox lines (`- [ ]` / `- [x]`, also `*`/`+` bullets), parses optional due dates (`@due(YYYY-MM-DD)`, `due:YYYY-MM-DD`, or a trailing `(YYYY-MM-DD)`), and reports open/done/overdue/due-today. Served at `GET /api/tasks` (with `status` and `overdue` filters) and `GET /api/tasks/stats`.

### Daily notes
`daily.mjs` lazily creates a dated journal note (`daily-YYYY-MM-DD`) on `GET /api/daily`, and `GET /api/daily/rollup` summarizes a day (notes created that day, pending-suggestion count, recent stream).

### Quick capture
`capture.mjs` turns input into a structured note fast:
- `POST /api/capture` — raw text → a note (title inferred from the first line); the new note is embedded immediately.
- `POST /api/capture/url` — fetches a web page's text via Helm's **Playwright** browser tool (free, local, no key) and stores it as a note, tagged `web`.

### Deduplication
`dedup.mjs` finds near-duplicate notes by **embedding similarity** (reusing the cached vectors — no model reload). `GET /api/dedup?threshold=` returns the overlapping pairs (default ≥ 0.9, capped at 100); `POST /api/dedup/flag` files them into the suggestions review queue.

### Spaced-repetition review
`review.mjs` resurfaces notes with an **SM-2-lite** algorithm in its own `review_state` table. `GET /api/review/due` lists notes due (never-reviewed first), `POST /api/review` records a grade (0–5) and reschedules, `GET /api/review/stats` summarizes tracked/due/reviewed-today.

### Obsidian-grade Markdown import/export
`vault-sync.mjs` is the no-lock-in layer:
- `POST /api/export/markdown` — writes every note to `<dir>/<id>.md` with **YAML frontmatter + body**.
- `POST /api/import/obsidian` — recursively ingests a folder of `.md` (reading frontmatter or deriving title/id), then resolves **`[[wikilinks]]`** (including `[[Target|Alias]]` and `[[Target#section]]`) into real graph links. Imported notes are embedded afterward so semantic search covers them.
- `GET /api/export/json` — a full `{ notes, links, graph }` snapshot.

### Insights & graph analytics
- `GET /api/insights` (`insights.mjs`) — totals, word counts, averages, orphan count, top tags/projects, notes-per-day (last 30), current streak, longest/newest/oldest note.
- `GET /api/graph/metrics` (`graph-analytics.mjs`) — treats links as undirected: node/edge counts, density, average degree, **hubs** (top-degree), **orphans** (degree 0), and **connected components** (via union-find).

### Webhooks
`webhooks.mjs` lets you register URLs that fire on note events (`note.created` / `note.updated` / `note.deleted`, or `*` for all). `POST /api/webhooks` to register, `GET /api/webhooks` to list, `DELETE /api/webhooks/:id` to remove. Delivery is fire-and-forget with a ~4s timeout so a dead URL can't hang anything. (Note CRUD handlers already fire `note.created`/`note.updated`/`note.deleted`.)

### Templates
`templates.mjs` provides reusable note templates with `{{variable}}` substitution plus built-in `{{date}}` / `{{datetime}}` tokens, seeded with **Meeting** and **Book** templates. `GET /api/templates`, `POST /api/templates`, `POST /api/templates/:name/apply` (renders `{ title, content, tags }` — it does not create the note; the caller does).

### AI retrieval context (BYO-model)
`POST /api/ai/ask` assembles a **retrieval context** for an agent question. It selects sources by **meaning** (semantic search, with scopes `all` / `single` / `related`), then returns the gathered `context`, the cited source ids, and a ready-to-use `instruction` prompt. CORTEX itself **calls no LLM and sends nothing to the cloud** — it hands you grounded, citation-ready context to feed to whatever model you choose.

---

## API reference

The endpoints below are exactly the ones published by the **`/api/spec`** object in `server.mjs` (verbatim descriptions). Hit `GET /api/spec` for the live JSON.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/layers` | 5-layer memory stack (Stream/Projects/Areas/Library/Archive) |
| POST | `/api/notes` | Create note (optional tz) |
| GET | `/api/notes` | List notes |
| GET | `/api/notes/search?q=` | Full-text (FTS5) search |
| GET | `/api/notes/semantic?q=` | Semantic search by meaning (local embeddings) |
| GET | `/api/notes/recent?limit=` | Latest captures (Stream layer) |
| GET | `/api/notes/temporal?from=&to=` | Notes updated in a time window |
| GET | `/api/notes/:id` | Get note with links + backlinks |
| GET | `/api/notes/:id/related` | Notes most related by meaning |
| GET | `/api/notes/:id/asof?at=` | A note as it existed at a past instant |
| PUT | `/api/notes/:id` | Update note (snapshots a version, re-embeds) |
| DELETE | `/api/notes/:id` | Delete note |
| GET | `/api/timetravel?at=` | The whole vault as it existed at an instant |
| GET | `/api/projects` | Auto-classified projects |
| GET | `/api/projects/:name` | Notes in a project |
| GET | `/api/graph` | Knowledge graph (nodes + edges) |
| POST | `/api/links` | Create link |
| GET | `/api/links/:noteId` | Links for a note |
| GET | `/api/versions/:noteId` | Version history |
| POST | `/api/versions/:noteId/restore/:versionId` | Restore a prior version |
| GET | `/api/suggestions?status=` | Gardener review queue |
| POST | `/api/suggestions/:id/accept` | Accept a suggestion |
| POST | `/api/suggestions/:id/reject` | Reject a suggestion |
| POST | `/api/gardener/run` | Run the self-maintenance pass now |
| POST | `/api/ai/ask` | Assemble retrieval context (by meaning) for an agent question |
| GET | `/api/insights` | Vault analytics (counts, streak, top tags/projects, orphans) |
| GET | `/api/graph/metrics` | Graph structure (hubs, orphans, components, density) |
| GET | `/api/tasks` | Tasks extracted from note checkboxes (status/overdue filters) |
| GET | `/api/daily` | Today's daily note (creates if missing); `/api/daily/rollup` for a summary |
| POST | `/api/capture` | Quick-capture text into a structured note |
| POST | `/api/capture/url` | Capture a web page into a note (free, Playwright) |
| GET | `/api/dedup` | Near-duplicate notes by embedding similarity |
| GET | `/api/review/due` | Notes due for spaced-repetition review (+ `POST /api/review`) |
| GET | `/api/export/json` | Full vault export (notes + links + graph) |
| POST | `/api/export/markdown` | Export notes to .md files on disk (portability) |
| POST | `/api/import/obsidian` | Import an Obsidian vault (.md + `[[wikilinks]]`) |

### Additional live routes (implemented, not listed in `/api/spec`)

These handlers exist in `server.mjs` and work, but the `/api/spec` object doesn't enumerate them as their own keys (some are referenced inside another entry's description text).

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Health check → `{ ok, version }` |
| GET | `/api/spec` | This API spec, as JSON |
| GET | `/api/tasks/stats` | Task roll-up (total/open/done/overdue/dueToday) |
| GET | `/api/daily/rollup` | Daily summary (created notes, pending suggestions, recent) |
| POST | `/api/dedup/flag` | File near-duplicate pairs into the review queue |
| POST | `/api/review` | Record a spaced-repetition review (`noteId`, `grade` 0–5) |
| GET | `/api/review/stats` | Review system stats (tracked/dueNow/reviewedToday) |
| GET | `/api/webhooks` | List registered webhooks |
| POST | `/api/webhooks` | Register a webhook (`url`, optional `events`) |
| DELETE | `/api/webhooks/:id` | Remove a webhook |
| GET | `/api/templates` | List templates |
| POST | `/api/templates` | Create/update a template |
| POST | `/api/templates/:name/apply` | Render a template with vars → `{ title, content, tags }` |

---

## Architecture

- **Stack:** Express + Node's built-in **`node:sqlite`** (`DatabaseSync`, synchronous — zero DB dependencies). Server binds to **`127.0.0.1:7002`**. Embeddings reuse Helm's local MiniLM pipeline (`../memory/embed.mjs`).
- **Data:** a single **`cortex.db`** file (WAL mode, foreign keys on). Tables: `notes`, `links`, `versions`, `notes_fts` (FTS5), `vectors` (embedding cache), `suggestions` (Gardener queue), plus `review_state`, `webhooks`, and `templates` created lazily by their own modules.
- **Embeddings cache:** every note's MiniLM vector is stored as JSON in the `vectors` table and reused across semantic search, related notes, clustering, and dedup — so the model is loaded once and cosine math runs locally.
- **Modules are standalone:** each power module owns its concern, touches the DB only through `db.mjs` at call-time, and does nothing at import time.

| File | Responsibility |
| --- | --- |
| `server.mjs` | Express app: all routes, `/api/spec`, static serving, startup embedding backfill + Gardener, 6-hour Gardener interval |
| `db.mjs` | Data layer over `node:sqlite`: schema, note CRUD, links/graph, versions, FTS5 search, temporal queries, projects, suggestions queue |
| `semantic.mjs` | Local MiniLM embeddings: embed-on-write, semantic search, related notes, backfill (degrades gracefully if model is unavailable) |
| `cluster.mjs` | Auto-classification into projects: cosine similarity graph + union-find connected components, also unions explicitly-linked notes |
| `gardener.mjs` | The self-maintaining agent: classify + **auto-link** related notes (≥ 0.42) + flag stale notes into the review queue |
| `layers.mjs` | Assembles the 5-layer stack (Stream / Projects / Areas / Library / Archive) for `GET /api/layers` |
| `tasks.mjs` | Extracts tasks from Markdown checkboxes live (no store), with due-date parsing and overdue/due-today logic |
| `daily.mjs` | Daily journal notes + per-day rollup |
| `insights.mjs` | Vault analytics: totals, words, orphans, top tags/projects, notes-per-day, streak, longest/newest/oldest |
| `graph-analytics.mjs` | Undirected graph structure: density, degree, hubs, orphans, connected components (union-find) |
| `dedup.mjs` | Near-duplicate detection by cosine similarity over cached vectors; optional flagging into the queue |
| `review.mjs` | Spaced-repetition resurfacing (SM-2-lite) in its own `review_state` table |
| `vault-sync.mjs` | Markdown-on-disk export, lossless Obsidian import with `[[wikilink]]` resolution, full JSON export |
| `capture.mjs` | Quick-capture: text → note, and URL → note via Helm's Playwright browser tool |
| `webhooks.mjs` | Event webhooks (`note.*`), fire-and-forget delivery with timeout; owns the `webhooks` table |
| `templates.mjs` | Reusable note templates with `{{variable}}` + `{{date}}`/`{{datetime}}` substitution; owns the `templates` table |

---

## Design principles

1. **AI suggests, the human decides.** No silent overwrites, ever. The Gardener and dedup file *suggestions*; only an explicit accept mutates your notes or graph. This preserves the "generation effect" — the reason auto-organizing cloud tools lost their users.
2. **Local-first & private.** The server binds to `127.0.0.1`, data is one `cortex.db` file you own, and embeddings run on-device. CORTEX sends nothing to any cloud model — even `/api/ai/ask` only assembles context for a model *you* run.
3. **Honest.** No advertised-but-unbuilt features. Every claim in this README maps to code in this repo, and `/api/spec` is kept in sync with the real routes. Semantic features degrade to empty results rather than pretending to work when the model isn't provisioned.

---

## Roadmap

CORTEX's foundation, semantic brain, temporal layer, Gardener, and 5-layer stack are built and tested (all local, free, no keys). Two phases remain.

### Phase 5 — Polish (UI on real data)
Render the five layers and the **living graph** from the real `/api/graph`, the note editor, quick-capture, and a semantic search box — all driven by live data rather than mock content.

### Phase 6 — Monetization
A tiered model on top of the free local core:
- **Sync subscription** — encrypted cross-device sync.
- **Pro / AI tier** — usage-aware or bring-your-own-key, so cloud-AI economics never threaten the free core.
- **Enterprise seats** — team deployments.

> **Monetization and any paid/cloud infrastructure require the owner's explicit approval before being built.** The free, fully-offline local core stays genuinely useful on its own; no AI cost is ever incurred without a key.
