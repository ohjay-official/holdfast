import { describe, expect, it } from 'vitest';
import {
  FailedRequireError,
  MockNetworkProvider,
  SignatureTemplate,
  placeholderP2PKHUnlocker,
  placeholderSignature,
  randomUtxo,
} from 'cashscript';
import { decodeTransaction, encodeCashAddress, hash160, hexToBin } from '@bitauth/libauth';
import { toRelaySignRequest } from '../src/relay.js';
import { verifySigned, walletSign } from './wallet-sim.js';
import {
  VAULT_FEE,
  VAULT_SATS,
  buildBump,
  buildGenesis,
  buildPrepare,
  buildWithdraw,
  counterHex,
  findVaultUtxo,
  makeContract,
  readCounter,
} from '../src/signtest.js';

const ownerKey = new Uint8Array(32).fill(7);
const owner = new SignatureTemplate(ownerKey);
const ownerPk = owner.publicKey;
const ownerAddress = encodeCashAddress({
  prefix: 'bchtest',
  type: 'p2pkh',
  payload: hash160(ownerPk),
}).address;

const strangerKey = new Uint8Array(32).fill(9);
const stranger = new SignatureTemplate(strangerKey);

function setup() {
  const provider = new MockNetworkProvider();
  const contract = makeContract(ownerPk, provider);
  return { provider, contract };
}

async function createVault() {
  const ctx = setup();
  ctx.provider.addUtxo(ownerAddress, randomUtxo({ satoshis: 100_000n, vout: 0 }));
  const userUtxos = await ctx.provider.getUtxos(ownerAddress);
  const { builder, category } = buildGenesis({
    ...ctx,
    userAddress: ownerAddress,
    userUtxos,
    unlocker: owner.unlockP2PKH(),
  });
  await builder.send();
  const vault = findVaultUtxo(await ctx.contract.getUtxos(), category)!;
  return { ...ctx, category, vault };
}

describe('counter encoding', () => {
  it('round-trips', () => {
    for (const n of [0, 1, 255, 256, 65_536, 2_000_000]) expect(readCounter(counterHex(n))).toBe(n);
    expect(counterHex(1)).toBe('01000000');
  });
});

describe('genesis', () => {
  it('mints one mutable NFT with counter 0 into the vault', async () => {
    const { vault, category } = await createVault();
    expect(vault.satoshis).toBe(VAULT_SATS);
    expect(vault.token?.category).toBe(category);
    expect(vault.token?.nft).toEqual({ capability: 'mutable', commitment: '00000000' });
  });

  it('refuses when no coin sits at output index 0', async () => {
    const { provider, contract } = setup();
    provider.addUtxo(ownerAddress, randomUtxo({ satoshis: 100_000n, vout: 3 }));
    const userUtxos = await provider.getUtxos(ownerAddress);
    expect(() =>
      buildGenesis({ provider, contract, userAddress: ownerAddress, userUtxos, unlocker: owner.unlockP2PKH() }),
    ).toThrow(/index 0/);
  });

  it('prepare turns a coin at another index into one at index 0', async () => {
    const { provider } = setup();
    provider.addUtxo(ownerAddress, randomUtxo({ satoshis: 100_000n, vout: 3 }));
    const userUtxos = await provider.getUtxos(ownerAddress);
    await buildPrepare({ provider, userAddress: ownerAddress, userUtxos, unlocker: owner.unlockP2PKH() }).send();
    const after = await provider.getUtxos(ownerAddress);
    expect(after.some((u) => u.vout === 0)).toBe(true);
  });
});

