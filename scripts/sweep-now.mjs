// One-shot: claim the 0.2 USDC + 0.1 USDsui currently stranded as
// address-owned Coin<T> at the vault address. Signed by Onara sponsor
// (which is also registry admin). After this lands, the next cron
// tick's deposit_to_owner step flushes the resulting bag balances to
// the user's wallet.
import { readFileSync } from "node:fs";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

const PACKAGE_LATEST =
  "0x29a0d730506baf8d60b70950f4696fbe85ab2cfdd5d1f536ff7e433f3eb4715a"; // v4
const VAULT_ID =
  "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";

const COINS = [
  {
    objectId: "0x42fcc1f3b00909d3c515b48a7273dfcd6fc2f790631411f19083635e6015e2d5",
    coinType:
      "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  },
  {
    objectId: "0x89e5737345cabec3d8602810bcbbe72ac019dd416ecefa9fe1b643376af14614",
    coinType:
      "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI",
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

// Fetch live version + digest for each coin RIGHT NOW so we never trust
// stale references.
const refs = [];
for (const c of COINS) {
  const obj = await client.getObject({
    id: c.objectId,
    options: { showOwner: true },
  });
  if (!obj.data) {
    console.error(`coin ${c.objectId} not found`);
    continue;
  }
  console.log(`coin ${c.objectId.slice(0, 10)}…  version=${obj.data.version}  digest=${obj.data.digest}`);
  refs.push({
    objectId: c.objectId,
    version: obj.data.version,
    digest: obj.data.digest,
    coinType: c.coinType,
  });
}

const tx = new Transaction();
tx.setSender(sender);
// Skip the dry-run gas estimation — it's been hitting a stale fullnode
// snapshot that rejects the receivingRef at its actual current version.
// Use a generous fixed budget instead.
tx.setGasBudget(50_000_000);
for (const r of refs) {
  tx.moveCall({
    target: `${PACKAGE_LATEST}::vault::receive_and_deposit`,
    typeArguments: [r.coinType],
    arguments: [
      tx.object(VAULT_ID),
      tx.receivingRef({
        objectId: r.objectId,
        version: r.version,
        digest: r.digest,
      }),
    ],
  });
}

const result = await client.signAndExecuteTransaction({
  transaction: tx,
  signer: keypair,
  options: { showEffects: true },
});

console.log("digest:", result.digest);
console.log("status:", result.effects?.status);
