export function initOrdeal(reduced: boolean) {
  const live = document.querySelector<HTMLElement>('.live'); if (!live) return;
  const [taken, held, safe] = [...live.querySelectorAll<HTMLElement>('.live-bar > span')];
  const amt = live.querySelector<HTMLElement>('.live-amt')!, label = live.querySelector<HTMLElement>('.live-label')!, when = live.querySelector<HTMLElement>('.live-when')!;
  const moments = [...document.querySelectorAll<HTMLElement>('.moment')];
  const set = (m: HTMLElement) => {
    moments.forEach(x => x.classList.toggle('is-active', x === m));
    const [t, h, s] = m.dataset.state!.split(',').map(Number);
    taken.style.width = t + '%'; held.style.width = h + '%'; safe.style.width = s + '%';
    amt.textContent = m.dataset.amt!; label.textContent = m.dataset.label!; when.textContent = m.querySelector('.when')!.textContent!;
    live.dataset.tone = h ? 'held' : m.classList.contains('glass--taken') ? 'taken' : 'safe';
  };
  set(moments[0]);
  if (reduced) return;
  const io = new IntersectionObserver(es => es.forEach(e => e.isIntersecting && set(e.target as HTMLElement)), { rootMargin: '-45% 0px -45% 0px' });
  moments.forEach(m => io.observe(m));
}
