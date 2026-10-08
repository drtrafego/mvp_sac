'use client'

import { useMemo, useState, useRef } from 'react'
import {
  UploadCloud,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  ArrowLeft,
  Sparkles,
  Phone,
  User,
  Mail,
  Package,
  Tags,
  CalendarDays,
  Database
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

interface ImportLeadsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

const CONTROL_H = 'h-[var(--control-lg)] lg:h-[var(--control-md)]'
const FIELD = 'bg-surface-inset border-line-subtle placeholder:text-fg-faint focus-ring'

function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

function headerTokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  if (!clean.trim()) return { headers: [], rows: [] }

  // Detecta o delimitador na primeira linha real, respeitando aspas.
  let firstLine = ''
  let insideQuotes = false
  for (const char of clean) {
    if (char === '"') insideQuotes = !insideQuotes
    if ((char === '\n' || char === '\r') && !insideQuotes) break
    firstLine += char
  }
  const candidates = [',', ';', '\t'] as const
  const delimiter = candidates.reduce((best, candidate) =>
    (firstLine.split(candidate).length > firstLine.split(best).length ? candidate : best), ',')

  const records: string[][] = []
  let record: string[] = []
  let current = ''
  insideQuotes = false

  const finishCell = () => {
    record.push(current.trim())
    current = ''
  }
  const finishRecord = () => {
    finishCell()
    if (record.some(value => value.length > 0)) records.push(record)
    record = []
  }

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i]
    if (char === '"') {
      if (insideQuotes && clean[i + 1] === '"') {
        current += '"'
        i++
      } else {
        insideQuotes = !insideQuotes
      }
    } else if (char === delimiter && !insideQuotes) {
      finishCell()
    } else if ((char === '\n' || char === '\r') && !insideQuotes) {
      if (char === '\r' && clean[i + 1] === '\n') i++
      finishRecord()
    } else {
      current += char
    }
  }
  if (current.length > 0 || record.length > 0) finishRecord()

  const [headers = [], ...rows] = records
  return { headers, rows: rows.map(row => headers.map((_, index) => row[index] ?? '')) }
}

function autoMatchColumn(headers: string[], keywordGroups: string[][]): string {
  for (const keywords of keywordGroups) {
    const match = headers.find(header => {
      const clean = normalizeHeader(header)
      return keywords.some(keyword => {
        const normalizedKeyword = normalizeHeader(keyword)
        if (normalizedKeyword.length <= 3) {
          const tokens = headerTokens(header)
          return tokens.some(token => token === normalizedKeyword || token === `${normalizedKeyword}s`)
        }
        return clean.includes(normalizedKeyword)
      })
    })
    if (match) return match
  }
  return ''
}

function splitTags(value: string): string[] {
  return [...new Set(value.split(/[|,;]/).map(tag => tag.trim()).filter(Boolean))]
}

