export function initCountUps(reduced: boolean) {
  const els = document.querySelectorAll<HTMLElement>('[data-count]');
  if (reduced) return;
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return; io.unobserve(e.target);
    const el = e.target as HTMLElement, final = el.textContent!, to = parseFloat(el.dataset.count!);
    const dec = (el.dataset.count!.split('.')[1] || '').length, t0 = performance.now(), dur = 1400;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur), k = 1 - Math.pow(1 - p, 5);
      el.textContent = (to * k).toFixed(dec);
      if (p < 1) requestAnimationFrame(tick); else el.textContent = final;
    };
    requestAnimationFrame(tick);
  }), { threshold: 0.6 });
  els.forEach(el => io.observe(el));
}
