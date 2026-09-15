/* Navegação por páginas e seletor de período do painel SAC.
 *
 * Só cuida de qual seção está visível e de qual janela de tempo está escolhida.
 * Não busca dado: publica os eventos `sac:pagina` e `sac:periodo` para quem
 * desenha reagir. Assim o app.js e a camada de analytics não precisam se
 * conhecer.
 */
(function (global) {
  "use strict";

  const svg = (corpo) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + corpo + "</svg>";

  /* Navegacao em arvore. Cada secao agrupa paginas irmas; secao sem `paginas`
   * e ela propria um item clicavel. Acrescentar uma plataforma de checkout e
   * uma entrada aqui - nada mais no painel muda.
   *
   * `fonte` diz de onde vem o dado da pagina:
   *   "sac"          - backend do SAC, ja existe;
   *   "recuperador"  - depende da integracao com o RecuperaVendas (Neon), que
   *                    ainda nao esta ligada. A pagina existe e diz isso, em
   *                    vez de mostrar tela falsa.
   */
  const SECOES = [
    {
      id: "atendimento", rotulo: "Atendimento",
      paginas: [
        { id: "visao", rotulo: "Visão geral", eyebrow: "Panorama do atendimento", fonte: "sac",
          icone: svg('<path d="M3.5 12.5h4l2.5 5 4-13 2.5 8h4"/>') },
        { id: "conversas", rotulo: "Conversas", eyebrow: "Central de atendimento", fonte: "sac",
          icone: svg('<path d="M20.5 12.2a7.7 7.7 0 0 1-8.3 7.7 8.6 8.6 0 0 1-2.6-.5L4 21l1.6-5a7.7 7.7 0 0 1-.6-3 7.7 7.7 0 0 1 7.7-7.7 7.7 7.7 0 0 1 7.8 6.9Z"/>') },
        { id: "pipeline", rotulo: "Pipeline", eyebrow: "Funil de atendimento", fonte: "sac",
          icone: svg('<path d="M3 5.5h18l-7 7.5v6l-4 2.5v-8.5Z"/>') }
      ]
    },
    {
      id: "analise", rotulo: "Análise",
      paginas: [
        { id: "canais", rotulo: "Canais", eyebrow: "Desempenho por canal", fonte: "sac",
          icone: svg('<circle cx="6" cy="12" r="2.6"/><circle cx="17.5" cy="6.5" r="2.6"/><circle cx="17.5" cy="17.5" r="2.6"/><path d="m8.3 10.8 6.9-3.2m0 9-6.9-3.2"/>') },
        { id: "origens", rotulo: "Origens", eyebrow: "De onde vêm os contatos", fonte: "sac",
          icone: svg('<path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>') },
        { id: "operacao", rotulo: "Operação", eyebrow: "Saúde da entrega e auditoria", fonte: "sac",
          icone: svg('<path d="M3.5 13.5h4l2-4 3 8 2-4h6"/><circle cx="12" cy="12" r="9.3"/>') }
      ]
    },
    {
      id: "api_oficial", rotulo: "API Oficial", marca: "#0866FF",
      icone: svg('<path d="M4.4 8.1c1.9-2.7 4.5-2.1 6.2.6l1.4 2.3 1.4-2.3c1.7-2.7 4.3-3.3 6.2-.6 1.7 2.3 1.7 5.5 0 7.8-1.9 2.7-4.5 2.1-6.2-.6L12 13l-1.4 2.3c-1.7 2.7-4.3 3.3-6.2.6-1.7-2.3-1.7-5.5 0-7.8Z"/>'),
      paginas: [
        { id: "api_modelos", rotulo: "Mensagens aprovadas", eyebrow: "Modelos aprovados pela Meta", fonte: "pendente" },
        { id: "api_campanhas", rotulo: "Campanhas ativas", eyebrow: "Disparos em andamento", fonte: "pendente" },
        { id: "api_followup", rotulo: "Follow-up", eyebrow: "Sequências de acompanhamento", fonte: "pendente" }
      ]
    },
    {
      id: "hotmart", rotulo: "Hotmart", marca: "#F04E23",
      icone: svg('<circle cx="12" cy="12" r="9.2"/><path d="M8.6 15.4V8.6M15.4 15.4V8.6M8.6 12h6.8"/>'),
      paginas: [
        { id: "hot_carrinho", rotulo: "Carrinho abandonado", eyebrow: "Hotmart · carrinho abandonado", fonte: "recuperador" },
        { id: "hot_boleto", rotulo: "Boleto e Pix", eyebrow: "Hotmart · pagamento pendente", fonte: "recuperador" },
        { id: "hot_recusado", rotulo: "Cartão recusado", eyebrow: "Hotmart · cartão recusado", fonte: "recuperador" },
        { id: "hot_aprovada", rotulo: "Compra aprovada", eyebrow: "Hotmart · pós-venda", fonte: "recuperador" }
      ]
    },
    {
      id: "ajustes", rotulo: "Ajustes",
      paginas: [
        { id: "configuracao", rotulo: "Configuração", eyebrow: "Contas dos canais e credenciais", fonte: "sac",
          icone: svg('<circle cx="12" cy="12" r="3.4"/><path d="M19.4 15a1.5 1.5 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.5 1v.2a1.9 1.9 0 1 1-3.8 0a1.5 1.5 0 0 0-2.6-1l-.1.1a1.9 1.9 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1-2.5H4.3a1.9 1.9 0 1 1 0-3.8a1.5 1.5 0 0 0 1-2.6l-.1-.1a1.9 1.9 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3a1.5 1.5 0 0 0 .9-1.4V4.3a1.9 1.9 0 1 1 3.8 0a1.5 1.5 0 0 0 2.5 1l.1-.1a1.9 1.9 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0 1 2.5h.2a1.9 1.9 0 1 1 0 3.8h-.1a1.5 1.5 0 0 0-1.4.9Z"/>') }
      ]
    }
  ];

  const PAGINAS = SECOES.flatMap((s) => s.paginas.map((p) => Object.assign({ secao: s.id }, p)));

  const PERIODOS = [
    { id: "7d", rotulo: "7 dias" },
    { id: "30d", rotulo: "30 dias" },
    { id: "90d", rotulo: "90 dias" }
  ];

  const CHAVE_PAGINA = "sac.pagina";
  const CHAVE_PERIODO = "sac.periodo";

  /* localStorage pode lançar (janela privativa, captura de miniatura, site
   * data bloqueado). Nunca deixar isso derrubar a navegação. */
  const lembrar = (chave, valor) => { try { localStorage.setItem(chave, valor); } catch (e) { /* conveniência */ } };
  const lembrado = (chave, padrao) => {
    try { return localStorage.getItem(chave) || padrao; } catch (e) { return padrao; }
  };

  const estado = {
    pagina: PAGINAS.some((p) => p.id === lembrado(CHAVE_PAGINA, "")) ? lembrado(CHAVE_PAGINA, "visao") : "visao",
    periodo: PERIODOS.some((p) => p.id === lembrado(CHAVE_PERIODO, "")) ? lembrado(CHAVE_PERIODO, "30d") : "30d"
  };

  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const CHAVE_ABERTAS = "sac.secoes";
  const abertas = () => {
    const bruto = lembrado(CHAVE_ABERTAS, "");
    if (!bruto) return new Set(SECOES.map((s) => s.id));   // tudo aberto na primeira visita
    return new Set(bruto.split(",").filter(Boolean));
  };
  let secoesAbertas = null;

  function pintarNav() {
    const alvo = document.getElementById("nav-paginas");
    if (!alvo) return;
    if (!secoesAbertas) secoesAbertas = abertas();
    const atual = PAGINAS.find((p) => p.id === estado.pagina);
    if (atual) secoesAbertas.add(atual.secao);          // a secao da pagina ativa nunca fica fechada

    alvo.innerHTML = SECOES.map((sec) => {
      const aberta = secoesAbertas.has(sec.id);
      const temAtiva = sec.paginas.some((p) => p.id === estado.pagina);
      const itens = sec.paginas.map((p) =>
        '<button type="button" class="nav-item' + (estado.pagina === p.id ? " ativa" : "") +
        (p.fonte !== "sac" ? " pendente" : "") + '" data-pagina="' + esc(p.id) + '"' +
        (estado.pagina === p.id ? ' aria-current="page"' : "") + ">" +
        (p.icone || '<span class="nav-marcador"></span>') +
        "<span>" + esc(p.rotulo) + "</span>" +
        (p.fonte !== "sac" ? '<i class="nav-pendente" title="fonte de dados ainda não ligada"></i>' : "") +
        "</button>").join("");
      return (
        '<div class="nav-secao-bloco' + (aberta ? " aberta" : "") + (temAtiva ? " com-ativa" : "") + '"' +
        (sec.marca ? ' style="--marca:' + sec.marca + '"' : "") + ">" +
        '<button type="button" class="nav-secao-topo" data-secao="' + esc(sec.id) + '"' +
        ' aria-expanded="' + (aberta ? "true" : "false") + '">' +
        (sec.icone ? '<span class="nav-secao-icone">' + sec.icone + "</span>" : "") +
        "<span>" + esc(sec.rotulo) + "</span>" +
        '<i class="nav-seta" aria-hidden="true"></i></button>' +
        '<div class="nav-filhos">' + itens + "</div></div>"
      );
    }).join("");
  }

  function alternarSecao(id) {
    if (!secoesAbertas) secoesAbertas = abertas();
    if (secoesAbertas.has(id)) secoesAbertas.delete(id); else secoesAbertas.add(id);
    lembrar(CHAVE_ABERTAS, Array.from(secoesAbertas).join(","));
    pintarNav();
  }

  function pintarPeriodo() {
    const alvo = document.getElementById("filtros-periodo");
    if (!alvo) return;
    alvo.innerHTML = PERIODOS.map((p) =>
      '<button type="button" data-periodo="' + esc(p.id) + '"' +
      (estado.periodo === p.id ? ' class="ativo" aria-pressed="true"' : ' aria-pressed="false"') +
      ">" + esc(p.rotulo) + "</button>").join("");
  }

  function mostrar(paginaId) {
    const pagina = PAGINAS.find((p) => p.id === paginaId);
    if (!pagina) return;
    estado.pagina = pagina.id;
    lembrar(CHAVE_PAGINA, pagina.id);
    document.querySelectorAll(".pagina").forEach((secao) =>
      secao.classList.toggle("ativa", secao.dataset.pagina === pagina.id));
    const eyebrow = document.getElementById("pagina-eyebrow");
    if (eyebrow) eyebrow.textContent = pagina.eyebrow;
    /* O período só faz sentido nas páginas de métrica; em Conversas ele
     * confundiria, porque a caixa de entrada não é recortada por janela. */
    const filtros = document.getElementById("filtros-periodo");
    if (filtros) filtros.hidden = !["visao", "canais", "origens", "operacao", "pipeline"].includes(pagina.id);
    pintarNav();
    global.dispatchEvent(new CustomEvent("sac:pagina", { detail: { pagina: pagina.id } }));
  }

  function trocarPeriodo(periodoId) {
    if (!PERIODOS.some((p) => p.id === periodoId)) return;
    estado.periodo = periodoId;
    lembrar(CHAVE_PERIODO, periodoId);
    pintarPeriodo();
    global.dispatchEvent(new CustomEvent("sac:periodo", { detail: { periodo: periodoId } }));
  }

  function iniciar() {
    pintarNav();
    pintarPeriodo();
    mostrar(estado.pagina);

    const nav = document.getElementById("nav-paginas");
    if (nav) nav.addEventListener("click", (ev) => {
      const secao = ev.target.closest("button[data-secao]");
      if (secao) { alternarSecao(secao.dataset.secao); return; }
      const botao = ev.target.closest("button[data-pagina]");
      if (botao) mostrar(botao.dataset.pagina);
    });

    const filtros = document.getElementById("filtros-periodo");
    if (filtros) filtros.addEventListener("click", (ev) => {
      const botao = ev.target.closest("button[data-periodo]");
      if (botao) trocarPeriodo(botao.dataset.periodo);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();

  global.SACNavegacao = {
    SECOES: SECOES,
    PAGINAS: PAGINAS,
    PERIODOS: PERIODOS,
    pagina: () => estado.pagina,
    periodo: () => estado.periodo,
    mostrar: mostrar,
    trocarPeriodo: trocarPeriodo
  };
})(typeof window !== "undefined" ? window : globalThis);
