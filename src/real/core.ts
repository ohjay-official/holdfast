// Real vaults: configuration, keys, reading the chain into a view, and planning
// the wallet-funded creation. No UI and no network code, so it can be tested
// against the mock network.

import {
  binToHex,
  decodeBip39Mnemonic,
  decodeCashAddress,
  encodeBip39Mnemonic,
  cashAddressToLockingBytecode,
  encodeCashAddress,
  getDustThreshold,
  hash160,
  hexToBin,
  lockingBytecodeToCashAddress,
  secp256k1,
  sha256,
  utf8ToBin,
} from '@bitauth/libauth';
import { TransactionBuilder, type NetworkProvider, type SignatureTemplate, type SpendableUtxo, type Unlocker, type Utxo } from 'cashscript';
import * as V from '../vault.js';

export type Net = 'mainnet' | 'chipnet';

export const PREFIX: Record<Net, 'bitcoincash' | 'bchtest'> = { mainnet: 'bitcoincash', chipnet: 'bchtest' };

/** One-time fee for creating a vault, paid to the project in the creation transaction. */
export const CREATE_FEE = 10_000n;
/** Who receives the creation fee: the hash behind the project's BLAZE address. */
const FEE_HASH = 'zrnwss6g79malz4lqtwf84ha5y3utm3t9uyhqakcg6';

export function feeAddress(net: Net): string {
  const d = decodeCashAddress(`bitcoincash:${FEE_HASH}`);
  if (typeof d === 'string') throw new Error(d);
  return encodeCashAddress({ prefix: PREFIX[net], type: 'p2pkh', payload: d.payload }).address;
}

export function p2pkhAddress(pk: Uint8Array, net: Net): string {
  return encodeCashAddress({ prefix: PREFIX[net], type: 'p2pkh', payload: hash160(pk) }).address;
}

export function addressOfLock(lockHex: string, net: Net): string {
  const r = lockingBytecodeToCashAddress({ bytecode: hexToBin(lockHex), prefix: PREFIX[net] });
  return typeof r === 'string' ? `script ${lockHex.slice(0, 12)}…` : r.address;
}

export function isAddressFor(address: string, net: Net): boolean {
  const d = decodeCashAddress(address.trim());
  return typeof d !== 'string' && d.prefix === PREFIX[net];
}

// ---------------- vault configuration ----------------

export interface VaultConfig {
  v: 1;
  net: Net;
  ownerPk: string;
  homePk: string;
  guardianPk: string;
  panicPk: string;
  hasGuardian: boolean;
  category: string;
  allowance: string; // sats
  waitBlocks: number;
  fastBlocks: number;
  refillBlocks: number;
  evictBlocks: number;
}

export function paramsOf(c: VaultConfig): V.VaultParams {
  return {
    ownerPk: hexToBin(c.ownerPk),
    homePk: hexToBin(c.homePk),
    guardianPk: hexToBin(c.guardianPk),
    panicPk: hexToBin(c.panicPk),
    category: c.category,
    allowance: BigInt(c.allowance),
    waitBlocks: c.waitBlocks,
    fastBlocks: c.fastBlocks,
    refillBlocks: c.refillBlocks,
    evictBlocks: c.evictBlocks,
  };
}

