/* Página de Configuração: contas de canal e estado das credenciais.
 *
 * O painel NUNCA lê um segredo. A API devolve apenas a referência de cofre e
 * um estado (presente/ausente/inválido); o valor só trafega no sentido da
 * gravação. A tela reflete isso: o campo de segredo é sempre vazio ao abrir,
 * nunca é preenchido com o que já existe, e não há como revelar nada.
 *
 * O `public_endpoint_id` é gerado no servidor e nunca enviado pelo cliente:
 * é ele que resolve o agente no webhook, então aceitar do navegador seria
 * entregar a resolução de tenant para quem chama.
 */
(function (global) {
  "use strict";

  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const CANAIS = [
    { id: "whatsapp", rotulo: "WhatsApp", provedores: ["meta"] },
    { id: "instagram", rotulo: "Instagram", provedores: ["meta"] },
    { id: "email", rotulo: "E-mail", provedores: ["brevo", "smtp"] }
  ];

  /* Nome legível de cada referência de segredo, por provedor. As chaves batem
   * com as colunas *_secret_ref de public.sac_channel_accounts. */
  /* Chaves conforme o contrato do backend: `secrets` traz só os campos do
   * provedor daquela conta, em camelCase. */
  const SEGREDOS = {
    signature: { rotulo: "Segredo de assinatura", ajuda: "valida a assinatura do webhook recebido" },
    verify: { rotulo: "Token de verificação", ajuda: "só para o desafio GET de cadastro na Meta" },
    accessToken: { rotulo: "Token de acesso", ajuda: "envio pela Graph API" },
    apiKey: { rotulo: "Chave da API", ajuda: "envio pela Brevo" },
    smtpUsername: { rotulo: "Usuário SMTP", ajuda: "" },
    smtpPassword: { rotulo: "Senha SMTP", ajuda: "" },
    imapUsername: { rotulo: "Usuário IMAP", ajuda: "entrada por caixa de e-mail" },
    imapPassword: { rotulo: "Senha IMAP", ajuda: "" }
  };

  const OBRIGATORIOS = {
    meta: ["accessToken", "signature"],
    brevo: ["apiKey"],
    smtp: ["smtpPassword"]
  };

  /* ------------------------------------------------------------ adaptador */
  /* Único ponto que conhece o formato da API. Se o contrato mudar, muda aqui. */
  function paraTela(payload) {
    const contas = (payload && payload.accounts) || [];
    const base = (payload && payload.webhookBaseUrl) || "";
    return contas.map((c) => ({
      id: c.id,
      canal: c.channel || c.canal,
      provedor: c.provider || c.provedor,
      contaExterna: c.externalAccountId || c.external_account_id || "",
      nome: c.displayName || c.display_name || "",
      status: c.status || "disabled",
      endpoint: c.publicEndpointId || c.public_endpoint_id || null,
      urlWebhook: c.webhookUrl || (base && c.webhookPath ? base + c.webhookPath : c.webhookPath) || null,
      cabecalho: c.signatureHeader || c.signature_header || "",
      segredos: c.secrets || c.segredos || {}
    }));
  }

  /* --------------------------------------------------------------- estado */

  const estadoSegredo = (s) => {
    const e = (s && (s.state || s.estado)) || "ausente";
    return e === "present" ? "presente" : e === "invalid" ? "invalido" : e === "missing" ? "ausente" : e;
  };

  const SELO = {
    presente: { classe: "bom", texto: "Definido" },
    ausente: { classe: "critico", texto: "Falta" },
    invalido: { classe: "atencao", texto: "Inválido" }
  };

  /* O backend tem um endpoint proprio de pendencia (`/channel-checklist`) que
   * sabe coisas que a tela nao sabe - por exemplo, que uma referencia
   * preenchida SEM arquivo no cofre derruba o agente inteiro. Quando ele
   * responde, mandamos nele; esta funcao fica como reserva. */
  function pendenciasDoBackend(checklist) {
    const nome = { whatsapp: "WhatsApp", instagram: "Instagram", email: "E-mail" };
    const lista = [];
    for (const canal of (checklist.channelsWithoutAccount || []))
      lista.push({ canal: nome[canal] || canal, texto: "nenhuma conta cadastrada", bloqueia: true });
    for (const conta of (checklist.accounts || []))
      for (const p of (conta.pendencias || []))
        lista.push({ canal: nome[conta.channel] || conta.channel,
                     texto: p.message || p.code, bloqueia: p.blocks !== false });
    return lista;
  }

  function pendencias(contas) {
    const lista = [];
    for (const canal of CANAIS) {
      const conta = contas.find((c) => c.canal === canal.id);
      if (!conta) { lista.push({ canal: canal.rotulo, texto: "nenhuma conta cadastrada" }); continue; }
      if (!conta.contaExterna) lista.push({ canal: canal.rotulo, texto: "identificador da conta em branco" });
      const exigidos = OBRIGATORIOS[conta.provedor] || [];
      for (const chave of exigidos) {
        if (estadoSegredo(conta.segredos[chave]) !== "presente")
          lista.push({ canal: canal.rotulo, texto: (SEGREDOS[chave] || {}).rotulo + " ausente no cofre" });
      }
      if (conta.provedor === "meta" && !conta.endpoint)
        lista.push({ canal: canal.rotulo, texto: "endpoint público de webhook não gerado" });
      if (conta.status !== "active")
        lista.push({ canal: canal.rotulo, texto: "conta ainda não está ativa" });
    }
    return lista;
  }

  /* -------------------------------------------------------------- desenho */

  function cartaoConta(canal, conta) {
    if (!conta) {
      return (
        '<article class="cfg-card cfg-vazia"><header><h3>' + esc(canal.rotulo) + "</h3>" +
        '<span class="selo-estado critico">sem conta</span></header>' +
        '<p class="cfg-nota">Nenhuma conta de ' + esc(canal.rotulo) +
        " cadastrada para este cliente.</p>" +
        '<button class="ghost cfg-acao" data-nova="' + esc(canal.id) + '">Cadastrar conta</button></article>'
      );
    }
    const exigidos = OBRIGATORIOS[conta.provedor] || [];
    const chaves = Object.keys(SEGREDOS).filter((k) => k in conta.segredos || exigidos.includes(k));
    const linhas = chaves.map((k) => {
      const s = conta.segredos[k] || {};
      const est = estadoSegredo(s);
      const selo = SELO[est] || SELO.ausente;
      const ref = s.ref || s.secretRef || "";
      return (
        '<li class="cfg-segredo">' +
        '<span class="cfg-seg-nome">' + esc(SEGREDOS[k].rotulo) +
        (exigidos.includes(k) ? '<i class="cfg-obrig" title="obrigatório para ativar">*</i>' : "") +
        (SEGREDOS[k].ajuda ? "<small>" + esc(SEGREDOS[k].ajuda) + "</small>" : "") + "</span>" +
        '<code class="cfg-ref">' + esc(ref || "sem referência") + "</code>" +
        '<span class="selo-estado ' + selo.classe + '">' + selo.texto + "</span>" +
        '<button class="ghost cfg-def" data-conta="' + esc(conta.id) + '" data-chave="' + esc(k) + '">' +
        (est === "presente" ? "Substituir" : "Definir") + "</button></li>"
      );
    }).join("");

    const ativa = conta.status === "active";
    return (
      '<article class="cfg-card"><header>' +
      "<h3>" + esc(canal.rotulo) + "</h3>" +
      '<span class="cfg-prov">' + esc(conta.provedor) + "</span>" +
      '<span class="selo-estado ' + (ativa ? "bom" : "atencao") + '">' +
      (ativa ? "Ativa" : conta.status === "error" ? "Com erro" : "Desativada") + "</span>" +
      "</header>" +
      '<dl class="cfg-campos">' +
      "<div><dt>Identificador da conta</dt><dd>" + esc(conta.contaExterna || "—") + "</dd></div>" +
      (conta.nome ? "<div><dt>Nome</dt><dd>" + esc(conta.nome) + "</dd></div>" : "") +
      (conta.cabecalho ? "<div><dt>Cabeçalho de assinatura</dt><dd><code>" + esc(conta.cabecalho) + "</code></dd></div>" : "") +
      "</dl>" +
      (conta.urlWebhook
        ? '<div class="cfg-webhook"><span>URL de webhook</span><code>' + esc(conta.urlWebhook) + "</code>" +
          '<button class="ghost cfg-copiar" data-copiar="' + esc(conta.urlWebhook) + '">Copiar</button></div>'
        : '<p class="cfg-nota">Endpoint público ainda não gerado. Ele é criado no servidor e é o que identifica este cliente no webhook.</p>') +
      '<ul class="cfg-segredos">' + linhas + "</ul>" +
      '<p class="cfg-nota">Um segredo definido nunca é exibido de volta. Para conferir, substitua.</p>' +
      "</article>"
    );
  }

  function pintar(contas, checklist) {
    const faltas = checklist ? pendenciasDoBackend(checklist) : pendencias(contas);
    const alvoPend = document.getElementById("config-pendencias");
    if (alvoPend) {
      alvoPend.innerHTML = faltas.length
        ? '<div class="cfg-pendencias"><h2>Falta para ativar este cliente</h2><ul>' +
          faltas.map((f) => '<li' + (f.bloqueia === false ? ' class="aviso"' : "") + "><strong>" +
            esc(f.canal) + "</strong>" + esc(f.texto) + "</li>").join("") +
          "</ul></div>"
        : '<div class="cfg-pendencias ok"><h2>Todos os canais configurados</h2>' +
          "<p>Nada impede a ativação deste cliente do lado da configuração. " +
          "A homologação em conta sandbox continua sendo obrigatória antes de qualquer contato real.</p></div>";
    }
    const alvoContas = document.getElementById("config-contas");
    if (alvoContas) {
      alvoContas.innerHTML = '<div class="cfg-grade">' +
        CANAIS.map((c) => cartaoConta(c, contas.find((x) => x.canal === c.id))).join("") + "</div>";
    }
  }

  /* ------------------------------------------------------------- controle */

  let ultimaFonte = null;

  async function atualizar() {
    const nav = global.SACNavegacao;
    if (!nav || nav.pagina() !== "configuracao") return;
    const fonte = typeof currentSource === "function" ? currentSource() : null;
    const caixa = document.getElementById("config-pendencias");

    if (!fonte || fonte.kind !== BACKEND_KIND) {
      if (caixa) caixa.innerHTML = '<div class="grafico-vazio">Escolha um cliente do backend. ' +
        'A fonte somente leitura não tem contas de canal para configurar.</div>';
      document.getElementById("config-contas").innerHTML = "";
      return;
    }
    if (!state.session) {
      if (caixa) caixa.innerHTML = '<div class="grafico-vazio">Entre com seu operador para ver a configuração deste cliente.</div>';
      document.getElementById("config-contas").innerHTML = "";
      return;
    }

    let contas = [], checklist = null;
    try {
      const [lista, chk] = await Promise.all([
        api(agentPath(fonte, "/channels")),
        api(agentPath(fonte, "/channel-checklist")).catch(() => null)
      ]);
      contas = paraTela(lista);
      checklist = chk;
    } catch (erro) {
      /* A rota ainda pode nao existir enquanto o backend nao sobe. Mostrar o
       * quadro vazio e mais util que erro: as pendencias ja dizem o que falta. */
      contas = [];
    }
    ultimaFonte = fonte.id;
    pintar(contas, checklist);
  }

  global.addEventListener("sac:pagina", (ev) => {
    if (ev.detail && ev.detail.pagina === "configuracao") atualizar();
  });
  global.addEventListener("sac:render", () => {
    const fonte = typeof currentSource === "function" ? currentSource() : null;
    if (fonte && fonte.id !== ultimaFonte) atualizar();
  });

  global.SACConfiguracao = {
    atualizar: atualizar,
    CANAIS: CANAIS, SEGREDOS: SEGREDOS, OBRIGATORIOS: OBRIGATORIOS,
    paraTela: paraTela, pendencias: pendencias, pintar: pintar
  };
})(typeof window !== "undefined" ? window : globalThis);
