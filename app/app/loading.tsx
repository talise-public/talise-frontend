/**
 * Route-group loading skeleton. Shown instantly on navigation into any
 * `/app/*` route while its client bundle hydrates + first fetch resolves -
 * replaces the blank-flash with a calm, on-theme placeholder.
 */
export default function AppLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl animate-pulse space-y-5 pt-1">
      {/* header */}
      <div className="space-y-2.5">
        <div className="h-3 w-24 rounded-full bg-surface-2" />
        <div className="h-7 w-2/3 rounded-lg bg-surface-2" />
        <div className="h-4 w-1/2 rounded-md bg-surface-2" />
      </div>
      {/* primary card */}
      <div className="rounded-3xl bg-surface p-7 ring-1 ring-line">
        <div className="flex items-center gap-3.5">
          <div className="size-11 rounded-2xl bg-surface-2" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-20 rounded-full bg-surface-2" />
            <div className="h-4 w-40 rounded-md bg-surface-2" />
          </div>
        </div>
        <div className="mt-6 space-y-3">
          <div className="h-12 rounded-xl bg-surface-2" />
          <div className="h-12 rounded-xl bg-surface-2" />
          <div className="h-12 rounded-xl bg-surface-2" />
        </div>
        <div className="mt-8 h-12 rounded-full bg-surface-2" />
      </div>
    </div>
  );
}
