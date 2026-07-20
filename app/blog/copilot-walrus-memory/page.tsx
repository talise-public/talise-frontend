import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-dynamic";

const TESTFLIGHT_URL = "https://testflight.apple.com/join/BFNEPYtM";

export const metadata: Metadata = {
  title: "Copilot that remembers: Talise memory on Walrus",
  description:
    "Talise Copilot now has real memory. It keeps the facts that matter across chats, encrypted and stored on Walrus, Sui's decentralized storage, and private to you alone.",
  openGraph: {
    title: "Copilot + Walrus memory",
    description:
      "Talise Copilot now remembers across chats. Encrypted, stored on Walrus, private to you.",
    type: "article",
  },
};

const MONO = "var(--font-mono), ui-monospace, SFMono-Regular, monospace";
const DISPLAY = '"TWK Everett", var(--font-display-v2), system-ui, sans-serif';

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="mt-12 text-[clamp(23px,5.6vw,32px)] font-[700] leading-[1.12] tracking-[-0.01em] text-[#15300c] sm:mt-14"
      style={{ fontFamily: DISPLAY }}
    >
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="mt-5 text-[14.5px] leading-[1.85] text-[#2c4a1f] sm:text-[15.5px]"
      style={{ fontFamily: MONO }}
    >
      {children}
    </p>
  );
}

function Lead({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="mt-3 text-[clamp(16px,4vw,19px)] leading-[1.6] text-[#15300c]"
      style={{ fontFamily: MONO }}
    >
      {children}
    </p>
  );
}

function HL({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative inline-block">
      <span className="absolute inset-x-[-3px] inset-y-[2px] -z-0 -rotate-[1deg] rounded-[6px] bg-[#CAFFB8]" />
      <span className="relative z-10">{children}</span>
    </span>
  );
}

