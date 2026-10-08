# SAC Lote 1 — escopo e evidências de revisão

Base recebida do Gemini: branch `feat/sac-lote1`, commit `1039952d117ebb8751c8a1da40c7ece35474e655`, sobre `83b078f`. As correções locais estão separadas para revisão; este documento não afirma implantação em produção.

## Escopo

O Lote 1 corresponde ao núcleo do plano: contexto do atendimento ligado ao pipeline existente, notas internas, respostas aprovadas, busca, regras internas, tratamento do envio e autorização. A lista anterior de vinte tarefas desta entrega não correspondia às vinte oportunidades do roadmap. Copiloto/áudio e upgrades como CSAT, widget, vínculo de canais e conhecimento versionado continuam fora deste lote.

A pausa já existia e funcionava na operação. A revisão preserva o recurso e corrige regressões introduzidas na execução: a IA pode enviar a última resposta quando ela própria encerra a rodada, mas uma pausa humana posterior impede o efeito. Não foi criado outro executor Hermes.

## Evidência de testes

`scripts/sac-lote1-core.test.ts` contém treze casos, porém dez conferem exemplos/objetos definidos no próprio teste. Apenas três exercitam helpers reais de contato, cargo e snippet. Essa bateria não demonstra APIs, isolamento completo, concorrência, migração, transporte nem interface; não sustenta a declaração anterior de “100% implementado e testado”. O cabeçalho que anuncia Docker/`TEST_DATABASE_URL` não corresponde ao código daquele script.

Nesta revisão foram executados:

- `scripts/sac-ai-reply-flow.test.ts`: 12 testes do handler de produção com dependências controladas, incluindo geração atrasada, pausa humana, encerramento próprio, aviso falho reusado sem repetir ação, estados incertos/pendentes e histórico sem falas não enviadas. Inclui execução de `executarAcaoDetectada` com consulta de slots e guarda antes de marcar.
- `scripts/sac-channel-send-metrics.test.ts`: 4 testes do agregador utilizado pela tela, incluindo separação por canal e estados sem evidência.

Comandos reproduzíveis (Node 24 e dependências do projeto):

```sh
node --experimental-test-module-mocks --import tsx --test scripts/sac-ai-reply-flow.test.ts
node --import tsx --test scripts/sac-channel-send-metrics.test.ts
```

Os testes da revisão executam lógica da aplicação, com transportes e armazenamento substituídos. Não comprovam execução externa do Hermes, disponibilidade do canal nem equivalência integral de um banco real. O fechamento geral de typecheck, build, migrações e demais aceites pertence ao relatório final da revisão.

## Estado de ação e aviso

O estado retornado por uma ação de agenda é preservado antes do aviso. O aviso utiliza uma identidade estável por empresa, lead e mensagem recebida. Quando já há um aviso falho, a rodada tenta esse aviso com o mesmo conteúdo/identidade, sem gerar novamente nem repetir a ação; avisos aceitos, pendentes ou incertos não são reenviados automaticamente.

Uma pausa durante uma ação já aceita pelo serviço externo não desfaz essa ação. Ela impede o aviso externo, que continua recuperável. Existe uma limitação de infraestrutura: uma queda ou falha do banco entre a aceitação externa da agenda e a persistência local pode perder a evidência da ação. Sem idempotência ou reconciliação no serviço de agenda, não há garantia de execução única após esse tipo de interrupção. Não reaplicar automaticamente ações cujo resultado externo seja desconhecido.

## Indicadores

A tela `/canais` conta intentos por canal e separa aceitos, falhos, pendentes, incertos e histórico sem confirmação. Aceitação não é entrega/leitura. Registros `accepted` sem identificador externo entram no contador conservador “sem confirmação de aceitação”; isso não os declara falhos. O histórico deste SAC não mede entrega/leitura de todos esses envios. Credenciais salvas são configuração, não comprovação de conexão saudável. A configuração atual do WhatsApp não identifica o provedor utilizado em mensagens antigas.

## Validação ainda necessária

Revisar os resultados completos das APIs, banco/migração e concorrência, a interface desktop/celular com dados persistidos e o percurso do runtime externo. Preservar a separação entre pipeline comercial, caso de atendimento, controle do bot, ação externa e resultado do aviso. A decisão de incorporar a branch e o veredito do lote são apresentados pelo revisor responsável após os checks.

## Fechamento da revisão integrada — 08/10/2026

`npm run test:sac-lote1` passou: **88 registros de teste, correspondentes a 87 cenários e um agrupador**, em nove arquivos. Os cenários incluem sender/loader e handlers reais com Drizzle/PostgreSQL WASM, migrações aplicadas duas vezes, conflitos, isolamento, pendências em lotes, helpers utilizados pela interface, fluxo de IA/agenda e métricas. Hermes, autenticação externa e transportes são controlados nos testes; não foram usados dados de produção.

O projeto inclui `@electric-sql/pglite@0.3.14` como dependência de desenvolvimento. A bateria requer Node 24. O manifesto e o lockfile foram verificados com PNPM 9.15.4 em modo frozen. Os treze exemplos do script original não compõem esses 87 cenários.

Lint de todos os arquivos TypeScript alterados: cinco erros preexistentes de `no-explicit-any` em `src/lib/db/index.ts` e onze advertências; não foram introduzidos erros novos. As verificações de tipos e o build completo são registrados no relatório final. A falha antiga de exportação de classe no webhook Instagram foi corrigida por extração para um módulo próprio, preservando o comportamento.

Consenso dos cinco revisores: a entrega original não era 100% concluída. O código corrigido segue para homologação da interface, dois operadores, migração com histórico representativo e canais reais. Configuração administrativa de políticas/macros continua por API; pendências exibem até 50 itens. Auditoria de claim/contexto/notas continua separada da atualização, com falhas observáveis em log; não há promessa de atomicidade desses eventos nem de execução única da agenda após uma interrupção entre serviço externo e banco.

Esta revisão não publicou mudanças, fez merge ou abriu PR. A `main` em `16bff8b` possui três commits posteriores à base do lote; a integração deve preservar essas mudanças, incluindo a política de templates WhatsApp, e repetir os checks.
