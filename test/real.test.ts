import { describe, expect, it } from 'vitest';
import { MockNetworkProvider, SignatureTemplate, placeholderP2PKHUnlocker, randomUtxo, type TransactionBuilder } from 'cashscript';
import { binToHex, hexToBin } from '@bitauth/libauth';
import * as V from '../src/vault.js';
import * as C from '../src/real/core.js';
import { toRelaySignRequest } from '../src/relay.js';
import { walletSign, verifySigned } from './wallet-sim.js';

const ownerKey = new Uint8Array(32).fill(7);
const ownerPk = C.publicKeyOf(ownerKey);
const ownerAddr = C.p2pkhAddress(ownerPk, 'chipnet');

/** Paytaca's side, then broadcast: what the app's signAndSend does. */
async function viaWallet(provider: MockNetworkProvider, tb: TransactionBuilder, paths: number[]) {
  const req = toRelaySignRequest(tb.generateWcTransactionObject({ broadcast: false, userPrompt: 't' }));
  const { signedTransaction, sourceOutputs } = walletSign(req, paths.map((i) => [i, 'receive', 0]), ownerKey);
  const ok = verifySigned(signedTransaction, sourceOutputs); if (ok !== true) throw new Error(String(ok));
  return provider.sendRawTransaction(signedTransaction);
}

async function walletCoins(provider: MockNetworkProvider): Promise<C.WalletCoin[]> {
  return (await provider.getUtxos(ownerAddr)).map((u) => ({ ...u, path: ['receive', 0] as [string, number] }));
}

async function created(withGuardian = true) {
  const provider = new MockNetworkProvider();
  provider.addUtxo(ownerAddr, randomUtxo({ satoshis: 300_000n, vout: 1 }));
  provider.addUtxo(ownerAddr, randomUtxo({ satoshis: 200_000n, vout: 2 }));
  const words = C.newHomeWords();
  const homeKey = C.homeKeyFromWords(words.join(' '));
  const panicKey = C.randomPrivateKey();
  const guardianKey = new Uint8Array(32).fill(3);
  let coins = await walletCoins(provider);
  let plan = C.planCreate(coins, 400_000n);
  expect(plan.needsPrepare).toBe(true);
  expect(plan.enough).toBe(true);
  const unlocker = () => placeholderP2PKHUnlocker(ownerAddr);
  const prep = C.buildPrepare({ provider, coins, changeAddress: ownerAddr, unlocker });
  await viaWallet(provider, prep, prep.inputs.map((_, i) => i));
  coins = await walletCoins(provider);
  plan = C.planCreate(coins, 400_000n);
  expect(plan.needsPrepare).toBe(false);
  const genesis = coins.find((u) => u.vout === 0)!;
  const config: C.VaultConfig = {
    v: 1, net: 'chipnet', ownerPk: binToHex(ownerPk), homePk: binToHex(C.publicKeyOf(homeKey)),
    guardianPk: binToHex(withGuardian ? C.publicKeyOf(guardianKey) : C.publicKeyOf(homeKey)), panicPk: binToHex(C.publicKeyOf(panicKey)),
    hasGuardian: withGuardian, category: genesis.txid, allowance: '50000', waitBlocks: 432, fastBlocks: 6, refillBlocks: 144, evictBlocks: 1008,
  };
  const contract = V.makeVault(C.paramsOf(config), provider);
  const { builder, inputs } = C.buildCreateWithFee({ provider, contract, coins, amount: 400_000n, net: 'chipnet', changeAddress: ownerAddr, unlocker });
  await viaWallet(provider, builder, inputs.map((_, i) => i));
  const read = async (tip = 1000, h = 900) => {
    const utxos = await contract.getUtxos();
    const heights = new Map(utxos.map((u) => [`${u.txid}:${u.vout}`, h]));
    return C.readVault(config, utxos, heights, tip);
  };
  return { provider, contract, config, homeKey, panicKey, guardianKey, read, words };
}

