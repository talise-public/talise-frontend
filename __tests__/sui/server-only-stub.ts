/**
 * Vitest stub for Next.js' `server-only` marker package. Aliased in
 * `vitest.integration.config.ts` so server-bound modules (which import
 * `"server-only"` to guard against accidental client bundling) can be
 * exercised by integration tests without bundling Next.
 *
 * The real `server-only` package has no runtime API; it just causes a
 * build-time error if pulled into a client component. We mirror that:
 * exporting nothing means consumers' `import "server-only"` succeeds
 * but contributes no symbols.
 */
export {};
