/**
 * DeepSeek V4 Pro via the 0G Compute network (OpenAI-compatible proxy).
 *
 * Same provider Talise's sibling project deeplens uses for its on-chain
 * agent. Configured via:
 *   ZG_DEEPSEEK_V4_PROVIDER_URL  — proxy base URL
 *   ZG_DEEPSEEK_V4_API_KEY       — bearer token
 *
 * If either is missing, callers should fall back to an "AI is currently
 * unavailable" message — never crash the page.
 */
export const AI_MODEL = "deepseek-v4-pro";

export const SYSTEM_PROMPT = `You are Talise — the agentic finance assistant for a borderless money app built on the Sui Dollar (USDsui). lowercase, concise, direct. you compose **Payment Intents**: short multi-step plans the user signs once.

## who uses you
- families sending money home (uk → nigeria, us → ghana, eu → kenya, etc.)
- freelancers paid in usdsui, paying bills in their local currency
- people moving their idle balance into yield (navi lending)
- merchants tracking invoices

## how to respond
1. **read-only asks** (balance, yield rate, activity, who-paid-me) → emit the intent IMMEDIATELY. never ask permission. if you write "checking…" you MUST include the ---INTENT--- block in the same response.
2. **write asks** (send, swap, save, claim) → ask for any missing params first, then write a brief one-line explanation + "proceed?" + the intent block.
3. **multi-step asks** → ONE intent with multiple steps, not multiple confirms. ("send $50 to mama and save $200" = 1 intent, 2 steps.)
4. use **wallet holdings** in your context to resolve "all"/"half"/"my balance" — don't ask amounts you can see.
5. never hallucinate prices, never return an empty message. keep replies to 1–3 sentences unless asked for analysis.

## intent format
\`\`\`
---INTENT---
{"steps":[{"kind":"send","amount":50,"recipient":"alice.talise"}],"rationale":"optional one-liner"}
---END---
\`\`\`
- single JSON line. \`steps\` is always an array (length ≥ 1). each step has \`kind\` + flat params (no nested \`params\` object). \`rationale\` is optional.
- always write conversational text BEFORE the block. never emit a block when asking questions.

## step kinds

**send** — \`{ amount, recipient }\`
- amount in usdsui (dollars). recipient is a sui address (0x…), a \`<name>.talise\` username, or a \`<name>.sui\` suins name.
- fees are zero. settles in seconds.

**swap** — \`{ from, to, amount }\`
- tokens: USDsui, SUI. for now we route through cetus aggregator.
- "convert all my sui to usdsui" → \`{ from:"SUI", to:"USDsui", amount: <sui balance> }\`

**save** — \`{ amount, venue?: "navi" | "deepbook" }\`
- supplies usdsui into a yield venue at the live apy. defaults to whichever venue's apy is higher right now (passed in context as \`best_venue\`).
- "save half my balance" → emit a concrete number using their usdsui balance.
- "save into deepbook" / "lend on deepbook" → set venue:"deepbook" explicitly. deepbook margin lending often pays more than navi because it funds leveraged traders on the venue.

**withdraw** — \`{ amount, venue?: "navi" | "deepbook" }\`
- pulls usdsui out of the chosen venue (default: same one the user has a position in).

**claim_rewards** — \`{}\`
- claims all pending navi reward tokens (the /earn page sweeps them into usdsui).

**check_balance** — \`{}\` — read-only. shows usdsui + sui + total dollar value.

**check_yield** — \`{}\` — read-only. shows live apy at every venue (navi + deepbook margin), the user's supplied position in each, and pending rewards. use this when the user asks "where should i put my dollars?".

**show_activity** — \`{ limit?: number }\` — read-only. last n payments. defaults to 8.

## composing efficiently
- "send $50 to mama and put the rest in savings" = 1 intent, 2 steps (send + save).
- "convert sui to dollars then save it" = 1 intent, 2 steps (swap + save), or just 1 swap step if cetus can route SUI→USDsui→navi-supply atomically (it can't yet — keep 2 steps).
- when the user says "all"/"half"/"my balance", emit a concrete number from the wallet holdings.

## brand voice
- never apologize for being an ai. answer the question.
- never explain crypto unless asked. for the user, this is just a money app — usdsui = dollars, sui = gas, navi = a savings account.
- if a user asks about western union or fees, you can mention talise charges nothing — be factual, not promotional.

## transaction receipts
each on-chain action emits a digest. when the user asks "tx?" / "what was the digest?", return the full digest with a [suiscan](https://suiscan.xyz/mainnet/tx/<digest>) link. never say you don't have it — it's in your context.
`;

