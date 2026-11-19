# Holdfast

<p align="center">
  <img src="docs/images/home-phone.png" alt="Phone view of the Holdfast home page. The headline reads A Bitcoin Cash vault a robber can't empty, with a Try the demo button under it." width="260">
</p>

**A Bitcoin Cash vault a robber can't empty.**

Whoever has your phone can make you send what the phone can spend, and a Bitcoin Cash payment cannot be reversed. Holdfast is a vault contract: the phone can spend only a small daily allowance, and anything more waits in public so a home code or a guardian can cancel it.

**For judges:** open the [demo](https://hodlfast.vercel.app/app/), tap **Start the demo**, then **Send**, **Use a sample address**, **Send all: 1.00 BCH**, **Review**, and **Send 1.00 BCH**. Then tap **Home code** and **Cancel withdrawal**. You should see **0.05 BCH** leave now and **0.95 BCH** come back.

## Quick Links

| What | What it needs |
| --- | --- |
| [Demo](#try-it-in-5-steps) | 5 steps, pretend money, no wallet |
| [Live site](#proof-its-real) | A browser |
| [Real vault](#what-works-today) | Paytaca, and a little BCH or chipnet |
| [Tests](#more-ways-to-test) | Node and npm, 101 tests |
| [How it was built](#built-during-bch-blaze-2026) | `git log --reverse` |

## Try It in 5 Steps

The [demo](https://hodlfast.vercel.app/app/) uses pretend money. No wallet and no signup.

1. Open the demo and tap **Start the demo**. You see **In your vault**, **1.00 BCH**, and **Demo vault ready: 1 BCH, 0.05 BCH a day, 3-day wait, Ada as guardian.**
2. Tap **Send**, then **Use a sample address**, then **Send all: 1.00 BCH**, then **Review**. You see **0.05 BCH leaves now** and **0.95 BCH waits 3 days**.
3. Tap **Send 1.00 BCH**. You see **Waiting to leave** and **0.95 BCH**. The **0.05 BCH** has already gone.
4. At the bottom, tap **Home code**, then **Cancel withdrawal**. You see **Withdrawal cancelled. The BCH stays in the vault.** and **Nothing is waiting.** **Saved** is **0.95 BCH**. **Spendable now** stays **0.00 BCH** until the allowance window refills, because the **0.05 BCH** already left.
5. Tap **Freeze vault**. You see **Vault frozen** and **Frozen by your home code.**

The words in bold are the words on the screen. The sample address is a demo address in the app, not a real wallet.

## Proof It's Real

- The rules are the contract [`contracts/Holdfast.cash`](contracts/Holdfast.cash) (`pragma cashscript ^0.14.0`).
- [`test/vault.test.ts`](test/vault.test.ts) runs 18 contract tests through the Bitcoin Cash VM, including three attacks named in that file.
- `npm test` passes 101 tests (counted 18 Nov 2026 on this commit).
- The site is live: [hodlfast.vercel.app](https://hodlfast.vercel.app). The same proof list is on [Security](https://hodlfast.vercel.app/security/#proof).
- A real vault was created from Paytaca on mainnet on 16 Nov 2026, and the later steps below were broadcast on 16 and 17 Nov 2026. There has been no outside audit.

| Step | Transaction |
| --- | --- |
| Vault created from Paytaca over WizardConnect (0.003 BCH in, 0.0001 fee) | [5d4e7cac](https://blockchair.com/bitcoin-cash/transaction/5d4e7cac3a9beca6235ef74a7bae37f239b78980a4b0d6b4f77f207cf329d519) |
| Phone spends within the allowance (0.0001), signed in Paytaca | [1243b504](https://blockchair.com/bitcoin-cash/transaction/1243b5043acc0dd0e8fb191c1af48e3fd3bdba25e840b8dc32d9f6c603686105) |
| Phone starts a bigger withdrawal (0.001): it must wait 1 day | [af31478b](https://blockchair.com/bitcoin-cash/transaction/af31478b5f9e91733e2684687f6d8fc51bb413a9c4d9d371b908aace1004fd2c) |
| Home code cancels a waiting withdrawal (0.0005) with no wallet involved | [fdec605d](https://blockchair.com/bitcoin-cash/transaction/fdec605dc778aa35902fcd7f60fc7b7e94e4bee79012ab3a742445a9f710741b) |
| After the wait, the withdrawal is released (0.00098 to the recipient, 2,000 sat fee), no wallet signature needed | [ba9ee1e9](https://blockchair.com/bitcoin-cash/transaction/ba9ee1e9121da03a31e2b8e5b35ddc5c8da00129272893437cd61886a0fe2495) |
| Home code freezes the vault | [4acd7c88](https://blockchair.com/bitcoin-cash/transaction/4acd7c88e0eb056e54733920a75f2c397fe42ad2a10876379f87ace0c404c15b) |
| Home code unfreezes the vault | [71d50061](https://blockchair.com/bitcoin-cash/transaction/71d50061870156c349af4fd07ddf09baa53524eb9d9608671e93db41818faadf) |
| Duress PIN quietly freezes the vault while showing only the allowance | [ad5c27ea](https://blockchair.com/bitcoin-cash/transaction/ad5c27ea0245f9140dfda45ea57a60490d33ce64028a0a728e2e19ef2e6baece) |
| Home code unfreezes it again | [48f2f9e4](https://blockchair.com/bitcoin-cash/transaction/48f2f9e44e6d4e79ac921f83a5c5769f45fc7fa81c89e05c638b3f6c6d21ffb9) |

## What's New Here

**A real PIN does not let the phone empty the vault.**

- **The phone can spend only the allowance in the current window.** `spend` in the contract requires `spent + amount <= allowance`, and `int(level) < 2`.
- **Anything bigger becomes a waiting withdrawal on the same address.** `startWithdrawal` mints that coin. `release` pays only the recorded recipient, and only after `this.age >= waitBlocks`.
- **A home code or a guardian can cancel. Neither can take the money alone.** Cancel is `merge`. Moving the whole vault is `recover`, and that needs both recovery flags. With no guardian, the contract sets both flags from the home code alone (`guardianPk == homePk`).
- **A duress key can freeze without blocking the allowance.** `freeze` with the panic key sets level 1. Level 2, from the home code or a guardian, blocks spends and new withdrawals. Level 2 does not stop `release` on a withdrawal whose wait is already over.

People already lose money this way. The [Why](https://hodlfast.vercel.app/why/) page states two sourced figures. One is ₦2.6 million from a bank app after a robbery at gunpoint in September 2025 ([WeeTracker](https://weetracker.com/2025/10/07/panic-mode-banking-nigeria-duress-features); the link path is dated 7 Oct 2025). The other is 72 verified "wrench attacks" in 2025, up 75% on 2024 ([Decrypt](https://decrypt.co/356604/41m-in-losses-as-crypto-wrench-attacks-hit-record-high-in-2025)). A day-level date for the Decrypt piece is not in this repo.

## How Bitcoin Cash Is Used

- **CashScript 0.14 covenants.** [`contracts/Holdfast.cash`](contracts/Holdfast.cash) checks signatures, fixes its own outputs, and carries state in CashToken NFT commitments. Waits use `this.age` (a relative time lock), not a timestamp the spender picks. The contract allows at most 2,500 sats of fee on a spend, and 4,000 on a merge.
- **libauth 3.1.0-next.8.** The real vault and the signing test use it for addresses, hashes, and transaction bytes (`src/vault.ts`, `src/real/core.ts`, `src/main.ts`).
- **WizardConnect 0.2 and Paytaca.** [`src/real/wallet.ts`](src/real/wallet.ts) connects the real vault to Paytaca. The same path is what the pre-kickoff signing test used.
- **In the repo, not in the vault app.** `contracts/SignTest.cash` and `contracts/CoSignTest.cash` are the chipnet signing tests, reached from [/signing-test/](https://hodlfast.vercel.app/signing-test/). Telegram alerts and a guardian-for-hire service are named on the [Why](https://hodlfast.vercel.app/why/) page as later work. There is no code that sends those alerts.

The app's builders use 144 blocks for about a day, 6 blocks for about an hour, and 1,008 blocks for about a week (`src/vault.ts`). The contract checks whatever block counts were set when the vault was created. The demo uses a 0.05 BCH allowance and a 3-day wait. A real vault can use 1 to 7 days. The site says 3 is the default.

## How It Compares

Our row is first. A cell says Not stated when this repo does not give the date or the fact.

| Product | What a forced phone can still take | Source | Date |
| --- | --- | --- | --- |
| Holdfast | The daily allowance now. The rest waits and can be cancelled. | [Contract](contracts/Holdfast.cash) and the [mainnet list](#proof-its-real) | 16 and 17 Nov 2026 |
| Kuda Panic Balance | Not stated here. The Why page says it shows a lower balance when you shake the phone, and that money still moves if they make you send it. | [Kuda help](https://help.kuda.com/en/articles/8943120-use-private-mode) | Not stated |
| Discovery Bank panic PIN | Not stated here. The Why page says a panic PIN alerts its fraud team. | [TechCentral](https://techcentral.co.za/discovery-bank-panic-code-app-kidnappings/261422/) | Not stated |
| Deus Wallet duress mode | Not stated here. The Why page says duress mode opens a decoy account. | [Decrypt](https://decrypt.co/297742/deus-wallet-introduces-duress-mode-the-revolutionary-solution-for-cryptocurrency-security) | Not stated |

A bank can call a fraud team. Holdfast cannot. Bitcoin Cash that has already left, including the allowance, is gone. The [Security](https://hodlfast.vercel.app/security/) page says that in those words.

## What Works Today

| Piece | State |
| --- | --- |
| Vault contract | In the repo. 18 contract tests. No outside audit. |
| Demo | Live at [/app/](https://hodlfast.vercel.app/app/). Pretend BCH in the browser. |
| Real vault | Live at [/real/](https://hodlfast.vercel.app/real/). Paytaca on mainnet or chipnet. Mainnet steps in the table above. |
| Signing test | Live at [/signing-test/](https://hodlfast.vercel.app/signing-test/). Five chipnet tests from before kickoff are listed on the [Security](https://hodlfast.vercel.app/security/#proof) page. |
| Website | Live at [hodlfast.vercel.app](https://hodlfast.vercel.app). |
| Telegram alerts | Not built. Listed on the Why page as later work. |
| Guardian-for-hire | Not built. The Why page lists it under "Later". |

## More Ways to Test

<details>
<summary><strong>Run the tests (101 tests, Node and npm)</strong></summary>

```bash
npm install
npm test
```

Vitest should report `Tests  101 passed`.

</details>

<details>
<summary><strong>Build the site (Node and npm)</strong></summary>

```bash
npm run build
git checkout -- src/*.artifact.ts
```

`npm run build` compiles the three CashScript contracts, typechecks, and runs Vite. The checkout puts the generated artifact files back so they do not stay as a local change.

</details>

<details>
<summary><strong>Run it locally (Node and npm)</strong></summary>

```bash
git clone https://github.com/ohjay-official/holdfast.git
cd holdfast
npm install
npm run dev
```

Vite prints a local address. Its usual default is http://localhost:5173 . Open `/app/` for the demo.

</details>

<details>
<summary><strong>Mainnet run (Paytaca and a small amount of BCH)</strong></summary>

Open [the real vault](https://hodlfast.vercel.app/real/). The screen says **Mainnet** or **Chipnet (test)**. The app charges a one-time 0.0001 BCH Holdfast fee when you create a vault (`CREATE_FEE` in `src/real/core.ts`). That fee is not a line in the contract. Until there is an outside audit, the site says to start with a small amount.

</details>

## Screenshots

Shots of the live site on 18 Nov 2026. The in-app shots are the demo, which uses pretend BCH.

<p align="center">
  <img src="docs/images/demo-vault.png" alt="Demo vault screen. It shows In your vault, 1.00 BCH, and the buttons Send and Receive. A Demo chip is in the top bar." width="260">
</p>

<p align="center">
  <img src="docs/images/demo-home-code.png" alt="Demo home code screen after Cancel withdrawal. It shows Withdrawal cancelled, Saved 0.95 BCH, Nothing is waiting, and the button Freeze vault." width="260">
</p>

<p align="center">
  <img src="docs/images/home-phone.png" alt="Phone view of the Holdfast home page with the demo button above the fold." width="260">
</p>

## What It Does

1. You open the demo, or you connect Paytaca and create a real vault.
2. You pick a daily allowance and a wait from 1 to 7 days.
3. You write down a 12-word home code. A guardian is optional. With no guardian, the home code fills the guardian's role.
4. The phone spends up to the allowance immediately (`spend`, or `spendFresh` after the refill age).
5. A larger send starts a waiting withdrawal. When the wait is over, anyone can release it to the saved recipient. No new signature is required for `release`.
6. The home code or a guardian can cancel that withdrawal (`merge`) or freeze the vault coin.
7. Unfreezing or moving everything needs the home code and the guardian. One home-code approval does both jobs when there is no guardian.

What it cannot promise:

- It cannot reverse Bitcoin Cash that has already left, including the allowance.
- A freeze of the vault coin does not, by itself, stop `release` on a withdrawal whose wait is already over. The real app's home-code and duress flows also cancel waiting withdrawals (`lockDown` in `src/real/core.ts`). A guardian-only freeze is the freeze function, not that whole flow.
- If someone has both the phone and the home code, the contract cannot tell them from you.
- There has been no outside audit.

## Security and What It Doesn't Promise

There is no `docs/SECURITY` file in this repo. The write-up is the live page: [Security](https://hodlfast.vercel.app/security/).

The short version is the list in [What It Does](#what-it-does). Read that page before you put in more than a small amount.

## Privacy

The live [Privacy](https://hodlfast.vercel.app/privacy/) page is the current note (last updated 17 Nov 2026 on that page).

The app keeps vault settings in the browser. Vault actions are public Bitcoin Cash transactions. The real app reads public Electrum servers named on that page. WizardConnect uses public Nostr relays. The site is hosted on Vercel. Fonts are files from this site.

## Run Your Own

```bash
git clone https://github.com/ohjay-official/holdfast.git
cd holdfast
npm install
npm test
npm run build
git checkout -- src/*.artifact.ts
npm run dev
```

No environment variables are required for the demo. The real vault talks to public servers from the browser. Do not put keys or secrets in the repo.

## Repository

| | |
| --- | --- |
| Code | https://github.com/ohjay-official/holdfast |
| License | [MIT](LICENSE) |
| Issues | https://github.com/ohjay-official/holdfast/issues |
| Live site | https://hodlfast.vercel.app |
| Kickoff snapshot | [`nov14-start`](https://github.com/ohjay-official/holdfast/tree/nov14-start) (`03f53db`, 11 Nov 2026) and https://holdfast-kickoff.vercel.app |
| Hackathon | [BCH BLAZE 2026](https://dorahacks.io/hackathon/bchblaze2026) |

No BCH BLAZE track id is written in this repo, so there is no tracks table.

## Built During BCH BLAZE 2026

**First commit `5149a2f` was 11 Nov 2026, 11:36 UTC, which is 12:36 in Lagos (UTC+1).** That is before the site's kickoff mark of 14 Nov 2026. It was the chipnet signing test, not the vault.

```bash
git log --reverse --format='%h %ad %s' --date=format:'%Y-%m-%d %H:%M %z'
```

<details>
<summary><strong>What landed each day (42 commits, Lagos dates)</strong></summary>

- **11 Nov:** WizardConnect signing test on chipnet, including a two-signer spend.
- **14 Nov:** Public site, demo app, and the vault contract with its first 18 tests.
- **15 Nov:** Judge bar, Why and Under the hood pages, pitch deck, and the real vault app.
- **16 Nov:** First mainnet vault, the allowance spend, a waiting withdrawal, a home-code cancel, and PIN-length fixes.
- **17 Nov:** More tests, docs aligned with the contract, home code on a new phone with the vault code, and the PIN redraw fix.
- **18 Nov:** Repeated-digit PIN fix, the Nov 17 mainnet transactions written into the docs, and the Night Vault site.

</details>

Code, tests, and docs were written with AI (Claude and Grok Bot), directed by Oh-Jay. Oh-Jay made the product decisions and did every wallet step and every real-money test.

Libraries from `package-lock.json` on this commit:

**Runtime:** `@bitauth/libauth` 3.1.0-next.8, `@wizardconnect/core` 0.2.5, `@wizardconnect/dapp` 0.2.2, `cashscript` 0.14.0, `qrcode` 1.5.4, `three` 0.170.0, `@types/three` 0.170.0, `@fontsource-variable/bricolage-grotesque` 5.3.0, `@fontsource-variable/jetbrains-mono` 5.3.0, `@fontsource-variable/source-serif-4` 5.3.1.

**Dev:** `cashc` 0.14.0, `typescript` 7.0.2, `vite` 8.3.8, `vitest` 5.1.0, `@types/qrcode` 1.5.6.

**Services:** Vercel hosts the site. The real app reads the public Electrum servers named on the Privacy page. WizardConnect uses public Nostr relays. No API keys are stored in the repo.

## License

[MIT](LICENSE). Copyright (c) 2026 ohjay-official.
