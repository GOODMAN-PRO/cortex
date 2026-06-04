/*
 * CORTEX — graph-view.js
 * Standalone, dependency-free interactive knowledge-graph visualization.
 *
 * Plain browser JavaScript. No build step, no npm, no modules, no CDN.
 * Exposes a single global:
 *
 *   window.CortexGraph = {
 *     init(container, options = {}) -> { refresh(), destroy() }
 *   }
 *
 * options:
 *   onSelect(noteId)  — called when a node is clicked.
 *
 * Renders a force-directed layout in vanilla canvas 2D with a small
 * spring/charge simulation (cooling + requestAnimationFrame). HiDPI-aware,
 * transparent background, lime accent (#c6ff3a) for the selected node.
 */
(function () {
  'use strict';

  var ACCENT = '#c6ff3a';            // selected highlight (lime)
  var NEIGHBOR = '#9fdc6b';          // neighbor highlight (muted lime)
  var EDGE_BASE = 'rgba(150,160,175,'; // translucent edge stroke (alpha appended)
  var LABEL_COLOR = 'rgba(232,238,245,0.92)';
  var EMPTY_COLOR = 'rgba(150,160,175,0.45)';

  // ---- small math/util helpers -------------------------------------------

  // Deterministic 32-bit string hash (FNV-1a-ish). Stable across reloads so a
  // given project always maps to the same hue.
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    s = s == null ? '' : String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Project string -> pleasant HSL fill. Hue from hash; fixed sat/light for a
  // cohesive dark-mode palette.
  function colorForProject(project) {
    var hue = hashStr(project) % 360;
    return {
      fill: 'hsl(' + hue + ', 62%, 58%)',
      dim: 'hsl(' + hue + ', 40%, 46%)',
      hue: hue
    };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ---- the implementation -------------------------------------------------

  function init(container, options) {
    options = options || {};
    var onSelect = typeof options.onSelect === 'function' ? options.onSelect : null;

    if (!container) throw new Error('CortexGraph.init: container is required');

    // --- canvas setup ---
    var canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';
    // Let the page's near-black background show through.
    canvas.style.background = 'transparent';
    container.appendChild(canvas);

    var ctx = canvas.getContext('2d');

    // --- state ---
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var cssW = 0, cssH = 0;            // CSS pixel size of the canvas

    var nodes = [];                    // {id,title,project,x,y,vx,vy,deg,r,color,pinned}
    var edges = [];                    // {source,target,type, a, b}  (a/b resolved node refs)
    var nodeById = Object.create(null);
    var adjacency = Object.create(null); // id -> Set-like map of neighbor ids

    var camera = { x: 0, y: 0, scale: 1 }; // world->screen: screen = (world - cam)*scale + center

    var selectedId = null;
    var hoverId = null;

    // search/filter state (additive — independent of selection)
    var searchQuery = '';              // normalized lower-case query; '' = no search
    var matchIds = null;               // Set-like map of matching node ids, or null when inactive
    var filterProject = null;          // active project filter, or null when showing all
    var filterVisible = null;          // Set-like map of ids kept visible by the filter, or null

    var rafId = null;
    var running = false;
    var alpha = 0;                     // simulation "temperature"; cools to ~0
    var destroyed = false;

    // pointer interaction state
    var pointer = { x: 0, y: 0, down: false };
    var dragNode = null;               // node being dragged (pins it)
    var dragGrab = { dx: 0, dy: 0 };   // grab offset (node - cursor) so the node doesn't jump on grab
    var panning = false;
    var panLast = { x: 0, y: 0 };
    var downPos = { x: 0, y: 0 };      // to distinguish click from drag
    var movedSinceDown = false;

    // tooltip element (lightweight DOM, positioned over the canvas)
    var tooltip = document.createElement('div');
    tooltip.style.cssText =
      'position:absolute;pointer-events:none;z-index:10;padding:5px 9px;' +
      'font:12px/1.3 ui-sans-serif,system-ui,-apple-system,"Space Grotesk",sans-serif;' +
      'color:#eaf0f7;background:rgba(14,16,20,0.92);border:1px solid rgba(198,255,58,0.35);' +
      'border-radius:7px;white-space:nowrap;max-width:280px;overflow:hidden;' +
      'text-overflow:ellipsis;box-shadow:0 6px 22px rgba(0,0,0,0.55);' +
      'opacity:0;transition:opacity .12s ease;backdrop-filter:blur(4px);';
    // The container needs a positioning context for the absolute tooltip.
    var prevPosition = container.style.position;
    var computedPos = window.getComputedStyle(container).position;
    if (computedPos === 'static') container.style.position = 'relative';
    container.appendChild(tooltip);

    // Legend: compact, absolutely-positioned project -> color key (top-right).
    // Subtle dark panel to match the app; rows toggle the project filter.
    var legend = document.createElement('div');
    legend.style.cssText =
      'position:absolute;top:12px;right:12px;z-index:9;pointer-events:auto;' +
      'padding:7px 9px;max-width:190px;' +
      'font:11px/1.35 ui-sans-serif,system-ui,-apple-system,"Space Grotesk",sans-serif;' +
      'color:rgba(232,238,245,0.82);background:rgba(14,16,20,0.82);' +
      'border:1px solid rgba(255,255,255,0.08);border-radius:9px;' +
      'box-shadow:0 6px 22px rgba(0,0,0,0.45);backdrop-filter:blur(4px);' +
      'user-select:none;';
    legend.style.display = 'none'; // shown once we have projects to list
    container.appendChild(legend);

    // ---- sizing -----------------------------------------------------------

    function resize() {
      var rect = container.getBoundingClientRect();
      cssW = Math.max(1, Math.round(rect.width));
      cssH = Math.max(1, Math.round(rect.height));
      dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      // Draw in CSS pixels; the transform handles HiDPI scaling.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      kick(); // a resize may reveal nodes; nudge the sim + repaint
    }

    var ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(function () { resize(); });
      ro.observe(container);
    } else {
      window.addEventListener('resize', resize);
    }

    // ---- coordinate transforms -------------------------------------------

    function worldToScreen(wx, wy) {
      return {
        x: (wx - camera.x) * camera.scale + cssW / 2,
        y: (wy - camera.y) * camera.scale + cssH / 2
      };
    }
    function screenToWorld(sx, sy) {
      return {
        x: (sx - cssW / 2) / camera.scale + camera.x,
        y: (sy - cssH / 2) / camera.scale + camera.y
      };
    }

    // ---- graph data -> simulation nodes ----------------------------------

    function buildGraph(data) {
      var rawNodes = (data && Array.isArray(data.nodes)) ? data.nodes : [];
      var rawEdges = (data && Array.isArray(data.edges)) ? data.edges : [];

      // Preserve positions of nodes that still exist across a refresh.
      var prev = nodeById;

      nodes = [];
      nodeById = Object.create(null);
      adjacency = Object.create(null);

      var n = rawNodes.length;
      // Seed initial positions on a circle (deterministic, avoids NaN blowups).
      var radius = Math.max(120, Math.min(420, 26 * Math.sqrt(Math.max(1, n))));
      for (var i = 0; i < n; i++) {
        var raw = rawNodes[i];
        if (!raw || raw.id == null) continue;
        var id = raw.id;
        var existing = prev[id];
        var angle = (i / Math.max(1, n)) * Math.PI * 2;
        var col = colorForProject(raw.project);
        var node = {
          id: id,
          title: raw.title != null ? String(raw.title) : String(id),
          project: raw.project != null ? String(raw.project) : '',
          x: existing ? existing.x : Math.cos(angle) * radius + (Math.random() - 0.5) * 4,
          y: existing ? existing.y : Math.sin(angle) * radius + (Math.random() - 0.5) * 4,
          vx: 0, vy: 0,
          deg: 0,
          r: 4,
          color: col,
          pinned: existing ? existing.pinned : false
        };
        nodes.push(node);
        nodeById[id] = node;
        adjacency[id] = Object.create(null);
      }

      // Resolve edges to node refs; drop dangling edges. Count degree.
      edges = [];
      for (var e = 0; e < rawEdges.length; e++) {
        var ed = rawEdges[e];
        if (!ed) continue;
        var a = nodeById[ed.source];
        var b = nodeById[ed.target];
        if (!a || !b || a === b) continue;
        edges.push({ source: ed.source, target: ed.target, type: ed.type || 'link', a: a, b: b });
        a.deg++; b.deg++;
        adjacency[ed.source][ed.target] = true;
        adjacency[ed.target][ed.source] = true;
      }

      // Radius scales with degree (sqrt so high-degree hubs don't explode).
      for (var k = 0; k < nodes.length; k++) {
        var nd = nodes[k];
        nd.r = 4 + Math.sqrt(nd.deg) * 2.6;
      }

      // Keep selection only if it still exists.
      if (selectedId != null && !nodeById[selectedId]) selectedId = null;
      hoverId = null;

      // Fit the view to the freshly laid-out graph (only meaningful when we have nodes).
      if (nodes.length) fitToView(true);

      // Recompute search/filter maps against the new node set, and (re)build the
      // legend so its rows + colors reflect the freshly loaded projects.
      if (filterProject != null) {
        // Drop a stale filter whose project no longer exists in the data.
        var stillThere = false;
        for (var fi = 0; fi < nodes.length; fi++) {
          if (nodes[fi].project === filterProject) { stillThere = true; break; }
        }
        if (!stillThere) filterProject = null;
      }
      recomputeSearch();
      recomputeFilter();
      buildLegend();

      alpha = 1; // reheat the simulation for the new layout
    }

    function neighborsOf(id) { return adjacency[id] || EMPTY_OBJ; }
    var EMPTY_OBJ = Object.create(null);

    // ---- search / filter computation -------------------------------------
    //
    // These derive lookup maps from the current searchQuery / filterProject and
    // the loaded nodes. They never move the camera and never touch the layout —
    // draw() simply consults the maps to decide emphasis/visibility.

    // Recompute matchIds from searchQuery (case-insensitive substring on title).
    function recomputeSearch() {
      if (!searchQuery) { matchIds = null; return; }
      var m = Object.create(null);
      for (var i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        if (nd.title.toLowerCase().indexOf(searchQuery) !== -1) m[nd.id] = true;
      }
      matchIds = m;
    }

    // Recompute filterVisible from filterProject: the project's nodes plus their
    // direct neighbors. null filter -> everything visible (filterVisible = null).
    function recomputeFilter() {
      if (!filterProject) { filterVisible = null; return; }
      var vis = Object.create(null);
      for (var i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        if (nd.project === filterProject) {
          vis[nd.id] = true;
          var nbrs = neighborsOf(nd.id);
          for (var k in nbrs) vis[k] = true; // include direct neighbors
        }
      }
      filterVisible = vis;
    }

    // ---- legend -----------------------------------------------------------
    var LEGEND_CAP = 8; // distinct projects to show before collapsing to "other"

    // (Re)build the legend rows from the loaded nodes' distinct projects. Each
    // swatch reuses colorForProject(...).fill so it matches node colors exactly.
    function buildLegend() {
      if (!legend) return;
      // clear existing rows + click handlers
      while (legend.firstChild) legend.removeChild(legend.firstChild);

      // Tally nodes per project (ignoring blank/unset project labels).
      var counts = Object.create(null);
      var order = [];
      for (var i = 0; i < nodes.length; i++) {
        var pj = nodes[i].project;
        if (!pj) continue;
        if (counts[pj] === undefined) { counts[pj] = 0; order.push(pj); }
        counts[pj]++;
      }

      if (!order.length) { legend.style.display = 'none'; return; }

      // Most-populous projects first; cap the list and fold the rest into "other".
      order.sort(function (a, b) { return counts[b] - counts[a]; });
      var shown = order.slice(0, LEGEND_CAP);
      var hasOther = order.length > LEGEND_CAP;

      for (var s = 0; s < shown.length; s++) {
        legend.appendChild(makeLegendRow(shown[s], colorForProject(shown[s]).fill));
      }
      if (hasOther) {
        // "other" is a non-interactive summary row (mixed projects, no single color).
        legend.appendChild(makeLegendRow('other', 'rgba(150,160,175,0.7)', true));
      }

      legend.style.display = 'block';
      syncLegendActive();
    }

    function makeLegendRow(project, swatchColor, isOther) {
      var row = document.createElement('div');
      row.setAttribute('data-project', isOther ? '' : project);
      row.style.cssText =
        'display:flex;align-items:center;gap:7px;padding:3px 4px;border-radius:6px;' +
        (isOther ? 'cursor:default;opacity:0.75;' : 'cursor:pointer;') +
        'transition:background .12s ease;';

      var swatch = document.createElement('span');
      swatch.style.cssText =
        'flex:0 0 auto;width:10px;height:10px;border-radius:3px;' +
        'box-shadow:0 0 0 1px rgba(0,0,0,0.35) inset;background:' + swatchColor + ';';

      var label = document.createElement('span');
      label.textContent = project;
      label.style.cssText = 'flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';

      row.appendChild(swatch);
      row.appendChild(label);

      if (!isOther) {
        row.addEventListener('mouseenter', function () {
          if (filterProject !== project) row.style.background = 'rgba(255,255,255,0.06)';
        });
        row.addEventListener('mouseleave', function () {
          if (filterProject !== project) row.style.background = 'transparent';
        });
        // Clicking a row toggles the filter for that project (re-renders).
        row.addEventListener('click', function () {
          setFilter(filterProject === project ? null : project);
        });
      }
      return row;
    }

    // Reflect the active filter in the legend rows (highlight the selected one).
    function syncLegendActive() {
      if (!legend) return;
      var rows = legend.childNodes;
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row || !row.getAttribute) continue;
        var pj = row.getAttribute('data-project');
        if (pj && pj === filterProject) {
          row.style.background = 'rgba(198,255,58,0.16)';
          row.style.color = '#eaffc0';
        } else {
          row.style.background = 'transparent';
          row.style.color = '';
        }
      }
    }

    // ---- force simulation -------------------------------------------------
    //
    // Barnes-Hut would be ideal, but a simple O(n^2) repulsion is fine and
    // smooth for ~500 nodes when we (a) cool quickly and (b) skip the loop
    // once settled. Spring attraction along edges, mild gravity to center.

    var REPULSION = 5400;   // charge strength
    var SPRING = 0.012;     // edge stiffness
    var SPRING_LEN = 70;    // natural edge length
    var GRAVITY = 0.018;    // pull toward origin (keeps graph on-screen)
    var DAMPING = 0.86;     // velocity decay per step
    var MAX_V = 18;         // clamp to avoid explosions

    function step() {
      var nNodes = nodes.length;
      if (!nNodes) return;

      // Repulsion (pairwise). For larger graphs, scale step count down via alpha.
      for (var i = 0; i < nNodes; i++) {
        var a = nodes[i];
        for (var j = i + 1; j < nNodes; j++) {
          var b = nodes[j];
          var dx = a.x - b.x;
          var dy = a.y - b.y;
          var d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { d2 = 0.01; dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); }
          var dist = Math.sqrt(d2);
          var force = REPULSION / d2;
          var fx = (dx / dist) * force;
          var fy = (dy / dist) * force;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }

      // Spring attraction along edges.
      for (var e = 0; e < edges.length; e++) {
        var ed = edges[e];
        var s = ed.a, t = ed.b;
        var ex = t.x - s.x;
        var ey = t.y - s.y;
        var elen = Math.sqrt(ex * ex + ey * ey) || 0.01;
        var disp = (elen - SPRING_LEN) * SPRING;
        var ax = (ex / elen) * disp;
        var ay = (ey / elen) * disp;
        s.vx += ax; s.vy += ay;
        t.vx -= ax; t.vy -= ay;
      }

      // Gravity + integrate.
      var totalKE = 0;
      for (var k = 0; k < nNodes; k++) {
        var nd = nodes[k];
        nd.vx -= nd.x * GRAVITY;
        nd.vy -= nd.y * GRAVITY;

        nd.vx *= DAMPING;
        nd.vy *= DAMPING;

        // clamp velocity
        nd.vx = clamp(nd.vx, -MAX_V, MAX_V);
        nd.vy = clamp(nd.vy, -MAX_V, MAX_V);

        // Pinned nodes (and the actively dragged node) don't drift.
        if (nd.pinned || nd === dragNode) { nd.vx = 0; nd.vy = 0; continue; }

        // Apply temperature so motion eases out as alpha cools.
        nd.x += nd.vx * alpha;
        nd.y += nd.vy * alpha;

        totalKE += nd.vx * nd.vx + nd.vy * nd.vy;
      }

      // Cool down; settle detection uses average kinetic energy.
      alpha *= 0.985;
      var avgKE = totalKE / nNodes;
      return avgKE;
    }

    // ---- rendering --------------------------------------------------------

    function draw() {
      ctx.clearRect(0, 0, cssW, cssH); // transparent — page bg shows through

      if (!nodes.length) {
        drawEmpty();
        return;
      }

      var hasSelection = selectedId != null;
      var selNeighbors = hasSelection ? neighborsOf(selectedId) : EMPTY_OBJ;
      var hasSearch = matchIds != null;
      var hasFilter = filterVisible != null;

      // --- edges ---
      ctx.lineWidth = 1;
      for (var e = 0; e < edges.length; e++) {
        var ed = edges[e];

        // Filter: hide an edge unless BOTH endpoints are within the visible set.
        if (hasFilter && !(filterVisible[ed.source] && filterVisible[ed.target])) {
          continue;
        }

        var pa = worldToScreen(ed.a.x, ed.a.y);
        var pb = worldToScreen(ed.b.x, ed.b.y);

        var incident = hasSelection &&
          (ed.source === selectedId || ed.target === selectedId);

        // Search: an edge stays bright only if it touches a match; others dim.
        var searchDim = hasSearch &&
          !(matchIds[ed.source] || matchIds[ed.target]);

        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        if (incident) {
          ctx.strokeStyle = 'rgba(198,255,58,0.40)';
          ctx.lineWidth = 1.4;
        } else if (searchDim) {
          ctx.strokeStyle = EDGE_BASE + '0.04)';
          ctx.lineWidth = 1;
        } else {
          ctx.strokeStyle = EDGE_BASE + (hasSelection ? 0.07 : 0.14) + ')';
          ctx.lineWidth = 1;
        }
        ctx.stroke();
      }

      // --- nodes ---
      for (var i = 0; i < nodes.length; i++) {
        var nd = nodes[i];

        // Filter: nodes outside the visible set are drawn very dim (kept on
        // screen as faint context rather than removed) and never labeled.
        var filteredOut = hasFilter && !filterVisible[nd.id];

        var p = worldToScreen(nd.x, nd.y);
        var r = nd.r * Math.sqrt(camera.scale); // gentle scale response
        r = clamp(r, 2.2, 64);

        var isSelected = nd.id === selectedId;
        var isNeighbor = hasSelection && selNeighbors[nd.id];
        var isHover = nd.id === hoverId;

        // Search: a node not matching the query is dimmed (matches stay full).
        var searchFaded = hasSearch && !matchIds[nd.id];

        var faded = (hasSelection && !isSelected && !isNeighbor) ||
          searchFaded || filteredOut;

        // glow for selected / hovered
        if (isSelected) {
          ctx.shadowColor = ACCENT;
          ctx.shadowBlur = 22;
        } else if (isHover) {
          ctx.shadowColor = 'rgba(198,255,58,0.6)';
          ctx.shadowBlur = 14;
        } else {
          ctx.shadowBlur = 0;
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);

        if (isSelected) {
          ctx.fillStyle = ACCENT;
        } else if (isNeighbor) {
          ctx.fillStyle = NEIGHBOR;
        } else if (faded) {
          // Filtered-out nodes are the faintest (near-hidden context); plain
          // search/selection fades stay at the original, more legible alpha.
          ctx.globalAlpha = filteredOut ? 0.1 : 0.32;
          ctx.fillStyle = nd.color.dim;
        } else {
          ctx.fillStyle = nd.color.fill;
        }
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;

        // crisp ring on selected / hovered / neighbors
        if (isSelected || isHover) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = isSelected ? '#eaffc0' : ACCENT;
          ctx.stroke();
        } else if (isNeighbor) {
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = 'rgba(198,255,58,0.5)';
          ctx.stroke();
        }

        // Labels: only when zoomed in enough, or for emphasized nodes,
        // and only for reasonably-sized graphs (avoids clutter at 500 nodes).
        // When searching, label the matches so they read clearly; never label
        // a node hidden by the filter.
        var showLabel =
          isSelected || isHover || isNeighbor ||
          (hasSearch && matchIds[nd.id]) ||
          (!searchFaded && camera.scale > 1.15 && (nodes.length <= 140 || nd.deg >= 3));
        if (filteredOut) showLabel = false;
        if (showLabel) {
          drawLabel(nd, p, r, isSelected || isHover || (hasSearch && matchIds[nd.id]));
        }
      }
    }

    function drawLabel(nd, p, r, strong) {
      var text = nd.title;
      if (text.length > 34) text = text.slice(0, 33) + '…';
      ctx.font = (strong ? '600 ' : '500 ') +
        '12px ui-sans-serif,system-ui,-apple-system,"Space Grotesk",sans-serif';
      var tx = p.x + r + 6;
      var ty = p.y + 4;

      // subtle dark plate behind text for legibility over edges
      var w = ctx.measureText(text).width;
      ctx.globalAlpha = strong ? 0.9 : 0.55;
      ctx.fillStyle = 'rgba(10,12,16,0.72)';
      ctx.fillRect(tx - 3, ty - 11, w + 6, 15);
      ctx.globalAlpha = 1;

      ctx.fillStyle = strong ? '#f2ffd6' : LABEL_COLOR;
      ctx.fillText(text, tx, ty);
    }

    function drawEmpty() {
      ctx.save();
      ctx.fillStyle = EMPTY_COLOR;
      ctx.font = '300 17px ui-sans-serif,system-ui,-apple-system,"Space Grotesk",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No notes yet', cssW / 2, cssH / 2);
      ctx.restore();
    }

    // ---- animation loop ---------------------------------------------------

    function frame() {
      if (destroyed) return;
      var avgKE = step();
      draw();

      // Stop the loop once the layout has settled (cool + low energy) and the
      // user isn't actively interacting. A repaint-on-demand keeps it cheap.
      var settled = (alpha < 0.02) || (avgKE !== undefined && avgKE < 0.05 && alpha < 0.15);
      if (settled && !dragNode && !panning) {
        running = false;
        rafId = null;
        draw(); // final crisp frame
        return;
      }
      rafId = requestAnimationFrame(frame);
    }

    function ensureRunning() {
      if (!running && !destroyed) {
        running = true;
        rafId = requestAnimationFrame(frame);
      }
    }

    // Reheat + run (used on data change, resize, interaction).
    function kick(amount) {
      if (destroyed) return;
      alpha = Math.max(alpha, amount || 0.35);
      ensureRunning();
    }

    // Repaint without reheating (used for hover/pan/selection where layout
    // doesn't need to change).
    function repaint() {
      if (destroyed) return;
      if (running) return;       // the loop will paint
      requestAnimationFrame(function () { if (!destroyed && !running) draw(); });
    }

    // ---- view fitting -----------------------------------------------------

    function fitToView(instant) {
      if (!nodes.length) return;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        if (nd.x < minX) minX = nd.x;
        if (nd.y < minY) minY = nd.y;
        if (nd.x > maxX) maxX = nd.x;
        if (nd.y > maxY) maxY = nd.y;
      }
      var w = Math.max(1, maxX - minX);
      var h = Math.max(1, maxY - minY);
      var pad = 80;
      var sx = (cssW - pad * 2) / w;
      var sy = (cssH - pad * 2) / h;
      var s = Math.min(sx, sy);
      s = clamp(s, 0.15, 2.2);
      camera.x = (minX + maxX) / 2;
      camera.y = (minY + maxY) / 2;
      camera.scale = isFinite(s) ? s : 1;
    }

    // ---- hit testing ------------------------------------------------------

    function nodeAt(sx, sy) {
      // Iterate front-to-back (last drawn = on top). Generous radius for touch.
      for (var i = nodes.length - 1; i >= 0; i--) {
        var nd = nodes[i];
        var p = worldToScreen(nd.x, nd.y);
        var r = clamp(nd.r * Math.sqrt(camera.scale), 2.2, 64) + 4;
        var dx = sx - p.x, dy = sy - p.y;
        if (dx * dx + dy * dy <= r * r) return nd;
      }
      return null;
    }

    // ---- pointer events ---------------------------------------------------

    function localPoint(ev) {
      var rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    function onPointerDown(ev) {
      var pt = localPoint(ev);
      pointer.down = true;
      downPos.x = pt.x; downPos.y = pt.y;
      movedSinceDown = false;

      var hit = nodeAt(pt.x, pt.y);
      if (hit) {
        dragNode = hit;
        var gw = screenToWorld(pt.x, pt.y);
        dragGrab.dx = hit.x - gw.x;     // grab the node where you actually clicked it
        dragGrab.dy = hit.y - gw.y;
        // Freeze the layout while dragging so ONLY this node moves (no swimming/jitter).
        running = false;
        if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
        alpha = Math.min(alpha, 0.04);
        canvas.style.cursor = 'grabbing';
      } else {
        panning = true;
        panLast.x = pt.x; panLast.y = pt.y;
        canvas.style.cursor = 'grabbing';
      }
      try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    }

    function onPointerMove(ev) {
      var pt = localPoint(ev);
      pointer.x = pt.x; pointer.y = pt.y;

      var dxFromDown = pt.x - downPos.x, dyFromDown = pt.y - downPos.y;
      if (dxFromDown * dxFromDown + dyFromDown * dyFromDown > 16) movedSinceDown = true;

      if (dragNode) {
        // Reposition (and pin) the dragged node under the cursor, keeping the grab offset.
        var world = screenToWorld(pt.x, pt.y);
        dragNode.x = world.x + dragGrab.dx;
        dragNode.y = world.y + dragGrab.dy;
        dragNode.vx = 0; dragNode.vy = 0;
        dragNode.pinned = true;
        draw(); // immediate redraw; layout stays frozen so the rest of the graph is rock-stable
        return;
      }

      if (panning) {
        var dx = pt.x - panLast.x;
        var dy = pt.y - panLast.y;
        camera.x -= dx / camera.scale;
        camera.y -= dy / camera.scale;
        panLast.x = pt.x; panLast.y = pt.y;
        repaint();
        return;
      }

      // Hover detection (no buttons pressed).
      var hit = nodeAt(pt.x, pt.y);
      var newHover = hit ? hit.id : null;
      if (newHover !== hoverId) {
        hoverId = newHover;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        updateTooltip(hit, pt);
        repaint();
      } else if (hit) {
        updateTooltip(hit, pt); // keep tooltip following the cursor
      }
    }

    function onPointerUp(ev) {
      var pt = localPoint(ev);
      try { canvas.releasePointerCapture(ev.pointerId); } catch (_) {}

      if (dragNode) {
        // A click (no real movement) on a node selects it.
        if (!movedSinceDown) {
          selectNode(dragNode);
        }
        dragNode = null;
      } else if (panning) {
        panning = false;
      }

      pointer.down = false;
      var over = nodeAt(pt.x, pt.y);
      canvas.style.cursor = over ? 'pointer' : 'grab';
      // settle after interaction
      ensureRunning();
    }

    function onPointerLeave() {
      if (hoverId !== null && !dragNode) {
        hoverId = null;
        hideTooltip();
        repaint();
      }
    }

    function onWheel(ev) {
      ev.preventDefault();
      var pt = localPoint(ev);
      // Zoom toward the cursor: keep the world point under the cursor fixed.
      var before = screenToWorld(pt.x, pt.y);
      var factor = Math.pow(1.0015, -ev.deltaY); // smooth, trackpad-friendly
      camera.scale = clamp(camera.scale * factor, 0.12, 6);
      var after = screenToWorld(pt.x, pt.y);
      camera.x += before.x - after.x;
      camera.y += before.y - after.y;
      repaint();
    }

    function selectNode(node) {
      selectedId = node.id;
      hideTooltip();
      repaint();
      if (onSelect) {
        try { onSelect(node.id); } catch (err) { /* swallow consumer errors */ }
      }
    }

    // ---- tooltip ----------------------------------------------------------

    function updateTooltip(node, pt) {
      if (!node) { hideTooltip(); return; }
      tooltip.textContent = node.title;
      // Position near the cursor, flipping to stay inside the container.
      var ox = pt.x + 14;
      var oy = pt.y + 14;
      // Measure after setting text.
      var tw = tooltip.offsetWidth || 120;
      var th = tooltip.offsetHeight || 24;
      if (ox + tw > cssW - 6) ox = pt.x - tw - 14;
      if (oy + th > cssH - 6) oy = pt.y - th - 14;
      tooltip.style.left = Math.max(4, ox) + 'px';
      tooltip.style.top = Math.max(4, oy) + 'px';
      tooltip.style.opacity = '1';
    }

    function hideTooltip() {
      tooltip.style.opacity = '0';
    }

    // ---- wiring -----------------------------------------------------------

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    // ---- data fetch -------------------------------------------------------

    function load() {
      return fetch('/api/graph')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (destroyed) return;
          buildGraph(data);
          // size may not be known until first layout pass
          if (!cssW || !cssH) resize();
          kick(1);
        })
        .catch(function (err) {
          if (destroyed) return;
          // On failure, render an empty state rather than throwing.
          buildGraph({ nodes: [], edges: [] });
          draw();
          // surface for debugging without breaking the app shell
          if (window && window.console) console.error('CortexGraph: failed to load /api/graph', err);
        });
    }

    // ---- public API -------------------------------------------------------

    // Highlight nodes whose title contains `query` (case-insensitive); dim the
    // rest and their edges. Blank/empty clears the highlight. Never moves the
    // camera. Returns the number of matches (handy for callers).
    function search(query) {
      if (destroyed) return 0;
      var q = (query == null ? '' : String(query)).trim().toLowerCase();
      searchQuery = q;
      recomputeSearch();
      repaint(); // re-render only; layout + camera untouched
      return matchIds ? Object.keys(matchIds).length : 0;
    }

    // Show only nodes whose project === `project` plus their direct neighbors
    // (others very dim). null/empty clears the filter (show all). Re-renders.
    function setFilter(project) {
      if (destroyed) return;
      var p = (project == null ? '' : String(project)).trim();
      filterProject = p ? p : null;
      recomputeFilter();
      syncLegendActive(); // reflect active row in the legend
      repaint();          // re-render only; layout + camera untouched
    }

    function refresh() {
      return load();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      running = false;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }

      if (ro) { try { ro.disconnect(); } catch (_) {} ro = null; }
      else window.removeEventListener('resize', resize);

      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);

      if (tooltip && tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
      if (legend && legend.parentNode) legend.parentNode.removeChild(legend);
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);

      // restore container positioning if we changed it
      if (computedPos === 'static') container.style.position = prevPosition;

      nodes = []; edges = []; nodeById = Object.create(null); adjacency = Object.create(null);
    }

    // initial size + load
    resize();
    load();

    return {
      refresh: refresh,
      destroy: destroy,
      search: search,
      setFilter: setFilter
    };
  }

  // expose the global contract
  window.CortexGraph = { init: init };
})();
