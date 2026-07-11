"use client";

/**
 * AgentChat — the Talise Agent chat surface for the web app (the web twin of
 * iOS `ChatTabView` + `ChatViewModel`), styled to feel like ChatGPT mobile.
 *
 * Layout (top → bottom):
 *   1. Header — mascot badge + greeting + a New-chat button. (No history
 *      sidebar: the app already has a left nav, so a second drawer just fought
 *      it. Each chat still persists; "New chat" starts a fresh one.)
 *   2. Scrollable transcript — assistant turns render as clean, full-width
 *      LEFT-aligned prose (no bubble); user turns are a compact right-aligned
 *      accent-green pill. A "thinking" indicator stands in where the assistant
 *      reply will appear while we await the first token. Each completed
 *      assistant turn gets a quiet Copy / Regenerate action row.
 *   3. Suggested-prompt chips (only when the transcript is empty + idle).
 *   4. Rounded input pill + send button, with a "Talise can make mistakes"
 *      microcopy line beneath it.
 *
 * Streaming: we POST the running transcript to `/api/chat/stream` and read its
 * Server-Sent-Events body. Each frame is `data: <json>\n\n` where json is
 * `{"type":"text","value":"…"}` (an incremental token) or `{"type":"done"}`
 * (terminal). We buffer the FULL raw stream — fence included — and derive the
 * displayed prose each delta by stripping any `---INTENT---{…}---END---` block,
 * so a fence split across chunks never flashes half-rendered JSON. When the
 * stream closes we run `parseAssistantMessage` on the raw text; any intent it
 * carries renders an <AgentIntentCard> beneath the prose.
 *
 * History: each completed turn is persisted to localStorage via
 * `conversationsStore` so a refresh restores the current thread; "New chat"
 * starts fresh. (We dropped the slide-out history drawer — it overlapped the
 * app's own left nav.)
 */

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUp01Icon,
  AiMagicIcon,
  Add01Icon,
  Copy01Icon,
  ArrowReloadHorizontalIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useMe, useToast } from "@/components/app";
import { parseAssistantMessage, type ChatIntent } from "@/lib/chat/intent";
import { AgentIntentCard } from "./AgentIntentCard";
import {
  loadConversation,
  saveConversation,
  titleFromMessages,
  type StoredMessage,
} from "./conversationsStore";

type Role = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: Role;
  /** Display prose (intent fence stripped). */
  content: string;
  /** Full raw stream including any intent fence (assistant only). */
  raw?: string;
  streaming?: boolean;
  intent?: ChatIntent | null;
};

const SUGGESTED = [
  "What's my balance?",
  "Send $20 to alice.talise",
  "Move $50 into savings",
  "Show my last 5 payments",
];

