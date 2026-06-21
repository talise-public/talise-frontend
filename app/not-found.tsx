import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Page not found · Talise",
};

const TESTFLIGHT_URL = "https://testflight.apple.com/join/BFNEPYtM";
const DISPLAY = { fontFamily: "var(--font-display-v2)" } as const;

/**
 * Global 404, styled to match the public Talise frontend (mint and forest, the
 * brand glyph, the display type). Points to the iOS beta and back home.
 */
export default function NotFound() {
  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center px-6 text-center"
      style={{ backgroundColor: "#ecf8e0", color: "#15300c" }}
    >
      <div className="flex items-center gap-2.5">
        <svg width="34" height="34" viewBox="0 0 583 533" aria-hidden>
          <path
            d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z"
            fill="#15300c"
          />
        </svg>
        <span className="text-[22px] font-[600] tracking-[-0.01em]" style={DISPLAY}>
          talise
        </span>
      </div>

      <h1
        className="mt-10 text-[clamp(64px,16vw,128px)] font-[800] leading-[0.9] tracking-[-0.03em]"
        style={DISPLAY}
      >
        404
      </h1>
      <p className="mt-4 text-[20px] font-[600] tracking-[-0.01em]" style={DISPLAY}>
        This page is not here.
      </p>
      <p className="mt-2 max-w-[420px] text-[15px] leading-[1.55] text-[#3a5230]">
        It may have moved, or it never existed. Talise lives in the app now.
      </p>

      <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
        <a
          href={TESTFLIGHT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-[52px] items-center gap-2 rounded-full bg-[#15300c] px-7 text-[15px] font-semibold text-[#f7fcf2] transition-transform hover:-translate-y-0.5"
        >
          Get the app <span aria-hidden>↗</span>
        </a>
        <a
          href="https://talise.io"
          className="inline-flex h-[52px] items-center rounded-full border-2 border-[#15300c] px-7 text-[15px] font-semibold text-[#15300c] transition-colors hover:bg-[#15300c] hover:text-[#f7fcf2]"
        >
          Back to home
        </a>
      </div>
    </main>
  );
}
