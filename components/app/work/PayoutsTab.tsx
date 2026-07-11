"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Delete02Icon,
  UserMultipleIcon,
  UserGroupIcon,
  CheckmarkCircle02Icon,
  CloudUploadIcon,
  Csv01Icon,
  FloppyDiskIcon,
  Tick02Icon,
  Cancel01Icon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import {
  GlassCard,
  GlassPill,
  PrimaryButton,
  Sheet,
  Eyebrow,
  MicroLabel,
  EmptyState,
  Spinner,
  SlideToConfirm,
  api,
  ApiError,
  useToast,
  useCurrency,
  resolveRecipient,
} from "@/components/app";
import { signSponsorReadyBytes, friendlyError } from "@/components/app/cheques/signBytes";

const MAX_RECIPIENTS = 50;

type ResolveState =
  | { status: "idle" }
  | { status: "resolving" }
  | { status: "ok"; address: string; displayName: string }
  | { status: "error"; message: string };

type Row = {
  /** Stable client key for React. */
  key: string;
  /** What the user typed: @handle / alice.talise.sui / 0x… */
  input: string;
  /** USDsui amount as a raw input string. */
  amount: string;
  /** Optional per-recipient label (memo). */
  label: string;
  resolve: ResolveState;
};

/** A saved team, as returned by /api/payouts/teams. */
type SavedTeam = {
  id: string;
  name: string;
  members: { recipient: string; amount?: number; label?: string }[];
  updatedAt: number;
};

let rowSeq = 0;
function emptyRow(): Row {
  rowSeq += 1;
  return {
    key: `r${rowSeq}_${Date.now().toString(36)}`,
    input: "",
    amount: "",
    label: "",
    resolve: { status: "idle" },
  };
}

/** Build a row from raw parts (used by CSV + paste + team loading). */
function rowFrom(input: string, amount: string, label: string): Row {
  const r = emptyRow();
  r.input = input;
  r.amount = amount;
  r.label = label;
  return r;
}

/**
 * Parse a CSV / pasted-list blob into recipient parts. Accepts:
 *   - the existing paste format: `handle,amount,label` per line
 *   - a real .csv with an OPTIONAL header row (handle,amount,label in any order)
 * Tolerates quoted fields and CRLF. Returns parsed rows + a skipped count for
 * lines that had no recipient handle at all.
 */
function parseDelimited(text: string): {
  rows: { input: string; amount: string; label: string }[];
  skipped: number;
} {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { rows: [], skipped: 0 };

  const unquote = (s: string) =>
    s.trim().replace(/^"(.*)"$/s, "$1").replace(/""/g, '"').trim();
  const splitCsv = (line: string) => {
    // Simple CSV split that respects double-quoted fields containing commas.
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = !inQ;
      } else if (ch === "," && !inQ) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((p) => p.trim());
  };

  // Header detection: first line's cells are all non-numeric and include a
  // recognizable column name → map columns; otherwise assume handle,amount,label.
  let idxHandle = 0;
  let idxAmount = 1;
  let idxLabel = 2;
  let start = 0;
  const first = splitCsv(lines[0]).map((c) => unquote(c).toLowerCase());
  const looksLikeHeader =
    first.some((c) => /handle|recipient|address|name|to/.test(c)) &&
    !first.some((c) => /^\$?\d/.test(c));
  if (looksLikeHeader) {
    const find = (re: RegExp) => first.findIndex((c) => re.test(c));
    const h = find(/handle|recipient|address|to|name/);
    const a = find(/amount|usd|pay|value/);
    const l = find(/label|memo|note|for|reason/);
    if (h >= 0) idxHandle = h;
    if (a >= 0) idxAmount = a;
    if (l >= 0) idxLabel = l;
    start = 1;
  }

  const rows: { input: string; amount: string; label: string }[] = [];
  let skipped = 0;
  for (let i = start; i < lines.length; i++) {
    const cells = splitCsv(lines[i]).map(unquote);
    const input = (cells[idxHandle] ?? "").trim();
    const amount = (cells[idxAmount] ?? "").replace(/[^\d.]/g, "");
    const label = (cells[idxLabel] ?? "").trim();
    if (!input) {
      skipped++;
      continue;
    }
    rows.push({ input, amount, label });
  }
  return { rows, skipped };
}

