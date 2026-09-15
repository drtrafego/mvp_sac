"use client"

import { useState } from "react"
import {
  UserPlus,
  User,
  Phone,
  Mail,
  DollarSign,
  Package,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  X,
  Zap,
  MessageSquare,
  Layers
} from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

function InstagramIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5"/>
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5"/>
    </svg>
  )
}

interface AddLeadModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

const EVENT_TYPE_OPTIONS: Record<string, string> = {
  carrinho_abandonado: "🛒 Carrinho Abandonado",
  pix: "⚡ Pix Pendente",
  boleto: "📄 Boleto Gerado",
  cartao_recusado: "💳 Cartão Recusado",
  compra_aprovada: "🎉 Compra Aprovada (Pós-venda)",
}

const SOURCE_OPTIONS: Record<string, string> = {
  mineracao: "⛏️ Mineração (Outreach / Prospecção Fria)",
  meta_ads: "📱 Meta Ads (Instagram / Facebook)",
  instagram: "📸 Instagram Direct (Orgânico)",
  email: "✉️ E-mail Marketing / Brevo",
  hotmart: "🔥 Hotmart",
  kiwify: "🥝 Kiwify",
  greenn: "🌿 Greenn",
  zouti: "⚡ Zouti",
  organico: "🌐 Direto / Orgânico",
}

const MEDIUM_OPTIONS: Record<string, string> = {
  whatsapp: "💬 WhatsApp Outreach",
  email: "✉️ E-mail Frio (Brevo)",
  instagram: "📸 Instagram Direct",
}

