/* Quadro kanban do pipeline do SAC com Modal de Edição de Cards.
 *
 * Cada cartão ao ser clicado abre o modal interativo para edição de etapa,
 * responsável, anotações internas e visualização do histórico.
 */
(function (global) {
  "use strict";

  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const CORES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181",
                 "#008300", "#9085e9", "#e66767"];

  const inicial = (nome) => (String(nome || "?").trim()[0] || "?").toUpperCase();

  const CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true"><rect x="3.4" y="5.2" width="17.2" height="15.4" rx="2.4"/>' +
    '<path d="M3.4 9.8h17.2M8.4 3v4.4M15.6 3v4.4"/></svg>';

  const dataCurta = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleDateString("pt-BR", { day: "numeric", month: "short" });
  };

  function cartao(item, podeEscrever) {
    const O = global.SACOrigens;
    const origem = O && item.origem ? O.chipOrigem(item.origem, { mini: true, canais: false }) : "";
    const canal = O && item.canal ? O.iconeCanal(item.canal, false) : "";
    const rotuloCanal = O && item.canal ? O.resolverCanal(item.canal).label : "";
    const atribuido = !!item.responsavel;
    return (
      '<article class="kb-card' + (podeEscrever ? " arrastavel" : "") + '"' +
      (podeEscrever ? ' draggable="true"' : "") +
      ' tabindex="0" data-cartao="' + esc(item.id) + '" data-etapa="' + esc(item.etapa || "") + '">' +

      '<div class="kb-topo">' + (origem || '<span class="kb-sem-origem">Sem origem</span>') +
      (canal ? '<span class="kb-canal" title="' + esc(rotuloCanal) + '">' + canal + "</span>" : "") +
      "</div>" +

      '<div class="kb-corpo">' +
      '<h4 class="kb-nome">' + esc(item.nome || "Contato sem nome") + "</h4>" +
      '<p class="kb-sub">' + esc(rotuloCanal || "—") +
      (item.etapaRotulo ? '<span class="kb-sep">·</span>' + esc(item.etapaRotulo) : "") + "</p>" +
      '<p class="kb-previa">' + esc(item.previa || "Sem mensagem registrada…") + "</p>" +
      "</div>" +

      '<div class="kb-rodape">' +
      '<span class="kb-quem">' +
      '<span class="kb-avatar' + (atribuido ? " atribuido" : "") + '">' + esc(inicial(item.nome)) +
      '<i class="kb-ponto"></i></span>' +
      '<span class="kb-etiqueta">' + esc(atribuido ? item.responsavel : "sem responsável") + "</span>" +
      "</span>" +
      '<span class="kb-data">' + CAL + "<span>" + esc(item.quando || dataCurta(item.criadoEm)) + "</span></span>" +
      "</div></article>"
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

  /* Modal de Edição do Card */
  function criarModalCard() {
    let dialog = document.getElementById("kb-card-dialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "kb-card-dialog";
      dialog.className = "kb-dialog";
      dialog.innerHTML = `
        <form method="dialog" id="kb-card-form">
          <div class="dialog-head">
            <div>
              <p class="eyebrow" id="kb-modal-eyebrow">Detalhes do Lead</p>
              <h2 id="kb-modal-nome">Editar Contato</h2>
            </div>
            <button type="button" class="icon-button" id="kb-modal-close" aria-label="Fechar">×</button>
          </div>

          <div style="display:grid;gap:12px;margin-top:10px;">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <label>
                Etapa do Pipeline
                <select id="kb-modal-etapa" class="rec-select"></select>
              </label>
              <label>
                Agente / Bot Responsável
                <select id="kb-modal-responsavel" class="rec-select">
                  <option value="">Sem responsável (Fila Geral)</option>
                  <option value="AutonomIA">AutonomIA (Bot)</option>
                  <option value="Bella">Bella (Bot)</option>
                  <option value="Casal do Tráfego">Casal do Tráfego (Bot)</option>
                  <option value="Gastão Matos">Gastão Matos (Bot)</option>
                  <option value="Operador Humano">Operador Humano</option>
                </select>
              </label>
            </div>

            <label>
              Última Mensagem / Histórico
              <div id="kb-modal-previa" style="background:#090d10;border:1px solid var(--line);border-radius:10px;padding:12px;font-size:13px;color:#d0d7de;min-height:50px;"></div>
            </label>

            <label>
              Nota Interna da Operação
              <textarea id="kb-modal-nota" placeholder="Adicione observações sobre o atendimento, proposta enviada, objeções..." style="min-height:75px;"></textarea>
            </label>
          </div>

          <div class="dialog-actions" style="margin-top:16px;">
            <button type="button" class="ghost" id="kb-modal-cancel">Cancelar</button>
            <button type="submit" class="primary" id="kb-modal-save">Salvar Alterações</button>
          </div>
        </form>
      `;
      document.body.appendChild(dialog);

      const fechar = () => dialog.close();
      dialog.querySelector("#kb-modal-close")?.addEventListener("click", fechar);
      dialog.querySelector("#kb-modal-cancel")?.addEventListener("click", fechar);
    }
    return dialog;
  }

  function abrirModalCard(cartaoItem, colunas, aoMover, aoSalvarNota) {
    const dialog = criarModalCard();
    if (!dialog || !cartaoItem) return;

    dialog.querySelector("#kb-modal-eyebrow").textContent = `ID: ${cartaoItem.id} · Canal: ${cartaoItem.canal || "WhatsApp"}`;
    dialog.querySelector("#kb-modal-nome").textContent = cartaoItem.nome || "Contato sem nome";
    dialog.querySelector("#kb-modal-previa").textContent = cartaoItem.previa || "Sem mensagens anteriores registradas.";

    const selectEtapa = dialog.querySelector("#kb-modal-etapa");
    if (selectEtapa) {
      selectEtapa.innerHTML = colunas.map(c =>
        `<option value="${esc(c.id)}" ${c.id === cartaoItem.etapa ? "selected" : ""}>${esc(c.titulo)}</option>`
      ).join("");
    }

    const selectResp = dialog.querySelector("#kb-modal-responsavel");
    if (selectResp) {
      selectResp.value = cartaoItem.responsavel || "";
    }

    const textareaNota = dialog.querySelector("#kb-modal-nota");
    if (textareaNota) textareaNota.value = "";

    const form = dialog.querySelector("#kb-card-form");
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const novaEtapa = selectEtapa.value;
      const novoResp = selectResp.value;
      const nota = textareaNota.value.trim();

      cartaoItem.responsavel = novoResp || null;
      if (novaEtapa !== cartaoItem.etapa) {
        cartaoItem.etapa = novaEtapa;
        if (typeof aoMover === "function") aoMover(cartaoItem.id, novaEtapa);
      }
      if (nota && typeof aoSalvarNota === "function") {
        aoSalvarNota(cartaoItem.id, nota);
      }

      dialog.close();
      // Notifica o painel para atualizar a renderização do card
      window.dispatchEvent(new CustomEvent("sac:render"));
    };

    dialog.showModal();
  }

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
      '<p class="kb-ajuda">Clique em qualquer cartão para abrir o <strong>Modal de Edição</strong> ou arraste entre as etapas.</p>';

    if (podeEscrever) ligarArraste(alvo, d.aoMover);

    // Binds de clique nos cartões para abrir Modal de Edição
    alvo.querySelectorAll("[data-cartao]").forEach((el) => {
      const cId = el.dataset.cartao;
      const cartaoItem = cartoes.find(item => String(item.id) === String(cId));
      el.addEventListener("click", () => {
        abrirModalCard(cartaoItem, colunas, d.aoMover, d.aoSalvarNota);
        if (typeof d.aoSelecionar === "function") d.aoSelecionar(cId);
      });
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          abrirModalCard(cartaoItem, colunas, d.aoMover, d.aoSalvarNota);
          if (typeof d.aoSelecionar === "function") d.aoSelecionar(cId);
        }
      });
    });
  }

  function ligarArraste(raiz, aoMover) {
    let arrastando = null;

    raiz.querySelectorAll(".kb-card.arrastavel").forEach((card) => {
      card.addEventListener("dragstart", (ev) => {
        arrastando = card;
        card.classList.add("arrastando");
        ev.dataTransfer.effectAllowed = "move";
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
        if (arrastando.dataset.etapa === destino) return;
        pilha.appendChild(arrastando);
        arrastando.dataset.etapa = destino;
        aoMover(cartaoId, destino);
      });
    });
  }

  global.SACKanban = { montar: montar, CORES: CORES, abrirModalCard: abrirModalCard };
})(typeof window !== "undefined" ? window : globalThis);
