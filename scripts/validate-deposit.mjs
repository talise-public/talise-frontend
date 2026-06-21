process.env.SHIELD_PKG = "0x8722790773958722225cf91f5a6762689dc13f97076534c05ebd3505d586f9bf";
process.env.SHIELD_RELAYER_ADDRESS = "0x37949e572bbc9cd57b7817cf3d309c0fa1b5361e0bc7605f6feffc6b6fdb72af";
const { validateTransactCommands } = await import("../lib/shield/validate-commands.ts");
const fs = await import("node:fs");
const djson = fs.readFileSync("/tmp/shield-deposit-ptb.json", "utf8");
// NOTE: the deposit sim used relayer=@0x0 + transfer to coin owner (self-submit).
// The relay control requires relayer == ours; a relayed deposit would set both.
try {
  const v = validateTransactCommands(djson, {});
  console.log("DEPOSIT(self-submit) validate: ACCEPTED fn=" + v.fn);
} catch (e) {
  console.log("DEPOSIT(self-submit) validate: REJECTED -", e.message, "(expected: self-submit PTB names @0x0, not the relay control's relayer)");
}
