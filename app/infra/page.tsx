"use client";

/**
 * /infra — Talise speed dashboard.
 *
 * Times every integration the app depends on, and every user action mapped to
 * the integrations on its critical path — so you can simulate "how fast is a
 * Send / Cash-out / Save" and see exactly where the latency is. Two sections:
 * Web app and Mobile app. Admin-gated by the layout.
 *
 * "Run" an action → it probes that action's integrations (read-only) and sums
 * the critical-path latency. "Run all" does a whole section; "Run everything"
 * does both. Results hit `/api/infra/probe`.
 */

import { useCallback, useState } from "react";
import {
  PROBE_META,
  WEB_ACTIONS,
  MOBILE_ACTIONS,
  FAST_MS,
  OK_MS,
  type ProbeId,
  type ActionDef,
} from "@/lib/infra-config";

type Probe = { ms: number; ok: boolean; detail: string; at: number; history: number[] };
type ProbeMap = Partial<Record<ProbeId, Probe>>;

const PROBE_LABEL = Object.fromEntries(PROBE_META.map((p) => [p.id, p.label])) as Record<ProbeId, string>;

function band(ms: number, ok: boolean): string {
  if (!ok) return "text-rose-400";
  if (ms < FAST_MS) return "text-emerald-400";
  if (ms < OK_MS) return "text-amber-400";
  return "text-rose-400";
}
function dot(ms: number, ok: boolean): string {
  if (!ok) return "bg-rose-500";
  if (ms < FAST_MS) return "bg-emerald-500";
  if (ms < OK_MS) return "bg-amber-500";
  return "bg-rose-500";
}

