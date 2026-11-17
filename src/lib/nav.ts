export function initNav() {
  const head = document.querySelector<HTMLElement>('[data-head]'); if (!head) return;
  const onScroll = () => head.classList.toggle('is-scrolled', scrollY > 24);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
  const btn = head.querySelector<HTMLButtonElement>('.menu-btn')!, menu = head.querySelector<HTMLElement>('#mobile-menu')!;
  const close = () => { btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-label', 'Open menu');
    menu.classList.remove('open'); document.body.style.overflow = ''; setTimeout(() => (menu.hidden = true), 300); btn.focus(); };
  const open = () => { menu.hidden = false; requestAnimationFrame(() => menu.classList.add('open'));
    btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-label', 'Close menu'); document.body.style.overflow = 'hidden'; };
  btn.addEventListener('click', () => (btn.getAttribute('aria-expanded') === 'true' ? close() : open()));
  addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) close(); });
  menu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => { document.body.style.overflow = ''; }));
}
