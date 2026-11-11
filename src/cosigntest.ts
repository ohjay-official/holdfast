// Builders for the two-key risk test: the page signs with a key it holds,
// the wallet adds its signature over WizardConnect, both in one spend.

import {
  Contract,
  SignatureTemplate,
  TransactionBuilder,
  placeholderSignature,
  type NetworkProvider,
  type SpendableUtxo,
  type Unlocker,
} from 'cashscript';
import artifact from './CoSignTest.artifact.js';
import { FEE_RATE, VAULT_FEE } from './signtest.js';

/** Value locked in the two-key test contract. */
export const COSIGN_SATS = 3_000n;

export type CoSignContract = ReturnType<typeof makeCoSignContract>;

export function makeCoSignContract(ownerPk: Uint8Array, homePk: Uint8Array, provider: NetworkProvider) {
  return new Contract(artifact, [ownerPk, homePk], { provider, contractType: 'p2sh32' });
}

/** Wallet sends COSIGN_SATS into the two-key contract. */
export function buildFund(opts: {
  provider: NetworkProvider;
  contract: CoSignContract;
  userAddress: string;
  userUtxos: SpendableUtxo[];
  unlocker: Unlocker;
}): TransactionBuilder {
  const plain = opts.userUtxos.filter((u) => !u.token);
  if (plain.length === 0) throw new Error('No spendable coins at the wallet address');
  return new TransactionBuilder({ provider: opts.provider })
    .addInputs(plain, opts.unlocker)
    .addOutput({ to: opts.contract.address, amount: COSIGN_SATS })
    .addBchChangeOutputIfNeeded({ to: opts.userAddress, feeRate: FEE_RATE });
}

/**
 * Spend from the two-key contract back to the wallet. The page's home key signs
 * here; the wallet's signature is a placeholder unless `ownerSig` is given.
 */
export function buildCoSpend(opts: {
  provider: NetworkProvider;
  contract: CoSignContract;
  utxo: SpendableUtxo;
  homeKey: Uint8Array;
  userAddress: string;
  ownerSig?: SignatureTemplate;
}): TransactionBuilder {
  const unlocker = opts.contract.unlock.cosign(
    new SignatureTemplate(opts.homeKey),
    opts.ownerSig ?? placeholderSignature(),
  );
  return new TransactionBuilder({ provider: opts.provider })
    .addInput(opts.utxo, unlocker)
    .addOutput({ to: opts.userAddress, amount: opts.utxo.satoshis - VAULT_FEE });
}

export function findCoSignUtxo(utxos: SpendableUtxo[]): SpendableUtxo | undefined {
  return utxos.find((u) => !u.token);
}
