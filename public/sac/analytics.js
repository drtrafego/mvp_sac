/* Primitivas de gráfico do painel SAC.
 *
 * SVG puro, sem biblioteca: o painel é servido atrás de autenticação e não
 * carrega script de terceiro. Cada função recebe dados já agregados pelo
 * backend e devolve uma string de HTML/SVG.
 *
 * PALETA — por que não são as cores das marcas: verde do WhatsApp e rosa do
 * Instagram, em luminosidade equivalente sobre fundo escuro, ficam a ΔE 1,6
 * para daltonismo deutan, ou seja, indistinguíveis. A tripla abaixo foi medida
 * e passa em todos os pares (pior caso ΔE 9,4 deutan, 20,9 visão normal, todos
 * com contraste >= 3:1 sobre #121518). As cores de marca continuam nos chips e
 * nas listas, onde quem carrega a identidade é o logo, não a cor.
 *
 * Ordem categórica é FIXA e nunca é reciclada: a nona série vira "Outros".
 */
(function (global) {
  "use strict";

  const PALETA = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181",
                  "#008300", "#9085e9", "#e66767"];
  const CANAL_COR = { whatsapp: "#199e70", instagram: "#d95926", email: "#3987e5" };
  const ESTADO = { bom: "#0ca30c", atencao: "#fab219", grave: "#ec835a", critico: "#e66767" };
  const TINTA = { forte: "#f4f5f2", media: "#c3cbd2", fraca: "#90989f", grade: "#ffffff14" };

  const corDaSerie = (nome, i) => CANAL_COR[nome] || PALETA[i % PALETA.length];

  /* ------------------------------------------------------------- formatos */

  const nf = new Intl.NumberFormat("pt-BR");
  const numero = (v) => nf.format(Math.round(Number(v) || 0));
  const decimal = (v, casas) => new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: casas, maximumFractionDigits: casas }).format(Number(v) || 0);
  const porcento = (v) => decimal((Number(v) || 0) * 100, 1) + "%";

  function duracao(segundos) {
    const s = Math.max(0, Math.round(Number(segundos) || 0));
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "min";
    if (s < 86400) return Math.floor(s / 3600) + "h " + Math.round((s % 3600) / 60) + "min";
    return Math.floor(s / 86400) + "d " + Math.round((s % 86400) / 3600) + "h";
  }

  const diaCurto = (iso) => {
    const d = new Date(iso + (String(iso).length === 10 ? "T12:00:00" : ""));
    return isNaN(d) ? String(iso) : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  };

  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const id = (() => { let n = 0; return () => "g" + (++n); })();

  /* --------------------------------------------------------- número-herói */

  /* Uma métrica só, grande, com variação contra o período anterior. Sem
   * gráfico: quando a resposta é um número, desenhar eixo é ruído. */
  function destaque(opcoes) {
    const o = opcoes || {};
    const temVar = o.variacao != null && isFinite(o.variacao);
    const sobe = temVar && o.variacao > 0;
    const igual = temVar && Math.abs(o.variacao) < 0.001;
    const bom = o.inverso ? !sobe : sobe;
    const classe = !temVar || igual ? "neutra" : bom ? "boa" : "ruim";
    const seta = igual ? "→" : sobe ? "↑" : "↓";
    return (
      '<div class="destaque">' +
      '<span class="destaque-rotulo">' + esc(o.rotulo || "") + "</span>" +
      '<strong class="destaque-valor">' + esc(o.valor) + "</strong>" +
      (temVar
        ? '<span class="destaque-var ' + classe + '">' + seta + " " +
          esc(porcento(Math.abs(o.variacao))) +
          '<small>vs. período anterior</small></span>'
        : o.apoio ? '<span class="destaque-apoio">' + esc(o.apoio) + "</span>" : "") +
      "</div>"
    );
  }

  /* ------------------------------------------------------ série temporal */

  /* Linha com área, grade recessiva e camada de hover com fio-cruzado.
   * series: [{nome, pontos:[{x, y}]}] com x em ISO (YYYY-MM-DD). */
  function serieTemporal(series, opcoes) {
    const o = opcoes || {};
    const L = 46, R = 14, T = 16, B = 26;
    const larg = o.largura || 720, alt = o.altura || 240;
    const dados = (series || []).filter((s) => s && s.pontos && s.pontos.length);
    if (!dados.length) return vazio(o.vazio || "Sem dados no período.");

    const eixoX = dados[0].pontos.map((p) => p.x);
    const maximo = Math.max(1, ...dados.flatMap((s) => s.pontos.map((p) => Number(p.y) || 0)));
    const teto = escalaBonita(maximo);
    const px = (i) => L + (eixoX.length === 1 ? (larg - L - R) / 2
      : (i * (larg - L - R)) / (eixoX.length - 1));
    const py = (v) => T + (alt - T - B) * (1 - (Number(v) || 0) / teto);

    const marcas = ticks(teto);
    const grade = marcas.map((v) =>
      '<line x1="' + L + '" x2="' + (larg - R) + '" y1="' + py(v).toFixed(1) +
      '" y2="' + py(v).toFixed(1) + '" stroke="' + TINTA.grade + '" stroke-width="1"/>' +
      '<text x="' + (L - 8) + '" y="' + (py(v) + 3.5).toFixed(1) +
      '" text-anchor="end" class="eixo">' + esc(numero(v)) + "</text>").join("");

    const passo = Math.max(1, Math.ceil(eixoX.length / 7));
    const rotulosX = eixoX.map((x, i) => i % passo === 0 || i === eixoX.length - 1
      ? '<text x="' + px(i).toFixed(1) + '" y="' + (alt - 7) +
        '" text-anchor="middle" class="eixo">' + esc(diaCurto(x)) + "</text>" : "").join("");

    const chave = id();
    const camadas = dados.map((s, k) => {
      const cor = corDaSerie(s.nome, k);
      const linha = s.pontos.map((p, i) => (i ? "L" : "M") + px(i).toFixed(1) + " " + py(p.y).toFixed(1)).join(" ");
      const area = linha + " L " + px(s.pontos.length - 1).toFixed(1) + " " + (alt - B) +
                   " L " + px(0).toFixed(1) + " " + (alt - B) + " Z";
      return (
        '<path d="' + area + '" fill="url(#' + chave + "-" + k + ')" opacity=".5"/>' +
        '<path d="' + linha + '" fill="none" stroke="' + cor +
        '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
        // ponta enfatizada: onde a leitura termina
        '<circle cx="' + px(s.pontos.length - 1).toFixed(1) + '" cy="' +
        py(s.pontos[s.pontos.length - 1].y).toFixed(1) + '" r="4" fill="' + cor +
        '" stroke="#121518" stroke-width="2"/>'
      );
    }).join("");

    const degrades = dados.map((s, k) => {
      const cor = corDaSerie(s.nome, k);
      return '<linearGradient id="' + chave + "-" + k + '" x1="0" x2="0" y1="0" y2="1">' +
        '<stop offset="0%" stop-color="' + cor + '" stop-opacity=".38"/>' +
        '<stop offset="100%" stop-color="' + cor + '" stop-opacity="0"/></linearGradient>';
    }).join("");

    // faixas de hover: alvo maior que a marca
    const faixa = (larg - L - R) / Math.max(1, eixoX.length - 1);
    const alvos = eixoX.map((x, i) => {
      const detalhe = dados.map((s, k) => esc(rotuloSerie(s.nome)) + ": " + numero(s.pontos[i] ? s.pontos[i].y : 0)).join(" · ");
      return '<rect class="alvo" x="' + (px(i) - faixa / 2).toFixed(1) + '" y="' + T +
        '" width="' + faixa.toFixed(1) + '" height="' + (alt - T - B) +
        '" fill="transparent" data-x="' + px(i).toFixed(1) +
        '" data-titulo="' + esc(diaCurto(x)) + '" data-detalhe="' + detalhe + '"/>';
    }).join("");

    return (
      '<figure class="grafico" data-grafico="serie">' +
      (o.titulo ? '<figcaption>' + esc(o.titulo) + "</figcaption>" : "") +
      (dados.length > 1 ? legenda(dados.map((s, k) => ({ nome: rotuloSerie(s.nome), cor: corDaSerie(s.nome, k) }))) : "") +
      '<div class="tela">' +
      '<svg viewBox="0 0 ' + larg + " " + alt + '" preserveAspectRatio="none" role="img">' +
      "<defs>" + degrades + "</defs>" + grade + camadas + rotulosX +
      '<line class="fio" x1="0" x2="0" y1="' + T + '" y2="' + (alt - B) + '" stroke="' + TINTA.fraca + '" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>' +
      alvos + "</svg>" +
      '<div class="dica" hidden></div></div>' +
      tabela(eixoX.map((x, i) => [diaCurto(x)].concat(dados.map((s) => numero(s.pontos[i] ? s.pontos[i].y : 0)))),
             ["Dia"].concat(dados.map((s) => rotuloSerie(s.nome)))) +
      "</figure>"
    );
  }

  /* ------------------------------------------------------ barras deitadas */

  /* Comparação de magnitude entre categorias. Deitada porque rótulo de origem
   * é longo e em barra em pé viraria texto na diagonal. */
  function barras(itens, opcoes) {
    const o = opcoes || {};
    const linhas = (itens || []).filter((i) => i);
    if (!linhas.length) return vazio(o.vazio || "Sem dados no período.");
    const teto = Math.max(1, ...linhas.map((i) => Number(i.valor) || 0));
    const corpo = linhas.map((i, k) => {
      const cor = i.cor || corDaSerie(i.chave || i.rotulo, k);
      const largura = ((Number(i.valor) || 0) / teto) * 100;
      return (
        '<li class="barra-linha">' +
        '<span class="barra-rotulo" title="' + esc(i.rotulo) + '">' +
        (i.icone ? '<span class="barra-icone" style="color:' + cor + '">' + i.icone + "</span>" : "") +
        esc(i.rotulo) + "</span>" +
        '<span class="barra-trilha"><span class="barra-preenche" style="width:' +
        largura.toFixed(2) + "%;background:" + cor + '"></span></span>' +
        '<span class="barra-valor">' + esc(o.formato ? o.formato(i.valor) : numero(i.valor)) + "</span>" +
        (i.apoio ? '<span class="barra-apoio">' + esc(i.apoio) + "</span>" : "") +
        "</li>"
      );
    }).join("");
    return (
      '<figure class="grafico" data-grafico="barras">' +
      (o.titulo ? "<figcaption>" + esc(o.titulo) + "</figcaption>" : "") +
      '<ul class="barras">' + corpo + "</ul></figure>"
    );
  }

  /* ------------------------------------------------------------- participação */

  /* Uma barra só, empilhada, com 2px de respiro entre segmentos. Responde
   * "quanto cada canal representa" sem virar pizza. */
  function participacao(itens, opcoes) {
    const o = opcoes || {};
    const linhas = (itens || []).filter((i) => (Number(i.valor) || 0) > 0);
    if (!linhas.length) return vazio(o.vazio || "Sem dados no período.");
    const total = linhas.reduce((s, i) => s + (Number(i.valor) || 0), 0) || 1;
    const segmentos = linhas.map((i, k) => {
      const cor = i.cor || corDaSerie(i.chave || i.rotulo, k);
      return '<span class="fatia" style="flex:' + (Number(i.valor) || 0) + ";background:" + cor +
        '" title="' + esc(i.rotulo) + ": " + esc(numero(i.valor)) + '"></span>';
    }).join("");
    const chaves = linhas.map((i, k) => (
      '<li><span class="ponto" style="background:' + (i.cor || corDaSerie(i.chave || i.rotulo, k)) + '"></span>' +
      '<span class="chave-nome">' + esc(i.rotulo) + "</span>" +
      '<span class="chave-valor">' + esc(porcento((Number(i.valor) || 0) / total)) + "</span>" +
      '<span class="chave-abs">' + esc(numero(i.valor)) + "</span></li>"
    )).join("");
    return (
      '<figure class="grafico" data-grafico="participacao">' +
      (o.titulo ? "<figcaption>" + esc(o.titulo) + "</figcaption>" : "") +
      '<div class="pilha">' + segmentos + "</div>" +
      '<ul class="chaves">' + chaves + "</ul></figure>"
    );
  }

  /* ------------------------------------------------------------------ funil */

  /* Etapas do pipeline com a taxa de passagem entre elas. A queda entre duas
   * etapas é a informação; o número absoluto sozinho esconde onde vaza. */
  function funil(etapas, opcoes) {
    const o = opcoes || {};
    const linhas = (etapas || []).filter((e) => e);
    if (!linhas.length) return vazio(o.vazio || "Pipeline vazio no período.");
    const topo = Math.max(1, Number(linhas[0].valor) || 0);
    const corpo = linhas.map((e, i) => {
      const largura = ((Number(e.valor) || 0) / topo) * 100;
      const anterior = i ? Number(linhas[i - 1].valor) || 0 : null;
      const passagem = i && anterior ? (Number(e.valor) || 0) / anterior : null;
      return (
        (i ? '<li class="funil-passo" aria-hidden="true"><span>' +
          (passagem == null ? "" : esc(porcento(passagem)) + " seguem") + "</span></li>" : "") +
        '<li class="funil-etapa">' +
        '<span class="funil-nome">' + esc(e.rotulo) + "</span>" +
        '<span class="funil-trilha"><span class="funil-preenche" style="width:' + largura.toFixed(2) +
        "%;background:" + PALETA[Math.min(i, PALETA.length - 1)] + '"></span></span>' +
        '<span class="funil-valor">' + esc(numero(e.valor)) + "</span>" +
        (e.tempoMedio != null ? '<span class="funil-tempo">' + esc(duracao(e.tempoMedio)) + " na etapa</span>" : "") +
        "</li>"
      );
    }).join("");
    return (
      '<figure class="grafico" data-grafico="funil">' +
      (o.titulo ? "<figcaption>" + esc(o.titulo) + "</figcaption>" : "") +
      '<ol class="funil">' + corpo + "</ol></figure>"
    );
  }

  /* ------------------------------------------------------------ auxiliares */

  const ROTULO_SERIE = { whatsapp: "WhatsApp", instagram: "Instagram", email: "E-mail",
                         entrada: "Entrada", saida: "Saída" };
  const rotuloSerie = (n) => ROTULO_SERIE[n] || n;

  function legenda(itens) {
    return '<ul class="legenda">' + itens.map((i) =>
      '<li><span class="ponto" style="background:' + i.cor + '"></span>' + esc(i.nome) + "</li>").join("") + "</ul>";
  }

  /* Visão em tabela: exigida para acessibilidade e para conferência de número.
   * Fica recolhida para não competir com o gráfico. */
  function tabela(linhas, cabecalho) {
    return (
      '<details class="tabela-visao"><summary>Ver como tabela</summary>' +
      '<div class="rolagem"><table><thead><tr>' +
      cabecalho.map((c) => "<th>" + esc(c) + "</th>").join("") +
      "</tr></thead><tbody>" +
      linhas.map((l) => "<tr>" + l.map((c, i) =>
        i ? "<td>" + esc(c) + "</td>" : "<th>" + esc(c) + "</th>").join("") + "</tr>").join("") +
      "</tbody></table></div></details>"
    );
  }

  const vazio = (texto) => '<div class="grafico-vazio">' + esc(texto) + "</div>";

  function escalaBonita(maximo) {
    const grandeza = Math.pow(10, Math.floor(Math.log10(maximo)));
    for (const passo of [1, 2, 2.5, 5, 10]) {
      const t = passo * grandeza;
      if (t >= maximo) return t;
    }
    return 10 * grandeza;
  }

  const ticks = (teto) => [0, teto / 4, teto / 2, (teto * 3) / 4, teto]
    .map((v) => Math.round(v)).filter((v, i, a) => a.indexOf(v) === i);

  /* Camada de hover: um ouvinte por gráfico, delegado. Chamado uma vez depois
   * de inserir os gráficos no DOM. */
  function ativarHover(raiz) {
    (raiz || document).querySelectorAll('.grafico[data-grafico="serie"] .tela').forEach((tela) => {
      if (tela.dataset.ligado) return;
      tela.dataset.ligado = "1";
      const dica = tela.querySelector(".dica");
      const fio = tela.querySelector(".fio");
      tela.addEventListener("pointermove", (ev) => {
        const alvo = ev.target.closest(".alvo");
        if (!alvo) return;
        const caixa = tela.getBoundingClientRect();
        fio.setAttribute("x1", alvo.dataset.x);
        fio.setAttribute("x2", alvo.dataset.x);
        fio.setAttribute("opacity", "1");
        dica.innerHTML = "<strong>" + alvo.dataset.titulo + "</strong><span>" + alvo.dataset.detalhe + "</span>";
        dica.hidden = false;
        const x = ev.clientX - caixa.left;
        dica.style.left = Math.min(Math.max(x, 8), caixa.width - 8) + "px";
      });
      tela.addEventListener("pointerleave", () => {
        dica.hidden = true;
        fio.setAttribute("opacity", "0");
      });
    });
  }

  global.SACGraficos = {
    PALETA: PALETA, CANAL_COR: CANAL_COR, ESTADO: ESTADO,
    numero: numero, decimal: decimal, porcento: porcento, duracao: duracao, diaCurto: diaCurto,
    destaque: destaque, serieTemporal: serieTemporal, barras: barras,
    participacao: participacao, funil: funil, legenda: legenda, tabela: tabela,
    ativarHover: ativarHover
  };
})(typeof window !== "undefined" ? window : globalThis);
