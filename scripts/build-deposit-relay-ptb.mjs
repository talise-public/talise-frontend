import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
const PKG="0x8722790773958722225cf91f5a6762689dc13f97076534c05ebd3505d586f9bf";
const POOL="0x6bcd28763456db543d0c29acb34970b81e4d7f004d2581fce46b813ece8152c1";
const COIN_TYPE="0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const RELAYER="0x37949e572bbc9cd57b7817cf3d309c0fa1b5361e0bc7605f6feffc6b6fdb72af";
const USDSUI_COIN="0x8a1c28a71ddfb123581eef0325c42212f3ce4161a4fc06b1702914c777ad4b27";
const proofHex="6cf350feaf23c93c465aea1ea2712bce059e96dfe27b5f84f746dc1f9280820b952c822ce307395140ccfd29c19ebe6006c4ed906d12535248d16f75a8bacb154d56841c071907c1650eeb2d21332761cd878cdcad512138a5e00263f59cf092a219c0a4a38700037614373abc49e3aa4c38633c9e113aa94a19d34df3fb9da5";
const pp=Uint8Array.from(proofHex.match(/.{2}/g).map(b=>parseInt(b,16)));
const P={root:4023688209857926016730691838838984168964497755397275208674494663143007853450n,publicValue:200000n,n0:8874489674610852055365825450502871696107617634674944839590774381311671432138n,n1:14735100347003117441335642801124275357118802347964005792522872815119077059237n,c0:17408295006874939298598769143181987675548030690756001296663597550777327872539n,c1:12013773756360371331370722014999054062474954786002594294326912317717327531506n};
const tx=new Transaction();
const proofArg=tx.moveCall({target:`${PKG}::proof::new`,typeArguments:[COIN_TYPE],arguments:[tx.pure.address(POOL),tx.pure(bcs.vector(bcs.u8()).serialize(pp)),tx.pure(bcs.u256().serialize(P.root)),tx.pure(bcs.u256().serialize(P.publicValue)),tx.pure(bcs.u256().serialize(P.n0)),tx.pure(bcs.u256().serialize(P.n1)),tx.pure(bcs.u256().serialize(P.c0)),tx.pure(bcs.u256().serialize(P.c1))]});
const extArg=tx.moveCall({target:`${PKG}::ext_data::new`,arguments:[tx.pure(bcs.u64().serialize(200000n)),tx.pure(bcs.bool().serialize(true)),tx.pure.address(RELAYER),tx.pure(bcs.u64().serialize(0n)),tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array([1,2,3]))),tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array([4,5,6])))]});
const [dep]=tx.splitCoins(tx.objectRef({objectId:USDSUI_COIN,version:"697461204",digest:"5K2bpN9XzNtuHaWKBSdRuz4Vw5AAxzAygcAPBVUbAddD"}),[tx.pure.u64(200000n)]);
const pool=tx.sharedObjectRef({objectId:POOL,initialSharedVersion:"919114728",mutable:true});
const out=tx.moveCall({target:`${PKG}::shielded_pool::transact`,typeArguments:[COIN_TYPE],arguments:[pool,dep,proofArg,extArg]});
tx.transferObjects([out],tx.pure.address(RELAYER)); // deposit return coin (zero) -> relayer
const fs=await import("node:fs"); fs.writeFileSync("/tmp/shield-deposit-relay-ptb.json", await tx.toJSON());
console.log("deposit relay PTB written");
