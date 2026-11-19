export function initNav() {
  const head = document.querySelector<HTMLElement>('[data-head]');
  if (!head) return;
  const onScroll = () => head.classList.toggle('is-scrolled', scrollY > 24);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const btn = head.querySelector<HTMLButtonElement>('.menu-btn');
  const menu = head.querySelector<HTMLElement>('#site-menu');
  if (!btn || !menu) return;

  menu.querySelectorAll<HTMLElement>('[data-n]').forEach((el, i) => {
    el.textContent = String(i + 1).padStart(2, '0');
  });
  menu.querySelectorAll<HTMLElement>('.menu-row, .menu-chip, .menu-cta').forEach((el, i) => {
    el.style.setProperty('--i', String(i));
  });

  let prevOverflow = '';

  const shut = () => {
    menu.classList.remove('is-open');
    menu.setAttribute('aria-hidden', 'true');
    menu.setAttribute('inert', '');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Open menu');
  };
  shut();

  const close = (returnFocus: boolean) => {
    if (btn.getAttribute('aria-expanded') !== 'true') return;
    shut();
    document.body.style.overflow = prevOverflow;
    if (returnFocus) btn.focus();
  };

  const open = () => {
    if (btn.getAttribute('aria-expanded') === 'true') return;
    prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    menu.removeAttribute('inert');
    menu.setAttribute('aria-hidden', 'false');
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-label', 'Close menu');
    menu.classList.add('is-open');
    menu.querySelector<HTMLElement>('.menu-row')?.focus();
  };

  btn.addEventListener('click', () => {
    if (btn.getAttribute('aria-expanded') === 'true') close(false);
    else open();
  });

  addEventListener('keydown', (e) => {
    if (btn.getAttribute('aria-expanded') !== 'true') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [btn, ...menu.querySelectorAll<HTMLElement>('a, button')];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === btn) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      btn.focus();
    }
  });

  addEventListener('pointerdown', (e) => {
    if (btn.getAttribute('aria-expanded') !== 'true') return;
    const t = e.target as Node;
    if (!menu.contains(t) && !btn.contains(t)) close(false);
  });

  menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => close(false)));
  addEventListener('hashchange', () => close(false));
}
