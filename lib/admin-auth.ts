import "server-only";

import { cookies } from "next/headers";
import { userById } from "@/lib/db";
import { readSessionEntryId } from "@/lib/session";
import { isAdminIdentity } from "@/lib/admin";

/**
 * Admin dashboard auth gate.
 *
 * Three ways in, checked in order:
 *   1. dev-open , non-production AND no ADMIN_TOKEN configured. Local
 *                   convenience so `pnpm dev` → /admin "just works". A
 *                   visible banner marks the session as unauthenticated.
 *   2. token    , the `talise_admin` cookie (set via /admin/login) OR
 *                   an `x-admin-token` request header matches ADMIN_TOKEN.
 *                   This is the production / shared-link path.
 *   3. session  , a logged-in Google account whose email/@handle is in
 *                   the allowlist (web/lib/admin.ts isAdminIdentity).
 *
 * In production with ADMIN_TOKEN set, only (2) and (3) pass, there is no
 * open access.
 */

export const ADMIN_COOKIE = "talise_admin";

/** The configured admin token, or null when unset/blank. */
export function adminToken(): string | null {
  const t = process.env.ADMIN_TOKEN?.trim();
  return t && t.length > 0 ? t : null;
}

/**
 * Local-dev escape hatch: open ONLY on a developer's own machine.
 *
 * Hard requirement: NOT on any Vercel deployment. Vercel sets `VERCEL=1` on
 * production AND preview/staging, so this guarantees the admin board + raw-DB
 * browser can never be reachable without auth on a deployed environment, even
 * a preview build that forgot to set ADMIN_TOKEN. Locally (`pnpm dev`, no
 * VERCEL) it stays open, still flagged by the unauthenticated banner.
 */
export function isDevOpen(): boolean {
  if (process.env.VERCEL) return false;
  return process.env.NODE_ENV !== "production" && adminToken() === null;
}

/** Length-guarded constant-time compare against the configured token. */
export function tokenMatches(candidate: string | null | undefined): boolean {
  const expected = adminToken();
  if (!expected || !candidate) return false;
  if (candidate.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export type AdminVia = "dev" | "token" | "session";
export type AdminCtx = {
  via: AdminVia;
  email?: string;
  handle?: string;
};

/** Logged-in Google session whose identity is allowlisted. */
async function sessionAdmin(): Promise<AdminCtx | null> {
  const id = await readSessionEntryId();
  if (id == null) return null;
  const u = await userById(id).catch(() => null);
  if (u && isAdminIdentity(u.email, u.talise_username)) {
    return { via: "session", email: u.email, handle: u.talise_username ?? undefined };
  }
  return null;
}

/**
 * Resolve the admin context from cookies + session. Use in server
 * components / pages and as the cookie+session fallback for API routes.
 */
export async function resolveAdmin(): Promise<AdminCtx | null> {
  if (isDevOpen()) return { via: "dev" };
  const jar = await cookies();
  if (tokenMatches(jar.get(ADMIN_COOKIE)?.value)) return { via: "token" };
  return await sessionAdmin();
}

/**
 * Resolve the admin context for an API route. Also honours an
 * `x-admin-token` header (programmatic / curl access), then falls back
 * to the cookie + session checks.
 */
export async function resolveAdminFromRequest(req: Request): Promise<AdminCtx | null> {
  if (isDevOpen()) return { via: "dev" };
  if (tokenMatches(req.headers.get("x-admin-token"))) return { via: "token" };
  return await resolveAdmin();
}

/**
 * Guard for API route handlers. Returns a 401 Response when the caller
 * is not an admin, or `null` when access is granted, so a route reads:
 *
 *   const denied = await requireAdminApi(req);
 *   if (denied) return denied;
 */
export async function requireAdminApi(req: Request): Promise<Response | null> {
  const ctx = await resolveAdminFromRequest(req);
  if (!ctx) {
    return new Response(
      JSON.stringify({ error: "admin auth required" }),
      { status: 401, headers: { "content-type": "application/json" } }
    );
  }
  return null;
}
