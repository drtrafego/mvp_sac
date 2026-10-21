# Eventos do SAC no GA4 e importação no Google Ads

O SAC envia as conversões confirmadas pelo Google Analytics 4 Measurement
Protocol. O envio usa o `measurement_id` e o `api_secret` do fluxo Web da
empresa, configurados em **Configurações → Google Analytics 4**.

## Eventos enviados

- `purchase`: vendas aprovadas da Hotmart, Greenn, Kiwify e Zouti.
- `generate_lead`: reservas/agendamentos confirmados pelo Hermes, como o Dr.
  Lucas.

Cada evento leva um `client_id` determinístico, `event_id` para deduplicação,
horário em microssegundos e, quando disponíveis, valor, moeda, transação,
origem, campanha, GCLID/GBRAID/WBRAID e identificadores de contato sem texto
livre. O SAC registra o resultado em `ga4_conversion_events` e não reenvia o
mesmo `company_id + event_id`.

Para validar um payload sem registrar evento, use o mesmo JSON no endpoint de
debug do Measurement Protocol:

`https://www.google-analytics.com/debug/mp/collect?measurement_id=G-...&api_secret=...`

O código de produção usa `/mp/collect`, não `/debug/mp/collect`.

## Importação para o Google Ads

1. Aguarde o evento aparecer no GA4 e marque-o como **evento principal (key
   event)**.
2. No Google Ads, abra **Metas → Conversões → Nova ação de conversão →
   Importar → Google Analytics 4** e importe o evento.
3. Depois da importação, confira a ação. Ela nasce como **Secundária**; marque
   como **Primária** se ela deve contar para os lances automáticos.

O Google Ads não faz backfill: só recebe dados a partir do dia em que a
importação for confirmada. Fechamentos anteriores não podem ser recuperados
por esse caminho.

Referências oficiais:

- https://developers.google.com/analytics/devguides/collection/protocol/ga4
- https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events
- https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference/events
