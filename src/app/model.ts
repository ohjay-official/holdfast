// Holdfast vault rules, as plain state transitions.
// Demo mode runs these in the browser. The contract will enforce the same rules on chain,
// so every rule here is written to match docs: allowance, wait, cancel, fast lane,
// freeze, unfreeze, recover, guardian removal.

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const SATS = 100_000_000;

export type Role = 'phone' | 'home' | 'guardian' | 'panic';

export interface Pending {
  id: number;
  sats: number;
  to: string;
  createdAt: number;
  readyAt: number;
  fast: boolean;
  status: 'waiting' | 'released' | 'cancelled';
  closedAt?: number;
  closedBy?: Role;
}

export interface Activity {
  at: number;
  kind:
    | 'created' | 'deposit' | 'spend' | 'withdraw-start' | 'withdraw-release' | 'withdraw-cancel'
    | 'fast-approve' | 'freeze' | 'unfreeze' | 'recover' | 'guardian-remove-start'
    | 'guardian-removed' | 'home-check' | 'settings';
  by?: Role;
  sats?: number;
  note?: string;
}

export interface VaultState {
  version: 1;
  createdAt: number;
  balance: number;            // sats inside the vault, including amounts still waiting
  allowance: number;          // sats per day the phone can spend at once
  allowanceSpent: number;     // sats spent in the current allowance window
  lastAllowanceSpend: number; // ms, 0 if never
  waitDays: number;           // 1..7
  pending: Pending[];
  frozen: boolean;
  frozenBy?: Role;
  unfreezeBy: Role[];         // approvals collected so far
  guardian: string | null;    // display name
  guardianRemovalAt: number | null;
  homeCheckedAt: number;
  phoneId: number;            // bumps on recovery to a new phone
  activity: Activity[];
  nextId: number;
}

export class RuleError extends Error {}

export interface Setup {
  allowanceSats: number;
  waitDays: number;
  guardian: string | null;
  depositSats: number;
}

export function createVault(s: Setup, now: number): VaultState {
  if (!(s.allowanceSats > 0)) throw new RuleError('Set an allowance above zero.');
  if (!(s.waitDays >= 1 && s.waitDays <= 7)) throw new RuleError('The wait must be 1 to 7 days.');
  const v: VaultState = {
    version: 1,
    createdAt: now,
    balance: 0,
    allowance: s.allowanceSats,
    allowanceSpent: 0,
    lastAllowanceSpend: 0,
    waitDays: Math.round(s.waitDays),
    pending: [],
    frozen: false,
    unfreezeBy: [],
    guardian: s.guardian,
    guardianRemovalAt: null,
    homeCheckedAt: now,
    phoneId: 1,
    activity: [{ at: now, kind: 'created' }],
    nextId: 1,
  };
  if (s.depositSats > 0) deposit(v, s.depositSats, now);
  return v;
}

// ---------- reading ----------

/** Sats the phone can still spend right now. Refills after 24h with no allowance spend. */
export function allowanceLeft(v: VaultState, now: number): number {
  // A duress freeze leaves the allowance spendable, so the robber still gets something.
  if (v.frozen && v.frozenBy !== 'panic') return 0;
  const spent = v.lastAllowanceSpend && now - v.lastAllowanceSpend >= DAY ? 0 : v.allowanceSpent;
  return Math.max(0, Math.min(v.allowance - spent, available(v)));
}

/** When the allowance is next full again, or null if it already is. */
export function allowanceRefillsAt(v: VaultState, now: number): number | null {
  if (!v.lastAllowanceSpend || now - v.lastAllowanceSpend >= DAY || v.allowanceSpent === 0) return null;
  return v.lastAllowanceSpend + DAY;
}

/** Sats not tied up in a waiting withdrawal. */
export function available(v: VaultState): number {
  return v.balance - waitingSats(v);
}

export function waitingSats(v: VaultState): number {
  return v.pending.filter((p) => p.status === 'waiting').reduce((a, p) => a + p.sats, 0);
}

export function waiting(v: VaultState): Pending[] {
  return v.pending.filter((p) => p.status === 'waiting');
}

export function isReady(p: Pending, now: number): boolean {
  return p.status === 'waiting' && now >= p.readyAt;
}

