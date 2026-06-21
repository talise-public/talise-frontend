"use client";

import { amountInWords } from "./amountInWords";

export type ChequeCardProps = {
  amountUsd: number;
  payee: string;
  memo?: string;
  signature: string;
  chequeNo: string;
  /** Diagonal status stamp, e.g. "ISSUED", "RECLAIMED", "CLAIMED". */
  stamp?: string;
};

const INK = "#15300c";
const INK_SOFT = "#3a5230";
const RULE = "#3d7a29";
const FOREST = "#3d7a29"; // brand forest, for ink on cream
const STAMP = "#c0532f"; // muted coral for the status stamp

/**
 * A skeuomorphic paper-cheque card. Cream stock on the v2 mint page:
 * engraved TALISE header, "pay to the order of" line, a boxed figure, the
 * amount in words, memo + authorised-signature lines, and an optional diagonal
 * status stamp. Read-only; the write screen passes live field values so the
 * preview updates as you type. Mirrors the iOS `ChequeCard`.
 */
export function ChequeCard({
  amountUsd,
  payee,
  memo = "",
  signature,
  chequeNo,
  stamp,
}: ChequeCardProps) {
  const figure = `$${Math.max(0, amountUsd).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

  return (
    <div
      className="relative w-full select-none overflow-hidden"
      style={{
        aspectRatio: "16 / 8.6",
        borderRadius: 28,
        background:
          "linear-gradient(135deg, #f7fcf2 0%, #eef8e4 100%)",
        boxShadow: "10px 10px 0 #15300c",
        color: INK,
        fontFamily: "var(--font-serif), Georgia, serif",
      }}
    >
      <div className="flex h-full flex-col justify-between p-[5%]">
        {/* Header band */}
        <div className="flex items-start justify-between">
          <div className="flex flex-col">
            <span
              className="font-serif font-bold"
              style={{
                color: FOREST,
                letterSpacing: "0.18em",
                fontSize: "clamp(13px, 3.4vw, 17px)",
                lineHeight: 1,
              }}
            >
              TALISE
            </span>
            <span
              className="font-mono"
              style={{
                color: INK_SOFT,
                letterSpacing: "0.16em",
                fontSize: "clamp(5px, 1.4vw, 7px)",
                marginTop: 3,
              }}
            >
              PAY ANYONE, ANYWHERE
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span
              className="font-mono"
              style={{ color: INK_SOFT, fontSize: "clamp(7px, 1.8vw, 10px)" }}
            >
              No. {chequeNo}
            </span>
            <span
              className="font-serif font-semibold"
              style={{ color: INK, fontSize: "clamp(8px, 2vw, 11px)", marginTop: 2 }}
            >
              USDsui
            </span>
          </div>
        </div>

        <div
          style={{ height: 1, background: RULE, opacity: 0.45, marginTop: "2%" }}
        />

        {/* Pay to the order of + boxed figure */}
        <div className="flex items-end gap-3" style={{ marginTop: "3%" }}>
          <div className="min-w-0 flex-1">
            <span
              className="block font-mono"
              style={{
                color: INK_SOFT,
                letterSpacing: "0.12em",
                fontSize: "clamp(6px, 1.6vw, 8px)",
              }}
            >
              PAY TO THE ORDER OF
            </span>
            <span
              className="block truncate font-serif font-semibold"
              style={{ color: INK, fontSize: "clamp(14px, 3.8vw, 20px)", marginTop: 2 }}
            >
              {payee || "—"}
            </span>
            <div style={{ height: 1, background: RULE, opacity: 0.6, marginTop: 3 }} />
          </div>
          <div
            className="shrink-0 font-serif font-bold"
            style={{
              color: INK,
              fontSize: "clamp(13px, 3.4vw, 18px)",
              border: `1.4px solid ${INK}88`,
              borderRadius: 6,
              padding: "5px 10px",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {figure}
          </div>
        </div>

        {/* Amount in words */}
        <div className="flex items-end gap-2" style={{ marginTop: "3%" }}>
          <span
            className="truncate font-serif italic"
            style={{ color: INK, fontSize: "clamp(9px, 2.4vw, 12px)" }}
          >
            {amountInWords(Math.max(0, amountUsd))}
          </span>
          <div style={{ flex: 1, height: 1, background: RULE, opacity: 0.6 }} />
          <span
            className="shrink-0 font-serif"
            style={{ color: INK_SOFT, fontSize: "clamp(7px, 1.8vw, 9px)" }}
          >
            USDsui
          </span>
        </div>

        {/* Memo + signature */}
        <div className="flex items-end justify-between gap-4" style={{ marginTop: "3%" }}>
          <div className="min-w-0" style={{ maxWidth: "55%" }}>
            <span
              className="block truncate font-serif"
              style={{ color: INK, fontSize: "clamp(8px, 2vw, 11px)", minHeight: "1em" }}
            >
              {memo || " "}
            </span>
            <div style={{ height: 1, background: RULE, opacity: 0.5, marginTop: 2 }} />
            <span
              className="font-mono"
              style={{ color: INK_SOFT, fontSize: "clamp(5px, 1.3vw, 6px)", letterSpacing: "0.1em" }}
            >
              MEMO
            </span>
          </div>
          <div className="min-w-0 text-right" style={{ maxWidth: "45%" }}>
            <span
              className="block truncate italic"
              style={{
                color: FOREST,
                fontSize: "clamp(13px, 3.4vw, 18px)",
                fontFamily: "var(--font-serif), 'Snell Roundhand', cursive",
              }}
            >
              {signature || " "}
            </span>
            <div style={{ height: 1, background: RULE, opacity: 0.5, marginTop: 2 }} />
            <span
              className="font-mono"
              style={{ color: INK_SOFT, fontSize: "clamp(5px, 1.3vw, 6px)", letterSpacing: "0.1em" }}
            >
              AUTHORIZED SIGNATURE
            </span>
          </div>
        </div>
      </div>

      {/* Diagonal status stamp */}
      {stamp && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span
            style={{
              transform: "rotate(-14deg)",
              color: STAMP,
              border: `3px solid ${STAMP}`,
              borderRadius: 6,
              padding: "4px 14px",
              fontFamily:
                "var(--font-display), system-ui, sans-serif",
              fontWeight: 800,
              letterSpacing: "0.12em",
              fontSize: "clamp(16px, 4vw, 26px)",
            }}
          >
            {stamp}
          </span>
        </div>
      )}
    </div>
  );
}
