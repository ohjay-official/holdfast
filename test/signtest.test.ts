import { describe, expect, it } from 'vitest';
import {
  FailedRequireError,
  MockNetworkProvider,
  SignatureTemplate,
  placeholderP2PKHUnlocker,
  placeholderSignature,
  randomUtxo,
} from 'cashscript';
import { encodeCashAddress, hash160, stringify } from '@bitauth/libauth';
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

describe('WizardConnect request objects', () => {
  it('genesis builds with a placeholder P2PKH unlocker and survives JSON transport', async () => {
    const { provider, contract } = setup();
    provider.addUtxo(ownerAddress, randomUtxo({ satoshis: 100_000n, vout: 0 }));
    const userUtxos = await provider.getUtxos(ownerAddress);
    const { builder } = buildGenesis({
      provider,
      contract,
      userAddress: ownerAddress,
      userUtxos,
      unlocker: placeholderP2PKHUnlocker(ownerAddress),
    });
    const wc = builder.generateWcTransactionObject({ broadcast: false, userPrompt: 'test' });
    const wire = JSON.parse(stringify(wc));
    expect(wire.sourceOutputs).toHaveLength(1);
    expect(JSON.stringify(wire)).not.toMatch(/\d+n"/);
  });

  it('bump builds with a placeholder signature and carries contract info for the wallet', async () => {
    const { provider, contract, vault } = await createVault();
    const wc = buildBump({
      provider,
      contract,
      vaultUtxo: vault,
      unlocker: contract.unlock.bump(placeholderSignature()),
    }).generateWcTransactionObject({ broadcast: false, userPrompt: 'test' });
    expect(wc.sourceOutputs[0].contract?.abiFunction.name).toBe('bump');
    expect(wc.sourceOutputs[0].token?.nft?.capability).toBe('mutable');
  });
});
