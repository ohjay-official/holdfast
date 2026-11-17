# Holdfast

**A Bitcoin Cash vault a robber can't empty.**

Whoever holds your phone can only spend a small daily allowance. Anything more waits days in the open, and your home code or a guardian can cancel it and freeze the vault. A duress PIN opens a view that shows only the allowance while the rest freezes quietly. The rules live in a CashScript contract, so they hold even if someone has your real PIN.

- Site: https://holdfast-bch.vercel.app
- Demo, no wallet needed: https://holdfast-bch.vercel.app/app/#/quick
- Real vault with Paytaca: https://holdfast-bch.vercel.app/real/
- How the contract works: https://holdfast-bch.vercel.app/under-the-hood/

Built for [BCH BLAZE 2026](https://dorahacks.io/hackathon/bchblaze2026) by [@jayejone](https://t.me/jayejone).

## Before and after kickoff

Judging covers only work from kickoff (Nov 14, 2026, 14:13 UTC) onwards.

| | Code | Demo |
| --- | --- | --- |
| At kickoff | [`nov14-start` branch](https://github.com/ohjay-official/holdfast/tree/nov14-start) (commit `03f53db`, Nov 11) | https://holdfast-kickoff.vercel.app |
| Now | [`main`](https://github.com/ohjay-official/holdfast) | https://holdfast-bch.vercel.app |

At kickoff the repo held only a pre-hackathon risk test: a signing test page and two throwaway contracts (`SignTest.cash`, `CoSignTest.cash`) that checked Paytaca can sign this kind of contract over WizardConnect. Everything else was built after kickoff: the vault contract, its builders and tests, the app and demo mode, and the website. `git log 03f53db..main` shows it.

## How it works

| Action | Who | How long |
| --- | --- | --- |
| Spend the allowance | Phone | Right away, refills after about 24 hours in which the vault coin isn't touched (any spend, cancel or approval restarts that clock) |
| Withdraw more | Phone | Waits the vault's wait, 1 to 7 days |
| Release a withdrawal | Anyone, no signature needed | Once the wait is over. The 0.00002 BCH network fee comes out of the amount |
| Cancel a withdrawal | Phone, home code, guardian or duress key | Right away |
| Fast withdrawal | Guardian approves | About 1 hour |
| Freeze | Home code or guardian (everything); duress PIN (all but the allowance) | Right away. A freeze stops the vault coin; withdrawals already waiting are cancelled separately, which the app does by itself after a home code or duress freeze |
| Unfreeze, recover | Home code and guardian, one approval each (home code alone if the vault has no guardian) | Right away |
| Replace the guardian | Phone and home code | About 7 days |

## The contract

[`contracts/Holdfast.cash`](contracts/Holdfast.cash). One address holds four kinds of coin, told apart by CashToken NFTs of the vault's own category:

- **Vault coin** (minting NFT): commitment `level(1) spent(8) unfreezeHome(1) unfreezeGuardian(1) recoverHome(1) recoverGuardian(1)`.
- **Waiting withdrawal** (mutable NFT): `0x50 fast(1) recipientLockingBytecode`. Its age is the wait.
- **Guardian-replacement ticket** (immutable NFT `0x45`). Its age is the week.
- **Deposit** (no token), merged in by any vault key.

Key points:

- **No admin key.** Only the vault's own keys can do anything.
- **Approvals are one signer per transaction,** so a guardian never needs to co-sign on the owner's phone.
- **Waits use relative time locks,** not timestamps the spender could choose.
- **Every spend the phone or a guardian can make fixes its outputs and caps its own fee,** so the wallet only signs. The two that move everything out (`recover`, `evict`) need the home code's signature, which covers the exact outputs.

Transaction builders for every function are in [`src/vault.ts`](src/vault.ts).

## Tests

```bash
npm install
npm test        # 91 tests
npm run build   # compiles the contracts, typechecks, builds the site
```

- [`test/vault.test.ts`](test/vault.test.ts): 18 contract tests on CashScript's mock network, run through the BCH VM. They cover every function, the wrong keys, amounts and timing, and three attacks: minting a fake vault coin, keeping a released withdrawal's NFT alive, and skipping the guardian-replacement wait.
- [`test/model.test.ts`](test/model.test.ts): the same rules as plain state changes, used by the demo.
- [`test/real.test.ts`](test/real.test.ts): the real app's flows end to end: creation with the fee, the robbery, duress (freeze, cancel everything, allowance-only view), refill, release with no signature (recipient gets the amount minus 2,000 sats), adding deposits, unfreezing with no guardian, release after an unfreeze, a guardian working from the vault code on a second device, and the backend limits (dust, smallest withdrawal, stale reads, crash safety).
- [`test/provider.test.ts`](test/provider.test.ts): the electrum fallback: a silent server times out and the next is tried, a rejected transaction is not retried, and sending the same transaction twice counts as sent.
- `test/signtest.test.ts`, `test/cosigntest.test.ts`: the pre-kickoff WizardConnect signing tests.

## Live on mainnet

The robbery story, run on Bitcoin Cash mainnet on Nov 16 with Paytaca on one iPhone:

| Step | Transaction |
| --- | --- |
| Vault created from Paytaca over WizardConnect (0.003 BCH in, 0.0001 fee) | [5d4e7cac](https://blockchair.com/bitcoin-cash/transaction/5d4e7cac3a9beca6235ef74a7bae37f239b78980a4b0d6b4f77f207cf329d519) |
| Phone spends within the allowance (0.0001), signed in Paytaca | [1243b504](https://blockchair.com/bitcoin-cash/transaction/1243b5043acc0dd0e8fb191c1af48e3fd3bdba25e840b8dc32d9f6c603686105) |
| Phone starts a bigger withdrawal (0.001): it must wait 1 day | [af31478b](https://blockchair.com/bitcoin-cash/transaction/af31478b5f9e91733e2684687f6d8fc51bb413a9c4d9d371b908aace1004fd2c) |
| Home code cancels a waiting withdrawal (0.0005) with no wallet involved | [fdec605d](https://blockchair.com/bitcoin-cash/transaction/fdec605dc778aa35902fcd7f60fc7b7e94e4bee79012ab3a742445a9f710741b) |

## Status

- [x] Vault contract and tests
- [x] Demo mode (no wallet), covering the whole robbery story
- [x] Real vault app at [/real/](https://holdfast-bch.vercel.app/real/): Paytaca over WizardConnect, mainnet or chipnet. Create (with a 0.0001 BCH fee), send, withdraw, release, cancel, add deposits; home code screen (cancel, freeze, approve, move everything); guardian screen on the guardian's own phone; duress PIN that freezes with a panic key and cancels everything waiting.
- [x] End-to-end tests of those flows on the mock network, with Paytaca's signing simulated and every signed transaction checked by the BCH 2025 VM ([`test/real.test.ts`](test/real.test.ts))
- [x] First live run on mainnet (Nov 16): vault created from Paytaca over WizardConnect, with the 0.0001 BCH creation fee. [5d4e7cac](https://blockchair.com/bitcoin-cash/transaction/5d4e7cac3a9beca6235ef74a7bae37f239b78980a4b0d6b4f77f207cf329d519)
- [ ] Outside audit

Until there has been an outside audit, use test coins or small amounts only.

## Before kickoff: the signing risk test (Nov 11, 2026)

Signed by Paytaca over WizardConnect on chipnet, one iPhone:

| Test | What it proves | Transaction |
| --- | --- | --- |
| Create | Wallet funds a contract with a mutable state NFT | [8dbbb25b](https://chipnet.imaginary.cash/tx/8dbbb25b24e2c2f705bc686fcc25de68125e585f28c8355345d4503f4145a24f) |
| Contract spend | Wallet signs a covenant spend that updates the NFT | [04108f18](https://chipnet.imaginary.cash/tx/04108f1818f275ecd911e057af01c043a225f5124b75f0c487d985d533b0e2e0) |
| Wait | Same, gated by a relative time lock | [ecfaaecb](https://chipnet.imaginary.cash/tx/ecfaaecb9d0f8d00a5fe67b9e9ab75b74a0ef573cf825e9a148c66be81aff8ba) |
| Withdraw | Wallet signs the contract spend back to itself | [682c878e](https://chipnet.imaginary.cash/tx/682c878ecf95d0ef7a5cfd3307233d131d0731911ee20795326dd8b3b3c64937) |
| Two keys | One spend needs two signers | [bcc703ae](https://chipnet.imaginary.cash/tx/bcc703ae85c60cc17f631fc8384928714b8e03eb6036dee951c8a3964b3e2935) |

All five ran on code already in the `nov14-start` branch.

## License

MIT
