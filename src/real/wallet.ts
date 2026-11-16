// The phone wallet over WizardConnect: connect, find coins, sign.
// Carries the one-phone fixes from the signing test: wait until the page is
// visible before sending, and tell the user when Paytaca restarted and needs
// another tap.

import { DappConnectionManager, loadSession } from '@wizardconnect/dapp';
import { initiateDappRelay, type DappRelayResult } from '@wizardconnect/core';
import { placeholderP2PKHUnlocker, type TransactionBuilder } from 'cashscript';
import type { FallbackNetworkProvider } from '../provider.js';
import { toRelaySignRequest } from '../relay.js';
import { p2pkhAddress, type Net, type WalletCoin } from './core.js';

const CHILD = { receive: 0, change: 1 } as const;
const SCAN = { receive: 20, change: 10 } as const;

export type WalletStatus = (text: string) => void;

export class Wallet {
  mgr: DappConnectionManager | null = null;
  relay: DappRelayResult | null = null;
  ready = false;
  awaiting = false;
  onReady: () => void = () => {};
  onStatus: WalletStatus = () => {};
  onQr: (uri: string, qrUri: string) => void = () => {};

  static hasSavedSession(): boolean {
    return Boolean(loadSession()?.walletPublicKey);
  }

  connect(resume: boolean) {
    this.mgr = new DappConnectionManager('Holdfast');
    const stored = resume ? loadSession() : null;
    this.relay = initiateDappRelay(
      (payload) => this.mgr!.updateConnection(payload.client, payload.status),
      stored?.walletPublicKey ? { existingCredentials: stored as Required<typeof stored> } : undefined,
    );
    this.mgr.attachRelay(this.relay);
    this.mgr.on('walletready', () => {
      this.markReady();
      if (this.awaiting) {
        setTimeout(() => {
          if (this.awaiting) this.onStatus('Paytaca restarted and missed the request. Sent again: open Paytaca and approve.');
        }, 2500);
      }
    });
    this.mgr.on('messagesent', (m) => {
      if (m.action === 'sign_transaction_request' && this.awaiting) {
        this.onStatus('Sent. Open Paytaca and approve, then come back here.');
      }
    });
    if (stored?.walletPublicKey && this.mgr.hasPath(CHILD.receive)) this.markReady();
    else this.onQr(this.relay.uri, this.relay.qrUri || this.relay.uri);
  }

  private markReady() {
    if (this.ready || !this.mgr?.getPubkey(CHILD.receive, 0n)) return;
    this.ready = true;
    this.onReady();
  }

  async disconnect() {
    try {
      this.mgr?.clearStoredSession();
      await this.mgr?.sendDisconnect('user disconnected');
    } catch {
      /* already gone */
    }
    this.relay?.cleanup();
    this.ready = false;
  }

  get name(): string {
    return this.mgr?.walletName ?? 'wallet';
  }

  /** The wallet's first receive key: the vault's phone key. */
  ownerPk(): Uint8Array {
    const pk = this.mgr?.getPubkey(CHILD.receive, 0n);
    if (!pk) throw new Error('The wallet shared no receive key.');
    return pk;
  }

  /** Every plain coin on the wallet's receive and change addresses. */
  async coins(provider: FallbackNetworkProvider, net: Net): Promise<WalletCoin[]> {
    if (!this.mgr) return [];
    const out: WalletCoin[] = [];
    const jobs: Promise<void>[] = [];
    for (const name of ['receive', 'change'] as const) {
      if (!this.mgr.hasPath(CHILD[name])) continue;
      for (let i = 0; i < SCAN[name]; i++) {
        const pk = this.mgr.getPubkey(CHILD[name], BigInt(i));
        if (!pk) continue;
        const address = p2pkhAddress(pk, net);
        jobs.push(
          provider.getUtxos(address).then((us) => {
            for (const u of us) if (!u.token) out.push({ ...u, path: [name, i] });
          }),
        );
      }
    }
    await Promise.all(jobs);
    return out;
  }

  /** Every address of the wallet we scan, to recognise "your Paytaca" as a recipient. */
  ownAddresses(net: Net): Set<string> {
    const out = new Set<string>();
    if (!this.mgr) return out;
    for (const name of ['receive', 'change'] as const) {
      if (!this.mgr.hasPath(CHILD[name])) continue;
      for (let i = 0; i < SCAN[name]; i++) {
        const pk = this.mgr.getPubkey(CHILD[name], BigInt(i));
        if (pk) out.add(p2pkhAddress(pk, net));
      }
    }
    return out;
  }

  unlockerFor(net: Net) {
    return (c: WalletCoin) => {
      const pk = this.mgr!.getPubkey(CHILD[c.path[0] as 'receive' | 'change'], BigInt(c.path[1]))!;
      return placeholderP2PKHUnlocker(p2pkhAddress(pk, net));
    };
  }

  /**
   * Ask the wallet to sign, then broadcast. `paths` lists, per wallet-signed input,
   * [input index, path name, address index].
   */
  async signAndSend(provider: FallbackNetworkProvider, builder: TransactionBuilder, paths: [number, string, number][], prompt: string): Promise<string> {
    if (!this.mgr || !this.ready) throw new Error('Connect your wallet first.');
    const transaction = toRelaySignRequest(builder.generateWcTransactionObject({ broadcast: false, userPrompt: prompt }));
    await whenVisible();
    this.onStatus('Sending to Paytaca... stay on this page.');
    this.awaiting = true;
    let res;
    try {
      res = await this.mgr.signTransaction({ transaction, inputPaths: paths } as never);
    } finally {
      this.awaiting = false;
    }
    if (res.error) throw new Error(/reject|cancel|denied/i.test(String(res.error)) ? 'You declined it in Paytaca. Nothing was sent.' : `Paytaca returned an error: ${res.error}`);
    if (!res.signedTransaction) throw new Error('Paytaca returned no signed transaction.');
    this.onStatus('Signed. Sending to the network...');
    return provider.sendRawTransaction(res.signedTransaction);
  }
}

/** On one phone, a request queued while this tab is hidden goes out stale. */
function whenVisible(): Promise<void> {
  if (!document.hidden) return Promise.resolve();
  return new Promise((resolve) => {
    const on = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', on);
      resolve();
    };
    document.addEventListener('visibilitychange', on);
  });
}