/**
 * PayoutsTab — pay your whole team USDsui in ONE atomic sponsored
 * transaction. Three stages in a single sheet:
 *
 *   1) Add recipients — manual person cards (the PRIMARY path) with a [+] Add
 *      person button; OR upload a .csv / drag-drop a list; OR paste a list
 *      (quieter disclosure). Save the current roster as a reusable team, and
 *      one-tap load a saved team. Each recipient live-resolves via
 *      /api/recipient/resolve.
 *   2) Review — resolved recipients, per-amount, running total + count.
 *   3) Pay — SlideToConfirm → prepare (build one sponsored PTB) → sign with
 *      the zkLogin ephemeral key + sponsor-execute → record the digest.
 *
 * Everyone or no one: the PTB is atomic on chain.
 */
export function PayoutsTab() {
  const { formatUsd } = useCurrency();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Eyebrow>Batch payouts</Eyebrow>
        <PrimaryButton onClick={() => setCreateOpen(true)} variant="ghost">
          <HugeiconsIcon icon={Add01Icon} size={15} strokeWidth={2} />
          New payout
        </PrimaryButton>
      </div>

      <GlassCard className="p-2">
        <EmptyState
          icon={<HugeiconsIcon icon={UserMultipleIcon} size={26} strokeWidth={1.6} />}
          title="Pay your whole team in one signature"
          subtitle="Add everyone — type them in, upload a CSV, or load a saved team — and send USDsui to all of them in one atomic transaction. Everyone gets paid, or no one does. Gas is on us."
          action={
            <PrimaryButton onClick={() => setCreateOpen(true)}>
              <HugeiconsIcon icon={Add01Icon} size={15} strokeWidth={2} />
              Start a payout
            </PrimaryButton>
          }
        />
      </GlassCard>

      <BatchPayoutSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        formatUsd={formatUsd}
      />
    </div>
  );
}

// ── Batch payout sheet ──────────────────────────────────────────────────────

