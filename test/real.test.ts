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

// ---------------- backend flows not yet run on mainnet (Nov 17) ----------------

const sendLocal = async (tb: TransactionBuilder) => (await tb.send()).txid;

/** Re-check a built transaction (local keys, or none) with the BCH 2025 VM, the same check the wallet sim does. */
function vmCheck(tb: TransactionBuilder): string {
  const req = toRelaySignRequest(tb.generateWcTransactionObject({ broadcast: false, userPrompt: 'check' }));
  const { signedTransaction, sourceOutputs } = walletSign(req, [], ownerKey);
  const ok = verifySigned(signedTransaction, sourceOutputs);
  if (ok !== true) throw new Error(String(ok));
  return signedTransaction;
}

const someone = C.p2pkhAddress(C.publicKeyOf(new Uint8Array(32).fill(11)), 'chipnet');
const sumAt = async (provider: MockNetworkProvider, a: string) => (await provider.getUtxos(a)).reduce((s, u) => s + u.satoshis, 0n);

describe('backend flows proven on the mock network', () => {
  it('(a) add deposits: a plain deposit merges into the vault, minus the merge fee', async () => {
    const { provider, contract, read, config } = await created();
    provider.addUtxo(contract.address, randomUtxo({ satoshis: 50_000n }));
    let v = await read();
    expect(v.deposits).toHaveLength(1);
    expect(v.depositSats).toBe(50_000n);
    expect(v.total).toBe(450_000n);
    expect(C.mergeableDeposits(v)).toHaveLength(1);
    const tb = V.buildMerge({ contract, main: v.main!, state: v.state!, other: v.deposits[0], pk: hexToBin(config.ownerPk), signer: 'wallet' });
    await viaWallet(provider, tb, [0]);
    v = await read();
    expect(v.deposits).toHaveLength(0);
    expect(v.main!.satoshis).toBe(450_000n - V.MERGE_FEE);
    expect(v.state).toEqual(V.OPEN);
  });

  it('(a) a deposit smaller than the merge fee is not offered, since adding it would shrink the vault', async () => {
    const { provider, contract, read } = await created();
    provider.addUtxo(contract.address, randomUtxo({ satoshis: 3_000n }));
    provider.addUtxo(contract.address, randomUtxo({ satoshis: 20_000n }));
    const v = await read();
    expect(v.deposits).toHaveLength(2);
    expect(C.mergeableDeposits(v).map((u) => u.satoshis)).toEqual([20_000n]);
  });

  it('(b) no guardian: the home code alone unfreezes in one transaction', async () => {
    const { contract, read, homeKey, config } = await created(false);
    const home = new SignatureTemplate(homeKey);
    let v = await read();
    await V.buildFreeze({ contract, main: v.main!, state: v.state!, pk: home.publicKey, signer: home, duress: false }).send();
    v = await read();
    expect(v.state!.level).toBe(2);
    const roles = C.approveRoles(config, 'home');
    expect(roles).toEqual({ asHome: true, asGuardian: true });
    const tb = V.buildApprove({ contract, main: v.main!, state: v.state!, pk: home.publicKey, ...roles, signer: home, what: 'unfreeze' });
    vmCheck(tb);
    await tb.send();
    v = await read();
    expect(v.state).toEqual({ ...V.OPEN, spent: v.state!.spent });
    expect(v.allowanceLeft).toBe(50_000n);
    // With a guardian, the home code alone only records its half.
    expect(C.approveRoles({ ...config, hasGuardian: true }, 'home')).toEqual({ asHome: true, asGuardian: false });
    expect(C.approveRoles(config, 'guardian')).toEqual({ asHome: false, asGuardian: true });
  });

  it('(b) no guardian: approving only as home would not match the contract, so the roles helper matters', async () => {
    const { contract, read, homeKey } = await created(false);
    const home = new SignatureTemplate(homeKey);
    let v = await read();
    await V.buildFreeze({ contract, main: v.main!, state: v.state!, pk: home.publicKey, signer: home, duress: false }).send();
    v = await read();
    const wrong = V.buildApprove({ contract, main: v.main!, state: v.state!, pk: home.publicKey, asHome: true, asGuardian: false, signer: home, what: 'unfreeze' });
    expect(() => vmCheck(wrong)).toThrow();
  });

  it('(c) a withdrawal left waiting through a freeze releases once the vault is unfrozen', async () => {
    const { provider, contract, read, homeKey } = await created(false);
    const home = new SignatureTemplate(homeKey);
    let v = await read();
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: 100_000n, to: someone, owner: 'wallet' }), [0]);
    v = await read();
    await V.buildFreeze({ contract, main: v.main!, state: v.state!, pk: home.publicKey, signer: home, duress: false }).send();
    v = await read();
    expect(v.state!.level).toBe(2);
    expect(v.pending).toHaveLength(1);
    await V.buildApprove({ contract, main: v.main!, state: v.state!, pk: home.publicKey, ...C.approveRoles({ hasGuardian: false } as C.VaultConfig, 'home'), signer: home, what: 'unfreeze' }).send();
    v = await read(2000, 1500);
    expect(v.state!.level).toBe(0);
    expect(v.pending[0].ready).toBe(true);
    const tb = V.buildRelease({ contract, pending: v.pending[0].utxo, to: v.pending[0].to, fast: false, waitBlocks: 432, fastBlocks: 6 });
    vmCheck(tb);
    await tb.send();
    expect(await sumAt(provider, someone)).toBe(100_000n - V.VAULT_FEE);
    expect((await read()).pending).toHaveLength(0);
  });

  it('(c) the contract does not stop a ready withdrawal while frozen, which is why freezing also cancels', async () => {
    const { provider, contract, read, homeKey } = await created(false);
    const home = new SignatureTemplate(homeKey);
    let v = await read();
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: 100_000n, to: someone, owner: 'wallet' }), [0]);
    v = await read();
    await V.buildFreeze({ contract, main: v.main!, state: v.state!, pk: home.publicKey, signer: home, duress: false }).send();
    v = await read(2000, 1500);
    const tb = V.buildRelease({ contract, pending: v.pending[0].utxo, to: v.pending[0].to, fast: false, waitBlocks: 432, fastBlocks: 6 });
    expect(vmCheck(tb)).toBeTruthy();
    // The home code's freeze path cancels everything waiting, so nothing is left to release.
    v = await read();
    const steps = await C.lockDown({ read: () => read(), send: sendLocal, contract, key: home, mode: 'home', wait: async () => {} });
    expect(steps.map((s) => s.what)).toEqual(['cancel']);
    v = await read();
    expect(v.pending).toHaveLength(0);
    expect(v.state!.level).toBe(2);
  });

  it('(d) a guardian opens the vault from its HF1 code on a second device and every guardian action is valid', async () => {
    const { provider, contract, config, guardianKey } = await created(true);
    // Second device: only the vault code, a fresh provider view of the same chain.
    const code = C.encodeVaultCode(config);
    expect(code.startsWith('HF1.')).toBe(true);
    const gc = C.decodeVaultCode(code);
    expect(gc).toEqual(config);
    const gContract = V.makeVault(C.paramsOf(gc), provider);
    expect(gContract.address).toBe(contract.address);
    const gRead = async (tip = 1000, h = 900) => {
      const utxos = await gContract.getUtxos();
      return C.readVault(gc, utxos, new Map(utxos.map((u) => [`${u.txid}:${u.vout}`, h])), tip);
    };
    const gSign = async (tb: TransactionBuilder) => {
      const req = toRelaySignRequest(tb.generateWcTransactionObject({ broadcast: false, userPrompt: 'g' }));
      const { signedTransaction, sourceOutputs } = walletSign(req, [[0, 'receive', 0]], guardianKey);
      const ok = verifySigned(signedTransaction, sourceOutputs); if (ok !== true) throw new Error(String(ok));
      return provider.sendRawTransaction(signedTransaction);
    };
    const gpk = hexToBin(gc.guardianPk);
    let v = await gRead();
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: 60_000n, to: someone, owner: 'wallet' }), [0]);
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: (await gRead()).main!, state: (await gRead()).state!, amount: 70_000n, to: someone, owner: 'wallet' }), [0]);
    v = await gRead();
    expect(v.pending).toHaveLength(2);
    await gSign(V.buildApproveFast({ contract: gContract, pending: v.pending[0].utxo, to: v.pending[0].to, guardian: 'wallet' }));
    v = await gRead();
    expect(v.pending.filter((p) => p.fast)).toHaveLength(1);
    await gSign(V.buildFreeze({ contract: gContract, main: v.main!, state: v.state!, pk: gpk, signer: 'wallet', duress: false }));
    v = await gRead();
    expect(v.state!.level).toBe(2);
    for (const p of [...v.pending]) {
      const now = await gRead();
      await gSign(V.buildMerge({ contract: gContract, main: now.main!, state: now.state!, other: now.pending.find((x) => x.utxo.txid === p.utxo.txid && x.utxo.vout === p.utxo.vout)!.utxo, pk: gpk, signer: 'wallet' }));
    }
    v = await gRead();
    expect(v.pending).toHaveLength(0);
    await gSign(V.buildApprove({ contract: gContract, main: v.main!, state: v.state!, pk: gpk, ...C.approveRoles(gc, 'guardian'), signer: 'wallet', what: 'unfreeze' }));
    await gSign(V.buildApprove({ contract: gContract, main: (await gRead()).main!, state: (await gRead()).state!, pk: gpk, ...C.approveRoles(gc, 'guardian'), signer: 'wallet', what: 'recover' }));
    v = await gRead();
    expect(v.state!.unfreezeGuardian).toBe(true);
    expect(v.state!.recoverGuardian).toBe(true);
    expect(v.state!.level).toBe(2);
    // Nothing a guardian signs can pay out: a guardian-signed spend is refused.
    expect(() => vmCheck(V.buildRecover({ contract: gContract, main: v.main!, home: new SignatureTemplate(guardianKey), to: someone }))).toThrow();
  });

  it('(d) a damaged or altered vault code is refused with a plain message', async () => {
    const { config } = await created(true);
    const enc = (o: unknown) => 'HF1.' + btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(() => C.decodeVaultCode('hello')).toThrow(/HF1/);
    expect(() => C.decodeVaultCode('HF1.%%%')).toThrow(/damaged/);
    expect(() => C.decodeVaultCode(enc({ ...config, net: 'testnet' }))).toThrow();
    expect(() => C.decodeVaultCode(enc({ ...config, guardianPk: 'zz' }))).toThrow();
    expect(() => C.decodeVaultCode(enc({ ...config, category: config.category.slice(2) }))).toThrow();
    expect(() => C.decodeVaultCode(enc({ ...config, allowance: '-5' }))).toThrow();
    expect(() => C.decodeVaultCode(enc({ ...config, waitBlocks: 0 }))).toThrow();
    expect(() => C.decodeVaultCode(enc({ ...config, hasGuardian: false }))).toThrow();
    expect(C.decodeVaultCode('  ' + C.encodeVaultCode(config) + '\n')).toEqual(config);
  });

  it('(e) duress: the panic key freezes, cancels every waiting withdrawal, and the duress view shows only the allowance', async () => {
    const { provider, contract, read, panicKey } = await created();
    let v = await read();
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: 100_000n, to: someone, owner: 'wallet' }), [0]);
    v = await read();
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: 80_000n, to: someone, owner: 'wallet' }), [0]);
    const before = await read();
    expect(before.pending).toHaveLength(2);
    const panic = new SignatureTemplate(panicKey);
    const seen: string[] = [];
    const steps = await C.lockDown({ read: () => read(), send: sendLocal, contract, key: panic, mode: 'duress', wait: async () => {}, onStep: (s) => seen.push(s.what) });
    expect(steps.map((s) => s.what)).toEqual(['freeze', 'cancel', 'cancel']);
    expect(seen).toEqual(['freeze', 'cancel', 'cancel']);
    v = await read();
    expect(v.state!.level).toBe(1);
    expect(v.pending).toHaveLength(0);
    expect(v.total).toBe(before.total - V.VAULT_FEE - 2n * V.MERGE_FEE);
    expect(C.duressBalance(v)).toBe(50_000n);
    expect(C.duressBalance(v)).toBe(v.allowanceLeft);
    // The robber can't start a new withdrawal while duress-frozen...
    await expect(viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: 100_000n, to: someone, owner: 'wallet' }), [0])).rejects.toThrow();
    // ...but the allowance still works, so the decoy looks real.
    await viaWallet(provider, V.buildSpend({ contract, main: v.main!, state: v.state!, amount: 50_000n, to: someone, owner: 'wallet', fresh: v.fresh, refillBlocks: 144 }), [0]);
    // Running the duress path again does nothing new.
    expect(await C.lockDown({ read: () => read(), send: sendLocal, contract, key: panic, mode: 'duress', wait: async () => {} })).toEqual([]);
  });

  it('(f) release needs no wallet signature: anyone broadcasts it and the recipient gets the amount minus 2,000 sats', async () => {
    const { provider, contract, read } = await created();
    let v = await read();
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: 100_000n, to: someone, owner: 'wallet' }), [0]);
    v = await read(2000, 1500);
    const p = v.pending[0];
    expect(p.ready).toBe(true);
    const tb = V.buildRelease({ contract, pending: p.utxo, to: p.to, fast: false, waitBlocks: 432, fastBlocks: 6 });
    const req = toRelaySignRequest(tb.generateWcTransactionObject({ broadcast: false, userPrompt: 'r' }));
    // No placeholder signature anywhere: nothing for Paytaca to sign.
    expect(JSON.stringify(req)).not.toContain('41' + '00'.repeat(65));
    vmCheck(tb);
    const before = await sumAt(provider, someone);
    await tb.send();
    expect((await sumAt(provider, someone)) - before).toBe(100_000n - 2_000n);
    expect(V.VAULT_FEE).toBe(2_000n);
    expect((await read()).pending).toHaveLength(0);
  });
});

