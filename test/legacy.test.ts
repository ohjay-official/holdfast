// Vaults made before the Nov 19 fixes run contract version 1. They must still open and move.
import { describe, expect, it } from 'vitest';
import { MockNetworkProvider, SignatureTemplate, randomUtxo } from 'cashscript';
import { encodeCashAddress, hash160 } from '@bitauth/libauth';
import * as V from '../src/vault.js';

const key = (n: number) => new SignatureTemplate(new Uint8Array(32).fill(n));
const owner = key(1), home = key(2), panic = key(4);
const addr = (k: SignatureTemplate) => encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(k.publicKey) }).address;

describe('contract version 1 (vaults made before Nov 19)', () => {
  it('opens at its own address and can still spend, withdraw, cancel and move everything', async () => {
    const provider = new MockNetworkProvider();
    provider.addUtxo(addr(owner), randomUtxo({ satoshis: 2_000_000n, vout: 0 }));
    const genesis = V.pickGenesisUtxo(await provider.getUtxos(addr(owner)))!;
    const base = { ownerPk: owner.publicKey, homePk: home.publicKey, guardianPk: home.publicKey, panicPk: panic.publicKey, category: genesis.txid, allowance: 50_000n, waitBlocks: 432, fastBlocks: 6, refillBlocks: 144, evictBlocks: 1008 };
    const c = V.makeVault({ ...base, version: 1 }, provider);
    expect(c.address).not.toBe(V.makeVault(base, provider).address);
    expect(V.versionOf(c)).toBe(1);
    await V.buildCreate({ provider, contract: c, genesis, otherUtxos: [], userAddress: addr(owner), amount: 1_000_000n, unlocker: owner.unlockP2PKH() }).send();
    const main = async () => V.classify(await c.getUtxos(), base.category).find((x) => x.kind === 'main') as { kind: 'main'; utxo: any; state: V.MainState };
    let m = await main();
    await V.buildSpend({ contract: c, main: m.utxo, state: m.state, amount: 10_000n, to: addr(key(9)), owner, fresh: false, refillBlocks: 144 }).send();
    m = await main();
    expect(m.state.spent).toBe(10_000n);
    await V.buildStartWithdrawal({ contract: c, main: m.utxo, state: m.state, amount: 100_000n, to: addr(key(9)), owner }).send();
    const p = V.classify(await c.getUtxos(), base.category).find((x) => x.kind === 'pending')!;
    m = await main();
    await V.buildMerge({ contract: c, main: m.utxo, state: m.state, other: p.utxo, pk: home.publicKey, signer: home }).send();
    m = await main();
    await V.buildApprove({ contract: c, main: m.utxo, state: m.state, pk: home.publicKey, asHome: true, asGuardian: true, signer: home, what: 'recover' }).send();
    m = await main();
    const to = addr(key(21));
    await V.buildRecover({ contract: c, main: m.utxo, home, to }).send();
    expect((await provider.getUtxos(to)).reduce((a, u) => a + u.satoshis, 0n)).toBe(m.utxo.satoshis - V.VAULT_FEE);
  });
});
