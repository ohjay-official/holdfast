// A NetworkProvider that tries several Electrum servers in turn, so one server
// being down, unreachable or silent doesn't stop the page from reading the chain.

import { binToHex, hash256, hexToBin } from '@bitauth/libauth';
import {
  ElectrumNetworkProvider,
  type Network,
  type NetworkProvider,
  type SpendableUtxo,
} from 'cashscript';

/** The calls we make on one server. ElectrumNetworkProvider in the app; a fake in tests. */
export type Backend = Pick<
  ElectrumNetworkProvider,
  'getUtxos' | 'getUtxosForLockingBytecode' | 'getBlockHeight' | 'getRawTransaction' | 'sendRawTransaction' | 'performRequest'
>;

/** How long one server gets to answer before the next one is tried. */
export const SERVER_TIMEOUT_MS = 10_000;

const CONNECTION_PROBLEM = /connect|websocket|timeout|timed out|network|closed|1006/i;
const ALREADY_SENT = /already been submitted|txn-already-known|txn-already-in-mempool|transaction already in block chain/i;

/** The txid of a raw transaction. */
export function txidOf(txHex: string): string {
  return binToHex(hash256(hexToBin(txHex)).reverse());
}

export class FallbackNetworkProvider implements NetworkProvider {
  readonly network: Network;
  private providers: { host: string; p: Backend }[];
  private current = 0;
  private timeoutMs: number;
  onSwitch?: (host: string) => void;

  constructor(network: Network, hosts: string[], opts: { timeoutMs?: number; make?: (host: string) => Backend } = {}) {
    if (hosts.length === 0) throw new Error('Need at least one Electrum server');
    this.network = network;
    this.timeoutMs = opts.timeoutMs ?? SERVER_TIMEOUT_MS;
    const make = opts.make ?? ((host: string) => new ElectrumNetworkProvider(network, { hostname: host }));
    this.providers = hosts.map((host) => ({ host, p: make(host) }));
  }

  get host(): string {
    return this.providers[this.current].host;
  }

  private async attempt<T>(fn: (p: Backend) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < this.providers.length; i++) {
      const idx = (this.current + i) % this.providers.length;
      const { host, p } = this.providers[idx];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A server that connects but never answers would otherwise hang here
        // forever and the other servers would never be tried.
        const out = await Promise.race([
          fn(p),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error(`${host} timed out after ${Math.round(this.timeoutMs / 1000)} seconds`)), this.timeoutMs);
          }),
        ]);
        if (idx !== this.current) {
          this.current = idx;
          this.onSwitch?.(host);
        }
        return out;
      } catch (err) {
        lastErr = err;
        // Only fall through to the next server on connection problems, not on
        // real answers such as a rejected transaction.
        if (!CONNECTION_PROBLEM.test(String((err as Error)?.message ?? err))) throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  getUtxos(address: string): Promise<SpendableUtxo[]> {
    return this.attempt((p) => p.getUtxos(address));
  }

  getUtxosForLockingBytecode(lockingBytecode: Uint8Array | string): Promise<SpendableUtxo[]> {
    return this.attempt((p) => p.getUtxosForLockingBytecode(lockingBytecode));
  }

  getBlockHeight(): Promise<number> {
    return this.attempt((p) => p.getBlockHeight());
  }

  getRawTransaction(txid: string): Promise<string> {
    return this.attempt((p) => p.getRawTransaction(txid));
  }

  /**
   * Broadcast. Sending the same transaction again (a double tap, or a retry
   * after a server timed out but did relay it) is reported as sent, not as an error.
   */
  async sendRawTransaction(txHex: string): Promise<string> {
    try {
      return await this.attempt((p) => p.sendRawTransaction(txHex));
    } catch (err) {
      if (ALREADY_SENT.test(String((err as Error)?.message ?? err))) return txidOf(txHex);
      throw err;
    }
  }

  /**
   * A second opinion: the coins at an address and their heights, from a different server than the
   * one in use. One dishonest server could otherwise hide a waiting withdrawal. Null if no other
   * server answers in time.
   */
  async otherServerView(address: string): Promise<{ host: string; utxos: SpendableUtxo[]; heights: Map<string, number> } | null> {
    for (let i = 1; i < this.providers.length; i++) {
      const { host, p } = this.providers[(this.current + i) % this.providers.length];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`${host} timed out`)), this.timeoutMs);
        });
        const [utxos, rows] = await Promise.race([
          Promise.all([p.getUtxos(address), p.performRequest('blockchain.address.listunspent', address, 'include_tokens') as Promise<{ tx_hash: string; tx_pos: number; height: number }[]>]),
          timeout,
        ]);
        const heights = new Map<string, number>();
        for (const r of rows ?? []) heights.set(`${r.tx_hash}:${r.tx_pos}`, r.height > 0 ? r.height : 0);
        return { host, utxos, heights };
      } catch {
        // try the next one
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  /** Confirmation height of each unspent coin at an address ("txid:vout" to height, 0 if unconfirmed). */
  async heights(address: string): Promise<Map<string, number>> {
    const rows = (await this.attempt((p) =>
      p.performRequest('blockchain.address.listunspent', address, 'include_tokens'),
    )) as { tx_hash: string; tx_pos: number; height: number }[];
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(`${r.tx_hash}:${r.tx_pos}`, r.height > 0 ? r.height : 0);
    return m;
  }
}
