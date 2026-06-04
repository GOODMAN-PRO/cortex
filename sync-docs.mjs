// Sync public/ -> docs/ for GitHub Pages.
//
// GitHub Pages serves this repo from main:/docs, and a *project* page lives at a
// subpath (e.g. https://<user>.github.io/cortex/). Absolute asset paths like
// "/shots/x.png" resolve against the domain root there and 404. This tool rewrites
// the site's absolute asset paths to RELATIVE ones — which resolve correctly both
// when served from public/ at "/" locally (Express) AND from docs/ at "/cortex/" on
// Pages — then mirrors the static site into docs/.
//
// Run after any change to public/index.html: `node sync-docs.mjs`
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pub = join(root, 'public');
const docs = join(root, 'docs');
mkdirSync(join(docs, 'shots'), { recursive: true });

// Absolute -> relative for assets that must resolve under the Pages subpath.
const toRelative = (html) => html
  .replace(/(src|href)="\/shots\//g, '$1="shots/')
  .replace(/(src|href)="\/graph-view\.js"/g, '$1="graph-view.js"')
  .replace(/href="\/app"/g, 'href="app.html"');

// index.html: rewrite in place (so local == Pages) and mirror to docs/.
const idx = toRelative(readFileSync(join(pub, 'index.html'), 'utf8'));
writeFileSync(join(pub, 'index.html'), idx);
writeFileSync(join(docs, 'index.html'), idx);

// Supporting static files copied as-is.
for (const f of ['app.html', 'graph-view.js']) {
  if (existsSync(join(pub, f))) copyFileSync(join(pub, f), join(docs, f));
}
for (const f of readdirSync(join(pub, 'shots'))) {
  copyFileSync(join(pub, 'shots', f), join(docs, 'shots', f));
}

console.log('synced public -> docs (relative asset paths)');
