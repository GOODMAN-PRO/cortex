import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';
import { existsSync } from 'fs';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env or .env.example
const envPath = join(__dirname, '.env');
const examplePath = join(__dirname, '.env.example');
const dotenvFile = existsSync(envPath) ? envPath : examplePath;
config({ path: dotenvFile });

const CORTEX_HOST = process.env.CORTEX_HOST || '127.0.0.1';
const CORTEX_PORT = parseInt(process.env.CORTEX_PORT || '7002', 10);
const CORTEX_URL = `http://${CORTEX_HOST}:${CORTEX_PORT}`;

let mainWindow;
let isShuttingDown = false;

// Security: ensure only localhost can connect
if (CORTEX_HOST !== '127.0.0.1' && CORTEX_HOST !== 'localhost') {
  console.error(
    `[CORTEX] Security Error: CORTEX_HOST must be localhost (got "${CORTEX_HOST}"). Refusing to start.`
  );
  app.quit();
}

/**
 * Poll for CORTEX server readiness
 * @param {number} maxAttempts - Maximum polling attempts
 * @param {number} delayMs - Delay between attempts
 * @returns {Promise<boolean>}
 */
async function waitForServer(maxAttempts = 30, delayMs = 500) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${CORTEX_URL}/health`, {
        timeout: 2000,
        method: 'GET',
      });
      if (response.ok || response.status === 404) {
        // 404 is OK—server is running, just no /health endpoint
        console.log(`[CORTEX] Server ready at ${CORTEX_URL}`);
        return true;
      }
    } catch (err) {
      // Server not ready yet
    }

    if (i < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  console.warn(`[CORTEX] Server did not become ready at ${CORTEX_URL} after ${maxAttempts * delayMs}ms`);
  return false;
}

/**
 * Validate window bounds to prevent off-screen placement
 * @param {Object} bounds - Window bounds { x, y, width, height }
 * @returns {Object} Validated bounds
 */
function validateWindowBounds(bounds) {
  const minWidth = 800;
  const minHeight = 600;

  if (!bounds || typeof bounds !== 'object') {
    return { width: minWidth, height: minHeight, x: undefined, y: undefined };
  }

  const validated = {
    width: Math.max(bounds.width || minWidth, minWidth),
    height: Math.max(bounds.height || minHeight, minHeight),
  };

  // Only set position if both x and y are valid numbers
  if (typeof bounds.x === 'number' && typeof bounds.y === 'number') {
    validated.x = bounds.x;
    validated.y = bounds.y;
  }

  return validated;
}

/**
 * Create and show the main window
 */
function createWindow() {
  // Load persisted bounds or use defaults
  let savedBounds;
  try {
    const boundsFile = join(__dirname, '.window-state.json');
    if (existsSync(boundsFile)) {
      const content = JSON.parse(require('fs').readFileSync(boundsFile, 'utf-8'));
      savedBounds = content.bounds;
    }
  } catch (err) {
    console.warn('[CORTEX] Failed to load window state:', err.message);
  }

  const bounds = validateWindowBounds(savedBounds);

  const windowConfig = {
    ...bounds,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      sandbox: true,
    },
    icon: process.platform === 'darwin' ? undefined : join(__dirname, 'icon.png'),
  };

  mainWindow = new BrowserWindow(windowConfig);

  // Apply CSP via headers
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: https:; " +
          "font-src 'self' data:; " +
          "connect-src 'self' http://127.0.0.1:7002; " +
          "frame-src 'none'; " +
          "object-src 'none'",
        ],
        'X-Content-Type-Options': ['nosniff'],
        'X-Frame-Options': ['DENY'],
        'X-XSS-Protection': ['1; mode=block'],
      },
    });
  });

  // Log IPC calls for security audit
  ipcMain.on('cortex:log', (event, level, ...args) => {
    const validLevels = ['info', 'warn', 'error'];
    if (!validLevels.includes(level)) return;
    const fn = console[level] || console.log;
    fn('[CORTEX-APP]', ...args);
  });

  // Handle window bounds persistence
  mainWindow.on('close', () => {
    if (!isShuttingDown) {
      const bounds = mainWindow.getBounds();
      try {
        const fs = require('fs');
        fs.writeFileSync(
          join(__dirname, '.window-state.json'),
          JSON.stringify({ bounds }, null, 2)
        );
      } catch (err) {
        console.warn('[CORTEX] Failed to save window state:', err.message);
      }
    }
  });

  // Load the app from localhost
  mainWindow.loadURL(`${CORTEX_URL}/app`);

  // Open DevTools in development (remove in production)
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

/**
 * App lifecycle
 */
app.on('ready', async () => {
  console.log('[CORTEX] Electron app starting...');
  console.log(`[CORTEX] Waiting for server at ${CORTEX_URL}...`);

  // Check if server is ready
  const serverReady = await waitForServer();

  if (!serverReady) {
    const { dialog } = await import('electron');
    dialog.showErrorBox(
      'CORTEX Server Error',
      `Could not connect to CORTEX server at ${CORTEX_URL}.\n\n` +
        'Please ensure the CORTEX server is running:\n' +
        '  node workspace/cortex/server.mjs'
    );
    app.quit();
    return;
  }

  createWindow();

  // Minimal menu to disable default shortcuts
  const template = [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
});

app.on('window-all-closed', () => {
  isShuttingDown = true;
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Prevent opening external URLs
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    // Only allow localhost URLs
    if (url.startsWith(`${CORTEX_URL}/`)) {
      return { action: 'allow' };
    }
    // Block external URLs
    console.warn(`[CORTEX] Blocked navigation to external URL: ${url}`);
    return { action: 'deny' };
  });

  // Log console messages from renderer
  contents.on('console-message', (level, message, line, sourceId) => {
    console.log(`[CORTEX-RENDERER:${level}] ${sourceId}:${line} - ${message}`);
  });
});

export { mainWindow };
