# Smoke tests locais do SAC

Pré-requisitos: Node 22+, pnpm 9.15.4, Docker acessível e portas loopback disponíveis.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:e2e:report
```

`pnpm test:e2e:list` apenas descobre os testes; não prova que passaram.

## Isolamento

- URL fixa `http://127.0.0.1:3217`; não há variável para apontar a produção e não se reutiliza servidor existente.
- O runner cria um Postgres 16 descartável com nome e senha aleatórios, porta aleatória publicada só em loopback e banco `sac_e2e`. Não usa volumes persistentes nem banco fornecido pelo ambiente.
- Aplica `src/lib/db/schema.ts` real com `drizzle-kit push --force`, como os testes de integração existentes.
- Copia a aplicação para `.e2e-runtime-*`, sem `.env`. Passa ao Next uma lista fechada de variáveis, sem credenciais de integrações.
- Só na cópia temporária, troca o adaptador Neon HTTP por Drizzle/postgres-js local e substitui o carregamento de fontes remotas. Rotas, autenticação, componentes e regras de negócio são os reais. Portanto estes testes não validam o transporte Neon nem `ensureSchema`.
- A autenticação usa o cookie HMAC real com segredo sintético. Testa duas empresas com usuários proprietários distintos; não simula autenticação remota do Stack nem OAuth.
- Bloqueia conexões externas do servidor Node e do navegador. Não cria jobs, não chama envios válidos nem sincronizações externas; cadastro manual usa `triggerSequence=false`.
- Ao encerrar normalmente, em falha ou SIGINT/SIGTERM, remove seu próprio container e a cópia temporária. Após SIGKILL, remova apenas o container `sac-e2e-*` e a pasta `.e2e-runtime-*` da execução interrompida.

## Cobertura

Páginas principais (dashboard, leads, analytics, agente/agenda, pipeline, configurações, Instagram, campanhas, follow-up, boleto e Pix); redirecionamento ao login; validação de telefone; cadastro sem disparo; histórico do inbox; tags comuns; isolamento Alpha/Beta em leitura e escrita; rejeição de cron/webhooks sem credencial. Falhas JS e respostas HTTP 5xx no navegador reprovam o teste.

Não cobre entregabilidade de provedores, OAuth, sincronização real dos bots, pagamentos reais, ambiente Vercel ou migrações de produção. Não cadastrar nenhum segredo de produção nos fixtures.

## Estado da validação em 26/09/2026

A descoberta dos testes e a checagem TypeScript foram executadas. A execução E2E foi tentada, mas este ambiente bloqueou o Docker (`permission denied`) e abertura de portas (`EPERM`). **Nenhum fluxo de navegador foi validado ponta a ponta nesta sessão.** Rode a suíte acima em máquina/CI com os pré-requisitos antes de considerar a infraestrutura homologada. Falha de Docker encerra com erro, sem converter os testes em skips verdes.
