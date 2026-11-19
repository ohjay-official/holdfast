import { describe, expect, it } from 'vitest';
import { MockNetworkProvider, SignatureTemplate, randomUtxo, type Utxo } from 'cashscript';
import { encodeCashAddress, hash160 } from '@bitauth/libauth';
import * as V from '../src/vault.js';

const key = (n: number) => new SignatureTemplate(new Uint8Array(32).fill(n));
const owner = key(1), home = key(2), guardian = key(3), panic = key(4), stranger = key(9);
const addr = (k: SignatureTemplate) => encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(k.publicKey) }).address;
const ownerAddress = addr(owner);
const robber = addr(stranger);

const WAIT = 432, FAST = 6, REFILL = 144, EVICT = 1008;
const ALLOW = 50_000n;

async function setup(noGuardian = false) {
  const provider = new MockNetworkProvider();
  provider.addUtxo(ownerAddress, randomUtxo({ satoshis: 2_000_000n, vout: 0 }));
  const utxos = await provider.getUtxos(ownerAddress);
  const genesis = V.pickGenesisUtxo(utxos)!;
  const params: V.VaultParams = {
    ownerPk: owner.publicKey, homePk: home.publicKey,
    guardianPk: noGuardian ? home.publicKey : guardian.publicKey, panicPk: panic.publicKey,
    category: genesis.txid, allowance: ALLOW, waitBlocks: WAIT, fastBlocks: FAST, refillBlocks: REFILL, evictBlocks: EVICT,
  };
  const contract = V.makeVault(params, provider);
  await V.buildCreate({ provider, contract, genesis, otherUtxos: [], userAddress: ownerAddress, amount: 1_000_000n, unlocker: owner.unlockP2PKH() }).send();
  return { provider, contract, params };
}

async function coins(c: V.HoldfastContract, category: string) {
  return V.classify(await c.getUtxos(), category);
}
async function main(c: V.HoldfastContract, category: string) {
  const m = (await coins(c, category)).find((x) => x.kind === 'main');
  if (!m || m.kind !== 'main') throw new Error('no main');
  return m;
}
async function pending(c: V.HoldfastContract, category: string) {
  return (await coins(c, category)).filter((x) => x.kind === 'pending') as Extract<V.VaultCoin, { kind: 'pending' }>[];
}

describe('state encoding', () => {
  it('round-trips', () => {
    const s: V.MainState = { level: 1, spent: 123_456n, unfreezeHome: true, unfreezeGuardian: false, recoverHome: false, recoverGuardian: true };
    expect(V.decodeMain(V.encodeMain(s))).toEqual(s);
    expect(V.encodeMain(V.OPEN)).toHaveLength(26);
  });
});

