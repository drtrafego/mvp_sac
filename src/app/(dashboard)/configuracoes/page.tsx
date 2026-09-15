'use client'

import { useState, useEffect } from 'react'
import { Eye, EyeOff, Save, Copy, Check, Users, UserPlus, Trash2, Crown, Clock, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'

/*
  Os selects do Base UI mostram o valor cru no gatilho quando o Root não recebe
  `items`, então o cargo aparecia como "membro" e o provedor como "meta".
*/
const ROLE_OPTIONS: Record<string, string> = {
  admin: 'Administrador',
  membro: 'Membro',
}

const PROVIDER_OPTIONS: Record<string, string> = {
  meta: 'Meta Cloud API (oficial)',
  uazapi: 'UazAPI (não-oficial)',
}

interface SettingsData {
  companySlug: string
  webhookUrlToken?: string | null
  hotmartWebhookToken: string
  hotmartClientId: string
  hotmartClientSecret: string
  greennWebhookToken: string
  greennPublicKey: string
  greennApiKey: string
  zoutiWebhookToken: string
  zoutiApiKey: string
  kiwifyWebhookToken: string
  whatsappProvider: string
  metaPhoneNumberId: string
  metaAccessToken: string
  metaVerifyToken: string
  metaWabaId: string
  uazapiBaseUrl: string
  uazapiInstanceToken: string
  notificationPhone: string
  brevoApiKey: string
  brevoSenderEmail: string
  brevoSenderName: string
  instagramUsername: string
  instagramAccountId: string
  instagramAccessToken: string
  instagramVerifyToken: string
  instagramPageId: string
}

interface Member {
  id: number
  email: string
  name: string | null
  role: string
  status: string
  inviteToken: string | null
  createdAt: string
}

interface MembersData {
  owner: { email: string | null; name: string | null; stackAuthUserId: string | null }
  members: Member[]
}

const defaults: SettingsData = {
  companySlug: '',
  webhookUrlToken: null,
  hotmartWebhookToken: '',
  hotmartClientId: '',
  hotmartClientSecret: '',
  greennWebhookToken: '',
  greennPublicKey: '',
  greennApiKey: '',
  zoutiWebhookToken: '',
  zoutiApiKey: '',
  kiwifyWebhookToken: '',
  whatsappProvider: 'meta',
  metaPhoneNumberId: '',
  metaAccessToken: '',
  metaVerifyToken: '',
  metaWabaId: '',
  uazapiBaseUrl: '',
  uazapiInstanceToken: '',
  notificationPhone: '',
  brevoApiKey: '',
  brevoSenderEmail: '',
  brevoSenderName: '',
  instagramUsername: '',
  instagramAccountId: '',
  instagramAccessToken: '',
  instagramVerifyToken: '',
  instagramPageId: '',
}

function SecretInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-surface-inset border-line-subtle h-11 lg:h-9 pr-12 lg:pr-10 max-w-[var(--w-form)]"
      />
      <button type="button" onClick={() => setShow(s => !s)} className="focus-ring absolute right-0 lg:right-3 top-1/2 -translate-y-1/2 flex items-center justify-center min-w-11 min-h-11 lg:min-w-0 lg:min-h-0 text-fg-subtle hover:text-fg">
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  )
}

