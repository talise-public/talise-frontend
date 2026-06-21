#!/usr/bin/env node
/**
 * Probe: exhaustively try every PTB shape that COULD make USDsui sends
 * gasless for a user whose balance lives in legacy `Coin<USDSUI>` objects
 * (not in their Address Balance accumulator).
 *
 * For each shape we:
 *   1. Build the PTB (`tx.build`) — captures BuildOk / BuildErr.
 *   2. Run `client.simulateTransaction({ transaction: tx, include: { effects } })`.
 *      This is the gRPC equivalent of `dryRunTransaction`. The decisive
 *      test for "is this PTB gasless?" is:
 *        effects.status.success === true
 *        AND effects.gasUsed.computationCost === "0"
 *        AND effects.gasUsed.storageCost === "0"
 *   3. Capture the verbatim validator error if it fails.
 *
 * Test matrix:
 *   A   — `0x2::balance::send_funds<T>(withdrawal, recipient)`  +  gasPrice(0)
 *   B1  — `0x2::coin::send_funds<T>(coinWithBalance, recipient)` +  gp(0)+gb(0)
 *   B2  — `0x2::coin::send_funds` over an explicit, pre-fetched coin object
 *         (no mergeCoins prefix) — split then send_funds.
 *   B2m — same as B2 but `tx.mergeCoins` prefix when sources are split.
 *   B3  — coin::send_funds WITHOUT setGasPrice/setGasBudget (let the SDK
 *         auto-detect gasless eligibility per the docs).
 *   B4  — Same as B3 but built via a freshly-constructed SuiGrpcClient
 *         directly (NOT through our fallback proxy), in case the proxy
 *         strips gasless behaviour from `simulateTransaction`.
 *   Cn  — Enumerate `0x2` functions taking a single `Coin<T>` arg and
 *         either no other args or `(Coin<T>, address)`. Try each with
 *         setGasPrice(0n).
 *
 * Usage:
 *   node scripts/probe-gasless-build.mjs [sender] [recipient] [amount-usdsui]
 *
 * Exits 0 always so the matrix is fully reported even when individual
 * shapes fail.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SENDER =
  process.argv[2] ??
  // The user holding 428k µ in legacy Coin objects + 3,788 µ in accumulator.
  "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const RECIPIENT =
  process.argv[3] ??
  "0x3333333333333333333333333333333333333333333333333333333333333333";
const AMOUNT_USDSUI = process.argv[4] ?? "0.001";

const testDir = join(process.cwd(), "__tests__", "sui");
mkdirSync(testDir, { recursive: true });
const testFile = join(testDir, "_probe-gasless.test.ts");

const src = `
import { it } from "vitest";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { sui } from "../../lib/sui";
import { USDSUI_TYPE } from "../../lib/usdsui";

const SENDER = ${JSON.stringify(SENDER)};
const RECIPIENT = ${JSON.stringify(RECIPIENT)};
const amountNum = Number(${JSON.stringify(AMOUNT_USDSUI)});
const onchain = BigInt(Math.round(amountNum * 1e6));

type ShapeResult = {
  name: string;
  buildOk: boolean;
  buildError?: string;
  simulateOk?: boolean;
  effectsStatusSuccess?: boolean;
  computationCost?: string | null;
  storageCost?: string | null;
  storageRebate?: string | null;
  validatorError?: string | null;
  // Was the dryRun decisive about gasless?
  gaslessProven?: boolean;
};

const RESULTS: ShapeResult[] = [];

function pushResult(r: ShapeResult) {
  RESULTS.push(r);
  console.log("[shape:" + r.name + "]", JSON.stringify(r));
}

async function runShape(
  name: string,
  buildTx: (tx: Transaction) => Promise<void> | void,
  options: {
    client?: any;
    setGasPriceZero?: boolean;
    setGasBudgetZero?: boolean;
  } = {},
) {
  const client = options.client ?? sui();
  const tx = new Transaction();
  tx.setSender(SENDER);
  let buildOk = false;
  let buildError: string | undefined;
  let bytes: Uint8Array | null = null;
  try {
    await buildTx(tx);
    if (options.setGasPriceZero !== false) {
      tx.setGasPrice(0n);
    }
    if (options.setGasBudgetZero) {
      tx.setGasBudget(0n);
    }
    bytes = await tx.build({ client: client as never });
    buildOk = true;
  } catch (e) {
    buildError = ((e as Error).message ?? String(e)).slice(0, 600);
    pushResult({ name, buildOk: false, buildError });
    return;
  }

  // Simulate — gRPC equivalent of dryRunTransaction.
  // We pass the BUILT bytes so the simulator's transaction matches exactly
  // what would be submitted on chain.
  try {
    const sim = await (client as any).simulateTransaction({
      transaction: bytes,
      include: { effects: true },
      checksEnabled: true,
    });
    const tx0 = sim?.Transaction ?? sim?.FailedTransaction;
    const eff = tx0?.effects;
    const success = eff?.status?.success === true;
    const validatorError = eff?.status?.error
      ? (typeof eff.status.error === "string"
          ? eff.status.error
          : JSON.stringify(eff.status.error))
      : null;
    const computationCost = eff?.gasUsed?.computationCost ?? null;
    const storageCost = eff?.gasUsed?.storageCost ?? null;
    const storageRebate = eff?.gasUsed?.storageRebate ?? null;
    const gaslessProven =
      success && computationCost === "0" && storageCost === "0";
    pushResult({
      name,
      buildOk,
      simulateOk: true,
      effectsStatusSuccess: success,
      computationCost,
      storageCost,
      storageRebate,
      validatorError: validatorError ? validatorError.slice(0, 600) : null,
      gaslessProven,
    });
  } catch (e) {
    pushResult({
      name,
      buildOk,
      simulateOk: false,
      validatorError: ((e as Error).message ?? String(e)).slice(0, 600),
    });
  }
}

it("probe gasless build (full matrix)", async () => {
  const client = sui();

  // State snapshot.
  try {
    const bal = await (client as any).getBalance({
      owner: SENDER,
      coinType: USDSUI_TYPE,
    });
    console.log("__BALANCE__", JSON.stringify(bal));
  } catch (e) {
    console.log("__BALANCE_ERR__", (e as Error).message);
  }
  let coinList: any[] = [];
  try {
    const coins = await (client as any).listCoins({
      owner: SENDER,
      coinType: USDSUI_TYPE,
    });
    coinList = (coins?.objects ?? coins?.coins ?? coins?.data ?? []) as any[];
    console.log(
      "__COINS__ count=" +
        coinList.length +
        " ids=" +
        JSON.stringify(
          coinList.map((c: any) => ({
            id: c.coinObjectId ?? c.id ?? c.objectId,
            balance: c.balance ?? c.amount,
          })),
        ),
    );
  } catch (e) {
    console.log("__COINS_ERR__", (e as Error).message);
  }

  // ─── SHAPE A: canonical balance::send_funds + setGasPrice(0n) ────────
  await runShape(
    "A_balance_send_funds",
    (tx) => {
      tx.moveCall({
        target: "0x2::balance::send_funds",
        typeArguments: [USDSUI_TYPE],
        arguments: [
          tx.withdrawal({ amount: onchain, type: USDSUI_TYPE }),
          tx.pure.address(RECIPIENT),
        ],
      });
    },
    { setGasPriceZero: true, setGasBudgetZero: true },
  );

  // Resolve the current epoch — gasless txs require a ValidDuring
  // expiration of at most two epochs (validator rule we discovered).
  let currentEpoch: number | null = null;
  let chainIdentifier: string | null = null;
  try {
    const sys: any = await (client as any).core.getCurrentSystemState();
    currentEpoch = sys?.systemState?.epoch
      ? Number(sys.systemState.epoch)
      : null;
    console.log("__EPOCH__", currentEpoch);
  } catch (e) {
    console.log("__EPOCH_ERR__", (e as Error).message);
  }
  try {
    const ci: any = await (client as any).core.getChainIdentifier();
    chainIdentifier = ci?.chainIdentifier ?? null;
    console.log("__CHAIN_IDENTIFIER__", chainIdentifier);
  } catch (e) {
    console.log("__CHAIN_IDENT_ERR__", (e as Error).message);
  }

  // ─── SHAPE A_full: balance::send_funds withdrawing the ENTIRE
  //                accumulator USDsui balance (no remainder rule).
  // The B1 error told us: "Gasless transactions must either use the
  // entire balance, or leave at least 10000". A_full tries the
  // "entire balance" branch for the accumulator-only path.
  // Note: this can only send AT MOST what's in the accumulator.
  // Use a small fixed amount = 3788 (the accumulator balance, in micro
  // USDsui, observed live above).
  await runShape(
    "A_full_balance_send_entire_accumulator",
    (tx) => {
      // 3788 µ — matches the user's current address-balance accumulator
      // exactly. If gasless is reachable for this user TODAY without
      // moving Coin objects, this is the one shape that should pass.
      tx.moveCall({
        target: "0x2::balance::send_funds",
        typeArguments: [USDSUI_TYPE],
        arguments: [
          tx.withdrawal({ amount: 3788n, type: USDSUI_TYPE }),
          tx.pure.address(RECIPIENT),
        ],
      });
    },
    { setGasPriceZero: true, setGasBudgetZero: true },
  );

  // ─── SHAPE A_full_vd: same, but with ValidDuring expiration (2 epochs).
  // The A_full error said: "Transactions must either have address-owned
  // inputs, or a ValidDuring expiration with at most two epochs of
  // validity". Try the expiration branch.
  const validDuringFor = (epoch: number) => ({
    ValidDuring: {
      minEpoch: String(epoch),
      maxEpoch: String(epoch + 1),
      minTimestamp: null,
      maxTimestamp: null,
      // Use the actual chain identifier reported by the node — falls
      // back to the well-known mainnet prefix if the RPC didn't return
      // one.
      chain: chainIdentifier ?? "35834a8a",
      nonce: Math.floor(Math.random() * 4294967296),
    },
  });

  if (currentEpoch != null) {
    await runShape(
      "A_full_balance_send_entire_validduring",
      (tx) => {
        tx.setExpiration(validDuringFor(currentEpoch as number));
        tx.moveCall({
          target: "0x2::balance::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [
            tx.withdrawal({ amount: 3788n, type: USDSUI_TYPE }),
            tx.pure.address(RECIPIENT),
          ],
        });
      },
      { setGasPriceZero: true, setGasBudgetZero: true },
    );
  } else {
    pushResult({
      name: "A_full_balance_send_entire_validduring",
      buildOk: false,
      buildError: "skipped — could not resolve current epoch",
    });
  }

  // ─── SHAPE A_arb_vd: same as A_full_vd but trying the user's REQUESTED
  // amount (1000 µ). This will hit the "leave 10000" rule unless we
  // ALSO bring in coin balance from coinWithBalance. Useful to confirm
  // the rule still binds when ValidDuring is set.
  if (currentEpoch != null) {
    await runShape(
      "A_arbitrary_amount_validduring",
      (tx) => {
        tx.setExpiration(validDuringFor(currentEpoch as number));
        tx.moveCall({
          target: "0x2::balance::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [
            tx.withdrawal({ amount: onchain, type: USDSUI_TYPE }),
            tx.pure.address(RECIPIENT),
          ],
        });
      },
      { setGasPriceZero: true, setGasBudgetZero: true },
    );
  }

  // ─── SHAPE A_full_vd_plus_coin: bring in the legacy Coin balance via
  // coinWithBalance({useGasCoin:false}) — this deposits into the
  // accumulator implicitly so the withdrawal can pull the user's
  // requested amount WITHOUT violating the "leave 10000" rule. This is
  // the canonical "spend Coin objects gasless" composite per the docs.
  if (currentEpoch != null && coinList.length > 0) {
    await runShape(
      "A_full_vd_with_coinWithBalance_topup",
      (tx) => {
        tx.setExpiration(validDuringFor(currentEpoch as number));
        // coinWithBalance with useGasCoin:false pulls from on-chain
        // Coin<T> objects. The SDK auto-resolves the source coin and
        // either splits an existing one or merges multiple.
        const c = tx.add(
          coinWithBalance({
            type: USDSUI_TYPE,
            balance: onchain,
            useGasCoin: false,
          }),
        );
        // Now transfer the resulting coin. We want to test BOTH the
        // 0x2::coin::send_funds path AND a plain transferObjects.
        tx.moveCall({
          target: "0x2::coin::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [c, tx.pure.address(RECIPIENT)],
        });
      },
      { setGasPriceZero: true, setGasBudgetZero: true },
    );
  }

  // ─── SHAPE B1: coin::send_funds + coinWithBalance(useGasCoin:false) ──
  await runShape(
    "B1_coin_send_funds_with_coinWithBalance",
    (tx) => {
      const c = tx.add(
        coinWithBalance({
          type: USDSUI_TYPE,
          balance: onchain,
          useGasCoin: false,
        }),
      );
      tx.moveCall({
        target: "0x2::coin::send_funds",
        typeArguments: [USDSUI_TYPE],
        arguments: [c, tx.pure.address(RECIPIENT)],
      });
    },
    { setGasPriceZero: true, setGasBudgetZero: true },
  );

  // ─── SHAPE B2: explicit per-coin split + coin::send_funds, no merge ──
  if (coinList.length > 0) {
    await runShape(
      "B2_coin_send_funds_explicit_split_no_merge",
      (tx) => {
        const big =
          coinList.find(
            (c) => BigInt(c.balance ?? c.amount ?? "0") >= onchain,
          ) ?? coinList[0];
        const id = big.coinObjectId ?? big.id ?? big.objectId;
        const [split] = tx.splitCoins(tx.object(id), [tx.pure.u64(onchain)]);
        tx.moveCall({
          target: "0x2::coin::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [split, tx.pure.address(RECIPIENT)],
        });
      },
      { setGasPriceZero: true, setGasBudgetZero: true },
    );
  } else {
    pushResult({
      name: "B2_coin_send_funds_explicit_split_no_merge",
      buildOk: false,
      buildError: "no legacy Coin objects to source from",
    });
  }

  // ─── SHAPE B2m: same but mergeCoins prefix when more than one coin ──
  if (coinList.length > 1) {
    await runShape(
      "B2m_coin_send_funds_with_mergeCoins_prefix",
      (tx) => {
        const ids = coinList.map(
          (c) => c.coinObjectId ?? c.id ?? c.objectId,
        );
        const primary = tx.object(ids[0]);
        const rest = ids.slice(1).map((id) => tx.object(id));
        tx.mergeCoins(primary, rest);
        const [split] = tx.splitCoins(primary, [tx.pure.u64(onchain)]);
        tx.moveCall({
          target: "0x2::coin::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [split, tx.pure.address(RECIPIENT)],
        });
      },
      { setGasPriceZero: true, setGasBudgetZero: true },
    );
  } else {
    pushResult({
      name: "B2m_coin_send_funds_with_mergeCoins_prefix",
      buildOk: false,
      buildError:
        "skipped — need at least 2 Coin<USDSUI> objects to exercise merge",
    });
  }

  // ─── SHAPE B3: coin::send_funds WITHOUT setGasPrice/setGasBudget ────
  // Let the SDK auto-detect gasless eligibility (docs claim it does this
  // for gRPC clients).
  if (coinList.length > 0) {
    await runShape(
      "B3_coin_send_funds_auto",
      (tx) => {
        const big =
          coinList.find(
            (c) => BigInt(c.balance ?? c.amount ?? "0") >= onchain,
          ) ?? coinList[0];
        const id = big.coinObjectId ?? big.id ?? big.objectId;
        const [split] = tx.splitCoins(tx.object(id), [tx.pure.u64(onchain)]);
        tx.moveCall({
          target: "0x2::coin::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [split, tx.pure.address(RECIPIENT)],
        });
      },
      { setGasPriceZero: false },
    );
  }

  // ─── SHAPE B4: same as B3, but use a freshly-constructed SuiGrpcClient
  //            (NOT our fallback proxy). The docs say SuiGrpcClient
  //            auto-handles gasless during build/simulate.
  if (coinList.length > 0) {
    const directClient = new SuiGrpcClient({
      network: "mainnet",
      baseUrl: "https://fullnode.mainnet.sui.io:443",
    });
    await runShape(
      "B4_coin_send_funds_direct_grpc_client",
      (tx) => {
        const big =
          coinList.find(
            (c) => BigInt(c.balance ?? c.amount ?? "0") >= onchain,
          ) ?? coinList[0];
        const id = big.coinObjectId ?? big.id ?? big.objectId;
        const [split] = tx.splitCoins(tx.object(id), [tx.pure.u64(onchain)]);
        tx.moveCall({
          target: "0x2::coin::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [split, tx.pure.address(RECIPIENT)],
        });
      },
      { client: directClient, setGasPriceZero: false },
    );
    // Also try B4 + explicit gasPrice(0n)
    await runShape(
      "B4z_coin_send_funds_direct_grpc_client_gp0",
      (tx) => {
        const big =
          coinList.find(
            (c) => BigInt(c.balance ?? c.amount ?? "0") >= onchain,
          ) ?? coinList[0];
        const id = big.coinObjectId ?? big.id ?? big.objectId;
        const [split] = tx.splitCoins(tx.object(id), [tx.pure.u64(onchain)]);
        tx.moveCall({
          target: "0x2::coin::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [split, tx.pure.address(RECIPIENT)],
        });
      },
      { client: directClient, setGasPriceZero: true, setGasBudgetZero: true },
    );
  }

  // ─── SHAPE B5: balance::send_funds with full accumulator + ValidDuring
  //              AND a coin::join_into_address-balance-style topup that
  //              keeps the accumulator's remaining >= 10000 rule
  //              satisfied. We can deposit Coin balance INTO accumulator
  //              implicitly by wrapping via 0x2::coin::into_balance,
  //              then call 0x2::balance::send_funds directly on that
  //              balance (skipping accumulator round-trip entirely).
  // This is the most promising "spend Coin objects gasless" shape.
  if (coinList.length > 0) {
    await runShape(
      "B5_balance_send_funds_from_coin_into_balance",
      (tx) => {
        const big =
          coinList.find(
            (c) => BigInt(c.balance ?? c.amount ?? "0") >= onchain,
          ) ?? coinList[0];
        const id = big.coinObjectId ?? big.id ?? big.objectId;
        const [split] = tx.splitCoins(tx.object(id), [tx.pure.u64(onchain)]);
        // Convert Coin<T> → Balance<T> via 0x2::coin::into_balance
        const bal = tx.moveCall({
          target: "0x2::coin::into_balance",
          typeArguments: [USDSUI_TYPE],
          arguments: [split],
        });
        // Then balance::send_funds<T>(Balance<T>, address) — the
        // canonical gasless send target.
        tx.moveCall({
          target: "0x2::balance::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [bal, tx.pure.address(RECIPIENT)],
        });
      },
      { setGasPriceZero: true, setGasBudgetZero: true },
    );
  }

  // ─── SHAPE B6: same as B5 but with ValidDuring expiration too.
  // Hedges against the "must have address-owned inputs OR ValidDuring"
  // rule when the accumulator path is taken (split's nested-result is
  // not an address-owned input).
  if (coinList.length > 0 && currentEpoch != null) {
    await runShape(
      "B6_balance_send_funds_from_coin_with_validduring",
      (tx) => {
        tx.setExpiration(validDuringFor(currentEpoch as number));
        const big =
          coinList.find(
            (c) => BigInt(c.balance ?? c.amount ?? "0") >= onchain,
          ) ?? coinList[0];
        const id = big.coinObjectId ?? big.id ?? big.objectId;
        const [split] = tx.splitCoins(tx.object(id), [tx.pure.u64(onchain)]);
        const bal = tx.moveCall({
          target: "0x2::coin::into_balance",
          typeArguments: [USDSUI_TYPE],
          arguments: [split],
        });
        tx.moveCall({
          target: "0x2::balance::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [bal, tx.pure.address(RECIPIENT)],
        });
      },
      { setGasPriceZero: true, setGasBudgetZero: true },
    );
  }

  // ─── SHAPE B7: send entire Coin object via coin::send_funds (no split).
  // The split + send_funds path might trip the per-coin storage budget.
  // A straight coin::send_funds on the whole coin sidesteps that — the
  // input coin's storage rebate exactly covers the call's computation
  // cost. paymentCount=0 confirms no gas coin selected. Net user cost
  // is 0 SUI even though gross computationCost is non-zero (rebate
  // cancels it 1:1).
  if (coinList.length > 0) {
    const big = coinList[0];
    const id = big.coinObjectId ?? big.id ?? big.objectId;
    await runShape(
      "B7_coin_send_funds_whole_coin_no_split",
      (tx) => {
        tx.moveCall({
          target: "0x2::coin::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [tx.object(id), tx.pure.address(RECIPIENT)],
        });
      },
      { setGasPriceZero: true, setGasBudgetZero: true },
    );
  }

  // ─── SHAPE B8: arbitrary-amount via 0x2::coin::split + coin::send_funds.
  // The PTB SplitCoins primitive creates an intermediate object that
  // doesn't fit the gasless rebate window. Try the Move-level
  // 0x2::coin::split entry function instead — its output is a Move-side
  // Coin that may avoid the per-command storage allocation.
  if (coinList.length > 0) {
    const big =
      coinList.find(
        (c) => BigInt(c.balance ?? c.amount ?? "0") >= onchain,
      ) ?? coinList[0];
    const id = big.coinObjectId ?? big.id ?? big.objectId;
    await runShape(
      "B8_coin_move_split_then_send_funds",
      (tx) => {
        const splitCoin = tx.moveCall({
          target: "0x2::coin::split",
          typeArguments: [USDSUI_TYPE],
          arguments: [tx.object(id), tx.pure.u64(onchain)],
        });
        tx.moveCall({
          target: "0x2::coin::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [splitCoin, tx.pure.address(RECIPIENT)],
        });
      },
      { setGasPriceZero: true, setGasBudgetZero: true },
    );
  }

  // ─── SHAPE B9: split via PTB SplitCoins, send split via send_funds,
  //              consume residue back to user via coin::send_funds to
  //              SENDER (self). Tests whether the gasless rail accepts
  //              two coin::send_funds calls (sender + residue both via
  //              gasless primitive).
  if (coinList.length > 0) {
    const big =
      coinList.find(
        (c) => BigInt(c.balance ?? c.amount ?? "0") >= onchain,
      ) ?? coinList[0];
    const id = big.coinObjectId ?? big.id ?? big.objectId;
    await runShape(
      "B9_split_send_funds_plus_residue_back",
      (tx) => {
        const [split] = tx.splitCoins(tx.object(id), [tx.pure.u64(onchain)]);
        tx.moveCall({
          target: "0x2::coin::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [split, tx.pure.address(RECIPIENT)],
        });
        // Send the residue (the remaining input Coin) back to sender via
        // gasless coin::send_funds. This explicitly re-owns the residue
        // so storage rebate accounting closes.
        tx.moveCall({
          target: "0x2::coin::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [tx.object(id), tx.pure.address(SENDER)],
        });
      },
      { setGasPriceZero: true, setGasBudgetZero: true },
    );
  }

  // ─── SHAPE B10: into_balance → balance::split → send_funds (target)
  //              → balance::destroy_zero(residue) OR send_funds residue
  //              back to sender. The hope: balance::send_funds and
  //              balance::split are both within the gasless allowlist
  //              (the canonical Sui-docs pattern).
  if (coinList.length > 0) {
    const big =
      coinList.find(
        (c) => BigInt(c.balance ?? c.amount ?? "0") >= onchain,
      ) ?? coinList[0];
    const id = big.coinObjectId ?? big.id ?? big.objectId;
    await runShape(
      "B10_into_balance_split_send_funds",
      (tx) => {
        const wholeBal = tx.moveCall({
          target: "0x2::coin::into_balance",
          typeArguments: [USDSUI_TYPE],
          arguments: [tx.object(id)],
        });
        const splitBal = tx.moveCall({
          target: "0x2::balance::split",
          typeArguments: [USDSUI_TYPE],
          arguments: [wholeBal, tx.pure.u64(onchain)],
        });
        tx.moveCall({
          target: "0x2::balance::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [splitBal, tx.pure.address(RECIPIENT)],
        });
        // Residue (wholeBal mutated by split) sent back to sender.
        tx.moveCall({
          target: "0x2::balance::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [wholeBal, tx.pure.address(SENDER)],
        });
      },
      { setGasPriceZero: true, setGasBudgetZero: true },
    );
  }

  // ─── SHAPE B11: same as B10 but with the SMALLER coin only (so the
  //              transaction touches less state — fewer storage charges).
  if (coinList.length > 1) {
    // Smallest coin >= amount
    const candidates = coinList
      .filter((c) => BigInt(c.balance ?? c.amount ?? "0") >= onchain)
      .sort((a, b) => Number(BigInt(a.balance) - BigInt(b.balance)));
    const big = candidates[0] ?? coinList[0];
    const id = big.coinObjectId ?? big.id ?? big.objectId;
    await runShape(
      "B11_into_balance_split_send_funds_smallest_coin",
      (tx) => {
        const wholeBal = tx.moveCall({
          target: "0x2::coin::into_balance",
          typeArguments: [USDSUI_TYPE],
          arguments: [tx.object(id)],
        });
        const splitBal = tx.moveCall({
          target: "0x2::balance::split",
          typeArguments: [USDSUI_TYPE],
          arguments: [wholeBal, tx.pure.u64(onchain)],
        });
        tx.moveCall({
          target: "0x2::balance::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [splitBal, tx.pure.address(RECIPIENT)],
        });
        tx.moveCall({
          target: "0x2::balance::send_funds",
          typeArguments: [USDSUI_TYPE],
          arguments: [wholeBal, tx.pure.address(SENDER)],
        });
      },
      { setGasPriceZero: true, setGasBudgetZero: true },
    );
  }

  // ─── SHAPE C: enumerate 0x2 candidate functions ─────────────────────
  // Hand-curated set (gRPC movePackageService.getPackage exists but
  // returning every module's normalized form is expensive; we test the
  // explicit candidates the docs / module dumps point at).
  //
  // Each candidate that takes (Coin<T>, address) is tried over a fresh
  // split coin with setGasPrice(0n).
  const C_CANDIDATES: Array<{ name: string; target: string }> = [
    { name: "C_pay_send", target: "0x2::pay::send" },
    { name: "C_pay_send_funds", target: "0x2::pay::send_funds" },
    { name: "C_pay_transfer", target: "0x2::pay::transfer" },
    { name: "C_pay_split_and_transfer", target: "0x2::pay::split_and_transfer" },
    { name: "C_coin_transfer", target: "0x2::coin::transfer" },
    { name: "C_coin_send", target: "0x2::coin::send" },
    { name: "C_transfer_public_transfer", target: "0x2::transfer::public_transfer" },
  ];
  if (coinList.length > 0) {
    for (const cand of C_CANDIDATES) {
      await runShape(cand.name + "_" + cand.target.replace(/[:<>]/g, "_"), (tx) => {
        const big =
          coinList.find(
            (c) => BigInt(c.balance ?? c.amount ?? "0") >= onchain,
          ) ?? coinList[0];
        const id = big.coinObjectId ?? big.id ?? big.objectId;
        const [split] = tx.splitCoins(tx.object(id), [tx.pure.u64(onchain)]);
        tx.moveCall({
          target: cand.target,
          typeArguments: [USDSUI_TYPE],
          arguments: [split, tx.pure.address(RECIPIENT)],
        });
      });
    }
  }

  // ─── Final summary ──────────────────────────────────────────────────
  const gaslessWinners = RESULTS.filter((r) => r.gaslessProven === true);
  console.log(
    "__GASLESS_SUMMARY__",
    JSON.stringify({
      totalShapes: RESULTS.length,
      buildOk: RESULTS.filter((r) => r.buildOk).length,
      simulateOk: RESULTS.filter((r) => r.simulateOk).length,
      effectsSuccess: RESULTS.filter((r) => r.effectsStatusSuccess).length,
      gaslessProven: gaslessWinners.length,
      winners: gaslessWinners.map((r) => r.name),
    }),
  );
  console.log("__RESULTS__", JSON.stringify(RESULTS, null, 2));
  console.log("__PROBE_DONE__");
}, 240_000);
`;

writeFileSync(testFile, src, "utf8");

const res = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.integration.config.ts",
    testFile,
    "--reporter=verbose",
    "--silent=false",
  ],
  { stdio: "inherit", cwd: process.cwd() },
);

try {
  spawnSync("rm", ["-f", testFile]);
} catch {
  /* leave it; not load-bearing */
}

// Exit 0 so callers always see the matrix output even if individual shapes
// failed (they're expected to in the negative case).
process.exit(0);
