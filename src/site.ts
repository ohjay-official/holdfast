import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/source-serif-4/wght-italic.css';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/pages.css';
import { initReveal } from './lib/reveal';
import { initSplit } from './lib/split';
import { initCopy } from './lib/copy';
import { initNav } from './lib/nav';

document.documentElement.classList.add('js');
export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

initSplit(reduced);     // must run before reveal so .mask headings get split first
initReveal(reduced);
initCopy();
initNav();

document.querySelectorAll<HTMLElement>('[data-coin]').forEach(el => {
  const peers = () => document.querySelectorAll(`[data-coin="${el.dataset.coin}"]`);
  el.addEventListener('pointerenter', () => peers().forEach(p => p.classList.add('hl')));
  el.addEventListener('pointerleave', () => peers().forEach(p => p.classList.remove('hl')));
});
