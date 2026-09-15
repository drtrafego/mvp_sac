/**
 * SAC Hermes - Módulo Oficial de Mensagens Aprovadas Meta, Variáveis & Réguas de Recuperação
 */
(function (global) {
  "use strict";

  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Dados padrão de demonstração e armazenamento em localStorage
  const STORAGE_KEY = "sac-hermes-recuperador-v2";

  const DEFAULT_META_TEMPLATES = [
    {
      id: "recuperacao_carrinho_urgente",
      name: "recuperacao_carrinho_urgente",
      category: "MARKETING",
      language: "pt_BR",
      status: "APPROVED",
      header: "Aviso de Compra Pendente",
      body: "Olá {{1}}, notamos que o seu pedido do {{2}} no valor de {{3}} está reservado por pouco tempo! Clique no botão abaixo para garantir sua vaga com desconto exclusivo: {{4}}",
      buttonText: "Concluir Pagamento Agora",
      variablesMap: { "1": "{primeiro_nome}", "2": "{produto}", "3": "{valor}", "4": "{link_checkout}" }
    },
    {
      id: "aviso_boleto_pix_expirando",
      name: "aviso_boleto_pix_expirando",
      category: "UTILITY",
      language: "pt_BR",
      status: "APPROVED",
      header: "Código de Pagamento Gerado",
      body: "Oi {{1}}! Identificamos a geração do seu pagamento para o {{2}}. O código Pix copia e cola é: {{3}}. Qualquer dúvida sobre a liberação, nossa equipe está de plantão!",
      buttonText: "Copiar Código Pix",
      variablesMap: { "1": "{primeiro_nome}", "2": "{produto}", "3": "{pix_codigo}" }
    },
    {
      id: "cartao_recusado_suporte",
      name: "cartao_recusado_suporte",
      category: "UTILITY",
      language: "pt_BR",
      status: "APPROVED",
      header: "Ops! Pagamento Não Concluído",
      body: "Olá {{1}}, sua tentativa de compra do {{2}} não foi aprovada pela operadora do cartão. Você pode tentar com outro cartão ou gerar via Pix com liberação imediata no link: {{3}}",
      buttonText: "Trocar Forma de Pagamento",
      variablesMap: { "1": "{primeiro_nome}", "2": "{produto}", "3": "{link_checkout}" }
    },
    {
      id: "boas_vindas_vip",
      name: "boas_vindas_vip",
      category: "MARKETING",
      language: "pt_BR",
      status: "APPROVED",
      header: "Acesso Liberado com Sucesso!",
      body: "Parabéns {{1}}! Seu acesso ao {{2}} já foi liberado. Acesse a plataforma pelo link: {{3}} e aproveite todo o conteúdo!",
      buttonText: "Acessar Plataforma",
      variablesMap: { "1": "{primeiro_nome}", "2": "{produto}", "3": "{link_checkout}" }
    }
  ];

  const SYSTEM_VARS = [
    { key: "{primeiro_nome}", label: "Primeiro Nome", sample: "Mariana" },
    { key: "{nome}", label: "Nome Completo", sample: "Mariana Souza" },
    { key: "{produto}", label: "Nome do Produto", sample: "Mentoria Tráfego Pro" },
    { key: "{valor}", label: "Valor (R$)", sample: "R$ 297,00" },
    { key: "{link_checkout}", label: "Link do Checkout", sample: "https://pay.hotmart.com/carrinho?ref=X9821" },
    { key: "{pix_codigo}", label: "Código Pix Copia e Cola", sample: "00020126580014br.gov.bcb.pix0136..." },
    { key: "{pix_validade}", label: "Validade do Pix", sample: "30 minutos" },
    { key: "{boleto_url}", label: "Link do Boleto PDF", sample: "https://static.hotmart.com/boleto-123.pdf" },
    { key: "{boleto_codigo}", label: "Linha Digitável", sample: "34191.79001 01043.510047..." }
  ];

  const DEFAULT_SEQUENCES = {
    hot_carrinho: {
      title: "Recuperação de Carrinho Abandonado",
      desc: "Mensagens automáticas enviadas para quem iniciou o checkout mas não concluiu o pagamento.",
      active: true,
      messages: [
        { id: 1, delayMinutes: 5, type: "text", content: "Olá {primeiro_nome}! Notei que você quase garantiu o {produto}. Ficou alguma dúvida sobre o conteúdo ou formas de pagamento?", active: true },
        { id: 2, delayMinutes: 30, type: "template", templateId: "recuperacao_carrinho_urgente", content: "Template Meta: recuperacao_carrinho_urgente", active: true },
        { id: 3, delayMinutes: 1440, type: "text", content: "Oi {primeiro_nome}, sua reserva para o {produto} está prestes a expirar. Posso te ajudar com um cupom especial de desconto?", active: true }
      ],
      leads: [
        { name: "Mariana Souza", phone: "+55 (11) 98***-1234", product: "Mentoria Tráfego Pro", value: "R$ 297,00", status: "recuperado", time: "Há 12 min" },
        { name: "Carlos Eduardo", phone: "+55 (21) 97***-5678", product: "Mentoria Tráfego Pro", value: "R$ 297,00", status: "andamento", time: "Há 45 min" },
        { name: "Beatriz Oliveira", phone: "+55 (31) 99***-4321", product: "Curso SAC Hermes", value: "R$ 197,00", status: "pendente", time: "Há 2h" }
      ]
    },
    hot_boleto: {
      title: "Recuperação de Boleto e Pix",
      desc: "Acompanhamento de pagamentos gerados e ainda não compensados, com envio de código e linha digitável.",
      active: true,
      messages: [
        { id: 1, delayMinutes: 10, type: "text", content: "Oi {primeiro_nome}! Seu pedido do {produto} foi registrado. Segue seu código Pix para liberação imediata:\n\n{pix_codigo}", active: true },
        { id: 2, delayMinutes: 120, type: "template", templateId: "aviso_boleto_pix_expirando", content: "Template Meta: aviso_boleto_pix_expirando", active: true },
        { id: 3, delayMinutes: 1440, type: "text", content: "Lembrete: Seu boleto do {produto} vence hoje! Você pode baixar a 2ª via aqui: {boleto_url}", active: true }
      ],
      leads: [
        { name: "Lucas Fernandes", phone: "+55 (41) 98***-7788", product: "Mentoria Tráfego Pro", value: "R$ 297,00", status: "andamento", time: "Há 20 min" },
        { name: "Patrícia Lima", phone: "+55 (19) 97***-1122", product: "Curso SAC Hermes", value: "R$ 197,00", status: "recuperado", time: "Há 3h" }
      ]
    },
    hot_recusado: {
      title: "Recuperação de Cartão Recusado",
      desc: "Disparos imediatos para recuperar transações recusadas pela operadora (máxima prioridade).",
      active: true,
      messages: [
        { id: 1, delayMinutes: 2, type: "text", content: "Olá {primeiro_nome}, vimos que seu pagamento do {produto} não foi aprovado pelo cartão. Para não perder o acesso, você pode pagar via Pix ou tentar outro cartão aqui: {link_checkout}", active: true },
        { id: 2, delayMinutes: 60, type: "template", templateId: "cartao_recusado_suporte", content: "Template Meta: cartao_recusado_suporte", active: true }
      ],
      leads: [
        { name: "Rodrigo Silva", phone: "+55 (11) 96***-9988", product: "Mentoria Tráfego Pro", value: "R$ 297,00", status: "recuperado", time: "Há 15 min" },
        { name: "Fernanda Costa", phone: "+55 (61) 98***-5544", product: "Mentoria Tráfego Pro", value: "R$ 297,00", status: "andamento", time: "Há 1h" }
      ]
    },
    hot_aprovada: {
      title: "Pós-Venda & Compra Aprovada",
      desc: "Mensagens de boas-vindas, entrega de acessos e ofertas de upsell automático após aprovação.",
      active: true,
      messages: [
        { id: 1, delayMinutes: 0, type: "template", templateId: "boas_vindas_vip", content: "Template Meta: boas_vindas_vip", active: true },
        { id: 2, delayMinutes: 2880, type: "text", content: "Olá {primeiro_nome}! Como está sendo sua experiência com o {produto}? Liberamos um bônus exclusivo para alunos VIP!", active: true }
      ],
      leads: [
        { name: "Juliana Mendes", phone: "+55 (81) 99***-3322", product: "Mentoria Tráfego Pro", value: "R$ 297,00", status: "concluido", time: "Há 10 min" },
        { name: "Gabriel Martins", phone: "+55 (11) 97***-6655", product: "Curso SAC Hermes", value: "R$ 197,00", status: "concluido", time: "Há 40 min" }
      ]
    }
  };

  function loadState() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch (e) { /* ignore */ }
    return {
      templates: DEFAULT_META_TEMPLATES,
      sequences: DEFAULT_SEQUENCES
    };
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* ignore */ }
  }

  let state = loadState();

  function formatDelayText(minutes) {
    if (!minutes || minutes === 0) return "Imediato (0 min)";
    if (minutes < 60) return `Após ${minutes} min`;
    if (minutes < 1440) return `Após ${Math.floor(minutes / 60)}h`;
    return `Após ${Math.floor(minutes / 1440)}d`;
  }

  function highlightVars(text) {
    let result = esc(text);
    SYSTEM_VARS.forEach(v => {
      const regex = new RegExp(v.key.replace(/\{|\}/g, "\\$&"), "g");
      result = result.replace(regex, `<mark class="var">${esc(v.key)}</mark>`);
    });
    return result;
  }

  function interpolatePreview(text, varMap = {}) {
    let result = text;
    // Substitui variáveis do sistema
    SYSTEM_VARS.forEach(v => {
      const regex = new RegExp(v.key.replace(/\{|\}/g, "\\$&"), "gi");
      result = result.replace(regex, v.sample);
    });
    // Substitui variáveis de template {{1}}, {{2}}
    Object.entries(varMap).forEach(([idx, sysVar]) => {
      const match = SYSTEM_VARS.find(v => v.key === sysVar);
      const sampleVal = match ? match.sample : sysVar;
      result = result.replace(new RegExp(`\\{\\{${idx}\\}\\}`, "g"), sampleVal);
    });
    return result;
  }

  function mostrarToast(msg) {
    const toast = document.createElement("div");
    toast.className = "rec-toast";
    toast.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#86efac" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> <span>${esc(msg)}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.3s ease";
      setTimeout(() => toast.remove(), 300);
    }, 2600);
  }

  /* --------------------------------------------------------------------------
     MODAL DE EDIÇÃO DE MENSAGEM NA RÉGUA
     -------------------------------------------------------------------------- */
  function criarModalMensagem() {
    let dialog = document.getElementById("rec-msg-dialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "rec-msg-dialog";
      dialog.className = "rec-dialog";
      dialog.innerHTML = `
        <form method="dialog" id="rec-msg-form">
          <div class="dialog-head">
            <div>
              <p class="eyebrow" id="rec-msg-eyebrow">Régua de Recuperação</p>
              <h2 id="rec-msg-title">Editar Mensagem da Sequência</h2>
            </div>
            <button type="button" class="icon-button" id="rec-msg-close" aria-label="Fechar">×</button>
          </div>

          <div class="rec-modal-grid">
            <div style="display:flex;flex-direction:column;gap:12px;">
              <div class="rec-field-group">
                <label>Tempo de Disparo (Delay)</label>
                <select id="rec-modal-delay" class="rec-select" style="width:100%;">
                  <option value="0">Imediato (0 min)</option>
                  <option value="2">Após 2 minutos</option>
                  <option value="5">Após 5 minutos</option>
                  <option value="10">Após 10 minutos</option>
                  <option value="15">Após 15 minutos</option>
                  <option value="30">Após 30 minutos</option>
                  <option value="60">Após 1 hora</option>
                  <option value="120">Após 2 horas</option>
                  <option value="1440">Após 24 horas (1 dia)</option>
                  <option value="2880">Após 48 horas (2 dias)</option>
                </select>
              </div>

              <div class="rec-field-group">
                <label>Tipo de Envio</label>
                <select id="rec-modal-type" class="rec-select" style="width:100%;">
                  <option value="text">Texto Livre com Variáveis</option>
                  <option value="template">Template Meta HSM (Janela > 24h)</option>
                </select>
              </div>

              <div class="rec-field-group" id="rec-modal-tpl-wrap" style="display:none;">
                <label>Modelo Oficial Meta</label>
                <select id="rec-modal-tpl-select" class="rec-select" style="width:100%;"></select>
              </div>

              <div class="rec-field-group">
                <label>Inserir Variável no Cursor:</label>
                <div class="rec-var-bar" style="padding:6px;gap:4px;">
                  ${SYSTEM_VARS.map(v => `
                    <button type="button" class="rec-var-chip btn-modal-insert" data-var="${esc(v.key)}">${esc(v.key)}</button>
                  `).join("")}
                </div>
              </div>

              <div class="rec-field-group">
                <label>Conteúdo da Mensagem</label>
                <textarea id="rec-modal-content" class="rec-textarea" style="min-height:120px;" placeholder="Digite a mensagem de recuperação..."></textarea>
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:10px;">
              <label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--muted);">Simulação WhatsApp ao Vivo</label>
              <div class="rec-wa-preview" style="padding:14px;">
                <div class="rec-wa-preview-head">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="#4ade80"><circle cx="12" cy="12" r="10"/></svg>
                  <strong style="font-size:10px;">Pré-visualização do Lead</strong>
                </div>
                <div class="rec-wa-bubble" style="max-width:100%;font-size:12.5px;">
                  <div id="rec-modal-live-header" style="font-weight:750;margin-bottom:6px;color:#fff;display:none;"></div>
                  <div id="rec-modal-live-body" class="wa-text-content"></div>
                  <div id="rec-modal-live-btn" style="display:none;" class="rec-wa-btn"></div>
                  <div class="rec-wa-time">Agora ✓✓</div>
                </div>
              </div>
              <p style="font-size:11px;color:var(--muted);line-height:1.4;margin:0;">
                As variáveis como <code>{primeiro_nome}</code> e <code>{produto}</code> são substituídas automaticamente com os dados reais de cada lead.
              </p>
            </div>
          </div>

          <div class="dialog-actions" style="margin-top:14px;">
            <button type="button" class="ghost" id="rec-msg-cancel">Cancelar</button>
            <button type="submit" class="primary" id="rec-msg-save">Salvar Mensagem</button>
          </div>
        </form>
      `;
      document.body.appendChild(dialog);

      const fechar = () => dialog.close();
      dialog.querySelector("#rec-msg-close")?.addEventListener("click", fechar);
      dialog.querySelector("#rec-msg-cancel")?.addEventListener("click", fechar);
    }
    return dialog;
  }

  function abrirModalMensagem(pageId, msgId, aoSalvar) {
    const dialog = criarModalMensagem();
    const seq = state.sequences[pageId];
    if (!dialog || !seq) return;

    const msg = seq.messages.find(m => m.id === msgId);
    if (!msg) return;

    dialog.querySelector("#rec-msg-eyebrow").textContent = `${seq.title} · Passo ${msg.id}`;
    dialog.querySelector("#rec-msg-title").textContent = `Editar Passo ${msg.id} da Régua`;

    const selectDelay = dialog.querySelector("#rec-modal-delay");
    const selectType = dialog.querySelector("#rec-modal-type");
    const wrapTpl = dialog.querySelector("#rec-modal-tpl-wrap");
    const selectTpl = dialog.querySelector("#rec-modal-tpl-select");
    const textarea = dialog.querySelector("#rec-modal-content");
    const liveHeader = dialog.querySelector("#rec-modal-live-header");
    const liveBody = dialog.querySelector("#rec-modal-live-body");
    const liveBtn = dialog.querySelector("#rec-modal-live-btn");

    if (selectDelay) selectDelay.value = String(msg.delayMinutes || "0");
    if (selectType) selectType.value = msg.type || "text";

    if (selectTpl) {
      selectTpl.innerHTML = state.templates.map(t =>
        `<option value="${esc(t.id)}" ${t.id === msg.templateId ? "selected" : ""}>${esc(t.name)} (${esc(t.category)})</option>`
      ).join("");
    }

    const atualizarVisibilidadeTipo = () => {
      const isTpl = selectType.value === "template";
      wrapTpl.style.display = isTpl ? "flex" : "none";
      if (isTpl) {
        const curTpl = state.templates.find(t => t.id === selectTpl.value);
        if (curTpl) {
          textarea.value = curTpl.body;
          if (curTpl.header) {
            liveHeader.style.display = "block";
            liveHeader.textContent = curTpl.header;
          } else {
            liveHeader.style.display = "none";
          }
          if (curTpl.buttonText) {
            liveBtn.style.display = "block";
            liveBtn.textContent = `🔗 ${curTpl.buttonText}`;
          } else {
            liveBtn.style.display = "none";
          }
        }
      } else {
        liveHeader.style.display = "none";
        liveBtn.style.display = "none";
      }
      atualizarLivePreview();
    };

    const atualizarLivePreview = () => {
      const val = textarea.value;
      if (selectType.value === "template") {
        const curTpl = state.templates.find(t => t.id === selectTpl.value);
        liveBody.textContent = interpolatePreview(val, curTpl ? curTpl.variablesMap : {});
      } else {
        liveBody.textContent = interpolatePreview(val);
      }
    };

    textarea.value = msg.type === "template"
      ? (state.templates.find(t => t.id === msg.templateId)?.body || msg.content)
      : msg.content;

    selectType.onchange = atualizarVisibilidadeTipo;
    selectTpl.onchange = () => {
      const curTpl = state.templates.find(t => t.id === selectTpl.value);
      if (curTpl) {
        textarea.value = curTpl.body;
      }
      atualizarVisibilidadeTipo();
    };
    textarea.oninput = atualizarLivePreview;

    dialog.querySelectorAll(".btn-modal-insert").forEach(chip => {
      chip.onclick = () => {
        const varText = chip.dataset.var;
        const start = textarea.selectionStart || textarea.value.length;
        const end = textarea.selectionEnd || textarea.value.length;
        const val = textarea.value;
        textarea.value = val.substring(0, start) + varText + val.substring(end);
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = start + varText.length;
        atualizarLivePreview();
      };
    });

    atualizarVisibilidadeTipo();

    const form = dialog.querySelector("#rec-msg-form");
    form.onsubmit = (ev) => {
      ev.preventDefault();
      msg.delayMinutes = parseInt(selectDelay.value, 10) || 0;
      msg.type = selectType.value;
      if (msg.type === "template") {
        msg.templateId = selectTpl.value;
        msg.content = `Template Meta: ${msg.templateId}`;
      } else {
        msg.templateId = null;
        msg.content = textarea.value.trim();
      }

      saveState(state);
      dialog.close();
      mostrarToast(`Passo ${msg.id} atualizado com sucesso!`);
      if (typeof aoSalvar === "function") aoSalvar();
    };

    dialog.showModal();
  }

  /* --------------------------------------------------------------------------
     MODAL DE TEMPLATE META
     -------------------------------------------------------------------------- */
  function criarModalTemplate() {
    let dialog = document.getElementById("rec-tpl-dialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "rec-tpl-dialog";
      dialog.className = "rec-dialog";
      dialog.innerHTML = `
        <form method="dialog" id="rec-tpl-form">
          <div class="dialog-head">
            <div>
              <p class="eyebrow" id="rec-tpl-eyebrow">Meta Cloud API (HSM)</p>
              <h2 id="rec-tpl-title">Editar Modelo Aprovado Meta</h2>
            </div>
            <button type="button" class="icon-button" id="rec-tpl-close" aria-label="Fechar">×</button>
          </div>

          <div class="rec-modal-grid">
            <div style="display:flex;flex-direction:column;gap:12px;">
              <div class="rec-field-group">
                <label>Identificador / Nome na Meta</label>
                <input type="text" id="rec-tpl-name" class="rec-input" required>
              </div>

              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div class="rec-field-group">
                  <label>Categoria</label>
                  <select id="rec-tpl-category" class="rec-select">
                    <option value="MARKETING">MARKETING</option>
                    <option value="UTILITY">UTILITY</option>
                    <option value="AUTHENTICATION">AUTHENTICATION</option>
                  </select>
                </div>
                <div class="rec-field-group">
                  <label>Idioma</label>
                  <input type="text" id="rec-tpl-lang" class="rec-input" value="pt_BR">
                </div>
              </div>

              <div class="rec-field-group">
                <label>Título do Cabeçalho (Opcional)</label>
                <input type="text" id="rec-tpl-header" class="rec-input" placeholder="Ex: Aviso de Compra Pendente">
              </div>

              <div class="rec-field-group">
                <label>Corpo do Modelo (use {{1}}, {{2}}...)</label>
                <textarea id="rec-tpl-body" class="rec-textarea" style="min-height:100px;" required></textarea>
              </div>

              <div class="rec-field-group">
                <label>Texto do Botão de Ação (Opcional)</label>
                <input type="text" id="rec-tpl-button" class="rec-input" placeholder="Ex: Concluir Pagamento Agora">
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:12px;">
              <label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--muted);">Mapeamento das Variáveis</label>
              <div id="rec-tpl-vars-container" class="rec-var-map"></div>

              <label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--muted);margin-top:6px;">Prévia no WhatsApp</label>
              <div class="rec-wa-preview" style="padding:14px;">
                <div class="rec-wa-bubble" style="max-width:100%;font-size:12.5px;">
                  <div id="rec-tpl-live-header" style="font-weight:750;margin-bottom:6px;color:#fff;"></div>
                  <div id="rec-tpl-live-body" class="wa-text-content"></div>
                  <div id="rec-tpl-live-btn" class="rec-wa-btn"></div>
                  <div class="rec-wa-time">14:32 ✓✓</div>
                </div>
              </div>
            </div>
          </div>

          <div class="dialog-actions" style="margin-top:14px;">
            <button type="button" class="ghost" id="rec-tpl-cancel">Cancelar</button>
            <button type="submit" class="primary" id="rec-tpl-save">Salvar Alterações</button>
          </div>
        </form>
      `;
      document.body.appendChild(dialog);

      const fechar = () => dialog.close();
      dialog.querySelector("#rec-tpl-close")?.addEventListener("click", fechar);
      dialog.querySelector("#rec-tpl-cancel")?.addEventListener("click", fechar);
    }
    return dialog;
  }

  function abrirModalTemplate(templateId, aoSalvar) {
    const dialog = criarModalTemplate();
    if (!dialog) return;

    const tpl = state.templates.find(t => t.id === templateId) || {
      id: "novo_modelo_" + Date.now(),
      name: "novo_modelo_recuperacao",
      category: "MARKETING",
      language: "pt_BR",
      status: "APPROVED",
      header: "",
      body: "Olá {{1}}, seu pedido do {{2}} está reservado!",
      buttonText: "Finalizar Compra",
      variablesMap: { "1": "{primeiro_nome}", "2": "{produto}" }
    };

    const isNew = !state.templates.some(t => t.id === templateId);

    dialog.querySelector("#rec-tpl-eyebrow").textContent = isNew ? "Novo Template HSM" : `Template: ${tpl.name}`;
    dialog.querySelector("#rec-tpl-title").textContent = isNew ? "Criar Novo Modelo Meta" : "Editar Modelo Aprovado Meta";

    const inputName = dialog.querySelector("#rec-tpl-name");
    const selectCat = dialog.querySelector("#rec-tpl-category");
    const inputLang = dialog.querySelector("#rec-tpl-lang");
    const inputHeader = dialog.querySelector("#rec-tpl-header");
    const textBody = dialog.querySelector("#rec-tpl-body");
    const inputBtn = dialog.querySelector("#rec-tpl-button");
    const varsContainer = dialog.querySelector("#rec-tpl-vars-container");
    const liveHeader = dialog.querySelector("#rec-tpl-live-header");
    const liveBody = dialog.querySelector("#rec-tpl-live-body");
    const liveBtn = dialog.querySelector("#rec-tpl-live-btn");

    inputName.value = tpl.name;
    inputName.readOnly = !isNew;
    selectCat.value = tpl.category;
    inputLang.value = tpl.language || "pt_BR";
    inputHeader.value = tpl.header || "";
    textBody.value = tpl.body;
    inputBtn.value = tpl.buttonText || "";

    const varMap = { ...(tpl.variablesMap || {}) };

    const atualizarLive = () => {
      liveHeader.textContent = inputHeader.value.trim();
      liveHeader.style.display = inputHeader.value.trim() ? "block" : "none";

      liveBtn.textContent = inputBtn.value.trim() ? `🔗 ${inputBtn.value.trim()}` : "";
      liveBtn.style.display = inputBtn.value.trim() ? "block" : "none";

      liveBody.textContent = interpolatePreview(textBody.value, varMap);
    };

    const renderizarMapeamentoVars = () => {
      const varIndices = (textBody.value.match(/\{\{(\d+)\}\}/g) || []).map(m => m.replace(/\D/g, ""));
      const uniqueIndices = [...new Set(varIndices)].sort((a,b) => Number(a)-Number(b));

      if (uniqueIndices.length === 0) {
        varsContainer.innerHTML = `<p style="margin:0;font-size:11px;color:var(--muted);">Nenhum parâmetro {{1}}, {{2}} detectado no texto.</p>`;
        atualizarLive();
        return;
      }

      varsContainer.innerHTML = uniqueIndices.map(idx => `
        <div class="rec-var-row">
          <span class="rec-var-tag">{{${idx}}}</span>
          <select class="rec-select modal-var-sel" data-var-idx="${idx}" style="width:100%;">
            ${SYSTEM_VARS.map(v => `
              <option value="${esc(v.key)}" ${varMap[idx] === v.key ? "selected" : ""}>
                ${esc(v.key)} (${esc(v.label)})
              </option>
            `).join("")}
          </select>
        </div>
      `).join("");

      varsContainer.querySelectorAll(".modal-var-sel").forEach(sel => {
        sel.onchange = (e) => {
          varMap[e.target.dataset.varIdx] = e.target.value;
          atualizarLive();
        };
      });

      atualizarLive();
    };

    textBody.oninput = renderizarMapeamentoVars;
    inputHeader.oninput = atualizarLive;
    inputBtn.oninput = atualizarLive;

    renderizarMapeamentoVars();

    const form = dialog.querySelector("#rec-tpl-form");
    form.onsubmit = (ev) => {
      ev.preventDefault();
      tpl.name = inputName.value.trim();
      tpl.category = selectCat.value;
      tpl.language = inputLang.value.trim();
      tpl.header = inputHeader.value.trim();
      tpl.body = textBody.value.trim();
      tpl.buttonText = inputBtn.value.trim();
      tpl.variablesMap = varMap;

      if (isNew) {
        tpl.id = tpl.name;
        state.templates.push(tpl);
      }

      saveState(state);
      dialog.close();
      mostrarToast(`Modelo Meta '${tpl.name}' salvo com sucesso!`);
      if (typeof aoSalvar === "function") aoSalvar();
    };

    dialog.showModal();
  }

  /* --------------------------------------------------------------------------
     MODAL DE LEAD
     -------------------------------------------------------------------------- */
  function criarModalLead() {
    let dialog = document.getElementById("rec-lead-dialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "rec-lead-dialog";
      dialog.className = "rec-dialog";
      dialog.innerHTML = `
        <form method="dialog" id="rec-lead-form">
          <div class="dialog-head">
            <div>
              <p class="eyebrow">Lead em Recuperação Ativa</p>
              <h2 id="rec-lead-nome">Nome do Lead</h2>
            </div>
            <button type="button" class="icon-button" id="rec-lead-close" aria-label="Fechar">×</button>
          </div>

          <div style="display:grid;gap:14px;margin-top:8px;">
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:10px;background:#0d1114;border:1px solid var(--line);border-radius:12px;padding:14px;">
              <div>
                <span style="font-size:10px;color:var(--muted);text-transform:uppercase;display:block;">Telefone / WhatsApp</span>
                <strong id="rec-lead-phone" style="font-size:13px;color:#fff;"></strong>
              </div>
              <div>
                <span style="font-size:10px;color:var(--muted);text-transform:uppercase;display:block;">Produto</span>
                <strong id="rec-lead-product" style="font-size:13px;color:#fff;"></strong>
              </div>
              <div>
                <span style="font-size:10px;color:var(--muted);text-transform:uppercase;display:block;">Valor da Transação</span>
                <strong id="rec-lead-value" style="font-size:14px;color:var(--accent);"></strong>
              </div>
              <div>
                <span style="font-size:10px;color:var(--muted);text-transform:uppercase;display:block;">Status Atual</span>
                <span id="rec-lead-status-wrap"></span>
              </div>
            </div>

            <div class="rec-field-group">
              <label>Ações Manuais do Operador</label>
              <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <button type="button" class="primary" id="btn-lead-send-manual" style="display:inline-flex;align-items:center;gap:6px;">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                  Disparar Mensagem Manual no WhatsApp
                </button>
                <button type="button" class="ghost" id="btn-lead-mark-recovered">Marcar como Recuperado</button>
              </div>
            </div>

            <div class="rec-field-group">
              <label>Histórico da Régua para este Contato</label>
              <div style="background:#090d10;border:1px solid var(--line);border-radius:10px;padding:12px;font-size:12.5px;color:#c9d1d9;line-height:1.5;">
                • Disparo automático do Passo 1 entregue com sucesso.<br>
                • Notificação de WhatsApp aberta pelo cliente.<br>
                • Checkout visitado novamente às 14:28.
              </div>
            </div>
          </div>

          <div class="dialog-actions" style="margin-top:14px;">
            <button type="button" class="ghost" id="rec-lead-cancel">Fechar</button>
          </div>
        </form>
      `;
      document.body.appendChild(dialog);

      const fechar = () => dialog.close();
      dialog.querySelector("#rec-lead-close")?.addEventListener("click", fechar);
      dialog.querySelector("#rec-lead-cancel")?.addEventListener("click", fechar);
    }
    return dialog;
  }

  function abrirModalLead(lead, seqKey, aoSalvar) {
    const dialog = criarModalLead();
    if (!dialog || !lead) return;

    dialog.querySelector("#rec-lead-nome").textContent = lead.name || "Contato";
    dialog.querySelector("#rec-lead-phone").textContent = lead.phone || "—";
    dialog.querySelector("#rec-lead-product").textContent = lead.product || "—";
    dialog.querySelector("#rec-lead-value").textContent = lead.value || "—";

    const stWrap = dialog.querySelector("#rec-lead-status-wrap");
    if (stWrap) {
      stWrap.innerHTML = `<span class="rec-st-badge rec-st-${esc(lead.status)}">${lead.status === "recuperado" ? "Recuperado" : lead.status === "andamento" ? "Em recuperação" : lead.status === "concluido" ? "Concluído" : "Pendente"}</span>`;
    }

    const btnSend = dialog.querySelector("#btn-lead-send-manual");
    if (btnSend) {
      btnSend.onclick = () => {
        btnSend.disabled = true;
        btnSend.textContent = "Enviando mensagem...";
        setTimeout(() => {
          btnSend.disabled = false;
          btnSend.textContent = "✓ Mensagem Enviada!";
          mostrarToast(`Mensagem enviada com sucesso para ${lead.name}!`);
          setTimeout(() => {
            btnSend.textContent = "Disparar Mensagem Manual no WhatsApp";
          }, 2500);
        }, 800);
      };
    }

    const btnMark = dialog.querySelector("#btn-lead-mark-recovered");
    if (btnMark) {
      btnMark.onclick = () => {
        lead.status = "recuperado";
        saveState(state);
        dialog.close();
        mostrarToast(`Lead '${lead.name}' marcado como recuperado!`);
        if (typeof aoSalvar === "function") aoSalvar();
      };
    }

    dialog.showModal();
  }

  /* --------------------------------------------------------------------------
     1. PÁGINA: MODELOS APROVADOS META (api_modelos)
     -------------------------------------------------------------------------- */
  function renderApiModelos(container) {
    const templates = state.templates;

    let html = `
      <div class="rec-container">
        <div class="rec-header">
          <div class="rec-header-info">
            <h2>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                <polyline points="22 4 12 14.01 9 11.01"></polyline>
              </svg>
              Modelos Aprovados Meta Cloud API (HSM)
            </h2>
            <p>Templates oficiais validados pelo WhatsApp/Meta para contato ativo com leads fora da janela de 24 horas.</p>
          </div>
          <div class="rec-header-actions">
            <button class="ghost" id="btn-novo-template" style="color:var(--accent);border-color:var(--accent);">
              + Novo Modelo Meta
            </button>
            <button class="primary" id="btn-sync-meta">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="display:inline;margin-right:6px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
              Sincronizar da Meta
            </button>
          </div>
        </div>

        <div class="rec-var-bar">
          <span class="rec-var-bar-title">Variáveis do Sistema Disponíveis:</span>
          ${SYSTEM_VARS.map(v => `<span class="rec-var-chip green" title="${esc(v.label)}: Exemplo ${esc(v.sample)}">${esc(v.key)}</span>`).join("")}
        </div>

        <div class="rec-template-grid">
          ${templates.map(tpl => {
            const previewBody = interpolatePreview(tpl.body, tpl.variablesMap);
            const varIndices = (tpl.body.match(/\{\{(\d+)\}\}/g) || []).map(m => m.replace(/\D/g, ""));
            const uniqueIndices = [...new Set(varIndices)].sort((a,b) => Number(a)-Number(b));

            return `
              <div class="rec-template-card" id="tpl-card-${esc(tpl.id)}">
                <div class="rec-template-head">
                  <div class="rec-template-title">
                    <strong>${esc(tpl.name)}</strong>
                    <small>Categoria: ${esc(tpl.category)} · Idioma: ${esc(tpl.language)}</small>
                  </div>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <span class="rec-status-approved">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>
                      Aprovado
                    </span>
                    <button class="rec-edit-chip btn-edit-tpl" data-tpl-id="${esc(tpl.id)}" title="Editar Template no Modal">
                      ✏️ Editar
                    </button>
                  </div>
                </div>

                <div class="rec-wa-preview">
                  <div class="rec-wa-preview-head">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="#4ade80"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.08-.3-.15-1.26-.46-2.39-1.48-.89-.79-1.48-1.76-1.66-2.06-.17-.3-.02-.46.13-.6.14-.14.3-.35.45-.52.15-.18.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.87 1.22 3.07.15.2 2.1 3.2 5.08 4.49.7.3 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2-1.41.25-.7.25-1.29.18-1.42-.08-.12-.28-.2-.57-.35M12.05 21.8h-.01a9.9 9.9 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.89 9.89-9.89a9.82 9.82 0 0 1 6.99 2.9 9.82 9.82 0 0 1 2.89 6.99c0 5.45-4.44 9.89-9.88 9.89"/></svg>
                    <strong>WhatsApp Pré-visualização Real</strong>
                  </div>
                  <div class="rec-wa-bubble" id="wa-bubble-${esc(tpl.id)}">
                    ${tpl.header ? `<div style="font-weight:750;margin-bottom:6px;color:#fff;">${esc(tpl.header)}</div>` : ""}
                    <div class="wa-text-content">${esc(previewBody)}</div>
                    ${tpl.buttonText ? `<a href="javascript:void(0)" class="rec-wa-btn">🔗 ${esc(tpl.buttonText)}</a>` : ""}
                    <div class="rec-wa-time">14:32 ✓✓</div>
                  </div>
                </div>

                ${uniqueIndices.length > 0 ? `
                  <div class="rec-var-map">
                    <div class="rec-var-map-title">Mapear Parâmetros da Meta:</div>
                    ${uniqueIndices.map(idx => `
                      <div class="rec-var-row">
                        <span class="rec-var-tag">{{${idx}}}</span>
                        <select class="rec-select" data-template-id="${esc(tpl.id)}" data-var-index="${idx}">
                          ${SYSTEM_VARS.map(v => `
                            <option value="${esc(v.key)}" ${tpl.variablesMap?.[idx] === v.key ? "selected" : ""}>
                              ${esc(v.key)} (${esc(v.label)})
                            </option>
                          `).join("")}
                        </select>
                      </div>
                    `).join("")}
                  </div>
                ` : ""}
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;

    container.innerHTML = html;

    container.querySelectorAll(".btn-edit-tpl").forEach(btn => {
      btn.addEventListener("click", () => {
        const tplId = btn.dataset.tplId;
        abrirModalTemplate(tplId, () => renderApiModelos(container));
      });
    });

    const btnNovo = container.querySelector("#btn-novo-template");
    if (btnNovo) {
      btnNovo.addEventListener("click", () => {
        abrirModalTemplate(null, () => renderApiModelos(container));
      });
    }

    container.querySelectorAll("select[data-template-id]").forEach(select => {
      select.addEventListener("change", (e) => {
        const tplId = e.target.dataset.templateId;
        const varIdx = e.target.dataset.varIndex;
        const val = e.target.value;

        const targetTpl = state.templates.find(t => t.id === tplId);
        if (targetTpl) {
          if (!targetTpl.variablesMap) targetTpl.variablesMap = {};
          targetTpl.variablesMap[varIdx] = val;
          saveState(state);

          const bubble = container.querySelector(`#wa-bubble-${tplId} .wa-text-content`);
          if (bubble) {
            bubble.textContent = interpolatePreview(targetTpl.body, targetTpl.variablesMap);
          }
        }
      });
    });

    const syncBtn = container.querySelector("#btn-sync-meta");
    if (syncBtn) {
      syncBtn.addEventListener("click", () => {
        syncBtn.disabled = true;
        syncBtn.innerHTML = "Sincronizando com Meta API...";
        setTimeout(() => {
          syncBtn.disabled = false;
          syncBtn.innerHTML = "✓ Sincronizado (4 Modelos Ativos)";
          mostrarToast("Modelos Meta Cloud API sincronizados com sucesso!");
          setTimeout(() => {
            syncBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="display:inline;margin-right:6px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg> Sincronizar da Meta`;
          }, 3000);
        }, 1200);
      });
    }
  }

  /* --------------------------------------------------------------------------
     2. PÁGINAS DE RÉGUAS DE RECUPERAÇÃO (hot_carrinho, hot_boleto, hot_recusado, hot_aprovada)
     -------------------------------------------------------------------------- */
  function renderSequencePage(pageId, container) {
    const seq = state.sequences[pageId];
    if (!seq) return;

    const domain = window.location.origin || "https://sac.casaldotrafego.com";
    const webhooks = [
      { name: "Hotmart", dot: "#F04E23", url: `${domain}/api/webhooks/hotmart/casaldotrafego` },
      { name: "Kiwify", dot: "#00E070", url: `${domain}/api/webhooks/kiwify/casaldotrafego` },
      { name: "Greenn", dot: "#00C9A7", url: `${domain}/api/webhooks/greenn/casaldotrafego` },
      { name: "Zouti", dot: "#845EC2", url: `${domain}/api/webhooks/zouti/casaldotrafego` }
    ];

    let html = `
      <div class="rec-container">
        <div class="rec-header">
          <div class="rec-header-info">
            <h2>
              <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${seq.active ? '#b8f35a' : '#ff8a7a'};"></span>
              ${esc(seq.title)}
            </h2>
            <p>${esc(seq.desc)}</p>
          </div>
          <div class="rec-header-actions">
            <label class="rec-toggle">
              <input type="checkbox" class="rec-toggle-input" id="seq-toggle-${pageId}" ${seq.active ? "checked" : ""}>
              <span>${seq.active ? "Automação Ativa" : "Automação Pausada"}</span>
            </label>
          </div>
        </div>

        <div class="rec-webhooks">
          <div class="rec-webhooks-head">
            <strong>URLs de Webhook para Configurar nas Plataformas</strong>
          </div>
          <div class="rec-webhook-grid">
            ${webhooks.map(wh => `
              <div class="rec-webhook-card">
                <div class="rec-webhook-label">
                  <span class="rec-webhook-dot" style="background:${wh.dot};"></span>
                  ${esc(wh.name)}
                </div>
                <code class="rec-webhook-url" title="${esc(wh.url)}">${esc(wh.url)}</code>
                <button class="rec-copy-btn" data-url="${esc(wh.url)}">Copiar</button>
              </div>
            `).join("")}
          </div>
        </div>

        <div class="rec-sequence-section">
          <div class="rec-section-head">
            <h3>Régua de Disparos (${seq.messages.length} mensagens configuradas)</h3>
            <button class="primary" id="btn-add-msg-${pageId}">+ Nova Mensagem na Régua</button>
          </div>

          <div class="rec-timeline" id="timeline-${pageId}">
            ${seq.messages.map(msg => `
              <div class="rec-step-node" id="msg-node-${msg.id}">
                <span class="rec-delay-badge">${formatDelayText(msg.delayMinutes)}</span>
                <div class="rec-msg-card rec-card-clickable" data-msg-id="${msg.id}">
                  <div class="rec-msg-header">
                    <div class="rec-msg-type">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                      Passo ${msg.id} · ${msg.type === "template" ? "Template Meta HSM" : "Texto Personalizado"}
                      ${msg.type === "template" ? `<span class="rec-badge-template">Oficial Meta</span>` : ""}
                    </div>
                    <div class="rec-msg-actions">
                      <button class="rec-edit-chip rec-btn-edit-msg" data-msg-id="${msg.id}">✏️ Editar</button>
                      <label class="rec-toggle" style="font-size:11px;">
                        <input type="checkbox" class="rec-toggle-input msg-toggle" data-msg-id="${msg.id}" ${msg.active ? "checked" : ""}>
                        <span>${msg.active ? "Ativo" : "Inativo"}</span>
                      </label>
                      <button class="ghost rec-del-msg" data-msg-id="${msg.id}" style="padding:4px 8px;font-size:11px;color:#ff8a7a;">Excluir</button>
                    </div>
                  </div>
                  <div class="rec-msg-content">${highlightVars(msg.content)}</div>
                </div>
              </div>
            `).join("")}
          </div>
        </div>

        <div class="rec-sequence-section" id="box-new-msg-${pageId}" style="display:none;background:#101418;border-color:#2a3642;">
          <div class="rec-section-head">
            <h3>Adicionar Nova Mensagem à Régua</h3>
            <button class="ghost" id="btn-cancel-new-${pageId}">Fechar</button>
          </div>

          <div style="display:grid;gap:14px;">
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:12px;">
              <div>
                <label style="font-size:11px;color:var(--muted);text-transform:uppercase;display:block;margin-bottom:5px;">Tipo de Mensagem</label>
                <select class="rec-select" id="new-msg-type-${pageId}" style="width:100%;">
                  <option value="text">Texto Livre com Variáveis</option>
                  <option value="template">Template Meta HSM (Contatos Frios / 24h+)</option>
                </select>
              </div>
              <div>
                <label style="font-size:11px;color:var(--muted);text-transform:uppercase;display:block;margin-bottom:5px;">Tempo de Disparo</label>
                <select class="rec-select" id="new-msg-delay-${pageId}" style="width:100%;">
                  <option value="0">Imediato (0 min)</option>
                  <option value="5">Após 5 minutos</option>
                  <option value="15">Após 15 minutos</option>
                  <option value="30">Após 30 minutos</option>
                  <option value="60">Após 1 hora</option>
                  <option value="120">Após 2 horas</option>
                  <option value="1440">Após 24 horas (1 dia)</option>
                  <option value="2880">Após 48 horas (2 dias)</option>
                </select>
              </div>
            </div>

            <div id="new-tpl-select-wrap-${pageId}" style="display:none;">
              <label style="font-size:11px;color:var(--muted);text-transform:uppercase;display:block;margin-bottom:5px;">Template Meta Aprovado</label>
              <select class="rec-select" id="new-msg-tpl-${pageId}" style="width:100%;">
                ${state.templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)} (${esc(t.category)})</option>`).join("")}
              </select>
            </div>

            <div>
              <div class="rec-var-bar" style="margin-bottom:8px;">
                <span class="rec-var-bar-title">Inserir Variável no Cursor:</span>
                ${SYSTEM_VARS.map(v => `<button type="button" class="rec-var-chip btn-insert-var" data-page-id="${pageId}" data-var="${esc(v.key)}">${esc(v.key)}</button>`).join("")}
              </div>
              <textarea id="new-msg-text-${pageId}" placeholder="Digite a mensagem de recuperação... Use os botões acima para inserir variáveis como {primeiro_nome}, {produto}, {valor}, {link_checkout}..." style="width:100%;height:100px;background:#090b0d;border:1px solid var(--line);border-radius:10px;color:#fff;padding:12px;font-family:inherit;font-size:13.5px;resize:vertical;"></textarea>
            </div>

            <div>
              <button class="primary" id="btn-save-new-${pageId}">Salvar Mensagem na Sequência</button>
            </div>
          </div>
        </div>

        <div class="rec-sequence-section">
          <div class="rec-section-head">
            <h3>Contatos e Leads Recentes em Recuperação</h3>
            <span style="font-size:12px;color:var(--muted);">Clique em qualquer linha para abrir o <strong>Modal de Ações</strong></span>
          </div>
          <div class="rec-table-wrap">
            <table class="rec-table">
              <thead>
                <tr>
                  <th>Contato</th>
                  <th>Telefone</th>
                  <th>Produto</th>
                  <th>Valor</th>
                  <th>Status</th>
                  <th>Tempo</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                ${(seq.leads || []).map((lead, idx) => `
                  <tr class="rec-card-clickable rec-lead-row" data-lead-idx="${idx}">
                    <td><strong>${esc(lead.name)}</strong></td>
                    <td><code>${esc(lead.phone)}</code></td>
                    <td>${esc(lead.product)}</td>
                    <td><strong>${esc(lead.value)}</strong></td>
                    <td>
                      <span class="rec-st-badge rec-st-${esc(lead.status)}">
                        ${lead.status === "recuperado" ? "Recuperado" : lead.status === "andamento" ? "Em recuperação" : lead.status === "concluido" ? "Concluído" : "Aguardando"}
                      </span>
                    </td>
                    <td><small style="color:var(--muted);">${esc(lead.time)}</small></td>
                    <td>
                      <button class="rec-edit-chip btn-open-lead" data-lead-idx="${idx}">Ver Detalhes</button>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    container.innerHTML = html;

    const toggleSeq = container.querySelector(`#seq-toggle-${pageId}`);
    if (toggleSeq) {
      toggleSeq.addEventListener("change", (e) => {
        seq.active = e.target.checked;
        saveState(state);
        mostrarToast(`Sequência ${seq.active ? "ativada" : "pausada"}!`);
        renderSequencePage(pageId, container);
      });
    }

    container.querySelectorAll(".rec-copy-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const url = btn.dataset.url;
        navigator.clipboard.writeText(url).then(() => {
          btn.classList.add("copied");
          btn.textContent = "Copiado!";
          mostrarToast("URL do Webhook copiada para a área de transferência!");
          setTimeout(() => {
            btn.classList.remove("copied");
            btn.textContent = "Copiar";
          }, 2000);
        });
      });
    });

    container.querySelectorAll(".rec-btn-edit-msg, .rec-msg-card").forEach(el => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".msg-toggle") || e.target.closest(".rec-del-msg")) return;
        const msgId = parseInt(el.dataset.msgId, 10);
        abrirModalMensagem(pageId, msgId, () => renderSequencePage(pageId, container));
      });
    });

    container.querySelectorAll(".rec-lead-row, .btn-open-lead").forEach(row => {
      row.addEventListener("click", (e) => {
        const idx = parseInt(row.dataset.leadIdx, 10);
        const lead = seq.leads[idx];
        if (lead) {
          abrirModalLead(lead, pageId, () => renderSequencePage(pageId, container));
        }
      });
    });

    const btnAddMsg = container.querySelector(`#btn-add-msg-${pageId}`);
    const boxNewMsg = container.querySelector(`#box-new-msg-${pageId}`);
    const btnCancelNew = container.querySelector(`#btn-cancel-new-${pageId}`);

    if (btnAddMsg && boxNewMsg) {
      btnAddMsg.addEventListener("click", () => {
        boxNewMsg.style.display = "flex";
        boxNewMsg.scrollIntoView({ behavior: "smooth" });
      });
    }
    if (btnCancelNew && boxNewMsg) {
      btnCancelNew.addEventListener("click", () => {
        boxNewMsg.style.display = "none";
      });
    }

    const textarea = container.querySelector(`#new-msg-text-${pageId}`);
    container.querySelectorAll(`.btn-insert-var[data-page-id="${pageId}"]`).forEach(chip => {
      chip.addEventListener("click", () => {
        const varText = chip.dataset.var;
        if (!textarea) return;
        const start = textarea.selectionStart || textarea.value.length;
        const end = textarea.selectionEnd || textarea.value.length;
        const val = textarea.value;
        textarea.value = val.substring(0, start) + varText + val.substring(end);
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = start + varText.length;
      });
    });

    const selectType = container.querySelector(`#new-msg-type-${pageId}`);
    const wrapTplSelect = container.querySelector(`#new-tpl-select-wrap-${pageId}`);
    if (selectType && wrapTplSelect) {
      selectType.addEventListener("change", (e) => {
        wrapTplSelect.style.display = e.target.value === "template" ? "block" : "none";
      });
    }

    const btnSaveNew = container.querySelector(`#btn-save-new-${pageId}`);
    if (btnSaveNew) {
      btnSaveNew.addEventListener("click", () => {
        const type = selectType ? selectType.value : "text";
        const delay = parseInt(container.querySelector(`#new-msg-delay-${pageId}`)?.value || "0", 10);
        let content = textarea ? textarea.value.trim() : "";
        let templateId = null;

        if (type === "template") {
          templateId = container.querySelector(`#new-msg-tpl-${pageId}`)?.value || "recuperacao_carrinho_urgente";
          content = `Template Meta: ${templateId}`;
        }

        if (!content) {
          alert("Por favor, digite o conteúdo da mensagem.");
          return;
        }

        const newId = seq.messages.length + 1;
        seq.messages.push({
          id: newId,
          delayMinutes: delay,
          type: type,
          templateId: templateId,
          content: content,
          active: true
        });

        saveState(state);
        mostrarToast("Nova mensagem adicionada à régua!");
        renderSequencePage(pageId, container);
      });
    }

    container.querySelectorAll(".rec-del-msg").forEach(btn => {
      btn.addEventListener("click", () => {
        const msgId = parseInt(btn.dataset.msgId, 10);
        if (confirm("Deseja realmente remover esta mensagem da sequência?")) {
          seq.messages = seq.messages.filter(m => m.id !== msgId);
          saveState(state);
          mostrarToast("Mensagem removida da sequência.");
          renderSequencePage(pageId, container);
        }
      });
    });

    container.querySelectorAll(".msg-toggle").forEach(toggle => {
      toggle.addEventListener("change", (e) => {
        const msgId = parseInt(e.target.dataset.msgId, 10);
        const msg = seq.messages.find(m => m.id === msgId);
        if (msg) {
          msg.active = e.target.checked;
          saveState(state);
          mostrarToast(`Passo ${msgId} ${msg.active ? "ativado" : "pausado"}`);
        }
      });
    });
  }

  /* --------------------------------------------------------------------------
     3. PÁGINAS DE CAMPANHAS & FOLLOW-UP (api_campanhas, api_followup)
     -------------------------------------------------------------------------- */
  function renderCampanhasFollowup(pageId, container) {
    const isCampanha = pageId === "api_campanhas";
    const title = isCampanha ? "Campanhas de Disparos Ativas" : "Sequências de Follow-up";
    const desc = isCampanha
      ? "Gerenciamento e métricas de campanhas ativas enviadas via WhatsApp Meta Cloud API."
      : "Régua de acompanhamento e reengajamento automático para contatos do SAC.";

    let html = `
      <div class="rec-container">
        <div class="rec-header">
          <div class="rec-header-info">
            <h2>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
              ${esc(title)}
            </h2>
            <p>${esc(desc)}</p>
          </div>
          <div class="rec-header-actions">
            <button class="primary" id="btn-action-${pageId}">${isCampanha ? "+ Novo Disparo em Massa" : "+ Nova Régua de Follow-up"}</button>
          </div>
        </div>

        <div class="rec-sequence-section">
          <div class="rec-section-head">
            <h3>${isCampanha ? "Disparos Recentes" : "Fluxos de Reengajamento"}</h3>
          </div>
          <div class="rec-table-wrap">
            <table class="rec-table">
              <thead>
                <tr>
                  <th>Nome do Fluxo</th>
                  <th>Canal</th>
                  <th>Enviados</th>
                  <th>Entregues</th>
                  <th>Lidos</th>
                  <th>Respostas</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>Reengajamento Leads Frios 7D</strong></td>
                  <td>WhatsApp Meta</td>
                  <td>142</td>
                  <td>140 (98.5%)</td>
                  <td>118 (83.1%)</td>
                  <td><strong>34 (24.3%)</strong></td>
                  <td><span class="rec-st-badge rec-st-recuperado">Ativo</span></td>
                </tr>
                <tr>
                  <td><strong>Oferta Relâmpago Ex-Alunos</strong></td>
                  <td>WhatsApp Meta</td>
                  <td>310</td>
                  <td>308 (99.3%)</td>
                  <td>275 (88.7%)</td>
                  <td><strong>68 (21.9%)</strong></td>
                  <td><span class="rec-st-badge rec-st-concluido">Concluído</span></td>
                </tr>
                <tr>
                  <td><strong>Follow-up Proposta Imobiliária</strong></td>
                  <td>WhatsApp + Email</td>
                  <td>58</td>
                  <td>58 (100%)</td>
                  <td>49 (84.4%)</td>
                  <td><strong>19 (32.7%)</strong></td>
                  <td><span class="rec-st-badge rec-st-recuperado">Ativo</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    container.innerHTML = html;
  }

  /* --------------------------------------------------------------------------
     ROTEADOR DE PÁGINAS DO PAINEL SAC
     -------------------------------------------------------------------------- */
  function desenhar(id) {
    if (!id) return;
    const alvo = document.getElementById(id + "-corpo");
    if (!alvo) return;

    if (id === "api_modelos") {
      renderApiModelos(alvo);
    } else if (["hot_carrinho", "hot_boleto", "hot_recusado", "hot_aprovada"].includes(id)) {
      renderSequencePage(id, alvo);
    } else if (["api_campanhas", "api_followup"].includes(id)) {
      renderCampanhasFollowup(id, alvo);
    }
  }

  global.addEventListener("sac:pagina", (ev) => desenhar(ev.detail && ev.detail.pagina));
  global.addEventListener("DOMContentLoaded", () => {
    if (global.SACNavegacao) desenhar(global.SACNavegacao.pagina());
  });

  global.SACPendentes = {
    desenhar: desenhar,
    abrirModalMensagem: abrirModalMensagem,
    abrirModalTemplate: abrirModalTemplate,
    abrirModalLead: abrirModalLead,
    mostrarToast: mostrarToast
  };
})(typeof window !== "undefined" ? window : globalThis);

