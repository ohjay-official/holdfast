// Real vaults: configuration, keys, reading the chain into a view, and planning
// the wallet-funded creation. No UI and no network code, so it can be tested
// against the mock network.

import {
  binToHex,
  decodeBip39Mnemonic,
  decodeCashAddress,
  encodeBip39Mnemonic,
  encodeCashAddress,
  hash160,
  hexToBin,
  lockingBytecodeToCashAddress,
  secp256k1,
  sha256,
  utf8ToBin,
} from '@bitauth/libauth';
import { TransactionBuilder, type NetworkProvider, type SpendableUtxo, type Unlocker, type Utxo } from 'cashscript';
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
  if (c.v !== 1 || !c.category || !c.ownerPk) throw new Error('That vault code is incomplete.');
  return c;
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
  deposits: Utxo[];
  tickets: Utxo[];
  tip: number;
}

export function readVault(c: VaultConfig, utxos: Utxo[], heights: Map<string, number>, tip: number): VaultView {
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
    const spendable = mainCoin.utxo.satoshis - V.VAULT_FEE;
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
    deposits,
    tickets,
    tip,
  };
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
