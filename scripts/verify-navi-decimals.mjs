#!/usr/bin/env node
/**
 * verify-navi-decimals.mjs
 *
 * Settles the NAVI "Earned so far" overinflation: is the SHIPPED currentValue
 * (readNaviUsdsuiSupply, divides rayMul(supply_balance, supplyIndex) by
 * 10^token.decimals == 10^6) correct, or ~1000x inflated vs the trusted
 * NaviAdapter.getPositions().amount (which the pre-7f5cc4d code used)?
 *
 * Prints, for <address>:
 *   - raw supply_balance (scaled) + currentSupplyIndex
 *   - rayMul(...) base
 *   - base / 10^6  (SHIPPED readNaviUsdsuiSupply)
 *   - base / 10^9  (proposed fix if NAVI normalizes to 9dp)
 *   - NaviAdapter.getPositions().amount  (TRUSTED)
 *
 * Run: cd web && node scripts/verify-navi-decimals.mjs <address?>
 */
import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { NaviAdapter } from "@t2000/sdk";

const ADDR = (
  process.argv[2] ||
  "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c"
).toLowerCase();

const NAVI_POOLS_URL = "https://open-api.naviprotocol.io/api/navi/pools?env=prod";
const NAVI_CONFIG_URL = "https://open-api.naviprotocol.io/api/navi/config?env=prod";
const RAY = 10n ** 27n;

const UserStateInfo = bcs.struct("UserStateInfo", {
  asset_id: bcs.u8(),
  borrow_balance: bcs.u256(),
  supply_balance: bcs.u256(),
});

function rayMul(rawScaled, supplyIndex) {
  const r = BigInt(rawScaled);
  const i = BigInt(supplyIndex);
  if (r === 0n || i === 0n) return 0n;
  return (r * i + RAY / 2n) / RAY;
}

function isUsdsui(coinType) {
  return /::usdsui::usdsui$/i.test(coinType || "");
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`address: ${ADDR}\n`);
  const client = new SuiClient({ url: getFullnodeUrl("mainnet"), network: "mainnet" });

  const [poolsBody, cfgBody] = await Promise.all([
    getJson(NAVI_POOLS_URL),
    getJson(NAVI_CONFIG_URL),
  ]);
  const pools = poolsBody?.data ?? [];
  const cfg = cfgBody?.data ?? {};
  const usdsui = pools.find((p) => isUsdsui("0x" + String(p.coinType || "").replace(/^0x/, "")));
  if (!usdsui) throw new Error("USDsui pool not found in NAVI open-api pools");

  console.log(`USDsui pool: id=${usdsui.id} decimals=${usdsui.token?.decimals} symbol=${usdsui.token?.symbol}`);
  console.log(`currentSupplyIndex=${usdsui.currentSupplyIndex}`);
  console.log(`uiGetter=${cfg.uiGetter}\nstorage=${cfg.storage}\n`);

  const tx = new Transaction();
  tx.moveCall({
    target: `${cfg.uiGetter}::getter_unchecked::get_user_state`,
    arguments: [tx.object(cfg.storage), tx.pure.address(ADDR)],
  });
  const inspect = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: ADDR });
  const bytes = inspect.results?.[0]?.returnValues?.[0]?.[0];
  if (!bytes) {
    console.log("get_user_state returned no bytes (empty position?)");
  } else {
    const rows = bcs.vector(UserStateInfo).parse(Uint8Array.from(bytes));
    const row = rows.find((r) => Number(r.asset_id) === Number(usdsui.id));
    if (!row) {
      console.log(`no USDsui row (asset_id ${usdsui.id}) among: ${rows.map((r) => r.asset_id).join(",")}`);
    } else {
      const base = rayMul(String(row.supply_balance), String(usdsui.currentSupplyIndex ?? "0"));
      const dec = Number(usdsui.token?.decimals ?? 6);
      console.log(`raw supply_balance (scaled): ${row.supply_balance}`);
      console.log(`rayMul base                : ${base}`);
      console.log(`base / 10^${dec}  (SHIPPED readNaviUsdsuiSupply): ${Number(base) / 10 ** dec}`);
      console.log(`base / 10^9      (if 9dp normalized)           : ${Number(base) / 1e9}`);
      console.log(`base / 10^6                                    : ${Number(base) / 1e6}`);
    }
  }

  console.log(`\nNaviAdapter.getPositions() [TRUSTED, pre-7f5cc4d source]:`);
  try {
    const a = new NaviAdapter();
    await a.init(client);
    const positions = await a.getPositions(ADDR);
    const row = positions.supplies.find((s) => String(s.asset).toLowerCase() === "usdsui");
    console.log(`  USDsui supply amount = ${row?.amount} (amountUsd=${row?.amountUsd}, apy=${row?.apy})`);
    console.log(`  full supplies: ${JSON.stringify(positions.supplies)}`);
  } catch (e) {
    console.log(`  ERROR ${e.message}`);
  }
}

main().catch((e) => {
  console.error("fatal:", e.message);
  process.exit(1);
});