function Bubble({ from, children }: { from: "you" | "copilot"; children: React.ReactNode }) {
  const isYou = from === "you";
  return (
    <div className={`flex ${isYou ? "justify-end" : "justify-start"}`}>
      <div
        className={
          isYou
            ? "max-w-[80%] rounded-[18px] rounded-br-[6px] bg-[#15300c] px-4 py-2.5 text-[13.5px] leading-[1.5] text-[#f7fcf2]"
            : "max-w-[80%] rounded-[18px] rounded-bl-[6px] border border-[#15300c]/10 bg-white/70 px-4 py-2.5 text-[13.5px] leading-[1.5] text-[#2c4a1f]"
        }
        style={{ fontFamily: MONO }}
      >
        {children}
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 border-t border-[#15300c]/10 py-6 sm:gap-6">
      <div
        className="flex-none pt-[3px] text-[13px] font-[500] tracking-[0.12em] text-[#3d7a29]"
        style={{ fontFamily: MONO }}
      >
        {String(n).padStart(2, "0")}
      </div>
      <div className="min-w-0">
        <h3 className="text-[18px] font-[600] text-[#15300c] sm:text-[19px]" style={{ fontFamily: DISPLAY }}>
          {title}
        </h3>
        <p className="mt-2 text-[14px] leading-[1.7] text-[#3a5230]" style={{ fontFamily: MONO }}>
          {children}
        </p>
      </div>
    </div>
  );
}

function Quote({ children }: { children: React.ReactNode }) {
  return (
    <blockquote
      className="mt-10 border-l-[3px] border-[#3d7a29] pl-5 text-[clamp(19px,4.6vw,26px)] font-[300] leading-[1.4] text-[#15300c] sm:pl-6"
      style={{ fontFamily: DISPLAY }}
    >
      {children}
    </blockquote>
  );
}

export default function CopilotWalrusMemory() {
  return (
    <main className="mx-auto max-w-[760px] px-6 pb-10 pt-12 md:px-10 md:pt-16">
      {/* tag + title */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[#3d7a29]">
        <span className="bg-[var(--color-accent-light)] px-2.5 py-1 text-[#1c3d12]">Engineering</span>
        <span>July 2, 2026</span>
        <span>·</span>
        <span>7 min read</span>
      </div>

      <h1
        className="mt-6 text-[clamp(36px,7vw,68px)] font-[700] uppercase leading-[0.92] tracking-[-0.02em] text-[#15300c]"
        style={{ fontFamily: "var(--font-display-v2)" }}
      >
        Copilot + Walrus memory
      </h1>
      <Lead>
        A copilot that forgets you the moment you close the chat is just a search box. So we gave
        Talise real memory, it keeps the facts that matter across conversations, encrypted and stored
        on Walrus, and private to you alone.
      </Lead>

      {/* mock conversation as the hero */}
      <figure className="mt-9 overflow-hidden rounded-[28px] border border-[#15300c]/10 bg-gradient-to-br from-[#e6f9d6] via-[#f7fcf2] to-[#ffeede] p-6 sm:p-9">
        <div className="mx-auto flex max-w-[440px] flex-col gap-3">
          <div
            className="text-center text-[10px] uppercase tracking-[0.2em] text-[#3d7a29]"
            style={{ fontFamily: MONO }}
          >
            Last week
          </div>
          <Bubble from="you">I send money to my sister ada every month for rent</Bubble>
          <Bubble from="copilot">Got it. I will remember that.</Bubble>
          <div
            className="mt-2 text-center text-[10px] uppercase tracking-[0.2em] text-[#3d7a29]"
            style={{ fontFamily: MONO }}
          >
            A new chat, today
          </div>
          <Bubble from="you">Time to sort out this month</Bubble>
          <Bubble from="copilot">
            Rent for ada? I can set up the usual transfer to ada@talise.sui. Same amount as last
            month?
          </Bubble>
        </div>
      </figure>

      {/* byline */}
      <div className="mt-6 flex items-center gap-3 border-b border-[#15300c]/10 pb-8">
        <div className="grid h-10 w-10 place-items-center rounded-full bg-[#15300c]">
          <svg width="18" height="18" viewBox="0 0 583 533" aria-hidden>
            <path
              d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z"
              fill="#f7fcf2"
            />
          </svg>
        </div>
        <div className="text-[12.5px] leading-snug" style={{ fontFamily: MONO }}>
          <div className="font-[500] text-[#15300c]">The Talise Team</div>
          <div className="text-[#3a5230]">Building money that moves like a message</div>
        </div>
      </div>

      {/* ---------- body ---------- */}

      <P>
        In our last post we introduced Copilot, the assistant built into Talise. It was already
        useful, but it had one honest limitation, it started every chat as a stranger. Close the
        conversation, open a new one, and it had no idea who you were or what you had told it. That is
        the difference between a tool and an assistant, and we wanted Copilot to be the second kind.
      </P>

      <Quote>An assistant that forgets you between chats is not really helping. It is starting over.</Quote>

      <H2>What memory changes</H2>
      <P>
        With memory, Copilot holds onto the things worth holding onto. Who you send to and why. The
        currency you think in. That you prefer to keep certain payments private. The name your sister
        goes by. It keeps the facts that matter, not every word of every chat, so the next time you
        open Talise it already knows the shape of your money life instead of asking you to explain it
        again.
      </P>
      <P>
        The result feels less like typing into a box and more like talking to someone who was there
        last time. You say &quot;the usual&quot; and it knows what the usual is.
      </P>

      <H2>Why we built it on Walrus</H2>
      <P>
        Here is the part we care about most. Your memory does not live in a Talise database. It lives
        on <HL>Walrus</HL>, the decentralized storage network built for the Sui ecosystem. That is a
        deliberate choice, and it changes what your memory actually is.
      </P>
      <P>
        A company database is a single place a company owns. It can be mined, sold, subpoenaed, or
        breached, and you are trusting one operator to do the right thing forever. Walrus is
        different, it is decentralized storage, so your memories are not sitting in one company&apos;s
        vault waiting to become a product. Before anything is written, it is <strong>encrypted.</strong>{" "}
        What lands on Walrus is a private blob that is meaningless without your key.
      </P>

      <H2>How it works, step by step</H2>
      <div className="mt-6 border-b border-[#15300c]/10">
        <Step n={1} title="You talk, Copilot listens">
          As you chat, Copilot notices the durable facts, the recurring recipient, the preferred
          currency, the standing habit, and separates them from the throwaway chatter that does not
          need keeping.
        </Step>
        <Step n={2} title="It gets encrypted, then stored on Walrus">
          Each memory is encrypted and written to Walrus as a private blob. It is filed under a
          namespace that belongs only to your wallet, so one person&apos;s memories can never bleed
          into another&apos;s.
        </Step>
        <Step n={3} title="Next time, it recalls what is relevant">
          When you start a new chat, Copilot pulls back the memories that relate to what you are
          asking, and only those, then uses them to answer as if the last conversation never ended.
        </Step>
        <Step n={4} title="It stays yours">
          The memory is keyed to you and encrypted for you. It is not a dataset we browse or train
          on. It is the assistant&apos;s private notebook about your money, and the notebook is
          yours.
        </Step>
      </div>

      <H2>Private to you, by design</H2>
      <P>
        We want to be precise here, the same way we are about payment privacy. Memory is scoped per
        wallet and encrypted before it leaves the app, so a memory saved for you is recalled only for
        you. It is not shared across users, and it is not a public record on a chain for anyone to
        read. It is the difference between an assistant that quietly remembers your preferences and a
        platform that turns them into an advertising profile. We chose the first, and Walrus is how we
        keep that promise technically, not just as a policy line.
      </P>
      <P>
        And if you would rather it forget, deleting a chat clears it from your history, while the
        durable facts Copilot has learned stay safely stored, so your assistant does not get amnesia
        every time you tidy up. Memory is a feature you benefit from, not a trap you cannot escape.
      </P>

      <H2>Why this matters for money</H2>
      <P>
        Memory is table stakes for a good assistant, but for a money assistant it is the difference
        between a novelty and something you rely on. The whole promise of Copilot is that you can
        just ask. Memory is what makes asking short. You do not re-explain who your sister is, what
        currency you use, or how you like to send. You say the thing, and the assistant fills in
        everything it already knows.
      </P>

      <Quote>Money that moves like a message. Now with memory, integrated on Walrus.</Quote>

      <P>
        Copilot with Walrus memory is live in Talise today. The more you use it, the better it knows
        you, and all of it stays encrypted, decentralized, and yours.
      </P>

      {/* CTA */}
      <div className="mt-12 rounded-[28px] border border-[#15300c]/10 bg-[#15300c] p-8 text-center md:p-10">
        <h2
          className="text-[clamp(24px,4vw,36px)] font-[700] uppercase leading-[1.0] tracking-[-0.01em] text-[#f7fcf2]"
          style={{ fontFamily: "var(--font-display-v2)" }}
        >
          An assistant that knows you
        </h2>
        <p
          className="mx-auto mt-3 max-w-[420px] text-[14px] leading-[1.6] text-[#cfe8bf]"
          style={{ fontFamily: MONO }}
        >
          Copilot remembers what matters, encrypted on Walrus. Get the app and start.
        </p>
        <a
          href={TESTFLIGHT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-flex h-12 items-center gap-2 rounded-full bg-[#CAFFB8] px-8 text-[15px] font-semibold text-[#15300c] transition-transform hover:-translate-y-0.5"
        >
          Get the app ↗
        </a>
      </div>

      <div className="mt-10 flex flex-wrap items-center justify-between gap-4">
        <Link
          href="/blog/talise-copilot"
          className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-[#15300c]"
        >
          <span aria-hidden>←</span> Meet Talise Copilot
        </Link>
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-[#15300c]"
        >
          Back to the blog <span aria-hidden>→</span>
        </Link>
      </div>
    </main>
  );
}