export function AddLeadModal({ open, onOpenChange, onSuccess }: AddLeadModalProps) {
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [productName, setProductName] = useState("")
  const [productValue, setProductValue] = useState("")
  const [eventType, setEventType] = useState("carrinho_abandonado")
  const [trackingSource, setTrackingSource] = useState("mineracao")
  const [utmMedium, setUtmMedium] = useState("whatsapp")
  const [triggerSequence, setTriggerSequence] = useState(false)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [successMsg, setSuccessMsg] = useState("")

  function reset() {
    setName("")
    setPhone("")
    setEmail("")
    setProductName("")
    setProductValue("")
    setEventType("carrinho_abandonado")
    setTrackingSource("mineracao")
    setUtmMedium("whatsapp")
    setTriggerSequence(false)
    setError("")
    setSuccessMsg("")
  }

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
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          phone: phone.trim(),
          email: email.trim() || undefined,
          productName: productName.trim() || "Produto Principal",
          productValue: productValue.trim() || "0",
          eventType,
          trackingSource,
          utmMedium,
          triggerSequence,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || "Erro ao cadastrar lead.")
        setSaving(false)
        return
      }

      setSuccessMsg("Lead cadastrado com sucesso!")
      setTimeout(() => {
        reset()
        onOpenChange(false)
        onSuccess()
      }, 900)
    } catch (err: any) {
      setError(err.message || "Erro de conexão ao salvar lead.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) reset(); onOpenChange(val); }}>
      <DialogContent className="max-w-lg bg-surface-overlay border-line-subtle p-0 overflow-hidden shadow-2xl rounded-2xl max-h-[90vh] flex flex-col">
        <DialogHeader className="p-5 bg-surface-panel border-b border-line-subtle flex flex-row items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-brand-glow border border-brand-solid/30 flex items-center justify-center text-brand-ink">
              <UserPlus size={18} />
            </div>
            <div>
              <DialogTitle className="text-h3 text-fg font-bold">Adicionar Lead Manualmente (1x1)</DialogTitle>
              <p className="text-micro text-fg-subtle mt-0.5">Cadastre um contato para atendimento, prospecção ou recuperação imediata.</p>
            </div>
          </div>
          <button type="button" onClick={() => onOpenChange(false)} className="focus-ring text-fg-subtle hover:text-fg p-1.5 rounded-lg hover:bg-surface-inset">
            <X size={16} />
          </button>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto flex-1">
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

          {/* Nome e Telefone */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                <User size={13} className="text-fg-subtle" /> Nome Completo
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="João da Silva"
                className="bg-surface-inset border-line-subtle h-10 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                <Phone size={13} className="text-emerald-400" /> WhatsApp / Telefone <span className="text-red-400">*</span>
              </Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(11) 99999-8888"
                className="bg-surface-inset border-line-subtle h-10 text-sm font-mono"
                required
              />
            </div>
          </div>

          {/* E-mail */}
          <div className="space-y-1.5">
            <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
              <Mail size={13} className="text-indigo-400" /> E-mail do Lead (Opcional)
            </Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="cliente@exemplo.com.br"
              className="bg-surface-inset border-line-subtle h-10 text-sm"
            />
          </div>

          {/* Tipo de Evento e Origem */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-micro font-semibold text-fg">Tipo de Evento / Situação</Label>
              <Select value={eventType} onValueChange={(v) => v && setEventType(v)} items={EVENT_TYPE_OPTIONS}>
                <SelectTrigger className="bg-surface-inset border-line-subtle h-10 text-micro w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-overlay border-line-subtle">
                  {Object.entries(EVENT_TYPE_OPTIONS).map(([val, label]) => (
                    <SelectItem key={val} value={val}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-micro font-semibold text-fg">Origem de Aquisição</Label>
              <Select value={trackingSource} onValueChange={(v) => v && setTrackingSource(v)} items={SOURCE_OPTIONS}>
                <SelectTrigger className="bg-surface-inset border-line-subtle h-10 text-micro w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-overlay border-line-subtle">
                  {Object.entries(SOURCE_OPTIONS).map(([val, label]) => (
                    <SelectItem key={val} value={val}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Subcategoria / Canal de Abordagem */}
          <div className="space-y-1.5">
            <Label className="text-micro font-semibold text-fg">Subcategoria / Canal de Abordagem</Label>
            <Select value={utmMedium} onValueChange={(v) => v && setUtmMedium(v)} items={MEDIUM_OPTIONS}>
              <SelectTrigger className="bg-surface-inset border-line-subtle h-10 text-micro w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-surface-overlay border-line-subtle">
                {Object.entries(MEDIUM_OPTIONS).map(([val, label]) => (
                  <SelectItem key={val} value={val}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-fg-subtle">Define por onde você abordará este lead (usado no rastreamento e métricas de conversão).</p>
          </div>

          {/* Produto e Valor */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                <Package size={13} className="text-fg-subtle" /> Produto
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
                placeholder="Ex: 497,00"
                className="bg-surface-inset border-line-subtle h-10 text-sm"
              />
            </div>
          </div>

          {/* Disparo de Sequência Automática */}
          <div className="p-3 rounded-xl bg-surface-inset border border-line-subtle flex items-start gap-3 mt-2">
            <input
              type="checkbox"
              id="triggerSequence"
              checked={triggerSequence}
              onChange={(e) => setTriggerSequence(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-line-subtle text-brand-solid focus:ring-brand-solid cursor-pointer"
            />
            <label htmlFor="triggerSequence" className="text-micro text-fg cursor-pointer select-none space-y-0.5 block">
              <span className="font-bold flex items-center gap-1">
                <Zap size={13} className="text-amber-400" /> Iniciar sequência automática imediatamente
              </span>
              <span className="text-fg-subtle block text-[11px]">
                Se houver uma sequência ativa para este tipo de evento, as mensagens programadas serão enfileiradas automaticamente para envio.
              </span>
            </label>
          </div>

          <div className="pt-3 border-t border-line-subtle flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-line-subtle bg-surface-panel hover:bg-surface-inset text-fg h-10"
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={saving || !phone.trim()}
              className="bg-brand-solid hover:bg-brand-solid/90 text-on-accent font-bold h-10 px-5 gap-1.5"
            >
              <UserPlus size={15} />
              {saving ? "Salvando lead..." : "Salvar Lead (1x1)"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}