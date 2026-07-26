/**
 * Provider-agnostic fiat-out (off-ramp) layer.
 *
 * Public surface, in the order a caller usually needs it:
 *
 *   config      , env-driven corridor routing + the FAIL-CLOSED product gate
 *   registry    , `resolvePayoutCorridor(ccy)` → primary/fallback + health
 *   provider    , the `PayoutProvider` contract + `submitPayout` (idempotent)
 *   breaker     , circuit breaking + provider error taxonomy
 *   status      , MONOTONIC payout-status writes (terminal states are sticky)
 *   reconcile   , terminal-state reconciliation + the refund queue
 *   caps        , the all-rails daily cash-out cap
 *   store       , the layer's own tables (`ensureOfframpProviderSchema`)
 *
 * The live rails are `linq` (NGN) and `bridge` (USD/EUR). Every other corridor
 * is a STUB and is unselectable outside development, on purpose: a stub reports
 * "pending" forever, which a user cannot distinguish from a payout that died.
 */

export * from "./types";
export * from "./registry";
export {
  cashoutOpen,
  CASHOUT_CLOSED_MESSAGE,
  CORRIDOR_DEGRADED_MESSAGE,
  corridorProviderOrder,
  providerBaseUrl,
  stubsAllowed,
  disabledProviders,
  BREAKER,
  DEPOSIT_WINDOW_MS,
  strandedAfterMs,
  LIVE_PROVIDER_IDS,
  type ProviderId,
} from "./config";
export {
  registerProvider,
  getProvider,
  listProviders,
  resolveCorridor,
  requireProvider,
  submitPayout,
  fromAdapter,
  type PayoutProvider,
  type PayoutSubmission,
  type ProviderReadiness,
  type CorridorResolution,
  type ResolvedCandidate,
  type SubmitPayoutInput,
  type SubmitPayoutResult,
} from "./provider";
export {
  checkBreaker,
  reportProviderOutcome,
  withBreaker,
  isProviderSideFailure,
  providerErrorForStatus,
  ProviderTransportError,
  ProviderRequestError,
  ProviderUnavailableError,
  type BreakerVerdict,
} from "./breaker";
export {
  applyLinqStatus,
  phaseOf,
  isTerminalPhase,
  phaseAdvanceAllowed,
  type PayoutPhase,
} from "./status";
export { reconcileLinqPayouts, refundQueue, type ReconcileSummary } from "./reconcile";
export { checkDailyOfframpCapAllRails, type CapVerdict } from "./caps";
export {
  ensureOfframpProviderSchema,
  claimIntent,
  completeIntent,
  releaseIntent,
  intentKey,
  fingerprintKey,
  recordAttempt,
  markAttemptFunded,
  settleAttempt,
  recordProviderEvent,
  listProviderHealth,
  readProviderHealth,
  resetProviderHealth,
  sumRecentAttemptUsd,
  listRefundsOwed,
  type BreakerState,
  type ProviderHealthRow,
  type ClaimResult,
  type IntentClaim,
} from "./store";
export { linqProvider } from "./linq-provider";
export { bridgeProvider, bridgeStateToStatus, attachBridgeMeta } from "./bridge-provider";
export { paynowSgAdapter } from "./paynow-sg";
export { zenginJpAdapter } from "./zengin-jp";
export { mpesaKeAdapter } from "./mpesa-ke";
export { makeGenericBankAdapter } from "./generic-bank";
export type { GenericBankCurrency } from "./generic-bank";
