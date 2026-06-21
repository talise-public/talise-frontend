/**
 * Server-boot warmup (Next.js instrumentation hook — runs once per process).
 *
 * The /infra dashboard showed the dominant latency is COLD-START: the first
 * request to hit the server pays the gRPC channel open + the epoch/chain-id
 * cache miss + the Onara worker connection. That cost lands on a real user's
 * first Send/Home-load. Here we pay it once, at boot, off the hot path —
 * priming the warm singleton `sui()` channel and the `memoTtl` caches so the
 * FIRST user action is already warm. Best-effort + non-blocking: a warmup
 * failure (e.g. an upstream blip at boot) never blocks startup; the real call
 * will just take the cold path that one time.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { getCurrentEpoch, getChainIdentifier } = await import("./lib/sui-epoch");
    // NOTE: do NOT import ./lib/db here — instrumentation is also bundled for
    // the Edge runtime (the app has middleware), and the `postgres` driver needs
    // node `net`/`tls`. The DB schema builds (memoized) on the first request.
    const tasks: Promise<unknown>[] = [
      getCurrentEpoch().catch(() => {}), // opens the gRPC channel + caches epoch
      getChainIdentifier().catch(() => {}), // caches the immutable chain id
    ];
    if (process.env.ONARA_URL) {
      const { onara } = await import("./lib/onara");
      tasks.push(
        (async () => {
          try {
            await onara().status(); // warms the sponsor worker connection
          } catch {
            /* best-effort */
          }
        })()
      );
    }
    await Promise.allSettled(tasks);
  } catch {
    /* warmup is best-effort; never block boot */
  }
}
