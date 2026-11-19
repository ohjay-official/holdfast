import * as M from './model';
import * as S from './store';

// ---------------- state ----------------

type Role = 'phone' | 'home' | 'guardian';

let store: S.DemoStore | null = S.load();
let role: Role = 'phone';
let unlocked = false;   // phone app unlocked with the real PIN
let decoy = false;      // phone app opened with the duress PIN
let pinEntry = '';
let flash: { kind: 'ok' | 'err'; text: string } | null = null;
let skipOpen = false;

// Setup wizard draft
const draft = {
  step: 1,
  allowance: '0.05',
  waitDays: 3,
  words: S.demoWords(),
  wroteDown: false,
  checkIndex: 4,
  guardian: 'Ada',
  pin: '1234',
  duressPin: '9999',
  deposit: '1',
};

// Send form draft
const sendDraft = { to: '', amount: '', confirm: false };

const now = () => Date.now() + (store?.clockOffset ?? 0);
const V = () => store!.vault;
const app = document.getElementById('app')!;

function commit() {
  S.save(store);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const bch = (sats: number) => `${M.fmtBch(sats)} BCH`;

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function short(addr: string): string {
  const a = addr.replace(/^bitcoincash:/, '');
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a;
}

function go(path: string) {
  if (location.hash !== '#' + path) location.hash = path;
  else render();
}

function act(fn: () => void, ok?: string) {
  try {
    fn();
    commit();
    if (ok) flash = { kind: 'ok', text: ok };
  } catch (e) {
    if (e instanceof M.RuleError) flash = { kind: 'err', text: e.message };
    else throw e;
  }
}

// ---------------- pieces ----------------

function vaultBar(v: M.VaultState, opts: { decoy?: boolean } = {}): string {
  const t = now();
  const total = Math.max(v.balance, 1);
  const spendable = M.allowanceLeft(v, t);
  const held = M.waitingSats(v);
  const rest = Math.max(0, v.balance - held - spendable);
  if (opts.decoy) {
    return `<div class="vbar" role="img" aria-label="Balance"><span class="seg-now" style="width:100%"></span></div>`;
  }
  const pct = (n: number) => `${((n / total) * 100).toFixed(2)}%`;
  return `
    <div class="vbar" role="img" aria-label="${esc(`${bch(spendable)} spendable now, ${bch(rest)} saved, ${bch(held)} waiting`)}">
      ${spendable ? `<span class="seg-now" style="width:${pct(spendable)}"></span>` : ''}
      ${rest ? `<span class="seg-safe" style="width:${pct(rest)}"></span>` : ''}
      ${held ? `<span class="seg-held" style="width:${pct(held)}"></span>` : ''}
    </div>
    <dl class="vkey">
      <div><dt><i class="k-now"></i>Spendable now</dt><dd>${bch(spendable)}</dd></div>
      <div><dt><i class="k-safe"></i>Saved</dt><dd>${bch(rest)}</dd></div>
      <div><dt><i class="k-held"></i>Waiting</dt><dd>${bch(held)}</dd></div>
    </dl>`;
}

function flashBox(): string {
  if (!flash) return '';
  const f = flash;
  flash = null;
  return `<p class="flash flash-${f.kind}" role="${f.kind === 'err' ? 'alert' : 'status'}">${esc(f.text)}</p>`;
}

/** One plain sentence on who still has to approve an unfreeze. */
function unfreezeLine(need: string[], done: string[]): string {
  const left = need.filter((n) => !done.includes(n));
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  if (!left.length) return 'Everyone has approved.';
  if (need.length === 1) return `To unfreeze, ${list(need)} approves.`;
  if (!done.length) return `To unfreeze, ${list(need)} each approve.`;
  const d = list(done);
  return `${d[0].toUpperCase()}${d.slice(1)} approved. Waiting for ${list(left)}.`;
}

function frozenBox(v: M.VaultState, forRole: Role): string {
  if (!v.frozen) return '';
  void forRole;
  const by = { home: 'your home code', guardian: 'your guardian', panic: 'your duress PIN', phone: 'your phone' }[v.frozenBy ?? 'home'];
  const needs = M.unfreezeNeeds(v);
  const got = v.unfreezeBy;
  const names = { home: 'your home code', guardian: 'your guardian', phone: 'your phone', panic: 'the panic key' };
  return `<div class="notice notice-frozen">
    <h2>Vault frozen</h2>
    <p>Frozen by ${by}. Nothing can leave until it's unfrozen${v.frozenBy === 'panic' ? ', except the daily allowance' : ''}.</p>
    <p class="small">${unfreezeLine(needs.map((r) => names[r]), needs.filter((r) => got.includes(r)).map((r) => names[r]))}</p>
  </div>`;
}

function pendingRow(p: M.Pending, actions: string): string {
  const t = now();
  const ready = M.isReady(p, t);
  return `<li class="pend">
    <div class="pend-top">
      <span class="pend-amt">${bch(p.sats)}</span>
      <span class="tag ${ready ? 'tag-taken' : 'tag-held'}">${ready ? 'Wait over' : `<span data-until="${p.readyAt}">${M.fmtDuration(p.readyAt - t)}</span> left`}</span>
    </div>
    <p class="pend-meta">To ${esc(short(p.to))}. ${p.fast ? 'Fast withdrawal approved by guardian. ' : ''}${ready ? 'Can be released now.' : `Releases ${when(p.readyAt)}.`}</p>
    ${actions ? `<div class="row-actions">${actions}</div>` : ''}
  </li>`;
}

function demoBar(): string {
  if (!store) return '';
  const tabs: [Role, string][] = [['phone', 'Phone'], ['home', 'Home code'], ['guardian', 'Guardian']];
  const g = V().guardian;
  return `<aside class="demobar" aria-label="Demo controls">
    <p class="guide">${guideText()}</p>
    <div class="demorow">
      <div class="seg" role="tablist" aria-label="Act as">
        ${tabs
          .filter(([r]) => r !== 'guardian' || g)
          .map(([r, l]) => `<button role="tab" aria-selected="${role === r}" data-act="role" data-role="${r}">${r === 'guardian' ? esc(g!) : l}</button>`)
          .join('')}
      </div>
      <button class="ghost" data-act="skip-toggle" aria-expanded="${skipOpen}">Skip ahead</button>
    </div>
    ${skipOpen ? `<div class="skiprow">
      <button class="ghost" data-act="skip" data-ms="${M.HOUR}">1 hour</button>
      <button class="ghost" data-act="skip" data-ms="${M.DAY}">1 day</button>
      <button class="ghost" data-act="skip" data-ms="${3 * M.DAY}">3 days</button>
      <button class="ghost" data-act="skip" data-ms="${31 * M.DAY}">31 days</button>
    </div>` : ''}
  </aside>`;
}

function guideText(): string {
  const v = V();
  const kinds = new Set(v.activity.map((a) => a.kind));
  if (!kinds.has('withdraw-start') && !kinds.has('spend'))
    return `<b>Demo:</b> play the robber. On <i>Phone</i>, tap Send and send everything.`;
  if (M.waiting(v).length && !kinds.has('withdraw-cancel'))
    return `<b>Next:</b> switch to <i>Home code</i> and cancel the waiting withdrawal.`;
  if (v.frozen && v.frozenBy === 'panic')
    return `<b>Duress PIN used.</b> The robber sees only the allowance, and the rest is quietly frozen. Switch to <i>Home code</i> to see the real vault.`;
  if (!kinds.has('freeze')) return `<b>Next:</b> freeze the vault from <i>Home code</i>${v.guardian ? ' or your guardian' : ''}.`;
  if (v.frozen) return `<b>Next:</b> unfreeze it. Approve as <i>Home code</i>${v.guardian ? ', then as your guardian' : ''}.`;
  if (!kinds.has('fast-approve') && v.guardian)
    return `<b>Also try:</b> lock the phone and open it with the duress PIN <b>${esc(store!.duressPin)}</b>, or start a withdrawal and have your guardian approve it fast.`;
  return `<b>Also try:</b> lock the phone and open it with the duress PIN <b>${esc(store!.duressPin)}</b>.`;
}

function topbar(title?: string, back?: string): string {
  return `<header class="topbar">
    ${back ? `<a class="back" href="#${back}">Back</a>` : `<a class="mark" href="/" aria-label="Holdfast website"><svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><path d="M16 4l10 4.4v6.4c0 6.6-4.4 11-10 13.2C10.4 25.8 6 21.4 6 14.8V8.4z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><circle cx="16" cy="14.2" r="2.7" fill="currentColor"/><path d="M16 16.4v5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>Holdfast</a>`}
    ${title ? `<h1 class="tb-title">${esc(title)}</h1>` : ''}
    ${store ? `<span class="demo-chip">Demo</span>` : ''}
  </header>`;
}

// ---------------- screens ----------------

function screenEntry(): string {
  return `${topbar()}
  <main class="screen" id="main">
    <h1 class="big">Open your vault</h1>
    ${store ? `
      <section class="panel">
        <h2>Your demo vault</h2>
        <p>${bch(V().balance)} of pretend BCH, saved in this browser.</p>
        <div class="stack"><button class="btn btn-dark" data-act="continue">Continue the demo</button>
        <button class="btn btn-line" data-act="reset">Delete it and start over</button></div>
      </section>` : `
      <section class="panel">
        <h2>Try the demo</h2>
        <p>A ready-made vault with 1 pretend BCH, no wallet needed. Play the robber, then stop yourself from home.</p>
        <div class="stack"><a class="btn btn-dark" href="#/quick">Start the demo</a>
        <a class="btn btn-line" href="#/new">Set up a vault step by step</a></div>
      </section>`}
    <section class="panel panel-quiet">
      <h2>Make a real vault</h2>
      <p>Connect Paytaca and lock real BCH in a Holdfast vault, on mainnet or the chipnet test network.</p>
      <a class="btn btn-line" href="/real/">Open the real vault app</a>
    </section>
  </main>`;
}

function screenNew(): string {
  const d = draft;
  const total = 6;
  const head = (t: string, help: string) => `
    <p class="stepno">Step ${d.step} of ${total}</p>
    <div class="progress" aria-hidden="true"><span style="width:${(d.step / total) * 100}%"></span></div>
    <h1 class="big">${t}</h1><p class="help">${help}</p>`;
  let body = '';
  if (d.step === 1) {
    body = `${head('Daily allowance', 'The most your phone can send right away in a day. If you\'re ever robbed, this is what you hand over.')}
      <label class="field"><span>Allowance in BCH</span>
        <input name="allowance" inputmode="decimal" autocomplete="off" value="${esc(d.allowance)}" required></label>
      <p class="small muted">It refills after 24 hours with no spending.</p>`;
  } else if (d.step === 2) {
    body = `${head('How long bigger withdrawals wait', 'Anything over the allowance waits this long before it leaves. During the wait, you can cancel it.')}
      <fieldset class="days"><legend class="sr">Wait in days</legend>
        ${[1, 2, 3, 4, 5, 6, 7].map((n) => `<label><input type="radio" name="wait" value="${n}" ${d.waitDays === n ? 'checked' : ''}><span>${n} ${n === 1 ? 'day' : 'days'}</span></label>`).join('')}
      </fieldset>
      <p class="small muted">3 days is the default. Longer is safer, shorter is handier.</p>`;
  } else if (d.step === 3) {
    body = `${head('Write down your home code', 'These 12 words are a second key. Keep them on paper at home, never on this phone. They cancel withdrawals, freeze the vault and help you recover it.')}
      <ol class="words">${d.words.map((w) => `<li>${w}</li>`).join('')}</ol>
      <p class="small muted">Demo words only. They aren't a real key.</p>
      <label class="check"><input type="checkbox" name="wrote" ${d.wroteDown ? 'checked' : ''}> I've written these down</label>
      <label class="field"><span>To check, type word ${d.checkIndex}</span>
        <input name="checkword" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>`;
  } else if (d.step === 4) {
    body = `${head('Add a guardian', 'Someone you trust to cancel and freeze. They can never send your money anywhere. In the demo, you play them too.')}
      <label class="field"><span>Guardian's name</span>
        <input name="guardian" autocomplete="off" value="${esc(d.guardian)}" maxlength="24"></label>
      <p class="small muted">In the real app they open Holdfast, tap I'm someone's guardian, connect their own wallet and send you their guardian key.</p>`;
  } else if (d.step === 5) {
    body = `${head('Set your PINs', 'Your PIN opens the app. Your duress PIN opens a version that shows only the allowance, and quietly freezes everything else.')}
      <label class="field"><span>PIN</span><input name="pin" inputmode="numeric" pattern="[0-9]{4,6}" autocomplete="off" value="${esc(d.pin)}" required></label>
      <label class="field"><span>Duress PIN</span><input name="duress" inputmode="numeric" pattern="[0-9]{4,6}" autocomplete="off" value="${esc(d.duressPin)}" required></label>
      <p class="small muted">4 to 6 digits each, and they must be different.</p>`;
  } else {
    const a = M.toSats(d.allowance);
    body = `${head('Check and fund', 'Here are your rules. Once the vault is funded, the contract enforces them.')}
      <ul class="review">
        <li>Your phone can send up to <b>${bch(a)}</b> a day right away.</li>
        <li>Anything more waits <b>${d.waitDays} ${d.waitDays === 1 ? 'day' : 'days'}</b>, and can be cancelled.</li>
        <li>Your home code can cancel, freeze and recover.</li>
        <li>${d.guardian ? `<b>${esc(d.guardian)}</b> can cancel, freeze, approve fast withdrawals and help recover.` : 'No guardian: your home code works alone.'}</li>
        <li>PIN <b>${esc(d.pin)}</b> opens the app. Duress PIN <b>${esc(d.duressPin)}</b> freezes it quietly.</li>
      </ul>
      <label class="field"><span>Pretend BCH to add</span>
        <input name="deposit" inputmode="decimal" autocomplete="off" value="${esc(d.deposit)}" required></label>`;
  }
  return `${topbar(undefined, d.step > 1 ? '/new/back' : '/')}
  <main class="screen" id="main">
    ${flashBox()}
    <form data-form="new" novalidate>
      ${body}
      <div class="stack stack-end">
        <button class="btn btn-dark" type="submit">${d.step === 6 ? `Create vault and add ${esc(d.deposit)} BCH` : 'Continue'}</button>
        ${d.step === 4 ? `<button class="btn btn-line" type="button" data-act="no-guardian">Skip, no guardian</button>` : ''}
      </div>
    </form>
  </main>`;
}

function screenLock(): string {
  const dots = Array.from({ length: Math.max(4, pinEntry.length) }, (_, i) => `<i class="${i < pinEntry.length ? 'on' : ''}"></i>`).join('');
  return `${topbar()}
  <main class="screen screen-lock" id="main">
    <h1 class="big center">Enter your PIN</h1>
    ${flashBox()}
    <div class="dots" aria-label="${pinEntry.length} digits entered">${dots}</div>
    <div class="pad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-act="pin" data-d="${n}">${n}</button>`).join('')}
      <button data-act="pin-del" aria-label="Delete">Delete</button>
      <button data-act="pin" data-d="0">0</button>
      <button data-act="pin-ok" class="pad-ok">Open</button>
    </div>
    <p class="small muted center">Demo PINs: <b>${esc(store!.pin)}</b> opens the app, <b>${esc(store!.duressPin)}</b> is the duress PIN.</p>
  </main>`;
}

function screenVault(): string {
  const v = V();
  const t = now();
  const refill = M.allowanceRefillsAt(v, t);
  const list = M.waiting(v);
  if (decoy) {
    const left = M.allowanceLeft(v, t);
    return `${topbar()}
    <main class="screen" id="main">
      ${flashBox()}
      <section class="balance">
        <p class="bal-label">Balance</p>
        <p class="bal">${bch(left)}</p>
        ${vaultBar(v, { decoy: true })}
      </section>
      <div class="actions2">
        <a class="btn btn-dark" href="#/send">Send</a>
        <a class="btn btn-line" href="#/receive">Receive</a>
      </div>
      <nav class="links"><a href="#/activity">Activity</a><button class="linkish" data-act="lock">Lock</button></nav>
    </main>`;
  }
  return `${topbar()}
  <main class="screen" id="main">
    ${flashBox()}
    ${frozenBox(v, 'phone')}
    ${M.homeCheckDue(v, t) ? `<div class="notice"><h2>Check your home code</h2><p>It's been 30 days. Make sure you can still find it, then confirm with it under Home code.</p></div>` : ''}
    <section class="balance">
      <p class="bal-label">In your vault</p>
      <p class="bal">${bch(v.balance)}</p>
      ${vaultBar(v)}
      ${refill ? `<p class="small muted">Allowance full again in <span data-until="${refill}">${M.fmtDuration(refill - t)}</span>.</p>` : ''}
    </section>
    <div class="actions2">
      <a class="btn btn-dark" href="#/send">Send</a>
      <a class="btn btn-line" href="#/receive">Receive</a>
    </div>
    ${list.length ? `<section class="block"><h2>Waiting to leave</h2><ul class="pends">${list.map((p) => pendingRow(p, `<a class="btn btn-sm btn-line" href="#/pending/${p.id}">Details</a>`)).join('')}</ul></section>` : ''}
    <nav class="links"><a href="#/activity">Activity</a><a href="#/settings">Settings</a><button class="linkish" data-act="lock">Lock</button></nav>
  </main>`;
}

function screenSend(): string {
  const v = V();
  const t = now();
  const sats = M.toSats(sendDraft.amount);
  const left = M.allowanceLeft(v, t);
  const max = decoy ? left : M.available(v);
  let preview = '';
  if (sendDraft.confirm && sats > 0) {
    const instant = Math.min(sats, left);
    const rest = sats - instant;
    preview = `<section class="confirm">
      <h2>Check before sending</h2>
      <ul class="split-list">
        ${instant ? `<li><span class="sw sw-taken"></span><span><b>${bch(instant)}</b> leaves now.</span></li>` : ''}
        ${rest ? `<li><span class="sw sw-held"></span><span><b>${bch(rest)}</b> waits ${v.waitDays} ${v.waitDays === 1 ? 'day' : 'days'}, until ${when(t + v.waitDays * M.DAY)}. It can be cancelled until then.</span></li>` : ''}
      </ul>
      <p class="small muted">To ${esc(short(sendDraft.to))}</p>
      <div class="stack"><button class="btn btn-dark" data-act="send-go">Send ${bch(sats)}</button>
      <button class="btn btn-line" data-act="send-edit">Change</button></div>
    </section>`;
  }
  return `${topbar('Send', '/vault')}
  <main class="screen" id="main">
    ${flashBox()}
    ${preview || `<form data-form="send" novalidate>
      <label class="field"><span>To</span>
        <input name="to" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="bitcoincash:..." value="${esc(sendDraft.to)}" required></label>
      <p class="small"><button type="button" class="linkish" data-act="sample">Use a sample address</button></p>
      <label class="field"><span>Amount in BCH</span>
        <input name="amount" inputmode="decimal" autocomplete="off" value="${esc(sendDraft.amount)}" required></label>
      ${max > 0 ? `<p class="small"><button type="button" class="linkish" data-act="send-all" data-max="${max}">Send all: ${bch(max)}</button></p>` : ''}
      ${decoy ? '' : `<p class="small muted">Up to ${bch(left)} leaves right away. Anything more waits ${v.waitDays} ${v.waitDays === 1 ? 'day' : 'days'}.</p>`}
      <div class="stack stack-end"><button class="btn btn-dark" type="submit">Review</button></div>
    </form>`}
  </main>`;
}

function screenPending(id: number): string {
  const v = V();
  const p = v.pending.find((x) => x.id === id);
  if (!p) return screenMissing();
  const t = now();
  const ready = M.isReady(p, t);
  const status = p.status === 'released' ? 'Released' : p.status === 'cancelled' ? 'Cancelled' : ready ? 'Wait over' : 'Waiting';
  return `${topbar('Withdrawal', '/vault')}
  <main class="screen" id="main">
    ${flashBox()}
    <p class="bal">${bch(p.sats)}</p>
    <dl class="facts-dl">
      <div><dt>Status</dt><dd>${status}</dd></div>
      <div><dt>To</dt><dd class="addr">${esc(p.to)}</dd></div>
      <div><dt>Started</dt><dd>${when(p.createdAt)}</dd></div>
      <div><dt>${p.status === 'waiting' ? 'Releases' : 'Closed'}</dt><dd>${when(p.closedAt ?? p.readyAt)}${p.status === 'waiting' && !ready ? `, in <span data-until="${p.readyAt}">${M.fmtDuration(p.readyAt - t)}</span>` : ''}</dd></div>
    </dl>
    ${p.status === 'waiting' ? `<div class="stack">
      ${ready ? `<button class="btn btn-dark" data-act="release" data-id="${p.id}">Release to recipient</button>` : ''}
      <button class="btn btn-line" data-act="cancel" data-id="${p.id}" data-by="phone">Cancel withdrawal</button>
    </div>
    ${!ready && v.guardian && !p.fast ? `<p class="small muted">Need it sooner? Ask ${esc(v.guardian)} to approve a fast withdrawal. It then leaves about an hour after you started it.</p>` : ''}` : ''}
  </main>`;
}

function screenReceive(): string {
  return `${topbar('Receive', '/vault')}
  <main class="screen" id="main">
    ${flashBox()}
    <p>${decoy ? 'Send BCH to this address.' : 'Send BCH to this vault address. It shows as a deposit until you add it to the vault.'}</p>
    <p class="addr-box"><code id="vault-addr">${decoy ? S.WALLET_ADDRESS : S.VAULT_ADDRESS}</code></p>
    <div class="stack"><button class="btn btn-line" data-copy="#vault-addr">Copy address</button>
    ${decoy ? '' : '<button class="btn btn-dark" data-act="deposit">Add 0.50 pretend BCH</button>'}</div>
    <p class="small muted">Demo address. Don't send real BCH to it.</p>
  </main>`;
}

const actLabel: Record<M.Activity['kind'], string> = {
  created: 'Vault created',
  deposit: 'Deposit',
  spend: 'Sent from allowance',
  'withdraw-start': 'Withdrawal started',
  'withdraw-release': 'Withdrawal released',
  'withdraw-cancel': 'Withdrawal cancelled',
  'fast-approve': 'Fast withdrawal approved',
  freeze: 'Vault frozen',
  unfreeze: 'Vault unfrozen',
  recover: 'Recovered to a new phone',
  'guardian-remove-start': 'Guardian removal started',
  'guardian-removed': 'Guardian removed',
  'home-check': 'Home code checked',
  settings: 'Settings changed',
};
const byLabel: Record<M.Role, string> = { phone: 'phone', home: 'home code', guardian: 'guardian', panic: 'duress PIN' };

function screenActivity(): string {
  const v = V();
  let items = v.activity;
  // The decoy shows nothing that would give the duress PIN away.
  if (decoy) items = items.filter((a) => a.kind === 'spend' || a.kind === 'deposit');
  return `${topbar('Activity', '/vault')}
  <main class="screen" id="main">
    <ul class="acts">${items
      .map(
        (a) => `<li><div><b>${actLabel[a.kind]}</b>${a.by && !decoy ? ` <span class="muted">by ${byLabel[a.by]}</span>` : ''}<br><span class="small muted">${when(a.at)}</span></div>${a.sats ? `<span class="amt">${a.kind === 'deposit' ? '+' : ''}${M.fmtBch(a.sats)}</span>` : ''}</li>`,
      )
      .join('') || '<li>No activity yet.</li>'}</ul>
  </main>`;
}

function screenSettings(): string {
  const v = V();
  return `${topbar('Settings', '/vault')}
  <main class="screen" id="main">
    ${flashBox()}
    <dl class="facts-dl">
      <div><dt>Daily allowance</dt><dd>${bch(v.allowance)}</dd></div>
      <div><dt>Wait for bigger withdrawals</dt><dd>${v.waitDays} ${v.waitDays === 1 ? 'day' : 'days'}</dd></div>
      <div><dt>Guardian</dt><dd>${v.guardian ? esc(v.guardian) : 'None'}${v.guardianRemovalAt ? `, removal possible ${when(v.guardianRemovalAt)}` : ''}</dd></div>
      <div><dt>Home code last checked</dt><dd>${when(v.homeCheckedAt)}</dd></div>
      <div><dt>Phone key</dt><dd>Phone ${v.phoneId}</dd></div>
    </dl>
    <p class="small muted">The allowance and wait are part of the contract. To change them, you'd move your BCH to a new vault.</p>
    <h2 class="h-sm">Demo</h2>
    <div class="stack"><button class="btn btn-line" data-act="reset">Delete this demo vault</button></div>
  </main>`;
}

function screenHome(): string {
  const v = V();
  const t = now();
  const list = M.waiting(v);
  const recoverNeeds = M.unfreezeNeeds(v);
  return `${topbar('Home code')}
  <main class="screen" id="main">
    <p class="who">You're using the 12 words you keep at home.</p>
    ${flashBox()}
    ${frozenBox(v, 'home')}
    <section class="balance"><p class="bal-label">In the vault</p><p class="bal">${bch(v.balance)}</p>${vaultBar(v)}</section>
    <section class="block"><h2>Waiting to leave</h2>
      ${list.length ? `<ul class="pends">${list.map((p) => pendingRow(p, `<button class="btn btn-sm btn-dark" data-act="cancel" data-id="${p.id}" data-by="home">Cancel withdrawal</button>`)).join('')}</ul>` : '<p class="muted">Nothing is waiting.</p>'}
    </section>
    <section class="block"><h2>Vault</h2>
      <div class="stack">
        ${!v.frozen ? `<button class="btn btn-dark" data-act="freeze" data-by="home">Freeze vault</button>` : ''}${v.frozen && v.frozenBy === 'panic' ? `<button class="btn btn-dark" data-act="freeze" data-by="home">Freeze fully, allowance too</button>` : ''}${v.frozen ? (v.unfreezeBy.includes('home') ? `<p class="muted">You approved unfreezing. Waiting for ${esc(v.guardian ?? '')}.</p>` : `<button class="btn btn-line" data-act="unfreeze" data-by="home">Approve unfreeze</button>`) : ''}
        ${store!.recoverBy.includes('home') ? `<p class="muted">You approved moving to a new phone. Waiting for ${esc(v.guardian ?? '')}.</p>` : `<button class="btn btn-line" data-act="recover" data-by="home">Move vault to a new phone</button>`}
        <button class="btn btn-line" data-act="home-check">Confirm I still have my home code</button>
      </div>
      ${recoverNeeds.length > 1 ? `<p class="small muted">Unfreezing and moving to a new phone need your home code and ${esc(v.guardian!)}.</p>` : ''}
    </section>
    ${v.guardian ? `<section class="block"><h2>Guardian</h2>
      ${v.guardianRemovalAt
        ? t >= v.guardianRemovalAt
          ? `<button class="btn btn-line" data-act="guardian-finish">Remove ${esc(v.guardian)} now</button>`
          : `<p class="muted">${esc(v.guardian)} can be removed in <span data-until="${v.guardianRemovalAt}">${M.fmtDuration(v.guardianRemovalAt - t)}</span>.</p>`
        : `<button class="btn btn-line" data-act="guardian-start">Start removing ${esc(v.guardian)}</button><p class="small muted">Takes 7 days, so someone with your phone can't do it quietly.</p>`}
    </section>` : ''}
  </main>`;
}