describe('vault contract', () => {
  it('creates a vault holding the deposit and an open state', async () => {
    const { contract, params } = await setup();
    const m = await main(contract, params.category);
    expect(m.utxo.satoshis).toBe(1_000_000n);
    expect(m.state).toEqual(V.OPEN);
  });

  it('phone spends within the allowance, not beyond', async () => {
    const { contract, params } = await setup();
    let m = await main(contract, params.category);
    await V.buildSpend({ contract, main: m.utxo, state: m.state, amount: 30_000n, to: robber, owner, fresh: false, refillBlocks: REFILL }).send();
    m = await main(contract, params.category);
    // The fee counts against the allowance too.
    expect(m.state.spent).toBe(30_000n + V.VAULT_FEE);
    await expect(
      V.buildSpend({ contract, main: m.utxo, state: m.state, amount: 30_000n, to: robber, owner, fresh: false, refillBlocks: REFILL }).send(),
    ).rejects.toThrow();
    // After a quiet day the window starts over.
    await V.buildSpend({ contract, main: m.utxo, state: m.state, amount: 50_000n - V.VAULT_FEE, to: robber, owner, fresh: true, refillBlocks: REFILL }).send();
    expect((await main(contract, params.category)).state.spent).toBe(50_000n);
  });

  it('a quiet-day spend without the wait is refused', async () => {
    const { contract, params } = await setup();
    const m = await main(contract, params.category);
    await expect(
      V.buildSpend({ contract, main: m.utxo, state: m.state, amount: 1_000n, to: robber, owner, fresh: true, refillBlocks: REFILL - 1 }).send(),
    ).rejects.toThrow();
  });

  it('only the owner key can spend', async () => {
    const { contract, params } = await setup();
    const m = await main(contract, params.category);
    await expect(
      V.buildSpend({ contract, main: m.utxo, state: m.state, amount: 1_000n, to: robber, owner: stranger, fresh: false, refillBlocks: REFILL }).send(),
    ).rejects.toThrow();
  });

  it('the robbery: withdrawal waits, release needs the full wait', async () => {
    const { contract, params } = await setup();
    const m = await main(contract, params.category);
    await V.buildStartWithdrawal({ contract, main: m.utxo, state: m.state, amount: 900_000n, to: robber, owner }).send();
    const [p] = await pending(contract, params.category);
    expect(p.utxo.satoshis).toBe(900_000n);
    expect(p.fast).toBe(false);
    await expect(V.buildRelease({ contract, pending: p.utxo, to: robber, fast: false, waitBlocks: WAIT - 1, fastBlocks: FAST }).send()).rejects.toThrow();
    // The fast lane needs the guardian's approval first.
    await expect(V.buildRelease({ contract, pending: p.utxo, to: robber, fast: true, waitBlocks: WAIT, fastBlocks: FAST }).send()).rejects.toThrow();
    // Release can't redirect the money.
    await expect(V.buildRelease({ contract, pending: p.utxo, to: ownerAddress, fast: false, waitBlocks: WAIT, fastBlocks: FAST }).send()).rejects.toThrow();
    await V.buildRelease({ contract, pending: p.utxo, to: robber, fast: false, waitBlocks: WAIT, fastBlocks: FAST }).send();
    expect(await pending(contract, params.category)).toHaveLength(0);
  });

  it('home code cancels the withdrawal and freezes', async () => {
    const { contract, params } = await setup();
    let m = await main(contract, params.category);
    await V.buildStartWithdrawal({ contract, main: m.utxo, state: m.state, amount: 900_000n, to: robber, owner }).send();
    const [p] = await pending(contract, params.category);
    m = await main(contract, params.category);
    await V.buildMerge({ contract, main: m.utxo, state: m.state, other: p.utxo, pk: home.publicKey, signer: home }).send();
    m = await main(contract, params.category);
    await V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: home.publicKey, signer: home, duress: false }).send();
    m = await main(contract, params.category);
    expect(m.state.level).toBe(2);
    expect(m.utxo.satoshis).toBe(1_000_000n - 2n * V.VAULT_FEE - V.MERGE_FEE);
    // Frozen: no spending, no new withdrawals.
    await expect(V.buildSpend({ contract, main: m.utxo, state: m.state, amount: 1_000n, to: robber, owner, fresh: false, refillBlocks: REFILL }).send()).rejects.toThrow();
    await expect(V.buildStartWithdrawal({ contract, main: m.utxo, state: m.state, amount: 10_000n, to: robber, owner }).send()).rejects.toThrow();
  });

  it('a stranger cannot merge, freeze or approve', async () => {
    const { contract, params } = await setup();
    const m = await main(contract, params.category);
    await expect(V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: stranger.publicKey, signer: stranger, duress: false }).send()).rejects.toThrow();
    await expect(V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: owner.publicKey, signer: owner, duress: false }).send()).rejects.toThrow();
    await expect(
      V.buildApprove({ contract, main: m.utxo, state: m.state, pk: stranger.publicKey, asHome: true, asGuardian: false, signer: stranger, what: 'recover' }).send(),
    ).rejects.toThrow();
  });

  it('duress freeze: allowance still spendable, withdrawals blocked', async () => {
    const { contract, params } = await setup();
    let m = await main(contract, params.category);
    await V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: panic.publicKey, signer: panic, duress: true }).send();
    m = await main(contract, params.category);
    expect(m.state.level).toBe(1);
    await V.buildSpend({ contract, main: m.utxo, state: m.state, amount: ALLOW - V.VAULT_FEE, to: robber, owner, fresh: false, refillBlocks: REFILL }).send();
    m = await main(contract, params.category);
    await expect(V.buildStartWithdrawal({ contract, main: m.utxo, state: m.state, amount: 10_000n, to: robber, owner }).send()).rejects.toThrow();
    // Guardian upgrades it to a full freeze.
    await V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: guardian.publicKey, signer: guardian, duress: false }).send();
    expect((await main(contract, params.category)).state.level).toBe(2);
  });

  it('unfreeze needs the home code and the guardian', async () => {
    const { contract, params } = await setup();
    let m = await main(contract, params.category);
    await V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: home.publicKey, signer: home, duress: false }).send();
    m = await main(contract, params.category);
    await V.buildApprove({ contract, main: m.utxo, state: m.state, pk: home.publicKey, asHome: true, asGuardian: false, signer: home, what: 'unfreeze' }).send();
    m = await main(contract, params.category);
    expect(m.state.level).toBe(2);
    expect(m.state.unfreezeHome).toBe(true);
    // The home code can't also claim the guardian's approval.
    await expect(
      V.buildApprove({ contract, main: m.utxo, state: m.state, pk: home.publicKey, asHome: true, asGuardian: true, signer: home, what: 'unfreeze' }).send(),
    ).rejects.toThrow();
    await V.buildApprove({ contract, main: m.utxo, state: m.state, pk: guardian.publicKey, asHome: false, asGuardian: true, signer: guardian, what: 'unfreeze' }).send();
    m = await main(contract, params.category);
    expect(m.state).toEqual({ ...V.OPEN, spent: 0n });
  });

  it('without a guardian, the home code unfreezes alone', async () => {
    const { contract, params } = await setup(true);
    let m = await main(contract, params.category);
    await V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: home.publicKey, signer: home, duress: false }).send();
    m = await main(contract, params.category);
    await V.buildApprove({ contract, main: m.utxo, state: m.state, pk: home.publicKey, asHome: true, asGuardian: true, signer: home, what: 'unfreeze' }).send();
    expect((await main(contract, params.category)).state.level).toBe(0);
  });

  it('recovery needs both approvals, then the home code moves everything', async () => {
    const { contract, params } = await setup();
    const newPhone = addr(key(5));
    let m = await main(contract, params.category);
    await expect(V.buildRecover({ contract, main: m.utxo, home, to: newPhone }).send()).rejects.toThrow();
    // Recovery approvals only count during a full freeze.
    await V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: home.publicKey, signer: home, duress: false }).send();
    m = await main(contract, params.category);
    await V.buildApprove({ contract, main: m.utxo, state: m.state, pk: home.publicKey, asHome: true, asGuardian: false, signer: home, what: 'recover' }).send();
    m = await main(contract, params.category);
    await expect(V.buildRecover({ contract, main: m.utxo, home, to: newPhone }).send()).rejects.toThrow();
    await V.buildApprove({ contract, main: m.utxo, state: m.state, pk: guardian.publicKey, asHome: false, asGuardian: true, signer: guardian, what: 'recover' }).send();
    m = await main(contract, params.category);
    // Only the home code can do the final move, not the phone.
    await expect(V.buildRecover({ contract, main: m.utxo, home: owner, to: robber }).send()).rejects.toThrow();
    await V.buildRecover({ contract, main: m.utxo, home, to: newPhone }).send();
    expect(await coins(contract, params.category)).toHaveLength(0);
  });

  it('guardian fast lane', async () => {
    const { contract, params } = await setup();
    const m = await main(contract, params.category);
    await V.buildStartWithdrawal({ contract, main: m.utxo, state: m.state, amount: 100_000n, to: ownerAddress, owner }).send();
    let [p] = await pending(contract, params.category);
    await expect(V.buildApproveFast({ contract, pending: p.utxo, to: ownerAddress, guardian: home }).send()).rejects.toThrow();
    await V.buildApproveFast({ contract, pending: p.utxo, to: ownerAddress, guardian }).send();
    [p] = await pending(contract, params.category);
    expect(p.fast).toBe(true);
    await expect(V.buildRelease({ contract, pending: p.utxo, to: ownerAddress, fast: true, waitBlocks: WAIT, fastBlocks: FAST - 1 }).send()).rejects.toThrow();
    await V.buildRelease({ contract, pending: p.utxo, to: ownerAddress, fast: true, waitBlocks: WAIT, fastBlocks: FAST }).send();
  });

  it('deposits are merged in; a stranger cannot steal them', async () => {
    const { provider, contract, params } = await setup();
    provider.addUtxo(contract.address, randomUtxo({ satoshis: 200_000n }));
    const dep = (await coins(contract, params.category)).find((c) => c.kind === 'deposit')!;
    const m = await main(contract, params.category);
    await expect(V.buildMerge({ contract, main: m.utxo, state: m.state, other: dep.utxo, pk: stranger.publicKey, signer: stranger }).send()).rejects.toThrow();
    await V.buildMerge({ contract, main: m.utxo, state: m.state, other: dep.utxo, pk: owner.publicKey, signer: owner }).send();
    expect((await main(contract, params.category)).utxo.satoshis).toBe(1_200_000n - V.MERGE_FEE);
  });

  it('replacing the guardian needs phone, home code and a ticket at least a week old', async () => {
    const { contract, params } = await setup();
    let m = await main(contract, params.category);
    await V.buildStartEvict({ contract, main: m.utxo, state: m.state, owner, home }).send();
    const t = (await coins(contract, params.category)).find((c) => c.kind === 'ticket')!;
    m = await main(contract, params.category);
    const to = addr(key(6));
    await expect(V.buildEvict({ contract, main: m.utxo, ticket: t.utxo, owner, home, to, evictBlocks: EVICT - 1 }).send()).rejects.toThrow();
    await expect(V.buildEvict({ contract, main: m.utxo, ticket: t.utxo, owner, home: guardian, to, evictBlocks: EVICT }).send()).rejects.toThrow();
    await V.buildEvict({ contract, main: m.utxo, ticket: t.utxo, owner, home, to, evictBlocks: EVICT }).send();
  });
});

