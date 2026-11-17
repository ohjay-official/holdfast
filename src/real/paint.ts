/**
 * Writes a screen's HTML only when it changed since the last write.
 *
 * The app redraws on every network answer. Rebuilding an identical screen swaps
 * every button under the finger, so a tap that is pressed when a background
 * redraw lands never becomes a click: on the PIN pad that silently drops a digit
 * and the right PIN is rejected. It also wiped anything typed into a form.
 */
export interface Paintable {
  innerHTML: string;
}

const last = new WeakMap<Paintable, string>();

/** Put html into el unless it is what this function last put there. Returns true if it wrote. */
export function paint(el: Paintable, html: string): boolean {
  if (last.get(el) === html) return false;
  el.innerHTML = html;
  last.set(el, html);
  return true;
}

/** Something changed el's content directly: make the next paint write in full. */
export function repaintNext(el: Paintable) {
  last.delete(el);
}
