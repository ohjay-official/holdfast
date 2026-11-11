// Holdfast pre-kickoff signing test.
// Connects a wallet over WizardConnect and runs four chipnet transactions
// against the SignTest contract, logging every step so results can be shared.

import { DappConnectionManager, loadSession } from '@wizardconnect/dapp';
import { initiateDappRelay, type DappRelayResult } from '@wizardconnect/core';
import {
  placeholderP2PKHUnlocker,
  placeholderSignature,
  type SpendableUtxo,
  type TransactionBuilder,
} from 'cashscript';
import { binToHex, encodeCashAddress, hash160, stringify } from '@bitauth/libauth';
import QRCode from 'qrcode';
import {
  buildBump,
  buildGenesis,
  buildPrepare,
  buildWithdraw,
  findVaultUtxo,
  makeContract,
  pickGenesisUtxo,
  readCounter,
  type SignTestContract,
} from './signtest';
import { FallbackNetworkProvider } from './provider';

const EXPLORER = 'https://chipnet.imaginary.cash/tx/';
const RECEIVE = 0;
const STORE_KEY = 'holdfast-signtest';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- log ----------
const logLines: string[] = [];
function log(msg: string) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
  logLines.push(line);
  $('log').textContent = logLines.join('\n');
  console.log(line);
}
function setResult(id: string, text: string, ok?: boolean) {
  const el = $(id);
  el.textContent = text;
  el.className = 'result' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
}
async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    log(`Copied ${what}.`);
  } catch {
    log(`Could not copy ${what} automatically. Long-press to select it instead.`);
  }
}

// ---------- state ----------
// Several chipnet servers, so one being down doesn't stop the test.
const provider = new FallbackNetworkProvider('chipnet', ['chipnet.bch.ninja', 'chipnet.imaginary.cash']);
provider.onSwitch = (host) => log(`Switched chipnet server to ${host}.`);
let mgr: DappConnectionManager | null = null;
let relay: DappRelayResult | null = null;
let ownerPk: Uint8Array | null = null;
let userAddress = '';
let contract: SignTestContract | null = null;
let category: string | null = localStorage.getItem(`${STORE_KEY}-category`);
let busy = false;
let lastRelayStatus = '';

// Switching to the wallet app hides this tab; logging it helps debug phone-only flows.
document.addEventListener('visibilitychange', () => {
  log(document.hidden ? 'Page hidden (switched away).' : 'Page visible again.');
});

// ---------- connection ----------
function setupManager(resume: boolean) {
  mgr = new DappConnectionManager('Holdfast signing test');
  const stored = resume ? loadSession() : null;
  relay = initiateDappRelay(
    (payload) => {
      mgr!.updateConnection(payload.client, payload.status);
      if (payload.status.status !== lastRelayStatus) {
        lastRelayStatus = payload.status.status;
        log(`Relay: ${lastRelayStatus}`);
      }
      if (!mgr!.isWalletDiscovered()) {
        const s = payload.status.status;
        $('connect-status').textContent =
          s === 'connected' ? 'Waiting for the wallet...' : `Connection ${s}...`;
      }
    },
    stored?.walletPublicKey ? { existingCredentials: stored as Required<typeof stored> } : undefined,
  );
  mgr.attachRelay(relay);

  mgr.on('walletready', (msg) => {
    log(`Wallet ready: ${msg.wallet_name ?? 'unknown wallet'}`);
    onWalletReady();
  });
  mgr.on('disconnect', (reason, message) => {
    log(`Wallet disconnected: ${reason}${message ? ` (${message})` : ''}`);
    $('connect-status').textContent = 'Disconnected.';
  });
  mgr.on('reconnecting', () => log('Relay reconnecting...'));
  mgr.on('messagereceived', (m) => log(`From wallet: ${m.action}`));

  if (stored?.walletPublicKey && mgr.hasPath(RECEIVE)) {
    log('Resumed a saved WizardConnect session.');
    onWalletReady();
  } else {
    showQr(relay);
  }
}

