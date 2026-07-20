// ─── API Responses ───────────────────────────────────────────────────────────

export type StatusResponse = {
  network: string
  chainId: string | null
  address: string
  balances: { active: string; pending: string } | null
}

// ─── Policy Config Types ─────────────────────────────────────────────────────

export type PolicyCallLimitRange = {
  min?: number
  max?: number
}

export type PolicyCallLimitCountMatch = {
  countMatch: string
}

export type PolicyCallLimit = PolicyCallLimitRange | PolicyCallLimitCountMatch

export type PolicyOrderingRule = {
  before: string
  after: string
}

export type PolicyResultFlowRule = {
  from: string
  to: string[]
  required?: boolean
}

export type PolicySequenceStep = {
  id: string
  targets: string[]
  count?: number
  min?: number
  max?: number
}

export type PolicyConfig = {
  name: string
  enabled?: boolean
  senders?: string[]
  gasBudgetMax?: number
  targets?: string[]
  sequence?: PolicySequenceStep[]
  callLimits?: Record<string, PolicyCallLimit>
  ordering?: PolicyOrderingRule[]
  resultFlow?: PolicyResultFlowRule[]
  typeArguments?: Record<string, Record<string, string[]>>
  maxCommands?: number
  allowedCommandKinds?: string[]
}

// ─── Sponsor Types ───────────────────────────────────────────────────────────

export type SponsorOptions = {
  sender: string
  txBytes: string
  txSignature: string
  dryRun?: boolean
  waitForExecution?: boolean
  /**
   * Skip Onara's pre-broadcast dry-run simulation (`?simulate=false`). The
   * simulate step is a full extra RPC round-trip (with its own retry) before
   * the sponsor signs + broadcasts, pure latency on the user's hot send path.
   * Since the send is already optimistic (waitForExecution:false, iOS polls the
   * digest for the real outcome), skipping it removes a round-trip and a major
   * source of the "onara timeout" under RPC congestion. Leave unset (simulate
   * on) for paths that want the pre-flight abort check.
   */
  simulate?: boolean
  /**
   * Per-call fetch timeout in ms. Enforced via AbortController. Default
   * 8000ms. Aborts surface as `OnaraError("onara timeout after Nms", 504)`
   * so the caller can branch on the error shape.
   *
   * Why a per-call override? sponsor-execute is on the user's hot path -
   * an unresponsive Onara upstream used to hang the Node socket until GC,
   * blowing through iOS's URLSession timeout. Other callers (status,
   * policies, dry-runs in tests) can leave the default.
   */
  timeoutMs?: number
}

export type SponsorDryRunResponse = {
  dryRun: true
  policy: string
  moveCallTargets: string[]
}

export type SponsorExecutionResponse = Record<string, unknown>

export type SponsorResponse = SponsorDryRunResponse | SponsorExecutionResponse

// ─── Error Types ─────────────────────────────────────────────────────────────

export type OnaraErrorResponse = {
  error: string
}
