// Every exploit from the Nov 19 security review, kept as a test that must now fail.
import { describe, expect, it } from 'vitest';
import { MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo } from 'cashscript';
import { encodeCashAddress, hash160 } from '@bitauth/libauth';
import * as V from '../src/vault.js';

const key = (n: number) => new SignatureTemplate(new Uint8Array(32).fill(n));
const owner = key(1), home = key(2), guardian = key(3), panic = key(4), stranger = key(9);
const addr = (k: SignatureTemplate) => encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(k.publicKey) }).address;
const ownerAddress = addr(owner);
const robber = addr(stranger);
const WAIT = 432, FAST = 6, REFILL = 144, EVICT = 1008;
const ALLOW = 50_000n;

async function setup(withGuardian = true) {
  const provider = new MockNetworkProvider();
  provider.addUtxo(ownerAddress, randomUtxo({ satoshis: 2_000_000n, vout: 0 }));
  const genesis = V.pickGenesisUtxo(await provider.getUtxos(ownerAddress))!;
  const params: V.VaultParams = {
    ownerPk: owner.publicKey, homePk: home.publicKey, guardianPk: withGuardian ? guardian.publicKey : home.publicKey, panicPk: panic.publicKey,
    category: genesis.txid, allowance: ALLOW, waitBlocks: WAIT, fastBlocks: FAST, refillBlocks: REFILL, evictBlocks: EVICT,
  };
  const contract = V.makeVault(params, provider);
  await V.buildCreate({ provider, contract, genesis, otherUtxos: [], userAddress: ownerAddress, amount: 1_000_000n, unlocker: owner.unlockP2PKH() }).send();
  return { provider, contract, params };
}
const coins = async (c: V.HoldfastContract, cat: string) => V.classify(await c.getUtxos(), cat);
async function main(c: V.HoldfastContract, cat: string) {
  const m = (await coins(c, cat)).find((x) => x.kind === 'main');
  if (!m || m.kind !== 'main') throw new Error('no main');
  return m;
}
const mainTok = (cat: string, s: V.MainState) => ({ category: cat, amount: 0n, nft: { capability: 'minting' as const, commitment: V.encodeMain(s) } });
const OPEN_RECOVER: V.MainState = { level: 0, spent: 0n, unfreezeHome: false, unfreezeGuardian: false, recoverHome: true, recoverGuardian: true };

