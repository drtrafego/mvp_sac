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

  const PAGINAS = [
    { id: "visao", rotulo: "Visão geral", eyebrow: "Panorama do atendimento",
      icone: svg('<path d="M3.5 12.5h4l2.5 5 4-13 2.5 8h4"/>') },
    { id: "conversas", rotulo: "Conversas", eyebrow: "Central de atendimento",
      icone: svg('<path d="M20.5 12.2a7.7 7.7 0 0 1-8.3 7.7 8.6 8.6 0 0 1-2.6-.5L4 21l1.6-5a7.7 7.7 0 0 1-.6-3 7.7 7.7 0 0 1 7.7-7.7 7.7 7.7 0 0 1 7.8 6.9Z"/>') },
    { id: "pipeline", rotulo: "Pipeline", eyebrow: "Funil de atendimento",
      icone: svg('<path d="M3 5.5h18l-7 7.5v6l-4 2.5v-8.5Z"/>') },
    { id: "canais", rotulo: "Canais", eyebrow: "Desempenho por canal",
      icone: svg('<circle cx="6" cy="12" r="2.6"/><circle cx="17.5" cy="6.5" r="2.6"/><circle cx="17.5" cy="17.5" r="2.6"/><path d="m8.3 10.8 6.9-3.2m0 9-6.9-3.2"/>') },
    { id: "origens", rotulo: "Origens", eyebrow: "De onde vêm os contatos",
      icone: svg('<path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>') },
    { id: "operacao", rotulo: "Operação", eyebrow: "Saúde da entrega e auditoria",
      icone: svg('<path d="M3.5 13.5h4l2-4 3 8 2-4h6"/><circle cx="12" cy="12" r="9.3"/>') }
  ];

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

  function pintarNav() {
    const alvo = document.getElementById("nav-paginas");
    if (!alvo) return;
    alvo.innerHTML = PAGINAS.map((p) =>
      '<button type="button" data-pagina="' + esc(p.id) + '"' +
      (estado.pagina === p.id ? ' class="ativa" aria-current="page"' : "") + ">" +
      p.icone + "<span>" + esc(p.rotulo) + "</span></button>").join("");
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
    if (filtros) filtros.hidden = pagina.id === "conversas";
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
    PAGINAS: PAGINAS,
    PERIODOS: PERIODOS,
    pagina: () => estado.pagina,
    periodo: () => estado.periodo,
    mostrar: mostrar,
    trocarPeriodo: trocarPeriodo
  };
})(typeof window !== "undefined" ? window : globalThis);
