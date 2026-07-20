import { streamText, type UIMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { withMemWal } from "@mysten-incubation/memwal/ai";
import { readSessionEntryId } from "@/lib/session";
import { userById } from "@/lib/db";
import { getSuiBalance, getUsdsuiBalance } from "@/lib/sui";
import { getYieldComparison } from "@/lib/yield";
import { findTaliseSubnameForOwner } from "@/lib/suins-lookup";
import { AI_MODEL, buildMessages, type ChatContext } from "@/lib/chat/ai";

export const runtime = "nodejs";

/**
 * POST /api/chat
 *
 * Streaming chat endpoint. Same wire format as the Vercel AI SDK's
 * `useChat` hook, the client posts `{ messages: UIMessage[] }` and we
 * stream back UI message parts as they arrive.
 *
 * Per request:
 *   1. Hydrate live user context (balance, yield venues, username).
 *   2. Build the system prompt + recent turns via `buildMessages`.
 *   3. Wrap the DeepSeek-via-OpenAI provider with `withMemWal`, per-wallet
 *      namespace, so the agent recalls the user's prior facts on every
 *      message and auto-saves new ones after the reply.
 *   4. Stream the result back.
 *
 * Memwal degrades cleanly: if MEMWAL_DELEGATE_KEY or MEMWAL_ACCOUNT_ID
 * are missing, we fall through to the raw provider, chat still works,
 * just without persistent memory.
 */

const PROVIDER_URL = process.env.ZG_DEEPSEEK_V4_PROVIDER_URL || "";
const API_KEY = process.env.ZG_DEEPSEEK_V4_API_KEY || "";
const MEMWAL_KEY = process.env.MEMWAL_DELEGATE_KEY || "";
const MEMWAL_ACCOUNT_ID = process.env.MEMWAL_ACCOUNT_ID || "";
const MEMWAL_SERVER_URL =
  process.env.MEMWAL_SERVER_URL || "https://relayer.memwal.ai";

const memwalConfigured = Boolean(MEMWAL_KEY && MEMWAL_ACCOUNT_ID);

/** Strip a trailing `/chat/completions` if env mistakenly includes it -
 *  createOpenAI appends that path itself. */
function baseURL(): string {
  return PROVIDER_URL.replace(/\/chat\/completions\/?$/, "").replace(
    /\/+$/,
    ""
  );
}

export async function POST(req: Request) {
  if (!PROVIDER_URL || !API_KEY) {
    return Response.json(
      {
        error:
          "AI provider not configured. Set ZG_DEEPSEEK_V4_PROVIDER_URL + ZG_DEEPSEEK_V4_API_KEY.",
      },
      { status: 500 }
    );
  }

  let body: { messages?: UIMessage[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const uiMessages = Array.isArray(body.messages) ? body.messages : [];
  if (uiMessages.length === 0) {
    return Response.json({ error: "empty messages" }, { status: 400 });
  }
  if (uiMessages.length > 60) {
    return Response.json({ error: "history too long" }, { status: 413 });
  }

  // Flatten UI messages to a plain {role, content} array for our system
  // prompt builder. Vercel UIMessages have `parts: [{type, text, ...}]`
  //, we just want the text. We skip Vercel's convertToModelMessages
  // helper (async/heavier than we need for our simple flow).
  const conversation = uiMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const text = (m.parts ?? [])
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      return {
        role: m.role as "user" | "assistant",
        content: text,
      };
    })
    .filter((m) => m.content.length > 0);

  // Hydrate the user's live context.
  const userId = await readSessionEntryId();
  const user = userId ? await userById(userId) : null;
  let context: ChatContext = {
    address: user?.sui_address ?? "0x0",
    usdsui: 0,
    sui: 0,
  };
  if (user) {
    try {
      const [bal, usd, yields, sub] = await Promise.all([
        getSuiBalance(user.sui_address),
        getUsdsuiBalance(user.sui_address),
        getYieldComparison(user.sui_address).catch(() => null),
        findTaliseSubnameForOwner(user.sui_address).catch(() => null),
      ]);
      context = {
        address: user.sui_address,
        usdsui: usd.usdsui,
        sui: bal.sui,
        username: sub?.username,
        yieldVenues: yields?.venues.map((v) => ({
          id: v.id,
          name: v.name,
          apy: v.apy,
          supplied: v.supplied,
        })),
        bestVenue: yields?.best?.id,
      };
    } catch {
      /* zero-state context */
    }
  }

  const built = buildMessages(conversation, context);
  const systemPrompt =
    built[0]?.role === "system" ? built[0].content : "";
  const convoOnly = built.filter((m) => m.role !== "system") as Array<{
    role: "user" | "assistant";
    content: string;
  }>;

  // DeepSeek-via-OpenAI-compatible proxy.
  const provider = createOpenAI({ apiKey: API_KEY, baseURL: baseURL() });
  // The proxy only implements /v1/chat/completions, not the newer
  // /v1/responses API. Pin to chat() so the SDK doesn't probe.
  const baseModel = provider.chat(AI_MODEL);

  // Wrap with Memwal when configured. Namespace per wallet so memories
  // never bleed between users.
  const model =
    memwalConfigured && context.address !== "0x0"
      ? withMemWal(baseModel, {
          key: MEMWAL_KEY,
          accountId: MEMWAL_ACCOUNT_ID,
          serverUrl: MEMWAL_SERVER_URL,
          namespace: `talise:${context.address.toLowerCase()}`,
          maxMemories: 5,
          autoSave: true,
          minRelevance: 0.3,
        })
      : baseModel;

  try {
    const result = streamText({
      model,
      system: systemPrompt,
      messages: convoOnly,
      temperature: 0.4,
      // DeepSeek V4 Pro is a reasoning model, reasoning tokens count
      // against this budget. Headroom for multi-step intent blocks.
      maxOutputTokens: 4096,
      abortSignal: req.signal,
      onError: ({ error }) => {
        console.error("[chat] streamText error:", error);
      },
    });
    return result.toUIMessageStreamResponse();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[chat] streamText failed:", msg);
    return Response.json(
      { error: `AI provider error: ${msg}` },
      { status: 502 }
    );
  }
}
