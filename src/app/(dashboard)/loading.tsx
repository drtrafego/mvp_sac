/*
  Enquanto a rota carrega, o painel mostra a silhueta da tela em vez de ficar em
  branco. Tela branca entre uma navegação e outra filma como travamento.
*/
export default function Loading() {
  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <div className="space-y-2">
        <div className="skeleton h-7 w-52" />
        <div className="skeleton h-4 w-72" />
      </div>

      {/* Mesma divisão da tela real: herói em 5 colunas e as 4 métricas nas 7 restantes */}
      <div className="grid grid-cols-12 gap-[var(--space-gutter)]">
        <div className="skeleton col-span-12 h-[150px] lg:col-span-5" />
        <div className="col-span-12 grid grid-cols-2 gap-[var(--space-gutter)] lg:col-span-7 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-[120px]" />
          ))}
        </div>
      </div>

      <div className="skeleton h-[320px] w-full" />
    </div>
  )
}