export function homeCheckDue(v: VaultState, now: number): boolean {
  return now - v.homeCheckedAt >= 30 * DAY;
}

// ---------- actions ----------

function log(v: VaultState, a: Activity) {
  v.activity.unshift(a);
  if (v.activity.length > 200) v.activity.length = 200;
}

function needOpen(v: VaultState) {
  if (v.frozen) throw new RuleError('The vault is frozen. Unfreeze it with your home code and guardian first.');
}

function needAmount(sats: number) {
  if (!Number.isInteger(sats) || sats <= 0) throw new RuleError('Enter an amount above zero.');
}

export function deposit(v: VaultState, sats: number, now: number) {
  needAmount(sats);
  v.balance += sats;
  log(v, { at: now, kind: 'deposit', sats });
}

/** Phone: spend within the allowance. Leaves the vault at once. */
export function spend(v: VaultState, sats: number, to: string, now: number) {
  if (v.frozen && v.frozenBy !== 'panic') needOpen(v);
  needAmount(sats);
  const left = allowanceLeft(v, now);
  if (sats > left) throw new RuleError('That is more than the allowance left. The rest has to wait.');
  if (v.lastAllowanceSpend && now - v.lastAllowanceSpend >= DAY) v.allowanceSpent = 0;
  v.allowanceSpent += sats;
  v.lastAllowanceSpend = now;
  v.balance -= sats;
  log(v, { at: now, kind: 'spend', by: 'phone', sats, note: to });
}

/** Phone: start a withdrawal that waits the vault's wait time. */
export function startWithdrawal(v: VaultState, sats: number, to: string, now: number): Pending {
  needOpen(v);
  needAmount(sats);
  if (sats > available(v)) throw new RuleError('That is more than is free in the vault.');
  const p: Pending = {
    id: v.nextId++,
    sats,
    to,
    createdAt: now,
    readyAt: now + v.waitDays * DAY,
    fast: false,
    status: 'waiting',
  };
  v.pending.push(p);
  log(v, { at: now, kind: 'withdraw-start', by: 'phone', sats, note: to });
  return p;
}

/**
 * Phone: send any amount. Up to the allowance goes now; the rest becomes a waiting withdrawal.
 * This is what happens when a robber says "send everything".
 */
export function send(v: VaultState, sats: number, to: string, now: number): { now: number; waiting: Pending | null } {
  needAmount(sats);
  if (v.frozen && sats > allowanceLeft(v, now)) {
    if (v.frozenBy === 'panic') throw new RuleError('Not enough BCH available.');
    needOpen(v);
  }
  if (sats > available(v)) throw new RuleError('That is more than is free in the vault.');
  const instant = Math.min(sats, allowanceLeft(v, now));
  if (instant > 0) spend(v, instant, to, now);
  const rest = sats - instant;
  return { now: instant, waiting: rest > 0 ? startWithdrawal(v, rest, to, now) : null };
}

function findWaiting(v: VaultState, id: number): Pending {
  const p = v.pending.find((x) => x.id === id);
  if (!p || p.status !== 'waiting') throw new RuleError('That withdrawal is no longer waiting.');
  return p;
}

/** Anyone: once the wait is over, the withdrawal can be released. Blocked while frozen. */
export function release(v: VaultState, id: number, now: number) {
  needOpen(v);
  const p = findWaiting(v, id);
  if (now < p.readyAt) throw new RuleError('The wait is not over yet.');
  p.status = 'released';
  p.closedAt = now;
  v.balance -= p.sats;
  log(v, { at: now, kind: 'withdraw-release', sats: p.sats, note: p.to });
}

/** Phone, home code or guardian: cancel a waiting withdrawal. Works even while frozen. */
export function cancel(v: VaultState, id: number, by: Role, now: number) {
  if (by === 'panic') throw new RuleError('The panic key can only freeze.');
  const p = findWaiting(v, id);
  p.status = 'cancelled';
  p.closedAt = now;
  p.closedBy = by;
  log(v, { at: now, kind: 'withdraw-cancel', by, sats: p.sats });
}

