/**
 * Talise agent — streaming chat for the iOS Chat tab.
 *
 * Wire format: Server-Sent Events. Each frame is `data: <json>\n\n`.
 * Event types (compact form for iOS):
 *   - `{"type":"text","value":"…"}` — incremental assistant text token(s)
 *   - `{"type":"done"}`             — terminal frame
 *
 * Provider stack — same brain the web `/api/chat` route uses, just
 * presented over the iOS-friendly SSE wire format:
 *   - System prompt + structured Payment-Intent rules from `lib/chat/ai.ts`
 *   - Live user context (USDsui + SUI balance, yield venues, subname) via
 *     `buildMessages()`
 *   - DeepSeek V4 Pro via the 0G Compute OpenAI-compatible proxy
 *     (`ZG_DEEPSEEK_V4_PROVIDER_URL` / `_API_KEY`)
 *   - Memwal per-wallet memory namespace (optional, degrades cleanly)
 *
 * Auth: bearer token via `readEntryIdFromRequest`. We never accept
 * anonymous requests. If the AI provider isn't configured we emit a
 * single-frame stub so the iOS UI loop can exercise the SSE parser
 * end-to-end in dev.
 */
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { findTaliseSubnameForOwner } from "@/lib/suins-lookup";
import { getSuiBalance, getUsdsuiBalance } from "@/lib/sui";
import { getYieldComparison } from "@/lib/yield";
import { getRecentActivity } from "@/lib/activity";
import {
  buildMessages,
  streamDeepSeek,
  type ChatContext,
} from "@/lib/chat/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IncomingMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

function encodeSse(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

export async function POST(req: Request) {
  // ---- Auth ---------------------------------------------------------
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return new Response(JSON.stringify({ error: "not authenticated" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const user = await userById(userId);
  if (!user) {
    return new Response(JSON.stringify({ error: "user not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  // ---- Input --------------------------------------------------------
  let body: { messages?: IncomingMessage[] };
  try {
    body = (await req.json()) as { messages?: IncomingMessage[] };
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  if (incoming.length === 0) {
    return new Response(JSON.stringify({ error: "empty messages" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (incoming.length > 40) {
    return new Response(JSON.stringify({ error: "history too long" }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }

  // ---- Hydrate the same live context the web /api/chat builds ------
  //
  // The Talise agent grounds every reply in the user's actual balance /
  // yield positions / recent activity. Doing this server-side rather
  // than letting the model "ask a tool" cuts a round-trip per chat
  // turn — we pay one bulk hydrate up front and stream the answer.
  const [bal, usd, yields, sub, recentTxs] = await Promise.all([
    getSuiBalance(user.sui_address).catch(() => ({ sui: 0, mist: "0" })),
    getUsdsuiBalance(user.sui_address).catch(() => ({ usdsui: 0, raw: "0" })),
    getYieldComparison(user.sui_address).catch(() => null),
    findTaliseSubnameForOwner(user.sui_address).catch(() => null),
    getRecentActivity(user.sui_address, 5, { includeNonTalise: true })
      .catch(() => []),
  ]);
  const context: ChatContext = {
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
    recentTxDigests: recentTxs.map((e) => e.digest).slice(0, 5),
  };

  const conversation = incoming
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }))
    .filter((m) => m.content.length > 0);

  const messages = buildMessages(conversation, context);

  // ---- Stub fallback (no DeepSeek key) -----------------------------
  //
  // Lets the iOS client exercise the SSE plumbing without a real
  // provider key. Used by the test-app.mts smoke suite + first-run
  // dev environments. Will not fire in prod since the env is set.
  if (
    !process.env.ZG_DEEPSEEK_V4_PROVIDER_URL ||
    !process.env.ZG_DEEPSEEK_V4_API_KEY
  ) {
    const stub =
      "Chat is configured but the AI provider keys aren't set in this " +
      "environment — set ZG_DEEPSEEK_V4_PROVIDER_URL and " +
      "ZG_DEEPSEEK_V4_API_KEY to enable Talise's agent.";
    const sseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encodeSse({ type: "text", value: stub }));
        controller.enqueue(encodeSse({ type: "done" }));
        controller.close();
      },
    });
    return new Response(sseStream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  // ---- Real provider path: stream DeepSeek deltas through SSE ------
  //
  // The web `/api/chat` route uses Vercel AI SDK's `streamText` which
  // emits a UI-message-stream format (multi-part JSONL designed for
  // the `useChat` hook). iOS can't easily parse that, so we go one
  // level lower: call the 0G proxy's OpenAI-compatible streaming
  // endpoint directly via `streamDeepSeek()` and re-emit each delta
  // as a compact `{type:"text",value:"…"}` SSE event.
  //
  // Memwal memory wrap is intentionally NOT applied here. It hooks
  // into the AI SDK's middleware layer, and that layer isn't on this
  // path. Adding it would require either porting the wrap into our
  // raw streaming loop or routing the iOS path back through
  // `streamText` + parsing UI message parts on the client — both
  // are larger lifts. Memory remains a web-tab feature for now;
  // iOS chat is stateless per session (the on-device transcript
  // store in `ChatHistoryStore` carries the last 20 messages).
  const sseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const delta of streamDeepSeek(messages, req.signal)) {
          if (delta) {
            controller.enqueue(
              encodeSse({ type: "text", value: delta })
            );
          }
        }
        controller.enqueue(encodeSse({ type: "done" }));
      } catch (err) {
        console.error("[chat/stream] DeepSeek loop crashed:", err);
        controller.enqueue(
          encodeSse({
            type: "text",
            value:
              "\n\n(I lost the connection mid-thought — try that again.)",
          })
        );
        controller.enqueue(encodeSse({ type: "done" }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(sseStream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
