// Copy buttons: <button data-copy="#id">. Says what happened, then resets.
for (const btn of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
  const label = btn.textContent ?? 'Copy';
  btn.addEventListener('click', async () => {
    const target = document.querySelector(btn.dataset.copy!);
    const text = target?.textContent?.trim() ?? '';
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      // Clipboard blocked: select the text so a long-press copy works.
      if (target) {
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      btn.textContent = 'Selected, copy it';
    }
    setTimeout(() => (btn.textContent = label), 2200);
  });
}

// Guardians hero: one verb at a time, the panel takes that verb's colour.
const vela = document.querySelector<HTMLElement>('.vela');
if (vela) {
  const words = [...vela.querySelectorAll<HTMLElement>('.vela-word')];
  const what = vela.querySelector<HTMLElement>('.vela-what')!;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let i = 0;
  const show = (n: number) => {
    words.forEach((w, k) => (w.hidden = k !== n));
    vela.dataset.tone = words[n].dataset.tone!;
    what.textContent = words[n].dataset.what!;
  };
  if (!still) setInterval(() => { i = (i + 1) % words.length; show(i); }, 2600);
}
