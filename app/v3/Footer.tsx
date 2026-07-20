import Reveal from "./Reveal";
import { BracketButton, Ticks } from "./ui";

const COLS: { title: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  { title: "Product", links: [
    { label: "Why Talise", href: "#why" },
    { label: "Features", href: "#features" },
    { label: "Global", href: "#global" },
    { label: "Get iOS App", href: "https://testflight.apple.com/join/BFNEPYtM", external: true },
  ] },
  { title: "Company", links: [
    { label: "Blog", href: "/blog" },
    { label: "Web app", href: "https://app.talise.io", external: true },
    { label: "Contact", href: "mailto:hello@talise.io" },
  ] },
  { title: "Legal", links: [
    { label: "Privacy", href: "/privacy" },
    { label: "Terms", href: "/terms" },
    { label: "Support", href: "/support" },
  ] },
];

export default function Footer() {
  return (
    <footer className="v3-frame relative border-t border-[var(--v3-line)]">
      <Ticks />

      {/* closing CTA */}
      <Reveal className="px-5 py-20 text-center sm:px-8">
        <h2 className="mx-auto max-w-[18ch] text-[clamp(28px,4.2vw,50px)] leading-[1.04] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>
          Money that moves as freely as messages
        </h2>
        <p className="mx-auto mt-5 max-w-[46ch] text-[16px] leading-[1.55] text-[var(--v3-muted)]">
          Hold dollars. Send to a name. Cash out home. Free of gas, free of seed
          phrases, now on TestFlight.
        </p>
        <div className="mt-8 flex justify-center">
          <BracketButton href="https://testflight.apple.com/join/BFNEPYtM" external>
            Get iOS App
          </BracketButton>
        </div>
      </Reveal>

      {/* accent bar */}
      <div className="h-2 w-full bg-[var(--v3-accent)]" />
      <div className="v3-hatch h-12" />

      {/* footer table */}
      <div className="grid grid-cols-1 gap-px border-y border-[var(--v3-line)] bg-[var(--v3-line)] md:grid-cols-[1.5fr_1fr_1fr_1fr]">
        {/* brand cell */}
        <div className="bg-[var(--v3-canvas)] p-7">
          <div className="flex items-center gap-2.5">
            <svg width="22" height="22" viewBox="0 0 583 533" aria-hidden>
              <path d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z" fill="#121a0f" />
            </svg>
            <span className="text-[17px] font-[500] tracking-[-0.02em] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>talise</span>
          </div>
          <p className="mt-4 max-w-[36ch] text-[12px] leading-[1.65] text-[var(--v3-muted)]" style={{ fontFamily: "var(--font-mono), monospace" }}>
            A gasless dollar wallet on Sui. Hold, send and cash out, money that
            moves like a message.
          </p>
          <a href="https://x.com/taliseio" target="_blank" rel="noreferrer noopener" aria-label="Talise on X" className="mt-6 inline-grid h-9 w-9 place-items-center border border-[var(--v3-line)] bg-[var(--v3-white)] text-[var(--v3-ink)] transition-colors hover:bg-[var(--v3-accent)] hover:text-[#f4fbef]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
          </a>
        </div>

        {COLS.map((col) => (
          <div key={col.title} className="flex flex-col bg-[var(--v3-canvas)]">
            <div className="border-b border-[var(--v3-line)] bg-[var(--v3-panel)] px-6 py-3.5 text-[11px] uppercase tracking-[0.14em] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-mono), monospace" }}>
              {col.title}
            </div>
            {col.links.map((l) => (
              <a
                key={l.label}
                href={l.href}
                {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="border-b border-[var(--v3-line)] px-6 py-3.5 text-[14px] text-[var(--v3-muted)] transition-colors last:border-b-0 hover:bg-[var(--v3-panel)] hover:text-[var(--v3-ink)]"
              >
                {l.label}
              </a>
            ))}
          </div>
        ))}
      </div>

      {/* copyright */}
      <div className="flex flex-col items-center justify-between gap-2 px-5 py-6 sm:flex-row sm:px-8" style={{ fontFamily: "var(--font-mono), monospace" }}>
        <span className="text-[11.5px] uppercase tracking-[0.1em] text-[var(--v3-dim)]">© 2026 Talise. All rights reserved.</span>
        <span className="text-[11.5px] uppercase tracking-[0.14em] text-[var(--v3-accent)]">talise.io · Built on Sui</span>
      </div>
    </footer>
  );
}
