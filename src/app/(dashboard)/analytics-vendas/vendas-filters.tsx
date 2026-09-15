'use client'

import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { useCallback, useState, type CSSProperties } from 'react'
import { X, Check, RefreshCw, SlidersHorizontal, LayoutGrid } from 'lucide-react'
import { Sheet } from '@/components/ui/sheet'

const PERIODS = [
  { value: 'today', label: 'Hoje' },
  { value: 'yesterday', label: 'Ontem' },
  { value: '7d', label: '7 dias' },
  { value: '14d', label: '14 dias' },
  { value: '30d', label: '30 dias' },
  { value: 'month', label: 'Este mês' },
  { value: 'custom', label: 'Personalizado' },
]

const PAYMENT_TYPES = [
  { value: '', label: 'Todos' },
  { value: 'credit_card', label: 'Cartão' },
  { value: 'boleto', label: 'Boleto' },
  { value: 'pix', label: 'PIX' },
  { value: 'debit_card', label: 'Débito' },
  { value: 'paypal', label: 'PayPal' },
]

const PLATFORMS = [
  { value: '', label: 'Todas' },
  { value: 'hotmart', label: 'Hotmart' },
  { value: 'greenn', label: 'Greenn' },
  { value: 'zouti', label: 'Zouti' },
  { value: 'kiwify', label: 'Kiwify' },
]

const PLATFORM_VAR: Record<string, string> = {
  hotmart: 'var(--plat-hotmart)',
  greenn: 'var(--plat-greenn)',
  zouti: 'var(--plat-zouti)',
  kiwify: 'var(--plat-kiwify)',
}

/*
  Chip ativo é borda de 1px na cor a 45% mais fundo da mesma cor a 12%. O glow
  colorido anterior virava mancha borrada na compressão de vídeo.
*/
function tintStyle(color: string): CSSProperties {
  return {
    color,
    borderColor: `color-mix(in oklch, ${color} 45%, transparent)`,
    background: `color-mix(in oklch, ${color} 12%, transparent)`,
  }
}

const NEUTRAL_ACTIVE: CSSProperties = {
  color: 'var(--fg)',
  borderColor: 'var(--line-strong)',
  background: 'color-mix(in oklch, var(--fg) 8%, transparent)',
}

const SECTION_LABEL = 'text-label uppercase text-fg-subtle'

// Altura padrão: control-lg no celular, control-md a partir de md
const CONTROL = 'h-[var(--control-lg)] md:h-[var(--control-md)]'
/* Os chips de período dividem a linha com Atualizar e Filtros, então precisam da
   mesma altura; --control-sm fica para chip que aparece sozinho numa linha. */
const CHIP = CONTROL

type ProductPlatform = 'hotmart' | 'greenn' | 'zouti' | 'kiwify' | null

interface Product {
  name: string
  platform: ProductPlatform
}

interface VendasFiltersProps {
  products: Product[]
  utmSources: string[]
  utmMediums: string[]
  utmCampaigns: string[]
  utmContents: string[]
  utmTerms: string[]
  sckValues: string[]
}

function FilterDropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  if (options.length === 0) return null
  return (
    <div className="flex w-full flex-col gap-1.5">
      <span className={SECTION_LABEL}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`native-field focus-ring w-full truncate rounded-[var(--r-sm)] border border-line-default bg-surface-inset px-2.5 text-body text-fg ${CONTROL}`}
      >
        <option value="">Todos</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  )
}

const PRODUCT_GROUPS = [
  { key: 'hotmart', label: 'Hotmart', color: 'var(--plat-hotmart)' },
  { key: 'greenn', label: 'Greenn', color: 'var(--plat-greenn)' },
  { key: 'zouti', label: 'Zouti', color: 'var(--plat-zouti)' },
  { key: 'kiwify', label: 'Kiwify', color: 'var(--plat-kiwify)' },
  { key: 'outros', label: 'Outros', color: 'var(--fg-subtle)' },
] as const

