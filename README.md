# Holdfast

A Bitcoin Cash vault a robber can't empty. You spend a daily allowance instantly. Anything bigger waits, and your guardian or your home code can cancel it. If someone takes your phone and forces your PIN, they leave with today's allowance and nothing more.

Built for [BCH BLAZE 2026](https://dorahacks.io/hackathon/bchblaze2026).

## Status

**Pre-kickoff.** The hackathon build runs Nov 14 to 22, 2026. What is in this repo now is a risk test, not the product:

- `contracts/SignTest.cash`: a small test contract (not the Holdfast vault).
- A signing test page that checks Paytaca can sign this kind of contract transaction over WizardConnect on chipnet.
- Contract tests on CashScript's mock network.

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