export function AgentChat() {
  const { me } = useMe();
  const { toast } = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [convId, setConvId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mirror the latest transcript so finalize/persist always read fresh state
  // without threading it through every functional setState.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Keep the tail pinned as new messages land / tokens trickle in.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  // Cancel any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  // ── Persistence ─────────────────────────────────────────────────────────
  function persist(msgs: ChatMessage[], id: string) {
    const stored: StoredMessage[] = msgs
      .filter((m) => !m.streaming && m.content.trim().length > 0)
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        raw: m.raw,
        intent: m.intent ?? null,
      }));
    if (stored.length === 0) return;
    const existing = loadConversation(id);
    saveConversation({
      id,
      title: titleFromMessages(stored),
      messages: stored,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
  }

  function newChat() {
    abortRef.current?.abort();
    setStreaming(false);
    setMessages([]);
    setConvId(null);
    setInput("");
    inputRef.current?.focus();
  }

  // ── Sending ─────────────────────────────────────────────────────────────
  function submit() {
    const text = input.trim();
    if (!text || streaming) return;
    sendPrompt(text);
    setInput("");
  }

  function sendPrompt(text: string) {
    const id = convId ?? uid();
    if (!convId) setConvId(id);

    const userMsg: ChatMessage = { id: uid(), role: "user", content: text };
    const assistantId = uid();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      raw: "",
      streaming: true,
    };
    const next = [...messages, userMsg, assistantMsg];
    setMessages(next);
    setStreaming(true);
    persist(next, id); // record the user turn immediately (assistant filtered)

    void runStream(historyFor(next), assistantId, id);
  }

  // Re-run the user prompt that produced this assistant turn, replacing it (and
  // anything after) with a fresh stream.
  function regenerate(assistantId: string) {
    if (streaming) return;
    const idx = messages.findIndex((m) => m.id === assistantId);
    if (idx < 0) return;
    const prior = messages.slice(0, idx); // ends at the originating user turn
    const history = historyFor(prior);
    if (history.length === 0) return;

    const id = convId ?? uid();
    if (!convId) setConvId(id);

    const newAssistantId = uid();
    const next: ChatMessage[] = [
      ...prior,
      { id: newAssistantId, role: "assistant", content: "", raw: "", streaming: true },
    ];
    setMessages(next);
    setStreaming(true);
    void runStream(history, newAssistantId, id);
  }

  // Finished turns + this prompt — never the streaming placeholder.
  function historyFor(msgs: ChatMessage[]) {
    return msgs
      .filter((m) => m.role === "user" || !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }))
      .filter((m) => m.content.length > 0);
  }

  async function copyMessage(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied", "success");
    } catch {
      toast("Couldn't copy", "danger");
    }
  }

  async function runStream(
    history: Array<{ role: Role; content: string }>,
    assistantId: string,
    convoId: string
  ) {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let raw = "";
    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        credentials: "include",
        body: JSON.stringify({ messages: history }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        finalizeError(assistantId, `Couldn't reach the assistant (HTTP ${res.status}).`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // One SSE event ends at the first blank line; drain every complete one.
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const evt = parseSseFrame(frame);
          if (evt?.type === "text" && typeof evt.value === "string") {
            raw += evt.value;
            const display = stripIntentBlocks(raw);
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: display, raw } : m))
            );
          }
          // `done` is a no-op — we finalize once the body ends.
        }
      }
      // Flush a trailing frame with no closing blank line.
      const tail = parseSseFrame(buffer);
      if (tail?.type === "text" && typeof tail.value === "string") raw += tail.value;

      finalize(assistantId, raw, convoId);
    } catch {
      if (ctrl.signal.aborted) return;
      finalizeError(assistantId, "I lost the connection mid-thought, try that again.");
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setStreaming(false);
    }
  }

  // Stream closed cleanly — parse the prose + any intent block from the raw.
  function finalize(assistantId: string, raw: string, convoId: string) {
    const { text, intent } = parseAssistantMessage(raw);
    const updated = messagesRef.current.map((m) =>
      m.id === assistantId
        ? {
            ...m,
            streaming: false,
            raw,
            content: text || (intent ? "" : "(no reply)"),
            intent: intent ?? null,
          }
        : m
    );
    setMessages(updated);
    persist(updated, convoId);
  }

  function finalizeError(assistantId: string, message: string) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId
          ? { ...m, streaming: false, content: m.content || message }
          : m
      )
    );
  }

  const empty = messages.length === 0;
  const greeting = `${timeOfDay()}, ${firstName(me?.name) ?? "there"}`;
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col lg:h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="flex shrink-0 items-start gap-3 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-full bg-[#CAFFB8]">
              <HugeiconsIcon icon={AiMagicIcon} size={17} color="#15300c" strokeWidth={1.9} />
            </span>
            <h1
              className="truncate text-[24px] font-[800] tracking-[-0.02em] text-[#15300c]"
              style={{ fontFamily: "var(--font-display-v2)" }}
            >
              {greeting}
            </h1>
          </div>
          <p className="mt-1 text-[14px] text-[#3a5230]">
            Let&rsquo;s make sense of your numbers.
          </p>
        </div>

        <button
          type="button"
          onClick={newChat}
          aria-label="New chat"
          title="New chat"
          className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full border border-[#15300c]/12 bg-white/60 text-[#15300c] backdrop-blur-sm transition-colors hover:border-[#15300c]/30"
        >
          <HugeiconsIcon icon={Add01Icon} size={18} strokeWidth={2.2} />
        </button>
      </div>

      {/* Transcript */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center py-12 text-center">
            <span className="mb-4 flex size-16 items-center justify-center rounded-[22px] bg-[#CAFFB8]">
              <HugeiconsIcon icon={AiMagicIcon} size={28} color="#15300c" strokeWidth={1.8} />
            </span>
            <p
              className="text-[20px] font-[800] tracking-[-0.02em] text-[#15300c]"
              style={{ fontFamily: "var(--font-display-v2)" }}
            >
              Ask anything about your money
            </p>
            <p className="mt-1.5 max-w-xs text-[14px] text-[#3a5230]">
              Check balances, send a payment, or move cash into savings. Just type it.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-[44rem] flex-col gap-5">
            {messages.map((m) => (
              <Row
                key={m.id}
                msg={m}
                isLastAssistant={m.id === lastAssistantId}
                canRegenerate={!streaming}
                onCopy={() => copyMessage(m.content)}
                onRegenerate={() => regenerate(m.id)}
              />
            ))}
          </div>
        )}
        <div ref={bottomRef} className="h-2" />
      </div>

      {/* Suggested prompts (idle + empty) */}
      {empty && !streaming && (
        <div className="shrink-0 pb-3">
          <div className="mx-auto flex max-w-[44rem] flex-wrap gap-2">
            {SUGGESTED.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setInput(p);
                  inputRef.current?.focus();
                }}
                className="rounded-full border border-[#15300c]/15 bg-white/60 px-3.5 py-2 text-[13px] font-medium text-[#3a5230] backdrop-blur-sm transition-colors hover:border-[#15300c]/30 hover:text-[#15300c]"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input pill */}
      <div className="mx-auto w-full max-w-[44rem] shrink-0">
        <div className="flex items-center gap-2 rounded-full border border-[#15300c]/12 bg-white/75 py-2 pl-5 pr-2 shadow-[0_8px_30px_-16px_rgba(21,48,12,0.4)] backdrop-blur-sm">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask anything"
            disabled={streaming}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-[#15300c] outline-none placeholder:text-[#3a5230]/60 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!input.trim() || streaming}
            aria-label="Send"
            className="flex size-9 shrink-0 items-center justify-center rounded-full transition-colors"
            style={{ background: !input.trim() || streaming ? "#cfe6c2" : "#3d7a29" }}
          >
            <HugeiconsIcon icon={ArrowUp01Icon} size={18} color="#f7fcf2" strokeWidth={2.4} />
          </button>
        </div>
        <p className="mt-2 text-center text-[11.5px] text-[#3a5230]/70">
          Talise can make mistakes. Double-check anything that moves money.
        </p>
      </div>
    </div>
  );
}

