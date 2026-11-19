// Holdfast vault: transaction builders and coin helpers.
// Pure functions over a NetworkProvider, so the same code runs against the mock
// network in tests and against chipnet in the browser.

import {
  Contract,
  SignatureTemplate,
  TransactionBuilder,
  placeholderSignature,
  type NetworkProvider,
  type SpendableUtxo,
  type Unlocker,
  type Utxo,
} from 'cashscript';
import { binToHex, cashAddressToLockingBytecode, hexToBin } from '@bitauth/libauth';
import artifact from './Holdfast.artifact.js';
import artifactV1 from './HoldfastV1.artifact.js';

/** Fee for a one-coin vault spend. The contract allows at most 2,500. */
export const VAULT_FEE = 2_000n;
/** Fee for a two-coin vault spend (merge, evict). The contract allows at most 4,000 for a merge. */
export const MERGE_FEE = 3_600n;
/** Sats kept on an evict ticket. */
// Version 2: the ticket carries its own merge fee, so destroying it never costs the vault.
export const TICKET_SATS = 5_000n;
/** Fee rate for wallet-funded transactions, in sats per byte. */
export const FEE_RATE = 1.1;
/** Smallest withdrawal the contract accepts. */
export const MIN_WITHDRAWAL = 5_000n;

export const BLOCKS = { day: 144, hour: 6, week: 1008 } as const;

export interface VaultParams {
  ownerPk: Uint8Array;
  homePk: Uint8Array;
  /** Same as homePk when the vault has no guardian. */
  guardianPk: Uint8Array;
  panicPk: Uint8Array;
  /** Token category, as shown by explorers (the genesis input's txid). */
  category: string;
  allowance: bigint;
  waitBlocks: number;
  fastBlocks: number;
  refillBlocks: number;
  evictBlocks: number;
  /**
   * Contract version. 2 (default) is the Nov 19 contract with the review fixes. 1 is the
   * first contract, kept only so vaults made before Nov 19 still open and can be moved.
   */
  version?: 1 | 2;
}

export type HoldfastContract = Contract<typeof artifact>;

/** Explorers show the category reversed from how it sits in the transaction. */
export function categoryForContract(categoryHex: string): Uint8Array {
  return hexToBin(categoryHex).reverse();
}

const versions = new WeakMap<object, 1 | 2>();
/** Which contract version a vault runs (1 = before the Nov 19 fixes). */
export function versionOf(c: HoldfastContract): 1 | 2 {
  return versions.get(c) ?? 2;
}

export function makeVault(p: VaultParams, provider: NetworkProvider): HoldfastContract {
  const v = p.version ?? 2;
  const c = new Contract(
    (v === 1 ? artifactV1 : artifact) as typeof artifact,
    [
      p.ownerPk,
      p.homePk,
      p.guardianPk,
      p.panicPk,
      categoryForContract(p.category),
      p.allowance,
      BigInt(p.waitBlocks),
      BigInt(p.fastBlocks),
      BigInt(p.refillBlocks),
      BigInt(p.evictBlocks),
    ],
    { provider, contractType: 'p2sh32' },
  );
  versions.set(c, v);
  return c;
}

// ---------------- commitments ----------------

export interface MainState {
  level: 0 | 1 | 2;
  spent: bigint;
  unfreezeHome: boolean;
  unfreezeGuardian: boolean;
  recoverHome: boolean;
  recoverGuardian: boolean;
}

export const OPEN: MainState = {
  level: 0, spent: 0n, unfreezeHome: false, unfreezeGuardian: false, recoverHome: false, recoverGuardian: false,
};

