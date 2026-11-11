// A NetworkProvider that tries several Electrum servers in turn, so one server
// being down or unreachable doesn't stop the page from reading the chain.

import {
  ElectrumNetworkProvider,
  type Network,
  type NetworkProvider,
  type SpendableUtxo,
} from 'cashscript';

export class FallbackNetworkProvider implements NetworkProvider {
  readonly network: Network;
  private providers: { host: string; p: ElectrumNetworkProvider }[];
  private current = 0;
  onSwitch?: (host: string) => void;

  constructor(network: Network, hosts: string[]) {
    if (hosts.length === 0) throw new Error('Need at least one Electrum server');
    this.network = network;
    this.providers = hosts.map((host) => ({ host, p: new ElectrumNetworkProvider(network, { hostname: host }) }));
  }

  get host(): string {
    return this.providers[this.current].host;
  }

  private async attempt<T>(fn: (p: ElectrumNetworkProvider) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < this.providers.length; i++) {
      const idx = (this.current + i) % this.providers.length;
      try {
        const out = await fn(this.providers[idx].p);
        if (idx !== this.current) {
          this.current = idx;
          this.onSwitch?.(this.providers[idx].host);
        }
        return out;
      } catch (err) {
        lastErr = err;
        // Only fall through to the next server on connection problems, not on
        // real answers such as a rejected transaction.
        if (!/connect|websocket|timeout|timed out|network|closed|1006/i.test(String((err as Error)?.message ?? err))) throw err;
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

  sendRawTransaction(txHex: string): Promise<string> {
    return this.attempt((p) => p.sendRawTransaction(txHex));
  }
}
