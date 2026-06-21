/**
 * Talise app barrel. Feature pages import primitives, hooks, the data client,
 * and the AppShell from here:
 *
 *   import { GlassCard, AmountDisplay, useBalances, useSignAndSend } from "@/components/app";
 */

export * from "./ui";
export * from "./data";
export { AppShell, default as AppShellDefault } from "./AppShell";
export type { AppShellProps } from "./AppShell";
