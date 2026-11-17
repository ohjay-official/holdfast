import QRCode from 'qrcode';
import { SignatureTemplate } from 'cashscript';
import { binToHex, hexToBin } from '@bitauth/libauth';
import * as V from '../vault.js';
import * as C from './core.js';
import { FallbackNetworkProvider } from '../provider.js';
import { Wallet } from './wallet.js';
import { fmtBch, toSats } from '../app/model.js';

// ---------------- setup ----------------

const HOSTS: Record<C.Net, string[]> = {
  mainnet: ['bch.imaginary.cash', 'electrum.imaginary.cash', 'bch.loping.net', 'electroncash.de'],
  chipnet: ['chipnet.bch.ninja', 'chipnet.imaginary.cash'],
};
const EXPLORER: Record<C.Net, string> = {
  mainnet: 'https://blockchair.com/bitcoin-cash/transaction/',
  chipnet: 'https://chipnet.imaginary.cash/tx/',
};

interface Saved {
  pinLen?: number;
  config: C.VaultConfig;
  panicKey: string;
  salt: string;
  pin: string;
  duress: string;
}

const NET_KEY = 'holdfast-real-net';
let net: C.Net = (localStorage.getItem(NET_KEY) as C.Net) || 'mainnet';
const savedKey = () => `holdfast-real-${net}`;
const load = (): Saved | null => {
  try {
    return JSON.parse(localStorage.getItem(savedKey()) || 'null');
  } catch {
    return null;
  }
};
let saved = load();
const pendingKey = () => `holdfast-real-pending-${net}`;
const save = () => (saved ? localStorage.setItem(savedKey(), JSON.stringify(saved)) : localStorage.removeItem(savedKey()));

let provider = new FallbackNetworkProvider(net, HOSTS[net]);
const wallet = new Wallet();

let unlocked = false;
let decoy = false;
let pinEntry = '';
let busy = false;
let status: { kind: 'ok' | 'err' | 'info'; text: string; tx?: string } | null = null;
let view: C.VaultView | null = null;
let qr: { uri: string; img: string } | null = null;
let homeKey: Uint8Array | null = null;
let guardianConfig: C.VaultConfig | null = null;
let guardianView: C.VaultView | null = null;
let walletSats: bigint | null = null;
let own = new Set<string>();

interface ActivityItem { at: number; text: string; tx?: string }
const actKey = () => `holdfast-real-activity-${net}`;
function activity(): ActivityItem[] {
  try {
    return JSON.parse(localStorage.getItem(actKey()) || '[]');
  } catch {
    return [];
  }
}
function addActivity(text: string, tx?: string) {
  const list = [{ at: Date.now(), text, tx }, ...activity()].slice(0, 50);
  try {
    localStorage.setItem(actKey(), JSON.stringify(list));
  } catch {
    /* full */
  }
}

const draft = { step: 1, allowance: '0.001', waitDays: 3, words: C.newHomeWords(), check: 4, guardianPk: '', pin: '', duress: '', amount: '' };

const app = document.getElementById('app')!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const bch = (sats: bigint) => `${fmtBch(Number(sats))} BCH`;
const sats = (text: string) => {
  const n = toSats(text);
  return Number.isFinite(n) && n > 0 ? BigInt(n) : 0n;
};
const go = (h: string) => (location.hash === '#' + h ? render() : (location.hash = h));

const LOG_KEY = 'holdfast-real-log';
let logLines: string[] = (() => {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
  } catch {
    return [];
  }
})();
function log(line: string) {
  logLines.push(`${new Date().toISOString().slice(5, 19)} [${net}] ${line}`);
  if (logLines.length > 300) logLines = logLines.slice(-300);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(logLines));
  } catch {
    /* full */
  }
}
let netCheck: { ok: boolean; text: string } | null = null;
async function checkNetwork() {
  netCheck = null;
  render();
  try {
    const h = await Promise.race([
      provider.getBlockHeight(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no answer after 15 seconds')), 15_000)),
    ]);
    netCheck = { ok: true, text: `Connected to ${net}, block ${h}.` };
  } catch (e) {
    netCheck = { ok: false, text: `Can't reach ${net} right now: ${(e as Error).message}` };
  }
  log(netCheck.text);
  render();
}

function setStatus(kind: 'ok' | 'err' | 'info', text: string, tx?: string) {
  status = { kind, text, tx };
  log(`${kind}: ${text}${tx ? ` tx ${tx}` : ''}`);
  const el = document.getElementById('status');
  if (el) el.outerHTML = statusBox();
  else render();
}

function statusBox(): string {
  if (!status) return '<div id="status"></div>';
  const s = status;
  return `<div id="status"><p class="flash flash-${s.kind === 'err' ? 'err' : 'ok'}" role="${s.kind === 'err' ? 'alert' : 'status'}">${esc(s.text)}${s.tx ? ` <a href="${EXPLORER[net]}${s.tx}" target="_blank" rel="noopener">View transaction</a>` : ''}</p></div>`;
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/insufficient|fee per byte|too low/i.test(m)) return 'Not enough BCH for the network fee.';
  if (/non-BIP68-final|non-final|BIP68/i.test(m)) return 'The wait isn\'t over on the network yet. Try again after the next block.';
  if (/missing inputs|missing or already spent|bad-txns-inputs-missingorspent|txn-mempool-conflict|conflicts with an unconfirmed/i.test(m)) return 'Something changed since this screen loaded. Refresh and try again.';
  if (/connect|websocket|1006|timeout|timed out/i.test(m)) return 'Couldn\'t reach the Bitcoin Cash network. Check your connection and try again.';
  return m;
}

const DONE: Record<string, string> = {
  Releasing: 'Released to the recipient.',
  Cancelling: 'Withdrawal cancelled. The BCH is back in the vault.',
  'Adding deposits': 'Deposits added to the vault.',
  Freezing: 'Vault frozen. Nothing can leave until it is unfrozen.',
  Approving: 'Approved.',
  'Approving fast lane': 'Fast lane approved. It can leave about an hour from now.',
  'Moving everything': 'Everything moved out of the vault.',
  'Creating your vault': 'Vault created.',
};
let nextDone: string | null = null;

