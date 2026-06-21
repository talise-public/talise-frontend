<div align="center">

# Talise Frontend

**Money that moves like a message.**

The web app and API for Talise: a gasless US dollar account on Sui that sends by name, settles in under a second, and keeps the amount private.

[Live app](https://app.talise.io) · [Contracts](https://github.com/talise-public/talise-contracts) · [Mobile](https://github.com/talise-public/talise-mobile) · [Docs](https://github.com/talise-public/talise-docs)

</div>

---

## What this is

This repository holds the Talise web client and its backend API, built on the Next.js App Router. It powers account creation with zkLogin, gasless sends to a `name@talise.sui` handle, private (shielded) transfers, claim links, streaming, on and off ramps, and the public beta at `app.talise.io`.

## Highlights

- **Sign in with Google (zkLogin).** A Google account becomes a self-custodial Sui wallet. No seed phrase, no extension.
- **Gasless sends.** Transactions are sponsored, so the user never holds a gas token.
- **Send by name.** Every user claims `name@talise.sui`, a real on-chain SuiNS identity that money routes to.
- **Private transfers.** A shielded pool hides the amount on chain and unlinks sender from recipient. Live on mainnet.
- **Claim links and streaming.** Wrap dollars in a link, or stream value by the second.
- **On and off ramps.** Cash in and out to a bank through licensed partners.

## Stack

- Next.js (App Router) and TypeScript
- Sui via gRPC (`@mysten/sui`), SuiNS (`@mysten/suins`)
- zkLogin for identity, a sponsored-gas station for fees
- Postgres for application state, behind a thin adapter

## Project layout

```
app/        Next.js routes and the API surface (app/api/*)
lib/        Core logic: sui client, zk, shield (privacy), cheques, ramps
components/ UI
public/     Static assets, including the in-browser shield prover
```

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in your own values
npm run dev
```

Every secret is read from the environment. `.env.example` documents the variables. Never commit a real `.env` file; the gitignore is configured to block them.

## Security

- No secrets are committed to this repository. Configuration is environment-driven.
- Money-path API routes are gated by app-attestation and rate limiting.
- Bank details are encrypted at rest.

## License

MIT. See [LICENSE](./LICENSE).
