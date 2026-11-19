import { describe, expect, it } from 'vitest';
import * as C from '../src/real/core.js';

describe('PIN storage', () => {
  it('two unlabelled slots: each PIN opens its role, anything else opens nothing', async () => {
    const slots = await C.makePinSlots('482913', '771205', 1000);
    expect(slots).toHaveLength(2);
    expect(JSON.stringify(slots)).not.toMatch(/pin|duress/);
    expect(await C.checkPinSlots('482913', slots, 1000)).toBe('pin');
    expect(await C.checkPinSlots('771205', slots, 1000)).toBe('duress');
    expect(await C.checkPinSlots('000000', slots, 1000)).toBeNull();
  });
  it('wrong PINs lock the pad for longer and longer', () => {
    expect(C.lockoutMs(4)).toBe(0);
    expect(C.lockoutMs(5)).toBe(30_000);
    expect(C.lockoutMs(6)).toBe(60_000);
    expect(C.lockoutMs(30)).toBe(3_600_000);
  });
});
