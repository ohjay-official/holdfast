import { reduced } from './site';
export function initSteps() {
  document.querySelectorAll<HTMLElement>('.steps').forEach(list => {
    const items = [...list.querySelectorAll<HTMLElement>(':scope > li')];
    const nodes = [...document.querySelectorAll<SVGCircleElement>('.ring-nodes circle')];
    const prog = document.querySelector<SVGCircleElement>('.ring-prog');
    if (reduced) { list.style.setProperty('--p', '1'); items.forEach(i => i.classList.add('done')); nodes.forEach(n => n.classList.add('on')); prog?.setAttribute('stroke-dashoffset', '0'); return; }
    const update = () => {
      const r = list.getBoundingClientRect(), mid = innerHeight * 0.55;
      const p = Math.min(1, Math.max(0, (mid - r.top) / r.height));
      list.style.setProperty('--p', p.toFixed(3));
      items.forEach((li, i) => { const on = li.getBoundingClientRect().top < mid; li.classList.toggle('done', on); nodes[i]?.classList.toggle('on', on); });
      prog?.setAttribute('stroke-dashoffset', String(1 - p));
    };
    addEventListener('scroll', update, { passive: true }); addEventListener('resize', update); update();
  });
}
initSteps();