export function ImportLeadsModal({ open, onOpenChange, onSuccess }: ImportLeadsModalProps) {
  const [step, setStep] = useState<'upload' | 'mapping' | 'importing' | 'result' | 'preview' | 'queued'>('upload')
  const [fileName, setFileName] = useState('')
  const [parsedData, setParsedData] = useState<{ headers: string[]; rows: string[][] }>({ headers: [], rows: [] })
  
  // Mapeamento de colunas
  const [phoneCol, setPhoneCol] = useState('')
  const [phoneFallbackCol, setPhoneFallbackCol] = useState('')
  const [nameCol, setNameCol] = useState('')
  const [lastNameCol, setLastNameCol] = useState('')
  const [emailCol, setEmailCol] = useState('')
  const [productCol, setProductCol] = useState('')
  const [valueCol, setValueCol] = useState('')
  const [tagsCol, setTagsCol] = useState('')
  const [sourceCol, setSourceCol] = useState('')
  const [externalIdCol, setExternalIdCol] = useState('')
  const [createdAtCol, setCreatedAtCol] = useState('')
  
  // Configurações gerais
  const [defaultSource, setDefaultSource] = useState('mineracao')
  // Evento só existe quando o usuário prepara um disparo em massa. Uma
  // importação simples não deve cair, por padrão, em uma régua específica.
  const [defaultEventType, setDefaultEventType] = useState('')
  const [recordType, setRecordType] = useState<'lead' | 'closed_sale'>('lead')
  const [recordPlatform, setRecordPlatform] = useState('import_planilha')
  const [createMassDispatch, setCreateMassDispatch] = useState(false)
  const [defaultProduct, setDefaultProduct] = useState('Produto Principal')
  const [defaultProductValue, setDefaultProductValue] = useState('')
  const [batchTag, setBatchTag] = useState('')
  const [tagScopeChannel, setTagScopeChannel] = useState('')

  // Resultados
  const [importResult, setImportResult] = useState<{
    total: number
    inserted: number
    updated: number
    skipped: number
    tagFailed: number
    dispatchRecipientFailed: number
    errors: string[]
    batchId: number | null
    recipientCount: number
  } | null>(null)
  const [dispatchPreview, setDispatchPreview] = useState<{
    recipientCount: number
    messageCount: number
    totalJobs: number
    messages: { id: number; order: number; delayMinutes: number; messageType: string; content: string; templateName: string | null }[]
  } | null>(null)
  const [dispatchConfirmed, setDispatchConfirmed] = useState(false)
  const [jobsCreated, setJobsCreated] = useState(0)
  const [isProcessing, setIsProcessing] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const importStats = useMemo(() => {
    const indexOf = (column: string) => column ? parsedData.headers.indexOf(column) : -1
    const valueAt = (row: string[], column: string) => {
      const index = indexOf(column)
      return index >= 0 ? (row[index] || '').trim() : ''
    }
    const phoneRows = parsedData.rows.filter(row => valueAt(row, phoneCol) || valueAt(row, phoneFallbackCol))
    const rowsWithTags = parsedData.rows.filter(row => valueAt(row, tagsCol)).length
    const rowsWithMultipleTags = parsedData.rows.filter(row => splitTags(valueAt(row, tagsCol)).length > 1).length
    const sourceValues = new Set(parsedData.rows.map(row => valueAt(row, sourceCol)).filter(Boolean))

    return {
      phoneRows: phoneRows.length,
      withoutPhone: parsedData.rows.length - phoneRows.length,
      rowsWithTags,
      rowsWithMultipleTags,
      sourceCount: sourceValues.size,
    }
  }, [parsedData.headers, parsedData.rows, phoneCol, phoneFallbackCol, sourceCol, tagsCol])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target?.result as string
      const { headers, rows } = parseCSV(text)
      setParsedData({ headers, rows })

      // Auto-match headers
      setPhoneCol(autoMatchColumn(headers, [['whatsapp', 'whats'], ['telefone', 'celular', 'fone', 'phone', 'contato', 'tel', 'numero', 'mobile']]))
      setPhoneFallbackCol(autoMatchColumn(headers, [['mobile'], ['telefone', 'celular', 'fone', 'phone', 'contato', 'tel', 'numero']]))
      setNameCol(autoMatchColumn(headers, [['nome completo', 'full name'], ['primeiro nome', 'first name'], ['nome', 'cliente', 'name', 'comprador', 'lead']]))
      setLastNameCol(autoMatchColumn(headers, [['sobrenome', 'last name', 'family name']]))
      setEmailCol(autoMatchColumn(headers, [['email', 'e-mail', 'mail', 'correio']]))
      setProductCol(autoMatchColumn(headers, [['produto', 'oferta', 'curso', 'product', 'item']]))
      setValueCol(autoMatchColumn(headers, [['valor', 'preco', 'price', 'total', 'quantia']]))
      setTagsCol(autoMatchColumn(headers, [['tags', 'tag', 'etiquetas', 'marcadores']]))
      setSourceCol(autoMatchColumn(headers, [['source', 'origem', 'canal']]))
      setExternalIdCol(autoMatchColumn(headers, [['external id', 'contact id', 'customer id'], ['id']]))
      setCreatedAtCol(autoMatchColumn(headers, [['created on', 'created at', 'created', 'data de criacao', 'data']]))

      setStep('mapping')
    }
    reader.readAsText(file, 'UTF-8')
  }

  const handleImport = async () => {
    if (!phoneCol) {
      alert('Por favor, selecione a coluna correspondente ao Telefone / WhatsApp.')
      return
    }
    if (createMassDispatch && !defaultEventType) {
      alert('Selecione o tipo de evento da sequência para preparar o disparo em massa.')
      return
    }
    if (recordType === 'closed_sale' && createMassDispatch) {
      alert('Venda fechada não entra em disparo de recuperação. Desmarque o disparo em massa para continuar.')
      return
    }

    setIsProcessing(true)
    setStep('importing')

    const phoneIdx = parsedData.headers.indexOf(phoneCol)
    const phoneFallbackIdx = phoneFallbackCol ? parsedData.headers.indexOf(phoneFallbackCol) : -1
    const nameIdx = nameCol ? parsedData.headers.indexOf(nameCol) : -1
    const lastNameIdx = lastNameCol ? parsedData.headers.indexOf(lastNameCol) : -1
    const emailIdx = emailCol ? parsedData.headers.indexOf(emailCol) : -1
    const productIdx = productCol ? parsedData.headers.indexOf(productCol) : -1
    const valueIdx = valueCol ? parsedData.headers.indexOf(valueCol) : -1
    const tagsIdx = tagsCol ? parsedData.headers.indexOf(tagsCol) : -1
    const sourceIdx = sourceCol ? parsedData.headers.indexOf(sourceCol) : -1
    const externalIdIdx = externalIdCol ? parsedData.headers.indexOf(externalIdCol) : -1
    const createdAtIdx = createdAtCol ? parsedData.headers.indexOf(createdAtCol) : -1

    const items = parsedData.rows.map(row => ({
      phone: row[phoneIdx] || (phoneFallbackIdx >= 0 ? row[phoneFallbackIdx] : '') || '',
      name: [nameIdx >= 0 ? row[nameIdx] : '', lastNameIdx >= 0 ? row[lastNameIdx] : ''].filter(Boolean).join(' ') || undefined,
      email: emailIdx >= 0 ? row[emailIdx] : undefined,
      productName: productIdx >= 0 && row[productIdx] ? row[productIdx] : defaultProduct,
      productValue: valueIdx >= 0 && row[valueIdx] ? row[valueIdx] : defaultProductValue || undefined,
      eventType: recordType === 'closed_sale'
        ? 'compra_aprovada'
        : createMassDispatch && defaultEventType ? defaultEventType : undefined,
      recordType,
      platform: recordPlatform,
      trackingSource: sourceIdx >= 0 && row[sourceIdx]?.trim() ? row[sourceIdx].trim() : defaultSource,
      tags: tagsIdx >= 0 ? splitTags(row[tagsIdx] || '') : [],
      sourceMetadata: {
        externalId: externalIdIdx >= 0 ? row[externalIdIdx]?.trim() || undefined : undefined,
        createdOn: createdAtIdx >= 0 ? row[createdAtIdx]?.trim() || undefined : undefined,
        originalSource: sourceIdx >= 0 ? row[sourceIdx]?.trim() || undefined : undefined,
      },
    })).filter(i => i.phone.trim().length > 0)

    try {
      const res = await fetch('/api/leads/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          defaultEventType: createMassDispatch ? defaultEventType : undefined,
          defaultSource,
          recordType,
          platform: recordPlatform,
          fileName,
          createMassDispatch,
          tag: batchTag.trim() || undefined,
          scopeChannel: batchTag.trim() && tagScopeChannel ? tagScopeChannel : undefined,
        }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        alert(`Erro na importação: ${errData.error || 'Falha ao processar planilha no servidor.'}`)
        setStep('mapping')
        return
      }

      const result = await res.json()
      setImportResult(result)
      setStep('result')
      onSuccess()
    } catch {
      alert('Erro ao processar importação. Tente novamente.')
      setStep('mapping')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleLoadPreview = async () => {
    if (!importResult?.batchId) return
    setIsProcessing(true)
    try {
      const res = await fetch(`/api/leads/import/${importResult.batchId}/dispatch`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Falha ao carregar preview')
      setDispatchPreview(data)
      setStep('preview')
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Falha ao carregar preview')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleConfirmDispatch = async () => {
    if (!importResult?.batchId || !dispatchConfirmed) return
    setIsProcessing(true)
    try {
      const res = await fetch(`/api/leads/import/${importResult.batchId}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, previewMessages: dispatchPreview?.messages ?? [] }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Falha ao iniciar disparo')
      setJobsCreated(data.jobsCreated)
      setStep('queued')
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Falha ao iniciar disparo')
    } finally {
      setIsProcessing(false)
    }
  }

  const resetModal = () => {
    setStep('upload')
    setFileName('')
    setParsedData({ headers: [], rows: [] })
    setPhoneCol('')
    setPhoneFallbackCol('')
    setNameCol('')
    setLastNameCol('')
    setEmailCol('')
    setProductCol('')
    setValueCol('')
    setTagsCol('')
    setSourceCol('')
    setExternalIdCol('')
    setCreatedAtCol('')
    setDefaultEventType('')
    setRecordType('lead')
    setRecordPlatform('import_planilha')
    setDefaultProduct('Produto Principal')
    setDefaultProductValue('')
    setCreateMassDispatch(false)
    setBatchTag('')
    setTagScopeChannel('')
    setImportResult(null)
    setDispatchPreview(null)
    setDispatchConfirmed(false)
    setJobsCreated(0)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetModal(); onOpenChange(v); }}>
      <DialogContent className="scroll-thin w-[calc(100%-2rem)] max-w-2xl max-h-[90vh] overflow-y-auto rounded-[var(--r-xl)] border border-line-subtle bg-surface-overlay p-6">
        <DialogHeader>
          <DialogTitle className="text-h2 flex items-center gap-2">
            <FileSpreadsheet size={20} className="text-cyan-400" />
            Importar Contatos & Mineração (Planilha CSV)
          </DialogTitle>
        </DialogHeader>

        {/* ─── PASSO 1: UPLOAD DO ARQUIVO ─── */}
        {step === 'upload' && (
          <div className="space-y-4 pt-3">
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-line-default hover:border-cyan-400/80 rounded-[var(--r-xl)] p-8 text-center bg-surface-inset/50 hover:bg-surface-inset transition-all cursor-pointer space-y-3"
            >
              <div className="h-12 w-12 rounded-full bg-cyan-500/10 text-cyan-400 flex items-center justify-center mx-auto">
                <UploadCloud size={24} />
              </div>
              <div>
                <p className="text-body font-bold text-fg">Clique para selecionar sua planilha CSV</p>
                <p className="text-micro text-fg-subtle mt-1">
                  Suporta arquivos .CSV exportados do Excel, Google Sheets, ferramentas de Mineração ou CRM.
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>

            <div className="rounded-[var(--r-md)] border border-line-subtle bg-surface-panel p-4 space-y-1.5 text-micro text-fg-muted">
              <span className="font-bold text-fg block text-label uppercase">Formato Recomendado:</span>
              <p>• A primeira linha deve conter o cabeçalho das colunas (ex: <code>Nome, Telefone, Email, Produto</code>).</p>
              <p>• Os telefones serão automaticamente normalizados com código do país (+55) e DDD.</p>
              <p>• Contatos duplicados são tratados automaticamente sem gerar cobrança duplicada.</p>
            </div>
          </div>
        )}

        {/* ─── PASSO 2: MAPEAMENTO DE COLUNAS & CONFIGURAÇÕES ─── */}
        {step === 'mapping' && (
          <div className="space-y-5 pt-2">
            <div className="flex items-center justify-between bg-surface-inset px-4 py-2.5 rounded-[var(--r-md)] border border-line-subtle">
              <div className="flex items-center gap-2 text-micro">
                <FileSpreadsheet size={15} className="text-cyan-400" />
                <span className="font-bold text-fg">{fileName}</span>
                <span className="text-fg-subtle">({parsedData.rows.length} linhas encontradas)</span>
              </div>
              <button
                onClick={() => setStep('upload')}
                className="text-micro text-fg-muted hover:text-fg font-medium cursor-pointer"
              >
                Trocar arquivo
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
              <div className="rounded-[var(--r-md)] border border-emerald-500/30 bg-emerald-500/5 p-2.5">
                <span className="text-micro text-fg-subtle block">Com telefone</span>
                <span className="text-h2 font-bold text-emerald-400">{importStats.phoneRows}</span>
              </div>
              <div className="rounded-[var(--r-md)] border border-amber-500/30 bg-amber-500/5 p-2.5">
                <span className="text-micro text-fg-subtle block">Sem telefone</span>
                <span className="text-h2 font-bold text-amber-400">{importStats.withoutPhone}</span>
              </div>
              <div className="rounded-[var(--r-md)] border border-purple-500/30 bg-purple-500/5 p-2.5">
                <span className="text-micro text-fg-subtle block">Com tags</span>
                <span className="text-h2 font-bold text-purple-400">{importStats.rowsWithTags}</span>
              </div>
              <div className="rounded-[var(--r-md)] border border-cyan-500/30 bg-cyan-500/5 p-2.5">
                <span className="text-micro text-fg-subtle block">Origens</span>
                <span className="text-h2 font-bold text-cyan-400">{importStats.sourceCount || '—'}</span>
              </div>
            </div>

            {importStats.withoutPhone > 0 && (
              <div className="rounded-[var(--r-md)] border border-amber-500/40 bg-amber-500/10 p-3 text-micro text-amber-600 dark:text-amber-400">
                {importStats.withoutPhone} linha(s) não têm telefone nas colunas selecionadas e serão ignoradas. Confira o fallback antes de importar.
              </div>
            )}

            {/* Mapeamento de Campos */}
            <div className="space-y-3">
              <span className="text-label uppercase text-fg-subtle font-bold block">1. Mapeamento das Colunas da sua Planilha</span>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Telefone (Obrigatório) */}
                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg flex items-center gap-1.5">
                    <Phone size={12} className="text-emerald-400" />
                    Telefone / WhatsApp *
                  </label>
                  <Select
                    value={phoneCol || '__none__'}
                    onValueChange={v => setPhoneCol(!v || v === '__none__' ? '' : v)}
                    items={{ __none__: 'Selecione a coluna...', ...Object.fromEntries(parsedData.headers.map(h => [h, h])) }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body', !phoneCol && 'border-rose-500/50')}>
                      <SelectValue placeholder="Selecione a coluna..." />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg max-h-48 border border-line-subtle">
                      {parsedData.headers.map(h => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Fallback de telefone */}
                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg flex items-center gap-1.5">
                    <Phone size={12} className="text-sky-400" />
                    Telefone alternativo
                  </label>
                  <Select
                    value={phoneFallbackCol || '__none__'}
                    onValueChange={v => setPhoneFallbackCol(!v || v === '__none__' ? '' : v)}
                    items={{ __none__: 'Não usar fallback', ...Object.fromEntries(parsedData.headers.map(h => [h, h])) }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body')}>
                      <SelectValue placeholder="Não usar fallback" />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg max-h-48 border border-line-subtle">
                      <SelectItem value="__none__">Não usar fallback</SelectItem>
                      {parsedData.headers.map(h => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Nome */}
                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg flex items-center gap-1.5">
                    <User size={12} className="text-blue-400" />
                    Nome do Cliente
                  </label>
                  <Select
                    value={nameCol || '__none__'}
                    onValueChange={v => setNameCol(!v || v === '__none__' ? '' : v)}
                    items={{ __none__: 'Não mapear (opcional)', ...Object.fromEntries(parsedData.headers.map(h => [h, h])) }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body')}>
                      <SelectValue placeholder="Selecione a coluna..." />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg max-h-48 border border-line-subtle">
                      <SelectItem value="__none__">Não mapear</SelectItem>
                      {parsedData.headers.map(h => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Sobrenome */}
                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg flex items-center gap-1.5">
                    <User size={12} className="text-indigo-400" />
                    Sobrenome
                  </label>
                  <Select
                    value={lastNameCol || '__none__'}
                    onValueChange={v => setLastNameCol(!v || v === '__none__' ? '' : v)}
                    items={{ __none__: 'Não mapear (opcional)', ...Object.fromEntries(parsedData.headers.map(h => [h, h])) }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body')}>
                      <SelectValue placeholder="Não mapear (opcional)" />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg max-h-48 border border-line-subtle">
                      <SelectItem value="__none__">Não mapear</SelectItem>
                      {parsedData.headers.map(h => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* E-mail */}
                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg flex items-center gap-1.5">
                    <Mail size={12} className="text-purple-400" />
                    E-mail
                  </label>
                  <Select
                    value={emailCol || '__none__'}
                    onValueChange={v => setEmailCol(!v || v === '__none__' ? '' : v)}
                    items={{ __none__: 'Não mapear (opcional)', ...Object.fromEntries(parsedData.headers.map(h => [h, h])) }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body')}>
                      <SelectValue placeholder="Selecione a coluna..." />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg max-h-48 border border-line-subtle">
                      <SelectItem value="__none__">Não mapear</SelectItem>
                      {parsedData.headers.map(h => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Produto */}
                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg flex items-center gap-1.5">
                    <Package size={12} className="text-amber-400" />
                    Produto / Oferta
                  </label>
                  <Select
                    value={productCol || '__none__'}
                    onValueChange={v => setProductCol(!v || v === '__none__' ? '' : v)}
                    items={{ __none__: 'Usar produto padrão', ...Object.fromEntries(parsedData.headers.map(h => [h, h])) }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body')}>
                      <SelectValue placeholder="Selecione a coluna..." />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg max-h-48 border border-line-subtle">
                      <SelectItem value="__none__">Usar produto padrão</SelectItem>
                      {parsedData.headers.map(h => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!productCol && (
                    <Input
                      value={defaultProduct}
                      onChange={e => setDefaultProduct(e.target.value)}
                      placeholder="Ex.: Curso de Vendas"
                      className={cn(FIELD, CONTROL_H, 'text-body mt-1.5')}
                    />
                  )}
                </div>

                {/* Valor */}
                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg flex items-center gap-1.5">
                    <Package size={12} className="text-emerald-400" />
                    Valor da venda
                  </label>
                  <Select
                    value={valueCol || '__none__'}
                    onValueChange={v => setValueCol(!v || v === '__none__' ? '' : v)}
                    items={{ __none__: 'Sem valor / usar R$ 0,00', ...Object.fromEntries(parsedData.headers.map(h => [h, h])) }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body')}>
                      <SelectValue placeholder="Sem valor / usar R$ 0,00" />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg max-h-48 border border-line-subtle">
                      <SelectItem value="__none__">Sem valor / usar R$ 0,00</SelectItem>
                      {parsedData.headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {!valueCol && (
                    <Input
                      value={defaultProductValue}
                      onChange={e => setDefaultProductValue(e.target.value)}
                      placeholder="Ex.: 1253,71"
                      className={cn(FIELD, CONTROL_H, 'text-body mt-1.5')}
                    />
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-3 pt-2 border-t border-line-subtle">
              <span className="text-label uppercase text-fg-subtle font-bold block">Metadados da base (opcional)</span>
              <p className="text-micro text-fg-subtle">Esses campos são preservados quando existirem; cada planilha pode ter colunas diferentes.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg flex items-center gap-1.5">
                    <Tags size={12} className="text-purple-400" />
                    Tags do contato
                  </label>
                  <Select
                    value={tagsCol || '__none__'}
                    onValueChange={v => setTagsCol(!v || v === '__none__' ? '' : v)}
                    items={{ __none__: 'Não mapear (opcional)', ...Object.fromEntries(parsedData.headers.map(h => [h, h])) }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body')}>
                      <SelectValue placeholder="Não mapear (opcional)" />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg max-h-48 border border-line-subtle">
                      <SelectItem value="__none__">Não mapear</SelectItem>
                      {parsedData.headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {importStats.rowsWithMultipleTags > 0 && tagsCol && (
                    <p className="text-micro text-purple-300">{importStats.rowsWithMultipleTags} linha(s) têm múltiplas tags e serão separadas.</p>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg flex items-center gap-1.5">
                    <Database size={12} className="text-cyan-400" />
                    Origem original
                  </label>
                  <Select
                    value={sourceCol || '__none__'}
                    onValueChange={v => setSourceCol(!v || v === '__none__' ? '' : v)}
                    items={{ __none__: 'Usar canal selecionado abaixo', ...Object.fromEntries(parsedData.headers.map(h => [h, h])) }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body')}>
                      <SelectValue placeholder="Usar canal selecionado abaixo" />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg max-h-48 border border-line-subtle">
                      <SelectItem value="__none__">Usar canal selecionado abaixo</SelectItem>
                      {parsedData.headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg flex items-center gap-1.5">
                    <Database size={12} className="text-sky-400" />
                    ID externo
                  </label>
                  <Select
                    value={externalIdCol || '__none__'}
                    onValueChange={v => setExternalIdCol(!v || v === '__none__' ? '' : v)}
                    items={{ __none__: 'Não preservar (opcional)', ...Object.fromEntries(parsedData.headers.map(h => [h, h])) }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body')}>
                      <SelectValue placeholder="Não preservar (opcional)" />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg max-h-48 border border-line-subtle">
                      <SelectItem value="__none__">Não preservar</SelectItem>
                      {parsedData.headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg flex items-center gap-1.5">
                    <CalendarDays size={12} className="text-amber-400" />
                    Data original
                  </label>
                  <Select
                    value={createdAtCol || '__none__'}
                    onValueChange={v => setCreatedAtCol(!v || v === '__none__' ? '' : v)}
                    items={{ __none__: 'Não preservar (opcional)', ...Object.fromEntries(parsedData.headers.map(h => [h, h])) }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body')}>
                      <SelectValue placeholder="Não preservar (opcional)" />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg max-h-48 border border-line-subtle">
                      <SelectItem value="__none__">Não preservar</SelectItem>
                      {parsedData.headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="space-y-3 pt-2 border-t border-line-subtle">
              <span className="text-label uppercase text-fg-subtle font-bold block">Classificação do registro</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg">O que esta base representa?</label>
                  <Select
                    value={recordType}
                    onValueChange={v => setRecordType(v === 'closed_sale' ? 'closed_sale' : 'lead')}
                    items={{ lead: 'Contato / Lead', closed_sale: 'Venda fechada / Curso comprado' }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg border border-line-subtle">
                      <SelectItem value="lead">Contato / Lead</SelectItem>
                      <SelectItem value="closed_sale">Venda fechada / Curso comprado</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg">Plataforma</label>
                  <Select
                    value={recordPlatform}
                    onValueChange={v => v && setRecordPlatform(v)}
                    items={{
                      import_planilha: 'Importação de planilha',
                      kiwify: 'Kiwify',
                      hotmart: 'Hotmart',
                      greenn: 'Greenn',
                      zouti: 'Zouti',
                    }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg border border-line-subtle">
                      <SelectItem value="import_planilha">Importação de planilha</SelectItem>
                      <SelectItem value="kiwify">Kiwify</SelectItem>
                      <SelectItem value="hotmart">Hotmart</SelectItem>
                      <SelectItem value="greenn">Greenn</SelectItem>
                      <SelectItem value="zouti">Zouti</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {recordType === 'closed_sale' ? (
                <p className="rounded-[var(--r-md)] border border-emerald-500/30 bg-emerald-500/5 p-3 text-micro text-emerald-300">
                  Esses contatos entrarão como compra aprovada, com status confirmado e etapa Fechado. Eles não serão tratados como recuperação.
                </p>
              ) : (
                <p className="text-micro text-fg-subtle">Contatos comuns entram como leads e só mudam de etapa quando houver atendimento, agendamento ou venda.</p>
              )}
            </div>

            {/* 2. Origem & Automação opcional */}
            <div className="space-y-3 pt-2 border-t border-line-subtle">
              <span className="text-label uppercase text-fg-subtle font-bold block">2. Origem da importação</span>
              
              <div className="space-y-1">
                  <label className="text-micro font-bold text-fg">Canal de Origem:</label>
                  <Select
                    value={defaultSource}
                    onValueChange={v => v && setDefaultSource(v)}
                    items={{
                      mineracao: '⛏️ Mineração (Outreach & Base Fria)',
                      meta_ads: '📱 Anúncios Meta Ads (Instagram/FB)',
                      google_ads: '🔍 Google Ads & YouTube',
                      lista_vip: '⭐ Lista VIP / Base de Clientes',
                      planilha_externa: '📄 Planilha Externa / Parceiros',
                    }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg border border-line-subtle">
                      <SelectItem value="mineracao">⛏️ Mineração (Outreach & Base Fria)</SelectItem>
                      <SelectItem value="meta_ads">📱 Anúncios Meta Ads (Instagram/FB)</SelectItem>
                      <SelectItem value="google_ads">🔍 Google Ads & YouTube</SelectItem>
                      <SelectItem value="lista_vip">⭐ Lista VIP / Base de Clientes</SelectItem>
                      <SelectItem value="planilha_externa">📄 Planilha Externa / Parceiros</SelectItem>
                    </SelectContent>
                  </Select>
                  {sourceCol && (
                    <p className="text-micro text-cyan-300">A origem desta coluna será preservada por contato; o canal abaixo será usado como fallback.</p>
                  )}
              </div>

              <div className="flex items-start gap-2.5 p-3 rounded-[var(--r-md)] bg-surface-inset border border-line-subtle mt-2">
                <AlertCircle size={17} className="mt-0.5 shrink-0 text-amber-400" />
                <div>
                  <span className="text-body font-bold text-fg block">A importação não envia mensagens</span>
                  <span className="text-micro text-fg-subtle block">
                    Quando o disparo em massa estiver marcado, o upload cria apenas um lote em rascunho. O envio exige preview e confirmação separada.
                  </span>
                </div>
              </div>

              <label className="flex items-center gap-2.5 p-3 rounded-[var(--r-md)] bg-surface-inset border border-line-subtle cursor-pointer mt-2">
                <input
                  type="checkbox"
                  checked={createMassDispatch}
                  onChange={e => setCreateMassDispatch(e.target.checked)}
                  className="rounded border-line-default text-brand-solid focus:ring-brand-ink h-4 w-4"
                />
                <div>
                  <span className="text-body font-bold text-fg block">Preparar disparo em massa para este CSV</span>
                  <span className="text-micro text-fg-subtle block">
                    Cria um lote draft com os destinatários importados. Nada é enviado até a confirmação explícita no preview.
                  </span>
                </div>
              </label>

              {createMassDispatch && (
                <div className="rounded-[var(--r-md)] border border-cyan-500/30 bg-cyan-500/5 p-3 space-y-2">
                  <span className="text-micro font-bold text-cyan-300 block">Configuração do disparo em massa</span>
                  <label className="text-micro font-bold text-fg block">Tipo de evento da sequência *</label>
                  <Select
                    value={defaultEventType || '__none__'}
                    onValueChange={v => setDefaultEventType(!v || v === '__none__' ? '' : v)}
                    items={{
                      __none__: 'Selecione o evento da sequência...',
                      carrinho_abandonado: 'Carrinho Abandonado (Recuperação)',
                      boleto: 'Boleto Bancário',
                      pix: 'Pix Gerado Pendente',
                      cartao_recusado: 'Cartão de Crédito Recusado',
                      compra_aprovada: 'Compra Aprovada (Onboarding/Upsell)',
                    }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body', !defaultEventType && 'border-rose-500/50')}>
                      <SelectValue placeholder="Selecione o evento da sequência..." />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg border border-line-subtle">
                      <SelectItem value="__none__">Selecione o evento da sequência...</SelectItem>
                      <SelectItem value="carrinho_abandonado">Carrinho Abandonado (Recuperação)</SelectItem>
                      <SelectItem value="boleto">Boleto Bancário</SelectItem>
                      <SelectItem value="pix">Pix Gerado Pendente</SelectItem>
                      <SelectItem value="cartao_recusado">Cartão de Crédito Recusado</SelectItem>
                      <SelectItem value="compra_aprovada">Compra Aprovada (Onboarding/Upsell)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-micro text-fg-subtle">
                    Este evento só será usado para montar o lote e localizar a sequência. Sem disparo em massa, a importação não recebe evento específico.
                  </p>
                </div>
              )}
            </div>

            {/* 3. Tag opcional, independente do evento */}
            <div className="space-y-3 pt-2 border-t border-line-subtle">
              <span className="text-label uppercase text-fg-subtle font-bold block">3. Tag extra para todos (opcional)</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg">Tag para todos os contatos</label>
                  <Input
                    value={batchTag}
                    onChange={e => setBatchTag(e.target.value)}
                    maxLength={50}
                    placeholder="Ex: vip"
                    className={cn(FIELD, CONTROL_H, 'text-body')}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-micro font-bold text-fg">Escopo da tag</label>
                  <Select
                    value={tagScopeChannel || '__general__'}
                    onValueChange={v => setTagScopeChannel(!v || v === '__general__' ? '' : v)}
                    disabled={!batchTag.trim()}
                    items={{
                      __general__: 'Geral (todos os canais)',
                      whatsapp: 'WhatsApp',
                      instagram: 'Instagram',
                      email: 'E-mail',
                      mineracao: 'Mineração',
                    }}
                  >
                    <SelectTrigger className={cn(FIELD, CONTROL_H, 'text-body')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-surface-overlay text-fg border border-line-subtle">
                      <SelectItem value="__general__">Geral (todos os canais)</SelectItem>
                      <SelectItem value="whatsapp">WhatsApp</SelectItem>
                      <SelectItem value="instagram">Instagram</SelectItem>
                      <SelectItem value="email">E-mail</SelectItem>
                      <SelectItem value="mineracao">Mineração</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-micro text-fg-subtle">As tags da planilha são preservadas por contato. Esta tag extra será aplicada aos contatos novos e existentes.</p>
            </div>

            {/* Ações */}
            <div className="flex justify-between items-center pt-3 border-t border-line-subtle">
              <Button variant="ghost" onClick={() => setStep('upload')} className={cn(CONTROL_H, 'px-4')}>
                <ArrowLeft size={14} className="mr-1.5" /> Voltar
              </Button>
              <Button
                onClick={handleImport}
                disabled={!phoneCol || isProcessing}
                className={cn(CONTROL_H, 'px-6 bg-cyan-500 hover:bg-cyan-400 text-black font-bold')}
              >
                Importar {importStats.phoneRows} Contato{importStats.phoneRows === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        )}

        {/* ─── PASSO 3: PROCESSANDO ─── */}
        {step === 'importing' && (
          <div className="py-12 text-center space-y-4">
            <div className="h-14 w-14 rounded-full bg-cyan-500/10 text-cyan-400 flex items-center justify-center mx-auto animate-spin">
              <Sparkles size={26} />
            </div>
            <div>
              <p className="text-h2 text-fg font-bold">Importando contatos...</p>
              <p className="text-body text-fg-muted mt-1">Normalizando telefones, validando DDDs e gravando no banco isolado da empresa.</p>
            </div>
          </div>
        )}

        {/* ─── PASSO 4: RESULTADO ─── */}
        {step === 'result' && importResult && (
          <div className="space-y-5 pt-2">
            <div className="text-center space-y-2 py-4">
              <div className="h-12 w-12 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center mx-auto">
                <CheckCircle2 size={26} />
              </div>
              <p className="text-h2 text-fg font-bold">
                {importResult.tagFailed > 0 || importResult.dispatchRecipientFailed > 0 ? 'Importação concluída com ressalvas' : 'Importação Concluída com Sucesso!'}
              </p>
              <p className="text-micro text-fg-muted">Os contatos já estão disponíveis no painel de Leads, Pipeline e Origens.</p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="panel p-3.5 rounded-[var(--r-md)] border border-line-subtle bg-surface-panel text-center">
                <span className="text-label uppercase text-fg-subtle font-bold block">Novos Inseridos</span>
                <span className="num text-h2 font-bold text-emerald-400 mt-1 block">{importResult.inserted}</span>
              </div>
              <div className="panel p-3.5 rounded-[var(--r-md)] border border-line-subtle bg-surface-panel text-center">
                <span className="text-label uppercase text-fg-subtle font-bold block">Atualizados</span>
                <span className="num text-h2 font-bold text-cyan-400 mt-1 block">{importResult.updated}</span>
              </div>
              <div className="panel p-3.5 rounded-[var(--r-md)] border border-line-subtle bg-surface-panel text-center">
                <span className="text-label uppercase text-fg-subtle font-bold block">Ignorados / Inválidos</span>
                <span className="num text-h2 font-bold text-fg-subtle mt-1 block">{importResult.skipped}</span>
              </div>
            </div>

            {importResult.tagFailed > 0 && (
              <div className="rounded-[var(--r-md)] border border-amber-500/40 bg-amber-500/10 p-3 text-body text-amber-600 dark:text-amber-400">
                <p className="font-semibold">
                  {importResult.tagFailed} contato(s) foram salvos, mas a tag não pôde ser aplicada.
                </p>
                {importResult.errors.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-micro">
                    {importResult.errors.map((error, index) => <li key={index}>{error}</li>)}
                  </ul>
                )}
              </div>
            )}

            {importResult.dispatchRecipientFailed > 0 && (
              <div className="rounded-[var(--r-md)] border border-amber-500/40 bg-amber-500/10 p-3 text-body text-amber-600 dark:text-amber-400">
                <p className="font-semibold">
                  {importResult.dispatchRecipientFailed} contato(s) foram salvos, mas não entraram no lote de disparo.
                </p>
                {importResult.errors.length > 0 && importResult.tagFailed === 0 && (
                  <ul className="mt-1 list-disc pl-5 text-micro">
                    {importResult.errors.map((error, index) => <li key={index}>{error}</li>)}
                  </ul>
                )}
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2 pt-3 border-t border-line-subtle">
              <Button
                onClick={() => { onOpenChange(false); resetModal(); }}
                variant={importResult.batchId ? 'outline' : 'default'}
                className={cn(CONTROL_H, 'px-5', !importResult.batchId && 'bg-brand-solid text-black font-bold')}
              >
                {importResult.batchId ? 'Fechar sem disparar' : 'Concluir & Fechar'}
              </Button>
              {importResult.batchId && (
                <Button
                  onClick={handleLoadPreview}
                  disabled={isProcessing || importResult.recipientCount === 0}
                  className={cn(CONTROL_H, 'px-5 bg-cyan-500 hover:bg-cyan-400 text-black font-bold')}
                >
                  {isProcessing ? 'Carregando...' : 'Ver preview do disparo'}
                  <ChevronRight size={15} className="ml-1" />
                </Button>
              )}
            </div>
          </div>
        )}

        {step === 'preview' && importResult && dispatchPreview && (
          <div className="space-y-4 pt-3">
            <div className="rounded-[var(--r-md)] border border-amber-500/40 bg-amber-500/10 p-4">
              <p className="text-body font-bold text-fg">Confirme antes de colocar na fila</p>
              <p className="text-micro text-fg-muted mt-1">
                {dispatchPreview.recipientCount} destinatários · {dispatchPreview.messageCount} mensagens por destinatário · {dispatchPreview.totalJobs} envios agendados no total.
              </p>
            </div>

            <div className="space-y-2">
              <span className="text-label uppercase text-fg-subtle font-bold">Mensagens que serão enviadas</span>
              {dispatchPreview.messages.length === 0 ? (
                <p className="rounded-[var(--r-md)] border border-rose-500/40 bg-rose-500/10 p-3 text-body text-fg">
                  Nenhuma mensagem ativa está configurada para este tipo de evento.
                </p>
              ) : dispatchPreview.messages.map(message => (
                <div key={message.id} className="rounded-[var(--r-md)] border border-line-subtle bg-surface-panel p-3">
                  <p className="text-micro font-bold text-fg">
                    Mensagem {message.order} · {message.messageType === 'template' ? `Template ${message.templateName || ''}` : message.messageType}
                    {message.delayMinutes > 0 ? ` · após ${message.delayMinutes} min` : ' · imediata'}
                  </p>
                  <p className="text-body text-fg-muted mt-2 whitespace-pre-wrap">{message.content || '(conteúdo definido pelo template)'}</p>
                </div>
              ))}
            </div>

            <label className="flex items-start gap-2.5 p-3 rounded-[var(--r-md)] bg-surface-inset border border-line-subtle cursor-pointer">
              <input
                type="checkbox"
                checked={dispatchConfirmed}
                onChange={event => setDispatchConfirmed(event.target.checked)}
                className="mt-0.5 rounded border-line-default text-brand-solid focus:ring-brand-ink h-4 w-4"
              />
              <span className="text-body text-fg">Confirmo o disparo real para os {dispatchPreview.recipientCount} contatos desta lista.</span>
            </label>

            <div className="flex justify-between gap-2 pt-3 border-t border-line-subtle">
              <Button variant="ghost" onClick={() => setStep('result')} className={cn(CONTROL_H, 'px-4')}>
                <ArrowLeft size={14} className="mr-1.5" /> Voltar
              </Button>
              <Button
                onClick={handleConfirmDispatch}
                disabled={!dispatchConfirmed || dispatchPreview.messageCount === 0 || isProcessing}
                className={cn(CONTROL_H, 'px-5 bg-rose-500 hover:bg-rose-400 text-white font-bold')}
              >
                {isProcessing ? 'Enfileirando...' : 'Iniciar disparo desta lista'}
              </Button>
            </div>
          </div>
        )}

        {step === 'queued' && dispatchPreview && (
          <div className="py-8 text-center space-y-4">
            <div className="h-12 w-12 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center mx-auto">
              <CheckCircle2 size={26} />
            </div>
            <div>
              <p className="text-h2 text-fg font-bold">Disparo colocado na fila</p>
              <p className="text-body text-fg-muted mt-1">
                {jobsCreated} jobs foram criados. O executor processa no máximo 50 por rodada e registra sucesso ou falha individualmente.
              </p>
            </div>
            <Button onClick={() => { onOpenChange(false); resetModal() }} className={cn(CONTROL_H, 'px-6 bg-brand-solid text-black font-bold')}>
              Concluir & Fechar
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