async function act(label: string, fn: () => Promise<string | void>, done?: string) {
  if (busy) return;
  busy = true;
  setStatus('info', `${label}...`);
  try {
    const txid = await fn();
    const text = done ?? nextDone ?? DONE[label] ?? `${label}: done.`;
    nextDone = null;
    setStatus('ok', text, txid || undefined);
    if (txid) addActivity(text, txid);
    await refreshSoon();
  } catch (e) {
    log(`raw error: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    setStatus('err', errText(e));
  } finally {
    busy = false;
    render();
  }
}

// ---------------- chain ----------------

function contractFor(c: C.VaultConfig) {
  return V.makeVault(C.paramsOf(c), provider);
}

async function readConfig(c: C.VaultConfig): Promise<C.VaultView> {
  const contract = contractFor(c);
  const [utxos, heights, tip] = await Promise.all([contract.getUtxos(), provider.heights(contract.address), provider.getBlockHeight()]);
  return C.readVault(c, utxos, heights, tip);
}

let lastWalletScan = 0;
async function refreshWallet(force = false) {
  if (!wallet.ready || (!force && Date.now() - lastWalletScan < 50_000)) return;
  lastWalletScan = Date.now();
  try {
    own = wallet.ownAddresses(net);
    const coins = await wallet.coins(provider, net);
    walletSats = coins.reduce((a, u) => a + u.satoshis, 0n);
  } catch (e) {
    log(`wallet scan failed: ${(e as Error).message}`);
  }
}

async function refresh() {
  try {
    refreshWallet().then(render);
    if (saved) view = await readConfig(saved.config);
    if (guardianConfig) guardianView = await readConfig(guardianConfig);
  } catch (e) {
    setStatus('err', errText(e));
  }
  render();
}

async function refreshSoon() {
  lastWalletScan = 0;
  await new Promise((r) => setTimeout(r, 1500));
  await refresh();
  setTimeout(refresh, 6000);
}

/** Broadcast a transaction signed in this page (home code, panic key, release). */
async function sendLocal(tb: { send(): Promise<{ txid: string }> }): Promise<string> {
  return (await tb.send()).txid;
}

// ---------------- pieces ----------------

function topbar(title?: string, back?: string): string {
  return `<header class="topbar">
    ${back ? `<a class="back" href="#${back}">Back</a>` : `<a class="mark" href="/" aria-label="Holdfast website"><svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><path d="M16 4l10 4.4v6.4c0 6.6-4.4 11-10 13.2C10.4 25.8 6 21.4 6 14.8V8.4z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><circle cx="16" cy="14.2" r="2.7" fill="currentColor"/><path d="M16 16.4v5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>Holdfast</a>`}
    ${title ? `<h1 class="tb-title">${esc(title)}</h1>` : ''}
    <span class="demo-chip ${net === 'mainnet' ? 'chip-main' : ''}">${net === 'mainnet' ? 'Mainnet' : 'Chipnet'}</span>
  </header>`;
}

function bar(v: C.VaultView): string {
  const total = v.total > 0n ? v.total : 1n;
  const pct = (n: bigint) => `${(Number((n * 10000n) / total) / 100).toFixed(2)}%`;
  const now = v.allowanceLeft;
  const saved = v.total - v.waitingSats - now;
  return `<div class="vbar" role="img" aria-label="${esc(`${bch(now)} spendable now, ${bch(saved)} saved, ${bch(v.waitingSats)} waiting`)}">
      ${now ? `<span class="seg-now" style="width:${pct(now)}"></span>` : ''}
      ${saved > 0n ? `<span class="seg-safe" style="width:${pct(saved)}"></span>` : ''}
      ${v.waitingSats ? `<span class="seg-held" style="width:${pct(v.waitingSats)}"></span>` : ''}
    </div>
    <dl class="vkey">
      <div><dt><i class="k-now"></i>Spendable now</dt><dd>${bch(now)}</dd></div>
      <div><dt><i class="k-safe"></i>Saved</dt><dd>${bch(saved > 0n ? saved : 0n)}</dd></div>
      <div><dt><i class="k-held"></i>Waiting</dt><dd>${bch(v.waitingSats)}</dd></div>
    </dl>`;
}

function frozenBox(v: C.VaultView, c: C.VaultConfig): string {
  const s = v.state;
  if (!s || s.level === 0) return '';
  const needs = c.hasGuardian ? 'your home code and your guardian' : 'your home code';
  return `<div class="notice notice-frozen"><h2>Vault frozen</h2>
    <p>${s.level === 1 ? 'Frozen by the duress PIN. Only the daily allowance can leave.' : 'Nothing can leave until it\'s unfrozen.'}</p>
    <p class="small">To unfreeze: ${needs}. Home code ${s.unfreezeHome ? '<b>approved</b>' : 'not yet'}${c.hasGuardian ? `, guardian ${s.unfreezeGuardian ? '<b>approved</b>' : 'not yet'}` : ''}.</p></div>`;
}

function shortAddr(a: string): string {
  if (own.has(a)) return 'your Paytaca';
  const t = a.replace(/^(bitcoincash|bchtest):/, '');
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

function clockIn(blocks: number): string {
  return new Date(Date.now() + blocks * 600_000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function pendingList(v: C.VaultView, actions: (p: C.PendingView, i: number) => string): string {
  if (!v.pending.length) return '<p class="muted">Nothing is waiting.</p>';
  return `<ul class="pends">${v.pending
    .map((p, i) => {
      const state = p.ready
        ? 'Ready to release'
        : p.blocksLeft === null
          ? 'Confirming'
          : `${C.blocksToText(p.blocksLeft)} left`;
      const when = p.ready
        ? 'The wait is over. Anyone can release it to the recipient now.'
        : p.blocksLeft === null
          ? 'Waiting for the next block, usually about 10 minutes. The wait starts then.'
          : `Can be released around ${clockIn(p.blocksLeft)} (${p.blocksLeft} blocks to go).`;
      return `<li class="pend">
      <div class="pend-top"><span class="pend-amt">${bch(p.sats)}</span>
      <span class="tag ${p.ready ? 'tag-taken' : 'tag-held'}">${state}</span></div>
      <p class="pend-meta">To ${esc(shortAddr(p.to))}.${p.fast ? ' Fast lane approved.' : ''} ${when}</p>
      <div class="row-actions">${actions(p, i)}</div></li>`;
    })
    .join('')}</ul>`;
}

function activityList(): string {
  const items = activity().slice(0, 6);
  if (!items.length) return '';
  const when = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `<section class="block"><h2>Recent activity</h2><ul class="acts">${items
    .map((a) => `<li><div>${esc(a.text)}<br><span class="small muted">${when(a.at)}</span></div>${a.tx ? `<a class="small" href="${EXPLORER[net]}${a.tx}" target="_blank" rel="noopener">View</a>` : ''}</li>`)
    .join('')}</ul></section>`;
}

// ---------------- screens ----------------

function screenStart(): string {
  return `${topbar()}
  <main class="screen" id="main">
    <h1 class="big">Your Holdfast vault</h1>
    <p class="help">Connect Paytaca to create a real vault, or to open the one you made on this phone.</p>
    ${statusBox()}
    <fieldset class="days netpick"><legend class="sr">Network</legend>
      <label><input type="radio" name="net" value="mainnet" ${net === 'mainnet' ? 'checked' : ''} data-act="net"><span>Mainnet</span></label>
      <label><input type="radio" name="net" value="chipnet" ${net === 'chipnet' ? 'checked' : ''} data-act="net"><span>Chipnet (test)</span></label>
    </fieldset>
    <p class="small ${netCheck?.ok === false ? 'flash flash-err' : 'muted'}">${netCheck ? esc(netCheck.text) : 'Checking the network...'}</p>
    <p class="small muted">${net === 'mainnet' ? 'Real BCH. Start with a small amount: this contract hasn\'t had an outside audit.' : 'Test coins only. In Paytaca: Apps, Settings, turn on Use Chipnet Network.'}</p>
    <div class="stack stack-end">
      <button class="btn btn-dark" data-act="connect">${saved ? 'Open my vault' : 'Connect Paytaca'}</button>
      <a class="btn btn-line" href="#/guardian">I'm someone's guardian</a>
      <a class="btn btn-line" href="/app/#/quick">Try the demo instead</a>
    </div>
    <p class="small" style="margin-top:1.5rem"><button class="linkish" data-act="copy-log">Copy log for support</button></p>
  </main>`;
}

function screenConnect(): string {
  return `${topbar('Connect', '/')}
  <main class="screen" id="main">
    ${statusBox()}
    ${qr ? `<ol class="steps">
        <li><h3>Copy the connection link</h3><p><code id="wiz-uri" class="sr">${esc(qr.uri)}</code><button class="btn btn-dark" data-copy="#wiz-uri" style="margin-top:.5rem">Copy connection link</button></p></li>
        <li><h3>Paste it in Paytaca</h3><p>Open Paytaca, tap Apps, then WizardConnect, then Initiate new session, then Paste URL. Approve the connection.</p></li>
        <li><h3>Come back here</h3><p>This page carries on by itself once Paytaca is connected.</p></li>
      </ol>
      <p class="small muted">Using two phones? Scan this code with Paytaca instead.</p>
      <p class="center"><img src="${qr.img}" width="200" height="200" alt="Connection code for Paytaca"></p>
      <p class="small"><a href="${esc(qr.uri)}">Open in Paytaca directly</a> (newer Paytaca versions only)</p>` : '<p>Connecting...</p>'}
  </main>`;
}

function screenSetup(): string {
  const d = draft;
  const head = (t: string, help: string) => `<p class="stepno">Step ${d.step} of 5</p><div class="progress" aria-hidden="true"><span style="width:${d.step * 20}%"></span></div><h1 class="big">${t}</h1><p class="help">${help}</p>`;
  let body = '';
  if (d.step === 1) {
    body = `${head('Allowance and wait', 'The allowance is what your phone can send right away each day. Anything more waits, and can be cancelled.')}
      <label class="field"><span>Daily allowance in BCH</span><input name="allowance" inputmode="decimal" value="${esc(d.allowance)}"></label>
      <fieldset class="days"><legend class="field" style="margin-bottom:.4rem">Wait for bigger withdrawals</legend>
        ${[1, 2, 3, 4, 5, 6, 7].map((n) => `<label><input type="radio" name="wait" value="${n}" ${d.waitDays === n ? 'checked' : ''}><span>${n} ${n === 1 ? 'day' : 'days'}</span></label>`).join('')}
      </fieldset>`;
  } else if (d.step === 2) {
    body = `${head('Write down your home code', 'These 12 words are a second key. Write them on paper and keep it at home, never on this phone. Holdfast doesn\'t store them, so nobody can show them to you again.')}
      <ol class="words">${d.words.map((w) => `<li>${w}</li>`).join('')}</ol>
      <label class="check"><input type="checkbox" name="wrote"> I've written these on paper</label>
      <label class="field"><span>To check, type word ${d.check}</span><input name="checkword" autocomplete="off" autocapitalize="none" spellcheck="false"></label>`;
  } else if (d.step === 3) {
    body = `${head('Guardian', 'A person who can cancel and freeze, and help you unfreeze. They open this page, tap "I\'m someone\'s guardian", connect their own wallet and send you their guardian key.')}
      <label class="field"><span>Guardian key (optional)</span><input name="gpk" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="02… or 03…, 66 characters" value="${esc(d.guardianPk)}"></label>
      <p class="small muted">Leave it empty for no guardian: your home code then works alone, and there's no fast lane.</p>`;
  } else if (d.step === 4) {
    body = `${head('PINs for this app', 'Your PIN opens the vault. Your duress PIN opens a view with only the allowance, and quietly freezes the rest.')}
      <label class="field"><span>PIN</span><input name="pin" type="password" inputmode="numeric" autocomplete="off" value="${esc(d.pin)}"></label>
      <label class="field"><span>Duress PIN</span><input name="duress" type="password" inputmode="numeric" autocomplete="off" value="${esc(d.duress)}"></label>
      <p class="small muted">4 to 6 digits, the same length for both, and different from each other.</p>`;
  } else {
    body = `${head('Fund the vault', 'Paytaca will ask you to approve. If your coins are spread out, it asks twice: once to gather them, once to create the vault.')}
      <label class="field"><span>BCH to put in</span><input name="amount" inputmode="decimal" placeholder="0.001" value="${esc(d.amount)}"></label>
      <p class="small">${walletSats === null ? 'Checking your Paytaca balance...' : `In Paytaca: <b>${bch(walletSats)}</b>. ${walletSats > C.CREATE_FEE + 20_000n ? `<button type="button" class="linkish" data-act="use-all">Use all I can</button>` : 'That is not enough yet: you need a little more than 0.0002 BCH.'}`}</p>
      <ul class="review">
        <li>Allowance <b>${esc(d.allowance)} BCH</b> a day, wait <b>${d.waitDays} ${d.waitDays === 1 ? 'day' : 'days'}</b>.</li>
        <li>${d.guardianPk ? 'Guardian key added.' : 'No guardian.'}</li>
        <li>One-time Holdfast fee: <b>${bch(C.CREATE_FEE)}</b>, plus a network fee of a few hundred sats.</li>
      </ul>`;
  }
  return `${topbar('New vault', d.step > 1 ? '/setup/back' : '/')}
  <main class="screen" id="main">${statusBox()}
    <form data-form="setup" novalidate>${body}
      <div class="stack stack-end"><button class="btn btn-dark" type="submit" ${busy ? 'disabled' : ''}>${d.step === 5 ? 'Create vault' : 'Continue'}</button></div>
    </form></main>`;
}

function screenLock(): string {
  const dots = Array.from({ length: Math.max(saved?.pinLen ?? 6, pinEntry.length) }, (_, i) => `<i class="${i < pinEntry.length ? 'on' : ''}"></i>`).join('');
  return `${topbar()}
  <main class="screen screen-lock" id="main">
    <h1 class="big center">Enter your PIN</h1>${statusBox()}
    <div class="dots">${dots}</div>
    <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-act="pin" data-d="${n}">${n}</button>`).join('')}
      <button data-act="pin-del">Delete</button><button data-act="pin" data-d="0">0</button><button data-act="pin-ok" class="pad-ok">Open</button></div>
    <p class="small center" style="margin-top:1.5rem"><a href="#/forgot">Forgot your PIN? Use your home code</a></p>
  </main>`;
}

function screenForgot(): string {
  return `${topbar('Reset PINs', '/vault')}
  <main class="screen" id="main">${statusBox()}
    <form data-form="forgot" novalidate>
      <p>Your home code proves the vault is yours. Type the 12 words, then choose new PINs.</p>
      <label class="field"><span>Home code</span><textarea name="words" rows="3" autocomplete="off" autocapitalize="none" spellcheck="false"></textarea></label>
      <label class="field"><span>New PIN</span><input name="pin" type="password" inputmode="numeric" autocomplete="off"></label>
      <label class="field"><span>New duress PIN</span><input name="duress" type="password" inputmode="numeric" autocomplete="off"></label>
      <div class="stack stack-end"><button class="btn btn-dark" type="submit">Reset PINs and open</button></div>
    </form></main>`;
}

function screenVault(): string {
  const c = saved!.config;
  const v = view;
  if (!v) return `${topbar()}<main class="screen" id="main">${statusBox()}<p>Reading your vault from the network...</p></main>`;
  if (!v.main) {
    return `${topbar()}<main class="screen" id="main">${statusBox()}<p>No vault coin found at this address yet. If you just created it, wait a few seconds.</p>
      <button class="btn btn-line" data-act="refresh">Check again</button></main>`;
  }
  if (decoy) {
    return `${topbar()}<main class="screen" id="main">${statusBox()}
      <section class="balance"><p class="bal-label">Balance</p><p class="bal">${bch(C.duressBalance(v))}</p><div class="vbar"><span class="seg-now" style="width:100%"></span></div></section>
      <div class="actions2"><a class="btn btn-dark" href="#/send">Send</a><a class="btn btn-line" href="#/receive">Receive</a></div>
      <nav class="links"><button class="linkish" data-act="lock">Lock</button></nav></main>`;
  }
  const s = v.state!;
  return `${topbar()}
  <main class="screen" id="main">${statusBox()}${frozenBox(v, c)}
    <section class="balance"><p class="bal-label">In your vault</p><p class="bal">${bch(v.total)}</p>${bar(v)}
      ${walletSats !== null ? `<p class="small muted">In Paytaca, outside the vault: ${bch(walletSats)}</p>` : ''}
      ${v.refillIn && v.refillIn > 0 ? `<p class="small muted">Allowance full again in ${C.blocksToText(v.refillIn)}.</p>` : ''}</section>
    <div class="actions2"><a class="btn btn-dark" href="#/send" ${s.level === 2 ? 'aria-disabled="true"' : ''}>Send</a><a class="btn btn-line" href="#/receive">Receive</a></div>
    ${s.level === 0 ? `<p class="small"><a href="#/withdraw">Withdraw more than the allowance</a></p>` : ''}
    ${depositNotice(v)}
    <section class="block"><h2>Waiting to leave</h2>${pendingList(v, (p, i) => `${p.ready && s.level === 0 ? `<button class="btn btn-sm btn-dark" data-act="release" data-i="${i}">Release ${bch(p.sats)}</button>` : ''}<button class="btn btn-sm btn-line" data-act="cancel-owner" data-i="${i}">Cancel</button>`)}</section>
    ${activityList()}
    <nav class="links"><a href="#/home">Home code</a><a href="#/settings">Settings</a><button class="linkish" data-act="refresh">Refresh</button><button class="linkish" data-act="lock">Lock</button></nav>
  </main>`;
}

function depositNotice(v: C.VaultView): string {
  if (!v.deposits.length) return '';
  const worth = C.mergeableDeposits(v);
  const small = v.deposits.length - worth.length;
  const smallText = small ? `<p class="small muted">${small === 1 ? 'One deposit is' : `${small} deposits are`} smaller than the ${bch(V.MERGE_FEE)} network fee to add ${small === 1 ? 'it' : 'them'}, so ${small === 1 ? 'it stays' : 'they stay'} as a deposit.</p>` : '';
  return `<div class="notice"><h2>${bch(v.depositSats)} deposited</h2><p>Deposits join the vault when you add them.${worth.length > 1 ? ` Paytaca asks once per deposit (${worth.length}).` : ''}</p>${worth.length ? '<button class="btn btn-sm btn-dark" data-act="absorb">Add to vault</button>' : ''}${smallText}</div>`;
}

function screenSend(): string {
  const v = view;
  const left = v?.allowanceLeft ?? 0n;
  return `${topbar('Send', '/vault')}
  <main class="screen" id="main">${statusBox()}
    <form data-form="send" novalidate>
      <p>You can send up to <b>${bch(left)}</b> right away.${decoy ? '' : ' For more, use a withdrawal, which waits.'}</p>
      <label class="field"><span>To</span><input name="to" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="${C.PREFIX[net]}:..."></label>
      <label class="field"><span>Amount in BCH</span><input name="amount" inputmode="decimal"></label>
      <div class="stack stack-end"><button class="btn btn-dark" type="submit" ${busy || left === 0n ? 'disabled' : ''}>Send</button></div>
    </form></main>`;
}

function screenWithdraw(): string {
  const c = saved!.config;
  const days = c.waitBlocks / 144;
  return `${topbar('Withdraw', '/vault')}
  <main class="screen" id="main">${statusBox()}
    <form data-form="withdraw" novalidate>
      <p>A withdrawal waits <b>about ${days} ${days === 1 ? 'day' : 'days'}</b> before it can leave. Until then, you, your home code${c.hasGuardian ? ' or your guardian' : ''} can cancel it.</p>
      <label class="field"><span>To</span><input name="to" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="${C.PREFIX[net]}:..."></label>
      <label class="field"><span>Amount in BCH</span><input name="amount" inputmode="decimal"></label>
      <div class="stack stack-end"><button class="btn btn-dark" type="submit" ${busy ? 'disabled' : ''}>Start withdrawal</button></div>
    </form></main>`;
}

function screenReceive(): string {
  const addr = contractFor(saved!.config).address;
  return `${topbar('Receive', '/vault')}
  <main class="screen" id="main">
    <p>Send BCH to your vault address. It shows as a deposit until you add it to the vault.</p>
    <p class="addr-box"><code id="vault-addr">${addr}</code></p>
    <button class="btn btn-line" data-copy="#vault-addr">Copy address</button>
  </main>`;
}

function screenHome(c: C.VaultConfig, v: C.VaultView | null, back: string): string {
  if (!homeKey) {
    return `${topbar('Home code', back)}
    <main class="screen" id="main">${statusBox()}
      <form data-form="homewords" novalidate>
        <p>Type the 12 words from your paper. They stay in this page's memory and are forgotten when you leave it.</p>
        <label class="field"><span>Home code</span><textarea name="words" rows="3" autocomplete="off" autocapitalize="none" spellcheck="false" class="words-in"></textarea></label>
        <div class="stack stack-end"><button class="btn btn-dark" type="submit">Use home code</button></div>
      </form></main>`;
  }
  if (!v || !v.main) return `${topbar('Home code', back)}<main class="screen" id="main">${statusBox()}<p>Reading the vault...</p></main>`;
  const s = v.state!;
  return `${topbar('Home code', back)}
  <main class="screen" id="main"><p class="who">Home code entered. Nothing here asks Paytaca: this page signs with your home code.</p>${statusBox()}${frozenBox(v, c)}
    <section class="balance"><p class="bal-label">In the vault</p><p class="bal">${bch(v.total)}</p>${bar(v)}</section>
    <section class="block"><h2>Waiting to leave</h2>${pendingList(v, (_p, i) => `<button class="btn btn-sm btn-dark" data-act="cancel-home" data-i="${i}">Cancel this ${bch(_p.sats)}</button>`)}</section>
    <section class="block"><h2>Vault</h2><div class="stack">
      ${s.level < 2 ? `<button class="btn btn-dark" data-act="freeze-home">${s.level === 1 ? 'Freeze fully, allowance too' : 'Freeze vault'}</button>` : ''}
      ${s.level > 0 && !s.unfreezeHome ? `<button class="btn btn-line" data-act="approve-home" data-what="unfreeze">Approve unfreeze</button>` : ''}
      ${!s.recoverHome ? `<button class="btn btn-line" data-act="approve-home" data-what="recover">Approve moving the vault</button>` : ''}
      ${s.recoverHome && (s.recoverGuardian || !c.hasGuardian) ? `<form data-form="recover" class="stack"><label class="field"><span>Move everything to</span><input name="to" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="${C.PREFIX[net]}:..."></label><button class="btn btn-dark" type="submit">Move everything</button></form>` : ''}
      ${s.recoverHome && c.hasGuardian && !s.recoverGuardian ? '<p class="muted">You approved moving the vault. Your guardian needs to approve too.</p>' : ''}
    </div></section>
    <button class="btn btn-line" data-act="forget-home">Forget the home code on this page</button>
  </main>`;
}

function screenSettings(): string {
  const c = saved!.config;
  const code = C.encodeVaultCode(c);
  return `${topbar('Settings', '/vault')}
  <main class="screen" id="main">${statusBox()}
    <dl class="facts-dl">
      <div><dt>Daily allowance</dt><dd>${bch(BigInt(c.allowance))}</dd></div>
      <div><dt>Wait</dt><dd>${c.waitBlocks} blocks, ${C.blocksToText(c.waitBlocks)}</dd></div>
      <div><dt>Guardian</dt><dd>${c.hasGuardian ? 'Yes' : 'None'}</dd></div>
      <div><dt>Vault address</dt><dd class="addr">${contractFor(c).address}</dd></div>
    </dl>
    <h2 class="h-sm">Vault code</h2>
    <p class="small">Your guardian needs this to act on your vault, and you need it to open the vault on another phone. It contains no keys.</p>
    <p class="addr-box"><code id="vault-code">${code}</code></p>
    <button class="btn btn-line" data-copy="#vault-code">Copy vault code</button>
    <h2 class="h-sm">This phone</h2>
    <div class="stack"><button class="btn btn-line" data-act="copy-log">Copy log for support</button><button class="btn btn-line" data-act="disconnect">Disconnect Paytaca</button></div>
  </main>`;
}

function screenGuardian(): string {
  if (!wallet.ready) {
    return `${topbar('Guardian', '/')}
    <main class="screen" id="main">${statusBox()}
      <p>As a guardian you can cancel withdrawals, freeze a vault and approve unfreezing. You can never send its money anywhere.</p>
      <div class="stack"><button class="btn btn-dark" data-act="connect-guardian">Connect my wallet</button></div></main>`;
  }
  const gpk = binToHex(wallet.ownerPk());
  if (!guardianConfig) {
    return `${topbar('Guardian', '/')}
    <main class="screen" id="main">${statusBox()}
      <h2 class="h-sm" style="margin-top:0!important">1. Send this guardian key to the vault owner</h2>
      <p class="addr-box"><code id="gkey">${gpk}</code></p>
      <button class="btn btn-line" data-copy="#gkey">Copy guardian key</button>
      <h2 class="h-sm">2. Paste their vault code</h2>
      <form data-form="gcode" novalidate><label class="field"><span>Vault code</span><textarea name="code" rows="3" autocomplete="off" spellcheck="false"></textarea></label>
      <div class="stack stack-end"><button class="btn btn-dark" type="submit">Open their vault</button></div></form></main>`;
  }
  const v = guardianView;
  if (!v || !v.main) return `${topbar('Guardian', '/')}<main class="screen" id="main">${statusBox()}<p>Reading the vault...</p></main>`;
  const s = v.state!;
  return `${topbar('Guardian', '/')}
  <main class="screen" id="main"><p class="who">You're this vault's guardian. You can stop things, never send.</p>${statusBox()}${frozenBox(v, guardianConfig)}
    <section class="balance"><p class="bal-label">In the vault</p><p class="bal">${bch(v.total)}</p>${bar(v)}</section>
    <section class="block"><h2>Waiting to leave</h2>${pendingList(v, (p, i) => `<button class="btn btn-sm btn-dark" data-act="cancel-guardian" data-i="${i}">Cancel</button>${!p.fast && s.level === 0 ? `<button class="btn btn-sm btn-line" data-act="fast" data-i="${i}">Approve fast</button>` : ''}`)}
      <p class="small muted">Only approve fast if the owner asked you, in a way you trust. Call them first.</p></section>
    <section class="block"><h2>Vault</h2><div class="stack">
      ${s.level < 2 ? `<button class="btn btn-dark" data-act="freeze-guardian">Freeze vault</button>` : ''}
      ${s.level > 0 && !s.unfreezeGuardian ? `<button class="btn btn-line" data-act="approve-guardian" data-what="unfreeze">Approve unfreeze</button>` : ''}
      ${!s.recoverGuardian ? `<button class="btn btn-line" data-act="approve-guardian" data-what="recover">Approve moving the vault</button>` : ''}
    </div></section>
    <nav class="links"><button class="linkish" data-act="refresh">Refresh</button><button class="linkish" data-act="guardian-close">Close this vault</button></nav>
  </main>`;
}

// ---------------- router ----------------

function render() {
  const h = location.hash.replace(/^#/, '') || '/';
  let html: string;
  if (h === '/setup/back') {
    draft.step = Math.max(1, draft.step - 1);
    history.replaceState(null, '', '#/setup');
    return render();
  }
  if (h === '/guardian') html = screenGuardian();
  else if (h === '/connect') html = screenConnect();
  else if (!saved && h === '/setup' && wallet.ready) html = screenSetup();
  else if (!saved || !wallet.ready) html = screenStart();
  else if (!unlocked && h === '/forgot') html = screenForgot();
  else if (!unlocked) html = screenLock();
  else if (h === '/send') html = screenSend();
  else if (h === '/withdraw' && !decoy) html = screenWithdraw();
  else if (h === '/receive') html = screenReceive();
  else if (h === '/home' && !decoy) html = screenHome(saved.config, view, '/vault');
  else if (h === '/settings' && !decoy) html = screenSettings();
  else html = screenVault();
  app.innerHTML = html;
}

// ---------------- events ----------------

function startWallet(next: string) {
  wallet.onQr = async (uri, qrUri) => {
    qr = { uri, img: await QRCode.toDataURL(qrUri, { margin: 1, width: 440 }) };
    go('/connect');
  };
  wallet.onStatus = (t) => setStatus('info', t);
  wallet.onReady = () => {
    log(`wallet ready: ${wallet.name}, owner ${binToHex(wallet.ownerPk()).slice(0, 12)}`);
    qr = null;
    status = null;
    if (next === '/guardian') return go('/guardian');
    if (saved && binToHex(wallet.ownerPk()) !== saved.config.ownerPk) {
      setStatus('err', 'This Paytaca wallet isn\'t the one that owns the vault saved on this phone. Connect that wallet, or open the right network.');
      return go('/');
    }
    if (saved) {
      refresh();
      return go('/vault');
    }
    go('/setup');
  };
  if (wallet.ready) return wallet.onReady();
  wallet.connect(Wallet.hasSavedSession());
}

function pendingAt(v: C.VaultView | null, i: string | undefined) {
  const p = v?.pending[Number(i)];
  if (!p) throw new Error('That withdrawal is gone. Refresh.');
  return p;
}

/** Read the vault again right before building, so a second tap or a slow refresh never builds on a spent coin. */
async function freshPending(c: C.VaultConfig, shown: C.VaultView | null, i: string | undefined) {
  const tapped = pendingAt(shown, i);
  const v = await readConfig(c);
  if (!v.main || !v.state) throw new Error('Couldn\'t find the vault coin. Refresh.');
  return { v, p: C.samePending(v, tapped) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Record each step of a freeze-and-cancel run in the activity list. */
function lockStepActivity(s: C.LockStep, who: string) {
  if (s.what === 'cancel') addActivity(`${who} cancelled a ${bch(s.sats)} withdrawal. The BCH is back in the vault.`, s.txid);
  else if (who === 'Duress PIN') addActivity('Duress PIN froze the vault. Only the allowance can leave.', s.txid);
}

app.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act],[data-copy]');
  if (!el) return;
  if (el.dataset.copy) {
    const t = document.querySelector(el.dataset.copy)?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(t);
      el.textContent = 'Copied';
    } catch {
      el.textContent = 'Copy blocked: press and hold the text';
    }
    return;
  }
  const a = el.dataset.act!;
  const c = saved?.config;
  switch (a) {
    case 'net': {
      net = (el as HTMLInputElement).value as C.Net;
      localStorage.setItem(NET_KEY, net);
      provider = new FallbackNetworkProvider(net, HOSTS[net]);
      saved = load();
      view = null;
      unlocked = false;
      checkNetwork();
      return;
    }
    case 'use-all': {
      const max = walletSats! - C.CREATE_FEE - 6_000n;
      draft.amount = fmtBch(Number(max));
      return render();
    }
    case 'copy-log': {
      const text = [`Holdfast real vault log`, `UA: ${navigator.userAgent}`, `Vault: ${saved ? contractFor(saved.config).address : 'none'}`, ...logLines].join('\n');
      try {
        await navigator.clipboard.writeText(text);
        el.textContent = 'Log copied. Paste it to the developer.';
      } catch {
        el.textContent = 'Copy blocked by the browser.';
      }
      return;
    }
    case 'connect':
      log('connect tapped');
      return startWallet('/vault');
    case 'connect-guardian':
      return startWallet('/guardian');
    case 'refresh':
      setStatus('info', 'Refreshing...');
      await refresh();
      status = null;
      return render();
    case 'pin':
      if (pinEntry.length < 6) pinEntry += el.dataset.d;
      return render();
    case 'pin-del':
      pinEntry = pinEntry.slice(0, -1);
      return render();
    case 'pin-ok': {
      const entry = pinEntry;
      pinEntry = '';
      const hash = await C.pinHash(entry, saved!.salt);
      if (hash === saved!.pin) {
        unlocked = true;
        decoy = false;
        status = null;
        refresh();
        return go('/vault');
      }
      if (hash === saved!.duress) {
        unlocked = true;
        decoy = true;
        status = null;
        go('/vault');
        duressFreeze();
        return;
      }
      setStatus('err', 'Wrong PIN. Try again.');
      return render();
    }
    case 'lock':
      unlocked = false;
      decoy = false;
      return render();
    case 'release':
      return act('Releasing', async () => {
        const { p } = await freshPending(c!, view, el.dataset.i);
        if (!p.ready) throw new Error('The wait isn\'t over on the network yet. Try again after the next block.');
        // No wallet prompt: the contract lets anyone send a withdrawal on once its wait is over.
        return sendLocal(V.buildRelease({ contract: contractFor(c!), pending: p.utxo, to: p.to, fast: p.fast, waitBlocks: c!.waitBlocks, fastBlocks: c!.fastBlocks }));
      });
    case 'cancel-owner':
      return act('Cancelling', async () => {
        const { v, p } = await freshPending(c!, view, el.dataset.i);
        const tb = V.buildMerge({ contract: contractFor(c!), main: v.main!, state: v.state!, other: p.utxo, pk: hexToBin(c!.ownerPk), signer: 'wallet' });
        return wallet.signAndSend(provider, tb, [[0, 'receive', 0]], 'Holdfast: cancel a withdrawal');
      });
    case 'absorb':
      return act('Adding deposits', async () => {
        let txid = '';
        let v = await readConfig(c!);
        const todo = C.mergeableDeposits(v);
        for (const [n, d] of todo.entries()) {
          if (!v.deposits.some((x) => x.txid === d.txid && x.vout === d.vout)) continue;
          const before = v.main;
          const tb = V.buildMerge({ contract: contractFor(c!), main: v.main!, state: v.state!, other: d, pk: hexToBin(c!.ownerPk), signer: 'wallet' });
          txid = await wallet.signAndSend(provider, tb, [[0, 'receive', 0]], `Holdfast: add a deposit to the vault${todo.length > 1 ? ` (${n + 1} of ${todo.length})` : ''}`);
          if (n < todo.length - 1) {
            addActivity(`Added a ${bch(d.satoshis)} deposit to the vault.`, txid);
            v = await C.waitForNewMain(() => readConfig(c!), before, sleep);
          }
        }
        return txid;
      });
    case 'cancel-home':
      return act('Cancelling', async () => {
        const { v, p } = await freshPending(c!, view, el.dataset.i);
        const home = new SignatureTemplate(homeKey!);
        return sendLocal(V.buildMerge({ contract: contractFor(c!), main: v.main!, state: v.state!, other: p.utxo, pk: home.publicKey, signer: home }));
      });
    case 'freeze-home':
      return act('Freezing', async () => {
        const home = new SignatureTemplate(homeKey!);
        const steps = await C.lockDown({
          read: () => readConfig(c!),
          send: sendLocal,
          contract: contractFor(c!),
          key: home,
          mode: 'home',
          onStep: (s) => lockStepActivity(s, 'Home code'),
        });
        const cancelled = steps.filter((s) => s.what === 'cancel').length;
        if (cancelled) nextDone = `Vault frozen and ${cancelled === 1 ? 'one withdrawal' : `${cancelled} withdrawals`} cancelled. Nothing can leave until it is unfrozen.`;
        return steps.find((s) => s.what === 'freeze')?.txid ?? '';
      });
    case 'approve-home':
      return act('Approving', async () => {
        const home = new SignatureTemplate(homeKey!);
        const what = el.dataset.what as 'unfreeze' | 'recover';
        const v = await readConfig(c!);
        if (!c!.hasGuardian) nextDone = what === 'unfreeze' ? 'Vault unfrozen.' : 'Approved. You can now move everything out.';
        return sendLocal(V.buildApprove({ contract: contractFor(c!), main: v.main!, state: v.state!, pk: home.publicKey, ...C.approveRoles(c!, 'home'), signer: home, what }));
      });
    case 'forget-home':
      homeKey = null;
      return go('/vault');
    case 'disconnect':
      await wallet.disconnect();
      unlocked = false;
      return go('/');
    case 'cancel-guardian':
      return act('Cancelling', async () => {
        const gc = guardianConfig!;
        const { v, p } = await freshPending(gc, guardianView, el.dataset.i);
        const tb = V.buildMerge({ contract: contractFor(gc), main: v.main!, state: v.state!, other: p.utxo, pk: hexToBin(gc.guardianPk), signer: 'wallet' });
        return wallet.signAndSend(provider, tb, [[0, 'receive', 0]], 'Holdfast guardian: cancel a withdrawal');
      });
    case 'fast':
      return act('Approving fast lane', async () => {
        const gc = guardianConfig!;
        const { p } = await freshPending(gc, guardianView, el.dataset.i);
        const tb = V.buildApproveFast({ contract: contractFor(gc), pending: p.utxo, to: p.to, guardian: 'wallet' });
        return wallet.signAndSend(provider, tb, [[0, 'receive', 0]], 'Holdfast guardian: approve a fast withdrawal');
      });
    case 'freeze-guardian':
      return act('Freezing', async () => {
        const gc = guardianConfig!;
        const v = await readConfig(gc);
        const tb = V.buildFreeze({ contract: contractFor(gc), main: v.main!, state: v.state!, pk: hexToBin(gc.guardianPk), signer: 'wallet', duress: false });
        // A freeze stops the vault coin, not withdrawals already waiting: those need Cancel.
        if (v.pending.length) nextDone = `Vault frozen. ${v.pending.length === 1 ? 'One withdrawal is' : `${v.pending.length} withdrawals are`} still waiting: cancel ${v.pending.length === 1 ? 'it' : 'them'} below.`;
        return wallet.signAndSend(provider, tb, [[0, 'receive', 0]], 'Holdfast guardian: freeze the vault');
      });
    case 'approve-guardian':
      return act('Approving', async () => {
        const gc = guardianConfig!;
        const v = await readConfig(gc);
        const tb = V.buildApprove({ contract: contractFor(gc), main: v.main!, state: v.state!, pk: hexToBin(gc.guardianPk), ...C.approveRoles(gc, 'guardian'), signer: 'wallet', what: el.dataset.what as 'unfreeze' | 'recover' });
        return wallet.signAndSend(provider, tb, [[0, 'receive', 0]], 'Holdfast guardian: approve');
      });
    case 'guardian-close':
      guardianConfig = null;
      guardianView = null;
      return render();
  }
});

/** Duress PIN: freeze with the panic key and cancel everything waiting, without the wallet or any sign on screen. */
async function duressFreeze() {
  const c = saved!.config;
  const panic = new SignatureTemplate(hexToBin(saved!.panicKey));
  try {
    view = await readConfig(c);
    render();
    await C.lockDown({
      read: () => readConfig(c),
      send: sendLocal,
      contract: contractFor(c),
      key: panic,
      mode: 'duress',
      onStep: (s) => lockStepActivity(s, 'Duress PIN'),
    });
  } catch (e) {
    /* Stay silent on screen: the robber is watching. The owner sees it in the log later. */
    log(`duress run stopped: ${(e as Error).message}`);
  }
  await refresh();
}

app.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  const val = (n: string) => ((f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '').trim();
  const c = saved?.config;
  const err = (t: string) => setStatus('err', t);
  switch (f.dataset.form) {
    case 'setup':
      return setupStep(f, val);
    case 'send': {
      const to = val('to');
      const amount = sats(val('amount'));
      if (!C.isAddressFor(to, net)) return err(`Enter a ${net === 'mainnet' ? 'bitcoincash:' : 'bchtest:'} address.`);
      if (amount === 0n) return err('Enter an amount in BCH, like 0.001');
      if (amount < C.minPayment(to)) return err(`The smallest payment the network accepts is ${bch(C.minPayment(to))}.`);
      if (amount > view!.allowanceLeft) return err(`You can send up to ${bch(view!.allowanceLeft)} right away.${decoy ? '' : ' For more, start a withdrawal.'}`);
      nextDone = `Sent ${bch(amount)}.`;
      return act('Sending', async () => {
        const tb = V.buildSpend({ contract: contractFor(c!), main: view!.main!, state: view!.state!, amount, to, owner: 'wallet', fresh: view!.fresh, refillBlocks: c!.refillBlocks });
        const txid = await wallet.signAndSend(provider, tb, [[0, 'receive', 0]], `Holdfast: send ${bch(amount)}`);
        go('/vault');
        return txid;
      });
    }
    case 'withdraw': {
      const to = val('to');
      const amount = sats(val('amount'));
      const free = C.maxWithdrawal(view!);
      if (!C.isAddressFor(to, net)) return err(`Enter a ${net === 'mainnet' ? 'bitcoincash:' : 'bchtest:'} address.`);
      const least = C.minWithdrawal(to);
      if (amount < least) return err(`The smallest withdrawal is ${bch(least)}: the release pays a ${bch(V.VAULT_FEE)} network fee out of it.`);
      if (amount > free) return err(`At most ${bch(free)} can be withdrawn right now.`);
      nextDone = `Withdrawal of ${bch(amount)} started. It waits ${C.blocksToText(c!.waitBlocks)}.`;
      return act('Starting withdrawal', async () => {
        const tb = V.buildStartWithdrawal({ contract: contractFor(c!), main: view!.main!, state: view!.state!, amount, to, owner: 'wallet' });
        const txid = await wallet.signAndSend(provider, tb, [[0, 'receive', 0]], `Holdfast: start a ${bch(amount)} withdrawal`);
        go('/vault');
        return txid;
      });
    }
    case 'forgot': {
      try {
        const key = C.homeKeyFromWords(val('words'));
        if (binToHex(C.publicKeyOf(key)) !== c!.homePk) return err('Those words are a valid home code, but not this vault\'s.');
        const p = val('pin'), q = val('duress');
        if (!/^\d{4,6}$/.test(p) || !/^\d{4,6}$/.test(q)) return err('Each PIN needs 4 to 6 digits.');
        if (p === q) return err('Your duress PIN must be different from your PIN.');
        if (p.length !== q.length) return err('Make both PINs the same length.');
        saved!.pinLen = p.length;
        saved!.pin = await C.pinHash(p, saved!.salt);
        saved!.duress = await C.pinHash(q, saved!.salt);
        save();
        homeKey = key;
        unlocked = true;
        decoy = false;
        log('PINs reset with the home code');
        setStatus('ok', 'PINs reset. Your vault is open.');
        refresh();
        return go('/vault');
      } catch (ex) {
        return err((ex as Error).message);
      }
    }
    case 'homewords':
      try {
        const key = C.homeKeyFromWords(val('words'));
        if (binToHex(C.publicKeyOf(key)) !== c!.homePk) return err('Those words are a valid home code, but not this vault\'s.');
        homeKey = key;
        status = null;
        return render();
      } catch (ex) {
        return err((ex as Error).message);
      }
    case 'recover': {
      const to = val('to');
      if (!C.isAddressFor(to, net)) return err(`Enter a ${net === 'mainnet' ? 'bitcoincash:' : 'bchtest:'} address.`);
      return act('Moving everything', async () => {
        const home = new SignatureTemplate(homeKey!);
        await C.lockDown({ read: () => readConfig(c!), send: sendLocal, contract: contractFor(c!), key: home, mode: 'cancel', onStep: (s) => lockStepActivity(s, 'Home code') });
        const v = await readConfig(c!);
        return sendLocal(V.buildRecover({ contract: contractFor(c!), main: v.main!, home, to }));
      });
    }
    case 'gcode':
      try {
        const gc = C.decodeVaultCode(val('code'));
        if (gc.net !== net) return err(`That vault is on ${gc.net}. Switch network on the first screen.`);
        if (!gc.hasGuardian || gc.guardianPk !== binToHex(wallet.ownerPk())) return err('This wallet isn\'t the guardian of that vault. Check the owner used your guardian key.');
        guardianConfig = gc;
        status = null;
        await refresh();
      } catch (ex) {
        return err((ex as Error).message);
      }
      return;
  }
});

async function setupStep(f: HTMLFormElement, val: (n: string) => string) {
  const d = draft;
  const err = (t: string) => setStatus('err', t);
  status = null;
  if (d.step === 1) {
    if (sats(val('allowance')) === 0n) return err('Enter an allowance in BCH, like 0.01');
    d.allowance = val('allowance');
    d.waitDays = Number((f.querySelector('input[name="wait"]:checked') as HTMLInputElement)?.value ?? 3);
  } else if (d.step === 2) {
    if (!(f.elements.namedItem('wrote') as HTMLInputElement).checked) return err('Write the words on paper first, then tick the box.');
    if (val('checkword').toLowerCase() !== d.words[d.check - 1]) return err(`That isn't word ${d.check}. Check your paper.`);
  } else if (d.step === 3) {
    const g = val('gpk').toLowerCase();
    if (g && !/^0[23][0-9a-f]{64}$/.test(g)) return err('A guardian key is 66 characters and starts with 02 or 03.');
    d.guardianPk = g;
  } else if (d.step === 4) {
    const p = val('pin'), q = val('duress');
    if (!/^\d{4,6}$/.test(p) || !/^\d{4,6}$/.test(q)) return err('Each PIN needs 4 to 6 digits.');
    if (p === q) return err('Your duress PIN must be different from your PIN.');
    if (p.length !== q.length) return err('Make both PINs the same length, so the lock screen looks the same for either.');
    d.pin = p;
    d.duress = q;
  } else {
    const amount = sats(val('amount'));
    d.amount = val('amount');
    if (amount < 10_000n) return err('Put in at least 0.0001 BCH.');
    return createVault(amount);
  }
  d.step += 1;
  if (d.step === 5) refreshWallet(true).then(render);
  render();
}

