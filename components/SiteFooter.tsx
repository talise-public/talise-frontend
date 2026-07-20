export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--color-line)] bg-[var(--color-surface)]/20">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-14 md:grid-cols-2 md:px-8">
        <div>
          <div className="font-display text-2xl tracking-tight">talise</div>
          <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
            Talise, money home, in seconds. We&apos;re in private beta.
          </p>
        </div>

        <Group title="Contact">
          <Item href="mailto:team@talise.io">team@talise.io</Item>
          <Item href="/litepaper">Litepaper</Item>
          <Item href="/waitlist">Join waitlist</Item>
        </Group>
      </div>
      <div className="border-t border-[var(--color-line)] px-6 py-6 md:px-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between text-[11px] text-[var(--color-fg-dim)]">
          <span>© 2026 Talise</span>
          <span>Money home, in seconds.</span>
        </div>
      </div>
    </footer>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-dim)]">
        {title}
      </div>
      <ul className="mt-4 space-y-2.5 text-[13px]">{children}</ul>
    </div>
  );
}

function Item({
  href,
  children,
  external,
  disabled,
}: {
  href: string;
  children: React.ReactNode;
  external?: boolean;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <li className="text-[var(--color-fg-dim)]">{children}</li>
    );
  }
  return (
    <li>
      <a
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noreferrer" : undefined}
        className="text-[var(--color-fg-muted)] underline-offset-4 transition hover:text-[var(--color-fg)] hover:underline"
      >
        {children}
        {external && " ↗"}
      </a>
    </li>
  );
}
