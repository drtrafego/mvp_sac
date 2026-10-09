# Atender agora e padrão visual do SAC

Esta entrega acrescenta uma fila diária a partir do card de contexto, do atendimento humano e das pendências existentes. Uma conversa aparece uma vez, mesmo quando tem vários motivos para atenção.

## Como usar

1. Abra **Atender agora** no menu de Atendimento; no celular, está também em **Mais**.
2. Selecione **Precisam de humano**, **Sem responsável**, **Vencem hoje**, **Vencidos**, **Todos** ou **Meus**.
3. Veja o motivo, responsável, próximo passo e prazo. **Abrir atendimento** entra na conversa com o Contexto aberto.
4. Use a seta de retorno para voltar à mesma visão e página da fila.
5. A lista consulta automaticamente a cada minuto com a aba visível, também ao retomar a aba. O botão Atualizar permanece disponível.

## Regras e escopo

- Empresa e usuário vêm da sessão autenticada; parâmetros enviados pelo navegador não escolhem outra empresa ou atendente.
- Precisam de humano inclui transbordo e atendimento humano em andamento. Pausar o bot, isoladamente, não cria uma demanda.
- Sem responsável considera apenas conversas acionáveis, não toda a base de leads.
- O prazo efetivo é o mais antigo entre próxima ação e retorno. Uma ação vencida ontem com retorno hoje fica em Vencidos.
- O calendário usa America/Sao_Paulo. Prazos editados como data são válidos durante todo o dia escolhido e vencem no dia seguinte.
- Casos resolvidos deixam a fila. Uma venda concluída pode continuar nela se houver uma demanda de pós-venda aberta.
- Meus exige um vínculo ativo do usuário com a empresa. Administradores sem esse vínculo podem usar as outras visões.
- A nova regra `proxima_acao_vencida` reutiliza reconciliação, episódios, auditoria e cron existentes. Não exige nova migração.
- A fila organiza atenção; não marca tarefas como concluídas, muda o pipeline ou envia mensagens automaticamente.

## Padrão visual

PageSurface padroniza o espaço das páginas e mantém Inbox/Instagram sem margens internas extras. PageHeader padroniza títulos, descrição, ícones e ações. Dashboard, Leads, Pipeline, Operação, Canais, Origens, Analytics, Agente, Configurações, Biblioteca, páginas da API, webhooks e sequências usam esse padrão.

Tokens de superfície, texto, borda e controles foram alinhados nos temas claro e escuro. Botões, seleção, campos e foco compartilham o padrão; tabelas e estados ativos receberam acabamento consistente. A seleção de tema agora funciona por teclado. No Pipeline, a altura usa o espaço disponível.

O cabeçalho da conversa mostra o Contexto e um resumo dos dados confirmados; rascunhos não aparecem como salvos. Indicadores de Operação distinguem bot liberado de resolução autônoma e não exibem SLA ou saúde ao vivo sem medição.

## Verificação técnica

```sh
pnpm test:sac-atender-agora
pnpm test:sac-lote1
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec next build --webpack
git diff --check
```

Os testes usam PostgreSQL WASM descartável (PGlite), sem acessar dados, transportes ou agentes de produção. A execução combinada de SAC Lote 1 e Atender agora aprovou 114 testes; TypeScript e lint dos novos componentes e serviços passaram.

## Conferência na homologação autenticada

- Desktop e celular: cabeçalhos, filtros, tabela/cards, rolagem do último item e ações em telas estreitas.
- Pipeline em celular na horizontal: altura útil, arrastar cards e filtros.
- Definir prazo hoje: não mostrar vencido. Definir ontem: entrar em Vencidos; mudar para amanhã: sair dessa visão.
- Resolver um atendimento, atualizar a fila e verificar a paginação se o total diminuir.
- Trocar filtros rapidamente e simular erro de consulta: preservar a visão atual, mostrar erro e permitir nova tentativa.
- Abrir atendimento, editar sem salvar e aguardar polling: resumo permanece confirmado; rascunho permanece editável.
- Dois usuários e duas empresas: validar Meus e isolamento de responsáveis.

Não foi possível concluir inspeção visual no navegador desta sessão: não havia Chromium local e o navegador remoto não abre os arquivos locais. A prévia separada usa componentes reais, fontes de sistema e dados fictícios identificados; não substitui a homologação autenticada de todas as páginas. Nenhuma configuração de autenticação foi relaxada.
