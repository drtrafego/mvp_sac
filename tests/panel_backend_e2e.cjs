/**
 * E2E do painel generico contra o gateway SAC v2 de homologacao.
 *
 * Prova o caminho inteiro: sessao de operador, leitura real vinda do
 * PostgreSQL, as tres escritas auditadas e o comportamento visivel quando o
 * backend cai. Falha se qualquer requisicao sair do prefixo da API do painel.
 *
 * Pre-requisitos:
 *   docker compose -p sac-homologacao -f compose.homologacao.yaml up -d
 *   python3 scripts/painel-dev-proxy.py --port 8190 &
 *   PANEL_OPERATOR=gastao PANEL_PASSWORD=... node tests/panel_backend_e2e.cjs
 */
const assert = require("node:assert/strict");
const {chromium} = require("playwright");

const baseUrl = process.env.PANEL_URL || "http://127.0.0.1:8190/";
const offlineUrl = process.env.PANEL_OFFLINE_URL || "http://127.0.0.1:8191/";
const operator = process.env.PANEL_OPERATOR || "gastao";
const password = process.env.PANEL_PASSWORD || "";

if(!password) throw new Error("defina PANEL_PASSWORD com a senha de homologacao");

async function entrar(page){
  await page.locator("#session-button").click();
  await page.locator("#login-operator").fill(operator);
  await page.locator("#login-password").fill(password);
  await page.locator("#login-submit").click();
  await page.locator("#login-dialog").waitFor({state:"hidden"});
  await page.waitForFunction(() => document.querySelector("#session-button")?.textContent === "Sair");
}

(async () => {
  const browser = await chromium.launch({headless:true, executablePath:"/usr/bin/chromium-browser", args:["--no-sandbox"]});
  const errors = [];
  const escritas = [];
  try {
    const page = await browser.newPage({viewport:{width:1440, height:1000}});
    page.on("pageerror", error => errors.push(error.message));
    // "Failed to load resource" e apenas o eco de um HTTP != 2xx (o 401 do
    // /session antes do login e esperado); erro de JS continua sendo falha.
    page.on("console", message => {
      if(message.type() === "error" && !/Failed to load resource/i.test(message.text())){
        errors.push(message.text());
      }
    });
    page.on("request", request => {
      if(request.method() !== "GET") escritas.push(`${request.method()} ${request.url()}`);
    });

    await page.goto(baseUrl, {waitUntil:"networkidle"});
    assert.match(await page.locator("#dataset-status").textContent(), /somente leitura/i,
                 "snapshot deveria abrir sem sessao");
    assert.equal(await page.locator("#session-button").textContent(), "Entrar");

    await entrar(page);

    const fonte = page.locator('[data-source^="agent:dr-lucas"]');
    assert.equal(await fonte.count(), 1, "agente autorizado nao apareceu na lista de fontes");
    assert.equal(await page.locator('[data-source^="agent:autonomia"]').count(), 0,
                 "agente sem permissao apareceu para este operador");
    await fonte.click();
    await page.waitForFunction(() => /escrita auditada/i.test(
      document.querySelector("#dataset-status")?.textContent || ""));

    const linhas = page.locator(".conversation-row");
    await linhas.first().waitFor();
    assert.ok(await linhas.count() >= 4, "conversas reais nao carregaram");
    await linhas.first().click();
    await page.locator(".messages .message").first().waitFor();
    assert.ok(await page.locator(".messages .message").count() >= 1, "sem historico da conversa");
    assert.equal(await page.locator(".composer input").isDisabled(), true);
    assert.equal(await page.locator(".composer button").isDisabled(), true);

    const etapaAntes = await page.locator("#stage-select").inputValue();
    const alvo = etapaAntes === "fechado" ? "agendado" : "fechado";
    await page.locator("#stage-select").selectOption(alvo);
    await page.locator("#move-stage").click();
    await page.waitForFunction(alvoEsperado => document.querySelector("#stage-select")?.value === alvoEsperado, alvo);
    assert.match(await page.locator(".panel-notice").textContent(), /Etapa/i);

    const nota = `nota de homologacao ${Date.now()}`;
    await page.locator("#note-text").fill(nota);
    await page.locator("#save-note").click();
    await page.locator(".messages .message.system", {hasText:nota}).waitFor();
    assert.match(await page.locator(".panel-notice").textContent(), /Nada foi enviado/i);

    await page.locator("#assign-conversation").click();
    await page.waitForFunction(nome => (document.querySelector("#detail")?.textContent || "").includes(nome), operator);
    assert.match(await page.locator("#assign-conversation").textContent(), /Liberar/i);

    const trilha = await page.locator("#integration").textContent();
    for(const acao of ["panel.contact.stage", "panel.conversation.note", "panel.conversation.assign"]){
      assert.ok(trilha.includes(acao), `auditoria sem ${acao}`);
    }
    assert.match(await page.locator("#side-card-title").textContent(), /auditoria/i);

    const foraDoPainel = escritas.filter(item => !item.includes("/api/"));
    assert.deepEqual(foraDoPainel, [], "painel escreveu fora da API do painel");

    await page.locator("#session-button").click();
    await page.waitForFunction(() => document.querySelector("#session-button")?.textContent === "Entrar");
    assert.equal(await page.locator('[data-source^="agent:dr-lucas"]').count(), 0,
                 "agente continuou visivel depois do logout");

    assert.equal(await page.evaluate(() => localStorage.getItem("sac-hermes-homologacao-v2")), null);
    const prefs = await page.evaluate(() => localStorage.getItem("sac-hermes-painel-preferencias-v3"));
    assert.equal(prefs.includes("conversations"), false, "conversa foi parar no navegador");
    assert.equal(prefs.includes("csrfToken"), false, "token de sessao foi parar no navegador");

    // Backend fora do ar: o aviso precisa aparecer, nenhum agente do gateway
    // pode ser listado e o login precisa falhar de forma visivel. A exportacao
    // estatica do piloto continua disponivel porque nao depende do gateway.
    const offline = await browser.newPage({viewport:{width:1440, height:1000}});
    await offline.goto(offlineUrl, {waitUntil:"networkidle"});
    const aviso = await offline.locator("#dataset-status").textContent();
    assert.match(aviso, /Backend v2 indispon/i, "queda do backend nao ficou visivel");
    assert.match(aviso, /simula/i, "painel nao avisou que nao simula dados");
    assert.equal(await offline.locator('[data-source^="agent:"]').count(), 0,
                 "painel listou agente do gateway com o backend fora do ar");
    await offline.locator("#session-button").click();
    await offline.locator("#login-operator").fill(operator);
    await offline.locator("#login-password").fill(password);
    await offline.locator("#login-submit").click();
    await offline.locator("#login-error").waitFor();
    assert.match(await offline.locator("#login-error").textContent(), /não foi possível entrar/i,
                 "login deveria falhar visivelmente com o backend fora do ar");
    assert.equal(await offline.locator("#session-button").textContent(), "Entrar");

    assert.deepEqual(errors, [], "erros JS/console detectados");
    console.log("PANEL_BACKEND_E2E_OK");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