describe('Nov 19 security review: every exploit is now refused', () => {
  it('H1: a guardian-replacement ticket unlocked with merged() cannot skip the week or rewrite the state', async () => {
    const { provider, contract, params } = await setup();
    let m = await main(contract, params.category);
    await V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: guardian.publicKey, signer: guardian, duress: false }).send();
    m = await main(contract, params.category);
    await V.buildStartEvict({ contract, main: m.utxo, state: m.state, owner, home }).send();
    const t = (await coins(contract, params.category)).find((c) => c.kind === 'ticket')!;
    m = await main(contract, params.category);
    await expect(
      new TransactionBuilder({ provider })
        .addInput(m.utxo as never, contract.unlock.evict(owner, home))
        .addInput(t.utxo as never, contract.unlock.merged())
        .addOutput({ to: contract.tokenAddress, amount: m.utxo.satoshis + t.utxo.satoshis - 3_600n, token: mainTok(params.category, OPEN_RECOVER) })
        .send(),
    ).rejects.toThrow();
    // Nor can it burn the vault while keeping the state.
    await expect(
      new TransactionBuilder({ provider })
        .addInput(m.utxo as never, contract.unlock.evict(owner, home))
        .addInput(t.utxo as never, contract.unlock.merged())
        .addOutput({ to: contract.tokenAddress, amount: 10_000n, token: mainTok(params.category, m.state) })
        .send(),
    ).rejects.toThrow();
  });

  it('H2: an allowance spend pays exactly its amount, and its fee counts against the allowance', async () => {
    const { provider, contract, params } = await setup();
    const m = await main(contract, params.category);
    const tb = new TransactionBuilder({ provider })
      .addInput(m.utxo as never, contract.unlock.spend(owner, 1n, false))
      .addOutput({ to: contract.tokenAddress, amount: m.utxo.satoshis - 2_501n, token: mainTok(params.category, { ...m.state, spent: m.state.spent + 1n }) })
      .addOutput({ to: robber, amount: 700n });
    await expect(tb.send()).rejects.toThrow();
    // Even reporting the full drop as used, the payment must equal the amount.
    const tb2 = new TransactionBuilder({ provider })
      .addInput(m.utxo as never, contract.unlock.spend(owner, 1n, false))
      .addOutput({ to: contract.tokenAddress, amount: m.utxo.satoshis - 2_501n, token: mainTok(params.category, { ...m.state, spent: 2_501n }) })
      .addOutput({ to: robber, amount: 700n });
    await expect(tb2.send()).rejects.toThrow();
  });

  it('H2: the phone cannot move or burn more than the allowance in a day, fees included', async () => {
    const { contract, params } = await setup();
    let m = await main(contract, params.category);
    let n = 0;
    for (; n < 100; n++) {
      try {
        await V.buildSpend({ contract, main: m.utxo, state: m.state, amount: 546n, to: robber, owner, fresh: false, refillBlocks: REFILL }).send();
      } catch { break; }
      m = await main(contract, params.category);
    }
    expect(1_000_000n - m.utxo.satoshis).toBeLessThanOrEqual(ALLOW);
    expect(m.state.spent).toBeLessThanOrEqual(ALLOW);
  }, 200_000);

  it('start-and-cancel loops are bounded by the allowance too', async () => {
    const { contract, params } = await setup();
    let lost = 0n;
    for (let n = 0; n < 40; n++) {
      let m = await main(contract, params.category);
      try {
        await V.buildStartWithdrawal({ contract, main: m.utxo, state: m.state, amount: 10_000n, to: robber, owner }).send();
      } catch { break; }
      const p = (await coins(contract, params.category)).find((c) => c.kind === 'pending')!;
      m = await main(contract, params.category);
      await V.buildMerge({ contract, main: m.utxo, state: m.state, other: p.utxo, pk: owner.publicKey, signer: owner }).send();
    }
    lost = 1_000_000n - (await main(contract, params.category)).utxo.satoshis;
    // Each start's fee came out of the allowance; each cancel's fee came out of the withdrawal.
    expect(lost).toBeLessThanOrEqual(ALLOW + 40n * V.MERGE_FEE);
    expect((await main(contract, params.category)).state.spent).toBeLessThanOrEqual(ALLOW);
  }, 200_000);

  it('M1: a merge must bring in a coin from this vault and cannot take its fee from the vault', async () => {
    const { provider, contract, params } = await setup();
    let m = await main(contract, params.category);
    provider.addUtxo(robber, randomUtxo({ satoshis: 546n }));
    const dust = (await provider.getUtxos(robber)).find((u) => u.satoshis === 546n)!;
    await expect(
      new TransactionBuilder({ provider })
        .addInput(m.utxo as never, contract.unlock.merge(owner.publicKey, owner))
        .addInput(dust, stranger.unlockP2PKH())
        .addOutput({ to: contract.tokenAddress, amount: m.utxo.satoshis + 546n - 4_000n, token: mainTok(params.category, m.state) })
        .send(),
    ).rejects.toThrow();
    // A small deposit at the vault address can't be merged at the vault's expense either.
    provider.addUtxo(contract.address, randomUtxo({ satoshis: 600n }));
    const dep = (await coins(contract, params.category)).find((c) => c.kind === 'deposit')!;
    m = await main(contract, params.category);
    await expect(V.buildMerge({ contract, main: m.utxo, state: m.state, other: dep.utxo, pk: owner.publicKey, signer: owner }).send()).rejects.toThrow();
  });

  it('M1: the phone and the panic key cannot touch a fully frozen vault', async () => {
    const { provider, contract, params } = await setup();
    let m = await main(contract, params.category);
    await V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: home.publicKey, signer: home, duress: false }).send();
    provider.addUtxo(contract.address, randomUtxo({ satoshis: 50_000n }));
    const dep = (await coins(contract, params.category)).find((c) => c.kind === 'deposit')!;
    m = await main(contract, params.category);
    await expect(V.buildMerge({ contract, main: m.utxo, state: m.state, other: dep.utxo, pk: owner.publicKey, signer: owner }).send()).rejects.toThrow();
    await expect(V.buildMerge({ contract, main: m.utxo, state: m.state, other: dep.utxo, pk: panic.publicKey, signer: panic }).send()).rejects.toThrow();
    // The home code and the guardian still can.
    await V.buildMerge({ contract, main: m.utxo, state: m.state, other: dep.utxo, pk: guardian.publicKey, signer: guardian }).send();
  });

  it('M2: repeating an approval that changes nothing is refused', async () => {
    const { contract, params } = await setup();
    let m = await main(contract, params.category);
    await V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: guardian.publicKey, signer: guardian, duress: false }).send();
    m = await main(contract, params.category);
    await V.buildApprove({ contract, main: m.utxo, state: m.state, pk: guardian.publicKey, asHome: false, asGuardian: true, signer: guardian, what: 'recover' }).send();
    m = await main(contract, params.category);
    await expect(
      V.buildApprove({ contract, main: m.utxo, state: m.state, pk: guardian.publicKey, asHome: false, asGuardian: true, signer: guardian, what: 'recover' }).send(),
    ).rejects.toThrow();
  });

  it('M4: only the home code can merge (destroy) a guardian-replacement ticket', async () => {
    const { contract, params } = await setup();
    let m = await main(contract, params.category);
    await V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: guardian.publicKey, signer: guardian, duress: false }).send();
    m = await main(contract, params.category);
    await V.buildStartEvict({ contract, main: m.utxo, state: m.state, owner, home }).send();
    const t = (await coins(contract, params.category)).find((c) => c.kind === 'ticket')!;
    m = await main(contract, params.category);
    await expect(V.buildMerge({ contract, main: m.utxo, state: m.state, other: t.utxo, pk: guardian.publicKey, signer: guardian }).send()).rejects.toThrow();
    await expect(V.buildMerge({ contract, main: m.utxo, state: m.state, other: t.utxo, pk: owner.publicKey, signer: owner }).send()).rejects.toThrow();
  });

  it('L2: recovery approvals only count during a full freeze, and unfreezing clears them', async () => {
    const { provider, contract, params } = await setup();
    let m = await main(contract, params.category);
    // An open-vault approval is refused outright.
    await expect(
      V.buildApprove({ contract, main: m.utxo, state: m.state, pk: guardian.publicKey, asHome: false, asGuardian: true, signer: guardian, what: 'recover' }).send(),
    ).rejects.toThrow();
    await V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: guardian.publicKey, signer: guardian, duress: false }).send();
    m = await main(contract, params.category);
    await V.buildApprove({ contract, main: m.utxo, state: m.state, pk: guardian.publicKey, asHome: false, asGuardian: true, signer: guardian, what: 'recover' }).send();
    for (const [pk, signer, asHome, asGuardian] of [[home.publicKey, home, true, false], [guardian.publicKey, guardian, false, true]] as const) {
      m = await main(contract, params.category);
      await V.buildApprove({ contract, main: m.utxo, state: m.state, pk, asHome, asGuardian, signer, what: 'unfreeze' }).send();
    }
    m = await main(contract, params.category);
    expect(m.state.level).toBe(0);
    expect(m.state.recoverGuardian).toBe(false);
    m = await main(contract, params.category);
    await V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: home.publicKey, signer: home, duress: false }).send();
    m = await main(contract, params.category);
    await V.buildApprove({ contract, main: m.utxo, state: m.state, pk: home.publicKey, asHome: true, asGuardian: false, signer: home, what: 'recover' }).send();
    m = await main(contract, params.category);
    await expect(V.buildRecover({ contract, main: m.utxo, home, to: robber }).send()).rejects.toThrow();
    expect(await provider.getUtxos(robber)).toHaveLength(0);
  });

  it('no guardian: a forced home code cannot empty the vault on the spot', async () => {
    const { contract, params } = await setup(false);
    let m = await main(contract, params.category);
    await V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: home.publicKey, signer: home, duress: false }).send();
    m = await main(contract, params.category);
    await V.buildApprove({ contract, main: m.utxo, state: m.state, pk: home.publicKey, asHome: true, asGuardian: true, signer: home, what: 'recover' }).send();
    m = await main(contract, params.category);
    await expect(V.buildRecover({ contract, main: m.utxo, home, to: robber }).send()).rejects.toThrow();
    await expect(V.buildRecover({ contract, main: m.utxo, home, to: robber, waitBlocks: WAIT - 1 }).send()).rejects.toThrow();
  });

  it('release fees are capped at the 2,000 sats the app pays', async () => {
    const { provider, contract, params } = await setup();
    let m = await main(contract, params.category);
    await V.buildStartWithdrawal({ contract, main: m.utxo, state: m.state, amount: 100_000n, to: robber, owner }).send();
    const p = (await coins(contract, params.category)).find((c) => c.kind === 'pending')!;
    await expect(
      new TransactionBuilder({ provider })
        .addInput(p.utxo as never, contract.unlock.release(), { sequence: WAIT })
        .addOutput({ to: robber, amount: 100_000n - 2_500n })
        .send(),
    ).rejects.toThrow();
    await V.buildRelease({ contract, pending: p.utxo, to: robber, fast: false, waitBlocks: WAIT, fastBlocks: FAST }).send();
  });
  it('round 2: with no guardian the home key cannot fast-approve a withdrawal', async () => {
    const { contract, params } = await setup(false);
    const m = await main(contract, params.category);
    await V.buildStartWithdrawal({ contract, main: m.utxo, state: m.state, amount: 900_000n, to: robber, owner }).send();
    const p = (await coins(contract, params.category)).find((c) => c.kind === 'pending')!;
    await expect(V.buildApproveFast({ contract, pending: p.utxo, to: robber, guardian: home }).send()).rejects.toThrow();
  });

  it('round 2: freeze and unfreeze in a loop burns at most about a day of allowance', async () => {
    const { contract, params } = await setup(false);
    let cycles = 0;
    for (; cycles < 40; cycles++) {
      let m = await main(contract, params.category);
      try {
        await V.buildFreeze({ contract, main: m.utxo, state: m.state, pk: home.publicKey, signer: home, duress: false }).send();
        m = await main(contract, params.category);
        await V.buildApprove({ contract, main: m.utxo, state: m.state, pk: home.publicKey, asHome: true, asGuardian: true, signer: home, what: 'unfreeze' }).send();
      } catch { break; }
    }
    const lost = 1_000_000n - (await main(contract, params.category)).utxo.satoshis;
    expect(cycles).toBeLessThan(40);
    expect(lost).toBeLessThanOrEqual(ALLOW + V.VAULT_FEE);
  }, 200_000);

  it('round 2: guardian-replacement tickets cannot be looped to burn the vault', async () => {
    const { contract, params } = await setup();
    let loops = 0;
    for (; loops < 40; loops++) {
      let m = await main(contract, params.category);
      try {
        await V.buildStartEvict({ contract, main: m.utxo, state: m.state, owner, home }).send();
      } catch { break; }
      const t = (await coins(contract, params.category)).find((c) => c.kind === 'ticket')!;
      m = await main(contract, params.category);
      // Merging the ticket back pays its fee from the ticket, never from the vault coin.
      const before = m.utxo.satoshis;
      await V.buildMerge({ contract, main: m.utxo, state: m.state, other: t.utxo, pk: home.publicKey, signer: home }).send();
      expect((await main(contract, params.category)).utxo.satoshis).toBeGreaterThanOrEqual(before);
    }
    const m = await main(contract, params.category);
    expect(loops).toBeLessThan(40);
    expect(m.state.spent).toBeLessThanOrEqual(ALLOW);
  }, 200_000);
});
