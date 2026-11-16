// FAQ: one question open at a time, search filter, category filter.
const items = [...document.querySelectorAll<HTMLLIElement>('.faq-item')];
const empty = document.querySelector<HTMLElement>('.faq-empty')!;
const input = document.querySelector<HTMLInputElement>('#faq-q')!;
const cats = [...document.querySelectorAll<HTMLButtonElement>('.faq-cat')];
let cat: string | null = null;

function setOpen(item: HTMLLIElement, open: boolean) {
  item.classList.toggle('open', open);
  item.querySelector('.faq-q')!.setAttribute('aria-expanded', String(open));
}

for (const item of items) {
  item.querySelector('.faq-q')!.addEventListener('click', () => {
    const open = !item.classList.contains('open');
    for (const other of items) if (other !== item) setOpen(other, false);
    setOpen(item, open);
  });
}

function apply() {
  const q = input.value.trim().toLowerCase();
  let shown = 0;
  for (const item of items) {
    const okCat = !cat || item.dataset.cat === cat;
    const okText = !q || item.textContent!.toLowerCase().includes(q);
    item.hidden = !(okCat && okText);
    if (!item.hidden) shown++;
  }
  empty.hidden = shown > 0;
}

input.addEventListener('input', apply);
for (const b of cats) {
  b.addEventListener('click', () => {
    cat = cat === b.dataset.cat ? null : b.dataset.cat!;
    for (const o of cats) o.setAttribute('aria-pressed', String(o.dataset.cat === cat));
    apply();
  });
}