describe('bump', () => {
  it('owner can bump: counter goes 0 to 1 to 2, fee stays under the cap', async () => {
    const { provider, contract, category } = await createVault();
    for (const expected of [1, 2]) {
      const vault = findVaultUtxo(await contract.getUtxos(), category)!;
      await buildBump({ provider, contract, vaultUtxo: vault, unlocker: contract.unlock.bump(owner) }).send();
      const next = findVaultUtxo(await contract.getUtxos(), category)!;
      expect(readCounter(next.token!.nft!.commitment)).toBe(expected);
      expect(next.satoshis).toBe(vault.satoshis - VAULT_FEE);
    }
  });

  it('a stranger cannot bump', async () => {
    const { provider, contract, vault } = await createVault();
    const tx = buildBump({ provider, contract, vaultUtxo: vault, unlocker: contract.unlock.bump(stranger) });
    await expect(tx.send()).rejects.toThrow(FailedRequireError);
  });

  it('rejects skipping the counter ahead', async () => {
    const { provider, contract, vault } = await createVault();
    const { TransactionBuilder } = await import('cashscript');
    const tx = new TransactionBuilder({ provider })
      .addInput(vault, contract.unlock.bump(owner))
      .addOutput({
        to: contract.tokenAddress,
        amount: vault.satoshis - VAULT_FEE,
        token: { amount: 0n, category: vault.token!.category, nft: { capability: 'mutable', commitment: counterHex(5) } },
      });
    await expect(tx.send()).rejects.toThrow(FailedRequireError);
  });

  it('rejects a fee above the 2,000 sat cap', async () => {
    const { provider, contract, vault } = await createVault();
    const { TransactionBuilder } = await import('cashscript');
    const tx = new TransactionBuilder({ provider })
      .addInput(vault, contract.unlock.bump(owner))
      .addOutput({
        to: contract.tokenAddress,
        amount: vault.satoshis - 2_001n,
        token: { amount: 0n, category: vault.token!.category, nft: { capability: 'mutable', commitment: counterHex(1) } },
      });
    await expect(tx.send()).rejects.toThrow(FailedRequireError);
  });

  it('rejects sending the vault anywhere else', async () => {
    const { provider, contract, vault } = await createVault();
    const { TransactionBuilder } = await import('cashscript');
    const strangerTokenAddress = encodeCashAddress({
      prefix: 'bchtest',
      type: 'p2pkhWithTokens',
      payload: hash160(stranger.publicKey),
    }).address;
    const tx = new TransactionBuilder({ provider })
      .addInput(vault, contract.unlock.bump(owner))
      .addOutput({
        to: strangerTokenAddress,
        amount: vault.satoshis - VAULT_FEE,
        token: { amount: 0n, category: vault.token!.category, nft: { capability: 'mutable', commitment: counterHex(1) } },
      });
    await expect(tx.send()).rejects.toThrow(FailedRequireError);
  });

  it('bumpAfterAge builds with sequence 1 on the vault input', async () => {
    const { provider, contract, vault } = await createVault();
    const tx = buildBump({
      provider,
      contract,
      vaultUtxo: vault,
      unlocker: contract.unlock.bumpAfterAge(owner),
      afterAge: true,
    });
    // The mock network does not track confirmation ages, so we check the sequence and that it evaluates.
    expect(tx.inputs[0].options?.sequence).toBe(1);
    await tx.send();
  });
});

describe('withdraw', () => {
  it('owner takes the coins back', async () => {
    const { provider, contract, vault } = await createVault();
    await buildWithdraw({ provider, vaultUtxo: vault, unlocker: contract.unlock.withdraw(owner), userAddress: ownerAddress }).send();
    expect(await contract.getUtxos()).toHaveLength(0);
  });

  it('a stranger cannot withdraw', async () => {
    const { provider, contract, vault } = await createVault();
    const tx = buildWithdraw({ provider, vaultUtxo: vault, unlocker: contract.unlock.withdraw(stranger), userAddress: ownerAddress });
    await expect(tx.send()).rejects.toThrow(FailedRequireError);
  });
});

