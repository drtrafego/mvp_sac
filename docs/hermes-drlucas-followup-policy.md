# Política de Follow-up de Confirmação — Hermes (Dr. Lucas)

## Contexto
O serviço de lembretes do Dr. Lucas (`/opt/gastaomatos/hermes/lembretes/`, em Python no servidor Hermes) é responsável pelo envio de mensagens de confirmações de consulta via WhatsApp 24 horas antes do horário agendado.

---

## 1. Rastreabilidade e Status de Entrega (Meta Callbacks)
- **Problema:** Respostas com HTTP 200/`sent` da Meta indicam apenas que a mensagem foi aceita pela fila da Meta, não comprovam entrega real no aparelho do paciente.
- **Regra:** O webhook do WhatsApp em `hermes.casaldotrafego.com/drlucas/whatsapp/webhook` processa e persiste os callbacks de status recebidos no array `statuses`:
  - `sent`: Aceito pela API da Meta
  - `delivered`: Entregue no dispositivo do destinatário (prova de entrega)
  - `read`: Lido pelo destinatário (confirmação visual)
  - `failed`: Falha de entrega (número inválido, bloqueio ou erro de envio)
- **Persistência:** Todo status de entrega é correlacionado via `wamid` (`external_id` / `external_wamid`) no banco de dados.

---

## 2. Política de Elegibilidade para Agendamentos de Última Hora (<24h)
- **Cenário:** Consultas agendadas pelo bot com menos de 24 horas de antecedência em relação ao horário do atendimento (ex.: consulta marcada para daqui a 6h ou no mesmo dia).
- **Decisão Explícita:** **Disparo Imediato (Immediate Dispatch)**.
  - Para agendamentos criados com janela inferior a 24 horas (`antecedencia < 24h`), o lembrete/confirmação é disparado **imediatamente** no momento da confirmação do agendamento, em vez de ser ignorado ou retido pela janela fixa `[agora+24h, agora+25h]`.
  - Agendamentos criados com `antecedencia >= 24h` mantêm a janela padrão de 24h antes do horário da consulta.