function WebhookUrlBox({ url, label }: { url: string | null; label: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    if (!url) return
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  if (!url) return (
    <div className="rounded-[var(--r-md)] bg-surface-inset border border-line-subtle p-3 max-w-[var(--w-form)]">
      <p className="text-micro text-fg-subtle italic">URL gerada após salvar as configurações.</p>
    </div>
  )
  return (
    <div className="space-y-1 max-w-[var(--w-form)]">
      <p className="text-label uppercase text-fg-subtle">{label}</p>
      <div className="rounded-[var(--r-md)] bg-surface-inset border border-line-subtle p-3 flex items-center gap-2">
        <code className="num flex-1 text-micro text-fg-muted truncate">{url}</code>
        <button onClick={copy} className="focus-ring text-fg-subtle hover:text-fg transition-colors p-3 lg:p-1 -my-2 lg:my-0 shrink-0" title="Copiar URL">
          {copied ? <Check size={15} className="text-brand-ink" /> : <Copy size={15} />}
        </button>
      </div>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button onClick={copy} className="focus-ring text-fg-subtle hover:text-fg transition-colors p-3 lg:p-1 -my-2 lg:my-0 shrink-0" title="Copiar link">
      {copied ? <Check size={14} className="text-brand-ink" /> : <Copy size={14} />}
    </button>
  )
}

function EquipeSection() {
  const [data, setData] = useState<MembersData | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('admin')
  const [inviting, setInviting] = useState(false)
  const [inviteResult, setInviteResult] = useState<{ url: string; email: string } | null>(null)
  const [error, setError] = useState('')

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  useEffect(() => {
    fetch('/api/members')
      .then(r => r.json())
      .then(setData)
  }, [])

  async function handleInvite() {
    setError('')
    setInviteResult(null)
    if (!inviteEmail.trim()) return
    setInviting(true)

    const res = await fetch('/api/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
    })
    const json = await res.json()
    setInviting(false)

    if (!res.ok) {
      setError(json.error ?? 'Erro ao convidar.')
      return
    }

    setInviteResult({ url: json.inviteUrl, email: inviteEmail.trim() })
    setInviteEmail('')
    setData(prev => prev ? { ...prev, members: [...prev.members, json.member] } : prev)
  }

  async function handleRemove(id: number) {
    if (!confirm('Remover este membro?')) return
    await fetch(`/api/members/${id}`, { method: 'DELETE' })
    setData(prev => prev ? { ...prev, members: prev.members.filter(m => m.id !== id) } : prev)
  }

  async function handleRoleChange(id: number, role: string) {
    await fetch(`/api/members/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    setData(prev => prev ? { ...prev, members: prev.members.map(m => m.id === id ? { ...m, role } : m) } : prev)
  }

  return (
    <section className="panel space-y-4 p-[var(--space-card)]">
      <div className="flex items-center gap-2">
        <Users size={16} className="text-fg-subtle" />
        <h2 className="text-h2 text-fg">Equipe</h2>
      </div>
      <Separator className="bg-line-subtle" />
      <p className="text-body text-fg-muted">
        Adicione pessoas para administrar esta empresa junto com você. Elas terão acesso completo ao painel.
      </p>

      {/* Lista de membros */}
      <div className="space-y-2">
        {/* Proprietário */}
        {data?.owner && (
          <div className="rounded-[var(--r-md)] bg-surface-inset border border-line-subtle px-4 py-3 flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
              style={{
                background: 'color-mix(in oklch, var(--st-atencao) 12%, transparent)',
                border: '1px solid color-mix(in oklch, var(--st-atencao) 22%, transparent)',
              }}
            >
              <Crown size={14} className="text-st-atencao" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-h3 text-fg truncate">{data.owner.name ?? data.owner.email ?? 'Proprietário'}</p>
              {data.owner.name && <p className="text-micro text-fg-subtle truncate">{data.owner.email}</p>}
            </div>
            <span className="text-micro text-st-atencao font-medium shrink-0">Proprietário</span>
          </div>
        )}

        {/* Membros convidados */}
        {data?.members.map(member => {
          const inviteUrl = member.inviteToken ? `${origin}/invite/membro/${member.inviteToken}` : null
          return (
            <div key={member.id} className="rounded-[var(--r-md)] bg-surface-inset border border-line-subtle px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <div className="flex items-center gap-3 min-w-0 sm:flex-1">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                  style={{
                    background: 'color-mix(in oklch, var(--st-info) 12%, transparent)',
                    border: '1px solid color-mix(in oklch, var(--st-info) 22%, transparent)',
                  }}
                >
                  {member.status === 'ativo'
                    ? <Shield size={14} className="text-st-info" />
                    : <Clock size={14} className="text-fg-subtle" />
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-h3 text-fg truncate">{member.name ?? member.email}</p>
                  {member.name && <p className="text-micro text-fg-subtle truncate">{member.email}</p>}
                  {member.status === 'pending' && (
                    <p className="text-micro text-st-atencao">Convite pendente</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap sm:shrink-0">
                <Select value={member.role} onValueChange={v => v && handleRoleChange(member.id, v)} items={ROLE_OPTIONS}>
                  <SelectTrigger className="focus-ring h-11 lg:h-9 text-micro bg-surface-overlay border-line-subtle w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-surface-overlay border-line-subtle">
                    {Object.entries(ROLE_OPTIONS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {member.status === 'pending' && inviteUrl && (
                  <CopyButton text={inviteUrl} />
                )}
                <button
                  onClick={() => handleRemove(member.id)}
                  className="focus-ring text-fg-subtle hover:text-st-negativo transition-colors p-3 lg:p-1"
                  title="Remover membro"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          )
        })}

        {data && data.members.length === 0 && (
          <p className="text-micro text-fg-faint italic">Nenhum membro convidado ainda.</p>
        )}
      </div>

      {/* Formulário de convite */}
      <div className="rounded-[var(--r-md)] bg-surface-inset border border-line-subtle p-4 space-y-3">
        <p className="text-label uppercase text-fg-subtle flex items-center gap-1.5">
          <UserPlus size={13} />
          Convidar pessoa
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={inviteEmail}
            onChange={e => setInviteEmail(e.target.value)}
            placeholder="email@exemplo.com"
            className="bg-surface-overlay border-line-subtle h-11 lg:h-9 text-base lg:text-sm w-full sm:flex-1"
            onKeyDown={e => e.key === 'Enter' && handleInvite()}
          />
          <Select value={inviteRole} onValueChange={v => v && setInviteRole(v)} items={ROLE_OPTIONS}>
            <SelectTrigger className="focus-ring bg-surface-overlay border-line-subtle h-11 lg:h-9 w-full sm:w-36 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-surface-overlay border-line-subtle">
              {Object.entries(ROLE_OPTIONS).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()} className="focus-ring h-11 lg:h-9 bg-brand-solid text-on-accent">
            {inviting ? 'Gerando...' : 'Convidar'}
          </Button>
        </div>
        {error && <p className="text-micro text-st-negativo">{error}</p>}
        {inviteResult && (
          <div className="space-y-1">
            <p className="text-micro text-st-positivo">Convite gerado para {inviteResult.email}. Copie o link abaixo e envie:</p>
            <div className="rounded-[var(--r-sm)] bg-surface-overlay border border-line-subtle p-2 flex items-center gap-2">
              <code className="num flex-1 text-micro text-fg-muted truncate">{inviteResult.url}</code>
              <CopyButton text={inviteResult.url} />
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export default function ConfiguracoesPage() {
  const [form, setForm] = useState<SettingsData>(defaults)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const slug = form.companySlug

  // Todo webhook exige o token da barreira na query. Para o admin a API devolve
  // o valor e a URL sai pronta para colar; para o cliente comum ela sai sem o
  // token, porque o segredo é global e valeria para o slug de qualquer empresa.
  const tokenQuery = form.webhookUrlToken ? `?token=${encodeURIComponent(form.webhookUrlToken)}` : ''
  const webhookUrl = (plataforma: string) =>
    slug ? `${origin}/api/webhooks/${plataforma}/${slug}${tokenQuery}` : null

  const hotmartWebhookUrl = webhookUrl('hotmart')
  const greennWebhookUrl = webhookUrl('greenn')
  const zoutiWebhookUrl = webhookUrl('zouti')
  const kiwifyWebhookUrl = webhookUrl('kiwify')
  const metaWebhookUrl = slug ? `${origin}/api/webhooks/whatsapp` : null
  const instagramWebhookUrl = webhookUrl('instagram')

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => setForm({
        companySlug: data.companySlug ?? '',
        webhookUrlToken: data.webhookUrlToken ?? null,
        hotmartWebhookToken: data.hotmartWebhookToken ?? '',
        hotmartClientId: data.hotmartClientId ?? '',
        hotmartClientSecret: data.hotmartClientSecret ?? '',
        greennWebhookToken: data.greennWebhookToken ?? '',
        greennPublicKey: data.greennPublicKey ?? '',
        greennApiKey: data.greennApiKey ?? '',
        zoutiWebhookToken: data.zoutiWebhookToken ?? '',
        zoutiApiKey: data.zoutiApiKey ?? '',
        kiwifyWebhookToken: data.kiwifyWebhookToken ?? '',
        whatsappProvider: data.whatsappProvider ?? 'meta',
        metaPhoneNumberId: data.metaPhoneNumberId ?? '',
        metaAccessToken: data.metaAccessToken ?? '',
        metaVerifyToken: data.metaVerifyToken ?? '',
        metaWabaId: data.metaWabaId ?? '',
        uazapiBaseUrl: data.uazapiBaseUrl ?? '',
        uazapiInstanceToken: data.uazapiInstanceToken ?? '',
        notificationPhone: data.notificationPhone ?? '',
        brevoApiKey: data.brevoApiKey ?? '',
        brevoSenderEmail: data.brevoSenderEmail ?? '',
        brevoSenderName: data.brevoSenderName ?? '',
        instagramUsername: data.instagramUsername ?? '',
        instagramAccountId: data.instagramAccountId ?? '',
        instagramAccessToken: data.instagramAccessToken ?? '',
        instagramVerifyToken: data.instagramVerifyToken ?? '',
        instagramPageId: data.instagramPageId ?? '',
      }))
  }, [])

  function set(key: keyof SettingsData, value: string) {
    setForm(f => ({ ...f, [key]: value }))
  }

  async function handleSave() {
    setSaving(true)
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="max-w-[880px] flex flex-col gap-[var(--space-section)]">
      <div>
        <h1 className="text-h1 text-fg">Configurações</h1>
        <p className="text-body text-fg-muted mt-1">
          Credenciais das plataformas de pagamento, do WhatsApp e da sua equipe.
        </p>
      </div>

      {/* Equipe */}
      <EquipeSection />

      {/* Hotmart */}
      <section className="panel space-y-4 p-[var(--space-card)]">
        <h2 className="text-h2 text-fg">Hotmart</h2>
        <Separator className="bg-line-subtle" />
        <p className="text-body text-fg-muted">
          Configure em: Produto, Configurações, Notificações, Webhook v2.0.0.
        </p>
        <WebhookUrlBox url={hotmartWebhookUrl} label="URL do Webhook" />
        <div className="space-y-1.5">
          <Label>Token de Segurança (Hottok)</Label>
          <SecretInput value={form.hotmartWebhookToken} onChange={v => set('hotmartWebhookToken', v)} placeholder="Opcional: valida o token enviado pela Hotmart" />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">Se preenchido, rejeita requisições com token diferente.</p>
        </div>
        <div className="space-y-1.5">
          <Label>Client ID</Label>
          <Input value={form.hotmartClientId} onChange={e => set('hotmartClientId', e.target.value)} className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]" />
        </div>
        <div className="space-y-1.5">
          <Label>Client Secret</Label>
          <SecretInput value={form.hotmartClientSecret} onChange={v => set('hotmartClientSecret', v)} />
        </div>
      </section>

      {/* Greenn */}
      <section className="panel space-y-4 p-[var(--space-card)]">
        <h2 className="text-h2 text-fg">Greenn</h2>
        <Separator className="bg-line-subtle" />
        <p className="text-body text-fg-muted">
          No painel Greenn: Sistema, Controle de Acesso, Integração e Tokens. Cole a URL abaixo no campo Webhook da Greenn e copie o Webhook Token para o campo abaixo.
        </p>
        <WebhookUrlBox url={greennWebhookUrl} label="URL do Webhook (colar na Greenn)" />
        <div className="space-y-1.5">
          <Label>Webhook Token</Label>
          <SecretInput value={form.greennWebhookToken} onChange={v => set('greennWebhookToken', v)} placeholder="Token gerado pela Greenn em Integração e Tokens" />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">Copie o Webhook Token da Greenn e cole aqui para validar as requisições.</p>
        </div>
        <div className="space-y-1.5">
          <Label>Public Key</Label>
          <Input value={form.greennPublicKey} onChange={e => set('greennPublicKey', e.target.value)} placeholder="Chave pública da Greenn" className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]" />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">Chave pública disponível em Chaves de Acesso no painel Greenn.</p>
        </div>
        <div className="space-y-1.5">
          <Label>API Key</Label>
          <SecretInput value={form.greennApiKey} onChange={v => set('greennApiKey', v)} placeholder="Chave de API da Greenn" />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">API Key disponível em Chaves de Acesso no painel Greenn.</p>
        </div>
      </section>

      {/* Zouti */}
      <section className="panel space-y-4 p-[var(--space-card)]">
        <h2 className="text-h2 text-fg">Zouti</h2>
        <Separator className="bg-line-subtle" />
        <p className="text-body text-fg-muted">
          No painel Zouti: Integrações, Webhooks, Criar Webhook. Cole a URL abaixo no campo URL do site e selecione os eventos (pedido pago, aguardando pagamento, cartão recusado, carrinho abandonado).
        </p>
        <WebhookUrlBox url={zoutiWebhookUrl} label="URL do Webhook (colar na Zouti)" />
        <div className="space-y-1.5">
          <Label>Signing Secret</Label>
          <SecretInput value={form.zoutiWebhookToken} onChange={v => set('zoutiWebhookToken', v)} placeholder="Secret gerado pela Zouti ao criar o webhook" />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">Cole o secret que a Zouti gerou. O sistema valida a assinatura HMAC-SHA256 (header x-zouti-signature) de cada requisição e rejeita as expiradas. Deixe vazio para aceitar sem validar.</p>
        </div>
        <div className="space-y-1.5">
          <Label>API Key</Label>
          <SecretInput value={form.zoutiApiKey} onChange={v => set('zoutiApiKey', v)} placeholder="Chave de API da Zouti (opcional)" />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">Usada para consultas futuras à API da Zouti. Opcional.</p>
        </div>
      </section>

      {/* Kiwify */}
      <section className="panel space-y-4 p-[var(--space-card)]">
        <h2 className="text-h2 text-fg">Kiwify</h2>
        <Separator className="bg-line-subtle" />
        <p className="text-body text-fg-muted">
          No painel Kiwify: Apps, Webhooks, Criar Webhook. Em Produtos selecione{' '}
          <strong className="font-semibold text-fg">Todos os produtos</strong>{' '}
          (a Kiwify aceita um produto só por webhook, se escolher um, os demais ficam mudos). Marque os eventos Boleto gerado, Pix gerado, Carrinho abandonado, Compra recusada e{' '}
          <strong className="font-semibold text-fg">Compra aprovada</strong>. Compra aprovada é obrigatório: é ele que faz o sistema parar de cobrar quem já pagou.
        </p>
        <WebhookUrlBox url={kiwifyWebhookUrl} label="URL do Webhook (colar na Kiwify)" />
        <div className="space-y-1.5">
          <Label>Token do Webhook</Label>
          <SecretInput value={form.kiwifyWebhookToken} onChange={v => set('kiwifyWebhookToken', v)} placeholder="Token gerado pela Kiwify ao criar o webhook" />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">Cole o token que a Kiwify gerou ao criar o webhook. O sistema valida a assinatura HMAC-SHA1 do corpo de cada requisição. Deixe vazio para aceitar sem validar.</p>
        </div>
      </section>

      {/* WhatsApp */}
      <section className="panel space-y-4 p-[var(--space-card)]">
        <h2 className="text-h2 text-fg">WhatsApp</h2>
        <Separator className="bg-line-subtle" />
        <div className="space-y-1.5">
          <Label>Provedor</Label>
          <Select value={form.whatsappProvider} onValueChange={v => v && set('whatsappProvider', v)} items={PROVIDER_OPTIONS}>
            <SelectTrigger className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-surface-overlay border-line-subtle">
              {Object.entries(PROVIDER_OPTIONS).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>

      {form.whatsappProvider === 'meta' && (
        <section className="panel space-y-4 p-[var(--space-card)]">
          <h2 className="text-h2 text-fg">Meta Cloud API</h2>
          <Separator className="bg-line-subtle" />
          <WebhookUrlBox url={metaWebhookUrl} label="URL do Webhook (configurar na Meta)" />
          <div className="space-y-1.5">
            <Label>Phone Number ID</Label>
            <Input value={form.metaPhoneNumberId} onChange={e => set('metaPhoneNumberId', e.target.value)} placeholder="123456789012345" className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]" />
            <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">Meta Business, WhatsApp, Configuração, Phone Number ID</p>
          </div>
          <div className="space-y-1.5">
            <Label>Access Token</Label>
            <SecretInput value={form.metaAccessToken} onChange={v => set('metaAccessToken', v)} placeholder="EAAxxxxxxx..." />
            <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">Token permanente do System User com permissão whatsapp_business_messaging</p>
          </div>
          <div className="space-y-1.5">
            <Label>Verify Token (Webhook)</Label>
            <Input value={form.metaVerifyToken} onChange={e => set('metaVerifyToken', e.target.value)} placeholder="meu_token_secreto" className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]" />
            <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">Qualquer texto que você escolher. Use o mesmo ao configurar o webhook na Meta.</p>
          </div>
          <div className="space-y-1.5">
            <Label>WABA ID (para templates)</Label>
            <Input value={form.metaWabaId} onChange={e => set('metaWabaId', e.target.value)} placeholder="123456789012345" className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]" />
            <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">WhatsApp Business Account ID. Necessário para listar e enviar templates aprovados.</p>
          </div>
        </section>
      )}

      {form.whatsappProvider === 'uazapi' && (
        <section className="panel space-y-4 p-[var(--space-card)]">
          <h2 className="text-h2 text-fg">UazAPI</h2>
          <Separator className="bg-line-subtle" />
          <div className="space-y-1.5">
            <Label>URL da Instância</Label>
            <Input value={form.uazapiBaseUrl} onChange={e => set('uazapiBaseUrl', e.target.value)} placeholder="https://focus.uazapi.com" className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]" />
            <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">URL base do seu servidor UazAPI</p>
          </div>
          <div className="space-y-1.5">
            <Label>Instance Token</Label>
            <SecretInput value={form.uazapiInstanceToken} onChange={v => set('uazapiInstanceToken', v)} placeholder="seu_token_aqui" />
            <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">Token de autenticação da instância no painel UazAPI</p>
          </div>
        </section>
      )}

      {/* Notificações internas */}
      <section className="panel space-y-4 p-[var(--space-card)]">
        <h2 className="text-h2 text-fg">Notificações internas</h2>
        <Separator className="bg-line-subtle" />
        <div className="space-y-1.5">
          <Label>Telefone para notificações</Label>
          <Input
            value={form.notificationPhone}
            onChange={e => set('notificationPhone', e.target.value)}
            placeholder="5511999999999"
            className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]"
          />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">
            Quando chegar uma nova venda ou lead, o sistema envia uma mensagem WhatsApp para este número com o resumo do evento. Formato: DDI + DDD + número (ex: 5511999998888).
          </p>
        </div>
      </section>

      {/* Brevo (E-mail Transacional & Automação) */}
      <section className="panel space-y-4 p-[var(--space-card)]">
        <div className="flex items-center gap-2">
          <h2 className="text-h2 text-fg">Brevo (E-mail Transacional)</h2>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            E-mail API
          </span>
        </div>
        <Separator className="bg-line-subtle" />
        <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">
          Utilizado para envio de notificações por e-mail, entrega de boletos/Pix por e-mail e sequências de e-mail marketing transacional da sua empresa.
        </p>
        <div className="space-y-1.5">
          <Label>Chave de API da Brevo (API Key v3)</Label>
          <SecretInput
            value={form.brevoApiKey}
            onChange={v => set('brevoApiKey', v)}
            placeholder="xkeysib-..."
          />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">
            Obtenha no painel da Brevo em: Configurações &gt; Chaves de API &gt; Gerar nova chave.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label>E-mail do Remetente (Verificado na Brevo)</Label>
          <Input
            value={form.brevoSenderEmail}
            onChange={e => set('brevoSenderEmail', e.target.value)}
            placeholder="contato@suaempresa.com.br"
            className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]"
          />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">
            O endereço de e-mail precisa estar com domínio autenticado (SPF/DKIM) na Brevo.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label>Nome do Remetente</Label>
          <Input
            value={form.brevoSenderName}
            onChange={e => set('brevoSenderName', e.target.value)}
            placeholder="SAC Hermes - Suporte"
            className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]"
          />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">
            Nome que aparecerá para o destinatário na caixa de entrada.
          </p>
        </div>
      </section>

      {/* Instagram Direct (Meta Graph API) */}
      <section className="panel space-y-4 p-[var(--space-card)]">
        <div className="flex items-center gap-2">
          <h2 className="text-h2 text-fg">Instagram Direct & Mensagens</h2>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-pink-500/10 text-pink-400 border border-pink-500/20">
            Meta Graph API
          </span>
        </div>
        <Separator className="bg-line-subtle" />
        <div className="text-micro text-fg-muted space-y-1.5 max-w-[var(--w-form)]">
          <p>
            Permite receber DMs do Instagram, responder leads de prospecção/mineração e automatizar o atendimento direto na sua conta do Instagram.
          </p>
          <div className="p-3 rounded-[var(--r-md)] bg-surface-inset border border-line-subtle space-y-1 text-fg-subtle">
            <p className="font-semibold text-fg">📋 Como conectar seu Instagram:</p>
            <ol className="list-decimal list-inside space-y-0.5">
              <li>Converta sua conta do Instagram para <strong>Comercial / Profissional</strong>.</li>
              <li>Conecte sua conta do Instagram à sua <strong>Página do Facebook</strong> no Meta Business Suite.</li>
              <li>Copie a <strong>URL do Webhook do Instagram</strong> abaixo e cadastre em seu App no Meta for Developers (produto <em>Instagram</em>, campo <em>messages</em>).</li>
              <li>Preencha seu <strong>Token de Acesso</strong> e <strong>Instagram Account ID</strong> abaixo.</li>
            </ol>
          </div>
        </div>

        <WebhookUrlBox url={instagramWebhookUrl} label="URL do Webhook (configurar no Meta Developers > Instagram Webhook)" />

        <div className="space-y-1.5">
          <Label>@ Usuário do Instagram</Label>
          <Input
            value={form.instagramUsername}
            onChange={e => set('instagramUsername', e.target.value)}
            placeholder="@suaempresa"
            className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]"
          />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">
            Nome de usuário do perfil oficial da sua empresa no Instagram.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Instagram Business Account ID</Label>
          <Input
            value={form.instagramAccountId}
            onChange={e => set('instagramAccountId', e.target.value)}
            placeholder="17841400000000000"
            className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]"
          />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">
            Obtido no Meta Graph API Explorer ou no painel do Meta Business Suite associado à conta.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>ID da Página do Facebook (Page ID)</Label>
          <Input
            value={form.instagramPageId}
            onChange={e => set('instagramPageId', e.target.value)}
            placeholder="100234567890123"
            className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]"
          />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">
            ID da Página do Facebook vinculada ao perfil do Instagram.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Token de Acesso do Instagram (Meta System User Token)</Label>
          <SecretInput
            value={form.instagramAccessToken}
            onChange={v => set('instagramAccessToken', v)}
            placeholder="EAAxxxxxxx..."
          />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">
            Token de acesso permanente com permissões <code className="text-fg font-mono text-[11px]">instagram_manage_messages</code>, <code className="text-fg font-mono text-[11px]">instagram_basic</code> e <code className="text-fg font-mono text-[11px]">pages_manage_metadata</code>. Se não preenchido, usa o Access Token geral da Meta.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Verify Token do Webhook do Instagram</Label>
          <Input
            value={form.instagramVerifyToken}
            onChange={e => set('instagramVerifyToken', e.target.value)}
            placeholder="meu_token_instagram_secreto"
            className="bg-surface-inset border-line-subtle h-11 lg:h-9 max-w-[var(--w-form)]"
          />
          <p className="text-micro text-fg-subtle max-w-[var(--w-form)]">
            Token secreto definido por você para validação do webhook no portal Meta for Developers.
          </p>
        </div>
      </section>

      <div className="pt-2">
        <Button onClick={handleSave} disabled={saving} className="focus-ring flex h-11 items-center gap-2 bg-brand-solid text-on-accent lg:h-9">
          <Save size={15} />
          {saving ? 'Salvando...' : saved ? 'Salvo!' : 'Salvar Configurações'}
        </Button>
      </div>
    </div>
  )
}
