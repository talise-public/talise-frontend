"use client";

import { useEffect, useState } from "react";

const LINKS = [
  { label: "Why", href: "#why" },
  { label: "Features", href: "#features" },
  { label: "Global", href: "#global" },
  { label: "Blog", href: "/blog" },
  { label: "FAQ", href: "#faq" },
];

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className="sticky top-0 z-50 border-b transition-colors duration-300"
      style={{
        borderColor: "var(--v3-line)",
        background: scrolled ? "rgba(236,239,232,0.88)" : "transparent",
        backdropFilter: scrolled ? "blur(10px)" : undefined,
        WebkitBackdropFilter: scrolled ? "blur(10px)" : undefined,
      }}
    >
      <div className="v3-frame flex items-center justify-between px-5 py-3.5 sm:px-8">
        {/* brand */}
        <a href="#top" className="flex items-center gap-2.5" aria-label="Talise, home">
          <svg width="22" height="22" viewBox="0 0 583 533" aria-hidden>
            <path
              d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z"
              fill="#121a0f"
            />
          </svg>
          <span className="text-[17px] font-[500] tracking-[-0.02em] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>
            talise
          </span>
        </a>

        {/* center links */}
        <nav aria-label="Primary" className="hidden items-center gap-7 md:flex">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="text-[14px] font-[500] text-[var(--v3-muted)] transition-colors hover:text-[var(--v3-ink)]">
              {l.label}
            </a>
          ))}
        </nav>

        {/* CTA */}
        <a
          href="https://app.talise.io"
          className="relative inline-flex h-9 items-center justify-center bg-[var(--v3-accent)] px-4 text-[12px] uppercase tracking-[0.06em] text-[#f4fbef] transition-transform hover:-translate-y-0.5"
          style={{ fontFamily: "var(--font-mono), monospace" }}
        >
          <span aria-hidden className="v3-bracket" />
          <span aria-hidden className="v3-bracket-2" />
          Web App
        </a>
      </div>
    </header>
  );
}
