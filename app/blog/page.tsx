import Link from "next/link";

export const dynamic = "force-dynamic";

type Post = {
  slug: string;
  title: string;
  excerpt: string;
  date: string;
  readTime: string;
  tag: string;
  // Image cover for the featured card. Posts without one render a branded
  // gradient panel (so we never ship a placeholder screenshot).
  cover?: string;
};

// Single source of truth for the index. Newest first (first item is featured).
const POSTS: Post[] = [
  {
    slug: "copilot-walrus-memory",
    title: "Copilot + Walrus memory",
    excerpt:
      "Talise Copilot now remembers across chats. It keeps the facts that matter, encrypted and stored on Walrus, Sui's decentralized storage, and private to you alone.",
    date: "July 2, 2026",
    readTime: "7 min read",
    tag: "Engineering",
  },
  {
    slug: "talise-copilot",
    title: "Meet Talise Copilot",
    excerpt:
      "Copilot is the assistant built into Talise. Tell it what you want in plain words, send money, check your balance, move into yield, and it does the work.",
    date: "July 2, 2026",
    readTime: "6 min read",
    tag: "Product",
  },
  {
    slug: "introducing-talise",
    title: "Introducing Talise",
    excerpt:
      "A dollar wallet that feels like a messaging app. Hold real dollars, send them to a name, and cash out at home. No gas, no seed phrase, no bank.",
    date: "June 22, 2026",
    readTime: "5 min read",
    tag: "Announcement",
    cover: "/blog/move-freely.png",
  },
];

export default function BlogIndex() {
  const [featured, ...rest] = POSTS;
  return (
    <main className="px-6 pb-16 pt-14 md:px-10 md:pt-16">
      {/* page heading */}
      <div className="max-w-[640px]">
        <span className="bp-kicker">The Talise blog</span>
        <h1 className="mt-5 text-[clamp(34px,6vw,58px)] leading-[1.0] text-[var(--color-fg)]">
          Notes from the build
        </h1>
        <p className="mt-4 max-w-[480px] font-mono text-[13px] leading-[1.7] text-[var(--color-fg-muted)]">
          Product, design, and the story of making money move like a message.
        </p>
      </div>

      {/* featured post */}
      {featured && (
        <Link
          href={`/blog/${featured.slug}`}
          className="bp-card group mt-12 block overflow-hidden transition-transform hover:-translate-y-1 md:grid md:grid-cols-[1.1fr_1fr]"
        >
          <div className="relative aspect-[16/10] overflow-hidden border-b border-[var(--color-line)] md:aspect-auto md:h-full md:border-b-0 md:border-r">
            {featured.cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={featured.cover}
                alt={featured.title}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
              />
            ) : (
              <div className="flex h-full min-h-[220px] w-full flex-col justify-between bg-[#0a0e0b] p-8 md:p-10">
                <svg width="28" height="28" viewBox="0 0 583 533" aria-hidden>
                  <path
                    d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z"
                    fill="#CAFFB8"
                  />
                </svg>
                <div className="text-[clamp(24px,4vw,38px)] leading-[1.0] tracking-[-0.03em] text-[#f2f4f2] transition-transform duration-500 group-hover:translate-x-1">
                  {featured.title}
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-col justify-center gap-4 p-7 md:p-10">
            <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-dim)]">
              <span className="bg-[var(--color-accent-light)] px-2.5 py-1 text-[#1c3d12]">{featured.tag}</span>
              <span>{featured.date}</span>
            </div>
            <h2 className="text-[clamp(26px,3.4vw,38px)] leading-[1.05] text-[var(--color-fg)]">
              {featured.title}
            </h2>
            <p className="font-mono text-[13px] leading-[1.7] text-[var(--color-fg-muted)]">
              {featured.excerpt}
            </p>
            <span className="mt-1 inline-flex items-center gap-1.5 font-mono text-[12px] uppercase tracking-[0.08em] text-[var(--color-accent)]">
              Read the post
              <span className="transition-transform group-hover:translate-x-0.5" aria-hidden>→</span>
            </span>
          </div>
        </Link>
      )}

      {/* more posts grid */}
      {rest.length > 0 && (
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          {rest.map((p) => (
            <Link
              key={p.slug}
              href={`/blog/${p.slug}`}
              className="bp-card group block p-6 transition-transform hover:-translate-y-1"
            >
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-dim)]">
                <span className="bg-[var(--color-accent-light)] px-2 py-0.5 text-[#1c3d12]">{p.tag}</span>
                <span>· {p.date}</span>
              </div>
              <h3 className="mt-4 text-[22px] leading-[1.15] text-[var(--color-fg)]">{p.title}</h3>
              <p className="mt-2 font-mono text-[13px] leading-[1.55] text-[var(--color-fg-muted)]">{p.excerpt}</p>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
