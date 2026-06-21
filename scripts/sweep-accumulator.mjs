// One-shot: claim the stranded accumulator balances at the vault
// address via the new v5 `vault::receive_from_accumulator<T>(amount)`
// entry. Signed by Onara sponsor (anyone can call — permissionless
// by design, destination is the vault's own bag).
import { readFileSync } from "node:fs";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

const PACKAGE_V5 =
  "0xd969ca63a796f88fae10fa1cfe67b6f5c75b71a9f89b7c7607f9898dad7f12c6";
const VAULT_ID =
  "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";

// (coinType, amount in raw u64) — what the accumulator currently
// holds for this vault. Reads via suix_getAllBalances.
const CLAIMS = [
  {
    coinType:
      "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    amount: "200000",
  },
  {
    coinType:
      "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI",
    amount: "100000",
  },
];

const mnemonic = readFileSync(
  "/Users/eromonseleodigie/Talise/onara/api/.dev.vars",
  "utf8",
)
  .split("\n")
  .find((l) => l.startsWith("SUI_MNEMONIC="))
  .replace(/^SUI_MNEMONIC="?|"?$/g, "")
  .trim();

const keypair = Ed25519Keypair.deriveKeypair(mnemonic);
const sender = keypair.toSuiAddress();
console.log("sender:", sender);

const client = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl("mainnet"),
  network: "mainnet",
});

const tx = new Transaction();
tx.setSender(sender);
tx.setGasBudget(50_000_000);

for (const c of CLAIMS) {
  tx.moveCall({
    target: `${PACKAGE_V5}::vault::receive_from_accumulator`,
    typeArguments: [c.coinType],
    arguments: [tx.object(VAULT_ID), tx.pure.u64(c.amount)],
  });
}

const result = await client.signAndExecuteTransaction({
  transaction: tx,
  signer: keypair,
  options: { showEffects: true, showObjectChanges: true },
});

console.log("digest:", result.digest);
console.log("status:", result.effects?.status);
if (result.effects?.status?.status !== "success") {
  console.log("effects:", JSON.stringify(result.effects, null, 2));
}
