/**
 * TaliseProfileCard, a premium, screenshot-worthy "membership card" for a
 * waitlist member, centered on their Talise name (@handle). Deliberately DARK
 * (forest→black with a mint glow + the brand diamond) so it pops against the
 * light-mint waitlist page and reads like a metal card when posted to X/IG.
 *
 * Presentational + server-safe (no hooks), reused by the post-claim dashboard
 * and the public /u/[handle] page. The matching social-preview image is
 * rendered separately by app/u/[handle]/opengraph-image.tsx.
 */
export function TaliseProfileCard({
  handle,
  position,
  referralCount,
  fill = false,
}: {
  handle: string;
  position?: number | null;
  referralCount?: number | null;
  /** When true, fill the parent's height (h-full) instead of holding a fixed
   *  card aspect, lets the dashboard stretch it to match the actions column.
   *  The card's internal justify-between spreads the content over the taller
   *  height cleanly (no image to distort). Defaults to the fixed-aspect card
   *  used standalone on /u/[handle]. */
  fill?: boolean;
}) {
  return (
    <div
      className={`relative w-full min-w-0 max-w-full overflow-hidden rounded-[22px] text-white shadow-[0_24px_60px_-20px_rgba(20,48,12,0.55)] ${
        fill
          ? "min-h-[176px] lg:h-full lg:min-h-[230px]"
          : "aspect-[1.586/1]"
      }`}
      style={{
        background:
          "radial-gradient(120% 90% at 85% -10%, #4b8a37 0%, #1c3d24 38%, #0a140c 72%, #060a07 100%)",
      }}
    >
      {/* fine mint hairline frame */}
      <div className="pointer-events-none absolute inset-0 rounded-[22px] ring-1 ring-inset ring-[#caffb8]/15" />
      {/* soft mint bloom, top-right */}
      <div
        className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full opacity-50 blur-2xl"
        style={{ background: "#caffb8" }}
      />

      <div className="relative flex h-full flex-col justify-between gap-4 p-5 sm:p-7">
        {/* top row, brand mark + waitlist tag */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <svg width="22" height="20" viewBox="0 0 583 533" aria-hidden>
              <path
                d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z"
                fill="#caffb8"
              />
            </svg>
            <span className="text-[13px] font-semibold tracking-tight text-white">
              talise
            </span>
          </div>
          <span className="rounded-full bg-[#caffb8]/12 px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-[#caffb8]">
            Waitlist
          </span>
        </div>

        {/* the name, the hero of the card */}
        <div className="min-w-0">
          <div className="truncate text-[26px] font-semibold leading-none tracking-tight text-white sm:text-[34px]">
            @{handle}
          </div>
          <div className="mt-1.5 truncate font-mono text-[11px] tracking-tight text-[#caffb8]/80 sm:text-[12px]">
            {handle}@talise.sui
          </div>
        </div>

        {/* bottom row, position + referrals. Labels shrink + tighten on
            small screens so the two columns always fit a narrow card. */}
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-white/45 sm:text-[9px] sm:tracking-[0.18em]">
              Position
            </div>
            <div className="mt-0.5 text-[17px] font-semibold leading-none tracking-tight text-white sm:text-[20px]">
              {typeof position === "number" && position > 0 ? `#${position.toLocaleString()}` : "-"}
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-white/45 sm:text-[9px] sm:tracking-[0.18em]">
              Referrals
            </div>
            <div className="mt-0.5 text-[17px] font-semibold leading-none tracking-tight text-[#caffb8] sm:text-[20px]">
              {Number(referralCount ?? 0).toLocaleString()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
