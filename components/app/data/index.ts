/**
 * Data-layer barrel. Pages import the client, providers, hooks, and the
 * Google sign-in trigger from "@/components/app/data" (or the top-level
 * "@/components/app" barrel which re-exports this).
 */

export { api, ApiError } from "./api";
export type { ApiOptions } from "./api";

export {
  CurrencyProvider,
  useCurrency,
  CURRENCIES,
} from "./currency";
export type { CurrencyDef, CurrencyCtx } from "./currency";

export { ToastProvider, useToast } from "./toast";
export type { ToastTone } from "./toast";

export {
  useMe,
  useBalances,
  useActivity,
  useContacts,
  resolveRecipient,
  seedResource,
} from "./hooks";
export type { Me, Balances, ActivityEntry, Contact } from "./hooks";

export { useSignAndSend } from "./send";
export type { SendArgs } from "./send";

export {
  useHiddenAmounts,
  MASK_BALANCE,
  MASK_AMOUNT,
} from "./useHiddenAmounts";

// Re-export the Google sign-in trigger so pages can start OAuth without
// reaching into web/lib/zkclient directly.
export { triggerOauthSignIn } from "@/lib/zkclient";
