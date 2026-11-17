export function initCopy() {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
    const label = btn.textContent ?? 'Copy';
    btn.addEventListener('click', async () => {
      const src = document.querySelector(btn.dataset.copy!); const text = src?.textContent?.trim() ?? '';
      try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
      catch {
        if (src) { const r = document.createRange(); r.selectNodeContents(src); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); }
        btn.textContent = 'Selected, copy it';
      }
      setTimeout(() => (btn.textContent = label), 2200);
    });
  }
}
