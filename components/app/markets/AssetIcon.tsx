"use client";

import { useState } from "react";
import { assetMeta } from "@/lib/waterx-assets";

/** Real WaterX market logo (proxied) with a brand-coloured badge fallback. */
export function AssetIcon({ ticker, size = 28 }: { ticker: string; size?: number }) {
  const m = assetMeta(ticker);
  const [failed, setFailed] = useState(false);
  if (!failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/asset-icon/${ticker.toUpperCase()}`}
        alt={m.name}
        width={size}
        height={size}
        onError={() => setFailed(true)}
        style={{ width: size, height: size, borderRadius: "50%", flex: "none", background: "#fff", objectFit: "cover" }}
      />
    );
  }
  const chars = m.cat === "stock" ? m.sym.slice(0, 4) : m.sym.slice(0, 3);
  return (
    <span
      aria-hidden
      style={{
        width: size, height: size, borderRadius: "50%", flex: "none", background: m.color, color: "#fff",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontSize: Math.max(8, size * (m.cat === "stock" ? 0.3 : 0.36)), fontWeight: 700, letterSpacing: "-0.05em",
      }}
    >
      {chars}
    </span>
  );
}
