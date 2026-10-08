"use client"

import { useState, useEffect } from "react"
import {
  User,
  Phone,
  Mail,
  DollarSign,
  Package,
  CheckCircle2,
  AlertCircle,
  Tag,
  Share2,
  Compass,
  MessageSquare,
  Clock,
  FileText,
  Calendar,
  ExternalLink,
  CreditCard,
  Edit,
} from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { EVENT_TYPE_OPTIONS, SOURCE_OPTIONS, MEDIUM_OPTIONS } from "./AddLeadModal"
import Link from "next/link"

export interface LeadForEdit {
  id: number
  phone: string
  name?: string | null
  email?: string | null
  productName?: string | null
  productValue?: number | null
  paymentType?: string | null
  eventType?: string
  status?: string | null
  platform?: string | null
  trackingSource?: string | null
  utmMedium?: string | null
  pipelineStage?: string | null
  notes?: string | null
  followUpDate?: string | null
  followUpNote?: string | null
  requestSummary?: string | null
  commitment?: string | null
  nextAction?: string | null
  nextActionDueAt?: string | null
  sacCaseState?: string | null
  createdAt?: string | null
}

interface EditLeadModalProps {
  lead: LeadForEdit | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

const STATUS_SELECT_OPTIONS: Record<string, string> = {
  pending: "Aguardando Abordagem",
  in_progress: "Em Atendimento",
  converted: "Convertido / Venda Fechada",
  completed: "Sem Conversão / Concluído",
  failed: "Falhou / Descartado",
}

const PAYMENT_TYPE_OPTIONS: Record<string, string> = {
  pix: "⚡ Pix",
  cartao_credito: "💳 Cartão de Crédito",
  boleto: "📄 Boleto Bancário",
  debit_card: "💳 Cartão de Débito",
  paypal: "🌐 PayPal",
  outro: "Outro",
}

export function EditLeadModal({ lead, open, onOpenChange, onSuccess }: EditLeadModalProps) {
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [productName, setProductName] = useState("")
  const [productValue, setProductValue] = useState("")
  const [eventType, setEventType] = useState("mentoria")
  const [status, setStatus] = useState("pending")
  const [pipelineStage, setPipelineStage] = useState("")
  const [paymentType, setPaymentType] = useState("pix")
  const [trackingSource, setTrackingSource] = useState("indicacao")
  const [utmMedium, setUtmMedium] = useState("indicacao")
  const [platform, setPlatform] = useState("")
  const [notes, setNotes] = useState("")

  // Contexto SAC
  const [requestSummary, setRequestSummary] = useState("")
  const [commitment, setCommitment] = useState("")
  const [nextAction, setNextAction] = useState("")
  const [nextActionDueAt, setNextActionDueAt] = useState("")
  const [followUpDate, setFollowUpDate] = useState("")
  const [followUpNote, setFollowUpNote] = useState("")

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [successMsg, setSuccessMsg] = useState("")

  useEffect(() => {
    if (!lead) return
    setName(lead.name || "")
    setPhone(lead.phone || "")
    setEmail(lead.email || "")
    setProductName(lead.productName || "")
    setProductValue(lead.productValue != null ? (lead.productValue / 100).toFixed(2).replace('.', ',') : "")
    setEventType(lead.eventType || "mentoria")
    setStatus(lead.status || "pending")
    setPipelineStage(lead.pipelineStage || "")
    setPaymentType(lead.paymentType || "pix")
    setTrackingSource(lead.trackingSource || "indicacao")
    setUtmMedium(lead.utmMedium || "indicacao")
    setPlatform(lead.platform || "")
    setNotes(lead.notes || "")
    setRequestSummary(lead.requestSummary || "")
    setCommitment(lead.commitment || "")
    setNextAction(lead.nextAction || "")
    setNextActionDueAt(lead.nextActionDueAt ? lead.nextActionDueAt.slice(0, 10) : "")
    setFollowUpDate(lead.followUpDate ? lead.followUpDate.slice(0, 10) : "")
    setFollowUpNote(lead.followUpNote || "")
    setError("")
    setSuccessMsg("")
  }, [lead])

  if (!lead) return null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setSuccessMsg("")

    if (!phone.trim()) {
      setError("O telefone / WhatsApp é obrigatório.")
      return
    }

    setSaving(true)

    try {
      const res = await fetch(`/api/leads/${lead!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || null,
          phone: phone.trim(),
          email: email.trim() || null,
          productName: productName.trim() || null,
          productValue: productValue.trim() || null,
          eventType,
          status,
          pipelineStage: pipelineStage || undefined,
          paymentType,
          trackingSource,
          utmMedium,
          platform: platform.trim() || null,
          notes: notes.trim() || null,
          requestSummary: requestSummary.trim() || null,
          commitment: commitment.trim() || null,
          nextAction: nextAction.trim() || null,
          nextActionDueAt: nextActionDueAt || null,
          followUpDate: followUpDate || null,
          followUpNote: followUpNote.trim() || null,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || "Erro ao salvar alterações do lead.")
        setSaving(false)
        return
      }

      setSuccessMsg("Lead atualizado com sucesso!")
      setTimeout(() => {
        onOpenChange(false)
        onSuccess()
      }, 600)
    } catch (err: any) {
      setError(err.message || "Erro de conexão ao salvar lead.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl md:max-w-3xl w-[96vw] bg-surface-overlay border border-line-subtle p-0 overflow-hidden shadow-2xl rounded-2xl max-h-[92vh] flex flex-col">
        {/* Header com ações rápidas */}
        <DialogHeader className="px-5 py-4 sm:px-6 sm:py-4.5 bg-surface-panel border-b border-line-subtle shrink-0">
          <div className="flex items-center justify-between gap-3 pr-8">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-brand-glow border border-brand-solid/30 flex items-center justify-center text-brand-ink shrink-0">
                <Edit size={20} />
              </div>
              <div>
                <DialogTitle className="text-base sm:text-lg text-fg font-bold leading-tight">
                  Editar Lead #{lead.id}
                </DialogTitle>
                <p className="text-micro text-fg-subtle mt-0.5 font-mono">
                  {lead.phone} {lead.name ? `• ${lead.name}` : ""}
                </p>
              </div>
            </div>

            <Link
              href={`/inbox/${lead.id}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-raised border border-line-subtle text-micro font-semibold text-brand-ink hover:bg-surface-inset transition-colors shrink-0"
            >
              <MessageSquare size={14} />
              <span>Abrir no Inbox</span>
              <ExternalLink size={12} />
            </Link>
          </div>
        </DialogHeader>

        {/* Formulário com Scroll */}
        <form id="edit-lead-form" onSubmit={handleSubmit} className="px-5 py-4 sm:px-6 sm:py-5 space-y-4 overflow-y-auto flex-1 overscroll-contain">
          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-micro flex items-center gap-2">
              <AlertCircle size={15} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {successMsg && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-micro flex items-center gap-2">
              <CheckCircle2 size={15} className="shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Seção 1: Contato e Identificação */}
          <div className="p-3.5 sm:p-4 rounded-xl bg-surface-panel border border-line-subtle space-y-3">
            <span className="text-[11px] font-bold text-brand-ink uppercase tracking-wider block">
              1. Dados do Contato
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5 sm:col-span-1">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <User size={13} className="text-fg-subtle" /> Nome
                </Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nome do cliente"
                  className="bg-surface-inset border-line-subtle h-10 text-sm"
                />
              </div>

              <div className="space-y-1.5 sm:col-span-1">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <Phone size={13} className="text-emerald-400" /> WhatsApp / Tel <span className="text-red-400">*</span>
                </Label>
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Ex: 5511999998888"
                  className="bg-surface-inset border-line-subtle h-10 text-sm font-mono"
                  required
                />
              </div>

              <div className="space-y-1.5 sm:col-span-1">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <Mail size={13} className="text-indigo-400" /> E-mail
                </Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="cliente@email.com"
                  className="bg-surface-inset border-line-subtle h-10 text-sm"
                />
              </div>
            </div>
          </div>

          {/* Seção 2: Produto, Valor e Status Comercial */}
          <div className="p-3.5 sm:p-4 rounded-xl bg-surface-panel border border-line-subtle space-y-3">
            <span className="text-[11px] font-bold text-brand-ink uppercase tracking-wider block">
              2. Venda, Produto & Status
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <Package size={13} className="text-fg-subtle" /> Produto / Oferta
                </Label>
                <Input
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder="Ex: Mentoria VIP"
                  className="bg-surface-inset border-line-subtle h-10 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <DollarSign size={13} className="text-brand-ink" /> Valor (R$)
                </Label>
                <Input
                  value={productValue}
                  onChange={(e) => setProductValue(e.target.value)}
                  placeholder="Ex: 1500,00"
                  className="bg-surface-inset border-line-subtle h-10 text-sm font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <Tag size={13} className="text-amber-400" /> Status Comercial
                </Label>
                <Select value={status} onValueChange={(v) => v && setStatus(v)} items={STATUS_SELECT_OPTIONS}>
                  <SelectTrigger className="bg-surface-inset border-line-subtle h-10 text-xs sm:text-sm w-full font-medium">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-surface-overlay border-line-subtle">
                    {Object.entries(STATUS_SELECT_OPTIONS).map(([val, label]) => (
                      <SelectItem key={val} value={val} className="text-xs sm:text-sm py-2">
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <CreditCard size={13} className="text-cyan-400" /> Forma de Pagamento
                </Label>
                <Select value={paymentType} onValueChange={(v) => v && setPaymentType(v)} items={PAYMENT_TYPE_OPTIONS}>
                  <SelectTrigger className="bg-surface-inset border-line-subtle h-10 text-xs sm:text-sm w-full font-medium">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-surface-overlay border-line-subtle">
                    {Object.entries(PAYMENT_TYPE_OPTIONS).map(([val, label]) => (
                      <SelectItem key={val} value={val} className="text-xs sm:text-sm py-2">
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <Compass size={13} className="text-blue-400" /> Origem
                </Label>
                <Select value={trackingSource} onValueChange={(v) => v && setTrackingSource(v)} items={SOURCE_OPTIONS}>
                  <SelectTrigger className="bg-surface-inset border-line-subtle h-10 text-xs sm:text-sm w-full font-medium">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-surface-overlay border-line-subtle max-h-64">
                    {Object.entries(SOURCE_OPTIONS).map(([val, label]) => (
                      <SelectItem key={val} value={val} className="text-xs sm:text-sm py-2">
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <Share2 size={13} className="text-purple-400" /> Canal de Abordagem
                </Label>
                <Select value={utmMedium} onValueChange={(v) => v && setUtmMedium(v)} items={MEDIUM_OPTIONS}>
                  <SelectTrigger className="bg-surface-inset border-line-subtle h-10 text-xs sm:text-sm w-full font-medium">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-surface-overlay border-line-subtle max-h-64">
                    {Object.entries(MEDIUM_OPTIONS).map(([val, label]) => (
                      <SelectItem key={val} value={val} className="text-xs sm:text-sm py-2">
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Seção 3: Card de Contexto SAC & Operação */}
          <div className="p-3.5 sm:p-4 rounded-xl bg-surface-panel border border-line-subtle space-y-3">
            <span className="text-[11px] font-bold text-brand-ink uppercase tracking-wider block">
              3. Atendimento & Contexto SAC
            </span>

            <div className="space-y-1.5">
              <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                <FileText size={13} className="text-fg-subtle" /> Pedido do Cliente (O que ele precisa)
              </Label>
              <Input
                value={requestSummary}
                onChange={(e) => setRequestSummary(e.target.value)}
                placeholder="Ex: Quer agendar para terça ou parcelar via Pix"
                className="bg-surface-inset border-line-subtle h-10 text-sm"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <CheckCircle2 size={13} className="text-emerald-400" /> Compromisso Assumido
                </Label>
                <Input
                  value={commitment}
                  onChange={(e) => setCommitment(e.target.value)}
                  placeholder="Ex: Enviar link com desconto até 16h"
                  className="bg-surface-inset border-line-subtle h-10 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <Clock size={13} className="text-amber-400" /> Próxima Ação
                </Label>
                <Input
                  value={nextAction}
                  onChange={(e) => setNextAction(e.target.value)}
                  placeholder="Ex: Cobrar retorno do link"
                  className="bg-surface-inset border-line-subtle h-10 text-sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <Calendar size={13} className="text-blue-400" /> Prazo da Ação
                </Label>
                <Input
                  type="date"
                  value={nextActionDueAt}
                  onChange={(e) => setNextActionDueAt(e.target.value)}
                  className="bg-surface-inset border-line-subtle h-10 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <Calendar size={13} className="text-purple-400" /> Data de Retorno
                </Label>
                <Input
                  type="date"
                  value={followUpDate}
                  onChange={(e) => setFollowUpDate(e.target.value)}
                  className="bg-surface-inset border-line-subtle h-10 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <Clock size={13} className="text-purple-400" /> Motivo do Retorno
                </Label>
                <Input
                  value={followUpNote}
                  onChange={(e) => setFollowUpNote(e.target.value)}
                  placeholder="Ex: Aguardar pagamento"
                  className="bg-surface-inset border-line-subtle h-10 text-sm"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                Observações Gerais do CRM
              </Label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Anotações internas sobre o lead..."
                className="w-full rounded-lg bg-surface-inset border border-line-subtle p-2.5 text-sm text-fg focus:outline-none focus:border-brand-solid"
              />
            </div>
          </div>
        </form>

        {/* Footer Fixo */}
        <div className="px-5 py-3.5 sm:px-6 sm:py-4 bg-surface-panel border-t border-line-subtle shrink-0 flex items-center justify-end gap-2.5">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-line-subtle bg-surface-inset hover:bg-surface-panel text-fg h-10 px-4 text-xs sm:text-sm font-medium"
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            form="edit-lead-form"
            disabled={saving || !phone.trim()}
            className="bg-brand-solid hover:bg-brand-solid/90 text-on-accent font-bold h-10 px-5 gap-1.5 text-xs sm:text-sm shadow-sm"
          >
            <CheckCircle2 size={16} />
            {saving ? "Salvando..." : "Salvar Alterações"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
