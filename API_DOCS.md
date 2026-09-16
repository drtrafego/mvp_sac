# 🚀 Documentação Oficial da API - SAC Hermes & Agentes IA

Esta API REST permite que agentes autônomos (**Bia**, **Luana**, **Renato**, scripts externos e integrações) operem de forma 100% programática no **SAC Hermes** sem depender de sessão ou login visual de navegador.

---

## 🔐 1. Autenticação & Headers

Todas as requisições para `/api/v1/*` e `/api/agent/*` autenticam diretamente via **Chave de API** (sem redirecionamentos de navegador).

### Headers Suportados:

| Header | Tipo | Descrição | Exemplo |
| :--- | :--- | :--- | :--- |
| `Authorization` | `string` | Token Bearer com a API Key | `Bearer sac_live_9f82...` |
| `x-api-key` | `string` | Alternativa direta ao Bearer Token | `sac_live_9f82...` |
| `x-company-slug` | `string` | Slug da empresa alvo (se não estiver na URL) | `autonomia` |
| `x-agent-id` | `string` | Identificador do agente executor para auditoria | `bia`, `luana`, `renato`, `master` |
| `Content-Type` | `string` | Tipo do corpo (para POST/PATCH) | `application/json` |

---

## 🌐 2. Base URLs

- **Produção:** `https://sac.casaldotrafego.com`
- **Local:** `http://localhost:3000`

---

## 🏢 3. Endpoints de Empresas (`/api/v1/companies`)

### 3.1 Listar Empresas
Retorna todas as empresas disponíveis para a chave informada.

- **Método:** `GET`
- **Rota:** `/api/v1/companies`

```bash
curl -X GET "https://sac.casaldotrafego.com/api/v1/companies" \
  -H "Authorization: Bearer SUA_API_KEY" \
  -H "x-agent-id: luana"
```

**Resposta (200 OK):**
```json
{
  "ok": true,
  "companies": [
    {
      "id": 14,
      "name": "AutonomIA",
      "slug": "autonomia",
      "plan": "pro",
      "createdAt": "2026-09-16T12:00:00.000Z"
    },
    {
      "id": 12,
      "name": "Gramado Plaza",
      "slug": "gramado-plaza",
      "plan": "pro",
      "createdAt": "2026-09-16T12:00:00.000Z"
    }
  ]
}
```

---

### 3.2 Obter Detalhes & Configurações da Empresa
- **Método:** `GET`
- **Rota:** `/api/v1/companies/:idOrSlug`

```bash
curl -X GET "https://sac.casaldotrafego.com/api/v1/companies/autonomia" \
  -H "Authorization: Bearer SUA_API_KEY"
```

---

## 👥 4. Endpoints de Leads & Contatos (`/api/v1/companies/:idOrSlug/leads`)

### 4.1 Listar e Filtrar Leads
Busca leads da empresa com paginação, busca textual e filtros de funil.

- **Método:** `GET`
- **Rota:** `/api/v1/companies/:idOrSlug/leads`
- **Query Params:**
  - `page` (default: 1)
  - `limit` (default: 50, máx: 200)
  - `search` (nome, telefone, email)
  - `status` (`in_conversation`, `converted`, `lost`, `pending`)
  - `channel` (`whatsapp`, `instagram`, `email`)
  - `pipelineStage` (`novo`, `qualificado`, `proposta`, `agendado`, `fechado`)

```bash
curl -X GET "https://sac.casaldotrafego.com/api/v1/companies/autonomia/leads?limit=10&status=in_conversation" \
  -H "Authorization: Bearer SUA_API_KEY" \
  -H "x-agent-id: bia"
```

---

### 4.2 Criar / Injetar Novo Lead
Injeta um lead ou contato proativamente no sistema.

- **Método:** `POST`
- **Rota:** `/api/v1/companies/:idOrSlug/leads`

```bash
curl -X POST "https://sac.casaldotrafego.com/api/v1/companies/autonomia/leads" \
  -H "Authorization: Bearer SUA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "5511999998888",
    "name": "Mariana Souza",
    "email": "mariana@gmail.com",
    "channel": "whatsapp",
    "pipelineStage": "qualificado",
    "productName": "Mentoria Tráfego Pro",
    "productValue": 29700,
    "responsibleAgent": "Luana"
  }'
```

---

## 💬 5. Endpoints de Conversas & Mensagens (`/api/v1/companies/:idOrSlug/conversations`)

### 5.1 Listar Histórico de Conversas
Retorna as conversas ativas no Inbox com a última mensagem e contador de não lidas.

