#!/usr/bin/env bash
# lint-no-jsonrpc.sh
# Fails if any NEW file (outside the allowlist) imports SuiJsonRpcClient,
# from @mysten/sui/jsonRpc, or references the legacy `suiJsonRpc()` helper.
# The Phase 5 migration removed JSON-RPC from the targeted call sites; this
# gate prevents regression. The allowlist is restricted to operator scripts
# and SDK-init helpers that the Phase 5 scope explicitly DID NOT cover.
#
# Usage (from repo root or web/):
#   bash web/scripts/lint-no-jsonrpc.sh
#   bash scripts/lint-no-jsonrpc.sh

set -uo pipefail

# Resolve repo root (script lives at <repo>/web/scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WEB_DIR="${REPO_ROOT}/web"

# Three patterns: the SDK class, the import surface, and the now-deleted
# `suiJsonRpc()` helper (still grepped to catch stale references in PRs).
PATTERN='SuiJsonRpcClient|@mysten/sui/jsonRpc|\bsuiJsonRpc\b'

# Allowlist (paths relative to repo root). Post-Phase-5 the allowlist is
# the MINIMUM SET of files that intentionally still touch JSON-RPC:
#
#   • web/lib/coins.ts                → SDK wraps SuiJsonRpcClient internally for
#                                       coin metadata + getAllCoins; no gRPC analog
#                                       in @mysten/sui ^2.16.
#   • web/lib/t2000.ts                → T2000 SDK only accepts a JSON-RPC URL;
#                                       SDK constructs its own client internally.
#   • web/lib/yield.ts                → Same — @t2000/sdk's getFinancialSummary
#                                       requires a JSON-RPC client surface.
#   • web/lib/payment-kit.ts          → Doc-comment only; no import. Kept until
#                                       comment is rewritten in a follow-up.
#   • web/scripts/*                   → Operator/debug scripts; not part of any
#                                       runtime path. Out of Phase 5 scope.
#
# Deferred (NOT in allowlist; documented elsewhere):
#   • ios/Talise/Auth/ZkLoginCoordinator.swift — sub-plan 5.6 parked pending
#     iOS deploy-target decision. Excluded from the sweep, not the lint.
# Additional deliberate exceptions (post-Phase-5, justified):
#   • web/scripts/probe-* → operator/debug probes; not on any runtime path.
#
# Removed 2026-07-10: web/lib/navi-supply.ts. NAVI Earn is now gRPC-native —
# @t2000/sdk's NaviAdapter is fed a gRPC-backed JSON-RPC-compat client
# (web/lib/navi-grpc-client.ts) instead of a SuiJsonRpcClient. No banned
# symbol remains in navi-supply.ts. See memory: navi-earn-grpc-migration.
#
# Removed 2026-06-01: web/app/api/send/sponsor-prepare/route.ts and the
# web/__tests__/sui/{send-gasless,send-sponsored,broadcast-config}.test.ts
# trio. The gasless build moved off SuiJsonRpcClient onto an offline gRPC
# build (tx.setGasPayment([]) + post-build gRPC simulate), so none of them
# reference a banned symbol anymore.
ALLOWLIST=(
  "web/lib/coins.ts"
  "web/lib/payment-kit.ts"
  "web/lib/t2000.ts"
  "web/lib/yield.ts"
  "web/scripts/bootstrap-payment-registry.mjs"
  "web/scripts/debug-navi-earned.mjs"
  "web/scripts/navi-grpc-validate.mjs"
  "web/scripts/probe-navi-withdraw.mjs"
  "web/scripts/probe-shinami-broadcast.mjs"
  "web/scripts/probe-valid-during.mjs"
  "web/scripts/probe-grpc-gasless.mjs"
  "web/scripts/recover-stranded.mjs"
  "web/scripts/sweep-accumulator.mjs"
  "web/scripts/sweep-now.mjs"
  "web/scripts/test-resolve.mts"
  "web/scripts/test-suins.mts"
  "web/scripts/verify-navi-decimals.mjs"
  "web/scripts/zk-speed-test.mjs"
)

is_allowlisted() {
  local f="$1"
  for a in "${ALLOWLIST[@]}"; do
    if [[ "$f" == "$a" ]]; then
      return 0
    fi
  done
  return 1
}

# Find all matching files under web/, excluding build/dep dirs.
# Use grep -rl with --exclude-dir for portability (macOS BSD grep + GNU grep).
HITS_RAW="$(cd "${REPO_ROOT}" && grep -rl \
    --exclude-dir=node_modules \
    --exclude-dir=.next \
    --exclude-dir=dist \
    --exclude-dir=.turbo \
    --exclude-dir=out \
    -E "${PATTERN}" \
    web 2>/dev/null | sed 's|//*|/|g' | sort -u)"

VIOLATIONS=""
VCOUNT=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  # Skip the lint script itself (it intentionally contains the pattern strings).
  if [[ "$f" == "web/scripts/lint-no-jsonrpc.sh" ]]; then
    continue
  fi
  if ! is_allowlisted "$f"; then
    VIOLATIONS="${VIOLATIONS}${f}"$'\n'
    VCOUNT=$((VCOUNT + 1))
  fi
done <<< "$HITS_RAW"

if (( VCOUNT > 0 )); then
  echo "lint-no-jsonrpc: FAIL"
  echo ""
  echo "The following files import a banned JSON-RPC symbol but are NOT"
  echo "on the allowlist. Refactor to GraphQL / the supported client, or"
  echo "if this is a deliberate temporary exception, add the file path to"
  echo "the ALLOWLIST in web/scripts/lint-no-jsonrpc.sh and justify in PR."
  echo ""
  printf '%s' "$VIOLATIONS" | while IFS= read -r v; do
    [[ -z "$v" ]] && continue
    echo "  - ${v}"
  done
  echo ""
  echo "Banned patterns: SuiJsonRpcClient, @mysten/sui/jsonRpc, suiJsonRpc"
  exit 1
fi

echo "lint-no-jsonrpc: OK (no new JSON-RPC imports; allowlist size: ${#ALLOWLIST[@]})"
exit 0