function screenGuardian(): string {
  const v = V();
  const list = M.waiting(v);
  const g = v.guardian;
  if (!g) return screenMissing();
  return `${topbar('Guardian')}
  <main class="screen" id="main">
    <p class="who">You're ${esc(g)}, guardian for this vault. You can stop things, never send.</p>
    ${flashBox()}
    ${frozenBox(v, 'guardian')}
    <section class="balance"><p class="bal-label">In the vault</p><p class="bal">${bch(v.balance)}</p>${vaultBar(v)}</section>
    <section class="block"><h2>Waiting to leave</h2>
      ${list.length ? `<ul class="pends">${list.map((p) => pendingRow(p, `<button class="btn btn-sm btn-dark" data-act="cancel" data-id="${p.id}" data-by="guardian">Cancel withdrawal</button>${!p.fast && !v.frozen ? `<button class="btn btn-sm btn-line" data-act="fast" data-id="${p.id}">Approve fast</button>` : ''}`)).join('')}</ul>
      <p class="small muted">Only approve fast if the owner asked you to, in a way you trust. Call them first.</p>` : '<p class="muted">Nothing is waiting.</p>'}
    </section>
    <section class="block"><h2>Vault</h2>
      <div class="stack">
        ${!v.frozen ? `<button class="btn btn-dark" data-act="freeze" data-by="guardian">Freeze vault</button>` : ''}${v.frozen && v.frozenBy === 'panic' ? `<button class="btn btn-dark" data-act="freeze" data-by="guardian">Freeze fully, allowance too</button>` : ''}${v.frozen ? (v.unfreezeBy.includes('guardian') ? `<p class="muted">You approved unfreezing. Waiting for the home code.</p>` : `<button class="btn btn-line" data-act="unfreeze" data-by="guardian">Approve unfreeze</button>`) : ''}
        ${store!.recoverBy.includes('home') && !store!.recoverBy.includes('guardian') ? `<button class="btn btn-line" data-act="recover" data-by="guardian">Approve move to a new phone</button>` : ''}
      </div>
    </section>
  </main>`;
}

