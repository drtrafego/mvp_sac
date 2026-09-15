/* Liga as páginas de métrica aos relatórios de analytics do backend.
 *
 * Carrega DEPOIS do app.js e usa o que ele já expõe: `api`, `agentPath`,
 * `currentSource`, `state` e `BACKEND_KIND`. Não abre sessão, não escreve e
 * não conhece tenant — quem resolve o agente é o servidor.
 *
 * Redesenha quando muda a página, o período ou a fonte, e só busca de novo
 * quando a combinação (fonte, período, página) muda de verdade.
 */
(function (global) {
  "use strict";

  const G = () => global.SACGraficos;
  const N = () => global.SACNavegacao;

  const PAGINAS_COM_METRICA = {
    visao: ["overview", "channels", "origins", "response-times"],
    canais: ["channels", "response-times"],
    origens: ["origins"],
    operacao: ["health", "operators"],
    pipeline: ["pipeline"]
  };

  const cache = new Map();          // chave -> payload
  let ultimaChave = null;
  let buscando = false;

  const chaveDe = (fonte, periodo, pagina) =>
    [fonte ? fonte.id : "-", periodo, pagina].join("|");

  function alvo(id) { return document.getElementById(id); }

  function aviso(ids, texto) {
    for (const id of ids) {
      const el = alvo(id);
      if (el) el.innerHTML = '<div class="grafico-vazio">' + texto + "</div>";
    }
  }

  async function buscar(fonte, periodo, relatorios) {
    const saida = {};
    await Promise.all(relatorios.map(async (rel) => {
      const caminho = agentPath(fonte, "/analytics/" + rel) + "?periodo=" + encodeURIComponent(periodo);
      try {
        saida[rel] = await api(caminho);
      } catch (erro) {
        saida[rel] = { __erro: erro && erro.reason ? erro.reason : "falhou" };
      }
    }));
    return saida;
  }

  /* delta.percent vem null quando o período anterior é zero. Cliente novo não
   * pode ver "+100%" inventado; mostra travessão. */
  const variacao = (d) => (d && d.percent != null && isFinite(d.percent) ? d.percent / 100 : null);

  function destaquesVisao(dados) {
    const g = G();
    const o = (dados.overview || {}).totals || {};
    const d = (dados.overview || {}).delta || {};
    const tr = (dados["response-times"] || {}).firstResponse || {};
    return (
      g.destaque({ rotulo: "Conversas no período", valor: g.numero(o.conversations), variacao: variacao(d.conversations) }) +
      g.destaque({ rotulo: "Contatos únicos", valor: g.numero(o.contacts), variacao: variacao(d.contacts) }) +
      g.destaque({ rotulo: "Mensagens trocadas", valor: g.numero(o.messages), variacao: variacao(d.messages) }) +
      (tr.medianSeconds != null
        ? g.destaque({ rotulo: "1ª resposta (mediana)", valor: g.duracao(tr.medianSeconds), inverso: true })
        : g.destaque({ rotulo: "1ª resposta (mediana)", valor: "—", apoio: "sem resposta registrada no período" }))
    );
  }

  const serieCanais = (dados, campo) =>
    ((dados.channels || {}).channels || [])
      .filter((c) => (c.series || []).some((p) => Number(p[campo]) > 0))
      .map((c) => ({ nome: c.channel, pontos: (c.series || []).map((p) => ({ x: p.date, y: p[campo] })) }));

  const itensCanais = (dados, campo) =>
    ((dados.channels || {}).channels || [])
      .map((c) => ({ chave: c.channel, rotulo: rotuloCanal(c.channel), valor: c[campo] || 0 }))
      .filter((c) => c.valor > 0);

  const ROTULO_CANAL = { whatsapp: "WhatsApp", instagram: "Instagram", email: "E-mail" };
  const rotuloCanal = (c) => ROTULO_CANAL[c] || c;

  function itensOrigens(dados, limite) {
    const O = global.SACOrigens;
    return ((dados.origins || {}).origins || [])
      .slice(0, limite || 8)
      .map((o) => {
        const vista = O ? O.resolverOrigem({ slug: o.slug, label: o.label, platform: o.platform, channel: o.channel }) : null;
        const ferramenta = O && vista ? O.resolverFerramenta(vista.ferramenta) : null;
        return {
          rotulo: (vista && vista.label) || o.label || o.slug,
          valor: o.contacts || 0,
          cor: ferramenta ? ferramenta.cor : null,
          icone: vista && vista.glifo && O ? O.desenho(vista.glifo) : ""
        };
      })
      .filter((o) => o.valor > 0);
  }

  /* ------------------------------------------------------------ desenhos */

  function pintarVisao(dados) {
    const g = G();
    alvo("visao-destaques").innerHTML = destaquesVisao(dados);
    const series = serieCanais(dados, "conversations");
    alvo("visao-serie").innerHTML = series.length
      ? g.serieTemporal(series, { titulo: "Conversas por dia", largura: 900, altura: 250 })
      : '<div class="grafico-vazio">Nenhuma conversa registrada no período.</div>';
    alvo("visao-canais").innerHTML = g.participacao(itensCanais(dados, "conversations"),
      { titulo: "Participação por canal", vazio: "Nenhum canal com conversa no período." });
    alvo("visao-origens").innerHTML = g.barras(itensOrigens(dados, 6),
      { titulo: "Origens que mais trazem contato", vazio: "Nenhuma origem identificada no período." });
  }

  function pintarCanais(dados) {
    const g = G();
    const canais = (dados.channels || {}).channels || [];
    alvo("canais-destaques").innerHTML = canais.map((c) =>
      g.destaque({
        rotulo: rotuloCanal(c.channel),
        valor: g.numero(c.conversations),
        variacao: variacao((c.delta || {}).conversations),
        apoio: g.numero(c.messages) + " mensagens"
      })).join("") || '<div class="grafico-vazio">Nenhum canal configurado.</div>';

    const series = serieCanais(dados, "messages");
    alvo("canais-serie").innerHTML = series.length
      ? g.serieTemporal(series, { titulo: "Mensagens por dia e canal", largura: 900, altura: 250 })
      : '<div class="grafico-vazio">Nenhuma mensagem no período.</div>';

    alvo("canais-participacao").innerHTML = g.participacao(itensCanais(dados, "messages"),
      { titulo: "Participação nas mensagens" });

    const tempos = (dados["response-times"] || {}).byChannel || [];
    alvo("canais-tempos").innerHTML = g.barras(
      tempos.map((t) => ({
        chave: t.channel, rotulo: rotuloCanal(t.channel),
        valor: (t.firstResponse || {}).medianSeconds || 0,
        apoio: (t.firstResponse || {}).p90Seconds != null
          ? "p90 " + g.duracao(t.firstResponse.p90Seconds) : ""
      })).filter((t) => t.valor > 0),
      { titulo: "Mediana da 1ª resposta", formato: g.duracao,
        vazio: "Sem resposta registrada para medir." });
  }

  function pintarOrigens(dados) {
    const g = G();
    const t = (dados.origins || {}).totals || {};
    alvo("origens-barras").innerHTML =
      g.barras(itensOrigens(dados, 12), { titulo: "Contatos por origem de aquisição",
        vazio: "Nenhuma origem registrada no período." }) +
      (t.identifiedShare != null
        ? '<p class="kb-ajuda">' + g.decimal(t.identifiedShare, 1) +
          "% dos contatos chegaram com origem identificada. Quando esse número cai, " +
          "costuma ser rastreamento quebrado, não campanha ruim.</p>"
        : "");
  }

  function pintarOperacao(dados) {
    const g = G();
    const h = dados.health || {};
    if (h.__erro) { aviso(["operacao-saude", "operacao-operadores"], "Não foi possível ler a saúde da fila."); return; }
    const ob = h.outbox || {}, dl = h.deadLetters || {}, inb = h.inbound || {};
    const selo = { ok: "bom", atencao: "atencao", critico: "critico" }[h.status] || "bom";
    const rotuloEstado = { ok: "Entregando", atencao: "Atenção", critico: "Crítico" }[h.status] || "—";

    alvo("operacao-saude").innerHTML =
      item(g.numero(ob.backlog), "na fila de saída",
           ob.oldestAgeSeconds != null ? "mais antigo: " + g.duracao(ob.oldestAgeSeconds) : "", selo, rotuloEstado) +
      item(g.numero(dl.total), "em dead-letter",
           dl.total ? "exige intervenção manual" : "nada travado", dl.total ? "critico" : "bom",
           dl.total ? "Travado" : "Limpo") +
      item(g.numero(inb.unprocessed), "webhooks não processados",
           inb.oldestAgeSeconds != null ? "mais antigo: " + g.duracao(inb.oldestAgeSeconds) : "",
           inb.unprocessed ? "atencao" : "bom", inb.unprocessed ? "Acumulando" : "Em dia");

    const ops = (dados.operators || {}).operators || [];
    alvo("operacao-operadores").innerHTML = g.barras(
      ops.map((o) => ({ rotulo: o.actorId || "(sistema)", valor: o.actions || 0 })),
      { titulo: "Ações por operador na auditoria",
        vazio: "Nenhuma ação registrada no período." });
  }

  const item = (valor, rotulo, apoio, estado, rotuloEstado) =>
    '<div class="saude-item"><strong>' + valor + "</strong><span>" + rotulo + "</span>" +
    (apoio ? "<span>" + apoio + "</span>" : "") +
    '<span class="selo-estado ' + estado + '">' + rotuloEstado + "</span></div>";

  /* O quadro sai do estado que o app.js ja carregou (conversas + etapas), nao
   * do relatorio: kanban precisa dos cartoes individuais, e analytics so
   * devolve agregado. Mover chama a escrita auditada que ja existe. */
  function montarKanban() {
    const K = global.SACKanban;
    const caixa = alvo("pipeline-kanban");
    if (!K || !caixa) return;
    const fonte = typeof currentSource === "function" ? currentSource() : null;
    const etapas = (state.pipeline || []).map((e) => ({
      id: e.id,
      titulo: (typeof stageView === "function" ? stageView(e.id).label : e.id)
    }));
    const cartoes = (state.conversations || []).map((c) => ({
      id: c.id,
      etapa: c.contact && c.contact.pipelineStage,
      nome: (c.contact && c.contact.displayName) || "Contato sem nome",
      canal: c.channel,
      origem: c.origin,
      // lastMessage e um objeto {direction,status,occurredAt,text}; usar o
      // objeto direto imprimia "[object Object]" no cartao.
      previa: (c.lastMessage && c.lastMessage.text) || "",
      quando: typeof relativeTime === "function"
        ? relativeTime((c.lastMessage && c.lastMessage.occurredAt) || c.updatedAt) : "",
      responsavel: c.assignedTo,
      etapaRotulo: typeof stageView === "function" && c.contact
        ? stageView(c.contact.pipelineStage).label : "",
      criadoEm: c.createdAt
    }));
    K.montar(caixa, {
      colunas: etapas,
      cartoes: cartoes,
      podeEscrever: !!(fonte && fonte.permissions && fonte.permissions.write && state.session),
      aoMover: async (conversaId, etapa) => {
        const conversa = (state.conversations || []).find((c) => c.id === conversaId);
        if (!conversa || !conversa.contact) return;
        try {
          await moveStage(conversa.contact.id, etapa);
          conversa.contact.pipelineStage = etapa;
        } catch (erro) {
          // Falhou a gravacao: redesenhar devolve o cartao para a coluna real.
          if (typeof render === "function") render();
        }
      },
      aoSelecionar: (conversaId) => {
        state.conversationId = conversaId;
        if (global.SACNavegacao) global.SACNavegacao.mostrar("conversas");
        if (typeof render === "function") render();
      }
    });
  }

  function pintarPipeline(dados) {
    const g = G();
    montarKanban();
    const etapas = (dados.pipeline || {}).stages || [];
    alvo("pipeline-funil").innerHTML = g.funil(
      etapas.map((e) => ({
        rotulo: (typeof stageView === "function" ? stageView(e.id).label : e.id),
        valor: e.contacts || 0,
        tempoMedio: (e.timeInStage || {}).medianSeconds
      })),
      { titulo: "Funil de atendimento", vazio: "Pipeline sem contatos no período." });
  }

  const PINTORES = { visao: pintarVisao, canais: pintarCanais, origens: pintarOrigens,
                     operacao: pintarOperacao, pipeline: pintarPipeline };

  const CONTEINERES = {
    visao: ["visao-destaques", "visao-serie", "visao-canais", "visao-origens"],
    canais: ["canais-destaques", "canais-serie", "canais-participacao", "canais-tempos"],
    origens: ["origens-barras"], operacao: ["operacao-saude", "operacao-operadores"],
    pipeline: ["pipeline-funil"]
  };

  /* ------------------------------------------------------------- controle */

  async function atualizar(forcar) {
    const nav = N();
    if (!nav || !G()) return;
    const pagina = nav.pagina();
    const relatorios = PAGINAS_COM_METRICA[pagina];
    if (!relatorios) return;                       // Conversas não usa analytics

    const fonte = typeof currentSource === "function" ? currentSource() : null;
    if (!fonte || fonte.kind !== BACKEND_KIND) {
      aviso(CONTEINERES[pagina], "Escolha um cliente do backend para ver métricas. " +
        "O snapshot somente leitura não expõe analytics.");
      return;
    }
    if (!state.session) {
      aviso(CONTEINERES[pagina], "Entre com seu operador para ver as métricas deste cliente.");
      return;
    }

    const chave = chaveDe(fonte, nav.periodo(), pagina);
    if (!forcar && chave === ultimaChave && cache.has(chave)) { PINTORES[pagina](cache.get(chave)); return; }
    if (buscando) return;

    buscando = true;
    aviso(CONTEINERES[pagina], "Carregando…");
    try {
      const dados = await buscar(fonte, nav.periodo(), relatorios);
      cache.set(chave, dados);
      ultimaChave = chave;
      PINTORES[pagina](dados);
      G().ativarHover(document);
    } catch (erro) {
      aviso(CONTEINERES[pagina], "Falha ao carregar as métricas.");
    } finally {
      buscando = false;
    }
  }

  global.addEventListener("sac:pagina", () => atualizar(false));
  global.addEventListener("sac:periodo", () => { cache.clear(); atualizar(true); });
  global.addEventListener("sac:render", () => atualizar(false));

  global.SACAnalytics = { atualizar: atualizar, limparCache: () => cache.clear() };
})(typeof window !== "undefined" ? window : globalThis);