async function showQr(r: DappRelayResult) {
  $('qr-area').hidden = false;
  $('connect-area').hidden = true;
  ($('qr') as HTMLImageElement).src = await QRCode.toDataURL(r.qrUri || r.uri, { margin: 1, width: 240 });
  ($('wiz-link') as HTMLAnchorElement).href = r.uri;
  $('connect-status').textContent = 'Waiting for the wallet...';
  log('Connection code ready. Scan it with Paytaca or tap Open in wallet.');
}

function onWalletReady() {
  if (!mgr) return;
  const pk = mgr.getPubkey(RECEIVE, 0n);
  if (!pk) {
    log('Wallet connected but shared no receive key. Stopping.');
    return;
  }
  ownerPk = pk;
  userAddress = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(pk) }).address;
  contract = makeContract(pk, provider);
  $('qr-area').hidden = true;
  $('connect-area').hidden = true;
  $('connect-status').textContent = `Connected: ${mgr.walletName ?? 'wallet'}`;
  $('btn-disconnect').hidden = false;
  $('step-fund').hidden = false;
  $('step-tests').hidden = false;
  $('address').textContent = userAddress;
  log(`Owner key (receive/0): ${binToHex(pk)}`);
  log(`Chipnet address: ${userAddress}`);
  log(`Test contract: ${contract.tokenAddress}`);
  refresh();
}

// ---------- chain reads ----------
async function walletUtxos(): Promise<SpendableUtxo[]> {
  return (await provider.getUtxos(userAddress)).filter((u) => !u.token);
}

async function vaultUtxo(): Promise<SpendableUtxo | undefined> {
  if (!contract) return undefined;
  return findVaultUtxo(await contract.getUtxos(), category ?? undefined);
}

async function refresh() {
  if (!contract) return;
  try {
    const utxos = await walletUtxos();
    const sats = utxos.reduce((a, u) => a + u.satoshis, 0n);
    $('balance').textContent = `Balance: ${sats.toLocaleString()} test sats in ${utxos.length} coin(s)`;
    const vault = await vaultUtxo();
    const hasVault = Boolean(vault);
    ($('btn-create') as HTMLButtonElement).disabled = hasVault || sats < 6_000n;
    ($('btn-bump') as HTMLButtonElement).disabled = !hasVault;
    ($('btn-age') as HTMLButtonElement).disabled = !hasVault;
    ($('btn-withdraw') as HTMLButtonElement).disabled = !hasVault;
    if (vault) {
      if (!category) {
        category = vault.token!.category;
        localStorage.setItem(`${STORE_KEY}-category`, category);
      }
      setResult('res-create', `Vault exists, counter ${readCounter(vault.token!.nft!.commitment)}`, true);
    }
  } catch (err) {
    log(`Could not read chipnet: ${errText(err)}`);
  }
}

// ---------- signing ----------
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function signAndSend(
  builder: TransactionBuilder,
  inputPaths: [number, string, number][],
  prompt: string,
): Promise<string> {
  if (!mgr) throw new Error('Not connected');
  const wc = builder.generateWcTransactionObject({ broadcast: false, userPrompt: prompt });
  const transaction = JSON.parse(stringify(wc));
  log(`Asking the wallet to sign: ${prompt}`);
  const res = await mgr.signTransaction({ transaction, inputPaths } as never);
  if (res.error) throw new Error(`Wallet returned an error: ${res.error}`);
  if (!res.signedTransaction) throw new Error('Wallet returned no signed transaction');
  log('Wallet signed. Broadcasting to chipnet...');
  const txid = await provider.sendRawTransaction(res.signedTransaction);
  log(`Broadcast OK: ${EXPLORER}${txid}`);
  return txid;
}

async function run(resId: string, label: string, fn: () => Promise<string>) {
  if (busy) return;
  busy = true;
  setResult(resId, 'Waiting for the wallet...');
  try {
    const txid = await fn();
    setResult(resId, `Passed (${txid.slice(0, 10)}...)`, true);
    log(`${label}: PASSED`);
  } catch (err) {
    setResult(resId, `Failed: ${errText(err)}`, false);
    log(`${label}: FAILED: ${errText(err)}`);
  } finally {
    busy = false;
    await new Promise((r) => setTimeout(r, 1500));
    refresh();
  }
}

