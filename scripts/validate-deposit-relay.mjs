process.env.SHIELD_PKG="0x8722790773958722225cf91f5a6762689dc13f97076534c05ebd3505d586f9bf";
process.env.SHIELD_RELAYER_ADDRESS="0x37949e572bbc9cd57b7817cf3d309c0fa1b5361e0bc7605f6feffc6b6fdb72af";
const {validateTransactCommands}=await import("../lib/shield/validate-commands.ts");
const fs=await import("node:fs");
try{const v=validateTransactCommands(fs.readFileSync("/tmp/shield-deposit-relay-ptb.json","utf8"),{});console.log("DEPOSIT(relayed) validate: ACCEPTED fn="+v.fn+" relayer="+v.relayer+" fee="+String(v.relayerFee));}catch(e){console.log("DEPOSIT(relayed) validate: REJECTED -",e.message);}
