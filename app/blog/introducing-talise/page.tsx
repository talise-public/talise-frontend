import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-dynamic";

const TESTFLIGHT_URL = "https://testflight.apple.com/join/BFNEPYtM";

export const metadata: Metadata = {
  title: "Introducing Talise: money that moves like a message",
  description:
    "A dollar wallet that feels like a messaging app. Hold real dollars, send them to a name, and cash out at home. No gas, no seed phrase, no bank in the middle.",
  openGraph: {
    title: "Introducing Talise",
    description:
      "A dollar wallet that feels like a messaging app. Hold real dollars, send them to a name, cash out at home.",
    type: "article",
    images: [{ url: "/blog/move-freely.png", width: 1200, height: 630 }],
  },
};

/* ---------- prose primitives, in the Talise brand ----------
   Display headings stay Hanken; all running text is JetBrains Mono
   (var(--font-mono)) for the technical, on-brand feel. */

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

export default function IntroducingTalise() {
  return (
    <main className="mx-auto max-w-[760px] px-6 pb-10 pt-12 md:px-10 md:pt-16">
      {/* tag + title */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[#3d7a29]">
        <span className="bg-[var(--color-accent-light)] px-2.5 py-1 text-[#1c3d12]">Announcement</span>
        <span>June 22, 2026</span>
        <span>·</span>
        <span>8 min read</span>
      </div>

      <h1
        className="mt-6 text-[clamp(38px,7.5vw,72px)] font-[700] uppercase leading-[0.92] tracking-[-0.02em] text-[#15300c]"
        style={{ fontFamily: "var(--font-display-v2)" }}
      >
        Introducing Talise
      </h1>
      <Lead>
        A dollar wallet that feels like a messaging app. Hold real dollars, send them to a name,
        and cash out at home. No gas, no seed phrase, no bank in the middle.
      </Lead>

      {/* hero image */}
      <figure className="mt-9 overflow-hidden rounded-[28px] border border-[#15300c]/10">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/blog/move-freely.png"
          alt="Money that moves freely, like messages."
          className="w-full"
        />
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
        Sending money should be the easiest thing in the world. You can send a photo to someone on
        the other side of the planet in under a second, and it costs you nothing. Try to send that
        same person ten dollars and the whole experience falls apart. You fill out a wire form, copy
        a routing number, wait three business days, pay a fee that takes a real bite out of the
        amount, and then hope a bank somewhere decides your transfer is allowed at all.
      </P>
      <P>
        For the billions of people who live and work across a border from the family they support,
        that friction is not a minor annoyance. It is the most stressful part of their financial
        month, every single month. Talise exists to remove it.
      </P>

      <Quote>Money should move as freely as the messages we send all day. So we built a wallet where it does.</Quote>

      <H2>What Talise is</H2>
      <P>
        Talise is a <HL>gasless dollar wallet</HL> built on Sui. You hold real, dollar-backed
        stablecoins, so your balance is worth what it says it is worth. You send those dollars to a
        name instead of a long string of characters. The person on the other side receives them in
        under a second, and when they want local money, they can cash out to a bank account.
      </P>
      <P>
        There is no seed phrase to write down and lose. There are no gas tokens to buy before you can
        move. There is nothing that quietly assumes you already understand blockchains. You sign in
        the way you sign in to everything else, and you are holding dollars. That is the entire
        setup.
      </P>

      <H2>How it works</H2>
      <div className="mt-6 border-b border-[#15300c]/10">
        <Step n={1} title="Sign in with Google or Apple">
          Your account is secured by zkLogin. Your existing login provider proves you are you, and
          the keys that move your money are derived so that only you control them. Nobody at Talise
          can spend on your behalf.
        </Step>
        <Step n={2} title="Hold real dollars">
          Your balance is a dollar-backed stablecoin, not a token that swings in value overnight.
          What you see is what it is worth. If you want, it can earn yield while it sits, and you can
          withdraw it whenever you like.
        </Step>
        <Step n={3} title="Send to a name">
          Every account gets a readable name like <span className="font-mono text-[14px]">name@talise.sui</span>.
          Pick a contact, enter an amount, confirm. The payment settles on-chain in under a second,
          and the network fee is sponsored, so you never fund a separate gas balance just to send.
        </Step>
        <Step n={4} title="Cash out at home">
          When the person receiving needs spendable local money, they cash out to a bank account. The
          dollars convert to their home currency without anyone touching an exchange or a crypto
          off-ramp by hand.
        </Step>
      </div>

      <H2>The details that make it usable</H2>
      <P>
        A wallet you would actually trust with rent money has to do more than move tokens around.
        These are the pieces we spent the most time getting right.
      </P>
      <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Feature title="Gasless, every single time">
          Every transaction is sponsored by Talise. You never hold a separate gas token, and you
          never get stuck halfway through a send because you are a few cents short of a fee.
        </Feature>
        <Feature title="A name, not an address">
          Readable names mean no copy-paste mistakes and no irreversible sends to the wrong 42
          characters. You pay a person, not a hash.
        </Feature>
        <Feature title="Privacy, when you choose it">
          Privacy is an option you switch on, not something we decide for you. When a payment is
          nobody else&apos;s business, you can hide the amount on-chain with a real zero-knowledge
          proof. The rest of the time you send normally.
        </Feature>
        <Feature title="Earn on idle dollars">
          If you opt in, your balance can earn yield through established, non-custodial lending on
          Sui. It stays in your name, it stays withdrawable, and nothing moves without your say.
        </Feature>
        <Feature title="Instant and final">
          Payments settle in under a second and they are final. No pending state, no waiting to learn
          whether it cleared, no chargeback reversing it a week later.
        </Feature>
        <Feature title="Built to keep growing">
          Claimable payment links and money that streams over time are already built, with more
          cash-out corridors and merchant payments on the way.
        </Feature>
      </div>

      <H2>A straight word on privacy</H2>
      <P>
        We want to be precise about this, because it is the kind of thing that is easy to
        over-promise. <strong>Talise is not private by default.</strong> By default, a payment is a
        normal on-chain transaction. What Talise adds is a private option: when you turn it on, the
        transfer goes through a shielded pool and the amount is hidden on-chain behind a
        zero-knowledge proof. That shielded pool is live on mainnet today.
      </P>
      <P>
        We think that is the honest version of privacy for a payments app. You should be able to keep
        a salary or a sensitive transfer to yourself, and you should also be able to send an
        ordinary, visible payment when that is simpler and cheaper. Talise gives you the switch and
        lets you decide, one transaction at a time. We would rather tell you exactly where the line
        is than sell you a promise we do not keep.
      </P>

      <H2>Why we built it on Sui</H2>
      <P>
        The experience we were after, sub-second, sub-cent, sponsored, and composable, is genuinely
        hard to deliver on most chains. Sui&apos;s parallel execution gives us the speed and the
        throughput. Its object model lets us sponsor gas cleanly so the user never sees it. And
        programmable transaction blocks let us bundle several steps, like swapping into dollars and
        sending them, into a single confirmation.
      </P>
      <P>
        The result is that the chain disappears. You are not bridging, approving, or topping up gas.
        You are just sending money. The best infrastructure is the kind you never have to think
        about, and Sui is what let us hide ours.
      </P>

      <H2>Non-custodial by design</H2>
      <P>
        Your money is yours. zkLogin means the signing keys are controlled by you through your login,
        not sitting in a Talise database we could lose or be compelled to hand over. Your yield
        positions stay in your name. Your privacy proofs are generated for you, on your device. We
        built Talise so that the worst possible day at Talise still cannot move your funds.
      </P>

      <H2>This is just the beginning</H2>
      <P>
        Talise is live on TestFlight today. Holding dollars, sending by name, the private option,
        earning, and cashing out are all in your hands right now. Next we are widening the set of
        countries you can cash out into, shipping claimable links and streamed payments to everyone,
        and bringing the same one-tap simplicity to merchants who want to get paid.
      </P>
      <P>
        The goal has not changed since the first sketch: make a dollar cross the world as easily as a
        message crosses it. We are closer to that than we have ever been, and we would love for you
        to try it and tell us where it still falls short.
      </P>

      {/* CTA */}
      <div className="mt-12 rounded-[28px] border border-[#15300c]/10 bg-[#15300c] p-8 text-center md:p-10">
        <h2
          className="text-[clamp(24px,4vw,36px)] font-[700] uppercase leading-[1.0] tracking-[-0.01em] text-[#f7fcf2]"
          style={{ fontFamily: "var(--font-display-v2)" }}
        >
          Try Talise
        </h2>
        <p
          className="mx-auto mt-3 max-w-[420px] text-[14px] leading-[1.6] text-[#cfe8bf]"
          style={{ fontFamily: MONO }}
        >
          Hold dollars. Send to a name. Cash out home. Now on TestFlight.
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

      <div className="mt-10">
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-[#15300c]"
        >
          <span aria-hidden>←</span> Back to the blog
        </Link>
      </div>
    </main>
  );
}