export function VendasFilters({ products, utmSources, utmMediums, utmCampaigns, utmContents, utmTerms, sckValues }: VendasFiltersProps) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const [refreshing, setRefreshing] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)

  async function handleRefresh() {
    setRefreshing(true)
    router.refresh()
    setTimeout(() => setRefreshing(false), 800)
  }

  const period = searchParams.get('period') ?? '30d'
  const payment = searchParams.get('payment') ?? ''
  const from = searchParams.get('from') ?? ''
  const to = searchParams.get('to') ?? ''
  const utmSource = searchParams.get('utmSource') ?? ''
  const utmMedium = searchParams.get('utmMedium') ?? ''
  const utmCampaign = searchParams.get('utmCampaign') ?? ''
  const utmContent = searchParams.get('utmContent') ?? ''
  const utmTerm = searchParams.get('utmTerm') ?? ''
  const sck = searchParams.get('sck') ?? ''
  const platform = searchParams.get('platform') ?? ''

  const uniqueNames = Array.from(new Set(products.map((p) => p.name)))

  const productsParam = searchParams.get('products') ?? ''
  const selectedProducts = productsParam ? productsParam.split(',').filter(Boolean) : []
  const allSelected = selectedProducts.length === 0 || selectedProducts.length === uniqueNames.length

  const grouped: Record<string, Product[]> = {
    hotmart: products.filter((p) => p.platform === 'hotmart'),
    greenn: products.filter((p) => p.platform === 'greenn'),
    zouti: products.filter((p) => p.platform === 'zouti'),
    kiwify: products.filter((p) => p.platform === 'kiwify'),
    outros: products.filter((p) => !p.platform),
  }

  const update = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString())
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value)
        else params.delete(key)
      }
      router.push(`${pathname}?${params.toString()}`)
    },
    [searchParams, router, pathname],
  )

  const toggleProduct = (name: string) => {
    const next = selectedProducts.includes(name)
      ? selectedProducts.filter((p) => p !== name)
      : [...selectedProducts, name]
    update({ products: next.length === uniqueNames.length ? '' : next.join(',') })
  }

  const clearFilters = () => router.push(pathname)

  // Contador exibido no botão "Filtros"
  const activeFilterCount = [
    payment, platform, utmSource, utmMedium, utmCampaign, utmContent, utmTerm, sck, productsParam,
  ].filter(Boolean).length

  // Chips removíveis do que está aplicado, para o filtro nunca ficar invisível
  const appliedChips: { id: string; label: string; color?: string; remove: () => void }[] = []

  if (platform) {
    appliedChips.push({
      id: `platform-${platform}`,
      label: PLATFORMS.find((p) => p.value === platform)?.label ?? platform,
      color: PLATFORM_VAR[platform],
      remove: () => update({ platform: '' }),
    })
  }
  if (payment) {
    appliedChips.push({
      id: `payment-${payment}`,
      label: PAYMENT_TYPES.find((p) => p.value === payment)?.label ?? payment,
      remove: () => update({ payment: '' }),
    })
  }
  const utmChips: [string, string, string][] = [
    ['utmSource', 'Source', utmSource],
    ['utmMedium', 'Medium', utmMedium],
    ['utmCampaign', 'Campaign', utmCampaign],
    ['utmContent', 'Content', utmContent],
    ['utmTerm', 'Term', utmTerm],
    ['sck', 'SCK', sck],
  ]
  for (const [key, label, value] of utmChips) {
    if (!value) continue
    appliedChips.push({
      id: `${key}-${value}`,
      label: `${label}: ${value}`,
      remove: () => update({ [key]: '' }),
    })
  }
  if (!allSelected) {
    for (const name of selectedProducts) {
      appliedChips.push({
        id: `product-${name}`,
        label: name,
        color: 'var(--brand-ink)',
        remove: () => toggleProduct(name),
      })
    }
  }

  const platformSection = (
    <div className="flex flex-col gap-2">
      <span className={SECTION_LABEL}>Plataforma</span>
      <div className="flex flex-wrap gap-1.5">
        {PLATFORMS.map(({ value, label }) => {
          const isActive = platform === value
          const color = PLATFORM_VAR[value]
          return (
            <button
              key={value}
              onClick={() => update({ platform: value })}
              style={isActive ? (color ? tintStyle(color) : NEUTRAL_ACTIVE) : undefined}
              className={`focus-ring inline-flex items-center gap-2 rounded-[var(--r-sm)] border px-3 text-body font-medium transition-colors ${CONTROL} ${
                isActive
                  ? ''
                  : 'border-line-subtle bg-surface-raised text-fg-muted hover:border-line-default hover:text-fg'
              }`}
            >
              {color ? (
                <span className="dot" style={{ color, opacity: isActive ? 1 : 0.5 }} />
              ) : (
                <LayoutGrid size={13} className="shrink-0" />
              )}
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )

  const paymentSection = (
    <div className="flex flex-col gap-2">
      <span className={SECTION_LABEL}>Pagamento</span>
      <div className="flex flex-wrap gap-1.5">
        {PAYMENT_TYPES.map(({ value, label }) => {
          const isActive = payment === value
          return (
            <button
              key={value}
              onClick={() => update({ payment: value })}
              style={isActive ? (value ? tintStyle('var(--st-info)') : NEUTRAL_ACTIVE) : undefined}
              className={`focus-ring inline-flex items-center rounded-[var(--r-sm)] border px-3 text-body font-medium transition-colors ${CONTROL} ${
                isActive
                  ? ''
                  : 'border-line-subtle bg-surface-raised text-fg-muted hover:border-line-default hover:text-fg'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )

  const productsSection = products.length > 0 ? (
    <div className="flex flex-col gap-2">
      <span className={SECTION_LABEL}>
        Produtos
        {!allSelected && selectedProducts.length > 0 && (
          <span className="num ml-2 rounded-full bg-brand-solid px-1.5 py-0.5 text-micro text-on-accent">
            {selectedProducts.length}
          </span>
        )}
      </span>
      <div className="scroll-thin max-h-64 overflow-y-auto rounded-[var(--r-md)] border border-line-subtle bg-surface-inset p-1.5">
        <button
          onClick={() => update({ products: '' })}
          className="group flex w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2 py-2 text-left hover:bg-surface-raised md:py-1.5"
        >
          <span
            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--r-sm)] border transition-colors ${
              allSelected ? 'border-brand-solid bg-brand-solid' : 'border-line-strong group-hover:border-fg-subtle'
            }`}
          >
            {allSelected && <Check size={10} className="text-on-accent" strokeWidth={3} />}
          </span>
          <span className="text-body text-fg-muted group-hover:text-fg">Todos</span>
        </button>

        {PRODUCT_GROUPS.map((group) => {
          const items = grouped[group.key]
          if (!items || items.length === 0) return null
          return (
            <div key={group.key}>
              <div className="flex items-center gap-2 px-2 pt-3 pb-1">
                <span className="dot" style={{ color: group.color }} />
                <span className="text-label uppercase" style={{ color: group.color }}>
                  {group.label}
                </span>
                <span className="num text-micro text-fg-faint">{items.length}</span>
                <div className="h-px flex-1 bg-line-subtle" />
              </div>
              {items.map((product) => {
                const checked = selectedProducts.includes(product.name)
                return (
                  <button
                    key={`${group.key}-${product.name}`}
                    onClick={() => toggleProduct(product.name)}
                    title={product.name}
                    className="group flex w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2 py-2 text-left hover:bg-surface-raised md:py-1.5"
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--r-sm)] border transition-colors ${
                        checked ? 'border-brand-solid bg-brand-solid' : 'border-line-strong group-hover:border-fg-subtle'
                      }`}
                    >
                      {checked && <Check size={10} className="text-on-accent" strokeWidth={3} />}
                    </span>
                    <span className="truncate text-body text-fg-muted group-hover:text-fg">{product.name}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  ) : null

  const utmSection = (
    <div className="flex flex-col gap-3">
      <span className={SECTION_LABEL}>Rastreamento</span>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FilterDropdown label="UTM Source"   value={utmSource}   options={utmSources}   onChange={(v) => update({ utmSource: v })} />
        <FilterDropdown label="UTM Medium"   value={utmMedium}   options={utmMediums}   onChange={(v) => update({ utmMedium: v })} />
        <FilterDropdown label="UTM Campaign" value={utmCampaign} options={utmCampaigns} onChange={(v) => update({ utmCampaign: v })} />
        <FilterDropdown label="UTM Content"  value={utmContent}  options={utmContents}  onChange={(v) => update({ utmContent: v })} />
        <FilterDropdown label="UTM Term"     value={utmTerm}     options={utmTerms}     onChange={(v) => update({ utmTerm: v })} />
        <FilterDropdown label="SCK"          value={sck}         options={sckValues}    onChange={(v) => update({ sck: v })} />
      </div>
    </div>
  )

  return (
    <div className="space-y-3">
      {/* Linha única: período à esquerda, ações à direita */}
      <div className="flex items-center gap-2">
        <div
          className="-mx-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-1 py-1"
          style={{ scrollbarWidth: 'none' }}
        >
          {PERIODS.map(({ value, label }) => {
            const isActive = period === value
            return (
              <button
                key={value}
                onClick={() =>
                  value !== 'custom'
                    ? update({ period: value, from: '', to: '' })
                    : update({ period: 'custom' })
                }
                className={`focus-ring shrink-0 inline-flex items-center rounded-[var(--r-sm)] border px-3 text-body font-medium transition-colors ${CHIP} ${
                  isActive
                    ? 'border-line-strong bg-surface-overlay text-fg'
                    : 'border-line-subtle bg-surface-raised text-fg-muted hover:border-line-default hover:text-fg'
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            aria-label="Atualizar"
            className={`focus-ring inline-flex w-[var(--control-lg)] items-center justify-center rounded-[var(--r-sm)] border border-line-subtle bg-surface-raised text-fg-subtle transition-colors hover:text-fg disabled:opacity-50 md:w-[var(--control-md)] ${CONTROL}`}
          >
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setPanelOpen(true)}
            className={`focus-ring inline-flex items-center gap-2 rounded-[var(--r-sm)] border border-line-default bg-surface-raised px-3 text-body font-medium text-fg-muted transition-colors hover:text-fg ${CONTROL}`}
          >
            <SlidersHorizontal size={14} />
            Filtros
            {activeFilterCount > 0 && (
              <span className="num rounded-full bg-brand-solid px-1.5 text-micro text-on-accent">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Datas do período personalizado */}
      {period === 'custom' && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-micro text-fg-subtle">
            De
            <input
              type="date"
              value={from}
              onChange={(e) => update({ from: e.target.value })}
              className={`native-field focus-ring rounded-[var(--r-sm)] border border-line-default bg-surface-inset px-2.5 text-body text-fg ${CONTROL}`}
            />
          </label>
          <label className="flex items-center gap-2 text-micro text-fg-subtle">
            Até
            <input
              type="date"
              value={to}
              onChange={(e) => update({ to: e.target.value })}
              className={`native-field focus-ring rounded-[var(--r-sm)] border border-line-default bg-surface-inset px-2.5 text-body text-fg ${CONTROL}`}
            />
          </label>
        </div>
      )}

      {/* Chips do que está aplicado */}
      {appliedChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {appliedChips.map((chip) => (
            <span
              key={chip.id}
              style={chip.color ? tintStyle(chip.color) : undefined}
              className={`inline-flex max-w-full items-center gap-1.5 rounded-full border py-0.5 pl-2.5 pr-1 text-micro ${CHIP} ${
                chip.color ? '' : 'border-line-default bg-surface-raised text-fg-muted'
              }`}
            >
              <span className="truncate" title={chip.label}>{chip.label}</span>
              <button
                onClick={chip.remove}
                aria-label={`Remover filtro ${chip.label}`}
                className="focus-ring inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-70 md:h-5 md:w-5"
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <button
            onClick={clearFilters}
            className="focus-ring inline-flex items-center rounded-full px-2.5 text-micro text-fg-subtle transition-colors hover:text-fg"
          >
            Limpar tudo
          </button>
        </div>
      )}

      <Sheet open={panelOpen} onOpenChange={setPanelOpen} side="right" title="Filtros" desktop className="w-[92vw] sm:max-w-[440px]">
        <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {platformSection}
          {paymentSection}
          {productsSection}
          {utmSection}
        </div>
        <div className="flex shrink-0 gap-2 border-t border-line-subtle px-4 py-3">
          <button
            onClick={() => {
              clearFilters()
              setPanelOpen(false)
            }}
            className="focus-ring h-[var(--control-lg)] flex-1 rounded-[var(--r-sm)] border border-line-default text-body font-medium text-fg-muted transition-colors hover:text-fg"
          >
            Limpar
          </button>
          <button
            onClick={() => setPanelOpen(false)}
            className="focus-ring h-[var(--control-lg)] flex-1 rounded-[var(--r-sm)] bg-brand-solid text-body font-medium text-on-accent"
          >
            Aplicar
          </button>
        </div>
      </Sheet>
    </div>
  )
}