function BatchPayoutSheet({
  open,
  onClose,
  formatUsd,
}: {
  open: boolean;
  onClose: () => void;
  formatUsd: (usd: number, o?: { fixed?: boolean }) => string;
}) {
  const { toast } = useToast();
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [pasteText, setPasteText] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [stage, setStage] = useState<"build" | "review">("build");
  const [slideReset, setSlideReset] = useState(0);
  const [done, setDone] = useState<{ count: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Saved teams
  const [teams, setTeams] = useState<SavedTeam[]>([]);
  const [savingTeam, setSavingTeam] = useState(false);
  const [teamNameOpen, setTeamNameOpen] = useState(false);
  const [teamName, setTeamName] = useState("");
  // The team currently being edited in place (its roster + name loaded into the
  // editor). Null when building a fresh roster / saving a brand-new team.
  const [editingTeam, setEditingTeam] = useState<SavedTeam | null>(null);

  const reset = useCallback(() => {
    setRows([emptyRow()]);
    setPasteText("");
    setPasteOpen(false);
    setStage("build");
    setDone(null);
    setTeamNameOpen(false);
    setTeamName("");
    setEditingTeam(null);
  }, []);

  // Reset to a clean slate whenever the sheet (re)opens.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  // Load saved teams once the sheet opens (best-effort; failures are silent).
  const loadTeams = useCallback(async () => {
    try {
      const r = await api<{ teams: SavedTeam[] }>("/api/payouts/teams");
      setTeams(Array.isArray(r.teams) ? r.teams : []);
    } catch {
      /* private-beta gate / network — just show no teams */
    }
  }, []);
  useEffect(() => {
    if (open) void loadTeams();
  }, [open, loadTeams]);

  const setRow = (key: string, patch: Partial<Row>) =>
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const addRow = () =>
    setRows((cur) =>
      cur.length >= MAX_RECIPIENTS ? cur : [...cur, emptyRow()]
    );

  const removeRow = (key: string) =>
    setRows((cur) => (cur.length === 1 ? [emptyRow()] : cur.filter((r) => r.key !== key)));

  /**
   * Merge freshly-parsed parts into the current rows: drop empty starter rows,
   * append the new ones, clamp to the max. Returns counts so callers can toast
   * "N added · M skipped".
   */
  const mergeParsed = useCallback(
    (parsed: { input: string; amount: string; label: string }[]): number => {
      if (parsed.length === 0) return 0;
      let added = 0;
      setRows((cur) => {
        const keep = cur.filter((r) => r.input.trim() || r.amount.trim());
        const room = Math.max(0, MAX_RECIPIENTS - keep.length);
        const take = parsed.slice(0, room);
        added = take.length;
        const merged = [
          ...keep,
          ...take.map((p) => rowFrom(p.input, p.amount, p.label)),
        ];
        return merged.length === 0 ? [emptyRow()] : merged;
      });
      return added;
    },
    []
  );

  // Parse pasted text (the quieter disclosure) into rows.
  const applyPaste = () => {
    const { rows: parsed, skipped } = parseDelimited(pasteText);
    const added = mergeParsed(parsed);
    if (added === 0 && skipped === 0) {
      toast("Nothing to add — check the format.", "neutral");
      return;
    }
    toast(
      `${added} added${skipped ? ` · ${skipped} skipped` : ""}`,
      added > 0 ? "success" : "neutral"
    );
    setPasteText("");
    setPasteOpen(false);
  };

  // Read a .csv file and merge its rows.
  const ingestFile = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      const looksCsv =
        /\.csv$/i.test(file.name) ||
        file.type === "text/csv" ||
        file.type === "application/vnd.ms-excel" ||
        file.type === "text/plain" ||
        file.type === "";
      if (!looksCsv) {
        toast("Please upload a .csv file.", "danger");
        return;
      }
      let text: string;
      try {
        text = await file.text();
      } catch {
        toast("Couldn't read that file.", "danger");
        return;
      }
      const { rows: parsed, skipped } = parseDelimited(text);
      const added = mergeParsed(parsed);
      if (added === 0) {
        toast("No recipients found in that CSV.", "danger");
        return;
      }
      toast(`${added} added${skipped ? ` · ${skipped} skipped` : ""}`, "success");
    },
    [mergeParsed, toast]
  );

  // Debounced live-resolve per row whenever its input changes.
  const debounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    for (const row of rows) {
      const q = row.input.trim();
      const t = debounceRef.current;
      if (t[row.key]) clearTimeout(t[row.key]);
      if (q.length < 2) {
        if (row.resolve.status !== "idle") setRow(row.key, { resolve: { status: "idle" } });
        continue;
      }
      // Already resolved this exact input → skip.
      if (row.resolve.status === "ok") continue;
      t[row.key] = setTimeout(async () => {
        setRow(row.key, { resolve: { status: "resolving" } });
        try {
          const r = await resolveRecipient(q);
          setRow(row.key, {
            resolve: { status: "ok", address: r.address, displayName: r.displayName },
          });
        } catch (err) {
          setRow(row.key, {
            resolve: {
              status: "error",
              message:
                err instanceof ApiError && err.status === 404
                  ? "No Talise user / address for that."
                  : "Couldn't resolve that recipient.",
            },
          });
        }
      }, 450);
    }
    return () => {
      const t = debounceRef.current;
      for (const k of Object.keys(t)) clearTimeout(t[k]);
    };
    // We re-run when any row's input changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => `${r.key}:${r.input}`).join("|")]);

  // The valid, resolved, positive-amount recipients (what we'd actually send).
  const validLegs = useMemo(
    () =>
      rows
        .map((r) => {
          const amount = Number(r.amount);
          if (r.resolve.status !== "ok") return null;
          if (!Number.isFinite(amount) || amount <= 0) return null;
          return {
            input: r.input.trim(),
            address: r.resolve.address,
            displayName: r.resolve.displayName,
            amount,
            label: r.label.trim() || undefined,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [rows]
  );

  const total = useMemo(
    () => Math.round(validLegs.reduce((acc, l) => acc + l.amount, 0) * 100) / 100,
    [validLegs]
  );

  const anyResolving = rows.some((r) => r.resolve.status === "resolving");
  const anyError = rows.some((r) => r.resolve.status === "error");
  // Ready to review when every non-empty row resolves and has a valid amount,
  // there's at least one leg, and nothing's mid-flight or errored.
  const filledRows = rows.filter((r) => r.input.trim() || r.amount.trim());
  const allRowsValid =
    filledRows.length > 0 &&
    filledRows.every(
      (r) => r.resolve.status === "ok" && Number(r.amount) > 0
    );
  const canReview =
    allRowsValid && !anyResolving && !anyError && validLegs.length > 0;

  // ── Saved teams ────────────────────────────────────────────────────────
  // Load a team into the form: every member becomes a person card with its
  // saved amount prefilled (editable). Replaces the current roster. With
  // `{ editing: true }` the name is prefilled + the save row opened so the next
  // save UPDATES this team in place (same name → server reuses its object id).
  const loadTeam = useCallback(
    (team: SavedTeam, opts?: { editing?: boolean }) => {
      const next = team.members
        .filter((m) => m.recipient && m.recipient.trim())
        .slice(0, MAX_RECIPIENTS)
        .map((m) =>
          rowFrom(
            m.recipient.trim(),
            m.amount != null && Number.isFinite(m.amount) ? String(m.amount) : "",
            (m.label ?? "").trim()
          )
        );
      setRows(next.length === 0 ? [emptyRow()] : next);
      setStage("build");
      if (opts?.editing) {
        setEditingTeam(team);
        setTeamName(team.name);
        setTeamNameOpen(true);
        toast(`Editing "${team.name}"`, "neutral");
      } else {
        // A plain load (to re-pay) is not an edit — clear any edit context.
        setEditingTeam(null);
        toast(`Loaded "${team.name}"`, "success");
      }
    },
    [toast]
  );

  const deleteTeam = useCallback(
    async (team: SavedTeam) => {
      // Optimistic removal; restore on failure.
      setTeams((cur) => cur.filter((t) => t.id !== team.id));
      try {
        await api(`/api/payouts/teams/${team.id}`, { method: "DELETE" });
      } catch {
        toast("Couldn't delete that team.", "danger");
        void loadTeams();
      }
    },
    [loadTeams, toast]
  );

  // Members snapshot for "save as team" — uses what the user typed (NOT the
  // resolved address), so the team re-resolves cleanly next time.
  const teamMembers = useMemo(
    () =>
      rows
        .filter((r) => r.input.trim())
        .map((r) => ({
          recipient: r.input.trim(),
          amount: Number(r.amount) > 0 ? Number(r.amount) : undefined,
          label: r.label.trim() || undefined,
        })),
    [rows]
  );
  const canSaveTeam = teamMembers.length > 0 && !anyError;

  // Save (create) OR update the current roster as a named team. Mirrors the
  // batch pipeline shape: prepare → (on-chain) sign → record.
  //   • on-chain disabled → POST /api/payouts/teams does a plain DB upsert and
  //     returns the team directly.
  //   • on-chain enabled  → POST returns sponsor-ready `payroll::create` /
  //     `set_roster` bytes we sign, then POST …/teams/record finalizes the DB
  //     row. The prepare response carries `chainObjectId` when an existing
  //     team (matched by name) is being edited; threading it into /record makes
  //     the server REUSE that on-chain object id (an in-place edit) instead of
  //     parsing a freshly-created one from the digest.
  const saveTeam = useCallback(async () => {
    const name = teamName.trim();
    if (!name) {
      toast("Give the team a name.", "neutral");
      return;
    }
    const editing = !!editingTeam;
    setSavingTeam(true);
    try {
      const prep = await api<{
        mode?: "db" | "onchain";
        team?: SavedTeam;
        edit?: boolean;
        chainObjectId?: string;
        name?: string;
        bytes?: string;
      }>("/api/payouts/teams", {
        method: "POST",
        body: { name, members: teamMembers },
      });

      let saved: SavedTeam;
      if (prep.mode === "onchain" && prep.bytes) {
        // Sign the sponsor-ready roster-mutation bytes with the zkLogin
        // ephemeral key + sponsor-execute.
        const { digest } = await signSponsorReadyBytes(prep.bytes, {
          kind: "payroll-team",
        });
        // Finalize the DB row. Passing `chainObjectId` (present for edits) keeps
        // the existing on-chain Team object id; omitting it on create lets the
        // server parse the new id from the confirmed digest.
        const rec = await api<{ team: SavedTeam }>("/api/payouts/teams/record", {
          method: "POST",
          body: {
            digest,
            name,
            members: teamMembers,
            chainObjectId: prep.chainObjectId,
          },
        });
        saved = rec.team;
      } else {
        // Legacy / on-chain-disabled: the DB upsert already returned the team.
        if (!prep.team) throw new Error("Couldn't save the team.");
        saved = prep.team;
      }

      // Upsert into local list (replace by id or name).
      setTeams((cur) => {
        const without = cur.filter((t) => t.id !== saved.id && t.name !== saved.name);
        return [saved, ...without];
      });
      setTeamNameOpen(false);
      setTeamName("");
      setEditingTeam(null);
      toast(`${editing ? "Updated" : "Saved"} "${saved.name}"`, "success");
    } catch (err) {
      toast(
        err instanceof ApiError ? friendlyError(err, "Couldn't save the team.") : "Couldn't save the team.",
        "danger"
      );
    } finally {
      setSavingTeam(false);
    }
  }, [teamName, teamMembers, editingTeam, toast]);

  // The full pay pipeline: prepare → sign + sponsor-execute → record.
  const payBatch = useCallback(async () => {
    if (validLegs.length === 0) {
      toast("Add at least one valid recipient", "danger");
      throw new Error("no recipients");
    }

    // 1) Prepare — server resolves again (authoritative), screens, gates the
    //    limit, builds ONE sponsored PTB, persists the batch.
    const prep = await api<{
      batchId: string;
      bytes: string;
      recipientCount: number;
      totalUsd: number;
    }>("/api/payouts/batch/prepare", {
      method: "POST",
      body: {
        asset: "USDsui",
        recipients: validLegs.map((l) => ({
          to: l.input,
          amount: l.amount,
          label: l.label,
        })),
      },
    });

    // 2) Sign the sponsor-ready bytes with the zkLogin ephemeral key and
    //    broadcast via /api/zk/sponsor-execute. kind:"send" + the batch total
    //    keeps us on the standard sponsor-execute path (no special handling).
    const { digest } = await signSponsorReadyBytes(prep.bytes, {
      kind: "send",
      amountUsd: prep.totalUsd,
    });

    // 3) Record — mark the batch broadcast with the confirmed digest.
    await api(`/api/payouts/batch/${prep.batchId}/record`, {
      method: "POST",
      body: { digest },
    });

    // Balances + activity refresh (same event ContractsTab posts).
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("talise:tx", { detail: { digest } }));
    }
    toast(
      `Paid ${prep.recipientCount} ${prep.recipientCount === 1 ? "person" : "people"} — ${formatUsd(prep.totalUsd, { fixed: true })}`,
      "success"
    );
    setDone({ count: prep.recipientCount, total: prep.totalUsd });
  }, [validLegs, toast, formatUsd]);

  const onConfirm = useCallback(async () => {
    try {
      await payBatch();
    } catch (err) {
      setSlideReset((n) => n + 1);
      if (err instanceof ApiError) {
        if (err.code === "NOT_SIGNED_IN") {
          toast("Taking you to sign in…", "neutral");
        } else {
          toast(friendlyError(err, "Couldn't run the payout. Please try again."), "danger");
        }
      } else if ((err as Error)?.message && (err as Error).message !== "no recipients") {
        toast("Couldn't run the payout. Please try again.", "danger");
      }
      throw err;
    }
  }, [payBatch, toast]);

  return (
    <Sheet open={open} onClose={onClose} title="Pay your team" size="lg">
      {done ? (
        <SuccessState
          count={done.count}
          total={done.total}
          formatUsd={formatUsd}
          onDone={onClose}
          onAgain={reset}
        />
      ) : stage === "build" ? (
        <div className="space-y-5">
          {/* Saved teams strip */}
          {teams.length > 0 && (
            <div>
              <Eyebrow className="mb-2 block">Your teams</Eyebrow>
              <div className="flex flex-wrap gap-2">
                {teams.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center rounded-full border border-[#15300c]/15 bg-white/60 backdrop-blur-sm transition-[border-color] duration-150 hover:border-[#15300c]/30"
                  >
                    {/* Tap the name to load this team into the editor (to re-pay). */}
                    <button
                      type="button"
                      onClick={() => loadTeam(t)}
                      className="inline-flex items-center gap-1.5 py-1.5 pl-3 pr-1 text-[12px] font-medium text-[#15300c] transition-opacity hover:opacity-70"
                    >
                      <HugeiconsIcon icon={UserGroupIcon} size={13} strokeWidth={1.8} className="text-[#3a5230]" />
                      {t.name}
                      <span className="text-[#3d7a29]">· {t.members.length}</span>
                    </button>
                    {/* Edit — load roster + name back in to update it in place. */}
                    <button
                      type="button"
                      onClick={() => loadTeam(t, { editing: true })}
                      aria-label={`Edit ${t.name}`}
                      className="flex size-7 items-center justify-center rounded-full text-[#3d7a29] transition-colors hover:bg-[#CAFFB8] hover:text-[#15300c]"
                    >
                      <HugeiconsIcon icon={PencilEdit02Icon} size={13} strokeWidth={1.8} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteTeam(t)}
                      aria-label={`Delete ${t.name}`}
                      className="flex size-7 items-center justify-center rounded-full text-[#3d7a29] transition-colors hover:text-[#c0532f]"
                    >
                      <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={2} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* CSV upload — drag-drop target + file picker */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void ingestFile(e.dataTransfer.files?.[0]);
            }}
            className={`rounded-2xl border border-dashed px-4 py-5 text-center transition-colors backdrop-blur-sm ${
              dragOver ? "border-[#3d7a29] bg-[#CAFFB8]" : "border-[#15300c]/15 bg-white/60"
            }`}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                void ingestFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="inline-flex flex-col items-center gap-1.5"
            >
              <span className="flex size-10 items-center justify-center rounded-full bg-[#CAFFB8] text-[#15300c]">
                <HugeiconsIcon icon={CloudUploadIcon} size={20} strokeWidth={1.7} />
              </span>
              <span className="text-[13px] font-medium text-[#15300c]">
                Upload a CSV
              </span>
              <span className="text-[11.5px] text-[#3d7a29]">
                Drag &amp; drop or tap · columns: handle, amount, label
              </span>
            </button>
          </div>

          {/* Manual person cards — the primary path */}
          <div>
            <Eyebrow className="mb-2.5 block">Recipients</Eyebrow>
            <div className="space-y-2.5">
              {rows.map((r, i) => (
                <RecipientCard
                  key={r.key}
                  index={i}
                  row={r}
                  onChange={(patch) => {
                    // Editing the input invalidates a prior resolution.
                    if (patch.input !== undefined) {
                      setRow(r.key, { ...patch, resolve: { status: "idle" } });
                    } else {
                      setRow(r.key, patch);
                    }
                  }}
                  onRemove={() => removeRow(r.key)}
                  removable={rows.length > 1}
                />
              ))}
            </div>
            <div className="mt-3">
              <PrimaryButton
                onClick={addRow}
                disabled={rows.length >= MAX_RECIPIENTS}
                variant="ghost"
                full
              >
                <HugeiconsIcon icon={Add01Icon} size={15} strokeWidth={2} />
                Add person
              </PrimaryButton>
            </div>
            {rows.length >= MAX_RECIPIENTS && (
              <p className="mt-1.5 text-[12px] text-[#3d7a29]">
                Max {MAX_RECIPIENTS} recipients per batch.
              </p>
            )}
          </div>

          {/* Paste a list — quieter disclosure */}
          <div className="rounded-2xl border border-[#15300c]/10 bg-white/60 backdrop-blur-sm">
            <button
              type="button"
              onClick={() => setPasteOpen((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
            >
              <span className="inline-flex items-center gap-2 text-[13px] font-medium text-[#3a5230]">
                <HugeiconsIcon icon={Csv01Icon} size={15} strokeWidth={1.7} />
                Or paste a list
              </span>
              <span className="text-[12px] text-[#3d7a29]">{pasteOpen ? "Hide" : "Show"}</span>
            </button>
            {pasteOpen && (
              <div className="space-y-2.5 px-4 pb-4">
                <textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  rows={3}
                  placeholder={"@alice,500,Design\nbob.talise.sui,300\n0xabc…,120,Bonus"}
                  className="w-full resize-y rounded-xl border border-[#15300c]/15 bg-white/60 px-3.5 py-2.5 font-mono text-[13px] text-[#15300c] outline-none backdrop-blur-sm placeholder:text-[#3d7a29] focus:ring-2 focus:ring-[#3d7a29]/45"
                />
                <p className="text-[12px] text-[#3d7a29]">
                  One per line: handle,amount,label — e.g. @alice,500,Design · label optional
                </p>
                {pasteText.trim() && (
                  <GlassPill
                    onClick={applyPaste}
                    tint="#CAFFB8"
                    size="sm"
                    icon={<HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={2} />}
                  >
                    Add pasted recipients
                  </GlassPill>
                )}
              </div>
            )}
          </div>

          {/* Save as team */}
          {canSaveTeam && (
            <div>
              {teamNameOpen ? (
                <div className="flex items-center gap-2">
                  <input
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value.slice(0, 60))}
                    placeholder="Team name (e.g. Design team)"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveTeam();
                      if (e.key === "Escape") {
                        setTeamNameOpen(false);
                        setEditingTeam(null);
                      }
                    }}
                    className="min-w-0 flex-1 rounded-xl border border-[#15300c]/15 bg-white/60 px-3 py-2.5 text-[13px] text-[#15300c] outline-none backdrop-blur-sm placeholder:text-[#3d7a29] focus:ring-2 focus:ring-[#3d7a29]/45"
                  />
                  <button
                    type="button"
                    onClick={() => void saveTeam()}
                    disabled={savingTeam || !teamName.trim()}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#CAFFB8] px-3.5 py-2.5 text-[13px] font-medium text-[#15300c] transition-opacity hover:opacity-80 disabled:opacity-40"
                  >
                    {savingTeam ? <Spinner size={13} /> : <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />}
                    {editingTeam ? "Update" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTeamNameOpen(false);
                      setEditingTeam(null);
                    }}
                    aria-label="Cancel"
                    className="flex size-9 shrink-0 items-center justify-center rounded-xl text-[#3d7a29] transition-colors hover:text-[#15300c]"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.8} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setTeamNameOpen(true)}
                  className="inline-flex items-center gap-1.5 text-[13px] text-[#3a5230] transition-opacity hover:opacity-70"
                >
                  <HugeiconsIcon icon={FloppyDiskIcon} size={14} strokeWidth={1.8} />
                  Save as team
                </button>
              )}
            </div>
          )}

          {/* Running total */}
          <div className="flex items-center justify-between rounded-xl border border-[#15300c]/10 bg-white/60 px-4 py-3.5 backdrop-blur-sm">
            <span className="text-[14px] text-[#3a5230]">
              {validLegs.length} ready · total
            </span>
            <span
              className="text-[22px] font-semibold text-[#15300c]"
              style={{ fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}
            >
              {formatUsd(total, { fixed: true })}
            </span>
          </div>

          <PrimaryButton onClick={() => setStage("review")} disabled={!canReview} full>
            Review {validLegs.length} {validLegs.length === 1 ? "payout" : "payouts"}
          </PrimaryButton>
        </div>
      ) : (
        /* Review + Pay */
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setStage("build")}
            className="text-[13px] text-[#3d7a29] transition-opacity hover:opacity-80"
          >
            ← Edit recipients
          </button>

          <GlassCard className="overflow-hidden p-0">
            {validLegs.map((l, i) => (
              <div key={`${l.address}_${i}`}>
                <div className="flex items-center gap-3.5 px-4 py-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8] text-[#15300c]">
                    <HugeiconsIcon icon={UserMultipleIcon} size={15} strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-[#15300c]">
                      {l.displayName}
                    </span>
                    {l.label && (
                      <span className="block truncate text-[11px] text-[#3d7a29]">
                        {l.label}
                      </span>
                    )}
                  </span>
                  <span
                    className="shrink-0 text-[14px] font-semibold text-[#15300c]"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatUsd(l.amount, { fixed: true })}
                  </span>
                </div>
                {i < validLegs.length - 1 && <div className="mx-4 border-t border-[#15300c]/10" />}
              </div>
            ))}
          </GlassCard>

          <div className="rounded-xl border border-[#15300c]/10 bg-white/60 px-4 py-4 backdrop-blur-sm">
            <div className="flex items-center justify-between">
              <MicroLabel>Total to {validLegs.length} {validLegs.length === 1 ? "person" : "people"}</MicroLabel>
              <span
                className="text-[22px] font-semibold text-[#15300c]"
                style={{ fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}
              >
                {formatUsd(total, { fixed: true })}
              </span>
            </div>
            <p className="mt-1.5 text-[12px] text-[#3d7a29]">
              One atomic transaction — everyone gets paid, or no one does. Gas is
              sponsored by Talise.
            </p>
          </div>

          <SlideToConfirm
            label="Slide to pay everyone"
            onConfirm={onConfirm}
            disabled={validLegs.length === 0}
            resetSignal={slideReset}
          />
        </div>
      )}
    </Sheet>
  );
}

