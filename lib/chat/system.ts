/**
 * Plan 12, system prompt + tool definitions for the streaming AI chat
 * (`/api/chat/stream`). Kept separate from the existing DeepSeek-backed
 * `/api/chat` route so the two endpoints can evolve independently.
 *
 * The prompt is grounded in TALISE-specific facts: the user's address,
 * their `<handle>.talise` subname, and the venues we actually integrate
 * with (NAVI + DeepBook margin). Tools mirror the four read paths the
 * iOS Home/Earn pages already use, plus one math-only projector.
 *
 * `cache_control: ephemeral` is set on the system prompt + tool defs by
 * the route so Anthropic's prompt cache amortizes them across turns.
 */
import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";

import { getSuiBalance, getUsdsuiBalance } from "@/lib/sui";
import { getRecentActivity } from "@/lib/activity";
import { getYieldComparison } from "@/lib/yield";

/** Default model id when AI Gateway is configured. */
export const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-4-6";

export type ChatUserContext = {
  /** Sui address, already lowercased + validated upstream. */
  address: string;
  /** Optional Talise subname (`<handle>.talise`). */
  handle: string | null;
  /** Best-effort first name from /api/me, used for greetings. */
  firstName: string | null;
};

/**
 * Build the system prompt. Kept short on purpose, Claude is concise by
 * default when the system prompt is concise. The route attaches
 * `cache_control: ephemeral` to this string.
 */
export function buildSystemPrompt(ctx: ChatUserContext): string {
  const handleLine = ctx.handle ? `- handle: \`${ctx.handle}.talise\`` : "";
  return [
    "You are TALISE's in-app finance assistant. You answer questions about",
    "the user's money in TALISE, balance, recent activity, and yield",
    "opportunities. You ground every numeric claim in tool output, never",
    "from memory.",
    "",
    "## tone",
    "- Concise. ≤4 sentences unless the user asks for more detail.",
    "- Direct and honest. Surface uncertainty instead of inventing numbers.",
    "- Plain English. Don't explain crypto unless the user asks.",
    "",
    "## what the user has",
    `- address: \`${ctx.address}\``,
    handleLine,
    "- balances in USDsui (a dollar-pegged stablecoin) and SUI (gas).",
    "- yield positions in NAVI lending and DeepBook margin supply.",
    "",
    "## tools",
    "Call `get_balance` for current balances, `list_recent_txs` for activity",
    "history, `get_yields` to compare APYs across NAVI and DeepBook, and",
    "`simulate_supply` to project earnings on a hypothetical supply (math",
    "only, never a real transaction).",
    "",
    "## refusals",
    "- No tax or legal advice. Tell the user to talk to a qualified",
    "  professional for those.",
    "- Never propose or sign specific on-chain transactions or Move calls.",
    "  You read; the app writes.",
    "",
    "## style",
    "- When you cite a number, round to two decimals for dollars and four",
    "  decimals for SUI. APYs are percentages with one decimal.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Tool definitions. Each tool is server-side: the model emits a tool_use
 * block, our route invokes the handler against the live user, and the
 * result is streamed back as a `tool_result` for the next turn.
 *
 * All four tools are read-only, by design. We do not let the chat
 * surface compose write txs; the iOS Send/Earn flows own that path.
 */
export function buildChatTools(ctx: ChatUserContext): ToolSet {
  return {
    get_balance: tool({
      description:
        "Get the user's current USDsui and SUI balances on Sui mainnet.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const [usd, sui] = await Promise.all([
          getUsdsuiBalance(ctx.address).catch(() => ({ usdsui: 0 })),
          getSuiBalance(ctx.address).catch(() => ({ sui: 0 })),
        ]);
        return {
          usdsui: usd.usdsui,
          sui: sui.sui,
        };
      },
    }),

    list_recent_txs: tool({
      description:
        "List the user's recent payments. `limit` defaults to 8, max 25.",
      inputSchema: z
        .object({
          limit: z.number().int().min(1).max(25).optional(),
        })
        .strict(),
      execute: async ({ limit }) => {
        const n = Math.min(Math.max(limit ?? 8, 1), 25);
        const rows = await getRecentActivity(ctx.address, n, {
          includeNonTalise: true,
        }).catch(() => []);
        // Slim the rows down, the model only needs the essentials.
        return rows.slice(0, n).map((r) => ({
          digest: r.digest,
          direction: r.direction,
          amountUsdsui: r.amountUsdsui,
          amountSui: r.amountSui,
          counterparty: r.counterpartyName ?? r.counterparty,
          venue: r.venue,
          timestampMs: r.timestampMs,
        }));
      },
    }),

    get_yields: tool({
      description:
        "Compare live yield APYs across NAVI lending and DeepBook margin. Includes the user's currently supplied amount per venue.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const cmp = await getYieldComparison(ctx.address).catch(() => null);
        if (!cmp) return { venues: [], best: null };
        return {
          venues: cmp.venues.map((v) => ({
            id: v.id,
            name: v.name,
            apy: v.apy,
            supplied: v.supplied ?? 0,
          })),
          best: cmp.best?.id ?? null,
        };
      },
    }),

    simulate_supply: tool({
      description:
        "Project earnings on a hypothetical USDsui supply at the current APY. Math only, does not move funds.",
      inputSchema: z
        .object({
          amount_usdsui: z.number().positive(),
          venue: z.enum(["navi", "deepbook"]),
        })
        .strict(),
      execute: async ({ amount_usdsui, venue }) => {
        const cmp = await getYieldComparison(ctx.address).catch(() => null);
        const v = cmp?.venues.find((x) => x.id === venue);
        if (!v) {
          return {
            error: `venue ${venue} not available`,
            amount_usdsui,
            venue,
          };
        }
        const annual = amount_usdsui * v.apy;
        return {
          amount_usdsui,
          venue: v.id,
          venueName: v.name,
          apy: v.apy,
          projected: {
            daily: annual / 365,
            weekly: annual / 52,
            monthly: annual / 12,
            annual,
          },
        };
      },
    }),
  };
}