/** Guardian (with the phone's request): shorten a waiting withdrawal to about an hour. */
export function approveFast(v: VaultState, id: number, now: number) {
  needOpen(v);
  if (!v.guardian) throw new RuleError('Fast withdrawals need a guardian.');
  const p = findWaiting(v, id);
  p.fast = true;
  p.readyAt = Math.min(p.readyAt, Math.max(now, p.createdAt + HOUR));
  log(v, { at: now, kind: 'fast-approve', by: 'guardian', sats: p.sats });
}

/** Home code, guardian or panic key: freeze. The phone alone can't. */
export function freeze(v: VaultState, by: Role, now: number) {
  if (by === 'phone') throw new RuleError('The phone alone can\'t freeze. Use your home code, guardian or duress PIN.');
  if (v.frozen && (v.frozenBy !== 'panic' || by === 'panic')) return;
  v.frozen = true;
  v.frozenBy = by;
  v.unfreezeBy = [];
  log(v, { at: now, kind: 'freeze', by });
}

/** Signers needed to unfreeze or recover. */
export function unfreezeNeeds(v: VaultState): Role[] {
  return v.guardian ? ['home', 'guardian'] : ['home'];
}

/** Home code and guardian each approve; the vault unfreezes when all needed have. */
export function approveUnfreeze(v: VaultState, by: Role, now: number): boolean {
  if (!v.frozen) throw new RuleError('The vault isn\'t frozen.');
  if (!unfreezeNeeds(v).includes(by)) throw new RuleError('Only your home code and guardian can unfreeze.');
  if (!v.unfreezeBy.includes(by)) v.unfreezeBy.push(by);
  if (unfreezeNeeds(v).every((r) => v.unfreezeBy.includes(r))) {
    v.frozen = false;
    v.frozenBy = undefined;
    v.unfreezeBy = [];
    log(v, { at: now, kind: 'unfreeze', by });
    return true;
  }
  return false;
}

/** Home code + guardian: move the vault to a new phone key. Cancels anything waiting. */
export function recover(v: VaultState, approvers: Role[], now: number) {
  const needs = unfreezeNeeds(v);
  if (!needs.every((r) => approvers.includes(r))) {
    throw new RuleError(v.guardian ? 'Recovery needs your home code and your guardian.' : 'Recovery needs your home code.');
  }
  for (const p of waiting(v)) cancel(v, p.id, 'home', now);
  v.phoneId += 1;
  v.frozen = false;
  v.frozenBy = undefined;
  v.unfreezeBy = [];
  v.allowanceSpent = 0;
  v.lastAllowanceSpend = 0;
  log(v, { at: now, kind: 'recover', by: 'home' });
}

/** Phone + home code: start removing the guardian. Takes 7 days. */
export function startGuardianRemoval(v: VaultState, now: number) {
  needOpen(v);
  if (!v.guardian) throw new RuleError('There is no guardian to remove.');
  if (v.guardianRemovalAt) throw new RuleError('Removal has already started.');
  v.guardianRemovalAt = now + 7 * DAY;
  log(v, { at: now, kind: 'guardian-remove-start', by: 'home' });
}

export function finishGuardianRemoval(v: VaultState, now: number) {
  needOpen(v);
  if (!v.guardianRemovalAt) throw new RuleError('No removal has started.');
  if (now < v.guardianRemovalAt) throw new RuleError('The 7 days aren\'t over yet.');
  v.guardian = null;
  v.guardianRemovalAt = null;
  log(v, { at: now, kind: 'guardian-removed', by: 'home' });
}

export function checkHomeCode(v: VaultState, now: number) {
  v.homeCheckedAt = now;
  log(v, { at: now, kind: 'home-check', by: 'home' });
}

// ---------- formatting ----------

export function toSats(bch: string): number {
  const t = bch.trim();
  if (!/^\d*(\.\d{0,8})?$/.test(t) || t === '' || t === '.') return NaN;
  const [w, f = ''] = t.split('.');
  return Number(w || '0') * SATS + Number((f + '00000000').slice(0, 8));
}

export function fmtBch(sats: number): string {
  const s = (sats / SATS).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  const [w, f = ''] = s.split('.');
  return f.length < 2 ? `${w}.${f.padEnd(2, '0')}` : s;
}

export function fmtDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const m = Math.ceil(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return mm ? `${h}h ${mm}m` : `${h}h`;
  return `${mm}m`;
}
