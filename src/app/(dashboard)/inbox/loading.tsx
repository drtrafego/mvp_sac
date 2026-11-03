export default function InboxLoading() {
  return (
    <div aria-label="Carregando conversas" className="flex h-full min-h-0 flex-1 overflow-hidden bg-surface-base">
      <aside className="flex w-full shrink-0 flex-col gap-3 border-r border-line-subtle bg-surface-panel p-3 md:w-[330px] xl:w-[380px]">
        <div className="skeleton h-7 w-32 rounded-lg" />
        <div className="skeleton h-9 w-full rounded-xl" />
        <div className="skeleton h-6 w-full rounded-lg" />
        <div className="skeleton h-6 w-4/5 rounded-lg" />
        {[0, 1, 2, 3].map((item) => <div key={item} className="skeleton h-20 w-full rounded-xl" />)}
      </aside>
      <div className="hidden flex-1 items-center justify-center text-body text-fg-muted md:flex">
        Carregando conversas…
      </div>
    </div>
  )
}
