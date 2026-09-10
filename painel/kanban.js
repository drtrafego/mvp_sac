/* Quadro kanban do pipeline do SAC.
 *
 * Portado do CRM do mvp_agente_ia (components/kanban) para JavaScript puro:
 * mesma leitura visual - colunas de largura fixa, rolagem horizontal, cartao
 * com avatar, origem e canal - sem trazer React, dnd-kit nem shadcn.
 *
 * A coluna e a etapa do pipeline do proprio agente. Arrastar um cartao chama
 * de volta quem montou o quadro, que usa a escrita ja existente do painel:
 * grava etapa + historico + auditoria numa transacao e NUNCA enfileira envio
 * externo. O quadro nao fala com a rede.
 */
(function (global) {
  "use strict";

  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* Cor por posicao da coluna, da paleta ja validada para fundo escuro.
   * A cor identifica a etapa; quem carrega o significado e o titulo. */
  const CORES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181",
                 "#008300", "#9085e9", "#e66767"];

  const inicial = (nome) => (String(nome || "?").trim()[0] || "?").toUpperCase();

  function cartao(item, podeEscrever) {
    const O = global.SACOrigens;
    const origem = O && item.origem ? O.chipOrigem(item.origem, { mini: true, canais: false }) : "";
    const canal = O && item.canal ? O.iconeCanal(item.canal, false) : "";
    return (
      '<article class="kb-card' + (podeEscrever ? " arrastavel" : "") + '"' +
      (podeEscrever ? ' draggable="true"' : "") +
      ' tabindex="0" data-cartao="' + esc(item.id) + '" data-etapa="' + esc(item.etapa || "") + '">' +
      '<header class="kb-card-topo">' +
      '<span class="kb-avatar">' + esc(inicial(item.nome)) + "</span>" +
      '<span class="kb-nome">' + esc(item.nome || "Contato sem nome") + "</span>" +
      (item.quando ? '<time class="kb-quando">' + esc(item.quando) + "</time>" : "") +
      "</header>" +
      (item.previa ? '<p class="kb-previa">' + esc(item.previa) + "</p>" : "") +
      '<footer class="kb-card-rodape">' +
      (canal ? '<span class="kb-canal">' + canal + "</span>" : "") +
      (origem || "") +
      (item.responsavel
        ? '<span class="kb-resp" title="Responsável">' + esc(inicial(item.responsavel)) + "</span>"
        : "") +
      "</footer></article>"
    );
  }

  function coluna(col, itens, podeEscrever, indice) {
    const cor = col.cor || CORES[indice % CORES.length];
    const corpo = itens.length
      ? itens.map((i) => cartao(i, podeEscrever)).join("")
      : '<p class="kb-vazia">Nenhum contato nesta etapa.</p>';
    return (
      '<section class="kb-coluna" data-coluna="' + esc(col.id) + '" style="--etapa:' + cor + '">' +
      '<header class="kb-coluna-topo">' +
      '<span class="kb-marca"></span>' +
      '<h3>' + esc(col.titulo) + "</h3>" +
      '<span class="kb-contagem">' + itens.length + "</span>" +
      "</header>" +
      '<div class="kb-pilha" data-solta="' + esc(col.id) + '">' + corpo + "</div>" +
      "</section>"
    );
  }

  /* alvo: elemento onde o quadro e desenhado.
   * dados: { colunas:[{id,titulo,cor?}], cartoes:[{id,etapa,nome,canal,origem,
   *          previa,quando,responsavel}], podeEscrever, aoMover(id, etapa) }
   */
  function montar(alvo, dados) {
    if (!alvo) return;
    const d = dados || {};
    const colunas = d.colunas || [];
    const cartoes = d.cartoes || [];
    const podeEscrever = !!d.podeEscrever && typeof d.aoMover === "function";

    if (!colunas.length) {
      alvo.innerHTML = '<div class="grafico-vazio">Este agente ainda não tem etapas de pipeline.</div>';
      return;
    }

    const porEtapa = new Map(colunas.map((c) => [c.id, []]));
    const semEtapa = [];
    for (const c of cartoes) {
      const lista = porEtapa.get(c.etapa);
      (lista || semEtapa).push(c);
    }

    alvo.innerHTML =
      '<div class="kb-quadro">' +
      colunas.map((c, i) => coluna(c, porEtapa.get(c.id) || [], podeEscrever, i)).join("") +
      (semEtapa.length
        ? coluna({ id: "__sem_etapa__", titulo: "Sem etapa", cor: "#6b7680" }, semEtapa, false, 0)
        : "") +
      "</div>" +
      (podeEscrever
        ? '<p class="kb-ajuda">Arraste um cartão para mudar a etapa. Toda mudança grava operador, data e valor anterior na auditoria — e não envia mensagem.</p>'
        : '<p class="kb-ajuda">Esta fonte não autoriza escrita nesta sessão; o quadro está em leitura.</p>');

    if (podeEscrever) ligarArraste(alvo, d.aoMover);
    if (typeof d.aoSelecionar === "function") {
      alvo.querySelectorAll("[data-cartao]").forEach((el) => {
        el.addEventListener("click", () => d.aoSelecionar(el.dataset.cartao));
        el.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); d.aoSelecionar(el.dataset.cartao); }
        });
      });
    }
  }

  function ligarArraste(raiz, aoMover) {
    let arrastando = null;

    raiz.querySelectorAll(".kb-card.arrastavel").forEach((card) => {
      card.addEventListener("dragstart", (ev) => {
        arrastando = card;
        card.classList.add("arrastando");
        ev.dataTransfer.effectAllowed = "move";
        // Firefox so inicia o arraste se houver dado no dataTransfer
        ev.dataTransfer.setData("text/plain", card.dataset.cartao);
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("arrastando");
        raiz.querySelectorAll(".kb-pilha").forEach((p) => p.classList.remove("sobre"));
        arrastando = null;
      });
    });

    raiz.querySelectorAll(".kb-pilha[data-solta]").forEach((pilha) => {
      if (pilha.dataset.solta === "__sem_etapa__") return;
      pilha.addEventListener("dragover", (ev) => {
        if (!arrastando) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        pilha.classList.add("sobre");
      });
      pilha.addEventListener("dragleave", () => pilha.classList.remove("sobre"));
      pilha.addEventListener("drop", (ev) => {
        ev.preventDefault();
        pilha.classList.remove("sobre");
        if (!arrastando) return;
        const cartaoId = arrastando.dataset.cartao;
        const destino = pilha.dataset.solta;
        if (arrastando.dataset.etapa === destino) return;   // nada mudou
        // Move na tela antes da resposta: quem arrastou precisa de retorno
        // imediato. Se a gravacao falhar, quem chamou redesenha e desfaz.
        pilha.appendChild(arrastando);
        arrastando.dataset.etapa = destino;
        aoMover(cartaoId, destino);
      });
    });
  }

  global.SACKanban = { montar: montar, CORES: CORES };
})(typeof window !== "undefined" ? window : globalThis);
