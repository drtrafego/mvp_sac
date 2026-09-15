/**
 * Camada de dados e estado do painel SAC.
 *
 * Esta camada nao simula atendimento. Cada conversa, mensagem, etapa de
 * pipeline e origem exibida vem de uma fonte declarada:
 *
 *   - "backend": gateway SAC v2, com sessao de operador e escrita auditada;
 *   - "snapshot": exportacao somente leitura do piloto AutonomIA.
 *
 * A distincao entre as duas e a *permissao de escrita* que a fonte declara
 * (`source.permissions.write`), nunca um rotulo de natureza do dado.
 *
 * O `localStorage` guarda apenas preferencia de navegacao (fonte, canal e
 * origem selecionadas). Nenhum dado de atendimento e persistido no navegador.
 * Se o backend cair, o painel avisa e para: nada e preenchido por simulacao.
 *
 * Apresentacao de origem, canal e etapa passa por um ponto unico
 * (`originView`/`channelView`/`stageView`). Quando `painel/origens.js` existir
 * e definir `window.SacOrigins`, ele assume rotulo e icone sem que esta camada
 * mude.
 */

const PREFS_KEY = "sac-hermes-painel-preferencias-v3";
const LEGACY_KEYS = ["sac-hermes-homologacao-v2"];
const SNAPSHOT_KIND = "snapshot";
const BACKEND_KIND = "backend";
const UNKNOWN_ORIGIN_SLUG = "origem_nao_identificada";

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));

let config = {};
let state = {
  session: null,
  sources: [],
  sourceId: null,
  channel: "all",
  originSlug: "all",
  conversationId: null,
  conversations: [],
  pipeline: [],
  origins: [],
  audit: [],
  messages: {},
  totals: null,
  backend: {status: "loading", error: null},
  snapshot: {status: "loading", error: null},
  busy: false,
  notice: null
};

/* ------------------------------------------------------------------ formato */

// `painel/origens.js` (camada de apresentacao) publica SACOrigens. Enquanto ele
// nao estiver carregado, os quatro pontos abaixo desenham texto simples. Nenhum
// outro lugar deste arquivo monta HTML de origem ou de canal.
const presentation = () => {
  if(typeof window === "undefined") return null;
  return window.SACOrigens || window.SacOrigins || null;
};

function originView(origin){
  const resolved = presentation()?.resolverOrigem?.(origin);
  const slug = origin?.slug || resolved?.slug || UNKNOWN_ORIGIN_SLUG;
  return {slug, label: resolved?.label || origin?.label || "Origem não identificada",
          channel: origin?.channel || null, campaign: origin?.campaign || null};
}

function channelView(channel){
  const id = channel || "";
  const resolved = presentation()?.resolverCanal?.(id);
  return {id, label: resolved?.label || config.channelLabels?.[id] || id || "Canal não informado"};
}

function stageView(stage){
  const id = stage || "";
  const resolved = presentation()?.resolverEtapa?.(id);
  return {id, label: resolved?.label || config.stageLabels?.[id] || id || "Sem etapa"};
}

function originChip(origin){
  const custom = presentation()?.chipOrigem?.(origin, {mini: true});
  if(custom) return custom;
  const view = originView(origin);
  return `<span class="origin-chip" data-origin-slug="${escapeHtml(view.slug)}">${escapeHtml(view.label)}</span>`;
}

function channelChip(channel){
  const custom = presentation()?.iconeCanal?.(channel || "", true);
  if(custom) return custom;
  const view = channelView(channel);
  return `<span class="channel-chip" data-channel="${escapeHtml(view.id)}">${escapeHtml(view.label)}</span>`;
}

function originGrid(origins){
  const counts = Object.fromEntries(origins.map(item => [item.slug, Number(item.contacts || 0)]));
  return presentation()?.grade?.(counts)
      || `<div class="source-list">${origins.map(item => originChip(item)).join("")}</div>`;
}

function relativeTime(value){
  if(!value) return "";
  const when = new Date(value);
  if(Number.isNaN(when.getTime())) return String(value);
  const minutes = Math.max(0, Math.floor((Date.now() - when.getTime()) / 60000));
  if(minutes < 1) return "agora";
  if(minutes < 60) return `${minutes} min`;
  if(minutes < 1440) return `${Math.floor(minutes / 60)} h`;
  return when.toLocaleDateString("pt-BR", {day:"2-digit", month:"2-digit"});
}

