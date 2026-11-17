export function initSplit(reduced: boolean) {
  if (reduced) return;
  document.querySelectorAll<HTMLElement>('.mask').forEach(el => {
    const label = el.textContent!.replace(/\s+/g, ' ').trim();
    let wi = 0;
    const wrapText = (node: Node) => {
      [...node.childNodes].forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) {
          const frag = document.createDocumentFragment();
          child.textContent!.split(/(\s+)/).forEach(part => {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.append(' '); return; }
            const w = document.createElement('span'); w.className = 'w';
            const inner = document.createElement('span'); inner.textContent = part;
            inner.style.setProperty('--wi', String(wi++)); w.append(inner); frag.append(w);
          });
          child.replaceWith(frag);
        } else if (child.nodeType === Node.ELEMENT_NODE) wrapText(child);
      });
    };
    wrapText(el);
    el.setAttribute('aria-label', label);
    [...el.children].forEach(c => c.setAttribute('aria-hidden', 'true'));
  });
}
