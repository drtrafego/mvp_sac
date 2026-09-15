"use client"

import { useState } from "react"
import {
  UserPlus,
  User,
  Phone,
  Mail,
  DollarSign,
  Package,
  CheckCircle2,
  AlertCircle,
  Zap,
  Tag,
  Share2,
  Compass,
} from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface AddLeadModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

export const EVENT_TYPE_OPTIONS: Record<string, string> = {
  // Produtos, Serviços e Infoprodutos
  mentoria: "🎓 Mentoria (VIP / Grupo / 1 a 1)",
  aulas: "📚 Aulas / Curso Online / Formação",
  projeto_individual: "💼 Projeto Individual / Serviço Dedicado",
  consultoria: "💡 Consultoria Estratégica / Diagnóstico",
  workshop: "🎟️ Workshop / Imersão ao Vivo",
  assinatura: "⭐ Assinatura / Comunidade / Recorrência",
  prospeccao: "🎯 Prospecção / Primeiro Contato",
  // Recuperação de Vendas & Checkout
  carrinho_abandonado: "🛒 Carrinho Abandonado",
  pix: "⚡ Pix Pendente",
  boleto: "📄 Boleto Gerado",
  cartao_recusado: "💳 Cartão Recusado",
  compra_aprovada: "🎉 Compra Aprovada (Pós-Venda / Boas-vindas)",
}

export const SOURCE_OPTIONS: Record<string, string> = {
  indicacao: "🤝 Indicação (Boca a Boca / Aluno / Parceiro)",
  mineracao: "⛏️ Mineração (Outreach / Prospecção Fria)",
  meta_ads: "📱 Meta Ads (Instagram / Facebook Ads)",
  instagram: "📸 Instagram Direct (Orgânico / Perfil)",
  whatsapp: "💬 WhatsApp Receptivo / Grupos",
  email: "✉️ E-mail Marketing / Base de Contatos",
  hotmart: "🔥 Hotmart (Checkout / Plataforma)",
  kiwify: "🥝 Kiwify (Checkout / Plataforma)",
  greenn: "🌿 Greenn (Checkout / Plataforma)",
  zouti: "⚡ Zouti (Checkout / Plataforma)",
  organico: "🌐 Direto / Site / Orgânico",
}

export const MEDIUM_OPTIONS: Record<string, string> = {
  indicacao: "🤝 Indicação Direta / Recomendação",
  parceria: "👥 Parceria / Co-produção",
  whatsapp: "💬 WhatsApp Outreach (Prospecção Ativa)",
  whatsapp_inbound: "🟢 WhatsApp Receptivo (Conversão / Dúvidas)",
  instagram: "📸 Instagram Direct / DM",
  instagram_stories: "📲 Instagram Stories / Menções",
  email: "✉️ E-mail Frio / Cold Mail (Brevo)",
  email_marketing: "📧 E-mail Marketing / Newsletter",
  ligacao_call: "📞 Ligação Telefônica / Call 1:1",
  trafego_pago: "🎯 Tráfego Pago / Anúncios Segmentados",
  evento: "🎟️ Evento Presencial / Networking",
}