function le(n: bigint, size: number): string {
  if (n < 0n) throw new Error('negative');
  let h = '';
  for (let i = 0; i < size; i++) {
    h += Number((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0');
  }
  return h;
}

function fromLe(hex: string): bigint {
  let n = 0n;
  for (let i = hex.length - 2; i >= 0; i -= 2) n = (n << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
  return n;
}

const flag = (b: boolean) => (b ? '01' : '00');

export function encodeMain(s: MainState): string {
  return le(BigInt(s.level), 1) + le(s.spent, 8) + flag(s.unfreezeHome) + flag(s.unfreezeGuardian) + flag(s.recoverHome) + flag(s.recoverGuardian);
}

export function decodeMain(hex: string): MainState {
  if (hex.length !== 26) throw new Error(`Bad vault state ${hex}`);
  return {
    level: parseInt(hex.slice(0, 2), 16) as 0 | 1 | 2,
    spent: fromLe(hex.slice(2, 18)),
    unfreezeHome: hex.slice(18, 20) === '01',
    unfreezeGuardian: hex.slice(20, 22) === '01',
    recoverHome: hex.slice(22, 24) === '01',
    recoverGuardian: hex.slice(24, 26) === '01',
  };
}

export function lockingBytecodeOf(address: string): Uint8Array {
  const r = cashAddressToLockingBytecode(address);
  if (typeof r === 'string') throw new Error(`Not a valid address: ${address}`);
  return r.bytecode;
}

export function encodePending(recipient: string, fast = false): string {
  return '50' + (fast ? '01' : '00') + binToHex(lockingBytecodeOf(recipient));
}

// ---------------- reading the address ----------------

export type VaultCoin =
  | { kind: 'main'; utxo: Utxo; state: MainState }
  | { kind: 'pending'; utxo: Utxo; recipientLock: string; fast: boolean }
  | { kind: 'ticket'; utxo: Utxo }
  | { kind: 'deposit'; utxo: Utxo }
  | { kind: 'foreign'; utxo: Utxo };

/** Sort every coin at the vault address. Tokens of other categories are ignored. */
export function classify(utxos: Utxo[], category: string): VaultCoin[] {
  return utxos.map((utxo): VaultCoin => {
    const t = utxo.token;
    if (!t) return { kind: 'deposit', utxo };
    if (t.category !== category || !t.nft) return { kind: 'foreign', utxo };
    const c = t.nft.commitment;
    if (t.nft.capability === 'minting') {
      try {
        return { kind: 'main', utxo, state: decodeMain(c) };
      } catch {
        return { kind: 'foreign', utxo };
      }
    }
    if (t.nft.capability === 'mutable' && c.startsWith('50')) {
      return { kind: 'pending', utxo, recipientLock: c.slice(4), fast: c.slice(2, 4) === '01' };
    }
    if (t.nft.capability === 'none' && c === '45') return { kind: 'ticket', utxo };
    return { kind: 'foreign', utxo };
  });
}

// ---------------- signers ----------------

/** A local key (home code, panic, or a test key) or the wallet's placeholder. */
export type Signer = SignatureTemplate | 'wallet';
/** Contract coins carry their unlocker separately; the builder only needs the outpoint and value. */
const su = (u: Utxo) => u as SpendableUtxo;
const sigOf = (s: Signer) => (s === 'wallet' ? placeholderSignature() : s);

function mainOut(contract: HoldfastContract, main: Utxo, state: MainState, amount: bigint) {
  return {
    to: contract.tokenAddress,
    amount,
    token: { category: main.token!.category, amount: 0n, nft: { capability: 'minting' as const, commitment: encodeMain(state) } },
  };
}

// ---------------- builders ----------------

/** A token genesis needs input 0 to spend an output at index 0. */
export function pickGenesisUtxo(utxos: SpendableUtxo[]): SpendableUtxo | undefined {
  return utxos.find((u) => u.vout === 0 && !u.token);
}

/** Create the vault: mint its minting NFT into the contract with the first deposit. */
export function buildCreate(o: {
  provider: NetworkProvider;
  contract: HoldfastContract;
  genesis: SpendableUtxo;
  otherUtxos: SpendableUtxo[];
  userAddress: string;
  amount: bigint;
  unlocker: Unlocker;
}): TransactionBuilder {
  return new TransactionBuilder({ provider: o.provider })
    .addInput(o.genesis, o.unlocker)
    .addInputs(o.otherUtxos.filter((u) => !u.token), o.unlocker)
    .addOutput({
      to: o.contract.tokenAddress,
      amount: o.amount,
      token: { category: o.genesis.txid, amount: 0n, nft: { capability: 'minting', commitment: encodeMain(OPEN) } },
    })
    .addBchChangeOutputIfNeeded({ to: o.userAddress, feeRate: FEE_RATE });
}

/** Phone: spend within the allowance. `fresh` starts a new allowance window after a quiet day. */
export function buildSpend(o: {
  contract: HoldfastContract;
  main: Utxo;
  state: MainState;
  amount: bigint;
  to: string;
  owner: Signer;
  fresh: boolean;
  refillBlocks: number;
}): TransactionBuilder {
  const legacy = versionOf(o.contract) === 1;
  const u = o.contract.unlock as any;
  const unlocker = legacy
    ? (o.fresh ? u.spendFresh(sigOf(o.owner), o.amount) : u.spend(sigOf(o.owner), o.amount))
    : o.contract.unlock.spend(sigOf(o.owner), o.amount, o.fresh);
  // The contract counts the payment plus its fee against the allowance.
  const next = { ...o.state, spent: (o.fresh ? 0n : o.state.spent) + o.amount + (legacy ? 0n : VAULT_FEE) };
  return new TransactionBuilder({ provider: o.contract.provider })
    .addInput(su(o.main), unlocker, o.fresh ? { sequence: o.refillBlocks } : undefined)
    .addOutput(mainOut(o.contract, o.main, next, o.main.satoshis - o.amount - VAULT_FEE))
    .addOutput({ to: o.to, amount: o.amount });
}

/** Phone: start a withdrawal that waits. */
export function buildStartWithdrawal(o: {
  contract: HoldfastContract;
  main: Utxo;
  state: MainState;
  amount: bigint;
  to: string;
  owner: Signer;
  /** After a quiet day the allowance window starts over (startWithdrawalFresh). */
  fresh?: boolean;
  refillBlocks?: number;
}): TransactionBuilder {
  const recipient = lockingBytecodeOf(o.to);
  const legacy = versionOf(o.contract) === 1;
  const unlocker = legacy
    ? (o.contract.unlock as any).startWithdrawal(sigOf(o.owner), o.amount, recipient)
    : o.contract.unlock.startWithdrawal(sigOf(o.owner), o.amount, recipient, !!o.fresh);
  // The fee counts against the allowance (version 2).
  const spent = legacy ? o.state.spent : (o.fresh ? 0n : o.state.spent) + VAULT_FEE;
  return new TransactionBuilder({ provider: o.contract.provider })
    .addInput(su(o.main), unlocker, o.fresh && !legacy ? { sequence: o.refillBlocks } : undefined)
    .addOutput(mainOut(o.contract, o.main, { ...o.state, spent }, o.main.satoshis - o.amount - VAULT_FEE))
    .addOutput({
      to: o.contract.tokenAddress,
      amount: o.amount,
      token: { category: o.main.token!.category, amount: 0n, nft: { capability: 'mutable', commitment: encodePending(o.to) } },
    });
}

/** Any vault key: pull a deposit, a waiting withdrawal (cancel) or a ticket back into the vault. */
export function buildMerge(o: {
  contract: HoldfastContract;
  main: Utxo;
  state: MainState;
  other: Utxo;
  pk: Uint8Array;
  signer: Signer;
}): TransactionBuilder {
  return new TransactionBuilder({ provider: o.contract.provider })
    .addInput(su(o.main), o.contract.unlock.merge(o.pk, sigOf(o.signer)))
    .addInput(su(o.other), o.contract.unlock.merged())
    .addOutput(mainOut(o.contract, o.main, o.state, o.main.satoshis + o.other.satoshis - MERGE_FEE));
}

/** Home code or guardian: full freeze. Panic key: duress freeze. */
export function buildFreeze(o: {
  contract: HoldfastContract;
  main: Utxo;
  state: MainState;
  pk: Uint8Array;
  signer: Signer;
  duress: boolean;
}): TransactionBuilder {
  // Version 2 records the freeze fee against the allowance.
  const legacy = versionOf(o.contract) === 1;
  const next: MainState = { ...OPEN, level: o.duress ? 1 : 2, spent: o.state.spent + (legacy ? 0n : VAULT_FEE) };
  return new TransactionBuilder({ provider: o.contract.provider })
    .addInput(su(o.main), o.contract.unlock.freeze(o.pk, sigOf(o.signer)))
    .addOutput(mainOut(o.contract, o.main, next, o.main.satoshis - VAULT_FEE));
}

/** The state an approval leads to, mirroring the contract. */
export function afterApprove(s: MainState, asHome: boolean, asGuardian: boolean, what: 'unfreeze' | 'recover', legacy = false): MainState {
  const n = { ...s };
  if (what === 'unfreeze') {
    if (asHome) n.unfreezeHome = true;
    if (asGuardian) n.unfreezeGuardian = true;
    // Unfreezing clears every approval, recovery ones too.
    if (n.unfreezeHome && n.unfreezeGuardian) {
      // Version 1 kept recovery approvals through an unfreeze; version 2 clears them.
      return legacy ? { ...n, level: 0, unfreezeHome: false, unfreezeGuardian: false } : { ...n, level: 0, unfreezeHome: false, unfreezeGuardian: false, recoverHome: false, recoverGuardian: false };
    }
  } else {
    if (asHome) n.recoverHome = true;
    if (asGuardian) n.recoverGuardian = true;
  }
  return n;
}

/** Home code or guardian: approve unfreezing or recovery. */
export function buildApprove(o: {
  contract: HoldfastContract;
  main: Utxo;
  state: MainState;
  pk: Uint8Array;
  asHome: boolean;
  asGuardian: boolean;
  signer: Signer;
  what: 'unfreeze' | 'recover';
  /** Version 2: after a quiet day the allowance window restarts with this approval's fee. */
  fresh?: boolean;
  refillBlocks?: number;
}): TransactionBuilder {
  const legacy = versionOf(o.contract) === 1;
  const after = afterApprove(o.state, o.asHome, o.asGuardian, o.what, legacy);
  // Version 2 counts the approval's fee against the allowance.
  const next = legacy ? after : { ...after, spent: (o.fresh ? 0n : o.state.spent) + VAULT_FEE };
  const what = o.what === 'unfreeze' ? 0n : 1n;
  const unlocker = legacy ? (o.contract.unlock as any).approve(o.pk, sigOf(o.signer), what) : o.contract.unlock.approve(o.pk, sigOf(o.signer), what, !!o.fresh);
  return new TransactionBuilder({ provider: o.contract.provider })
    .addInput(su(o.main), unlocker, o.fresh && !legacy ? { sequence: o.refillBlocks } : undefined)
    .addOutput(mainOut(o.contract, o.main, next, o.main.satoshis - VAULT_FEE));
}

/** Home code, once both approved recovery: move everything to `to`. */
export function buildRecover(o: { contract: HoldfastContract; main: Utxo; home: Signer; to: string; waitBlocks?: number }): TransactionBuilder {
  // With no guardian the contract also needs the vault coin to be `waitBlocks` old.
  return new TransactionBuilder({ provider: o.contract.provider })
    .addInput(su(o.main), o.contract.unlock.recover(sigOf(o.home)), o.waitBlocks ? { sequence: o.waitBlocks } : undefined)
    .addOutput({ to: o.to, amount: o.main.satoshis - VAULT_FEE });
}

/** Anyone: send a withdrawal on once its wait is over. */
export function buildRelease(o: {
  contract: HoldfastContract;
  pending: Utxo;
  to: string;
  fast: boolean;
  waitBlocks: number;
  fastBlocks: number;
}): TransactionBuilder {
  const unlocker = o.fast ? o.contract.unlock.releaseFast() : o.contract.unlock.release();
  return new TransactionBuilder({ provider: o.contract.provider })
    .addInput(su(o.pending), unlocker, { sequence: o.fast ? o.fastBlocks : o.waitBlocks })
    .addOutput({ to: o.to, amount: o.pending.satoshis - VAULT_FEE });
}

/** Guardian: put a waiting withdrawal in the fast lane. */
export function buildApproveFast(o: { contract: HoldfastContract; pending: Utxo; to: string; guardian: Signer }): TransactionBuilder {
  return new TransactionBuilder({ provider: o.contract.provider })
    .addInput(su(o.pending), o.contract.unlock.approveFast(sigOf(o.guardian)))
    .addOutput({
      to: o.contract.tokenAddress,
      amount: o.pending.satoshis - VAULT_FEE,
      token: { category: o.pending.token!.category, amount: 0n, nft: { capability: 'mutable', commitment: encodePending(o.to, true) } },
    });
}

/** Phone and home code: start the clock to replace the guardian. */
const ticketSats = (c: HoldfastContract) => (versionOf(c) === 1 ? 1_000n : TICKET_SATS);

export function buildStartEvict(o: { contract: HoldfastContract; main: Utxo; state: MainState; owner: Signer; home: Signer }): TransactionBuilder {
  return new TransactionBuilder({ provider: o.contract.provider })
    .addInput(su(o.main), o.contract.unlock.startEvict(sigOf(o.owner), sigOf(o.home)))
    // Version 2 counts the fee against the allowance.
    .addOutput(mainOut(o.contract, o.main, versionOf(o.contract) === 1 ? o.state : { ...o.state, spent: o.state.spent + VAULT_FEE }, o.main.satoshis - ticketSats(o.contract) - VAULT_FEE))
    .addOutput({
      to: o.contract.tokenAddress,
      amount: ticketSats(o.contract),
      token: { category: o.main.token!.category, amount: 0n, nft: { capability: 'none', commitment: '45' } },
    });
}

/** Phone and home code, once the ticket is old enough: move everything to `to`. */
export function buildEvict(o: {
  contract: HoldfastContract;
  main: Utxo;
  ticket: Utxo;
  owner: Signer;
  home: Signer;
  to: string;
  evictBlocks: number;
}): TransactionBuilder {
  return new TransactionBuilder({ provider: o.contract.provider })
    .addInput(su(o.main), o.contract.unlock.evict(sigOf(o.owner), sigOf(o.home)))
    .addInput(su(o.ticket), o.contract.unlock.ticket(), { sequence: o.evictBlocks })
    .addOutput({ to: o.to, amount: o.main.satoshis + o.ticket.satoshis - MERGE_FEE });
}
