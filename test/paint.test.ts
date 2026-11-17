import { describe, expect, it } from 'vitest';
import { paint, repaintNext } from '../src/real/paint.js';

/** A stand-in for #app: every innerHTML write builds new nodes, like a browser does. */
function fakeApp() {
  let html = '';
  let writes = 0;
  let nodes: object[] = [];
  return {
    get innerHTML() { return html; },
    set innerHTML(v: string) { html = v; writes++; nodes = v.split('<button').slice(1).map(() => ({})); },
    get writes() { return writes; },
    button(i: number) { return nodes[i]; },
  };
}

const lockScreen = (dots: number) => `<div class="dots">${'<i class="on"></i>'.repeat(dots)}</div><div class="pad"><button>1</button><button>2</button></div>`;

describe('screen redraws (duress PIN rejected on the phone)', () => {
  it('a background redraw of the same lock screen keeps the pressed button, so the tap still lands', () => {
    const app = fakeApp();
    paint(app, lockScreen(2));
    const pressed = app.button(1); // finger down on "2"
    paint(app, lockScreen(2)); // the vault read started by the normal PIN finishes and redraws
    expect(app.button(1)).toBe(pressed); // finger up: same node, so the click and the digit count
    expect(app.writes).toBe(1);
  });

  it('still redraws when the screen changes', () => {
    const app = fakeApp();
    expect(paint(app, lockScreen(2))).toBe(true);
    expect(paint(app, lockScreen(3))).toBe(true);
    expect(app.innerHTML).toBe(lockScreen(3));
  });

  it('redraws in full after something edited the screen directly (status box, Copied label)', () => {
    const app = fakeApp();
    paint(app, lockScreen(0));
    repaintNext(app);
    expect(paint(app, lockScreen(0))).toBe(true);
    expect(app.writes).toBe(2);
  });
});
