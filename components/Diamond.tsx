/**
 * Talise brand mark. Path data inlined from public/symbol.svg so the
 * fill can reference the live --color-accent CSS var (the source SVG
 * ships with fill="black"). Shared between the landing TopBar and the
 * waitlist header so both wordmarks render identically.
 */
export function Diamond() {
  return (
    <svg width="24" height="22" viewBox="0 0 583 533" aria-hidden>
      <path
        d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z"
        fill="#15300c"
      />
    </svg>
  );
}
