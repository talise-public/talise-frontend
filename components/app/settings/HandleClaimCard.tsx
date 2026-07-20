"use client";

/**
 * Handle claim card for /app/settings.
 *
 * Mirrors the iOS ClaimHandleSheet flow:
 *   1. Debounced GET /api/username/check?u=<input> on every keystroke.
 *   2. Tap "Claim" → POST /api/username/claim (the operator wallet pays the
 *      SuiNS mint gas + signs; the user pays nothing).
 *   3. On success, refresh useMe() so the parent swaps the card for the
 *      claimed-handle display.
 *
 * Only rendered when the user has NOT yet claimed a handle.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AtIcon,
  CheckmarkCircle02Icon,
  AlertCircleIcon,
} from "@hugeicons/core-free-icons";
import { api, ApiError, useToast, PrimaryButton, Spinner } from "@/components/app";

type Availability =
  | "empty"
  | "short"
  | "checking"
  | "available"
  | "taken"
  | "reserved"
  | "invalid"
  | "rpc";

type CheckResponse = { available: boolean; reason?: string };

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20);
}

export function HandleClaimCard({ onClaimed }: { onClaimed: () => void }) {
  const { toast } = useToast();
  const [input, setInput] = useState("");
  const [state, setState] = useState<Availability>("empty");
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqId = useRef(0);

  const runCheck = useCallback((q: string) => {
    if (debounce.current) clearTimeout(debounce.current);
    setError(null);
    if (!q) {
      setState("empty");
      return;
    }
    if (q.length < 3) {
      setState("short");
      return;
    }
    setState("checking");
    const id = ++reqId.current;
    debounce.current = setTimeout(async () => {
      try {
        const res = await api<CheckResponse>("/api/username/check", {
          query: { u: q },
        });
        if (id !== reqId.current) return;
        if (res.available) {
          setState("available");
        } else {
          setState(
            res.reason === "taken"
              ? "taken"
              : res.reason === "reserved"
                ? "reserved"
                : res.reason === "rpc"
                  ? "rpc"
                  : "invalid"
          );
        }
      } catch {
        if (id !== reqId.current) return;
        setState("rpc");
      }
    }, 280);
  }, []);

  useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);

  const onChange = (raw: string) => {
    const clean = sanitize(raw);
    setInput(clean);
    runCheck(clean);
  };

  const canClaim = !claiming && (state === "available" || state === "rpc");

  async function claim() {
    if (!canClaim) return;
    setClaiming(true);
    setError(null);
    try {
      await api("/api/username/claim", {
        method: "POST",
        body: { username: input },
      });
      toast(`@${input}.talise.sui is yours.`, "success");
      onClaimed();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409) {
          setState("taken");
          setError(e.message || "That name was just taken.");
        } else {
          setError(e.message || "Couldn't claim that handle right now.");
        }
      } else {
        setError("Couldn't claim that handle right now.");
      }
    } finally {
      setClaiming(false);
    }
  }

  const statusTone =
    state === "available"
      ? "text-[#3d7a29]"
      : state === "rpc"
        ? "text-[#3a5230]"
        : "text-[#c0532f]";

  const statusText =
    state === "checking"
      ? "Checking…"
      : state === "available"
        ? `@${input}.talise.sui is available`
        : state === "taken"
          ? "Someone already claimed that name."
          : state === "reserved"
            ? "That name is reserved."
            : state === "short"
              ? "Use 3–20 lowercase letters, digits, or underscores."
              : state === "invalid"
                ? "Use 3–20 lowercase letters, digits, or underscores."
                : state === "rpc"
                  ? "Couldn't verify on-chain, you can still claim it."
                  : "";

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-[15px] font-medium text-[#15300c]">Claim your name</p>
        <p className="text-[13px] text-[#3a5230]">
          People pay you at{" "}
          <span className="font-mono text-[#15300c]">name.talise.sui</span>, far
          easier to share than a 0x address. The mint is on us.
        </p>
      </div>

      <div
        className="flex items-center gap-1.5 border border-[#15300c]/15 bg-white/60 px-4 py-3 backdrop-blur-sm"
        style={{ borderRadius: 12 }}
      >
        <HugeiconsIcon
          icon={AtIcon}
          size={18}
          className="shrink-0 text-[#3d7a29]"
          strokeWidth={2}
        />
        <input
          value={input}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void claim();
          }}
          placeholder="yourname"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          aria-label="Choose your handle"
          className="min-w-0 flex-1 bg-transparent text-[17px] font-medium tracking-[-0.05em] text-[#15300c] outline-none placeholder:text-[#3d7a29]"
        />
        <span className="shrink-0 font-mono text-[13px] text-[#3a5230]">
          .talise.sui
        </span>
      </div>

      <div className="flex min-h-[18px] items-center gap-2">
        {state === "checking" && <Spinner size={13} />}
        {state === "available" && (
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            size={14}
            className="text-[#3d7a29]"
            strokeWidth={2}
          />
        )}
        {(state === "taken" || state === "reserved" || state === "invalid") && (
          <HugeiconsIcon
            icon={AlertCircleIcon}
            size={14}
            className="text-[#c0532f]"
            strokeWidth={2}
          />
        )}
        {statusText && (
          <span className={`text-[12px] ${statusTone}`}>{statusText}</span>
        )}
      </div>

      {error && (
        <p className="text-[12px] text-[#c0532f]">{error}</p>
      )}

      <PrimaryButton
        onClick={() => void claim()}
        disabled={!canClaim}
        loading={claiming}
        full
      >
        {claiming
          ? "Claiming…"
          : input
            ? `Claim @${input}.talise.sui`
            : "Claim your handle"}
      </PrimaryButton>

      <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[#3d7a29]">
        One handle per account · minted on SuiNS
      </p>
    </div>
  );
}
