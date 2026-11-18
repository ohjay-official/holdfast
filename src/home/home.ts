import { reduced } from '../site';
import { initOrdeal } from './ordeal';
import type { DoorState } from './vault3d';

const K: DoorState[] = [
  { x: .22,  y: .02, s: .78, ry: -.42, rx: .10,  wheel: 0,   bolts: 1, held: 0 },
  { x: -.24, y: 0,   s: .70, ry: .50,  rx: -.06, wheel: 2.6, bolts: 1, held: 0 },
  { x: .24,  y: 0,   s: .70, ry: -.28, rx: .12,  wheel: 2.6, bolts: 1, held: 1 },
  { x: -.24, y: 0,   s: .72, ry: .18,  rx: 0,    wheel: 0,   bolts: 1, held: 0 },
];
const KM: DoorState[] = [
  { x: 0, y: -.22, s: .46, ry: -.40, rx: .12,  wheel: 0,   bolts: 1, held: 0 },
  { x: 0, y: -.24, s: .42, ry: .45,  rx: -.05, wheel: 2.6, bolts: 1, held: 0 },
  { x: 0, y: -.24, s: .42, ry: -.30, rx: .12,  wheel: 2.6, bolts: 1, held: 1 },
  { x: 0, y: -.24, s: .44, ry: .15,  rx: 0,    wheel: 0,   bolts: 1, held: 0 },
];
const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: DoorState, b: DoorState, t: number) => {
  const o = {} as DoorState; for (const k in a) (o as any)[k] = (a as any)[k] + ((b as any)[k] - (a as any)[k]) * t; return o;
};
const hasWebGL = () => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } };

const canvas = document.querySelector<HTMLCanvasElement>('#door');
const stage = document.querySelector<HTMLElement>('.door-stage');
const steps = [...document.querySelectorAll<HTMLElement>('.dz[data-k]')];
const saveData = !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;

/**
 * Start after the load event, once the main thread has had a quiet stretch,
 * then on an idle slice. The quiet stretch keeps the Three.js parse off the
 * first input. setTimeout covers browsers without requestIdleCallback.
 */
function afterIdle(run: () => void) {
  const arm = () => {
    setTimeout(() => {
      if ('requestIdleCallback' in window) requestIdleCallback(() => run(), { timeout: 2000 });
      else setTimeout(run, 200);
    }, 6000);
  };
  if (document.readyState === 'complete') arm();
  else addEventListener('load', arm, { once: true });
}

function mountDoor() {
  if (!canvas || !stage) return;
  import('./vault3d').then(({ mountVault }) => {
    const v = mountVault(canvas, { onReady: () => stage.classList.add('ready') });
    const keys = () => (innerWidth < 760 ? KM : K);
    const progress = () => {
      const mid = scrollY + innerHeight / 2;
      const c = steps.map(s => { const r = s.getBoundingClientRect(); return r.top + scrollY + r.height / 2; });
      if (mid <= c[0]) return 0;
      for (let i = 0; i < c.length - 1; i++) if (mid < c[i + 1]) return i + (mid - c[i]) / (c[i + 1] - c[i]);
      return c.length - 1;
    };
    const pose = (p: number) => { const k = keys(), i = Math.min(k.length - 2, Math.floor(p)); return lerp(k[i], k[i + 1], smooth(Math.min(1, Math.max(0, p - i)))); };
    let cur = progress(), intro = 0, raf = 0, visible = true;
    const frame = () => {
      raf = 0;
      const target = progress(); cur += (target - cur) * 0.12;
      if (intro < 1) intro = Math.min(1, intro + 1 / 70);
      const st = pose(cur), l = smooth(intro);
      st.bolts *= l; st.wheel += (1 - l) * -3;
      v.draw(st);
      if (visible && (Math.abs(target - cur) > 0.001 || intro < 1)) raf = requestAnimationFrame(frame);
    };
    const kick = () => { if (!raf && visible) raf = requestAnimationFrame(frame); };
    addEventListener('scroll', kick, { passive: true });
    addEventListener('resize', () => { v.resize(); kick(); });
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; kick(); }).observe(stage.parentElement!);
    kick();
  }).catch(() => stage.classList.add('failed'));
}

// The SVG door in the page is the first paint. Three.js starts only once the hero is on screen and the browser is idle.
if (!canvas || !stage) {
  /* no door on this page */
} else if (reduced || saveData || !hasWebGL()) {
  stage.classList.add('static');
} else {
  const hero = document.querySelector('.dz-hero');
  let seen = !hero;
  let idle = false;
  let started = false;
  const start = () => {
    if (started || !seen || !idle) return;
    started = true;
    mountDoor();
  };
  afterIdle(() => { idle = true; start(); });
  if (hero) {
    const watch = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      seen = true;
      start();
      watch.disconnect();
    });
    watch.observe(hero);
  }
}

// step 02 HUD countdown (decorative)
const clock = document.querySelector<HTMLElement>('[data-countdown]');
if (clock && !reduced) {
  let s = Number(clock.dataset.countdown); let id = 0;
  const fmt = (n: number) => [Math.floor(n / 3600), Math.floor((n % 3600) / 60), n % 60].map(x => String(x).padStart(2, '0')).join(':');
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !id) id = window.setInterval(() => { s = s > 0 ? s - 1 : 259200; clock.textContent = fmt(s); }, 50);
    if (!e.isIntersecting && id) { clearInterval(id); id = 0; }
  }).observe(clock);
}

initOrdeal(reduced);