describe('backend bugs found in review (Nov 17)', () => {
  it('the vault coin always keeps enough sats to stay above the dust limit, so "send all" and "withdraw all" can be built', async () => {
    const { provider, contract, read } = await created();
    let v = await read();
    // Drain the vault coin down with a withdrawal of the most the app allows.
    const max = C.maxWithdrawal(v);
    expect(max).toBe(v.main!.satoshis - V.VAULT_FEE - C.MAIN_MIN);
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: max, to: someone, owner: 'wallet' }), [0]);
    v = await read();
    expect(v.main!.satoshis).toBe(C.MAIN_MIN);
    expect(v.allowanceLeft).toBe(0n);
    // Before the fix, the app offered main - fee, which can't be built.
    const raw = (await read()).main!.satoshis - V.VAULT_FEE;
    expect(raw).toBeLessThan(0n + C.MAIN_MIN);
  });

  it('allowance offered never leaves the vault coin under the dust limit', async () => {
    const { provider, contract, read } = await created();
    let v = await read();
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: v.main!.satoshis - V.VAULT_FEE - 30_000n, to: someone, owner: 'wallet' }), [0]);
    v = await read();
    expect(v.main!.satoshis).toBe(30_000n);
    expect(v.allowanceLeft).toBe(30_000n - V.VAULT_FEE - C.MAIN_MIN);
    const tb = V.buildSpend({ contract, main: v.main!, state: v.state!, amount: v.allowanceLeft, to: someone, owner: 'wallet', fresh: v.fresh, refillBlocks: 144 });
    await viaWallet(provider, tb, [0]);
  });

  it('a withdrawal too small to release is refused up front', () => {
    expect(C.minWithdrawal(someone, 'chipnet')).toBe(V.VAULT_FEE + 546n);
    const p2sh32 = C.addressOfLock('aa20' + '11'.repeat(32) + '87', 'chipnet');
    expect(C.minWithdrawal(p2sh32, 'chipnet')).toBe(V.VAULT_FEE + 576n);
    expect(C.minPayment(someone)).toBe(546n);
    expect(C.minWithdrawal(someone, 'chipnet')).toBeGreaterThan(V.MIN_WITHDRAWAL);
  });

  it('lockDown waits for the network to show each step instead of spending a stale vault coin', async () => {
    const { provider, contract, read, homeKey } = await created(false);
    let v = await read();
    for (const amt of [40_000n, 30_000n]) {
      v = await read();
      await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: amt, to: someone, owner: 'wallet' }), [0]);
    }
    const home = new SignatureTemplate(homeKey);
    // A slow server: the first read after each step still shows the old vault coin.
    let stale: C.VaultView | null = null;
    let sentSinceRead = false;
    const slowRead = async () => {
      if (sentSinceRead && stale) { sentSinceRead = false; return stale; }
      stale = await read();
      return stale;
    };
    const send = async (tb: TransactionBuilder) => { sentSinceRead = true; return sendLocal(tb); };
    let waits = 0;
    const steps = await C.lockDown({ read: slowRead, send, contract, key: home, mode: 'home', wait: async () => { waits++; } });
    expect(steps.map((s) => s.what)).toEqual(['freeze', 'cancel', 'cancel']);
    expect(waits).toBeGreaterThan(0);
    v = await read();
    expect(v.pending).toHaveLength(0);
    expect(v.state!.level).toBe(2);
  });

  it('lockDown gives a plain error, not a hang, when the network never shows the step', async () => {
    const { contract, read, homeKey } = await created(false);
    const home = new SignatureTemplate(homeKey);
    const first = await read();
    let sent = 0;
    await expect(C.lockDown({ read: async () => first, send: async () => { sent++; return 'x'; }, contract, key: home, mode: 'home', wait: async () => {} })).rejects.toThrow(/hasn't shown/);
    expect(sent).toBe(1);
  });

  it('crash safety: an earlier creation that reached the chain is adopted, never overwritten', async () => {
    const { config, read } = await created();
    const readFor = async (c: C.VaultConfig) => (c.category === config.category ? read() : C.readVault(c, [], new Map(), 1000));
    expect(await C.resolveEarlierCreation(config, readFor)).toBe('adopt');
    expect(await C.resolveEarlierCreation({ ...config, category: '00'.repeat(32) }, readFor)).toBe('replace');
    await expect(C.resolveEarlierCreation(config, async () => { throw new Error('websocket closed'); })).rejects.toThrow(/earlier/);
  });
});

