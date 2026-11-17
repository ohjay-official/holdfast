import { reduced } from '../site';
import { mountDots } from './dotfield';

const items = [...document.querySelectorAll<HTMLElement>('.faq-item')];
const empty = document.querySelector<HTMLElement>('.faq-empty')!;
const q = document.querySelector<HTMLInputElement>('#faq-q')!;
const cats = [...document.querySelectorAll<HTMLButtonElement>('.faq-cat')];
let cat: string | null = null;

const setOpen = (it: HTMLElement, open: boolean) => {
  it.classList.toggle('open', open);
  it.querySelector('.faq-q')!.setAttribute('aria-expanded', String(open));
};
for (const it of items) it.querySelector('.faq-q')!.addEventListener('click', () => {
  const open = !it.classList.contains('open');
  for (const other of items) if (other !== it) setOpen(other, false);
  setOpen(it, open);
});
function filter() {
  const term = q.value.trim().toLowerCase(); let shown = 0;
  for (const it of items) {
    const okCat = !cat || it.dataset.cat === cat;
    const okTerm = !term || it.textContent!.toLowerCase().includes(term);
    it.hidden = !(okCat && okTerm); if (!it.hidden) shown++;
  }
  empty.hidden = shown > 0;
}
q.addEventListener('input', filter);
for (const b of cats) b.addEventListener('click', () => {
  cat = cat === b.dataset.cat ? null : b.dataset.cat!;
  for (const x of cats) x.setAttribute('aria-pressed', String(x.dataset.cat === cat));
  filter();
});

const canvas = document.querySelector<HTMLCanvasElement>('#dots');
if (canvas) mountDots(canvas, reduced);