// ── Transcript row ──────────────────────────────────────────────────────────

function Row({
  msg,
  isLastAssistant,
  canRegenerate,
  onCopy,
  onRegenerate,
}: {
  msg: ChatMessage;
  isLastAssistant: boolean;
  canRegenerate: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
}) {
  const isUser = msg.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-[20px] rounded-br-[6px] bg-[#3d7a29] px-3.5 py-2.5 text-[15px] leading-relaxed text-[#f7fcf2]">
          <span className="whitespace-pre-wrap">{msg.content}</span>
        </div>
      </div>
    );
  }

  // Assistant — clean left-aligned prose, no bubble.
  const awaitingFirstToken = msg.streaming === true && msg.content.length === 0;
  const showActions = !msg.streaming && msg.content.trim().length > 0;

  return (
    <div className="group flex flex-col gap-2">
      {awaitingFirstToken ? (
        <ThinkingIndicator />
      ) : (
        msg.content.length > 0 && (
          <div className="text-[15px] leading-[1.7] text-[#15300c]">
            <span className="whitespace-pre-wrap">{msg.content}</span>
            {msg.streaming && (
              <span className="ml-0.5 inline-block animate-pulse text-[#3d7a29]">▍</span>
            )}
          </div>
        )
      )}

      {msg.intent && !msg.streaming && (
        <div className="w-full">
          <AgentIntentCard intent={msg.intent} />
        </div>
      )}

      {showActions && (
        <div
          className={`flex items-center gap-1 transition-opacity duration-150 ${
            isLastAssistant ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <ActionButton label="Copy" icon={Copy01Icon} onClick={onCopy} />
          <ActionButton
            label="Regenerate"
            icon={ArrowReloadHorizontalIcon}
            onClick={onRegenerate}
            disabled={!canRegenerate}
          />
        </div>
      )}
    </div>
  );
}

function ActionButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: typeof Copy01Icon;
  onClick: () => void;
  disabled?: boolean;
}) {
  const [hit, setHit] = useState(false);
  const isCopy = label === "Copy";
  return (
    <button
      type="button"
      onClick={() => {
        if (disabled) return;
        onClick();
        if (isCopy) {
          setHit(true);
          window.setTimeout(() => setHit(false), 1400);
        }
      }}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex size-7 items-center justify-center rounded-lg text-[#3a5230]/55 transition-colors hover:bg-[#15300c]/5 hover:text-[#15300c] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[#3a5230]/55"
    >
      <HugeiconsIcon icon={hit ? Tick02Icon : icon} size={15} strokeWidth={2} />
    </button>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2" aria-label="Thinking" role="status">
      <span className="flex items-end gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-2 rounded-full bg-[#3d7a29]/70"
            style={{ animation: "talise-think 1.2s ease-in-out infinite", animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </span>
      <span className="text-[13px] text-[#3a5230]/70">Thinking…</span>
      <style>{`@keyframes talise-think {0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}`}</style>
    </div>
  );
}

// ── SSE + intent-fence helpers ────────────────────────────────────────────

/** Parse one SSE frame: concatenate its `data:` lines and JSON-decode. */
function parseSseFrame(frame: string): { type: string; value?: string } | null {
  const data = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => {
      let s = l.slice(5).replace(/\r$/, "");
      if (s.startsWith(" ")) s = s.slice(1);
      return s;
    });
  if (data.length === 0) return null;
  try {
    return JSON.parse(data.join("\n"));
  } catch {
    return null;
  }
}

/**
 * Remove any `---INTENT---{json}---END---` fence (and the blank lines it leaves)
 * from a string. Handles a partial block mid-stream: an open fence with no close
 * yet is trimmed from the open marker to the end, so a half-rendered
 * `---INTENT---{"steps":[…` never flashes to the user. (Port of the iOS
 * `stripIntentBlocks`.)
 */
function stripIntentBlocks(s: string): string {
  let out = s;
  let open: number;
  while ((open = out.indexOf("---INTENT---")) !== -1) {
    const close = out.indexOf("---END---", open);
    if (close !== -1) {
      out = out.slice(0, open) + out.slice(close + "---END---".length);
    } else {
      out = out.slice(0, open);
      break;
    }
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function uid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function timeOfDay(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 17) return "Good afternoon";
  if (h >= 17 && h < 22) return "Good evening";
  return "Hey";
}

function firstName(name: string | null | undefined): string | null {
  const raw = (name ?? "").trim();
  if (!raw) return null;
  return raw.split(/\s+/)[0] || null;
}
