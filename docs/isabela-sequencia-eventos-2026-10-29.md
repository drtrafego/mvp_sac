# Sequência de eventos da Isabela · auditoria de configuração

Data da conferência: 2026-10-29

Tenant conferido: `isabela-fanini` / Isabella Fanini, empresa `id=2` no checkout oficial. A integração habilitada é Kiwify. Meta oficial: conta de mensagens `1122213357065075`, número `+55 65 93618-0647`, estado `linked/registered`.

## Templates aprovados encontrados

A leitura atual da conta Meta retornou somente estes modelos `UTILITY` em `pt_BR`:

- `status_atendimento` (`878458305288945`), aprovado, corpo de status de atendimento com 3 variáveis.
- `cancelar_solicitacao_atendimento` (`1991997074800170`), aprovado, registro/cancelamento de solicitação com 3 variáveis.

Nenhum dos dois corresponde ao texto ou ao contexto de venda do Despertar das Bellas. O catálogo local do SAC estava divergente da Meta e não foi usado como prova de aprovação.

## Matriz solicitada

| Evento | Delay/condição | Template aprovado correspondente | Estado |
| --- | --- | --- | --- |
| Compra aprovada / boas-vindas + grupo | imediato após compra Kiwify de Despertar das Bellas | nenhum | bloqueado |
| D+1 / formulário | 1 dia após aprovação, uma vez por compra | nenhum; o convite à sessão gratuita é promocional | bloqueado: exige `MARKETING` aprovado + consentimento |
| D+10 / conclusão e experiência | 10 dias após aprovação, uma vez por compra | nenhum | bloqueado |
| Concluiu o desafio | resposta inbound, somente após confirmação | nenhum; o convite ao Portal é promocional | bloqueado: exige `MARKETING` aprovado + consentimento |
| Ainda não começou | resposta inbound classificada | nenhum | bloqueado |
| Começou e não terminou | resposta inbound classificada | nenhum | bloqueado |
| Carrinho abandonado | somente registro de lead/estado; cancelar ao converter | proibido criar conversa/job | protegido |
| Boleto não pago | somente com consentimento/janela e modelo aprovado | nenhum | bloqueado |
| Pix não pago | somente com consentimento/janela e modelo aprovado | nenhum | bloqueado |
| Cartão recusado | somente com consentimento/janela e modelo aprovado | nenhum | bloqueado |

Nenhum template foi criado ou submetido, nenhuma mensagem foi enviada e nenhum cron foi iniciado.

O código do checkout não aceita `MARKETING` como atalho para uma sequência da Isabela: mensagens desse tipo permanecem bloqueadas até existir aprovação específica e consentimento válido. Os dois modelos atuais de atendimento também não foram reutilizados, porque adaptar o texto de venda em variáveis seria mascarar marketing como utilidade.
