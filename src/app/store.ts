// Demo-mode storage: one pretend vault, kept in this browser only.
import * as M from './model';

export interface DemoStore {
  vault: M.VaultState;
  clockOffset: number;   // ms added to the real clock by "Skip ahead"
  pin: string;
  duressPin: string;
  homeWords: string[];
  recoverBy: M.Role[];   // approvals collected for a recovery
}

const KEY = 'holdfast-demo-v1';

export function load(): DemoStore | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as DemoStore;
    return s?.vault?.version === 1 ? s : null;
  } catch {
    return null;
  }
}

export function save(s: DemoStore | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the demo still works until the tab closes */
  }
}

const WORDS = (
  'anchor bridge cedar dune ember fable garden harbor island juniper kettle lantern meadow ' +
  'nectar orchard pebble quarry river saddle timber umber velvet willow yarrow zephyr amber ' +
  'basket canyon delta engine falcon glacier hollow ivory jasper lemon marble north olive ' +
  'pepper quiet raven silver tulip valley walnut'
).split(' ');

export function demoWords(): string[] {
  const out: string[] = [];
  const pick = new Uint32Array(12);
  crypto.getRandomValues(pick);
  for (const n of pick) out.push(WORDS[n % WORDS.length]);
  return out;
}

export const SAMPLE_ADDRESS = 'bitcoincash:qz8f3k4m9p2x7w6y5t0r3e2w1q9s8d7f6g5h4j3k2l';
export const VAULT_ADDRESS = 'bitcoincash:pvh0ldf4st6demo0vau1t8x3k9m2p7q4w5e6r7t8y9';
