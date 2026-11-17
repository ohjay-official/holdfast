import { describe, expect, it } from 'vitest';
import { binToHex, hash256, hexToBin } from '@bitauth/libauth';
import { FallbackNetworkProvider, type Backend } from '../src/provider.js';

const never = () => new Promise<never>(() => {});
function fake(over: Partial<Backend>): Backend {
  return {
    getUtxos: async () => [],
    getUtxosForLockingBytecode: async () => [],
    getBlockHeight: async () => 1,
    getRawTransaction: async () => '',
    sendRawTransaction: async () => 'ok',
    performRequest: async () => [],
    ...over,
  } as Backend;
}

describe('electrum fallback', () => {
  it('a server that connects but never answers is skipped after the timeout', async () => {
    const backends: Record<string, Backend> = { a: fake({ getBlockHeight: never }), b: fake({ getBlockHeight: async () => 42 }) };
    const switched: string[] = [];
    const p = new FallbackNetworkProvider('mainnet' as never, ['a', 'b'], { timeoutMs: 50, make: (h) => backends[h] });
    p.onSwitch = (h) => switched.push(h);
    expect(await p.getBlockHeight()).toBe(42);
    expect(switched).toEqual(['b']);
  });

  it('when every server fails, it ends with a clear error instead of hanging', async () => {
    const p = new FallbackNetworkProvider('mainnet' as never, ['a', 'b'], { timeoutMs: 30, make: () => fake({ getUtxos: never }) });
    await expect(p.getUtxos('x')).rejects.toThrow(/timed out/);
  });

  it('a real answer (a rejected transaction) is not retried on another server', async () => {
    let calls = 0;
    const p = new FallbackNetworkProvider('mainnet' as never, ['a', 'b'], {
      timeoutMs: 50,
      make: () => fake({ sendRawTransaction: async () => { calls++; throw new Error('Transaction inputs are missing or already spent: bad-txns-inputs-missingorspent'); } }),
    });
    await expect(p.sendRawTransaction('00')).rejects.toThrow(/missing/);
    expect(calls).toBe(1);
  });

  it('sending the same transaction twice (double tap, retry after a timeout) counts as sent, with its txid', async () => {
    const hex = '0200000000000000000000';
    const txid = binToHex(hash256(hexToBin(hex)).reverse());
    const p = new FallbackNetworkProvider('mainnet' as never, ['a'], {
      timeoutMs: 50,
      make: () => fake({ sendRawTransaction: async () => { throw new Error('Transaction has already been submitted: txn-already-known'); } }),
    });
    expect(await p.sendRawTransaction(hex)).toBe(txid);
  });
});
