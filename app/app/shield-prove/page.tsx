import { shieldConfigured, SHIELD } from "@/lib/shield/onchain";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { ShieldProveHarness } from "./harness";

export const dynamic = "force-dynamic";

/**
 * /app/shield-prove — HIDDEN prover harness for the native iOS private-send flow.
 *
 * This page is never shown to a human. The native `PrivateSendFlowView` mounts
 * it inside a 0×0 WKWebView (authenticated via the bearer→web-session bridge)
 * and calls `window.taliseShieldSend(micros, recipient)`. The harness runs the
 * shielded send CLIENT-SIDE (the Groth16 proof is built in-page, so the relayer
 * never sees note secrets) and posts progress + the final digest back over the
 * `shield` script-message handler.
 *
 * STATUS: the native UI + the bridge + this harness are wired end to end. The
 * last mile — the in-browser WASM prove + non-custodial shield-key derivation
 * for zkLogin users (PRIVACY-BUILD-PLAN.md Workstream D) — is what makes a real
 * send execute. Until that lands the harness reports an honest "finalizing"
 * status (it never fakes a success and never moves funds), so the native flow
 * fails cleanly rather than silently.
 */
export default function ShieldProvePage() {
  return (
    <ShieldProveHarness
      live={shieldConfigured()}
      packageId={SHIELD.packageId ?? ""}
      poolObjectId={SHIELD.poolUsdsui ?? ""}
      coinType={USDSUI_TYPE}
    />
  );
}