/** A short code with everything needed to find and act on the vault from another device. */
export function encodeVaultCode(c: VaultConfig): string {
  const json = JSON.stringify(c);
  return 'HF1.' + btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeVaultCode(code: string): VaultConfig {
  const t = code.trim();
  if (!t.startsWith('HF1.')) throw new Error('That is not a Holdfast vault code. It starts with HF1.');
  let c: VaultConfig;
  try {
    const b = t.slice(4).replace(/-/g, '+').replace(/_/g, '/');
    c = JSON.parse(atob(b + '='.repeat((4 - (b.length % 4)) % 4)));
  } catch {
    throw new Error('That vault code is damaged. Copy it again in full.');
  }
  if (!validConfig(c)) throw new Error('That vault code is incomplete or was changed. Copy it again in full.');
  return c;
}

const PK = /^0[23][0-9a-f]{64}$/;
const isBlocks = (n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 0xffff;

/** Every field a vault code must carry, in the shape the app writes. */
function validConfig(c: VaultConfig): boolean {
  if (!c || typeof c !== 'object' || c.v !== 1) return false;
  if (c.net !== 'mainnet' && c.net !== 'chipnet') return false;
  if (![c.ownerPk, c.homePk, c.guardianPk, c.panicPk].every((k) => typeof k === 'string' && PK.test(k))) return false;
  if (typeof c.category !== 'string' || !/^[0-9a-f]{64}$/.test(c.category)) return false;
  if (typeof c.allowance !== 'string' || !/^[1-9][0-9]*$/.test(c.allowance)) return false;
  if (![c.waitBlocks, c.fastBlocks, c.refillBlocks, c.evictBlocks].every(isBlocks)) return false;
  if (typeof c.hasGuardian !== 'boolean') return false;
  // A vault without a guardian uses the home key in the guardian's place.
  if (!c.hasGuardian && c.guardianPk !== c.homePk) return false;
  return true;
}

// ---------------- keys ----------------

export function randomPrivateKey(): Uint8Array {
  let k: Uint8Array;
  do k = crypto.getRandomValues(new Uint8Array(32));
  while (!secp256k1.validatePrivateKey(k));
  return k;
}

export function publicKeyOf(priv: Uint8Array): Uint8Array {
  const pk = secp256k1.derivePublicKeyCompressed(priv);
  if (typeof pk === 'string') throw new Error(pk);
  return pk;
}

/** 12 standard BIP39 words. */
export function newHomeWords(): string[] {
  const r = encodeBip39Mnemonic(crypto.getRandomValues(new Uint8Array(16)));
  if (typeof r === 'string') throw new Error(r);
  return r.phrase.split(' ');
}

export function normaliseWords(text: string): string {
  return text.trim().toLowerCase().split(/[\s,]+/).filter(Boolean).join(' ');
}

/** The home key behind the words. Throws a readable error for a typo. */
export function homeKeyFromWords(text: string): Uint8Array {
  const phrase = normaliseWords(text);
  if (phrase.split(' ').length !== 12) throw new Error('Enter all 12 words of your home code.');
  const entropy = decodeBip39Mnemonic(phrase);
  if (typeof entropy === 'string') throw new Error('Those words aren\'t a valid home code. Check each word against your paper.');
  let key = sha256.hash(utf8ToBin('holdfast-home-v1:' + binToHex(entropy)));
  while (!secp256k1.validatePrivateKey(key)) key = sha256.hash(key);
  return key;
}

export async function pinHash(pin: string, salt: string): Promise<string> {
  return binToHex(sha256.hash(utf8ToBin(`holdfast-pin:${salt}:${pin}`)));
}

// ---------------- reading a vault ----------------

export interface PendingView {
  utxo: Utxo;
  sats: bigint;
  to: string;
  fast: boolean;
  height: number; // 0 = unconfirmed
  readyAt: number | null; // block height the wait ends, null while unconfirmed
  blocksLeft: number | null;
  ready: boolean;
}

export interface VaultView {
  main: Utxo | null;
  state: V.MainState | null;
  mainHeight: number;
  /** Everything the vault holds: vault coin, waiting withdrawals, deposits. */
  total: bigint;
  waitingSats: bigint;
  depositSats: bigint;
  allowanceLeft: bigint;
  /** True when the next allowance spend starts a new window (spendFresh). */
  fresh: boolean;
  /** Blocks until the allowance refills, when it isn't full. */
  refillIn: number | null;
  pending: PendingView[];
  /** Withdrawals this page just released, still listed by a lagging server. Not counted anywhere. */
  settling: Settling[];
  deposits: Utxo[];
  tickets: Utxo[];
  tip: number;
}

export function readVault(c: VaultConfig, utxos: Utxo[], heights: Map<string, number>, tip: number, settling: SettlingRaw[] = []): VaultView {
  const coins = V.classify(utxos, c.category);
  const h = (u: Utxo) => heights.get(`${u.txid}:${u.vout}`) ?? 0;
  const age = (u: Utxo) => (h(u) > 0 ? tip - h(u) + 1 : 0);
  const mainCoin = coins.find((x) => x.kind === 'main') as Extract<V.VaultCoin, { kind: 'main' }> | undefined;
  const pending: PendingView[] = coins
    .filter((x): x is Extract<V.VaultCoin, { kind: 'pending' }> => x.kind === 'pending')
    .map((p) => {
      const need = p.fast ? c.fastBlocks : c.waitBlocks;
      const ht = h(p.utxo);
      const readyAt = ht > 0 ? ht + need - 1 : null;
      const left = readyAt === null ? null : Math.max(0, readyAt - tip);
      return { utxo: p.utxo, sats: p.utxo.satoshis, to: addressOfLock(p.recipientLock, c.net), fast: p.fast, height: ht, readyAt, blocksLeft: left, ready: age(p.utxo) >= need };
    })
    .sort((a, b) => (a.readyAt ?? 1e9) - (b.readyAt ?? 1e9));
  const deposits = coins.filter((x) => x.kind === 'deposit').map((x) => x.utxo);
  const tickets = coins.filter((x) => x.kind === 'ticket').map((x) => x.utxo);
  const allowance = BigInt(c.allowance);
  let allowanceLeft = 0n;
  let fresh = false;
  let refillIn: number | null = null;
  const state = mainCoin?.state ?? null;
  if (mainCoin && state && state.level < 2) {
    const mainAge = age(mainCoin.utxo);
    if (state.spent > 0n && mainAge >= c.refillBlocks) {
      fresh = true;
      allowanceLeft = allowance;
    } else {
      allowanceLeft = allowance > state.spent ? allowance - state.spent : 0n;
      if (state.spent > 0n) refillIn = c.refillBlocks - mainAge;
    }
    const spendable = mainCoin.utxo.satoshis - V.VAULT_FEE - MAIN_MIN;
    if (allowanceLeft > spendable) allowanceLeft = spendable > 0n ? spendable : 0n;
  }
  const waitingSats = pending.reduce((a, p) => a + p.sats, 0n);
  const depositSats = deposits.reduce((a, u) => a + u.satoshis, 0n);
  return {
    main: mainCoin?.utxo ?? null,
    state,
    mainHeight: mainCoin ? h(mainCoin.utxo) : 0,
    total: (mainCoin?.utxo.satoshis ?? 0n) + waitingSats + depositSats,
    waitingSats,
    depositSats,
    allowanceLeft,
    fresh,
    refillIn,
    pending,
    settling: settling.map((x) => ({ what: x.what, sats: x.sats, to: addressOfLock(x.toLock, c.net), txid: x.txid })),
    deposits,
    tickets,
    tip,
  };
}

// ---------------- what this page just broadcast ----------------
//
// A server can keep listing a coin for a while after our transaction spent it,
// and can be slow to list the coins it created. Without this, the screen right
// after a release still showed the withdrawal as "Ready to release", and the
// home code screen right after a freeze still showed the vault open.

/** How long a broadcast hides the coins it spent if the network never confirms it. */
export const OVERLAY_MS = 30 * 60_000;

export type BroadcastKind = 'release' | 'cancel' | 'freeze' | 'approve' | 'send' | 'withdraw' | 'merge' | 'recover' | 'create' | 'other';

export interface SettlingRaw { what: 'release'; sats: bigint; toLock: string; txid: string }
export interface Settling { what: 'release'; sats: bigint; to: string; txid: string }

export interface Overlay {
  spent: Map<string, { until: number; settle?: SettlingRaw }>;
  added: Map<string, { until: number; lock: string; utxo: Utxo }>;
}

export const newOverlay = (): Overlay => ({ spent: new Map(), added: new Map() });

const op = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;

/** Remember the coins a successful broadcast spent and the coins it made. */
export function noteBroadcast(ov: Overlay, tb: TransactionBuilder, txid: string, what: BroadcastKind, now = Date.now()): void {
  const until = now + OVERLAY_MS;
  for (const i of tb.inputs) {
    const commitment = i.token?.nft?.commitment ?? '';
    const isPending = i.token?.nft?.capability === 'mutable' && commitment.startsWith('50');
    const settle = what === 'release' && isPending ? { what: 'release' as const, sats: i.satoshis, toLock: commitment.slice(4), txid } : undefined;
    ov.spent.set(op(i), { until, settle });
  }
  tb.outputs.forEach((o, vout) => {
    if (typeof o.to !== 'string') return;
    const lock = cashAddressToLockingBytecode(o.to);
    if (typeof lock === 'string') return;
    ov.added.set(`${txid}:${vout}`, { until, lock: binToHex(lock.bytecode), utxo: { txid, vout, satoshis: o.amount, lockingBytecode: binToHex(lock.bytecode), ...(o.token ? { token: o.token } : {}) } as Utxo });
  });
}

/**
 * The coins to show for the address with locking bytecode `lockHex`: what the
 * network listed, minus coins we spent, plus coins we made that it doesn't list yet.
 * `added` holds the outpoints that are ours and unconfirmed.
 */
export function applyOverlay(ov: Overlay, utxos: Utxo[], lockHex: string, now = Date.now()): { utxos: Utxo[]; added: Set<string>; settling: SettlingRaw[] } {
  for (const [k, e] of ov.spent) if (e.until < now) ov.spent.delete(k);
  for (const [k, e] of ov.added) if (e.until < now) ov.added.delete(k);
  const listed = new Set(utxos.map(op));
  for (const [k, e] of ov.added) if (e.lock === lockHex && listed.has(k)) ov.added.delete(k);
  const settling: SettlingRaw[] = [];
  const out = utxos.filter((u) => {
    const s = ov.spent.get(op(u));
    if (!s) return true;
    if (s.settle) settling.push(s.settle);
    return false;
  });
  const added = new Set<string>();
  for (const [k, e] of ov.added) {
    if (e.lock !== lockHex || ov.spent.has(k)) continue;
    out.push(e.utxo);
    added.add(k);
  }
  return { utxos: out, added, settling };
}

/** The vault's locking bytecode, from its configuration alone. */
export function lockOf(c: VaultConfig): string {
  const offline = { network: c.net } as unknown as NetworkProvider;
  const r = cashAddressToLockingBytecode(V.makeVault(paramsOf(c), offline).address);
  if (typeof r === 'string') throw new Error(r);
  return binToHex(r.bytecode);
}

// ---------------- frozen state, in words ----------------

export function frozenText(s: V.MainState, hasGuardian: boolean): { title: string; body: string; next: string } | null {
  if (s.level === 0) return null;
  const body = s.level === 1 ? 'Frozen by the duress PIN. Only the daily allowance can leave.' : 'Nothing can leave until it\'s unfrozen.';
  if (!hasGuardian) return { title: 'Vault frozen', body, next: 'Unfreeze with your home code on the Home code screen.' };
  const given = s.unfreezeHome && s.unfreezeGuardian
    ? 'Both have approved.'
    : s.unfreezeHome
      ? 'Your home code has approved; waiting for your guardian.'
      : s.unfreezeGuardian
        ? 'Your guardian has approved; waiting for your home code.'
        : 'Neither has approved yet.';
  return { title: 'Vault frozen', body, next: `To unfreeze, your home code and your guardian each approve. ${given}` };
}

export interface HomeAction { act: 'approve-unfreeze' | 'freeze' | 'approve-recover'; label: string; primary: boolean }

/** The buttons on the home code screen, most important first. Unfreeze and recovery are worded apart on purpose. */
export function homeActions(s: V.MainState, hasGuardian: boolean): HomeAction[] {
  const out: HomeAction[] = [];
  if (s.level > 0 && !s.unfreezeHome) {
    out.push({ act: 'approve-unfreeze', label: hasGuardian ? 'Approve unfreezing (your guardian approves too)' : 'Unfreeze the vault', primary: true });
  }
  if (s.level < 2) out.push({ act: 'freeze', label: s.level === 1 ? 'Freeze fully, allowance too' : 'Freeze vault', primary: s.level === 0 });
  if (!s.recoverHome) out.push({ act: 'approve-recover', label: 'Allow moving everything out (only if you lost your phone)', primary: false });
  return out;
}

// ---------------- limits the app checks before building ----------------

/**
 * Sats the vault coin always keeps. A CashTokens output below its dust limit
 * (720 sats for the vault coin) can't be built or relayed, so "send all" or
 * "withdraw all" must leave at least this much behind.
 */
export const MAIN_MIN = 1_000n;

/** The smallest payment the network relays to `address` (its dust limit). */
export function minPayment(address: string): bigint {
  return BigInt(getDustThreshold({ lockingBytecode: V.lockingBytecodeOf(address), valueSatoshis: 0n }));
}

/**
 * The smallest withdrawal that can ever be released: the release pays the
 * 2,000-sat fee out of it and the rest must still be a relayable payment.
 * The contract itself accepts down to 1,000 sats, but those could only be cancelled.
 */
export function minWithdrawal(to: string, _net?: Net): bigint {
  return V.VAULT_FEE + minPayment(to);
}

/** The most a single withdrawal can take while the vault coin stays usable. */
export function maxWithdrawal(v: VaultView): bigint {
  if (!v.main) return 0n;
  const m = v.main.satoshis - V.VAULT_FEE - MAIN_MIN;
  return m > 0n ? m : 0n;
}

/** Deposits worth adding: merging one smaller than the merge fee would shrink the vault. */
export function mergeableDeposits(v: VaultView): Utxo[] {
  return v.deposits.filter((u) => u.satoshis > V.MERGE_FEE);
}

/** With no guardian, the home key stands in for the guardian too, so one approval does both halves. */
export function approveRoles(c: Pick<VaultConfig, 'hasGuardian'>, who: 'home' | 'guardian'): { asHome: boolean; asGuardian: boolean } {
  return who === 'home' ? { asHome: true, asGuardian: !c.hasGuardian } : { asHome: false, asGuardian: true };
}

/** What the duress view shows as the balance: only what the allowance lets out now. */
export function duressBalance(v: VaultView): bigint {
  return v.allowanceLeft;
}

// ---------------- freeze and cancel everything ----------------

export interface LockStep {
  what: 'freeze' | 'cancel';
  txid: string;
  sats: bigint;
}

const outpoint = (u: Utxo | null) => (u ? `${u.txid}:${u.vout}` : '');

/**
 * Freeze (home code or duress) and pull every waiting withdrawal back, one
 * transaction at a time, with a key this page holds. After each step it waits
 * until the network shows the new vault coin, so it never builds on a coin that
 * is already spent. `mode: 'cancel'` only cancels (used before moving the vault).
 */
export async function lockDown(o: {
  read: () => Promise<VaultView>;
  send: (tb: TransactionBuilder) => Promise<string>;
  contract: V.HoldfastContract;
  key: SignatureTemplate;
  mode: 'home' | 'duress' | 'cancel';
  wait?: (ms: number) => Promise<void>;
  onStep?: (s: LockStep) => void;
  tries?: number;
}): Promise<LockStep[]> {
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tries = o.tries ?? 10;
  const steps: LockStep[] = [];
  const pk = o.key.publicKey;
  let v = await o.read();
  for (let n = 0; n < 30 && v.main && v.state; n++) {
    const level = v.state.level;
    const wantFreeze = o.mode === 'duress' ? level === 0 : o.mode === 'home' ? level < 2 : false;
    const canFreeze = v.main.satoshis - V.VAULT_FEE >= MAIN_MIN;
    let tb: TransactionBuilder;
    let step: Omit<LockStep, 'txid'>;
    if (wantFreeze && (canFreeze || !v.pending.length)) {
      if (!canFreeze) throw new Error('The vault holds too little to pay the network fee for a freeze.');
      tb = V.buildFreeze({ contract: o.contract, main: v.main, state: v.state, pk, signer: o.key, duress: o.mode === 'duress' });
      step = { what: 'freeze', sats: 0n };
    } else if (v.pending.length) {
      // Cancelling first also tops up a vault coin too small to pay for the freeze.
      const p = v.pending[0];
      tb = V.buildMerge({ contract: o.contract, main: v.main, state: v.state, other: p.utxo, pk, signer: o.key });
      step = { what: 'cancel', sats: p.sats };
    } else break;
    const before = outpoint(v.main);
    const txid = await o.send(tb);
    const done = { ...step, txid };
    steps.push(done);
    o.onStep?.(done);
    v = await waitForNewMain(o.read, before, wait, tries);
  }
  return steps;
}

/**
 * Every vault action spends the vault coin, so the next one must be built on
 * the new coin. Read until the network shows it.
 */
export async function waitForNewMain(
  read: () => Promise<VaultView>,
  before: Utxo | string | null,
  wait: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  tries = 10,
): Promise<VaultView> {
  const old = typeof before === 'string' ? before : outpoint(before);
  for (let t = 0; t < tries; t++) {
    await wait(1200);
    const r = await read();
    if (outpoint(r.main) !== old) return r;
  }
  throw new Error('The network hasn\'t shown the last step yet. Refresh in a minute and tap again.');
}

/** The same waiting withdrawal in a fresher read, or an error if it already left or was cancelled. */
export function samePending(v: VaultView, p: { utxo: Utxo }): PendingView {
  const q = v.pending.find((x) => x.utxo.txid === p.utxo.txid && x.utxo.vout === p.utxo.vout);
  if (!q) throw new Error('That withdrawal already left or was cancelled. Refresh.');
  return q;
}

/**
 * Before starting a new creation, deal with the record a previous try left
 * behind. If that vault reached the chain it must be adopted: its panic key
 * exists nowhere else. Throws if the chain can't be read, so nothing is overwritten blind.
 */
export async function resolveEarlierCreation(earlier: VaultConfig, read: (c: VaultConfig) => Promise<VaultView>): Promise<'adopt' | 'replace'> {
  let v: VaultView;
  try {
    v = await read(earlier);
  } catch {
    throw new Error('Couldn\'t check your earlier try at creating a vault. Check your connection and tap Create vault again.');
  }
  return v.main ? 'adopt' : 'replace';
}

// ---------------- creating a vault ----------------

export interface WalletCoin extends SpendableUtxo {
  path: [string, number]; // e.g. ['receive', 3]
}

/** What creation needs from the wallet: a coin at output 0 to mint from, and enough value. */
export function planCreate(coins: WalletCoin[], amount: bigint): { needsPrepare: boolean; enough: boolean; total: bigint } {
  const plain = coins.filter((u) => !u.token);
  const total = plain.reduce((a, u) => a + u.satoshis, 0n);
  const genesis = plain.find((u) => u.vout === 0);
  // The creation sends amount + fee and pays a miner fee of a few hundred sats per input.
  const need = amount + CREATE_FEE + 2_000n + BigInt(plain.length) * 200n;
  return { needsPrepare: !genesis, enough: total >= need, total };
}

/** Self-send that merges the wallet's coins into one output at index 0. */
export function buildPrepare(o: {
  provider: NetworkProvider;
  coins: WalletCoin[];
  changeAddress: string;
  unlocker: (c: WalletCoin) => Unlocker;
}): TransactionBuilder {
  const tb = new TransactionBuilder({ provider: o.provider });
  for (const c of o.coins.filter((u) => !u.token)) tb.addInput(c, o.unlocker(c));
  return tb.addBchChangeOutputIfNeeded({ to: o.changeAddress, feeRate: V.FEE_RATE });
}

/** Mint the vault coin with the first deposit, and pay the creation fee. */
export function buildCreateWithFee(o: {
  provider: NetworkProvider;
  contract: V.HoldfastContract;
  coins: WalletCoin[];
  amount: bigint;
  net: Net;
  changeAddress: string;
  unlocker: (c: WalletCoin) => Unlocker;
}): { builder: TransactionBuilder; inputs: WalletCoin[] } {
  const plain = o.coins.filter((u) => !u.token);
  const genesis = plain.find((u) => u.vout === 0);
  if (!genesis) throw new Error('Need a coin at output 0 first');
  const inputs = [genesis, ...plain.filter((u) => u !== genesis)];
  const tb = new TransactionBuilder({ provider: o.provider });
  for (const c of inputs) tb.addInput(c, o.unlocker(c));
  tb.addOutput({
    to: o.contract.tokenAddress,
    amount: o.amount,
    token: { category: genesis.txid, amount: 0n, nft: { capability: 'minting', commitment: V.encodeMain(V.OPEN) } },
  });
  tb.addOutput({ to: feeAddress(o.net), amount: CREATE_FEE });
  tb.addBchChangeOutputIfNeeded({ to: o.changeAddress, feeRate: V.FEE_RATE });
  return { builder: tb, inputs };
}

export const blocksToText = (blocks: number): string => {
  if (blocks <= 0) return 'now';
  const mins = blocks * 10;
  if (mins < 90) return `about ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `about ${hours} h`;
  const days = Math.round((hours / 24) * 10) / 10;
  return `about ${days} days`;
};
