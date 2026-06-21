// One-off: rescue address-owned Coin<SUI> objects at the user's vault address
// by calling the new `vault::receive_and_deposit<SUI>` entry function.
//
// Signed by the Onara sponsor keypair (which is also the registry admin)
// since `receive_and_deposit` doesn't gate on caller identity — anyone
// can claim a coin sent to the vault's address into the vault's bag.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

const PACKAGE_V2 =
  "0x45654c43edf8ce7229b6f6edc90509b1f84f77e38abd8b507193df338bc49046";
const VAULT_ID =
  "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";

const STRANDED_COINS = [
  {
    objectId: "0x265574d4df04575310471c7be4144bcf3cfb1641c23b1553b564513ddf566878",
    version: "893712848",
    digest: "7pGW8jLedM2EdXRmEYUuWwT22zJd2E6nrpEaTwFHLAXi",
  },
  {
    objectId: "0x7c4917543f266262568accb93af4b47304834347038b2f4f95bf652e49dbeaaf",
    version: "893167289",
    digest: "F7mpY2GhagLWQ4LbNyt8yz2TuwnXB3Ha7roECnuUQkKa",
  },
];

const mnemonic = readFileSync(
  "/Users/eromonseleodigie/Talise/onara/api/.dev.vars",
  "utf8"
)
  .split("\n")
  .find((l) => l.startsWith("SUI_MNEMONIC="))
  .replace(/^SUI_MNEMONIC="?|"?$/g, "")
  .trim();

const keypair = Ed25519Keypair.deriveKeypair(mnemonic);
const sender = keypair.toSuiAddress();
console.log("sender:", sender);

const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl("mainnet") });

const tx = new Transaction();
tx.setSender(sender);

for (const c of STRANDED_COINS) {
  tx.moveCall({
    target: `${PACKAGE_V2}::vault::receive_and_deposit`,
    typeArguments: ["0x2::sui::SUI"],
    arguments: [
      tx.object(VAULT_ID),
      tx.receivingRef({
        objectId: c.objectId,
        version: c.version,
        digest: c.digest,
      }),
    ],
  });
}

const result = await client.signAndExecuteTransaction({
  transaction: tx,
  signer: keypair,
  options: { showEffects: true, showObjectChanges: true },
});

console.log("digest:", result.digest);
console.log("status:", result.effects?.status);
