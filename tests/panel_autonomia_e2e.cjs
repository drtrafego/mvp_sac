/**
 * E2E da fonte somente leitura do piloto AutonomIA dentro do painel.
 *
 * Continua provando o que esta frente nao pode quebrar: a exportacao do piloto
 * aparece sem sessao, nao oferece nenhum controle de escrita, nao dispara
 * requisicao diferente de GET e nao deixa dado operacional no navegador.
 *
 * Pre-requisitos:
 *   python3 scripts/painel-dev-proxy.py --port 8190 &
 *   node tests/panel_autonomia_e2e.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {chromium} = require("playwright");

const baseUrl = process.env.PANEL_URL || "http://127.0.0.1:8190/";

function httpCredentials(){
  const path = process.env.PANEL_AUTH_FILE;
  if(!path) return undefined;
  const line = fs.readFileSync(path, "utf8").split(/\r?\n/).find(row => row && !row.startsWith("#"));
  if(!line || !line.includes(":")) throw new Error("credencial HTTP inválida");
  const separator = line.indexOf(":");
  return {username:line.slice(0, separator), password:line.slice(separator + 1)};
}

(async () => {
  const browser = await chromium.launch({headless:true, executablePath:"/usr/bin/chromium-browser", args:["--no-sandbox"]});
  const errors = [];
  const nonGetRequests = [];
  try {
    const page = await browser.newPage({viewport:{width:1440, height:1000}, httpCredentials:httpCredentials()});
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      // O 401 de /api/session antes do login e esperado e vira ruido de console.
      if(message.type() === "error" && !/Failed to load resource/i.test(message.text())){
        errors.push(message.text());
      }
    });
    page.on("request", request => { if(request.method() !== "GET") nonGetRequests.push(`${request.method()} ${request.url()}`); });

    await page.goto(baseUrl, {waitUntil:"networkidle"});
    await page.locator("#dataset-status.ready").waitFor();
    const snapshot = await page.evaluate(() => fetch("autonomia.json").then(response => response.json()));

    assert.equal(await page.locator("#client-title").textContent(), "AutonomIA · Hermes AutonomIA");
    assert.match(await page.locator("#dataset-status").textContent(), /somente leitura/i);
    assert.match(await page.locator('[data-source^="snapshot:"]').textContent(), /somente leitura/i);

    // Fonte somente leitura nao oferece nenhum controle de escrita.
    for(const controle of ["#move-stage", "#save-note", "#assign-conversation", "#stage-select"]){
      assert.equal(await page.locator(controle).count(), 0, `${controle} aparece em fonte sem escrita`);
    }
    assert.equal(await page.locator(".composer input").isDisabled(), true);
    assert.equal(await page.locator(".composer button").isDisabled(), true);
    assert.match(await page.locator("#detail").textContent(), /não autoriza escrita/i);

    for(const origem of snapshot.sources.map(item => item.id)){
      await page.locator(`[data-origin="${origem}"]`).click();
      const rows = page.locator(".conversation-row");
      assert.ok(await rows.count() >= 1, `sem conversa para ${origem}`);
      await rows.first().click();
      assert.ok(await page.locator(".messages .message").count() >= 1, `sem histórico para ${origem}`);
      assert.equal(await page.locator(".metric").first().locator("strong").textContent(),
                   String(await rows.count()), `métrica não acompanhou o filtro ${origem}`);
      const pipelineTotal = await page.locator(".stage strong").evaluateAll(
        elements => elements.reduce((sum, element) => sum + Number(element.textContent), 0));
      const esperado = snapshot.pipeline.filter(item => item.source === origem)
        .reduce((total, item) => total + Number(item.leads), 0);
      assert.equal(pipelineTotal, esperado, `pipeline não acompanhou o filtro ${origem}`);
    }

    await page.locator('[data-origin="all"]').click();
    for(const canal of ["whatsapp", "email"]){
      await page.locator(`[data-channel="${canal}"]`).click();
      assert.ok(await page.locator(".conversation-row").count() >= 1, `sem conversa no canal ${canal}`);
    }
    await page.locator('[data-channel="all"]').click();

    const stored = await page.evaluate(() => localStorage.getItem("sac-hermes-painel-preferencias-v3"));
    assert.equal(stored.includes("dedupeKey"), false, "dado operacional foi persistido no navegador");
    assert.equal(stored.includes("messages"), false, "mensagem foi persistida no navegador");
    assert.equal(await page.evaluate(() => localStorage.getItem("sac-hermes-homologacao-v2")), null,
                 "simulação antiga continua no navegador");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

    await page.setViewportSize({width:390, height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    assert.equal(await page.locator("#detail").isVisible(), true);

    assert.deepEqual(nonGetRequests, [], "painel tentou escrever na rede");
    assert.deepEqual(errors, [], "erros JS/console detectados");
    console.log("PANEL_AUTONOMIA_E2E_OK");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
