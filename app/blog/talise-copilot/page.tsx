import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-dynamic";

const TESTFLIGHT_URL = "https://testflight.apple.com/join/BFNEPYtM";

export const metadata: Metadata = {
  title: "Meet Talise Copilot: money you can talk to",
  description:
    "Copilot is the assistant built into Talise. Ask it in plain words to send money, check your balance, or move into yield, and it does the work for you.",
  openGraph: {
    title: "Meet Talise Copilot",
    description:
      "Copilot is the assistant built into Talise. Ask in plain words to send money, check your balance, or earn.",
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

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[18px] border border-[#15300c]/10 bg-white/55 p-5 backdrop-blur-sm sm:p-6">
      <h3 className="text-[17px] font-[600] text-[#15300c] sm:text-[18px]" style={{ fontFamily: DISPLAY }}>
        {title}
      </h3>
      <p className="mt-2 text-[13.5px] leading-[1.65] text-[#3a5230]" style={{ fontFamily: MONO }}>
        {children}
      </p>
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

export default function TaliseCopilot() {
  return (
    <main className="mx-auto max-w-[760px] px-6 pb-10 pt-12 md:px-10 md:pt-16">
      {/* tag + title */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[#3d7a29]">
        <span className="bg-[var(--color-accent-light)] px-2.5 py-1 text-[#1c3d12]">Product</span>
        <span>July 2, 2026</span>
        <span>·</span>
        <span>6 min read</span>
      </div>

      <h1
        className="mt-6 text-[clamp(38px,7.5vw,72px)] font-[700] uppercase leading-[0.92] tracking-[-0.02em] text-[#15300c]"
        style={{ fontFamily: "var(--font-display-v2)" }}
      >
        Meet Talise Copilot
      </h1>
      <Lead>
        Copilot is the assistant built into Talise. Tell it what you want in plain words, send fifty
        dollars to a friend, check what you have, move idle cash into yield, and it does the work.
        No forms, no menus, no jargon.
      </Lead>

      {/* mock conversation as the hero */}
      <figure className="mt-9 overflow-hidden rounded-[28px] border border-[#15300c]/10 bg-gradient-to-br from-[#e6f9d6] via-[#f7fcf2] to-[#ffeede] p-6 sm:p-9">
        <div className="mx-auto flex max-w-[440px] flex-col gap-3">
          <Bubble from="you">Send 50 dollars to ada</Bubble>
          <Bubble from="copilot">
            Sending $50.00 to ada@talise.sui. That is about the price of a nice dinner. Confirm to
            send, it settles in under a second and the fee is on us.
          </Bubble>
          <Bubble from="you">How much do I have left after that?</Bubble>
          <Bubble from="copilot">
            You would have $312.40 in dollars. Want me to move some of it into yield so it earns
            while it sits?
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
        Most finance apps hand you a grid of buttons and hope you can find the one you need. Copilot
        takes the opposite bet. You already know how to describe what you want, you do it in every
        chat you send all day. So Talise lets you describe money the same way, and a capable
        assistant turns the sentence into the transaction.
      </P>

      <Quote>You should not have to learn an app to move your own money. You should just be able to ask.</Quote>

      <H2>What Copilot can do</H2>
      <P>
        Copilot is not a chatbot bolted onto a wallet. It is wired into the same engine that powers
        the rest of Talise, so it works with your real balance and can act, not just answer.
      </P>
      <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Feature title="Send by asking">
          &quot;Send 20 to mum&quot; becomes a ready-to-confirm payment to a name you know. You
          review the amount and send. It settles in under a second, gas sponsored.
        </Feature>
        <Feature title="Answers grounded in your account">
          It knows your dollar balance, your recent activity, and where you can earn, so its answers
          are about your money, not a generic explanation of how wallets work.
        </Feature>
        <Feature title="Talks in your currency">
          Say &quot;send 5000 naira&quot; and it converts at the live rate you see in the app, so the
          person on the other side gets what you meant.
        </Feature>
        <Feature title="Guides you into yield">
          Ask where your idle dollars could earn and it compares the venues, then sets it up if you
          say yes. Nothing moves without your confirmation.
        </Feature>
        <Feature title="Explains before it acts">
          Every action is previewed in plain language first. You always see the amount and the
          recipient before anything happens.
        </Feature>
        <Feature title="Payment links on request">
          Ask for a link to collect money and it drafts one you can share. The other person pays
          without needing an account first.
        </Feature>
      </div>

      <H2>Built to be trusted with money</H2>
      <P>
        An assistant that can move funds has to earn a different level of trust than one that writes
        emails. We built Copilot with that bar in mind.
      </P>
      <P>
        It <HL>never sends without your confirmation.</HL> Copilot proposes, you approve. It shows
        the exact amount and recipient every time, so there is no ambiguity about what a tap will do.
        It runs on the same non-custodial rails as the rest of Talise, which means even the assistant
        cannot spend on your behalf. The keys stay yours through zkLogin.
      </P>
      <P>
        And because Talise is gasless, Copilot never has to stop you mid-sentence to buy a gas token
        or top up a fee balance. You ask, you confirm, it is done.
      </P>

      <H2>Fast, because slow is not an assistant</H2>
      <P>
        A copilot that makes you wait is just another form to fill out. Talise hydrates your live
        context, balance, recent activity, yield venues, up front, so Copilot answers with real
        numbers immediately instead of pausing to look things up one field at a time. The reply
        starts streaming as it thinks, and a send finalizes in under a second.
      </P>

      <H2>This is the start</H2>
      <P>
        Copilot is live in the Talise app today. It can send, explain your balance, walk you into
        yield, and draft payment links, all from plain language. And it is about to get much more
        personal. In the next post we get into how Copilot remembers, using Walrus, so the assistant
        that helps you today actually knows you tomorrow.
      </P>

      {/* CTA */}
      <div className="mt-12 rounded-[28px] border border-[#15300c]/10 bg-[#15300c] p-8 text-center md:p-10">
        <h2
          className="text-[clamp(24px,4vw,36px)] font-[700] uppercase leading-[1.0] tracking-[-0.01em] text-[#f7fcf2]"
          style={{ fontFamily: "var(--font-display-v2)" }}
        >
          Talk to your money
        </h2>
        <p
          className="mx-auto mt-3 max-w-[420px] text-[14px] leading-[1.6] text-[#cfe8bf]"
          style={{ fontFamily: MONO }}
        >
          Copilot is built into Talise. Get the app and just ask.
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
          href="/blog"
          className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-[#15300c]"
        >
          <span aria-hidden>←</span> Back to the blog
        </Link>
        <Link
          href="/blog/copilot-walrus-memory"
          className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-[#15300c]"
        >
          Copilot + Walrus memory <span aria-hidden>→</span>
        </Link>
      </div>
    </main>
  );
}
