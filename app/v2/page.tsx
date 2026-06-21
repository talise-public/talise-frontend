import HeroV2 from "./HeroV2";
import FeaturesBento from "./FeaturesBento";
import CrossBorder from "./CrossBorder";
import WhySui from "./WhySui";
import Faq from "./Faq";
import { HowItWorks, MoreWays, Earn, Trust, AppShowcase } from "./MoreSections";

export const dynamic = "force-dynamic";

/**
 * Talise landing, v2 PREVIEW (Wero-inspired, brand-mint). Lives at /v2 so the
 * production landing (app/page.tsx) stays untouched until this is approved.
 * Style spec: app/v2/STYLE-SPEC.md.
 */
export default function LandingV2() {
  return (
    <main className="relative">
      {/* top brand mark */}
      <div className="mx-auto flex max-w-[1500px] items-center justify-between px-6 pt-7 md:px-12">
        <div className="flex items-center gap-2.5">
          <svg width="26" height="26" viewBox="0 0 583 533" aria-hidden>
            <path d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z" fill="#15300c" />
          </svg>
          <span className="text-[19px] font-[600] tracking-[-0.01em]" style={{ fontFamily: "var(--font-display-v2)" }}>talise</span>
        </div>
        <a href="/waitlist" className="rounded-full border border-[#15300c]/20 px-5 py-2 text-[13px] font-semibold text-[#15300c] transition-colors hover:bg-[#15300c] hover:text-[#f7fcf2]">
          Join waitlist
        </a>
      </div>

      <HeroV2 />
      <div id="start" className="scroll-mt-8"><HowItWorks /></div>
      <div id="features" className="scroll-mt-8"><FeaturesBento /></div>
      <div id="app" className="scroll-mt-8"><AppShowcase /></div>
      <div id="ways" className="scroll-mt-8"><MoreWays /></div>
      <div id="how" className="scroll-mt-8"><CrossBorder /></div>
      <div id="earn" className="scroll-mt-8"><Earn /></div>
      <div id="why" className="scroll-mt-8"><WhySui /></div>
      <div id="trust" className="scroll-mt-8"><Trust /></div>
      <div id="faq" className="scroll-mt-8"><Faq /></div>

      {/* closing CTA + giant wordmark */}
      <section className="px-6 pb-10 text-center md:px-10">
        <div className="mx-auto max-w-[760px]">
          <h2 className="text-[clamp(26px,5.4vw,56px)] font-[800] uppercase leading-[1.0] tracking-[-0.02em]" style={{ fontFamily: "var(--font-display-v2)" }}>
            Money that makes sense.
          </h2>
          <p className="mx-auto mt-4 max-w-[440px] text-[16px] text-[#3a5230]">
            Hold dollars. Send to a name. Cash out home. Now on TestFlight.
          </p>
          <a
            href="https://testflight.apple.com/join/BFNEPYtM"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-7 inline-flex h-12 items-center gap-2 rounded-full bg-[#15300c] px-8 text-[15px] font-semibold text-[#f7fcf2] transition-transform hover:-translate-y-0.5"
          >
            Get the app ↗
          </a>
        </div>
        <div
          className="pointer-events-none mt-16 select-none text-center text-[clamp(80px,22vw,320px)] font-[800] leading-[0.8] tracking-[-0.04em] text-[#15300c]"
          style={{ fontFamily: "var(--font-display-v2)" }}
          aria-hidden
        >
          talise.
        </div>
        <div className="flex flex-col items-center gap-4 pb-32 pt-6">
          <a
            href="https://x.com/taliseio"
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Talise on X"
            className="grid h-10 w-10 place-items-center rounded-full border border-[#15300c]/20 text-[#15300c] transition-colors hover:bg-[#15300c] hover:text-[#f7fcf2]"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#3d7a29]">
            talise.io · Built on Sui
          </div>
        </div>
      </section>
    </main>
  );
}