export default function InfraDashboard() {
  const [probes, setProbes] = useState<ProbeMap>({});
  const [inflight, setInflight] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<"web" | "mobile">("web");

  const runProbe = useCallback(async (id: ProbeId) => {
    setInflight((s) => new Set(s).add(id));
    try {
      const res = await fetch(`/api/infra/probe?check=${id}`, { cache: "no-store" });
      const r = (await res.json()) as { ok: boolean; ms: number; detail: string };
      setProbes((prev) => {
        const prevHist = prev[id]?.history ?? [];
        return {
          ...prev,
          [id]: { ms: r.ms, ok: r.ok, detail: r.detail, at: Date.now(), history: [...prevHist, r.ms].slice(-8) },
        };
      });
    } catch (e) {
      setProbes((prev) => ({ ...prev, [id]: { ms: 0, ok: false, detail: String(e), at: Date.now(), history: prev[id]?.history ?? [] } }));
    } finally {
      setInflight((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  }, []);

  const runMany = useCallback(
    async (ids: ProbeId[]) => {
      await Promise.all([...new Set(ids)].map(runProbe));
    },
    [runProbe]
  );

  const actions = tab === "web" ? WEB_ACTIONS : MOBILE_ACTIONS;
  const sectionChecks = (acts: ActionDef[]) => acts.flatMap((a) => a.checks);
  const allChecks = [...new Set([...sectionChecks(WEB_ACTIONS), ...sectionChecks(MOBILE_ACTIONS)])] as ProbeId[];

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <header className="mb-7 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Infra · Speed</h1>
          <p className="mt-1 text-[13px] text-zinc-400">
            Live latency of every integration + simulated speed of every user action. Read-only probes — no money moves.
          </p>
        </div>
        <button
          onClick={() => runMany(allChecks)}
          className="rounded-lg bg-emerald-500/90 px-4 py-2 text-[13px] font-semibold text-black transition hover:bg-emerald-400"
        >
          Run everything
        </button>
      </header>

      {/* Integrations strip */}
      <section className="mb-8">
        <h2 className="mb-3 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-500">Integrations</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {PROBE_META.map((p) => {
            const r = probes[p.id];
            const busy = inflight.has(p.id);
            return (
              <button
                key={p.id}
                onClick={() => runProbe(p.id)}
                className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-3 text-left transition hover:border-zinc-700"
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <span className={`size-2 shrink-0 rounded-full ${r ? dot(r.ms, r.ok) : "bg-zinc-600"}`} />
                  <span className="truncate text-[13px] text-zinc-200">{p.label}</span>
                </span>
                <span className={`shrink-0 font-mono text-[13px] tabular-nums ${r ? band(r.ms, r.ok) : "text-zinc-500"}`}>
                  {busy ? "…" : r ? (r.ok ? `${r.ms}ms` : "fail") : "—"}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Section tabs */}
      <div className="mb-4 flex items-center gap-2">
        <Tab active={tab === "web"} onClick={() => setTab("web")} label="Web app" />
        <Tab active={tab === "mobile"} onClick={() => setTab("mobile")} label="Mobile app" />
        <button
          onClick={() => runMany(sectionChecks(actions) as ProbeId[])}
          className="ml-auto rounded-lg border border-zinc-700 px-3 py-1.5 text-[12px] font-medium text-zinc-300 transition hover:bg-zinc-800"
        >
          Run all ({tab})
        </button>
      </div>

      {/* Actions */}
      <section className="space-y-2">
        {actions.map((a) => {
          const legs = a.checks.map((c) => ({ id: c, r: probes[c] }));
          const haveAll = legs.every((l) => l.r);
          const total = haveAll ? legs.reduce((s, l) => s + (l.r!.ms || 0), 0) : null;
          const allOk = haveAll && legs.every((l) => l.r!.ok);
          const busy = a.checks.some((c) => inflight.has(c));
          return (
            <div key={a.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[15px] font-medium text-zinc-100">{a.label}</span>
                    {total != null && (
                      <span className={`font-mono text-[13px] font-semibold tabular-nums ${band(total, allOk)}`}>
                        {allOk ? `${total}ms` : "fail"}
                        <span className="ml-1 text-[10px] font-normal text-zinc-500">critical path</span>
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12px] text-zinc-500">{a.desc}</p>
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {legs.map((l) => (
                      <span
                        key={l.id}
                        title={l.r?.detail ?? PROBE_LABEL[l.id]}
                        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px]"
                      >
                        <span className={`size-1.5 rounded-full ${l.r ? dot(l.r.ms, l.r.ok) : "bg-zinc-600"}`} />
                        <span className="text-zinc-400">{PROBE_LABEL[l.id]}</span>
                        <span className={`font-mono tabular-nums ${l.r ? band(l.r.ms, l.r.ok) : "text-zinc-600"}`}>
                          {l.r ? (l.r.ok ? `${l.r.ms}` : "×") : "—"}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => runMany(a.checks)}
                  disabled={busy}
                  className="shrink-0 rounded-lg bg-zinc-100 px-3.5 py-2 text-[12px] font-semibold text-black transition hover:bg-white disabled:opacity-50"
                >
                  {busy ? "Running…" : "Run"}
                </button>
              </div>
            </div>
          );
        })}
      </section>

      <p className="mt-8 text-center text-[11px] leading-relaxed text-zinc-600">
        Latency bands: <span className="text-emerald-400">&lt;{FAST_MS}ms</span> ·{" "}
        <span className="text-amber-400">&lt;{OK_MS}ms</span> · <span className="text-rose-400">slow / fail</span>.
        Action latency = sum of its integration legs (sequential critical path).
        <br />
        db / Sui / Onara / FX report <strong>warm steady-state</strong> (the cold channel-open is paid once at
        server boot, off the hot path); Linq / Stripe / prover are cold reachability RTT to remote endpoints.
      </p>
    </div>
  );
}

function Tab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-4 py-2 text-[13px] font-medium transition ${
        active ? "bg-zinc-100 text-black" : "border border-zinc-800 text-zinc-400 hover:bg-zinc-800"
      }`}
    >
      {label}
    </button>
  );
}
