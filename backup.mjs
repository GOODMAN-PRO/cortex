// CORTEX backup module — consistent SQLite snapshots via `VACUUM INTO`.
//
// Why VACUUM INTO (not a file copy): cortex.db runs in WAL mode (see db.mjs: PRAGMA journal_mode=WAL),
// so the main .db file alone is NOT a complete picture — recent writes live in the -wal sidecar until a
// checkpoint. Copying the open file can capture a torn/stale state. `VACUUM INTO` asks SQLite itself to
// write a fully-consistent, defragmented snapshot of the live database (WAL included) to a new file,
// using the SAME connection the server already holds — so it sees all committed data and respects locks.
//
// Hard rules honored here: ONE file, NO npm deps (node: builtins only), DB accessed ONLY via getDb() at
// call-time (we never open our own connection), everything free/local, and NOTHING ever throws — each
// exported function returns a result object (or [] for listBackups).
//
// node:sqlite is synchronous (DatabaseSync), so getDb().exec(...) blocks until the snapshot is complete;
// on return the backup file is fully written and we can statSync it for its size.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { getDb } from './db.mjs';

// Resolve everything relative to THIS file so it works regardless of process cwd.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backupsDir = path.join(__dirname, 'backups');

// SQLite's VACUUM INTO takes a single-quoted string literal for the path. To embed it safely we:
//   - use forward slashes (valid on Windows for SQLite, and avoids backslash-escaping ambiguity), and
//   - escape any single-quote by doubling it ('' is an escaped ' inside a SQL string literal).
function sqlPathLiteral(absPath) {
  const forward = absPath.replace(/\\/g, '/');
  return forward.replace(/'/g, "''");
}

// Local timestamp -> YYYYMMDD-HHMMSS (filesystem-safe; no colons).
function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// Create a consistent snapshot of the live DB. Returns { ok:true, file, bytes } or { ok:false, error }.
export function createBackup() {
  try {
    const db = getDb();
    if (!db) return { ok: false, error: 'CORTEX database is not open (getDb() returned null — is the server running?)' };

    // Ensure <cortex>/backups/ exists.
    mkdirSync(backupsDir, { recursive: true });

    // Absolute target path: <cortex>/backups/cortex-<YYYYMMDD-HHMMSS>.db
    const file = path.join(backupsDir, `cortex-${stamp()}.db`);

    // VACUUM INTO '<path>'  — path forward-slashed and single-quotes escaped.
    db.exec(`VACUUM INTO '${sqlPathLiteral(file)}'`);

    const bytes = statSync(file).size;
    return { ok: true, file, bytes };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// List every *.db snapshot in the backups dir, newest-first. [] if the dir doesn't exist (or on error).
export function listBackups() {
  try {
    const entries = readdirSync(backupsDir).filter(name => name.toLowerCase().endsWith('.db'));
    const rows = [];
    for (const name of entries) {
      const file = path.join(backupsDir, name);
      try {
        const st = statSync(file);
        rows.push({ file, bytes: st.size, created: st.mtimeMs });
      } catch {
        // File vanished between readdir and stat — skip it.
      }
    }
    rows.sort((a, b) => b.created - a.created); // newest first
    return rows;
  } catch {
    // Dir doesn't exist yet (or unreadable) — no backups.
    return [];
  }
}

// Delete the oldest backups beyond `keep`. Returns { ok:true, removed:N } (or { ok:false, error }).
export function pruneBackups(keep = 10) {
  try {
    const all = listBackups();          // newest-first
    const doomed = all.slice(keep);     // everything past the first `keep`
    let removed = 0;
    for (const b of doomed) {
      try {
        unlinkSync(b.file);
        removed++;
      } catch {
        // Couldn't remove this one (locked/already gone) — keep going.
      }
    }
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
