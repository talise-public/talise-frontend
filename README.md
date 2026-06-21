<div align="center">

# Talise Frontend

**Money that moves like a message.**

The web client and API for Talise: a gasless US dollar account on Sui that sends by name, settles in under a second, and keeps the amount private.

[Website](https://talise.io) · [iOS app (TestFlight)](https://testflight.apple.com/join/BFNEPYtM) · [Contracts](https://github.com/talise-public/talise-contracts) · [Mobile](https://github.com/talise-public/talise-mobile) · [Docs](https://github.com/talise-public/talise-docs)

</div>

---

## What this is

This repository holds the Talise web application and its backend API, built on the Next.js App Router. It serves the public website at talise.io, the API that the Talise iOS app runs on, and the public claim and pay pages (claim links, invoices, profiles). The consumer wallet now lives in the iOS app; the web surface routes people to the iOS beta while keeping the API, auth, money links, and assets serving.

## What it powers

- **Sign in with Google (zkLogin).** A Google account becomes a self-custodial Sui wallet. No seed phrase, no extension.
- **Gasless sends.** Transactions are sponsored, so the user never holds a gas token. A send settles in under a second.
- **Send by name.** Every user claims `name@talise.sui`, a real on-chain SuiNS identity that money routes to.
- **Private transfers.** A Groth16 shielded pool hides the amount on chain and unlinks sender from recipient. Live on mainnet.
- **Claim links and streaming.** Wrap dollars in a link, or stream value over time.
- **Token bucket.** Lists every token a user holds besides USDsui (sourced from the live Cetus pool universe, enriched with on-chain logos and decimals), with per-coin swap to USDsui.
- **On and off ramps.** Cash in and out to a bank through licensed partners.

## Architecture

```
app/
  api/          The backend API: zk (sponsor, sponsor-execute), wallet, shield
                (privacy), cheques, send, ramps, recipient resolution
  (routes)      Public pages: landing, claim (/c), invoice (/i), pay, profile (/u)
lib/
  sui*.ts       Sui gRPC client, endpoints, fallback chain
  zk*.ts        zkLogin proof + signing helpers
  shield/       The shielded-pool SDK (Merkle, notes, prover, relay)
  cheques.ts    Claimable links + streaming
  coins-verified.ts, cetus-tokens.ts   Verified token set + Cetus universe
components/      UI
middleware.ts    Host routing (talise.io vs app host), security headers, edge guards
public/          Static assets, including the in-browser shield prover and the
                 Sui Overflow pitch deck at /overflow-pitchdeck
```

## How it integrates with Sui

- **zkLogin** for keyless, self-custodial accounts.
- **Sponsored transactions:** the API builds a transaction, hands it to the gas-sponsorship service, and the user signs only their half. The user pays nothing in gas.
- **Programmable transaction blocks** compose a send with a receipt or a vault deposit in one atomic transaction.
- **SuiNS** subnames give every user an on-chain `name@talise.sui` identity.
- **gRPC** is the transport for all reads, executions, and lookups.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in your own values
npm run dev
```

Every secret is read from the environment. `.env.example` documents the variables. Never commit a real `.env` file; the gitignore blocks them.

## Security

- No secrets are committed. Configuration is environment-driven.
- Money-path API routes are gated by app attestation and rate limiting.
- Bank details are encrypted at rest.

## License

MIT. See [LICENSE](./LICENSE).
