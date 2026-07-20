import { Hanken_Grotesk, DM_Sans } from "next/font/google";
import { readSessionEntryId } from "@/lib/session";
import { userById, isAppAccessAllowed } from "@/lib/db";
import { readBalanceSnapshot } from "@/lib/snapshots";
import { AppShell } from "@/components/app/AppShell";
import SmoothScroll from "@/components/SmoothScroll";
import type { Me, Balances } from "@/components/app/data";

export const dynamic = "force-dynamic";

// Same type system as the v2 landing so the app feels like one product.
// Load the lighter weights too, this is the TWK Everett *fallback*, and the
// blueprint headings render at regular (400)/medium (500). Without 400/500 the
// browser substituted 700, making every heading read bold ("thick Everett").
const display = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display-v2",
  display: "swap",
});
const sans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-sans-v2",
  display: "swap",
});

/**
 * /app shell + ACCESS GATE (private beta, open sign-in).
 *
 *   • Not signed in           → AppShell renders its Continue-with-Google
 *                               screen. Anyone may sign in.
 *   • Signed in, NOT allowed  → the waiting-room screen below. Access is
 *                               granted per-email via the app_allowlist table
 *                               (admin API /api/admin/app-access) or the
 *                               APP_ALLOWED_EMAILS env bootstrap.
 *   • Signed in + allowed     → the app.
 *
 * The PUBLIC surfaces (/c claim, /i invoice, /pay links, /u profiles) are
 * intentionally NOT gated, they're how non-members receive money.
 */
/**
 * Wraps every /app surface in the v2 landing type system + warm mint
 * background, so the app reads as one product with the marketing site.
 */
function V2Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={`app-clean ${display.variable} ${sans.variable} relative min-h-screen overflow-x-hidden`}
      style={{
        // Leading/primary text runs in TWK Everett (Hanken fallback); only the
        // sub-elements (eyebrows, labels, meta, amounts) opt into mono via their
        // own font-mono classes. Mirrors the landing's Everett-leading voice.
        fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif',
        color: "#121a0f",
        background: "#edf0ea",
      }}
    >
      <SmoothScroll />
      {children}
    </div>
  );
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let me: Me | null = null;
  let initialBalances: Balances | null = null;

  const id = await readSessionEntryId();
  if (id != null) {
    const u = await userById(id).catch(() => null);
    if (u) {
      // ── The gate ────────────────────────────────────────────────────
      if (!(await isAppAccessAllowed(u.email))) {
        return (
          <V2Shell>
            <WaitingRoom email={u.email} name={u.name} />
          </V2Shell>
        );
      }
      me = {
        id: String(u.id),
        email: u.email,
        name: u.name,
        picture: u.picture,
        country: u.country,
        suiAddress: u.sui_address,
        taliseHandle: u.talise_username,
        accountType: u.account_type ?? "personal",
      };
      // Seed the balance from the display snapshot so the dashboard paints the
      // real number on first byte, no client round-trip, no skeleton flash.
      // (Display-only; the client still revalidates fresh against chain.)
      const snap = await readBalanceSnapshot(id).catch(() => null);
      if (snap) {
        initialBalances = {
          address: snap.suiAddress,
          usdsui: snap.usdsui,
          sui: snap.sui,
          suiPriceUsd: snap.suiPriceUsd,
          totalUsd: snap.totalUsd,
          refreshedAt: snap.refreshedAt,
          stale: true,
        };
      }
    }
  }

  return (
    <V2Shell>
      <AppShell me={me} initialBalances={initialBalances}>
        {children}
      </AppShell>
    </V2Shell>
  );
}

/**
 * Signed-in-but-not-yet-allowed screen. Calm, on-brand, honest: account
 * created, spot held, access opens in waves.
 */
function WaitingRoom({ email, name }: { email: string; name: string | null }) {
  const first = (name ?? "").split(/\s+/)[0] || null;
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6">
      <div
        className="w-full max-w-sm rounded-[16px] border border-[rgba(18,26,15,0.12)] bg-white p-8 text-center"
        style={{ boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 20px 44px -24px rgba(18,26,15,0.28)" }}
      >
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-[#CAFFB8]">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="9" stroke="#121a0f" strokeWidth="1.8" />
            <path d="M12 7.5V12l3 2" stroke="#121a0f" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>
        <h1
          className="mt-5 text-[26px] leading-[1.05] tracking-[-0.05em] text-[#121a0f]"
          style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
        >
          {first ? `You're in line, ${first}` : "You're in line"}
        </h1>
        <p className="mx-auto mt-3 max-w-[17rem] text-[14px] leading-relaxed text-[#3a5230]">
          Talise is opening in waves. Your account is created and your spot is
          held, we&rsquo;ll email <span className="font-semibold text-[#15300c]">{email}</span>{" "}
          the moment your access unlocks.
        </p>
        <a
          href="https://www.talise.io/waitlist"
          className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-[#15300c] px-5 py-3 text-[14px] font-semibold text-[#f7fcf2] transition-transform hover:-translate-y-0.5 active:scale-[0.98]"
        >
          Claim your @handle while you wait
        </a>
        <a
          href="/auth/logout"
          className="mt-3 inline-block text-[12.5px] text-[#3d7a29] underline-offset-2 hover:underline"
        >
          Sign out
        </a>
      </div>
      <p className="mt-6 text-center font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
        Invite-only beta · by Talise
      </p>
    </div>
  );
}
