# Talise landing v2 — STYLE SPEC (read before building any section)

Inspiration: Wero (wero-wallet) — **bold, playful, type-driven, friendly fintech**.
Adapted to **Talise's mint/forest brand** + a few complementary pops. Light, warm,
confident. NOT dark, NOT renaissance. Build every section to this spec so the page
reads as one piece.

## Voice
Confident, warm, a little playful ("going global, finally"). Short punchy lines.
Obeys the hard copy rules: no "free" except "stablecoin transactions on Sui cost
nothing"; no APY numbers; handles as `name@talise`; sends land "in under a
second" (Sui finalizes that fast), never "in seconds"; "private" ok, "anonymous" not.

## Type
- **Display (headlines, the big stuff): `Bricolage Grotesque`, weight 800** — heavy,
  characterful grotesque. Tight tracking (-0.02 to -0.04em), line-height ~0.95–1.0.
  Headlines are BIG (clamp up to ~96px) and can be ALL-CAPS or sentence case.
- **Body / UI: `DM Sans`** (300–600). **Micro-labels / amounts / handles: `JetBrains Mono`.**
- One word per headline gets the **highlighter** treatment (see below).

## Color (brand-led + complementary)
Tokens (use these exact hexes):
- Ink (text): `#15300c`   · Forest: `#3d7a29`   · Mint (bright): `#CAFFB8`
- Cream (base): `#f7fcf2`  · Soft mint: `#d8f5c6`
- Complementary pops (cards/accents, use sparingly): Coral `#FF9E7A` · Lilac `#C9B8FF` · Butter `#FFE59E`
- **Page background**: a soft warm gradient, mint-led:
  `radial-gradient(120% 90% at 15% 0%, #e6f9d6 0%, #f7fcf2 45%, #ffeede 100%)`.
- Text is ink `#15300c` on the light bg. Cards may invert (mint/forest fills with ink or cream text).

## Signature components
1. **Highlighter** — a key phrase sits in a rounded mint `#CAFFB8` block (like a marker
   swipe), slight rotation (-1.5°), ink text. e.g. `<span class="hl">under a second</span>`.
2. **Bento cards** — generously rounded (`rounded-[28px]`), each a different gradient
   (mint, coral, lilac, butter) with a **hard offset shadow** (`box-shadow: 10px 10px 0 #15300c`
   or a softer `0 18px 0 -4px`), a bold card headline, and a playful 3D-ish illustration.
   Slight tilt (±2°). This is the layout workhorse (features, "how it works", FAQ).
3. **Pill nav** — a floating rounded-full bar, bottom-center, cream/white with a subtle
   border + soft shadow; links in DM Sans medium. Circular icon buttons flank it.
4. **Circular buttons** — `rounded-full`, ink or mint fill, for FAQ / social / arrows.
5. **3D illustrations** — playful isometric gradient objects (coin, globe, padlock, phone)
   with hard shadows. (Source later: a 3D/illustration pass — placeholder geometric/SVG
   accents are fine for v1.)
6. **Giant wordmark footer** — `talise.` set HUGE in Bricolage 800, ink, as the closing beat.

## Motion (GSAP + Lenis — already installed)
- Smooth scroll (Lenis). Headlines **clip-reveal** word-by-word on load/scroll.
- Bento cards **pop in** with a slight scale + the hard shadow settling (back.out ease).
- Highlighter **swipes in** (scaleX 0→1 from left) after its line lands.
- Gentle float on 3D illustrations. Respect `prefers-reduced-motion`.

## Page flow (v2)
1. Hero — giant headline + highlighter + pill nav + a hero card/illustration.
2. "What it means" — bento grid of the core features (hold / send / earn / cash out).
3. Cross-border — the globe / pay-the-world beat.
4. Trust/Why-Sui — a card row (instant · costs nothing · gas sponsored).
5. FAQ — bento cards.
6. Final CTA + giant `talise.` wordmark + footer.

## Hard rules
- Brand-led: mint/forest dominate; coral/lilac/butter are *accents*, never the whole page.
- One highlighter + a tasteful number of pops per viewport — playful, not chaotic.
- Keep it CLEAN: lots of breathing room despite the bold type.
- Build at `/v2` — do NOT touch the production landing (`app/page.tsx`) until approved.