describe('real vault flows', () => {
  it('creates a vault from a Paytaca-signed transaction and pays the fee', async () => {
    const { provider, read, config } = await created();
    const v = await read();
    expect(v.total).toBe(400_000n);
    expect(v.state).toEqual(V.OPEN);
    expect(v.allowanceLeft).toBe(50_000n);
    const fee = await provider.getUtxos(C.feeAddress('chipnet'));
    expect(fee.map((u) => u.satoshis)).toContain(C.CREATE_FEE);
    expect(C.decodeVaultCode(C.encodeVaultCode(config))).toEqual(config);
  });

  it('the robbery with a real wallet: allowance now, the rest waits, home code cancels and freezes', async () => {
    const { provider, contract, read, homeKey } = await created();
    let v = await read();
    const robber = C.p2pkhAddress(C.publicKeyOf(new Uint8Array(32).fill(9)), 'chipnet');
    await viaWallet(provider, V.buildSpend({ contract, main: v.main!, state: v.state!, amount: v.allowanceLeft, to: robber, owner: 'wallet', fresh: v.fresh, refillBlocks: 144 }), [0]);
    v = await read();
    expect(v.allowanceLeft).toBe(0n);
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: 300_000n, to: robber, owner: 'wallet' }), [0]);
    v = await read(1000, 1000);
    expect(v.pending).toHaveLength(1);
    expect(v.pending[0].to).toBe(robber);
    expect(v.pending[0].ready).toBe(false);
    expect(v.pending[0].blocksLeft).toBe(431);
    // Home code: no wallet prompt, signed in the page.
    const home = new SignatureTemplate(homeKey);
    await V.buildMerge({ contract, main: v.main!, state: v.state!, other: v.pending[0].utxo, pk: home.publicKey, signer: home }).send();
    v = await read();
    await V.buildFreeze({ contract, main: v.main!, state: v.state!, pk: home.publicKey, signer: home, duress: false }).send();
    v = await read();
    expect(v.pending).toHaveLength(0);
    expect(v.state!.level).toBe(2);
    expect(v.allowanceLeft).toBe(0n);
  });

  it('duress PIN: the panic key cancels and freezes without the wallet, allowance still works', async () => {
    const { provider, contract, read, panicKey } = await created();
    let v = await read();
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: 100_000n, to: ownerAddr, owner: 'wallet' }), [0]);
    v = await read();
    const panic = new SignatureTemplate(panicKey);
    await V.buildFreeze({ contract, main: v.main!, state: v.state!, pk: panic.publicKey, signer: panic, duress: true }).send();
    v = await read();
    await V.buildMerge({ contract, main: v.main!, state: v.state!, other: v.pending[0].utxo, pk: panic.publicKey, signer: panic }).send();
    v = await read();
    expect(v.state!.level).toBe(1);
    expect(v.pending).toHaveLength(0);
    expect(v.allowanceLeft).toBe(50_000n);
  });

  it('allowance refill shows as fresh once the vault coin is a day old', async () => {
    const { provider, contract, read } = await created();
    let v = await read();
    await viaWallet(provider, V.buildSpend({ contract, main: v.main!, state: v.state!, amount: 20_000n, to: ownerAddr, owner: 'wallet', fresh: false, refillBlocks: 144 }), [0]);
    v = await read(1000, 950);
    expect(v.fresh).toBe(false);
    expect(v.allowanceLeft).toBe(30_000n);
    expect(v.refillIn).toBe(93);
    v = await read(1100, 957);
    expect(v.fresh).toBe(true);
    await viaWallet(provider, V.buildSpend({ contract, main: v.main!, state: v.state!, amount: 50_000n, to: ownerAddr, owner: 'wallet', fresh: true, refillBlocks: 144 }), [0]);
  });

  it('release after the wait needs no signature', async () => {
    const { provider, contract, read } = await created();
    let v = await read();
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: 100_000n, to: ownerAddr, owner: 'wallet' }), [0]);
    v = await read(2000, 1500);
    expect(v.pending[0].ready).toBe(true);
    await V.buildRelease({ contract, pending: v.pending[0].utxo, to: v.pending[0].to, fast: false, waitBlocks: 432, fastBlocks: 6 }).send();
  });

  it('guardian approvals from a wallet, then unfreeze', async () => {
    const { provider, contract, read, homeKey, guardianKey } = await created();
    const home = new SignatureTemplate(homeKey);
    let v = await read();
    await V.buildFreeze({ contract, main: v.main!, state: v.state!, pk: home.publicKey, signer: home, duress: false }).send();
    v = await read();
    await V.buildApprove({ contract, main: v.main!, state: v.state!, pk: home.publicKey, asHome: true, asGuardian: false, signer: home, what: 'unfreeze' }).send();
    v = await read();
    const g = new SignatureTemplate(guardianKey);
    await V.buildApprove({ contract, main: v.main!, state: v.state!, pk: g.publicKey, asHome: false, asGuardian: true, signer: g, what: 'unfreeze' }).send();
    v = await read();
    expect(v.state!.level).toBe(0);
    void provider;
  });

  it('owner cancels from the phone, and a guardian acts from their own wallet', async () => {
    const { provider, contract, read, config, guardianKey } = await created();
    let v = await read();
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: 100_000n, to: ownerAddr, owner: 'wallet' }), [0]);
    v = await read();
    await viaWallet(provider, V.buildMerge({ contract, main: v.main!, state: v.state!, other: v.pending[0].utxo, pk: hexToBin(config.ownerPk), signer: 'wallet' }), [0]);
    v = await read();
    expect(v.pending).toHaveLength(0);
    // Guardian's Paytaca signs with the guardian key.
    const gSign = async (tb: TransactionBuilder) => {
      const req = toRelaySignRequest(tb.generateWcTransactionObject({ broadcast: false, userPrompt: 'g' }));
      const { signedTransaction, sourceOutputs } = walletSign(req, [[0, 'receive', 0]], guardianKey);
      const ok = verifySigned(signedTransaction, sourceOutputs); if (ok !== true) throw new Error(String(ok));
      return provider.sendRawTransaction(signedTransaction);
    };
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: 100_000n, to: ownerAddr, owner: 'wallet' }), [0]);
    v = await read();
    await gSign(V.buildApproveFast({ contract, pending: v.pending[0].utxo, to: v.pending[0].to, guardian: 'wallet' }));
    v = await read();
    expect(v.pending[0].fast).toBe(true);
    await gSign(V.buildFreeze({ contract, main: v.main!, state: v.state!, pk: hexToBin(config.guardianPk), signer: 'wallet', duress: false }));
    v = await read();
    await gSign(V.buildMerge({ contract, main: v.main!, state: v.state!, other: v.pending[0].utxo, pk: hexToBin(config.guardianPk), signer: 'wallet' }));
    v = await read();
    expect(v.state!.level).toBe(2);
    expect(v.pending).toHaveLength(0);
    await gSign(V.buildApprove({ contract, main: v.main!, state: v.state!, pk: hexToBin(config.guardianPk), asHome: false, asGuardian: true, signer: 'wallet', what: 'unfreeze' }));
    expect((await read()).state!.unfreezeGuardian).toBe(true);
  });

  it('home words: a typo is caught, case and spacing are not', () => {
    const words = C.newHomeWords();
    const k = C.homeKeyFromWords(words.join(' '));
    expect(C.homeKeyFromWords('  ' + words.join('  ').toUpperCase())).toEqual(k);
    const bad = [...words];
    bad[3] = bad[3] === 'abandon' ? 'ability' : 'abandon';
    expect(() => C.homeKeyFromWords(bad.join(' '))).toThrow();
    expect(() => C.homeKeyFromWords(words.slice(0, 11).join(' '))).toThrow(/12/);
  });

  it('fee address is the project address on each network', () => {
    expect(C.feeAddress('mainnet')).toMatch(/^bitcoincash:q/);
    expect(C.feeAddress('chipnet')).toMatch(/^bchtest:q/);
  });
});
