const links = [...document.querySelectorAll<HTMLAnchorElement>('.toc a')];
const map = new Map(links.map(a => [a.hash.slice(1), a]));
const io = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) { links.forEach(l => l.classList.remove('on')); map.get(e.target.id)?.classList.add('on'); }
}), { rootMargin: '-20% 0px -70% 0px' });
document.querySelectorAll('.doc h2[id]').forEach(h => io.observe(h));