describe('WizardConnect sign requests', () => {
  const walletPaths = (n: number) => Array.from({ length: n }, (_, i) => [i, 'receive', 0] as [number, string, number]);

  async function genesisRequest() {
    const { provider, contract } = setup();
    provider.addUtxo(ownerAddress, randomUtxo({ satoshis: 100_000n, vout: 0 }));
    const userUtxos = await provider.getUtxos(ownerAddress);
    const { builder, category } = buildGenesis({
      provider,
      contract,
      userAddress: ownerAddress,
      userUtxos,
      unlocker: placeholderP2PKHUnlocker(ownerAddress),
    });
    const request = toRelaySignRequest(builder.generateWcTransactionObject({ broadcast: false, userPrompt: 'test' }));
    return { provider, contract, builder, category, request };
  }

  it('sends the unsigned transaction as hex, which is what wallets decode', async () => {
    const { builder, request } = await genesisRequest();
    expect(typeof request.transaction).toBe('string');
    expect(request.transaction).toMatch(/^[0-9a-f]+$/);
    expect(request.transaction).toBe(builder.build());
    const decoded = decodeTransaction(hexToBin(request.transaction));
    expect(typeof decoded).not.toBe('string');
  });

  it('serializes source outputs as hex and bigint strings that survive JSON transport', async () => {
    const { request } = await genesisRequest();
    const wire = JSON.parse(JSON.stringify(request));
    expect(wire).toEqual(request);
    const so = wire.sourceOutputs[0];
    expect(so.valueSatoshis).toBe('<bigint: 100000n>');
    expect(so.unlockingBytecode).toBe('');
    expect(so.lockingBytecode).toMatch(/^76a914[0-9a-f]{40}88ac$/);
  });

  it('a wallet can sign the genesis request and the result passes the BCH VM', async () => {
    const { provider, contract, category, request } = await genesisRequest();
    const { signedTransaction, sourceOutputs } = walletSign(request, walletPaths(request.sourceOutputs.length), ownerKey);
    expect(verifySigned(signedTransaction, sourceOutputs)).toBe(true);
    await provider.sendRawTransaction(signedTransaction);
    expect(findVaultUtxo(await contract.getUtxos(), category)?.token?.nft?.commitment).toBe(counterHex(0));
  });

  it('a wallet can fill the contract signature for bump, bumpAfterAge and withdraw', async () => {
    const { provider, contract, category, vault } = await createVault();
    const paths: [number, string, number][] = [[0, 'receive', 0]];

    const bump = toRelaySignRequest(
      buildBump({ provider, contract, vaultUtxo: vault, unlocker: contract.unlock.bump(placeholderSignature()) })
        .generateWcTransactionObject({ broadcast: false, userPrompt: 'bump' }),
    );
    expect(bump.sourceOutputs[0].contract?.redeemScript).toMatch(/^[0-9a-f]+$/);
    let signed = walletSign(bump, paths, ownerKey);
    expect(verifySigned(signed.signedTransaction, signed.sourceOutputs)).toBe(true);
    await provider.sendRawTransaction(signed.signedTransaction);
    const v1 = findVaultUtxo(await contract.getUtxos(), category)!;
    expect(v1.token?.nft?.commitment).toBe(counterHex(1));

    const aged = toRelaySignRequest(
      buildBump({
        provider,
        contract,
        vaultUtxo: v1,
        unlocker: contract.unlock.bumpAfterAge(placeholderSignature()),
        afterAge: true,
      }).generateWcTransactionObject({ broadcast: false, userPrompt: 'aged' }),
    );
    expect(aged.sourceOutputs[0].sequenceNumber).toBe(1);
    signed = walletSign(aged, paths, ownerKey);
    expect(verifySigned(signed.signedTransaction, signed.sourceOutputs)).toBe(true);
    await provider.sendRawTransaction(signed.signedTransaction);
    const v2 = findVaultUtxo(await contract.getUtxos(), category)!;
    expect(v2.token?.nft?.commitment).toBe(counterHex(2));

    const withdraw = toRelaySignRequest(
      buildWithdraw({
        provider,
        vaultUtxo: v2,
        userAddress: ownerAddress,
        unlocker: contract.unlock.withdraw(placeholderSignature()),
      }).generateWcTransactionObject({ broadcast: false, userPrompt: 'withdraw' }),
    );
    signed = walletSign(withdraw, paths, ownerKey);
    expect(verifySigned(signed.signedTransaction, signed.sourceOutputs)).toBe(true);
  });

  it('a signature from the wrong key fails the VM', async () => {
    const { provider, contract, vault } = await createVault();
    const req = toRelaySignRequest(
      buildBump({ provider, contract, vaultUtxo: vault, unlocker: contract.unlock.bump(placeholderSignature()) })
        .generateWcTransactionObject({ broadcast: false, userPrompt: 'bump' }),
    );
    const signed = walletSign(req, [[0, 'receive', 0]], strangerKey);
    expect(verifySigned(signed.signedTransaction, signed.sourceOutputs)).not.toBe(true);
  });
});