function messageTime(value){
  if(!value) return "";
  const when = new Date(value);
  if(Number.isNaN(when.getTime())) return String(value);
  return when.toLocaleString("pt-BR", {day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit"});
}

/* --------------------------------------------------------------- transporte */

class ApiError extends Error {
  constructor(status, code){
    super(code || `HTTP ${status}`);
    this.status = status;
    this.code = code || "";
  }
}

async function fetchJson(url){
  const separator = url.includes("?") ? "&" : "?";
  const response = await fetch(`${url}${separator}v=${Date.now()}`, {cache:"no-store"});
  if(!response.ok) throw new ApiError(response.status, `http_${response.status}`);
  return response.json();
}

function apiUrl(path){
  const base = config.panelApi?.baseUrl || "api/";
  return `${base.replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

async function api(path, {method = "GET", body} = {}){
  const headers = {"Accept": "application/json"};
  if(body !== undefined) headers["Content-Type"] = "application/json";
  if(method !== "GET" && state.session?.csrfToken) headers["X-SAC-Panel-CSRF"] = state.session.csrfToken;
  let response;
  try{
    response = await fetch(apiUrl(path), {
      method, headers, cache:"no-store", credentials:"same-origin",
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }catch(error){
    throw new ApiError(0, "network_error");
  }
  const text = await response.text();
  let payload = {};
  if(text){ try{ payload = JSON.parse(text); }catch{ payload = {}; } }
  if(!response.ok) throw new ApiError(response.status, payload.error || `http_${response.status}`);
  return payload;
}

/* ------------------------------------------------------------- preferencias */

function readPrefs(){
  for(const key of LEGACY_KEYS){
    try{ localStorage.removeItem(key); }catch{ /* modo privado */ }
  }
  try{ return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); }
  catch{ return {}; }
}

function persistPrefs(){
  // Somente navegacao. Conversa, mensagem e pipeline nunca entram aqui.
  try{
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      sourceId: state.sourceId, channel: state.channel, originSlug: state.originSlug
    }));
  }catch{ /* modo privado: preferencia deixa de ser lembrada, e so */ }
}

/* -------------------------------------------------------------------- fontes */

function currentSource(){
  return state.sources.find(item => item.id === state.sourceId) || null;
}

function backendSource(agent, index){
  return {
    id: `agent:${agent.tenantId}/${agent.agentId}`,
    kind: BACKEND_KIND,
    tenantId: agent.tenantId,
    agentId: agent.agentId,
    label: agent.tenantName || agent.tenantId,
    sublabel: agent.agentName || agent.agentId,
    status: agent.status,
    channels: agent.channels || [],
    permissions: agent.permissions || {read:true, write:false},
    accent: config.accents?.[index % (config.accents?.length || 1)] || "#6ed0ff"
  };
}

function snapshotSources(){
  const declaredList = config.snapshotSources || (config.snapshotSource ? [config.snapshotSource] : []);
  return declaredList.map(declared => ({
    id: declared.id || "snapshot:autonomia",
    kind: SNAPSHOT_KIND,
    label: declared.label || "Snapshot",
    sublabel: declared.agent || "",
    permissions: {read:true, write:false},
    accent: declared.accent || "#b8f35a"
  }));
}

function agentPath(source, suffix){
  return `agents/${encodeURIComponent(source.tenantId)}/${encodeURIComponent(source.agentId)}${suffix}`;
}

/* ------------------------------------------------------------------ snapshot */

let snapshotCache = null;

function snapshotOrigins(payload){
  // Slug e rotulo saem do proprio snapshot; o painel nao mantem tabela literal.
  return (payload.sources || []).map(item => ({
    slug: item.id, label: item.label || item.id, channel: item.channel || null,
    platform: item.captureOrigin || null, campaign: null,
    contacts: Number(item.leads || 0), lastSeenAt: item.lastActivityAt || null
  }));
}

function snapshotConversation(item){
  const pipeline = item.pipeline || {};
  const contact = item.contact || {};
  return {
    id: String(item.id),
    channel: item.channel || "",
    status: item.status || pipeline.status || "",
    assignedTo: null,
    updatedAt: item.lastActivityAt || "",
    contact: {id: String(item.id), displayName: contact.displayName || contact.company ||
              contact.handleMasked || "Contato sem nome", pipelineStage: pipeline.name || ""},
    handle: contact.handleMasked || "",
    company: contact.company || "",
    messageCount: Number(item.messageCount || 0),
    origin: {slug: item.source || UNKNOWN_ORIGIN_SLUG, label: item.sourceLabel || item.source || "",
             channel: null, platform: item.captureOrigin || null, campaign: null}
  };
}

async function loadSnapshot(){
  const endpoint = config.snapshotSource?.endpoint;
  if(!endpoint){ state.snapshot = {status:"absent", error:null}; return; }
  try{
    const payload = await fetchJson(endpoint);
    if(payload.readOnly !== true) throw new ApiError(0, "contrato_invalido");
    const bySlug = Object.fromEntries(snapshotOrigins(payload).map(item => [item.slug, item]));
    snapshotCache = {
      conversations: (payload.conversations || []).map(item => {
        const conversation = snapshotConversation(item);
        const origin = bySlug[conversation.origin.slug];
        if(origin) conversation.origin.channel = origin.channel;
        return conversation;
      }),
      messages: Object.fromEntries(Object.entries(payload.messagesByConversation || {}).map(
        ([id, list]) => [id, (list || []).map(message => ({
          id: message.id, direction: message.direction,
          occurredAt: message.sentAt || null,
          text: message.body || message.subject || "Mensagem sem texto"
        }))])),
      // Mantem o vinculo com a origem para que o filtro por origem valha
      // tambem no pipeline, sem que o painel guarde tabela de rotulos.
      pipeline: (payload.pipeline || []).map(item => ({id: item.name || item.id,
                                                       originSlug: item.source || null,
                                                       contacts: Number(item.leads || 0)})),
      origins: snapshotOrigins(payload),
      totals: payload.totals || null,
      updatedAt: payload.updatedAt || null
    };
    state.snapshot = {status:"ready", error:null, updatedAt: snapshotCache.updatedAt};
  }catch(error){
    snapshotCache = null;
    state.snapshot = {status:"unavailable", error: error.code || error.message};
  }
}

/* -------------------------------------------------------------------- sessao */

async function restoreSession(){
  try{
    const payload = await api("session");
    state.session = {operator: payload.operator, csrfToken: payload.csrfToken};
    return true;
  }catch(error){
    state.session = null;
    if(error.status === 0 || error.status >= 500) state.backend = {status:"unavailable", error:error.code};
    else state.backend = {status:"unauthenticated", error:null};
    return false;
  }
}

async function signIn(operator, password){
  const payload = await api("session", {method:"POST", body:{operator, password}});
  state.session = {operator: payload.operator, csrfToken: payload.csrfToken};
}

async function signOut(){
  try{ await api("session", {method:"DELETE"}); }catch{ /* sessao ja expirada */ }
  state.session = null;
  state.backend = {status:"unauthenticated", error:null};
  state.sources = state.sources.filter(item => item.kind === SNAPSHOT_KIND);
  if(!currentSource()) state.sourceId = state.sources[0]?.id || null;
}

/* --------------------------------------------------------------- carregamento */

async function loadBackendSources(){
  if(!state.session){ return; }
  try{
    const payload = await api("agents");
    const agents = (payload.agents || []).map(backendSource);
    state.sources = [...agents, ...state.sources.filter(item => item.kind === SNAPSHOT_KIND)];
    state.backend = {status: "ready", error: null, agents: agents.length};
  }catch(error){
    state.sources = state.sources.filter(item => item.kind === SNAPSHOT_KIND);
    if(error.status === 401){ state.session = null; state.backend = {status:"unauthenticated", error:null}; }
    else state.backend = {status:"unavailable", error: error.code};
  }
}

function clearSourceData(){
  state.conversations = []; state.pipeline = []; state.origins = [];
  state.audit = []; state.messages = {}; state.totals = null;
}

async function loadSourceData(){
  const source = currentSource();
  clearSourceData();
  if(!source) return;
  if(source.kind === SNAPSHOT_KIND){
    if(!snapshotCache) return;
    state.conversations = snapshotCache.conversations;
    state.messages = snapshotCache.messages;
    state.pipeline = snapshotCache.pipeline;
    state.origins = snapshotCache.origins;
    state.totals = snapshotCache.totals;
    return;
  }
  try{
    const [conversas, pipeline, origens] = await Promise.all([
      api(agentPath(source, "/conversations?limit=50")),
      api(agentPath(source, "/pipeline")),
      api(agentPath(source, "/origins"))
    ]);
    state.conversations = conversas.conversations || [];
    state.pipeline = pipeline.stages || [];
    state.origins = origens.origins || [];
    state.backend = {...state.backend, status:"ready", error:null};
    if(conversas.agent?.permissions) source.permissions = conversas.agent.permissions;
    try{
      const trilha = await api(agentPath(source, "/audit?limit=20"));
      state.audit = trilha.entries || [];
    }catch{ state.audit = []; }
  }catch(error){
    clearSourceData();
    if(error.status === 401){ state.session = null; state.backend = {status:"unauthenticated", error:null}; }
    else state.backend = {status:"unavailable", error: error.code};
  }
}

async function selectFirstConversation(){
  const primeira = visibleConversations()[0] || state.conversations[0];
  state.conversationId = primeira?.id || null;
  if(state.conversationId) await loadMessages(state.conversationId);
}

async function loadMessages(conversationId){
  const source = currentSource();
  if(!source || !conversationId) return;
  if(source.kind === SNAPSHOT_KIND) return;
  if(state.messages[conversationId]) return;
  try{
    const payload = await api(agentPath(source, `/conversations/${encodeURIComponent(conversationId)}/messages?limit=50`));
    state.messages[conversationId] = [...(payload.messages || [])].reverse();
    state.messages[`${conversationId}:notes`] = payload.notes || [];
  }catch(error){
    if(error.status === 401){ state.session = null; state.backend = {status:"unauthenticated", error:null}; }
    else state.backend = {status:"unavailable", error: error.code};
  }
}

/* ---------------------------------------------------------------------- acoes */

// Acoes do operador sao serializadas, nunca descartadas: um clique durante
// uma recarga espera a vez em vez de sumir sem aviso.
let pendingAction = Promise.resolve();

function withBusy(action){
  pendingAction = pendingAction.then(async () => {
    state.busy = true;
    try{ await action(); }
    finally{ state.busy = false; }
  }).catch(() => { state.busy = false; });
  return pendingAction;
}

async function moveStage(contactId, stage){
  const source = currentSource();
  if(!source || source.kind !== BACKEND_KIND) return;
  try{
    const result = await api(agentPath(source, `/contacts/${encodeURIComponent(contactId)}/stage`),
                             {method:"POST", body:{stage}});
    state.notice = result.changed
      ? `Etapa alterada de ${stageView(result.before).label} para ${stageView(result.after).label}.`
      : "Etapa já estava nessa posição; ação registrada na auditoria.";
    await loadSourceData();
  }catch(error){
    state.notice = `Não foi possível mover o card (${error.code}).`;
    if(error.status === 401) state.session = null;
  }
}

async function addNote(conversationId, text){
  const source = currentSource();
  if(!source || source.kind !== BACKEND_KIND) return;
  try{
    await api(agentPath(source, `/conversations/${encodeURIComponent(conversationId)}/notes`),
              {method:"POST", body:{text}});
    delete state.messages[conversationId];
    state.notice = "Nota interna registrada. Nada foi enviado ao contato.";
    await loadMessages(conversationId);
    await loadSourceData();
    delete state.messages[conversationId];
    await loadMessages(conversationId);
  }catch(error){
    state.notice = `Não foi possível registrar a nota (${error.code}).`;
  }
}

async function assignConversation(conversationId, assignee){
  const source = currentSource();
  if(!source || source.kind !== BACKEND_KIND) return;
  try{
    await api(agentPath(source, `/conversations/${encodeURIComponent(conversationId)}/assignment`),
              {method:"POST", body:{assignee}});
    state.notice = assignee ? "Conversa atribuída." : "Conversa liberada.";
    await loadSourceData();
  }catch(error){
    state.notice = `Não foi possível atribuir a conversa (${error.code}).`;
  }
}

/* ------------------------------------------------------------------ selecao */

function visibleConversations(){
  const term = ($("#search")?.value || "").toLocaleLowerCase("pt-BR");
  return state.conversations.filter(item => {
    const origin = originView(item.origin);
    const channelOk = state.channel === "all" || item.channel === state.channel;
    const originOk = state.originSlug === "all" || origin.slug === state.originSlug;
    const haystack = `${item.contact?.displayName || ""} ${origin.label} ${item.company || ""}`;
    return channelOk && originOk && haystack.toLocaleLowerCase("pt-BR").includes(term);
  });
}

/* ---------------------------------------------------------------- renderizacao */

function render(){
  renderSources(); renderStatus(); renderMetrics(); renderFilters();
  renderConversations(); renderPipeline(); renderSideCard();
  $("#session-button").textContent = state.session ? "Sair" : "Entrar";
  // As paginas de metrica e o kanban desenham fora daqui; avisar em vez de
  // acopla-las ao app.js.
  window.dispatchEvent(new CustomEvent("sac:render"));
}

function renderSources(){
  $("#clients").innerHTML = state.sources.map(source => `
    <button class="client-button ${state.sourceId === source.id ? "active" : ""}"
            data-source="${escapeHtml(source.id)}" style="--client-accent:${escapeHtml(source.accent)}">
      <span class="client-dot"></span>
      <span>${escapeHtml(source.label)}<small class="nav-mode">${source.permissions?.write ? "leitura e escrita" : "somente leitura"}</small></span>
    </button>`).join("") || `<p class="form-note">Nenhuma fonte disponível para esta sessão.</p>`;
  document.querySelectorAll("[data-source]").forEach(button => button.addEventListener("click", async () => {
    state.sourceId = button.dataset.source;
    state.channel = "all"; state.originSlug = "all"; state.conversationId = null;
    persistPrefs();
    await withBusy(async () => { await loadSourceData(); await selectFirstConversation(); });
    render();
  }));
  const source = currentSource();
  // O sublabel do backend costuma vir como "Atendimento <Nome>", o que
  // repetia o nome da fonte no titulo. So concatena quando acrescenta algo.
  const subtitulo = source && source.sublabel &&
    !source.sublabel.toLowerCase().includes(String(source.label).toLowerCase())
    ? ` · ${source.sublabel}` : "";
  $("#client-title").textContent = source ? `${source.label}${subtitulo}`
                                          : "Central de atendimento";
}

function renderStatus(){
  const element = $("#dataset-status");
  const source = currentSource();
  const notice = state.notice ? `<span class="panel-notice">${escapeHtml(state.notice)}</span>` : "";
  if(state.backend.status === "unavailable"){
    element.className = "dataset-status warning";
    element.innerHTML = `<span class="warning-dot"></span><strong>Backend v2 indisponível</strong>` +
      `<span>nada é exibido por simulação — verifique ${escapeHtml(config.backend?.address || "o gateway")} (${escapeHtml(state.backend.error || "sem detalhe")})</span>${notice}`;
    return;
  }
  if(source?.kind === SNAPSHOT_KIND){
    const quando = state.snapshot.updatedAt
      ? new Date(state.snapshot.updatedAt).toLocaleString("pt-BR", {dateStyle:"short", timeStyle:"short"})
      : "sem data";
    element.className = "dataset-status ready";
    element.innerHTML = `<span class="live-dot"></span><strong>${escapeHtml(source.label)}</strong>` +
      `<span>exportação somente leitura · ${escapeHtml(quando)}</span>${notice}`;
    return;
  }
  if(!state.session){
    element.className = "dataset-status warning";
    element.innerHTML = `<span class="warning-dot"></span><strong>Sem sessão de operador</strong>` +
      `<span>entre para ver e agir sobre os agentes do gateway</span>${notice}`;
    return;
  }
  element.className = "dataset-status ready";
  const escopo = `${source?.permissions?.write ? "escrita auditada" : "somente leitura"} · operador ${escapeHtml(state.session.operator?.displayName || state.session.operator?.id || "")}`;
  element.innerHTML = `<span class="live-dot"></span><strong>${escapeHtml(source?.label || "Gateway SAC v2")}</strong><span>${escopo}</span>${notice}`;
}

function pipelineView(){
  const source = currentSource();
  if(source?.kind !== SNAPSHOT_KIND) return state.pipeline;
  const contagem = new Map();
  for(const row of state.pipeline){
    if(state.originSlug !== "all" && row.originSlug !== state.originSlug) continue;
    contagem.set(row.id, (contagem.get(row.id) || 0) + Number(row.contacts || 0));
  }
  return [...contagem].map(([id, contacts]) => ({id, contacts}));
}

function renderMetrics(){
  const rows = visibleConversations();
  const mensagens = rows.reduce((total, item) => total + Number(item.messageCount || 0), 0);
  const contatos = pipelineView().reduce((total, item) => total + Number(item.contacts || 0), 0);
  const metricas = [
    [rows.length, "conversas"],
    [contatos, "contatos no pipeline"],
    [mensagens, "mensagens"],
    [state.audit.length, "ações auditadas"]
  ];
  $("#metrics").innerHTML = metricas.map(([numero, rotulo]) =>
    `<div class="metric"><strong>${numero}</strong><span>${escapeHtml(rotulo)}</span></div>`).join("");
}

function renderFilters(){
  const canais = ["all", ...Object.keys(config.channelLabels || {})];
  $("#filters").innerHTML = canais.map(value => {
    const rotulo = value === "all" ? "Todos" : channelView(value).label;
    return `<button class="filter ${state.channel === value ? "active" : ""}" data-channel="${escapeHtml(value)}">${escapeHtml(rotulo)}</button>`;
  }).join("");
  document.querySelectorAll("[data-channel]").forEach(button => button.addEventListener("click", () => {
    state.channel = button.dataset.channel; state.conversationId = null; persistPrefs();
    renderFilters(); renderConversations(); renderMetrics(); renderPipeline();
  }));

  const slugs = new Map();
  for(const item of state.origins) slugs.set(item.slug, item);
  for(const item of state.conversations){
    if(item.origin?.slug && !slugs.has(item.origin.slug)) slugs.set(item.origin.slug, item.origin);
  }
  const botoes = [["all", "Todas"], ...[...slugs.values()].map(item => [item.slug, originView(item).label])];
  $("#origin-filters").innerHTML = `<span>Origem</span>` + botoes.map(([slug, rotulo]) =>
    `<button class="origin-filter ${state.originSlug === slug ? "active" : ""}" data-origin="${escapeHtml(slug)}">${escapeHtml(rotulo)}</button>`).join("");
  document.querySelectorAll("[data-origin]").forEach(button => button.addEventListener("click", () => {
    state.originSlug = button.dataset.origin; state.conversationId = null; persistPrefs();
    renderFilters(); renderConversations(); renderMetrics(); renderPipeline();
  }));
}

function renderConversations(){
  const rows = visibleConversations();
  if(!rows.some(item => item.id === state.conversationId)) state.conversationId = rows[0]?.id || null;
  $("#conversation-list").innerHTML = rows.length ? rows.map(item => {
    const nome = item.contact?.displayName || "Contato sem nome";
    return `<button class="conversation-row ${state.conversationId === item.id ? "active" : ""}" data-conversation="${escapeHtml(item.id)}">
      <span class="avatar">${escapeHtml(nome.charAt(0))}</span>
      <span class="row-main">
        <span class="row-title"><strong>${escapeHtml(nome)}</strong><time>${escapeHtml(relativeTime(item.updatedAt))}</time></span>
        <span class="row-meta">${channelChip(item.channel)} · ${escapeHtml(stageView(item.contact?.pipelineStage).label)}</span>
        <span class="row-origin">${originChip(item.origin)}</span>
      </span>
    </button>`;
  }).join("") : `<div class="empty">${emptyMessage()}</div>`;
  document.querySelectorAll("[data-conversation]").forEach(button => button.addEventListener("click", async () => {
    state.conversationId = button.dataset.conversation;
    await withBusy(async () => { await loadMessages(state.conversationId); });
    renderConversations(); renderStatus();
  }));
  renderConversationDetail();
}

function emptyMessage(){
  const source = currentSource();
  if(source?.kind === SNAPSHOT_KIND) return "Nenhuma conversa neste filtro.";
  if(state.backend.status === "unavailable") return "Backend indisponível: nenhuma conversa carregada.";
  if(!state.session) return "Entre com um operador para carregar as conversas.";
  return "Nenhuma conversa neste filtro.";
}

function renderConversationDetail(){
  const item = state.conversations.find(row => row.id === state.conversationId);
  const source = currentSource();
  if(!item || !source){
    $("#conversation").innerHTML = `<div class="empty">${emptyMessage()}</div>`;
    $("#detail").innerHTML = "";
    return;
  }
  const mensagens = state.messages[item.id] || [];
  const notas = state.messages[`${item.id}:notes`] || [];
  const corpo = mensagens.length ? mensagens.map(message => `
    <div class="message ${message.direction === "inbound" ? "lead" : "agent"}">${escapeHtml(message.text || "Mensagem sem texto")}<time>${escapeHtml(messageTime(message.occurredAt))}</time></div>`).join("")
    : `<div class="empty compact">${item.messageCount ? `${item.messageCount} mensagens registradas; histórico não carregado.` : "Sem mensagens nesta conversa."}</div>`;
  const notasHtml = notas.length ? `<div class="notes">${notas.map(nota =>
    `<div class="message system">${escapeHtml(nota.text)}<time>${escapeHtml(nota.actor || "")} · ${escapeHtml(messageTime(nota.createdAt))}</time></div>`).join("")}</div>` : "";
  $("#conversation").innerHTML = `
    <div class="conversation-header">
      <div><h2>${escapeHtml(item.contact?.displayName || "Contato sem nome")}</h2>
      <small>${escapeHtml(source.label)} · ${channelChip(item.channel)}</small></div>
    </div>
    <div class="messages">${corpo}${notasHtml}</div>
    <div class="composer"><input disabled placeholder="Resposta ao contato desativada neste painel"><button class="primary" disabled>Enviar</button></div>`;

  const podeEscrever = source.kind === BACKEND_KIND && source.permissions?.write && state.session;
  const etapas = state.pipeline.map(stage => stage.id);
  const atribuido = item.assignedTo;
  const operadorAtual = state.session?.operator?.id;
  $("#detail").innerHTML = `
    <p class="eyebrow">Contato</p>
    <h3>${escapeHtml(item.contact?.displayName || "Contato sem nome")}</h3>
    ${item.handle ? `<p class="masked-handle">${escapeHtml(item.handle)}</p>` : ""}
    <dl>
      <div><dt>Fonte</dt><dd>${escapeHtml(source.label)}</dd></div>
      <div><dt>Canal</dt><dd>${channelChip(item.channel)}</dd></div>
      <div><dt>Etapa atual</dt><dd>${escapeHtml(stageView(item.contact?.pipelineStage).label)}</dd></div>
      <div><dt>Origem</dt><dd>${originChip(item.origin)}</dd></div>
      ${item.origin?.campaign ? `<div><dt>Campanha</dt><dd>${escapeHtml(item.origin.campaign)}</dd></div>` : ""}
      <div><dt>Responsável</dt><dd>${escapeHtml(atribuido || "sem responsável")}</dd></div>
    </dl>
    ${podeEscrever ? `
      <label class="stage-field">Mover para
        <select id="stage-select">${etapas.map(stage =>
          `<option value="${escapeHtml(stage)}" ${stage === item.contact?.pipelineStage ? "selected" : ""}>${escapeHtml(stageView(stage).label)}</option>`).join("")}</select>
      </label>
      <button class="stage-button ghost" id="move-stage">Mover card</button>
      <label class="note-field">Nota interna<textarea id="note-text" maxlength="4000" placeholder="Registro visível apenas para a operação"></textarea></label>
      <button class="stage-button ghost" id="save-note">Registrar nota</button>
      <button class="stage-button ghost" id="assign-conversation">${atribuido === operadorAtual ? "Liberar conversa" : "Assumir conversa"}</button>
      <p class="readonly-note">Toda ação grava operador, data e valor antes/depois na auditoria. Nenhuma delas envia mensagem.</p>`
    : `<p class="readonly-note">Esta fonte não autoriza escrita nesta sessão.</p>`}`;

  if(!podeEscrever) return;
  $("#move-stage").addEventListener("click", () => withBusy(async () => {
    await moveStage(item.contact.id, $("#stage-select").value);
    render();
  }));
  $("#save-note").addEventListener("click", () => withBusy(async () => {
    const texto = $("#note-text").value.trim();
    if(!texto){ state.notice = "Nota vazia não é registrada."; renderStatus(); return; }
    await addNote(item.id, texto);
    render();
  }));
  $("#assign-conversation").addEventListener("click", () => withBusy(async () => {
    await assignConversation(item.id, atribuido === operadorAtual ? null : operadorAtual);
    render();
  }));
}

function renderPipeline(){
  // O quadro kanban e o funil substituiram este bloco na pagina de Pipeline;
  // o elemento pode nao existir mais.
  if(!$("#pipeline")) return;
  const stages = pipelineView();
  $("#pipeline").innerHTML = stages.length ? stages.map(stage => `
    <div class="stage"><strong>${Number(stage.contacts || 0)}</strong><span>${escapeHtml(stageView(stage.id).label)}</span></div>`).join("")
    : `<div class="empty compact">${emptyMessage()}</div>`;
}

function renderSideCard(){
  const source = currentSource();
  if(source?.kind === BACKEND_KIND){
    $("#side-card-eyebrow").textContent = "Governança";
    $("#side-card-title").textContent = "Trilha de auditoria";
    $("#integration").innerHTML = state.audit.length ? state.audit.map(entry => `
      <div class="ig-status"><span>${escapeHtml(messageTime(entry.occurredAt))}</span>
      <strong>${escapeHtml(entry.actorId || "")} · ${escapeHtml(entry.action || "")}</strong></div>`).join("")
      + `<p class="form-note">Registro append-only por agente. Escrita do painel nunca enfileira envio externo.</p>`
      : `<p class="form-note">Sem ações registradas para este agente.</p>`;
    return;
  }
  $("#side-card-eyebrow").textContent = "Fonte";
  $("#side-card-title").textContent = "Canais e origens";
  $("#integration").innerHTML = `
    <div class="ig-status"><span>Fonte</span><strong>${escapeHtml(source?.label || "-")}</strong></div>
    <div class="ig-status"><span>Escrita</span><strong class="ok">desativada</strong></div>
    ${originGrid(state.origins)}
    <p class="form-note">Exportação somente leitura do piloto. A base bruta de mineração permanece separada e nenhum envio parte daqui.</p>`;
}

/* --------------------------------------------------------------------- boot */

function bindLogin(){
  const dialog = $("#login-dialog");
  $("#session-button").addEventListener("click", async () => {
    if(state.session){
      await withBusy(async () => { await signOut(); await loadSourceData(); });
      render();
      return;
    }
    $("#login-error").textContent = "";
    dialog.showModal();
  });
  $("#login-form").addEventListener("submit", async event => {
    if(event.submitter?.value === "cancel") return;
    event.preventDefault();
    const operator = $("#login-operator").value.trim();
    const password = $("#login-password").value;
    try{
      await signIn(operator, password);
      $("#login-password").value = "";
      dialog.close();
      await withBusy(async () => {
        await loadBackendSources();
        if(!currentSource()) state.sourceId = state.sources[0]?.id || null;
        await loadSourceData();
        await selectFirstConversation();
      });
      render();
    }catch(error){
      $("#login-error").textContent = error.code === "invalid_credentials" ? "Operador ou senha inválidos."
        : error.code === "too_many_attempts" ? "Muitas tentativas. Aguarde alguns minutos."
        : `Não foi possível entrar (${error.code}).`;
    }
  });
}

function bind(){
  $("#search").addEventListener("input", () => { renderConversations(); renderMetrics(); });
  $("#refresh-data").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    await withBusy(async () => {
      await loadSnapshot();
      if(state.session) await loadBackendSources();
      await loadSourceData();
    });
    button.disabled = false;
    render();
  });
  bindLogin();
}

async function boot(){
  config = await fetchJson("data.json");
  const prefs = readPrefs();
  state.channel = prefs.channel || "all";
  state.originSlug = prefs.originSlug || "all";
  await loadSnapshot();
  state.sources = state.snapshot.status === "ready" ? snapshotSources() : [];
  await restoreSession();
  await loadBackendSources();
  state.sourceId = state.sources.some(item => item.id === prefs.sourceId)
    ? prefs.sourceId : state.sources[0]?.id || null;
  await loadSourceData();
  await selectFirstConversation();
  bind();
  render();
}

boot().catch(error => {
  document.body.innerHTML = `<div class="empty fatal">Não foi possível carregar o painel.<br><small>${escapeHtml(error.message || "erro desconhecido")}</small></div>`;
});
