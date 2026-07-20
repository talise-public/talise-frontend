import Image from "next/image";
import Reveal from "./Reveal";
import { Counter, Kicker, Ticks } from "./ui";

const POSTS = [
  {
    href: "/blog/introducing-talise",
    img: "/v3/move-freely.png",
    date: "2026",
    tag: "Product",
    title: "Introducing Talise",
    desc: "Why we're building money that moves like a message, gasless dollars anyone can send.",
  },
  {
    href: "/blog/talise-copilot",
    img: "/v3/move-freely.png",
    date: "2026",
    tag: "AI",
    title: "Meet the Talise Copilot",
    desc: "An assistant that moves money for you in plain language, send, save and swap by asking.",
  },
  {
    href: "/blog/copilot-walrus-memory",
    img: "/v3/move-freely.png",
    date: "2026",
    tag: "Engineering",
    title: "Private memory with Walrus",
    desc: "How the Copilot remembers what matters to you, without us being able to read it.",
  },
];

export default function Insights() {
  return (
    <section id="blog" className="v3-frame relative scroll-mt-20 border-t border-[var(--v3-line)] px-5 pt-20 sm:px-8">
      <Ticks />
      <Reveal className="flex flex-col items-center text-center">
        <Kicker>Insights & updates</Kicker>
        <h2 className="mt-7 max-w-[16ch] text-[clamp(25px,3.3vw,40px)] leading-[1.08] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>
          From the Talise blog
        </h2>
        <p className="mt-5 max-w-[52ch] text-[16px] leading-[1.55] text-[var(--v3-muted)]">
          Clear, practical writing on money, on Sui, and on building a wallet
          that feels like nothing at all.
        </p>
      </Reveal>

      <Reveal className="relative mt-16 grid grid-cols-1 border-y border-[var(--v3-line)] md:grid-cols-3">
        <Ticks />
        {[33.333, 66.666].map((p) => (
          <span key={`t${p}`} aria-hidden className="v3-tick hidden md:block" style={{ left: `${p}%`, top: 0, transform: "translate(-50%,-50%)" }} />
        ))}
        {POSTS.map((post, i) => (
          <a
            key={post.href}
            href={post.href}
            className={`group flex flex-col p-5 transition-colors hover:bg-[var(--v3-panel)] sm:p-6 ${i > 0 ? "border-t border-[var(--v3-line)] md:border-l md:border-t-0" : ""}`}
          >
            <div className="relative aspect-[16/10] overflow-hidden rounded-lg border border-[var(--v3-line)]">
              <Image src={post.img} alt="" fill sizes="(max-width:768px) 100vw, 33vw" className="object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
            </div>
            <div className="mt-5 flex items-center gap-3">
              <span className="text-[11px] uppercase tracking-[0.1em] text-[var(--v3-dim)]" style={{ fontFamily: "var(--font-mono), monospace" }}>{post.date}</span>
              <span className="bg-[var(--v3-accent-2)] px-2 py-0.5 text-[10.5px] uppercase tracking-[0.1em] text-[#1c3d12]" style={{ fontFamily: "var(--font-mono), monospace" }}>{post.tag}</span>
            </div>
            <h3 className="mt-3 text-[18.5px] leading-[1.2] text-[var(--v3-ink)]" style={{ fontFamily: "var(--font-display-v3)" }}>{post.title}</h3>
            <p className="mt-2.5 text-[14px] leading-[1.5] text-[var(--v3-muted)]">{post.desc}</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-[12px] uppercase tracking-[0.08em] text-[var(--v3-accent)]" style={{ fontFamily: "var(--font-mono), monospace" }}>
              Read <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
            </span>
          </a>
        ))}
      </Reveal>

      <div className="v3-hatch h-16" />
      <div className="pb-8"><Counter n="08" label="Insights" /></div>
    </section>
  );
}
