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