function screenMissing(): string {
  return `${topbar()}
  <main class="screen" id="main"><h1 class="big">Nothing here</h1><p>That screen doesn't exist or the item is gone.</p><a class="btn btn-dark" href="#/">Go to the start</a></main>`;
}

// A ready-made vault, so the first tap lands on the point.
function quickStart() {
  const words = S.demoWords();
  const vault = M.createVault({ allowanceSats: M.SATS / 20, waitDays: 3, guardian: 'Ada', depositSats: M.SATS }, Date.now());
  store = { vault, clockOffset: 0, pin: '1234', duressPin: '9999', homeWords: words, recoverBy: [] };
  commit();
  role = 'phone'; unlocked = true; decoy = false;
  flash = { kind: 'ok', text: 'Demo vault ready: 1 BCH, 0.05 BCH a day, 3-day wait, Ada as guardian.' };
  history.replaceState(null, '', '#/vault');
  render();
}

// ---------------- router ----------------

function render() {
  const h = location.hash.replace(/^#/, '') || '/';
  let html: string;
  if (h === '/new/back') {
    draft.step = Math.max(1, draft.step - 1);
    history.replaceState(null, '', '#/new');
    return render();
  }
  if (h === '/quick') {
    quickStart();
    return;
  }
  if (h === '/new') html = screenNew();
  else if (!store || h === '/') html = screenEntry();
  else if (role === 'home') html = screenHome();
  else if (role === 'guardian') html = screenGuardian();
  else if (!unlocked) html = screenLock();
  else if (h === '/vault') html = screenVault();
  else if (h === '/send') html = screenSend();
  else if (h === '/receive') html = screenReceive();
  else if (h === '/activity') html = screenActivity();
  else if (h === '/settings' && !decoy) html = screenSettings();
  else if (h.startsWith('/pending/') && !decoy) html = screenPending(Number(h.split('/')[2]));
  else html = screenMissing();
  app.innerHTML = html + (h !== '/' && h !== '/new' ? demoBar() : '');
  document.body.dataset.role = store && h !== '/' && h !== '/new' ? role : '';
}

// ---------------- events ----------------

app.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act],[data-copy]');
  if (!el) return;
  if (el.dataset.copy) {
    const t = document.querySelector(el.dataset.copy)?.textContent ?? '';
    try { await navigator.clipboard.writeText(t); el.textContent = 'Copied'; } catch { el.textContent = 'Copy blocked: press and hold the address'; }
    return;
  }
  const a = el.dataset.act!;
  const t = now();
  switch (a) {
    case 'continue': role = 'phone'; unlocked = false; return go('/vault');
    case 'reset':
      store = null; commit(); role = 'phone'; unlocked = false; decoy = false;
      Object.assign(draft, { step: 1, words: S.demoWords(), wroteDown: false });
      return go('/');
    case 'no-guardian': draft.guardian = ''; draft.step = 5; return render();
    case 'role':
      role = el.dataset.role as Role;
      if (role === 'phone') { unlocked = false; decoy = false; pinEntry = ''; }
      return go('/vault');
    case 'skip-toggle': skipOpen = !skipOpen; return render();
    case 'skip': {
      const ms = Number(el.dataset.ms);
      store!.clockOffset += ms; commit();
      flash = { kind: 'ok', text: `Skipped ahead ${M.fmtDuration(ms)}. It's now ${when(now())}.` };
      return render();
    }
    case 'pin':
      if (pinEntry.length < 6) pinEntry += el.dataset.d;
      return render();
    case 'pin-del': pinEntry = pinEntry.slice(0, -1); return render();
    case 'pin-ok':
      if (pinEntry === store!.pin) { unlocked = true; decoy = false; }
      else if (pinEntry === store!.duressPin) {
        act(() => M.freeze(V(), 'panic', t));
        unlocked = true; decoy = true;
      } else flash = { kind: 'err', text: 'Wrong PIN. Try again.' };
      pinEntry = '';
      return go('/vault');
    case 'lock': unlocked = false; decoy = false; return go('/vault');
    case 'sample': keepSendInputs(); sendDraft.to = S.SAMPLE_ADDRESS; return render();
    case 'send-all': keepSendInputs(); sendDraft.amount = M.fmtBch(Number(el.dataset.max)); return render();
    case 'send-edit': sendDraft.confirm = false; return render();
    case 'send-go': {
      const sats = M.toSats(sendDraft.amount);
      let res: { now: number; waiting: M.Pending | null } | null = null;
      act(() => { res = M.send(V(), sats, sendDraft.to, t); });
      sendDraft.confirm = false;
      if (res) {
        const r = res as { now: number; waiting: M.Pending | null };
        flash = { kind: 'ok', text: r.waiting
          ? `Sent ${bch(r.now)}. ${bch(r.waiting.sats)} is waiting until ${when(r.waiting.readyAt)}.`
          : `Sent ${bch(r.now)}.` };
        sendDraft.to = ''; sendDraft.amount = '';
        return go('/vault');
      }
      return render();
    }
    case 'release': act(() => M.release(V(), Number(el.dataset.id), t), 'Released to the recipient.'); return render();
    case 'cancel': act(() => M.cancel(V(), Number(el.dataset.id), el.dataset.by as M.Role, t), 'Withdrawal cancelled. The BCH stays in the vault.'); return render();
    case 'fast': act(() => M.approveFast(V(), Number(el.dataset.id), t), 'Fast withdrawal approved. It can leave about an hour after it started.'); return render();
    case 'freeze': act(() => M.freeze(V(), el.dataset.by as M.Role, t), 'Vault frozen. Nothing can leave until it\'s unfrozen.'); return render();
    case 'unfreeze': {
      let done = false;
      act(() => { done = M.approveUnfreeze(V(), el.dataset.by as M.Role, t); });
      if (!flash) flash = { kind: 'ok', text: done ? 'Vault unfrozen.' : 'Approved. One more approval needed.' };
      return render();
    }
    case 'recover': {
      const by = el.dataset.by as M.Role;
      if (!store!.recoverBy.includes(by)) store!.recoverBy.push(by);
      const needs = M.unfreezeNeeds(V());
      if (needs.every((r) => store!.recoverBy.includes(r))) {
        act(() => M.recover(V(), store!.recoverBy, t), 'Moved to a new phone. Anything waiting was cancelled, and the old phone can\'t spend.');
        store!.recoverBy = [];
      } else flash = { kind: 'ok', text: 'Approved. Now approve as the guardian too.' };
      commit();
      return render();
    }
    case 'home-check': act(() => M.checkHomeCode(V(), t), 'Home code checked. We\'ll remind you in 30 days.'); return render();
    case 'guardian-start': act(() => M.startGuardianRemoval(V(), t), 'Removal started. It finishes in 7 days.'); return render();
    case 'guardian-finish': act(() => M.finishGuardianRemoval(V(), t), 'Guardian removed.'); return render();
    case 'deposit': act(() => M.deposit(V(), M.SATS / 2, t), 'Added 0.50 BCH.'); return render();
  }
});

