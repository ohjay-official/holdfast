const SHOW = '[data-reveal], .mask, .bar, .num-strip, [data-inview]';

function showAll() {
  document.querySelectorAll<HTMLElement>(SHOW).forEach(t => t.classList.add('in'));
  document.documentElement.classList.add('revealed');
}

export function initReveal(reduced: boolean) {
  const failSafe = window.setTimeout(showAll, 2500);
  try {
    document.querySelectorAll<HTMLElement>('[data-stagger]').forEach(group => {
      [...group.querySelectorAll<HTMLElement>(':scope > [data-reveal], :scope > * > [data-reveal]')]
        .forEach((el, i) => el.style.setProperty('--i', String(i)));
    });
    const targets = document.querySelectorAll<HTMLElement>(SHOW);
    if (reduced || !('IntersectionObserver' in window)) { showAll(); window.clearTimeout(failSafe); return; }
    const io = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { threshold: 0.15, rootMargin: '0px 0px -5% 0px' });
    targets.forEach(t => io.observe(t));
    // anything already in view on load (e.g. hero) reveals on the next frame
    requestAnimationFrame(() => targets.forEach(t => {
      const r = t.getBoundingClientRect(); if (r.top < innerHeight && r.bottom > 0) t.classList.add('in');
    }));
  } catch {
    showAll();
    window.clearTimeout(failSafe);
  }
}
