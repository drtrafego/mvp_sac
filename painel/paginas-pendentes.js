/* Estado honesto das páginas cuja fonte de dado ainda não está ligada.
 *
 * A alternativa seria deixar a seção em branco ou desenhar tela de exemplo.
 * Branco parece defeito; exemplo parece pronto e não está. Aqui cada página
 * diz o que vai mostrar, de onde o dado vem e o que falta para ligar.
 */
(function (global) {
  "use strict";

  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const PENDENTES = {
    api_modelos: {
      titulo: "Mensagens aprovadas",
      resumo: "Os modelos de mensagem aprovados pela Meta para este número, com categoria, idioma e status de aprovação.",
      fonte: "Graph API da Meta, lida com o token da conta de WhatsApp deste cliente.",
      falta: ["conta de WhatsApp cadastrada em Configuração",
              "token de acesso gravado no cofre",
              "leitura dos modelos no backend (a chamada é de leitura, não é envio)"]
    },
    api_campanhas: {
      titulo: "Campanhas ativas",
      resumo: "Disparos em andamento por modelo aprovado: quantos foram enviados, entregues, lidos e responderam.",
      fonte: "Fila de saída do SAC cruzada com o retorno de status da Meta.",
      falta: ["conta de WhatsApp ativa", "primeiro disparo real — hoje nada foi enviado por este painel"]
    },
    api_followup: {
      titulo: "Follow-up",
      resumo: "Sequências de acompanhamento: quantas mensagens, com que intervalo, e quantas pessoas estão em cada passo.",
      fonte: "Tabelas `recovery_sequences` e `message_jobs` do RecuperaVendas, no Neon.",
      falta: ["integração do recuperador como ramal do SAC",
              "decisão de quem envia — hoje quem dispara é o cron do recuperador"]
    },
    hot_carrinho: {
      titulo: "Hotmart · Carrinho abandonado",
      resumo: "Quem abandonou o checkout, há quanto tempo, valor do produto e em que passo da recuperação está.",
      fonte: "Webhook `ABANDONED_CART` da Hotmart, recebido pelo RecuperaVendas.",
      falta: ["integração do recuperador", "escolha de qual plataforma entra primeiro"]
    },
    hot_boleto: {
      titulo: "Hotmart · Boleto e Pix",
      resumo: "Pagamentos gerados e ainda não compensados, com validade e link, e o passo da sequência.",
      fonte: "Webhooks `BILLET_PRINTED` e `WAITING_PAYMENT` da Hotmart.",
      falta: ["integração do recuperador"]
    },
    hot_recusado: {
      titulo: "Hotmart · Cartão recusado",
      resumo: "Compras recusadas na aprovação — a fila de maior urgência, porque a intenção de compra já existia.",
      fonte: "Webhook `PURCHASE_COMPLETE` com status recusado.",
      falta: ["integração do recuperador"]
    },
    hot_aprovada: {
      titulo: "Hotmart · Compra aprovada",
      resumo: "Vendas concluídas, com atribuição de qual mensagem influenciou, e o pós-venda.",
      fonte: "Webhook `PURCHASE_APPROVED`, que também cancela a fila pendente daquele telefone.",
      falta: ["integração do recuperador"]
    }
  };

  function desenhar(id) {
    const d = PENDENTES[id];
    const alvo = document.getElementById(id + "-corpo");
    if (!d || !alvo || alvo.dataset.pintado) return;
    alvo.dataset.pintado = "1";
    alvo.innerHTML =
      '<div class="pend-bloco">' +
      '<span class="pend-selo">ainda não ligado</span>' +
      "<h2>" + esc(d.titulo) + "</h2>" +
      '<p class="pend-resumo">' + esc(d.resumo) + "</p>" +
      '<dl class="pend-detalhe">' +
      "<div><dt>Fonte do dado</dt><dd>" + esc(d.fonte) + "</dd></div>" +
      "<div><dt>O que falta</dt><dd><ul>" +
      d.falta.map((f) => "<li>" + esc(f) + "</li>").join("") + "</ul></dd></div>" +
      "</dl>" +
      '<p class="pend-nota">Esta tela está vazia de propósito. Preferi dizer o que falta a mostrar ' +
      "número de exemplo, que pareceria pronto sem estar.</p></div>";
  }

  global.addEventListener("sac:pagina", (ev) => desenhar(ev.detail && ev.detail.pagina));
  global.addEventListener("DOMContentLoaded", () => {
    if (global.SACNavegacao) desenhar(global.SACNavegacao.pagina());
  });

  global.SACPendentes = { PENDENTES: PENDENTES, desenhar: desenhar };
})(typeof window !== "undefined" ? window : globalThis);