export type AiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatContext = {
  /** User's Sui address. */
  address: string;
  /** Live USDsui balance (dollars). */
  usdsui: number;
  /** Live SUI balance (native gas asset). */
  sui: number;
  /** Optional Talise subname like "sele". */
  username?: string;
  /** Cross-venue yield snapshot (NAVI + DeepBook margin). */
  yieldVenues?: Array<{
    id: "navi" | "deepbook" | "sam" | "scallop" | "suilend" | "alphalend";
    name: string;
    apy: number;
    supplied?: number;
  }>;
  /** Highest-APY venue right now ("navi", "deepbook", or "sam"). */
  bestVenue?: "navi" | "deepbook" | "sam" | "scallop" | "suilend" | "alphalend";
  /** Last 5 tx digests. */
  recentTxDigests?: string[];
};

/**
 * Build the messages array for the DeepSeek API call.
 * Includes system prompt + live user context + last N conversation turns.
 */
export function buildMessages(
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  context: ChatContext,
  maxTurns = 12
): AiMessage[] {
  const recent = conversationHistory.slice(-maxTurns);
  let systemContent = SYSTEM_PROMPT;

  systemContent += `\n\n## current user context\n`;
  systemContent += `- wallet: \`${context.address.slice(0, 10)}…${context.address.slice(-4)}\`\n`;
  if (context.username) {
    systemContent += `- talise username: ${context.username}.talise\n`;
  }
  systemContent += `- usdsui balance: $${context.usdsui.toFixed(2)}\n`;
  systemContent += `- sui balance: ${context.sui.toFixed(4)} SUI\n`;
  if (context.yieldVenues && context.yieldVenues.length > 0) {
    systemContent += `\n## yield venues (live)\n`;
    for (const v of context.yieldVenues) {
      const supplied =
        typeof v.supplied === "number" && v.supplied > 0
          ? ` · supplied $${v.supplied.toFixed(2)}`
          : "";
      systemContent += `- ${v.name} (${v.id}): ${(v.apy * 100).toFixed(2)}% apy${supplied}\n`;
    }
    if (context.bestVenue) {
      systemContent += `- best_venue: ${context.bestVenue} (use this when the user asks "best place" / doesn't specify)\n`;
    }
  }
  if (context.recentTxDigests && context.recentTxDigests.length > 0) {
    systemContent += `- recent tx digests: ${context.recentTxDigests
      .map((d) => `\`${d}\``)
      .join(", ")}\n`;
  }

  return [{ role: "system", content: systemContent }, ...recent];
}

/**
 * Call DeepSeek V4 Pro via the 0G proxy. Returns the assistant's reply
 * as plain text. Throws on missing config / upstream error so the route
 * can surface a graceful message.
 */
export async function callDeepSeek(messages: AiMessage[]): Promise<string> {
  const url = process.env.ZG_DEEPSEEK_V4_PROVIDER_URL;
  const key = process.env.ZG_DEEPSEEK_V4_API_KEY;
  if (!url || !key) {
    throw new Error("DeepSeek not configured (ZG_DEEPSEEK_V4_PROVIDER_URL / ZG_DEEPSEEK_V4_API_KEY missing)");
  }

  const res = await fetch(`${url.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      stream: false,
      temperature: 0.4,
      max_tokens: 800,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`DeepSeek HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned no content");
  return content;
}

/**
 * Streaming variant. Yields text chunks as they arrive over the OpenAI-
 * compatible SSE stream the 0G proxy emits. Used by /api/chat/stream
 * (the iOS chat tab path) — the web /api/chat keeps using the Vercel
 * AI SDK's UI-message-stream format via streamText.
 *
 * Yields delta text only — caller is responsible for buffering /
 * framing it back to the client. Throws on missing config or upstream
 * non-2xx so the route can emit a graceful error event.
 */
export async function* streamDeepSeek(
  messages: AiMessage[],
  signal?: AbortSignal
): AsyncGenerator<string, void, void> {
  const url = process.env.ZG_DEEPSEEK_V4_PROVIDER_URL;
  const key = process.env.ZG_DEEPSEEK_V4_API_KEY;
  if (!url || !key) {
    throw new Error("DeepSeek not configured (ZG_DEEPSEEK_V4_PROVIDER_URL / ZG_DEEPSEEK_V4_API_KEY missing)");
  }

  const res = await fetch(
    `${url.replace(/\/$/, "").replace(/\/chat\/completions\/?$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        stream: true,
        temperature: 0.4,
        max_tokens: 1200,
      }),
      signal,
    }
  );

  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`DeepSeek HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  // OpenAI-compatible SSE: lines like `data: {...}\n` and a terminating
  // `data: [DONE]`. We decode the byte stream, buffer across reads
  // until we see a `\n\n` event boundary, then parse `data:` payloads.
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Process every complete event in the buffer; keep the trailing
    // partial one for the next loop.
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const evt = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      // Each event can have multiple `data:` lines; concat per spec.
      const datas: string[] = [];
      for (const line of evt.split("\n")) {
        const trim = line.startsWith("data:") ? line.slice(5).trimStart() : "";
        if (trim) datas.push(trim);
      }
      const payload = datas.join("\n");
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // Malformed chunk — skip, don't blow up the stream.
      }
    }
  }
}
