import Image from "next/image";

export const dynamic = "force-dynamic";

/**
 * Internal preview of 5 social-share (OG, 1200x630) card designs in the v2
 * brand. Not linked anywhere; used to screenshot candidates. The chosen design
 * gets promoted to app/opengraph-image.tsx (next/og ImageResponse).
 */
const DISPLAY = { fontFamily: "var(--font-display-v2)" } as const;
const MINT_BG = "radial-gradient(120% 90% at 12% -5%, #e6f9d6 0%, #f7fcf2 46%, #ffeede 100%)";

function Mark({ size = 40, fill = "#15300c" }: { size?: number; fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 583 533" aria-hidden>
      <path d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z" fill={fill} />
    </svg>
  );
}

function Frame({ id, children, bg }: { id: string; children: React.ReactNode; bg: string }) {
  return (
    <div id={id} className="relative h-[630px] w-[1200px] overflow-hidden" style={{ background: bg, color: "#15300c" }}>
      {children}
    </div>
  );
}

/* 1 — Highlighter headline, the signature look */
function Og1() {
  return (
    <Frame id="og1" bg={MINT_BG}>
      <div className="flex h-full flex-col justify-between p-[72px]">
        <div className="flex items-center gap-3">
          <Mark size={38} />
          <span className="text-[30px] font-[600] tracking-[-0.01em]" style={DISPLAY}>talise</span>
        </div>
        <div>
          <div className="mb-6 font-mono text-[18px] uppercase tracking-[0.3em] text-[#3d7a29]">Dollars, on Sui</div>
          <h1 className="text-[92px] font-[800] uppercase leading-[0.92] tracking-[-0.02em]" style={DISPLAY}>
            Money that moves<br />
            like a{" "}
            <span className="relative inline-block">
              <span className="absolute inset-x-[-12px] inset-y-[10px] -z-0 -rotate-[1.5deg] rounded-[16px] bg-[#CAFFB8]" />
              <span className="relative z-10">message.</span>
            </span>
          </h1>
        </div>
        <div className="font-mono text-[17px] tracking-[0.08em] text-[#3a5230]">talise.io · hold, send, cash out</div>
      </div>
      <Image src="/v2/coin.png" alt="" width={300} height={300} className="absolute -right-6 top-10 h-[280px] w-[280px] rotate-6 object-contain drop-shadow-[0_20px_30px_rgba(21,48,12,0.25)]" />
    </Frame>
  );
}