- **Método:** `GET`
- **Rota:** `/api/v1/companies/:idOrSlug/conversations`

```bash
curl -X GET "https://sac.casaldotrafego.com/api/v1/companies/autonomia/conversations?limit=30" \
  -H "Authorization: Bearer SUA_API_KEY"
```

---

### 5.2 Obter Mensagens de um Contato Específico
Busca todas as mensagens trocadas com um número de telefone ou ID de lead.

- **Método:** `GET`
- **Rota:** `/api/v1/companies/:idOrSlug/conversations/:contact/messages`

```bash
curl -X GET "https://sac.casaldotrafego.com/api/v1/companies/autonomia/conversations/5511999998888/messages" \
  -H "Authorization: Bearer SUA_API_KEY"
```

---

### 5.3 Enviar Mensagem para o Contato (Agente IA ou Operador)
Dispara uma mensagem de texto ou mídia para o contato no WhatsApp/Instagram.

- **Método:** `POST`
- **Rota:** `/api/v1/companies/:idOrSlug/conversations/:contact/messages`

```bash
curl -X POST "https://sac.casaldotrafego.com/api/v1/companies/autonomia/conversations/5511999998888/messages" \
  -H "Authorization: Bearer SUA_API_KEY" \
  -H "Content-Type: application/json" \
  -H "x-agent-id: luana" \
  -d '{
    "content": "Olá Mariana! Aqui é a Luana. Já liberei sua proposta com condição exclusiva. Posso tirar suas dúvidas?",
    "messageType": "text",
    "sentBy": "bot",
    "senderName": "Luana (Agente IA)"
  }'
```

---

### 5.4 Pausar ou Retomar Bot IA no Atendimento
Pausa o agente automático em uma conversa específica quando um humano assume o atendimento.

- **Método:** `POST`
- **Rota:** `/api/v1/companies/:idOrSlug/conversations/:contact/pause-bot`

```bash
curl -X POST "https://sac.casaldotrafego.com/api/v1/companies/autonomia/conversations/5511999998888/pause-bot" \
  -H "Authorization: Bearer SUA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "paused": true,
    "pausedBy": "Renato (Suporte Humano)"
  }'
```

---

## 📊 6. Endpoints de Pipeline & Funil (`/api/v1/companies/:idOrSlug/pipeline`)

### 6.1 Mover Lead de Estágio no Kanban
Atualiza o estágio do lead no funil de vendas.

- **Método:** `PATCH`
- **Rota:** `/api/v1/companies/:idOrSlug/leads/:leadId`

```bash
curl -X PATCH "https://sac.casaldotrafego.com/api/v1/companies/autonomia/leads/6875" \
  -H "Authorization: Bearer SUA_API_KEY" \
  -H "Content-Type: application/json" \
  -H "x-agent-id: bia" \
  -d '{
    "pipelineStage": "fechado",
    "status": "converted",
    "followUpNote": "Compra aprovada via Pix após disparo da Bia."
  }'
```

---

## 📈 7. Analytics & Performance (`/api/v1/companies/:idOrSlug/analytics`)

Retorna métricas consolidadas em tempo real:
- Total de leads recuperados
- Taxa de conversão de mensagens
- Volume financeiro recuperado (R$)
- Desempenho individual por agente (Bia, Luana, Renato)

- **Método:** `GET`
- **Rota:** `/api/v1/companies/:idOrSlug/analytics`

```bash
curl -X GET "https://sac.casaldotrafego.com/api/v1/companies/autonomia/analytics" \
  -H "Authorization: Bearer SUA_API_KEY"
```

---

## 🔗 8. Webhooks de Entrada das Plataformas

Endpoints para recebimento direto de eventos de checkout e mensagens:

| Plataforma | Endpoint do Webhook | Formato |
| :--- | :--- | :--- |
| **WhatsApp Cloud API** | `/api/webhooks/whatsapp` | Meta Cloud JSON |
| **Instagram Direct** | `/api/webhooks/instagram` | Meta Graph JSON |
| **Hotmart** | `/api/webhooks/hotmart/:slug` | Hotmart 2.0 Webhook |
| **Kiwify** | `/api/webhooks/kiwify/:slug` | Kiwify Webhook Payload |
| **Greenn** | `/api/webhooks/greenn/:slug` | Greenn Postback |
| **Zouti** | `/api/webhooks/zouti/:slug` | Zouti Event JSON |

> **Nota:** Quando qualquer webhook recebe uma mensagem de um novo contato que não existia no banco, o sistema cria o registro em `recovery_leads` instantaneamente com `channel: "whatsapp"`, vincula a mensagem e torna a conversa visível no Inbox.
