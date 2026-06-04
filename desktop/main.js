// CORTEX Desktop — Electron shell that manages the local CORTEX server.
//
// Strategy:
//   1. If a CORTEX server is already answering on the port (e.g. the user's own
//      full server with the embedding model), reuse it — full semantic features.
//   2. Otherwise spawn the bundled lightweight server (Node from PATH) writing its
//      DB to the app's userData dir. Semantic search degrades to keyword if the
//      model isn't present; everything else works.
// The spawned server (if any) is killed on quit. Existing servers are left alone.

import { app, BrowserWindow, Menu, dialog, shell, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.CORTEX_PORT || '7002', 10);
const BASE = `http://${HOST}:${PORT}`;

let mainWindow = null;
let serverProc = null;   // our spawned child (null when reusing an existing server)
let shuttingDown = false;

// ---- single instance: never run two copies (would double-spawn the server) ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
}

// ---- locate the bundled server (packaged) or the repo server (dev) ----
function serverPaths() {
  const packed = join(process.resourcesPath || '', 'app-server', 'cortex', 'server.mjs');
  if (existsSync(packed)) return { script: packed, cwd: dirname(packed) };
  const dev = join(__dirname, '..', 'server.mjs'); // desktop/ -> cortex/server.mjs
  return { script: dev, cwd: dirname(dev) };
}

// ---- find a Node runtime (server needs node:sqlite => Node 22+) ----
function findNode() {
  const abs = [];
  if (process.platform === 'win32') {
    if (process.env.ProgramFiles) abs.push(join(process.env.ProgramFiles, 'nodejs', 'node.exe'));
    if (process.env.LOCALAPPDATA) abs.push(join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'));
  } else {
    abs.push('/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node');
  }
  for (const p of abs) if (existsSync(p)) return p;
  return process.platform === 'win32' ? 'node.exe' : 'node'; // fall back to PATH lookup
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/api/health`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(tries = 60, delay = 500) {
  for (let i = 0; i < tries; i++) {
    if (await ping()) return true;
    await new Promise(r => setTimeout(r, delay));
  }
  return false;
}

async function ensureServer() {
  if (await ping()) return 'existing';            // reuse the user's running server

  const { script, cwd } = serverPaths();
  if (!existsSync(script)) throw new Error(`CORTEX server not found at ${script}`);

  const dbPath = join(app.getPath('userData'), 'cortex.db');
  const node = findNode();
  serverProc = spawn(node, [script], {
    cwd,
    env: { ...process.env, CORTEX_PORT: String(PORT), CORTEX_DB: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProc.stdout.on('data', d => console.log('[cortex-server]', String(d).trimEnd()));
  serverProc.stderr.on('data', d => console.error('[cortex-server]', String(d).trimEnd()));
  serverProc.on('error', (e) => console.error('[cortex-server] spawn error:', e.message));
  serverProc.on('exit', (code) => { if (!shuttingDown) console.error('[cortex-server] exited', code); serverProc = null; });

  if (!(await waitForServer())) throw new Error('the CORTEX server did not become ready in time');
  return 'spawned';
}

function killServer() {
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill(); } catch { /* ignore */ }
  }
  serverProc = null;
}

// ---- window bounds persistence ----
function loadBounds() {
  try {
    const f = join(app.getPath('userData'), 'window-state.json');
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf-8')).bounds;
  } catch { /* ignore */ }
  return null;
}
function saveBounds() {
  if (!mainWindow) return;
  try {
    writeFileSync(join(app.getPath('userData'), 'window-state.json'),
      JSON.stringify({ bounds: mainWindow.getBounds() }));
  } catch { /* ignore */ }
}

function createWindow() {
  const b = loadBounds();
  mainWindow = new BrowserWindow({
    width: Math.max(b?.width || 1280, 800),
    height: Math.max(b?.height || 860, 600),
    x: (typeof b?.x === 'number') ? b.x : undefined,
    y: (typeof b?.y === 'number') ? b.y : undefined,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#09090b',
    title: 'CORTEX',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Permissive-but-scoped CSP: our own localhost content + Google Fonts. Keeps the
  // SPA fully functional while blocking arbitrary remote origins.
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' data: blob: " + BASE + " https://fonts.googleapis.com https://fonts.gstatic.com",
        ],
      },
    });
  });

  mainWindow.on('close', saveBounds);
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(`${BASE}/app`);
}

ipcMain.on('cortex:log', (_e, level, ...args) => {
  const fn = ['info', 'warn', 'error'].includes(level) ? console[level] : console.log;
  fn('[cortex-app]', ...args);
});

app.whenReady().then(async () => {
  try {
    const mode = await ensureServer();
    console.log('[CORTEX] server mode:', mode);
  } catch (e) {
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'CORTEX could not start',
      message: 'Could not start the CORTEX server.',
      detail: `${e.message}\n\nCORTEX needs Node.js 22 or newer on your system. Install it from nodejs.org, then open CORTEX again.`,
      buttons: ['Get Node.js', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) shell.openExternal('https://nodejs.org/');
    app.quit();
    return;
  }

  createWindow();

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
  ]));
});

app.on('activate', () => { if (mainWindow === null) createWindow(); });

app.on('window-all-closed', () => {
  shuttingDown = true;
  killServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { shuttingDown = true; killServer(); });
process.on('exit', killServer);

// Open external links in the system browser; keep app navigation to our origin.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(BASE)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (ev, url) => {
    if (!url.startsWith(BASE)) { ev.preventDefault(); shell.openExternal(url); }
  });
});