async function createVault(amount: bigint) {
  const d = draft;
  await act('Creating your vault', async () => {
    // A record from an earlier try may belong to a vault that did reach the chain
    // (for example the network dropped after sending). Its panic key exists only
    // there, so adopt it instead of overwriting it.
    const earlier = readPendingRecord();
    if (earlier && (await C.resolveEarlierCreation(earlier.config, readConfig)) === 'adopt') {
      saved = earlier;
      save();
      localStorage.removeItem(pendingKey());
      log('adopted vault from an earlier try instead of creating a second one');
      unlocked = true;
      go('/vault');
      nextDone = 'Your vault from the earlier try is on the network. Opened it; nothing new was created.';
      return '';
    }
    const ownerPk = wallet.ownerPk();
    const change = C.p2pkhAddress(ownerPk, net);
    const unlocker = wallet.unlockerFor(net);
    let coins = await wallet.coins(provider, net);
    let plan = C.planCreate(coins, amount);
    log(`wallet coins: ${coins.length}, total ${plan.total}, paths ${coins.map((u) => u.path.join('/') + ':' + u.vout).join(' ')}`);
    if (!plan.enough) throw new Error(`Not enough BCH in Paytaca. You have ${bch(plan.total)}; this needs about ${bch(amount + C.CREATE_FEE + 3_000n)}.`);
    if (plan.needsPrepare) {
      setStatus('info', 'Step 1 of 2: gathering your coins. Approve in Paytaca.');
      const prep = C.buildPrepare({ provider, coins, changeAddress: change, unlocker });
      const plain = coins.filter((u) => !u.token);
      await wallet.signAndSend(provider, prep, plain.map((u, i) => [i, u.path[0], u.path[1]]), 'Holdfast: gather coins to create your vault (1 of 2)');
      for (let n = 0; n < 15; n++) {
        await new Promise((r) => setTimeout(r, 1500));
        coins = await wallet.coins(provider, net);
        plan = C.planCreate(coins, amount);
        if (!plan.needsPrepare) break;
      }
      if (plan.needsPrepare) throw new Error('Your coins were gathered but haven\'t shown up yet. Tap Create vault again in a moment.');
    }
    const genesis = coins.find((u) => u.vout === 0 && !u.token)!;
    const homeKey = C.homeKeyFromWords(d.words.join(' '));
    const panicKey = C.randomPrivateKey();
    const homePk = binToHex(C.publicKeyOf(homeKey));
    const config: C.VaultConfig = {
      v: 1,
      net,
      ownerPk: binToHex(ownerPk),
      homePk,
      guardianPk: d.guardianPk || homePk,
      panicPk: binToHex(C.publicKeyOf(panicKey)),
      hasGuardian: Boolean(d.guardianPk),
      category: genesis.txid,
      allowance: String(sats(d.allowance)),
      waitBlocks: d.waitDays * V.BLOCKS.day,
      fastBlocks: V.BLOCKS.hour,
      refillBlocks: V.BLOCKS.day,
      evictBlocks: V.BLOCKS.week,
    };
    const contract = contractFor(config);
    const { builder, inputs } = C.buildCreateWithFee({ provider, contract, coins, amount, net, changeAddress: change, unlocker });
    setStatus('info', `${plan.needsPrepare ? 'Step 2 of 2: ' : ''}creating the vault. Approve in Paytaca.`);
    // Keep everything needed to use this vault BEFORE asking the wallet to sign,
    // so a reload or a closed tab can never lose a vault that got created.
    const salt = binToHex(crypto.getRandomValues(new Uint8Array(8)));
    const record: Saved = { pinLen: d.pin.length, config, panicKey: binToHex(panicKey), salt, pin: await C.pinHash(d.pin, salt), duress: await C.pinHash(d.duress, salt) };
    localStorage.setItem(pendingKey(), JSON.stringify(record));
    log(`creating vault ${contract.address} code ${C.encodeVaultCode(config)}`);
    const txid = await wallet.signAndSend(provider, builder, inputs.map((u, i) => [i, u.path[0], u.path[1]]), `Holdfast: create your vault with ${bch(amount)}`);
    saved = record;
    save();
    localStorage.removeItem(pendingKey());
    unlocked = true;
    d.words = C.newHomeWords();
    d.pin = d.duress = '';
    d.step = 1;
    go('/vault');
    return txid;
  });
}

window.addEventListener('hashchange', () => {
  status = status?.kind === 'err' ? null : status;
  render();
});
setInterval(() => {
  if (!busy && document.visibilityState === 'visible' && (unlocked || guardianConfig)) refresh();
}, 60_000);

function readPendingRecord(): Saved | null {
  try {
    return JSON.parse(localStorage.getItem(pendingKey()) || 'null');
  } catch {
    return null;
  }
}

/** A creation that was signed but whose page was reloaded before it finished: adopt it if the vault exists on chain. */
async function adoptPending() {
  if (saved) return;
  const rec = readPendingRecord();
  if (!rec) return;
  try {
    const v = await readConfig(rec.config);
    if (v.main) {
      saved = rec;
      save();
      localStorage.removeItem(pendingKey());
      log('adopted vault created before a reload');
      setStatus('ok', 'Found the vault you created before the page reloaded. Enter your PIN to open it.');
      if (Wallet.hasSavedSession()) startWallet('/vault');
    }
  } catch (e) {
    log(`adopt check failed: ${(e as Error).message}`);
  }
}

log('page loaded');
if (saved && Wallet.hasSavedSession()) startWallet('/vault');
else adoptPending();
render();
checkNetwork();
