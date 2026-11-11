import { describe, expect, it } from 'vitest';
import {
  FailedRequireError,
  MockNetworkProvider,
  SignatureTemplate,
  placeholderP2PKHUnlocker,
  randomUtxo,
} from 'cashscript';
import { encodeCashAddress, hash160 } from '@bitauth/libauth';
import { COSIGN_SATS, buildCoSpend, buildFund, findCoSignUtxo, makeCoSignContract } from '../src/cosigntest.js';
import { toRelaySignRequest } from '../src/relay.js';
import { verifySigned, walletSign } from './wallet-sim.js';

const ownerKey = new Uint8Array(32).fill(7);
const owner = new SignatureTemplate(ownerKey);
const ownerAddress = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(owner.publicKey) }).address;
const homeKey = new Uint8Array(32).fill(3);
const homePk = new SignatureTemplate(homeKey).publicKey;
const strangerKey = new Uint8Array(32).fill(9);

async function funded() {
  const provider = new MockNetworkProvider();
  const contract = makeCoSignContract(owner.publicKey, homePk, provider);
  provider.addUtxo(ownerAddress, randomUtxo({ satoshis: 100_000n }));
  await buildFund({
    provider,
    contract,
    userAddress: ownerAddress,
    userUtxos: await provider.getUtxos(ownerAddress),
    unlocker: owner.unlockP2PKH(),
  }).send();
  const utxo = findCoSignUtxo(await contract.getUtxos())!;
  return { provider, contract, utxo };
}

describe('two-key test contract', () => {
  it('fund puts COSIGN_SATS into the contract', async () => {
    const { utxo } = await funded();
    expect(utxo.satoshis).toBe(COSIGN_SATS);
  });

  it('spends with the home key and the owner key', async () => {
    const { provider, contract, utxo } = await funded();
    await buildCoSpend({ provider, contract, utxo, homeKey, userAddress: ownerAddress, ownerSig: owner }).send();
    expect(await contract.getUtxos()).toHaveLength(0);
  });

  it('rejects a wrong home key', async () => {
    const { provider, contract, utxo } = await funded();
    await expect(
      buildCoSpend({ provider, contract, utxo, homeKey: strangerKey, userAddress: ownerAddress, ownerSig: owner }).send(),
    ).rejects.toThrow(FailedRequireError);
  });

  it('rejects a wrong owner key', async () => {
    const { provider, contract, utxo } = await funded();
    await expect(
      buildCoSpend({
        provider,
        contract,
        utxo,
        homeKey,
        userAddress: ownerAddress,
        ownerSig: new SignatureTemplate(strangerKey),
      }).send(),
    ).rejects.toThrow(FailedRequireError);
  });
});

describe('two-key sign request', () => {
  async function coRequest() {
    const ctx = await funded();
    const builder = buildCoSpend({ ...ctx, homeKey, userAddress: ownerAddress });
    const request = toRelaySignRequest(builder.generateWcTransactionObject({ broadcast: false, userPrompt: 'E' }));
    return { ...ctx, request };
  }

  it('carries the page signature and exactly one placeholder for the wallet', async () => {
    const { request } = await coRequest();
    const unlocking = request.sourceOutputs[0].unlockingBytecode;
    expect(unlocking.split('41' + '00'.repeat(65)).length - 1).toBe(1);
  });

  it('a wallet adds its signature and the result passes the BCH VM', async () => {
    const { provider, contract, request } = await coRequest();
    const signed = walletSign(request, [[0, 'receive', 0]], ownerKey);
    expect(verifySigned(signed.signedTransaction, signed.sourceOutputs)).toBe(true);
    await provider.sendRawTransaction(signed.signedTransaction);
    expect(await contract.getUtxos()).toHaveLength(0);
  });

  it('the wrong wallet cannot complete it', async () => {
    const { request } = await coRequest();
    const signed = walletSign(request, [[0, 'receive', 0]], strangerKey);
    expect(verifySigned(signed.signedTransaction, signed.sourceOutputs)).not.toBe(true);
  });

  it('the funding request is signable by the wallet', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeCoSignContract(owner.publicKey, homePk, provider);
    provider.addUtxo(ownerAddress, randomUtxo({ satoshis: 100_000n }));
    const fund = buildFund({
      provider,
      contract,
      userAddress: ownerAddress,
      userUtxos: await provider.getUtxos(ownerAddress),
      unlocker: placeholderP2PKHUnlocker(ownerAddress),
    });
    const req = toRelaySignRequest(fund.generateWcTransactionObject({ broadcast: false }));
    const signed = walletSign(req, req.sourceOutputs.map((_, i) => [i, 'receive', 0] as [number, string, number]), ownerKey);
    expect(verifySigned(signed.signedTransaction, signed.sourceOutputs)).toBe(true);
  });
});