function keepSendInputs() {
  const f = app.querySelector<HTMLFormElement>('form[data-form="send"]');
  if (!f) return;
  sendDraft.to = (f.elements.namedItem('to') as HTMLInputElement).value.trim();
  sendDraft.amount = (f.elements.namedItem('amount') as HTMLInputElement).value.trim();
}

app.addEventListener('submit', (e) => {
  const f = e.target as HTMLFormElement;
  e.preventDefault();
  const val = (n: string) => ((f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '').trim();
  if (f.dataset.form === 'send') {
    keepSendInputs();
    const sats = M.toSats(sendDraft.amount);
    if (!/^bitcoincash:[a-z0-9]{20,}$/.test(sendDraft.to)) flash = { kind: 'err', text: 'Enter a Bitcoin Cash address starting with bitcoincash:' };
    else if (!(sats > 0)) flash = { kind: 'err', text: 'Enter an amount in BCH, like 0.1' };
    else sendDraft.confirm = true;
    return render();
  }
  if (f.dataset.form === 'new') {
    const d = draft;
    const err = (t: string) => { flash = { kind: 'err', text: t }; render(); };
    if (d.step === 1) {
      const s = M.toSats(val('allowance'));
      if (!(s > 0)) return err('Enter an allowance in BCH, like 0.05');
      d.allowance = val('allowance');
    } else if (d.step === 2) {
      d.waitDays = Number((f.querySelector('input[name="wait"]:checked') as HTMLInputElement)?.value ?? 3);
    } else if (d.step === 3) {
      d.wroteDown = (f.elements.namedItem('wrote') as HTMLInputElement).checked;
      if (!d.wroteDown) return err('Write the words down first, then tick the box.');
      if (val('checkword').toLowerCase() !== d.words[d.checkIndex - 1]) return err(`That isn't word ${d.checkIndex}. Check your paper.`);
    } else if (d.step === 4) {
      d.guardian = val('guardian');
    } else if (d.step === 5) {
      const p = val('pin'), q = val('duress');
      if (!/^\d{4,6}$/.test(p) || !/^\d{4,6}$/.test(q)) return err('Each PIN needs 4 to 6 digits.');
      if (p === q) return err('Your duress PIN must be different from your PIN.');
      d.pin = p; d.duressPin = q;
    } else {
      const dep = M.toSats(val('deposit'));
      if (!(dep > 0)) return err('Enter how much pretend BCH to add, like 1');
      if (dep > 1000 * M.SATS) return err('Keep the demo under 1,000 BCH.');
      d.deposit = val('deposit');
      try {
        const vault = M.createVault({ allowanceSats: M.toSats(d.allowance), waitDays: d.waitDays, guardian: d.guardian || null, depositSats: dep }, Date.now());
        store = { vault, clockOffset: 0, pin: d.pin, duressPin: d.duressPin, homeWords: d.words, recoverBy: [] };
        commit();
      } catch (ex) {
        if (ex instanceof M.RuleError) return err(ex.message);
        throw ex;
      }
      role = 'phone'; unlocked = true; decoy = false;
      flash = { kind: 'ok', text: `Vault created with ${bch(dep)}.` };
      d.step = 1;
      return go('/vault');
    }
    d.step += 1;
    return render();
  }
});

// Keep countdowns current without re-rendering inputs.
setInterval(() => {
  const t = now();
  for (const el of app.querySelectorAll<HTMLElement>('[data-until]')) el.textContent = M.fmtDuration(Number(el.dataset.until) - t);
}, 15_000);

window.addEventListener('hashchange', render);
render();