async function waitFor<T>(check: () => Promise<T | undefined>, what: string, tries = 20): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// A. create vault (with a prepare step first if needed)
async function createVault(): Promise<string> {
  if (!contract) throw new Error('Not connected');
  let utxos = await walletUtxos();
  if (!pickGenesisUtxo(utxos)) {
    log('No coin at output index 0 yet. Making one with a self-send first.');
    const prep = buildPrepare({ provider, userAddress, userUtxos: utxos, unlocker: placeholderP2PKHUnlocker(userAddress) });
    await signAndSend(prep, prep.inputs.map((_, i) => [i, 'receive', 0]), 'Holdfast test: prepare coins');
    utxos = await waitFor(async () => {
      const u = await walletUtxos();
      return pickGenesisUtxo(u) ? u : undefined;
    }, 'the prepared coin');
  }
  const { builder, category: cat } = buildGenesis({
    provider,
    contract,
    userAddress,
    userUtxos: utxos,
    unlocker: placeholderP2PKHUnlocker(userAddress),
  });
  const txid = await signAndSend(
    builder,
    builder.inputs.map((_, i) => [i, 'receive', 0]),
    'Holdfast test: create test vault',
  );
  category = cat;
  localStorage.setItem(`${STORE_KEY}-category`, cat);
  log(`State token category: ${cat}`);
  return txid;
}

// B / C. contract spend
async function bump(afterAge: boolean): Promise<string> {
  if (!contract) throw new Error('Not connected');
  const vault = await vaultUtxo();
  if (!vault) throw new Error('No test vault found. Run test A first.');
  const unlocker = afterAge
    ? contract.unlock.bumpAfterAge(placeholderSignature())
    : contract.unlock.bump(placeholderSignature());
  const builder = buildBump({ provider, contract, vaultUtxo: vault, unlocker, afterAge });
  try {
    return await signAndSend(
      builder,
      [[0, 'receive', 0]],
      afterAge ? 'Holdfast test: timelocked contract spend' : 'Holdfast test: contract spend',
    );
  } catch (err) {
    if (afterAge && /BIP68|non-BIP68-final|sequence/i.test(errText(err))) {
      throw new Error('Too early: the last transaction is not in a block yet. Wait about 10 minutes and retry.');
    }
    throw err;
  }
}

// D. withdraw
async function withdraw(): Promise<string> {
  if (!contract) throw new Error('Not connected');
  const vault = await vaultUtxo();
  if (!vault) throw new Error('No test vault found.');
  const builder = buildWithdraw({
    provider,
    vaultUtxo: vault,
    unlocker: contract.unlock.withdraw(placeholderSignature()),
    userAddress,
  });
  const txid = await signAndSend(builder, [[0, 'receive', 0]], 'Holdfast test: withdraw test coins');
  localStorage.removeItem(`${STORE_KEY}-category`);
  category = null;
  return txid;
}

// ---------- wiring ----------
$('btn-connect').onclick = () => setupManager(false);
$('btn-copy-uri').onclick = () => relay && copy(relay.uri, 'connection link');
$('btn-copy-address').onclick = () => copy(userAddress, 'address');
$('btn-refresh').onclick = () => refresh();
$('btn-create').onclick = () => run('res-create', 'A. Create test vault', createVault);
$('btn-bump').onclick = () => run('res-bump', 'B. Contract spend', () => bump(false));
$('btn-age').onclick = () => run('res-age', 'C. Timelocked spend', () => bump(true));
$('btn-withdraw').onclick = () => run('res-withdraw', 'D. Withdraw', withdraw);
$('btn-copy-log').onclick = () =>
  copy(
    [`Holdfast signing test`, `UA: ${navigator.userAgent}`, ...logLines].join('\n'),
    'log',
  );
$('btn-disconnect').onclick = async () => {
  try {
    mgr?.clearStoredSession();
    await mgr?.sendDisconnect('user disconnected');
  } catch {
    /* ignore */
  }
  relay?.cleanup();
  location.reload();
};

log('Page loaded. Network: chipnet.');
if (loadSession()?.walletPublicKey) setupManager(true);