// ── A single editable recipient person card ─────────────────────────────────

function RecipientCard({
  index,
  row,
  onChange,
  onRemove,
  removable,
}: {
  index: number;
  row: Row;
  onChange: (patch: Partial<Row>) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  return (
    <div className="rounded-2xl border border-[#15300c]/10 bg-white/60 p-3 backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[#3d7a29]">
          <HugeiconsIcon icon={UserMultipleIcon} size={12} strokeWidth={1.8} />
          Person {index + 1}
        </span>
        <button
          type="button"
          onClick={onRemove}
          disabled={!removable}
          aria-label="Remove person"
          className="flex size-7 items-center justify-center rounded-lg text-[#3d7a29] transition-colors hover:text-[#c0532f] disabled:opacity-30"
        >
          <HugeiconsIcon icon={Delete02Icon} size={15} strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <input
          value={row.input}
          onChange={(e) => onChange({ input: e.target.value })}
          placeholder="@alice or 0x…"
          className="min-w-0 flex-1 rounded-xl border border-[#15300c]/15 bg-white/60 px-3 py-2.5 text-[14px] text-[#15300c] outline-none backdrop-blur-sm placeholder:text-[#3d7a29] focus:ring-2 focus:ring-[#3d7a29]/45"
        />
        <div className="flex w-28 items-center rounded-xl border border-[#15300c]/15 bg-white/60 px-2.5 py-2.5 backdrop-blur-sm focus-within:ring-2 focus-within:ring-[#3d7a29]/45">
          <span className="text-[13px] text-[#3d7a29]">$</span>
          <input
            value={row.amount}
            onChange={(e) => onChange({ amount: e.target.value.replace(/[^\d.]/g, "") })}
            inputMode="decimal"
            placeholder="0.00"
            aria-label="Amount"
            className="w-full bg-transparent pl-1 text-right text-[14px] text-[#15300c] outline-none placeholder:text-[#3d7a29]"
            style={{ fontVariantNumeric: "tabular-nums" }}
          />
        </div>
      </div>

      {/* Optional label + resolve status */}
      <div className="mt-2 flex items-center gap-2 pl-1">
        <input
          value={row.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Label (optional)"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-[#3a5230] outline-none placeholder:text-[#3d7a29]"
        />
        <span className="shrink-0 text-[11px]">
          {row.resolve.status === "resolving" && (
            <span className="inline-flex items-center gap-1 text-[#3d7a29]">
              <Spinner size={11} /> Resolving…
            </span>
          )}
          {row.resolve.status === "ok" && (
            <span className="inline-flex items-center gap-1 text-[#3d7a29]">
              <HugeiconsIcon icon={CheckmarkCircle02Icon} size={12} strokeWidth={2} />
              {row.resolve.displayName}
            </span>
          )}
          {row.resolve.status === "error" && (
            <span className="text-[#c0532f]">{row.resolve.message}</span>
          )}
        </span>
      </div>
    </div>
  );
}

// ── Success state ───────────────────────────────────────────────────────────

function SuccessState({
  count,
  total,
  formatUsd,
  onDone,
  onAgain,
}: {
  count: number;
  total: number;
  formatUsd: (usd: number, o?: { fixed?: boolean }) => string;
  onDone: () => void;
  onAgain: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-[#CAFFB8] text-[#15300c]">
        <HugeiconsIcon icon={CheckmarkCircle02Icon} size={30} strokeWidth={1.8} />
      </span>
      <div>
        <h3 className="text-[18px] font-medium text-[#15300c]">Team paid</h3>
        <p className="mt-1 text-[14px] text-[#3a5230]">
          {formatUsd(total, { fixed: true })} to {count}{" "}
          {count === 1 ? "person" : "people"} in one transaction.
        </p>
      </div>
      <div className="flex w-full gap-2">
        <PrimaryButton onClick={onAgain} variant="ghost" full>
          Pay another batch
        </PrimaryButton>
        <PrimaryButton onClick={onDone} full>
          Done
        </PrimaryButton>
      </div>
    </div>
  );
}