describe('attacks', () => {
  it('spend cannot mint a second vault coin', async () => {
    const { contract, params } = await setup();
    const m = await main(contract, params.category);
    const tb = V.buildSpend({ contract, main: m.utxo, state: m.state, amount: 10_000n, to: robber, owner, fresh: false, refillBlocks: REFILL });
    tb.addOutput({
      to: contract.tokenAddress, amount: 1_000n,
      token: { category: params.category, amount: 0n, nft: { capability: 'minting', commitment: V.encodeMain(V.OPEN) } },
    });
    await expect(tb.send()).rejects.toThrow();
  });

  it('a release cannot keep the withdrawal token alive', async () => {
    const { contract, params } = await setup();
    const m = await main(contract, params.category);
    await V.buildStartWithdrawal({ contract, main: m.utxo, state: m.state, amount: 100_000n, to: robber, owner }).send();
    const [p] = await pending(contract, params.category);
    const tb = V.buildRelease({ contract, pending: p.utxo, to: robber, fast: false, waitBlocks: WAIT, fastBlocks: FAST });
    tb.addOutput({
      to: contract.tokenAddress, amount: 1_000n,
      token: { category: params.category, amount: 0n, nft: { capability: 'mutable', commitment: V.encodePending(robber, true) } },
    });
    await expect(tb.send()).rejects.toThrow();
  });

  it('the ticket cannot dodge its age check through merged()', async () => {
    const { contract, params } = await setup();
    let m = await main(contract, params.category);
    await V.buildStartEvict({ contract, main: m.utxo, state: m.state, owner, home }).send();
    const t = (await coins(contract, params.category)).find((c) => c.kind === 'ticket')! as { utxo: Utxo };
    m = await main(contract, params.category);
    const { TransactionBuilder } = await import('cashscript');
    const tb = new TransactionBuilder({ provider: contract.provider })
      .addInput(m.utxo as never, contract.unlock.evict(owner, home))
      .addInput(t.utxo as never, contract.unlock.merged())
      .addOutput({ to: robber, amount: m.utxo.satoshis - 2_000n });
    await expect(tb.send()).rejects.toThrow();
  });
});
