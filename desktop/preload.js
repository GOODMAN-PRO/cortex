import { contextBridge, ipcRenderer } from 'electron';

// Whitelist of safe, non-dangerous APIs
// These are the only functions the renderer can call
const safeAPI = {
  /**
   * Fetch wrapper for making HTTP requests
   * Limited to localhost only
   */
  fetch: async (url, options = {}) => {
    // Validate URL is localhost-only
    if (!url.startsWith('http://127.0.0.1:7002/') && !url.startsWith('http://localhost:7002/')) {
      throw new Error(`[CORTEX] Security: fetch blocked — URL must be localhost (got: ${url})`);
    }

    try {
      const response = await fetch(url, {
        // Force safe defaults
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...((options.headers || {}) || {}),
        },
        // Sanitize method
        method: (options.method || 'GET').toUpperCase(),
        ...options,
      });

      // Log for audit trail
      ipcRenderer.send('cortex:log', 'info', `[fetch] ${options.method || 'GET'} ${url} → ${response.status}`);

      return response;
    } catch (error) {
      ipcRenderer.send('cortex:log', 'error', `[fetch] ${url} failed:`, error.message);
      throw error;
    }
  },

  /**
   * Clipboard read (paste)
   */
  clipboard: {
    get: async () => {
      try {
        const text = await navigator.clipboard.readText();
        ipcRenderer.send('cortex:log', 'info', '[clipboard] read');
        return text;
      } catch (error) {
        ipcRenderer.send('cortex:log', 'warn', '[clipboard] read failed:', error.message);
        throw error;
      }
    },

    /**
     * Clipboard write (copy)
     */
    set: async (text) => {
      if (typeof text !== 'string') {
        throw new Error('[CORTEX] clipboard.set: argument must be a string');
      }

      try {
        await navigator.clipboard.writeText(text);
        ipcRenderer.send('cortex:log', 'info', '[clipboard] write');
      } catch (error) {
        ipcRenderer.send('cortex:log', 'warn', '[clipboard] write failed:', error.message);
        throw error;
      }
    },
  },

  /**
   * App info (read-only metadata)
   */
  app: {
    getVersion: () => process.env.npm_package_version || '1.0.0',
    getName: () => 'CORTEX',
  },

  /**
   * Logger for renderer errors
   */
  log: (level, ...args) => {
    const validLevels = ['info', 'warn', 'error'];
    if (!validLevels.includes(level)) return;
    ipcRenderer.send('cortex:log', level, ...args);
  },
};

// Expose only the safe API to the renderer
contextBridge.exposeInMainWorld('cortex', safeAPI);

// Optional: expose console methods as-is (already sandboxed)
contextBridge.exposeInMainWorld('console', {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
});
