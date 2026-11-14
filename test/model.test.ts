import { describe, it, expect, beforeEach } from 'vitest';
import * as M from '../src/app/model';

const T0 = 1_800_000_000_000;
const B = (n: number) => Math.round(n * M.SATS);
let v: M.VaultState;

beforeEach(() => {
  v = M.createVault({ allowanceSats: B(0.05), waitDays: 3, guardian: 'Ada', depositSats: B(1) }, T0);
});

describe('allowance', () => {
  it('spends up to the allowance at once', () => {
    M.spend(v, B(0.05), 'x', T0);
    expect(v.balance).toBe(B(0.95));
    expect(M.allowanceLeft(v, T0)).toBe(0);
  });
  it('refuses more than the allowance', () => {
    expect(() => M.spend(v, B(0.06), 'x', T0)).toThrow(M.RuleError);
  });
  it('refills after 24h with no spending, not before', () => {
    M.spend(v, B(0.03), 'x', T0);
    expect(M.allowanceLeft(v, T0 + M.DAY - 1)).toBe(B(0.02));
    expect(M.allowanceLeft(v, T0 + M.DAY)).toBe(B(0.05));
  });
  it('a spend inside the window pushes the refill back', () => {
    M.spend(v, B(0.01), 'x', T0);
    M.spend(v, B(0.01), 'x', T0 + 20 * M.HOUR);
    expect(M.allowanceLeft(v, T0 + 30 * M.HOUR)).toBe(B(0.03));
    expect(M.allowanceLeft(v, T0 + 44 * M.HOUR)).toBe(B(0.05));
  });
});

describe('robbery: send everything', () => {
  it('gives the allowance now and holds the rest for the wait', () => {
    const r = M.send(v, B(1), 'robber', T0);
    expect(r.now).toBe(B(0.05));
    expect(r.waiting!.sats).toBe(B(0.95));
    expect(r.waiting!.readyAt).toBe(T0 + 3 * M.DAY);
    expect(() => M.release(v, r.waiting!.id, T0 + 3 * M.DAY - 1)).toThrow(/wait/);
  });
  it('home code cancels, then the money is free again', () => {
    const r = M.send(v, B(1), 'robber', T0);
    M.cancel(v, r.waiting!.id, 'home', T0 + M.HOUR);
    M.freeze(v, 'home', T0 + M.HOUR);
    expect(v.balance).toBe(B(0.95));
    expect(M.available(v)).toBe(B(0.95));
    expect(M.allowanceLeft(v, T0 + 2 * M.DAY)).toBe(0); // frozen
  });
  it('release works after the wait if nobody cancels', () => {
    const r = M.send(v, B(1), 'robber', T0);
    M.release(v, r.waiting!.id, T0 + 3 * M.DAY);
    expect(v.balance).toBe(0);
  });
  it('cannot release while frozen, even after the wait', () => {
    const r = M.send(v, B(1), 'robber', T0);
    M.freeze(v, 'guardian', T0);
    expect(() => M.release(v, r.waiting!.id, T0 + 4 * M.DAY)).toThrow(/frozen/);
  });
  it('waiting money cannot be withdrawn twice', () => {
    M.startWithdrawal(v, B(0.9), 'a', T0);
    expect(() => M.startWithdrawal(v, B(0.2), 'b', T0)).toThrow(/free/);
  });
});

describe('roles', () => {
  it('phone cannot freeze; panic can freeze but not cancel', () => {
    expect(() => M.freeze(v, 'phone', T0)).toThrow();
    const p = M.startWithdrawal(v, B(0.5), 'a', T0);
    expect(() => M.cancel(v, p.id, 'panic', T0)).toThrow();
    M.freeze(v, 'panic', T0);
    expect(v.frozen).toBe(true);
  });
  it('guardian fast lane makes it about an hour', () => {
    const p = M.startWithdrawal(v, B(0.5), 'a', T0);
    M.approveFast(v, p.id, T0 + 10 * 60_000);
    expect(p.readyAt).toBe(T0 + M.HOUR);
    M.release(v, p.id, T0 + M.HOUR);
    expect(v.balance).toBe(B(0.5));
  });
  it('unfreeze needs home and guardian', () => {
    M.freeze(v, 'panic', T0);
    expect(M.approveUnfreeze(v, 'home', T0)).toBe(false);
    expect(v.frozen).toBe(true);
    expect(() => M.approveUnfreeze(v, 'phone', T0)).toThrow();
    expect(M.approveUnfreeze(v, 'guardian', T0)).toBe(true);
    expect(v.frozen).toBe(false);
  });
  it('without a guardian the home code unfreezes alone', () => {
    const w = M.createVault({ allowanceSats: 1000, waitDays: 1, guardian: null, depositSats: 5000 }, T0);
    M.freeze(w, 'home', T0);
    expect(M.approveUnfreeze(w, 'home', T0)).toBe(true);
  });
  it('recover cancels waiting withdrawals and moves to a new phone', () => {
    M.send(v, B(1), 'robber', T0);
    expect(() => M.recover(v, ['home'], T0)).toThrow();
    M.recover(v, ['home', 'guardian'], T0);
    expect(M.waiting(v)).toHaveLength(0);
    expect(v.phoneId).toBe(2);
    expect(v.balance).toBe(B(0.95));
  });
  it('guardian removal takes 7 days', () => {
    M.startGuardianRemoval(v, T0);
    expect(() => M.finishGuardianRemoval(v, T0 + 6 * M.DAY)).toThrow();
    M.finishGuardianRemoval(v, T0 + 7 * M.DAY);
    expect(v.guardian).toBeNull();
  });
});

describe('duress', () => {
  it('panic freeze still lets the allowance go, but nothing more', () => {
    M.freeze(v, 'panic', T0);
    expect(M.allowanceLeft(v, T0)).toBe(B(0.05));
    expect(() => M.send(v, B(1), 'robber', T0)).toThrow(/Not enough/);
    const r = M.send(v, B(0.05), 'robber', T0);
    expect(r.now).toBe(B(0.05));
    expect(() => M.startWithdrawal(v, B(0.1), 'robber', T0)).toThrow(/frozen/);
  });
  it('home or guardian freeze upgrades a duress freeze to a full one', () => {
    M.freeze(v, 'panic', T0);
    M.freeze(v, 'guardian', T0);
    expect(v.frozenBy).toBe('guardian');
    expect(M.allowanceLeft(v, T0)).toBe(0);
  });
});

describe('format', () => {
  it('parses and prints BCH', () => {
    expect(M.toSats('0.05')).toBe(5_000_000);
    expect(M.toSats('1')).toBe(M.SATS);
    expect(Number.isNaN(M.toSats('1.123456789'))).toBe(true);
    expect(Number.isNaN(M.toSats('abc'))).toBe(true);
    expect(M.fmtBch(B(0.95))).toBe('0.95');
    expect(M.fmtBch(B(1))).toBe('1.00');
    expect(M.fmtBch(12345)).toBe('0.00012345');
  });
  it('prints durations', () => {
    expect(M.fmtDuration(3 * M.DAY)).toBe('3d');
    expect(M.fmtDuration(M.DAY + 5 * M.HOUR)).toBe('1d 5h');
    expect(M.fmtDuration(90_000)).toBe('2m');
  });
});