export function AddLeadModal({ open, onOpenChange, onSuccess }: AddLeadModalProps) {
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [productName, setProductName] = useState("")
  const [productValue, setProductValue] = useState("")
  const [eventType, setEventType] = useState("mentoria")
  const [trackingSource, setTrackingSource] = useState("indicacao")
  const [utmMedium, setUtmMedium] = useState("indicacao")
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
    setEventType("mentoria")
    setTrackingSource("indicacao")
    setUtmMedium("indicacao")
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
          productName: productName.trim() || "Mentoria VIP",
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
      }, 700)
    } catch (err: any) {
      setError(err.message || "Erro de conexão ao salvar lead.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) reset(); onOpenChange(val); }}>
      <DialogContent className="sm:max-w-xl md:max-w-2xl w-[96vw] sm:w-full bg-surface-overlay border border-line-subtle p-0 overflow-hidden shadow-2xl rounded-2xl max-h-[92vh] sm:max-h-[88vh] flex flex-col">
        
        {/* Header Fixo com visual elegante e sem botão X duplicado */}
        <DialogHeader className="px-5 py-4 sm:px-6 sm:py-4.5 bg-surface-panel border-b border-line-subtle shrink-0">
          <div className="flex items-center gap-3 pr-8">
            <div className="h-10 w-10 rounded-xl bg-brand-glow border border-brand-solid/30 flex items-center justify-center text-brand-ink shrink-0">
              <UserPlus size={20} />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-base sm:text-lg text-fg font-bold leading-tight">
                Cadastrar Novo Lead
              </DialogTitle>
              <p className="text-micro text-fg-subtle mt-0.5 truncate">
                Centralize atendimentos para mentoria, aulas, projetos, indicações e recuperação.
              </p>
            </div>
          </div>
        </DialogHeader>

        {/* Formulário com Scroll Suave apenas no corpo */}
        <form id="add-lead-form" onSubmit={handleSubmit} className="px-5 py-4 sm:px-6 sm:py-5 space-y-4 overflow-y-auto flex-1 overscroll-contain">
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

          {/* Seção 1: Contato */}
          <div className="p-3.5 sm:p-4 rounded-xl bg-surface-panel border border-line-subtle space-y-3">
            <span className="text-[11px] font-bold text-brand-ink uppercase tracking-wider block">
              1. Identificação do Lead
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <User size={13} className="text-fg-subtle" /> Nome Completo
                </Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex: João Silva"
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
                  placeholder="Ex: 11 99999-8888"
                  className="bg-surface-inset border-line-subtle h-10 text-sm font-mono"
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                <Mail size={13} className="text-indigo-400" /> E-mail (Opcional)
              </Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="cliente@exemplo.com.br"
                className="bg-surface-inset border-line-subtle h-10 text-sm"
              />
            </div>
          </div>

          {/* Seção 2: Classificação e Origem */}
          <div className="p-3.5 sm:p-4 rounded-xl bg-surface-panel border border-line-subtle space-y-3">
            <span className="text-[11px] font-bold text-brand-ink uppercase tracking-wider block">
              2. Classificação & Origem
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <Tag size={13} className="text-amber-400" /> Tipo de Evento / Oferta
                </Label>
                <Select value={eventType} onValueChange={(v) => v && setEventType(v)} items={EVENT_TYPE_OPTIONS}>
                  <SelectTrigger className="bg-surface-inset border-line-subtle h-10 text-xs sm:text-sm w-full font-medium">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-surface-overlay border-line-subtle max-h-64">
                    {Object.entries(EVENT_TYPE_OPTIONS).map(([val, label]) => (
                      <SelectItem key={val} value={val} className="text-xs sm:text-sm py-2">
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <Compass size={13} className="text-blue-400" /> Origem de Aquisição
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
            </div>

            <div className="space-y-1.5">
              <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                <Share2 size={13} className="text-cyan-400" /> Subcategoria / Canal de Abordagem
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
              <p className="text-[11px] text-fg-subtle">
                Identifica se o contato veio de <strong>Indicação</strong>, <strong>WhatsApp Ativo</strong>, <strong>Instagram</strong>, etc.
              </p>
            </div>
          </div>

          {/* Seção 3: Produto e Valor */}
          <div className="p-3.5 sm:p-4 rounded-xl bg-surface-panel border border-line-subtle space-y-3">
            <span className="text-[11px] font-bold text-brand-ink uppercase tracking-wider block">
              3. Produto ou Serviço Oferecido
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <Package size={13} className="text-fg-subtle" /> Nome do Produto / Projeto
                </Label>
                <Input
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder="Ex: Mentoria VIP Individual"
                  className="bg-surface-inset border-line-subtle h-10 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-micro font-semibold text-fg flex items-center gap-1.5">
                  <DollarSign size={13} className="text-brand-ink" /> Valor Estimado (R$)
                </Label>
                <Input
                  value={productValue}
                  onChange={(e) => setProductValue(e.target.value)}
                  placeholder="Ex: 1.500,00"
                  className="bg-surface-inset border-line-subtle h-10 text-sm"
                />
              </div>
            </div>
          </div>

          {/* Disparo de Sequência Automática */}
          <div className="p-3.5 rounded-xl bg-surface-inset/80 border border-line-subtle flex items-start gap-3">
            <input
              type="checkbox"
              id="triggerSequence"
              checked={triggerSequence}
              onChange={(e) => setTriggerSequence(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-line-subtle text-brand-solid focus:ring-brand-solid cursor-pointer"
            />
            <label htmlFor="triggerSequence" className="text-micro text-fg cursor-pointer select-none space-y-0.5 block">
              <span className="font-bold flex items-center gap-1 text-xs">
                <Zap size={13} className="text-amber-400" /> Iniciar sequência automática imediatamente
              </span>
              <span className="text-fg-subtle block text-[11px]">
                Se houver uma régua ativa configurada para este evento, os disparos pelo WhatsApp serão agendados automaticamente.
              </span>
            </label>
          </div>
        </form>

        {/* Footer Fixo: SEMPRE visível em Notebooks e Mobile */}
        <div className="px-5 py-3.5 sm:px-6 sm:py-4 bg-surface-panel border-t border-line-subtle shrink-0 flex items-center justify-between gap-3">
          <span className="text-[11px] text-fg-subtle hidden sm:inline">
            * WhatsApp é o identificador único do lead
          </span>
          <div className="flex items-center gap-2.5 w-full sm:w-auto justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-line-subtle bg-surface-inset hover:bg-surface-panel text-fg h-10 px-4 text-xs sm:text-sm font-medium flex-1 sm:flex-initial"
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              form="add-lead-form"
              disabled={saving || !phone.trim()}
              className="bg-brand-solid hover:bg-brand-solid/90 text-on-accent font-bold h-10 px-5 gap-1.5 text-xs sm:text-sm flex-1 sm:flex-initial shadow-sm"
            >
              <UserPlus size={16} />
              {saving ? "Salvando..." : "Salvar Lead"}
            </Button>
          </div>
        </div>

      </DialogContent>
    </Dialog>
  )
}
