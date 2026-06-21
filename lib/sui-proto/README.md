# Sui gRPC Protobuf Definitions (web)

Vendored copy of the Sui `sui.rpc.v2` protobuf definitions plus the Google
`protobuf` / `rpc` imports they depend on. Both the web backend and the iOS SDK
own independent copies of this tree so each platform can regenerate its own
client without depending on the other.

## Source

- Upstream repo: `https://github.com/MystenLabs/sui-rust-sdk`
- Upstream path: `crates/sui-rpc/vendored/proto/`
- Pinned revision: `5b41bc701525f1b94f1fe63008d4841bc6fb1065`
  (61 commits past tag `sui-rpc-0.3.1`)
- Matching Sui core release: `mainnet-v1.72.2`
  (the `Cargo.toml` of that release pins `sui-rpc` to this exact rev)
- Matching TS SDK: `@mysten/sui@2.16.3` — its generated TS clients under
  `dist/grpc/proto/sui/rpc/v2/*` were produced from these `.proto` files.

Historical note: in earlier Sui releases these definitions lived at
`crates/sui-rpc-api/proto/sui/rpc/v2/*.proto` inside the `MystenLabs/sui`
repo. They were extracted into `MystenLabs/sui-rust-sdk` and `sui-rpc-api`
now consumes them as a build dependency. The README task statement still
refers to the old path; the canonical source is now sui-rust-sdk.

## Layout

```
proto/
  google/
    protobuf/{any,duration,empty,field_mask,struct,timestamp}.proto
    rpc/{error_details,status}.proto
  sui/
    rpc/v2/*.proto    # 29 service + message files
```

Total: 39 `.proto` files, ~256 KB on disk.

## Regenerating clients

A `scripts/regen-proto.sh` will be added in the next phase. It will run
`protoc` (or `buf generate`) against this `proto/` tree to produce
TypeScript/Swift stubs under `web/lib/sui-proto/generated/` and
`ios/Talise/Network/SuiProto/Generated/` respectively.

## Updating

1. Pick the new Sui core release tag.
2. Look up the `sui-rpc` git rev in that tag's root `Cargo.toml`.
3. Clone `MystenLabs/sui-rust-sdk` at that rev.
4. Replace the contents of `proto/` from `crates/sui-rpc/vendored/proto/`.
5. Update the "Pinned revision" and "Matching Sui core release" lines above.
6. Re-run `scripts/regen-proto.sh`.

Do not edit files under `proto/` by hand.
