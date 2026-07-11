"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Standalone admin login (outside the gated (dash) route group). Posts
 * the token to /api/admin/auth which sets the httpOnly cookie. On dev-
 * open setups this page is never reached — the gate lets you straight in.
 */
export default function AdminLoginPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) {
        setError(json?.error ?? `Login failed (${res.status})`);
        return;
      }
      router.push("/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 text-fg">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-7"
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" />
          <span className="font-mono text-sm font-semibold tracking-tight">Talise Admin</span>
        </div>
        <h1 className="mt-4 text-lg font-semibold tracking-tight">Enter admin token</h1>
        <p className="mt-1 text-sm text-fg-dim">
          The token is the <code className="font-mono text-fg-muted">ADMIN_TOKEN</code> value from
          your server environment.
        </p>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ADMIN_TOKEN"
          autoFocus
          className="mt-5 w-full rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg placeholder:text-fg-dim focus:border-accent-deep focus:outline-none"
        />
        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
        <button
          type="submit"
          disabled={busy || !token}
          className="mt-5 w-full rounded-lg bg-accent-deep px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Unlock dashboard"}
        </button>
      </form>
    </div>
  );
}
