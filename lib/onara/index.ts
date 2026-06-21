export { OnaraClient } from './client'
export type { OnaraClientOptions } from './client'
export { OnaraError } from './errors'

import { OnaraClient } from './client'

let _onara: OnaraClient | null = null

/**
 * Module-level singleton so the same Node fetch pool / TLS session is reused
 * across requests. Creating a new client per request was throwing away
 * keep-alive entirely and adding ~150ms of TLS handshake per call.
 */
export function onara(): OnaraClient {
  if (_onara) return _onara
  const url = process.env.ONARA_URL
  if (!url) throw new Error('ONARA_URL not configured')
  _onara = new OnaraClient(url)
  return _onara
}
export type {
  StatusResponse,
  PolicyConfig,
  PolicyCallLimitRange,
  PolicyCallLimitCountMatch,
  PolicyCallLimit,
  PolicyOrderingRule,
  PolicyResultFlowRule,
  PolicySequenceStep,
  SponsorOptions,
  SponsorDryRunResponse,
  SponsorExecutionResponse,
  SponsorResponse,
  OnaraErrorResponse,
} from './types'
