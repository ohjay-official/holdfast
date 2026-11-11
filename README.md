# Holdfast

A Bitcoin Cash vault a robber can't empty. You spend a daily allowance instantly. Anything bigger waits, and your guardian or your home code can cancel it. If someone takes your phone and forces your PIN, they leave with today's allowance and nothing more.

Built for [BCH BLAZE 2026](https://dorahacks.io/hackathon/bchblaze2026).

## Status

**Pre-kickoff.** The hackathon build runs Nov 14 to 22, 2026. What is in this repo now is a risk test, not the product:

- `contracts/SignTest.cash`: a small test contract (not the Holdfast vault).
- A signing test page that checks Paytaca can sign this kind of contract transaction over WizardConnect on chipnet.
- Contract tests on CashScript's mock network, plus tests that sign each WizardConnect request the way a wallet does and check the result in the BCH VM.

### Risk test result (Nov 11, 2026)

All four passed on chipnet, signed by Paytaca over WizardConnect on one iPhone:

| Test | What it proves | Transaction |
| --- | --- | --- |
| A. Create test vault | Wallet funds a contract with a mutable state NFT | [8dbbb25b](https://chipnet.imaginary.cash/tx/8dbbb25b24e2c2f705bc686fcc25de68125e585f28c8355345d4503f4145a24f) |
| B. Contract spend | Wallet signs a covenant spend that updates the NFT | [04108f18](https://chipnet.imaginary.cash/tx/04108f1818f275ecd911e057af01c043a225f5124b75f0c487d985d533b0e2e0) |
| C. Timelocked spend | Same, gated by a relative timelock (`this.age`) | [ecfaaecb](https://chipnet.imaginary.cash/tx/ecfaaecb9d0f8d00a5fe67b9e9ab75b74a0ef573cf825e9a148c66be81aff8ba) |
| D. Withdraw | Wallet signs the contract spend back to itself | [682c878e](https://chipnet.imaginary.cash/tx/682c878ecf95d0ef7a5cfd3307233d131d0731911ee20795326dd8b3b3c64937) |

At kickoff this state is tagged `nov14-start`. Everything judged is built after that tag.

## Run the tests

```bash
npm install
npm test
```

## Run the signing test page

```bash
npm run dev
```

Open the page, connect Paytaca with WizardConnect, fund the shown chipnet address from a chipnet faucet, and run tests A to D.

## License

MIT
