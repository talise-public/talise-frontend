process.env.SHIELD_PKG = "0x8722790773958722225cf91f5a6762689dc13f97076534c05ebd3505d586f9bf";
process.env.SHIELD_RELAYER_ADDRESS = "0x37949e572bbc9cd57b7817cf3d309c0fa1b5361e0bc7605f6feffc6b6fdb72af";
const { validateTransactCommands } = await import("../lib/shield/validate-commands.ts");
const fs = await import("node:fs");
const wjson = fs.readFileSync("/tmp/shield-withdraw-ptb.json", "utf8");
const EXIT = "0x39d4ded1f081c828662dcbf4a43c9183c9e10510112e269d961cf89c90b1ae7b";
try {
  const v = validateTransactCommands(wjson, { exitAddress: EXIT });
  console.log("WITHDRAW validate-commands: ACCEPTED  fn=" + v.fn + " relayer=" + v.relayer + " relayerFee=" + String(v.relayerFee));
} catch (e) {
  console.log("WITHDRAW validate-commands: REJECTED -", e.message);
}