/* 2 — Product card showcase */
function Og2() {
  return (
    <Frame id="og2" bg={MINT_BG}>
      <div className="grid h-full grid-cols-[1.05fr_1fr] items-center gap-10 px-[72px]">
        <div>
          <div className="mb-5 inline-flex items-center gap-3">
            <Mark size={34} />
            <span className="text-[26px] font-[600] tracking-[-0.01em]" style={DISPLAY}>talise</span>
          </div>
          <h1 className="text-[68px] font-[800] uppercase leading-[0.94] tracking-[-0.02em]" style={DISPLAY}>
            Hold dollars.<br />
            Send to a{" "}
            <span className="relative inline-block">
              <span className="absolute inset-x-[-10px] inset-y-[8px] -z-0 -rotate-[1.5deg] rounded-[14px] bg-[#CAFFB8]" />
              <span className="relative z-10">name.</span>
            </span>
          </h1>
          <p className="mt-6 max-w-[440px] text-[22px] leading-[1.4] text-[#3a5230]">No seed phrase, no gas. It lands in under a second.</p>
        </div>
        <div className="relative mx-auto w-[420px] -rotate-2 rounded-[32px] bg-gradient-to-br from-[#3d7a29] to-[#1c4513] p-9 text-[#f7fcf2]" style={{ boxShadow: "16px 16px 0 #15300c" }}>
          <div className="font-mono text-[13px] uppercase tracking-[0.2em] text-[#CAFFB8]">Your balance</div>
          <div className="mt-2 text-[52px] font-[800] leading-none" style={DISPLAY}>$1,240.00</div>
          <div className="mt-1 font-mono text-[14px] text-[#cfe9c2]">1,240.00 USDsui</div>
          <div className="mt-7 rounded-2xl bg-[#0e2a08]/60 p-5">
            <div className="font-mono text-[12px] text-[#9fc78c]">SEND TO</div>
            <div className="mt-1 text-[24px] font-semibold">sele@talise</div>
            <div className="mt-4 flex items-center justify-between">
              <span className="font-mono text-[13px] text-[#cfe9c2]">under a second</span>
              <span className="rounded-full bg-[#CAFFB8] px-5 py-2 text-[15px] font-bold text-[#15300c]">Send →</span>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}

/* 3 — Forest premium (dark) */
function Og3() {
  return (
    <Frame id="og3" bg="radial-gradient(120% 120% at 18% 0%, #3d7a29 0%, #1c4513 45%, #0e2a08 100%)">
      <div className="flex h-full flex-col justify-between p-[72px] text-[#f7fcf2]">
        <div className="flex items-center gap-3">
          <Mark size={38} fill="#CAFFB8" />
          <span className="text-[30px] font-[600] tracking-[-0.01em] text-[#f7fcf2]" style={DISPLAY}>talise</span>
        </div>
        <div>
          <div className="mb-6 font-mono text-[18px] uppercase tracking-[0.3em] text-[#9fdc86]">Dollars, on Sui</div>
          <h1 className="text-[88px] font-[800] uppercase leading-[0.92] tracking-[-0.02em]" style={DISPLAY}>
            Money that moves<br />
            like a{" "}
            <span className="relative inline-block">
              <span className="absolute inset-x-[-12px] inset-y-[10px] -z-0 -rotate-[1.5deg] rounded-[16px] bg-[#CAFFB8]" />
              <span className="relative z-10 text-[#15300c]">message.</span>
            </span>
          </h1>
        </div>
        <div className="font-mono text-[17px] tracking-[0.08em] text-[#cfe9c2]">talise.io · hold, send, cash out</div>
      </div>
      <Image src="/v2/coin.png" alt="" width={300} height={300} className="absolute -right-4 top-12 h-[280px] w-[280px] rotate-6 object-contain drop-shadow-[0_24px_40px_rgba(0,0,0,0.4)]" />
    </Frame>
  );
}

/* 4 — Bento trio, playful-premium */
function Og4() {
  const tiles = [
    { bg: "#CAFFB8", img: "/v2/coin.png", t: "Hold", tilt: "-3deg" },
    { bg: "#FF9E7A", img: "/v2/plane.png", t: "Send", tilt: "2.5deg" },
    { bg: "#C9B8FF", img: "/v2/globe.png", t: "Global", tilt: "-2deg" },
  ];
  return (
    <Frame id="og4" bg={MINT_BG}>
      <div className="flex h-full flex-col justify-between p-[64px]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Mark size={34} />
            <span className="text-[26px] font-[600] tracking-[-0.01em]" style={DISPLAY}>talise</span>
          </div>
          <div className="font-mono text-[15px] uppercase tracking-[0.26em] text-[#3d7a29]">Dollars, on Sui</div>
        </div>
        <h1 className="max-w-[760px] text-[60px] font-[800] uppercase leading-[0.96] tracking-[-0.02em]" style={DISPLAY}>
          Everything money{" "}
          <span className="relative inline-block">
            <span className="absolute inset-x-[-10px] inset-y-[8px] -z-0 -rotate-[1.2deg] rounded-[14px] bg-[#CAFFB8]" />
            <span className="relative z-10">should already do.</span>
          </span>
        </h1>
        <div className="grid grid-cols-3 gap-6">
          {tiles.map((t) => (
            <div key={t.t} className="relative h-[150px] rounded-[26px] p-6" style={{ background: t.bg, boxShadow: "10px 10px 0 #15300c", transform: `rotate(${t.tilt})` }}>
              <div className="text-[22px] font-[800] text-[#15300c]" style={DISPLAY}>{t.t}</div>
              <Image src={t.img} alt="" width={120} height={120} className="absolute bottom-3 right-3 h-[96px] w-[96px] object-contain" />
            </div>
          ))}
        </div>
      </div>
    </Frame>
  );
}

/* 5 — Editorial minimal */
function Og5() {
  return (
    <Frame id="og5" bg="radial-gradient(110% 120% at 90% 10%, #ffeede 0%, #f7fcf2 50%, #eafad9 100%)">
      <div className="flex h-full flex-col justify-between p-[80px]">
        <div className="flex items-center gap-3">
          <Mark size={36} />
          <span className="text-[28px] font-[600] tracking-[-0.01em]" style={DISPLAY}>talise</span>
        </div>
        <div>
          <div className="mb-7 font-mono text-[19px] uppercase tracking-[0.34em] text-[#3d7a29]">A dollar wallet on Sui</div>
          <h1 className="text-[104px] font-[800] uppercase leading-[0.88] tracking-[-0.03em]" style={DISPLAY}>
            Money,<br />
            that{" "}
            <span className="relative inline-block">
              <span className="absolute inset-x-[-12px] inset-y-[10px] -z-0 -rotate-[2deg] rounded-[16px] bg-[#CAFFB8]" />
              <span className="relative z-10">moves.</span>
            </span>
          </h1>
        </div>
        <div className="font-mono text-[16px] tracking-[0.1em] text-[#3a5230]">Hold · Send · Cash out · talise.io</div>
      </div>
      <Image src="/v2/coin.png" alt="" width={200} height={200} className="absolute right-[80px] top-[150px] h-[190px] w-[190px] -rotate-6 object-contain drop-shadow-[0_18px_28px_rgba(21,48,12,0.2)]" />
    </Frame>
  );
}

export default function OgPreview() {
  return (
    <div className="flex flex-col items-start gap-10 p-10">
      <Og1 /><Og2 /><Og3 /><Og4 /><Og5 />
    </div>
  );
}
