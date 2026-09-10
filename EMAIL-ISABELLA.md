# E-mail da Isabella — descoberta e decisão de integração

Levantamento somente leitura em 08/09/2026:

- `isabellafranklin.com.br` responde com `NOERROR`, mas **não publica registro
  MX**. Portanto não há, hoje, evidência DNS de uma caixa receptora ativa nesse
  domínio nem como atribuí-la a Google, Microsoft, Brevo ou outro provedor.
- Os nameservers são `ns1.vercel-dns.com` e `ns2.vercel-dns.com`; isso identifica
  a hospedagem do DNS/site, não um serviço de e-mail.
- Não foram encontrados remetente ou conta de e-mail da Isabella nos artefatos
  locais do projeto. Uma chave Brevo de outra operação não prova titularidade e
  não deve ser reutilizada.

## Decisão

O backend fica neutro até a caixa real ser informada ou o MX ser publicado:

- entrada preferencial por webhook do provedor em `/webhooks/email`, convertido
  para o envelope canônico;
- fallback por IMAP quando o provedor não oferecer evento de mensagem recebida;
- saída preferencial pela API do provedor, com SMTP como fallback;
- segredo, usuário e senha somente por variáveis de ambiente.

`/webhooks/brevo` continua como alias compatível, mas Isabella não está marcada
como cliente Brevo. Para habilitar o canal, ainda são necessários endereço da
caixa, provedor e credenciais próprias; então se confirma API/webhook ou os
hosts IMAP/SMTP publicados pelo provedor.
