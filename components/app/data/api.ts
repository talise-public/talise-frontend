/**
 * Same-origin JSON client for the Talise beta app.
 *
 * The browser is authenticated by the httpOnly `talise_session` cookie, so
 * every request runs with `credentials: "include"` and we NEVER attach an
 * Authorization bearer. Errors are normalized into `ApiError` carrying the
 * HTTP status and the server's machine `code` (e.g. LIMIT_EXCEEDED,
 * SCREENING_BLOCK, BELOW_GASLESS_MINIMUM) so pages can render friendly
 * inline messages.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export type ApiOptions = {
  method?: string;
  body?: unknown;
  query?: Record<string, unknown>;
  /** Append `?fresh=1` to bypass the read-snapshot caches (use right after a tx). */
  fresh?: boolean;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

function buildUrl(path: string, query?: Record<string, unknown>, fresh?: boolean): string {
  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
  }
  if (fresh) qs.set("fresh", "1");
  const s = qs.toString();
  return s ? `${path}${path.includes("?") ? "&" : "?"}${s}` : path;
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { method = "GET", body, query, fresh, signal, headers } = opts;
  const init: RequestInit = {
    method,
    credentials: "include",
    signal,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query, fresh), init);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Network error — check your connection.", "NETWORK");
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const obj = (data ?? {}) as { error?: string; code?: string; message?: string; reason?: string };
    const code = obj.code ?? null;
    const message =
      obj.error ?? obj.message ?? obj.reason ?? `Request failed (HTTP ${res.status})`;
    throw new ApiError(res.status, message, code);
  }

  return data as T;
}
