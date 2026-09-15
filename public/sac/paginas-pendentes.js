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
                  <span class="rec-status-approved">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>
                    Aprovado
                  </span>
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

    // Eventos de alteração dos selects de variáveis
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

          // Atualiza o balão do WhatsApp ao vivo
          const bubble = container.querySelector(`#wa-bubble-${tplId} .wa-text-content`);
          if (bubble) {
            bubble.textContent = interpolatePreview(targetTpl.body, targetTpl.variablesMap);
          }
        }
      });
    });

    // Botão de sincronização com feedback visual
    const syncBtn = container.querySelector("#btn-sync-meta");
    if (syncBtn) {
      syncBtn.addEventListener("click", () => {
        syncBtn.disabled = true;
        syncBtn.innerHTML = "Sincronizando com Meta API...";
        setTimeout(() => {
          syncBtn.disabled = false;
          syncBtn.innerHTML = "✓ Sincronizado (4 Modelos Ativos)";
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
        <!-- Header -->
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

        <!-- Webhooks -->
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

        <!-- Régua de Mensagens -->
        <div class="rec-sequence-section">
          <div class="rec-section-head">
            <h3>Régua de Disparos (${seq.messages.length} mensagens configuradas)</h3>
            <button class="primary" id="btn-add-msg-${pageId}">+ Nova Mensagem na Régua</button>
          </div>

          <div class="rec-timeline" id="timeline-${pageId}">
            ${seq.messages.map(msg => `
              <div class="rec-step-node" id="msg-node-${msg.id}">
                <span class="rec-delay-badge">${formatDelayText(msg.delayMinutes)}</span>
                <div class="rec-msg-card">
                  <div class="rec-msg-header">
                    <div class="rec-msg-type">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                      Passo ${msg.id} · ${msg.type === "template" ? "Template Meta HSM" : "Texto Personalizado"}
                      ${msg.type === "template" ? `<span class="rec-badge-template">Oficial Meta</span>` : ""}
                    </div>
                    <div class="rec-msg-actions">
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

        <!-- Formulário de Criação Rápida de Mensagem -->
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

            <!-- Seleção de Template Meta se escolhido -->
            <div id="new-tpl-select-wrap-${pageId}" style="display:none;">
              <label style="font-size:11px;color:var(--muted);text-transform:uppercase;display:block;margin-bottom:5px;">Template Meta Aprovado</label>
              <select class="rec-select" id="new-msg-tpl-${pageId}" style="width:100%;">
                ${state.templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)} (${esc(t.category)})</option>`).join("")}
              </select>
            </div>

            <!-- Barra de Inserção de Variáveis -->
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

        <!-- Leads Recentes em Recuperação -->
        <div class="rec-sequence-section">
          <div class="rec-section-head">
            <h3>Contatos e Leads Recentes em Recuperação</h3>
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
                </tr>
              </thead>
              <tbody>
                ${(seq.leads || []).map(lead => `
                  <tr>
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
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    container.innerHTML = html;

    // Toggle geral da sequência
    const toggleSeq = container.querySelector(`#seq-toggle-${pageId}`);
    if (toggleSeq) {
      toggleSeq.addEventListener("change", (e) => {
        seq.active = e.target.checked;
        saveState(state);
        renderSequencePage(pageId, container);
      });
    }

    // Copiar webhooks
    container.querySelectorAll(".rec-copy-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const url = btn.dataset.url;
        navigator.clipboard.writeText(url).then(() => {
          btn.classList.add("copied");
          btn.textContent = "Copiado!";
          setTimeout(() => {
            btn.classList.remove("copied");
            btn.textContent = "Copiar";
          }, 2000);
        });
      });
    });

    // Abrir/Fechar painel de nova mensagem
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

    // Inserção de variáveis no textarea
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

    // Mudança de tipo de mensagem
    const selectType = container.querySelector(`#new-msg-type-${pageId}`);
    const wrapTplSelect = container.querySelector(`#new-tpl-select-wrap-${pageId}`);
    if (selectType && wrapTplSelect) {
      selectType.addEventListener("change", (e) => {
        wrapTplSelect.style.display = e.target.value === "template" ? "block" : "none";
      });
    }

    // Salvar nova mensagem
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
        renderSequencePage(pageId, container);
      });
    }

    // Excluir mensagem
    container.querySelectorAll(".rec-del-msg").forEach(btn => {
      btn.addEventListener("click", () => {
        const msgId = parseInt(btn.dataset.msgId, 10);
        if (confirm("Deseja realmente remover esta mensagem da sequência?")) {
          seq.messages = seq.messages.filter(m => m.id !== msgId);
          saveState(state);
          renderSequencePage(pageId, container);
        }
      });
    });

    // Toggle de mensagem individual
    container.querySelectorAll(".msg-toggle").forEach(toggle => {
      toggle.addEventListener("change", (e) => {
        const msgId = parseInt(e.target.dataset.msgId, 10);
        const msg = seq.messages.find(m => m.id === msgId);
        if (msg) {
          msg.active = e.target.checked;
          saveState(state);
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

  global.SACPendentes = { desenhar: desenhar };
})(typeof window !== "undefined" ? window : globalThis);
