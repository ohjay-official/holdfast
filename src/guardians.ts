import { reduced } from './site';
const root = document.querySelector<HTMLElement>('.verb');
if (root) {
  const words = [...root.querySelectorAll<HTMLElement>('.verb-word')];
  const what = root.querySelector<HTMLElement>('.verb-what')!;
  let i = 0;
  const show = (n: number) => {
    words.forEach((w, k) => (w.hidden = k !== n));
    root.dataset.tone = words[n].dataset.tone!;
    what.textContent = words[n].dataset.what!;
    what.classList.remove('swap'); void what.offsetWidth; what.classList.add('swap');
  };
  let id = 0;
  const start = () => { if (!reduced && !id) id = window.setInterval(() => { i = (i + 1) % words.length; show(i); }, 2600); };
  const stop = () => { clearInterval(id); id = 0; };
  start();
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  root.addEventListener('pointerenter', stop); root.addEventListener('pointerleave', start);
  root.addEventListener('focusin', stop); root.addEventListener('focusout', start);
}
