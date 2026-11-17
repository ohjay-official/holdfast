// Elements wrapped in <span class="magnetic"> follow the cursor: offset ÷ strength, within a padding radius.
export function initMagnetic(reduced: boolean) {
  if (reduced || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  document.querySelectorAll<HTMLElement>('.magnetic').forEach(wrap => {
    const el = wrap.firstElementChild as HTMLElement; if (!el) return;
    const strength = 4, pad = 40;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const dx = e.clientX - cx, dy = e.clientY - cy;
      const inside = Math.abs(dx) < r.width / 2 + pad && Math.abs(dy) < r.height / 2 + pad;
      if (inside) { el.style.transition = 'transform .3s cubic-bezier(.22,1,.36,1)'; el.style.transform = `translate3d(${dx / strength}px,${dy / strength}px,0)`; }
      else reset();
    };
    const reset = () => { el.style.transition = 'transform .6s cubic-bezier(.65,0,.35,1)'; el.style.transform = ''; };
    window.addEventListener('pointermove', move, { passive: true });
    wrap.addEventListener('pointerleave', reset);
  });
}
