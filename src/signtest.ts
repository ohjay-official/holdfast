// Transaction builders for the pre-kickoff signing test.
// Pure functions: they take a provider and unlockers, so the same code runs
// against the mock network in tests and against chipnet in the browser.

import {
  Contract,
  TransactionBuilder,
  type NetworkProvider,
  type SpendableUtxo,
  type Unlocker,
} from 'cashscript';
import artifact from './SignTest.artifact.js';

/** Value kept in the test vault. */
export const VAULT_SATS = 3_000n;
/** Fee each vault spend leaves for miners. The contract allows at most 2,000. */
export const VAULT_FEE = 500n;
/** Fee rate for wallet-funded transactions, in sats per byte. */
export const FEE_RATE = 1.1;

export type SignTestContract = ReturnType<typeof makeContract>;

export function makeContract(ownerPk: Uint8Array, provider: NetworkProvider) {
  return new Contract(artifact, [ownerPk], { provider, contractType: 'p2sh32' });
}

/** 4-byte little-endian counter, as hex. */
export function counterHex(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 0x7fffffff) throw new Error(`Bad counter ${n}`);
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, n, true);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function readCounter(commitmentHex: string): number {
  if (commitmentHex.length !== 8) throw new Error(`Bad commitment ${commitmentHex}`);
  const bytes = Uint8Array.from(commitmentHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return new DataView(bytes.buffer).getUint32(0, true);
}

/** A token genesis needs input 0 to spend an output at index 0. */
export function pickGenesisUtxo(utxos: SpendableUtxo[]): SpendableUtxo | undefined {
  return utxos.find((u) => u.vout === 0 && !u.token);
}

/**
 * Self-send that turns any spendable coins into a single output at index 0,
 * so the next transaction can create a token.
 */
export function buildPrepare(opts: {
  provider: NetworkProvider;
  userAddress: string;
  userUtxos: SpendableUtxo[];
  unlocker: Unlocker;
}): TransactionBuilder {
  const plain = opts.userUtxos.filter((u) => !u.token);
  if (plain.length === 0) throw new Error('No spendable coins at the wallet address');
  return new TransactionBuilder({ provider: opts.provider })
    .addInputs(plain, opts.unlocker)
    .addBchChangeOutputIfNeeded({ to: opts.userAddress, feeRate: FEE_RATE });
}

/** Create the test vault: mint one mutable NFT (counter 0) into the contract. */
export function buildGenesis(opts: {
  provider: NetworkProvider;
  contract: SignTestContract;
  userAddress: string;
  userUtxos: SpendableUtxo[];
  unlocker: Unlocker;
}): { builder: TransactionBuilder; category: string } {
  const first = pickGenesisUtxo(opts.userUtxos);
  if (!first) throw new Error('Need a coin at output index 0 first (run prepare)');
  const rest = opts.userUtxos.filter((u) => u !== first && !u.token);
  const category = first.txid;
  const builder = new TransactionBuilder({ provider: opts.provider })
    .addInput(first, opts.unlocker)
    .addInputs(rest, opts.unlocker)
    .addOutput({
      to: opts.contract.tokenAddress,
      amount: VAULT_SATS,
      token: { amount: 0n, category, nft: { capability: 'mutable', commitment: counterHex(0) } },
    })
    .addBchChangeOutputIfNeeded({ to: opts.userAddress, feeRate: FEE_RATE });
  return { builder, category };
}

/** Spend the vault back into itself with the counter plus one. */
export function buildBump(opts: {
  provider: NetworkProvider;
  contract: SignTestContract;
  vaultUtxo: SpendableUtxo;
  unlocker: Unlocker;
  /** Set when the unlocker is bumpAfterAge: the input then needs sequence >= 1. */
  afterAge?: boolean;
}): TransactionBuilder {
  const token = opts.vaultUtxo.token;
  if (!token?.nft) throw new Error('Vault UTXO has no NFT');
  const next = readCounter(token.nft.commitment) + 1;
  return new TransactionBuilder({ provider: opts.provider })
    .addInput(opts.vaultUtxo, opts.unlocker, opts.afterAge ? { sequence: 1 } : undefined)
    .addOutput({
      to: opts.contract.tokenAddress,
      amount: opts.vaultUtxo.satoshis - VAULT_FEE,
      token: {
        amount: 0n,
        category: token.category,
        nft: { capability: 'mutable', commitment: counterHex(next) },
      },
    });
}

/** End of test: send the coins back to the wallet. The NFT is burned. */
export function buildWithdraw(opts: {
  provider: NetworkProvider;
  vaultUtxo: SpendableUtxo;
  unlocker: Unlocker;
  userAddress: string;
}): TransactionBuilder {
  return new TransactionBuilder({ provider: opts.provider })
    .addInput(opts.vaultUtxo, opts.unlocker)
    .addOutput({ to: opts.userAddress, amount: opts.vaultUtxo.satoshis - VAULT_FEE });
}

/** The vault UTXO is the contract UTXO carrying our NFT. */
export function findVaultUtxo(utxos: SpendableUtxo[], category?: string): SpendableUtxo | undefined {
  return utxos.find(
    (u) => u.token?.nft?.capability === 'mutable' && (!category || u.token.category === category),
  );
}
