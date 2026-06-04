// Nav blur on scroll
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });

// Bidirectional scroll reveals — re-animates when scrolling back up
const observer = new IntersectionObserver(
  (entries) => entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.classList.add('visible');
    } else {
      e.target.classList.remove('visible');
    }
  }),
  { threshold: 0.12, rootMargin: '0px 0px -60px 0px' }
);

document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .reveal-scale').forEach(el => observer.observe(el));

// Stagger children inside .stagger containers
document.querySelectorAll('.stagger').forEach(parent => {
  [...parent.children].forEach((child, i) => {
    child.style.transitionDelay = `${i * 0.1}s`;
  });
});

// Animated counters — count up when visible
const counterObserver = new IntersectionObserver(
  (entries) => entries.forEach(e => {
    if (e.isIntersecting && !e.target.dataset.animated) {
      e.target.dataset.animated = 'true';
      const target = parseInt(e.target.dataset.target);
      const duration = 2000;
      const start = Date.now();
      const animate = () => {
        const elapsed = Date.now() - start;
        const progress = Math.min(elapsed / duration, 1);
        const current = Math.floor(progress * target);
        e.target.textContent = current;
        if (progress < 1) requestAnimationFrame(animate);
      };
      animate();
    }
  }),
  { threshold: 0.5 }
);

document.querySelectorAll('.counter').forEach(el => counterObserver.observe(el));

// ── Typewriter animations ─────────────────────────────────
// Wrap code-pre content into per-line spans for reveal
document.querySelectorAll('.code-pre code').forEach(code => {
  code.innerHTML = code.innerHTML.split('\n')
    .map(l => `<span class="code-line">${l || ' '}</span>`)
    .join('');
});

// Save original text so typing can be re-run on bidirectional scroll
document.querySelectorAll('.term-bar, .api-path').forEach(el => {
  el.dataset.orig = el.textContent;
});

function typeText(el, charDelay, onDone) {
  const full = el.dataset.orig;
  const gen = (+(el.dataset.typeGen || 0)) + 1;
  el.dataset.typeGen = gen;
  el.textContent = '';
  const cursor = document.createElement('span');
  cursor.className = 'type-cursor';
  el.appendChild(cursor);
  let i = 0;
  (function step() {
    if (+el.dataset.typeGen !== gen) return;
    if (i >= full.length) { cursor.remove(); onDone && onDone(); return; }
    cursor.insertAdjacentText('beforebegin', full[i++]);
    setTimeout(step, charDelay);
  })();
}

function revealLines(lines, startDelay, interval) {
  lines.forEach((el, i) =>
    setTimeout(() => el.classList.add('typed-in'), startDelay + i * interval)
  );
}

const twObs = new IntersectionObserver(entries => {
  entries.forEach(({ target: el, isIntersecting }) => {
    if (isIntersecting) {
      if (el.classList.contains('terminal-mock')) {
        el.classList.add('type-active');
        const bar = el.querySelector('.term-bar');
        const lines = [...el.querySelectorAll('.term-ln')];
        lines.forEach(l => l.classList.remove('typed-in'));
        typeText(bar, 38, () => revealLines(lines, 60, 140));
      }
      if (el.classList.contains('api-mock')) {
        el.classList.add('type-active');
        const path = el.querySelector('.api-path');
        const fields = [...el.querySelectorAll('.api-brace, .api-field')];
        fields.forEach(l => l.classList.remove('typed-in'));
        typeText(path, 28, () => revealLines(fields, 50, 120));
      }
      if (el.classList.contains('code-pre')) {
        const lines = [...el.querySelectorAll('.code-line')];
        lines.forEach(l => l.classList.remove('typed-in'));
        revealLines(lines, 120, 90);
      }
    } else {
      if (el.classList.contains('terminal-mock')) {
        const bar = el.querySelector('.term-bar');
        if (bar) { bar.dataset.typeGen = (+(bar.dataset.typeGen || 0)) + 1; bar.textContent = bar.dataset.orig; }
        el.querySelectorAll('.term-ln').forEach(l => l.classList.remove('typed-in'));
        el.classList.remove('type-active');
      }
      if (el.classList.contains('api-mock')) {
        const path = el.querySelector('.api-path');
        if (path) { path.dataset.typeGen = (+(path.dataset.typeGen || 0)) + 1; path.textContent = path.dataset.orig; }
        el.querySelectorAll('.api-brace, .api-field').forEach(l => l.classList.remove('typed-in'));
        el.classList.remove('type-active');
      }
      if (el.classList.contains('code-pre')) {
        el.querySelectorAll('.code-line').forEach(l => l.classList.remove('typed-in'));
      }
    }
  });
}, { threshold: 0.35 });

document.querySelectorAll('.terminal-mock, .api-mock, .code-pre').forEach(el => twObs.observe(el));

// ── Graph node pop-in ─────────────────────────────────────
const graphObserver = new IntersectionObserver(entries => {
  entries.forEach(({ target, isIntersecting }) => {
    const center = target.querySelector('.graph-node-center');
    const nodes  = [...target.querySelectorAll('.graph-node')];
    if (isIntersecting) {
      if (center) setTimeout(() => center.classList.add('node-pop'), 80);
      nodes.forEach((n, i) => setTimeout(() => n.classList.add('node-pop'), 220 + i * 140));
    } else {
      if (center) center.classList.remove('node-pop');
      nodes.forEach(n => n.classList.remove('node-pop'));
    }
  });
}, { threshold: 0.25 });

document.querySelectorAll('.graph-mock').forEach(el => graphObserver.observe(el));

// Parallax scroll effect on hero graph and cap visuals
window.addEventListener('scroll', () => {
  const scrollY = window.scrollY;

  // Hero graph parallax
  const heroGraph = document.querySelector('.hero-graph');
  if (heroGraph) {
    heroGraph.style.transform = `translateY(${scrollY * 0.4}px) scale(${1 - scrollY * 0.0002})`;
  }

  // Cap visual parallax
  document.querySelectorAll('.cap-visual').forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    const centerOffset = rect.top - window.innerHeight / 2;
    el.style.transform = `translateY(${centerOffset * 0.08}px)`;
  });
}, { passive: true });