describe('lost phone: home code and vault code on another device, no wallet', () => {
  it('no guardian: freeze, cancel and move everything to a new address with only the 12 words and the HF1 code', async () => {
    const { provider, contract, read, config, words } = await created(false);
    let v = await read();
    await viaWallet(provider, V.buildStartWithdrawal({ contract, main: v.main!, state: v.state!, amount: 120_000n, to: someone, owner: 'wallet' }), [0]);
    // New device: nothing saved, no Paytaca.
    const c2 = C.decodeVaultCode(C.encodeVaultCode(config));
    const key = C.homeKeyFromWords(words.join(' '));
    expect(binToHex(C.publicKeyOf(key))).toBe(c2.homePk);
    const k2 = V.makeVault(C.paramsOf(c2), provider);
    const r2 = async () => { const u = await k2.getUtxos(); return C.readVault(c2, u, new Map(u.map((x) => [`${x.txid}:${x.vout}`, 900])), 1000); };
    const home = new SignatureTemplate(key);
    const steps = await C.lockDown({ read: r2, send: sendLocal, contract: k2, key: home, mode: 'home', wait: async () => {} });
    expect(steps.map((s) => s.what)).toEqual(['freeze', 'cancel']);
    v = await r2();
    await V.buildApprove({ contract: k2, main: v.main!, state: v.state!, pk: home.publicKey, ...C.approveRoles(c2, 'home'), signer: home, what: 'recover' }).send();
    v = await r2();
    expect(v.state!.recoverHome && v.state!.recoverGuardian).toBe(true);
    const fresh = C.p2pkhAddress(C.publicKeyOf(new Uint8Array(32).fill(21)), 'chipnet');
    const tb = V.buildRecover({ contract: k2, main: v.main!, home, to: fresh });
    vmCheck(tb);
    await tb.send();
    expect(await sumAt(provider, fresh)).toBe(v.main!.satoshis - V.VAULT_FEE);
    expect((await r2()).main).toBeNull();
  });

  it('with a guardian: the home code alone cannot move everything until the guardian approves', async () => {
    const { provider, read, config, words, guardianKey } = await created(true);
    const c2 = C.decodeVaultCode(C.encodeVaultCode(config));
    const k2 = V.makeVault(C.paramsOf(c2), provider);
    const home = new SignatureTemplate(C.homeKeyFromWords(words.join(' ')));
    let v = await read();
    await V.buildApprove({ contract: k2, main: v.main!, state: v.state!, pk: home.publicKey, ...C.approveRoles(c2, 'home'), signer: home, what: 'recover' }).send();
    v = await read();
    const fresh = C.p2pkhAddress(C.publicKeyOf(new Uint8Array(32).fill(21)), 'chipnet');
    expect(() => vmCheck(V.buildRecover({ contract: k2, main: v.main!, home, to: fresh }))).toThrow();
    const g = new SignatureTemplate(guardianKey);
    await V.buildApprove({ contract: k2, main: v.main!, state: v.state!, pk: g.publicKey, ...C.approveRoles(c2, 'guardian'), signer: g, what: 'recover' }).send();
    v = await read();
    vmCheck(V.buildRecover({ contract: k2, main: v.main!, home, to: fresh }));
  });
});
