// Home page: headline rise-in, section reveals and the scroll-driven vault door.
import type { Key } from './vault3d';

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

// One orchestrated load moment: the headline rises in word by word.
const h1 = document.querySelector<HTMLElement>('h1.rise');
if (h1 && !reduce) {
  const words = h1.textContent!.trim().split(/\s+/);
  h1.setAttribute('aria-label', h1.textContent!.trim());
  h1.innerHTML = words.map((w, i) => `<span class="w" aria-hidden="true"><span style="animation-delay:${80 + i * 55}ms">${w}</span></span>`).join(' ');
  h1.classList.add('go');
}

// Copy blocks fade up once as they enter.
const io = new IntersectionObserver((es) => {
  for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}, { threshold: 0.25 });
document.querySelectorAll('.reveal').forEach((el) => (reduce ? el.classList.add('in') : io.observe(el)));

// Door keyframes, one per section. x/y are fractions of the viewport from its centre.
const DESK: Key[] = [
  { x: 0.24, y: 0.07, s: 0.6, ry: -0.42, rx: 0.1, wheel: 0, bolts: 1, held: 0 },
  { x: -0.26, y: 0, s: 0.56, ry: 0.5, rx: -0.06, wheel: 2.6, bolts: 1, held: 0 },
  { x: 0.26, y: 0, s: 0.56, ry: -0.28, rx: 0.12, wheel: 2.6, bolts: 1, held: 1 },
  { x: -0.26, y: 0, s: 0.56, ry: 0.18, rx: 0, wheel: 0, bolts: 1, held: 0 },
];
const PHONE: Key[] = [
  { x: 0.1, y: -0.75, s: 0.6, ry: -0.4, rx: 0.12, wheel: 0, bolts: 1, held: 0 },
  { x: -0.06, y: 0.22, s: 0.6, ry: 0.45, rx: -0.05, wheel: 2.6, bolts: 1, held: 0 },
  { x: 0.06, y: 0.22, s: 0.6, ry: -0.3, rx: 0.12, wheel: 2.6, bolts: 1, held: 1 },
  { x: 0, y: 0.22, s: 0.64, ry: 0.15, rx: 0, wheel: 0, bolts: 1, held: 0 },
];

const ease = (t: number) => t * t * (3 - 2 * t);
function mix(a: Key, b: Key, t: number): Key {
  const o = {} as Key;
  for (const k in a) (o as any)[k] = (a as any)[k] + ((b as any)[k] - (a as any)[k]) * t;
  return o;
}

const canvas = document.querySelector<HTMLCanvasElement>('#door');
const stage = document.querySelector<HTMLElement>('.door-stage');
const sections = [...document.querySelectorAll<HTMLElement>('.dz[data-k]')];

function webgl() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}

if (canvas && stage && webgl()) {
  import('./vault3d').then(({ mountVault }) => {
    const v = mountVault(canvas, { onReady: () => stage.classList.add('ready') });
    const frames = () => (innerWidth < 760 ? PHONE : DESK);

    // Where the reader is in the story, as a fractional section index.
    function target() {
      const mid = scrollY + innerHeight / 2;
      const centres = sections.map((s) => { const r = s.getBoundingClientRect(); return r.top + scrollY + r.height / 2; });
      if (mid <= centres[0]) return 0;
      for (let i = 0; i < centres.length - 1; i++) {
        if (mid < centres[i + 1]) return i + (mid - centres[i]) / (centres[i + 1] - centres[i]);
      }
      return centres.length - 1;
    }
    function keyAt(p: number): Key {
      const f = frames();
      const i = Math.min(f.length - 2, Math.floor(p));
      return mix(f[i], f[i + 1], ease(Math.min(1, Math.max(0, p - i))));
    }

    let p = target();
    let intro = reduce ? 1 : 0;
    let raf = 0;
    let visible = true;

    function frame() {
      raf = 0;
      const t = target();
      p += (t - p) * (reduce ? 1 : 0.12);
      if (intro < 1) intro = Math.min(1, intro + 1 / 70);
      const k = keyAt(p);
      // Load moment: bolts shoot out and the wheel settles.
      const e = ease(intro);
      k.bolts *= e;
      k.wheel += (1 - e) * -3;
      v.draw(k);
      if (visible && (Math.abs(t - p) > 0.001 || intro < 1)) raf = requestAnimationFrame(frame);
    }
    const kick = () => { if (!raf && visible) raf = requestAnimationFrame(frame); };

    addEventListener('scroll', kick, { passive: true });
    addEventListener('resize', () => { v.resize(); kick(); });
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; kick(); }).observe(stage.parentElement!);
    kick();
  }).catch(() => stage.classList.add('failed'));
} else {
  stage?.classList.add('failed');
}
