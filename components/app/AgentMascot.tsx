"use client";

/**
 * Talise Agent mascot (web), the friendly blocky assistant, mirroring the
 * iOS `AgentMascot`: a mint "brick" head with spherical shading (top-left
 * specular highlight, bottom volume shadow, a rim light), two deep-ink eyes,
 * and a small smile. Crisp at any size (pure SVG).
 *
 * Used as the top-bar Copilot entry point on both desktop and mobile, tapping
 * it opens /app/agent. Body colour defaults to the "Classic" skin (#CAFFB8);
 * pass `tint` to recolour it.
 */
export function AgentMascot({ size = 36, tint = "#CAFFB8" }: { size?: number; tint?: string }) {
  const deep = "#15300c"; // face features
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <defs>
        {/* spherical highlight, light source at top-left */}
        <radialGradient id="am-hi" cx="32%" cy="26%" r="62%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        {/* volume shading toward the bottom */}
        <linearGradient id="am-vol" x1="0" y1="0.4" x2="0" y2="1">
          <stop offset="0%" stopColor="#000000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.2" />
        </linearGradient>
        {/* rim light, bright top edge easing to a soft bottom */}
        <linearGradient id="am-rim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.04" />
        </linearGradient>
      </defs>

      {/* 3D head, a soft squircle */}
      <rect x="9" y="11" width="82" height="78" rx="32" fill={tint} />
      <rect x="9" y="11" width="82" height="78" rx="32" fill="url(#am-hi)" />
      <rect x="9" y="11" width="82" height="78" rx="32" fill="url(#am-vol)" />
      <rect
        x="9.75"
        y="11.75"
        width="80.5"
        height="76.5"
        rx="31.25"
        stroke="url(#am-rim)"
        strokeWidth="1.5"
      />

      {/* eyes */}
      <ellipse cx="38" cy="47" rx="5" ry="6.5" fill={deep} />
      <ellipse cx="62" cy="47" rx="5" ry="6.5" fill={deep} />
      {/* catchlights */}
      <circle cx="36.4" cy="44.6" r="1.5" fill="#ffffff" fillOpacity="0.85" />
      <circle cx="60.4" cy="44.6" r="1.5" fill="#ffffff" fillOpacity="0.85" />

      {/* smile */}
      <path
        d="M39 62 Q50 71 61 62"
        stroke={deep}
        strokeWidth="4.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
