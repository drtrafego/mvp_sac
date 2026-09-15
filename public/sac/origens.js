/* Camada de apresentacao de canais e origens do SAC Hermes.
 *
 * Invariante do produto: canal de conversa e origem de aquisicao sao campos
 * DIFERENTES. O canal e por onde se fala (WhatsApp, Instagram, e-mail). A
 * origem e de onde a pessoa veio (anuncio, mineracao, carrinho abandonado,
 * recuperacao de venda). Uma origem pode entregar em varios canais; um canal
 * atende varias origens. Este arquivo so desenha - nao busca dado, nao decide
 * permissao e nao conhece tenant.
 *
 * Para adicionar uma ferramenta nova, acrescente uma entrada em FERRAMENTAS e
 * uma ou mais em ORIGENS. Nada mais no painel precisa mudar.
 */
(function (global) {
  "use strict";

  /* ---------------------------------------------------------------- glifos */
  /* Marcas conhecidas sao desenhadas fielmente. Onde nao ha desenho oficial
   * confiavel, usamos monograma na cor da marca - explicito, nunca um logo
   * inventado que pareca oficial. */

  const GLIFOS = {
    whatsapp:
      '<path fill="currentColor" d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.08-.3-.15-1.26-.46-2.39-1.48-.89-.79-1.48-1.76-1.66-2.06-.17-.3-.02-.46.13-.6.14-.14.3-.35.45-.52.15-.18.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.87 1.22 3.07.15.2 2.1 3.2 5.08 4.49.7.3 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2-1.41.25-.7.25-1.29.18-1.42-.08-.12-.28-.2-.57-.35M12.05 21.8h-.01a9.9 9.9 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.89 9.89-9.89a9.82 9.82 0 0 1 6.99 2.9 9.82 9.82 0 0 1 2.89 6.99c0 5.45-4.44 9.89-9.88 9.89m8.41-18.3A11.8 11.8 0 0 0 12.05 0C5.5 0 .16 5.34.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.9 11.9 0 0 0 5.69 1.45c6.55 0 11.89-5.34 11.89-11.9a11.8 11.8 0 0 0-3.48-8.4"/>',
    instagram:
      '<rect x="2.6" y="2.6" width="18.8" height="18.8" rx="5.6" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="17.3" cy="6.7" r="1.25" fill="currentColor"/>',
    email:
      '<rect x="2.4" y="4.6" width="19.2" height="14.8" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M3.6 7.6 12 13.3l8.4-5.7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    google:
      '<path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.4 5.4 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24"/><path fill="#FBBC05" d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.29a12 12 0 0 0 0 10.76z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.7 0 3.99 2.47 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75"/>',
    meta:
      '<path d="M4.4 8.1c1.9-2.7 4.5-2.1 6.2.6l1.4 2.3 1.4-2.3c1.7-2.7 4.3-3.3 6.2-.6 1.7 2.3 1.7 5.5 0 7.8-1.9 2.7-4.5 2.1-6.2-.6L12 13l-1.4 2.3c-1.7 2.7-4.3 3.3-6.2.6-1.7-2.3-1.7-5.5 0-7.8Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
    pin:
      '<path d="M12 22s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><circle cx="12" cy="10.6" r="2.6" fill="none" stroke="currentColor" stroke-width="1.9"/>',
    pix:
      '<path d="M12 2.4 21.6 12 12 21.6 2.4 12Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M8.1 8.1 12 12l3.9-3.9M8.1 15.9 12 12l3.9 3.9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    cartao:
      '<rect x="2.4" y="5" width="19.2" height="14" rx="2.8" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M2.4 9.7h19.2" stroke="currentColor" stroke-width="1.9"/><path d="m14.7 13.5 4.3 4.3m0-4.3-4.3 4.3" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    aprovada:
      '<circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="m7.8 12.3 2.9 2.9 5.5-5.9" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>',
    disputa:
      '<path d="M12 2.6 20 5.6v6c0 4.6-3.2 8.4-8 9.8-4.8-1.4-8-5.2-8-9.8v-6Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M12 8.4v4.4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="16.3" r="1.15" fill="currentColor"/>',
    chatgpt:
      '<path fill="currentColor" d="M22.28 9.82a6 6 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.5-2.9A6.07 6.07 0 0 0 4.98 4.18a6 6 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 6 6 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 6 6 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07Zm-9.02 12.6a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.8.8 0 0 0 .4-.68v-6.74l2.02 1.17a.07.07 0 0 1 .03.05v5.59a4.5 4.5 0 0 1-4.49 4.49ZM3.6 18.3a4.47 4.47 0 0 1-.54-3.01l.15.08 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06L9.74 19.95a4.5 4.5 0 0 1-6.14-1.65ZM2.34 7.9a4.49 4.49 0 0 1 2.37-1.98v5.69a.77.77 0 0 0 .38.67l5.82 3.36-2.02 1.16a.08.08 0 0 1-.07 0l-4.83-2.78A4.5 4.5 0 0 1 2.34 7.9Zm16.6 3.86-5.84-3.39 2.02-1.16a.08.08 0 0 1 .07 0l4.83 2.78a4.49 4.49 0 0 1-.68 8.11v-5.68a.79.79 0 0 0-.4-.66Zm2.01-3.03-.15-.08-4.77-2.79a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.07l4.83-2.78a4.5 4.5 0 0 1 6.68 4.66Zm-12.64 4.14-2.02-1.17a.08.08 0 0 1-.04-.05V6.08a4.5 4.5 0 0 1 7.38-3.46l-.15.09-4.78 2.75a.8.8 0 0 0-.4.69Z"/>',
    claude:
      '<path fill="currentColor" d="M4.71 15.96 9.42 4.04h2.83L7.54 15.96H4.71Zm7.06 0L16.48 4.04h2.83L14.6 15.96h-2.83Z"/>',
    gemini:
      '<path fill="currentColor" d="M12 0c0 6.63 5.37 12 12 12-6.63 0-12 5.37-12 12 0-6.63-5.37-12-12-12 6.63 0 12-5.37 12-12Z"/>',
    grok:
      '<path fill="currentColor" d="m3.2 20.8 11-11 2.4 2.4-11 11H3.2v-2.4Zm14.6-9.1 3-3V3.2h-5.5l-3 3 5.5 5.5Z"/>',
    ia_busca:
      '<circle cx="10.6" cy="10.6" r="6.6" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="m15.4 15.4 5 5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M10.6 7.4v6.4M7.4 10.6h6.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    bio:
      '<path d="M9.4 14.6a3.6 3.6 0 0 0 5.1 0l3.3-3.3a3.6 3.6 0 1 0-5.1-5.1l-.9.9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M14.6 9.4a3.6 3.6 0 0 0-5.1 0l-3.3 3.3a3.6 3.6 0 1 0 5.1 5.1l.9-.9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    prospeccao:
      '<path d="M12 2.6v4M12 17.4v4M2.6 12h4M17.4 12h4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="12" r="4.4" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>',
    organico:
      '<path d="M12 21c0-6 3.4-10.4 8.4-11.4C20.4 15.6 17 21 12 21Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M12 21C7 21 3.6 16.6 3.6 10.6 8.6 11.6 12 15 12 21Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
    carrinho:
      '<path d="M2.6 3.6h2.5l2.3 11.1h10.1l2-7.9H6.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="19.4" r="1.7" fill="currentColor"/><circle cx="17.2" cy="19.4" r="1.7" fill="currentColor"/>',
    boleto:
      '<rect x="2.6" y="5.2" width="18.8" height="13.6" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M6.2 8.6v6.8M8.8 8.6v6.8M11.9 8.6v6.8M15.6 8.6v6.8M18.2 8.6v6.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    recuperador:
      '<path d="M20.4 12a8.4 8.4 0 1 1-2.5-6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M20.6 2.6v4.2h-4.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7.8v4.5l3 1.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    site:
      '<circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M2.8 12h18.4M12 2.8c2.4 2.6 3.6 5.7 3.6 9.2s-1.2 6.6-3.6 9.2c-2.4-2.6-3.6-5.7-3.6-9.2S9.6 5.4 12 2.8Z" fill="none" stroke="currentColor" stroke-width="1.9"/>',
    indicacao:
      '<circle cx="9" cy="8.4" r="3.4" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M2.8 20.2c0-3.4 2.8-6.1 6.2-6.1s6.2 2.7 6.2 6.1" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M17.4 5.8a3.4 3.4 0 0 1 0 6.6M18.6 14.6c2.2.6 3.8 2.6 3.8 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'
  };

  const desenho = (nome) =>
    GLIFOS[nome]
      ? '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + GLIFOS[nome] + "</svg>"
      : "";

  /* --------------------------------------------------------------- canais */

  const CANAIS = {
    whatsapp: { slug: "whatsapp", label: "WhatsApp", glifo: "whatsapp", cor: "#25D366" },
    instagram: { slug: "instagram", label: "Instagram", glifo: "instagram", cor: "#E1306C" },
    email: { slug: "email", label: "E-mail", glifo: "email", cor: "#8AB4F8" }
  };

  const ORDEM_CANAIS = ["whatsapp", "instagram", "email"];

  /* ---------------------------------------------------------- ferramentas */
  /* tipo: "marca" desenha o glifo da marca; "monograma" desenha a inicial na
   * cor da marca (usado quando nao temos o desenho oficial); "interno" e
   * ferramenta nossa, desenhada com o verde do painel. */

  const FERRAMENTAS = {
    meta_ads: { slug: "meta_ads", nome: "Meta Ads", cor: "#0866FF", tipo: "marca", glifo: "meta", nota: "Facebook e Instagram" },
    mineracao: { slug: "mineracao", nome: "Mineração", cor: "#4285F4", tipo: "marca", glifo: "google", nota: "Google Places" },
    hotmart: { slug: "hotmart", nome: "Hotmart", cor: "#F04E23", tipo: "monograma", monograma: "H", nota: "Checkout de infoproduto", checkout: true },
    kiwify: { slug: "kiwify", nome: "Kiwify", cor: "#0EA65A", tipo: "monograma", monograma: "K", nota: "Checkout de infoproduto", checkout: true },
    greenn: { slug: "greenn", nome: "Greenn", cor: "#12B981", tipo: "monograma", monograma: "G", nota: "Checkout de infoproduto", checkout: true },
    zouti: { slug: "zouti", nome: "Zouti", cor: "#7C5CFF", tipo: "monograma", monograma: "Z", nota: "Checkout de infoproduto", checkout: true },
    google_ads: { slug: "google_ads", nome: "Google Ads", cor: "#f43f5e", tipo: "marca", glifo: "google", nota: "Rede de pesquisa" },
    link_bio: { slug: "link_bio", nome: "Link da Bio", cor: "#ec4899", tipo: "interno", glifo: "bio", nota: "Perfil do Instagram" },
    captacao_ativa: { slug: "captacao_ativa", nome: "Captação Ativa", cor: "#f59e0b", tipo: "interno", glifo: "prospeccao", nota: "Prospecção" },
    organicos: { slug: "organicos", nome: "Orgânicos", cor: "#10b981", tipo: "interno", glifo: "organico", nota: "Busca sem anúncio" },
    minerador: { slug: "minerador", nome: "Minerador", cor: "#06b6d4", tipo: "interno", glifo: "pin", nota: "Prospecção automatizada" },
    chatgpt: { slug: "chatgpt", nome: "ChatGPT", cor: "#19c37d", tipo: "marca", glifo: "chatgpt", nota: "Indicação de IA" },
    claude: { slug: "claude", nome: "Claude", cor: "#d97757", tipo: "marca", glifo: "claude", nota: "Indicação de IA" },
    gemini: { slug: "gemini", nome: "Gemini", cor: "#4285f4", tipo: "marca", glifo: "gemini", nota: "Indicação de IA" },
    grok: { slug: "grok", nome: "Grok", cor: "#a3a3a3", tipo: "marca", glifo: "grok", nota: "Indicação de IA" },
    ia_busca: { slug: "ia_busca", nome: "Busca por IA", cor: "#8b5cf6", tipo: "interno", glifo: "ia_busca", nota: "Copilot, Perplexity e afins" },
    site: { slug: "site", nome: "Site", cor: "#9AA7B2", tipo: "interno", glifo: "site", nota: "Formulário próprio" },
    indicacao: { slug: "indicacao", nome: "Indicação", cor: "#F0B429", tipo: "interno", glifo: "indicacao", nota: "Boca a boca" }
  };

  /* Eventos do recuperador de vendas. Sao os mesmos tipos que o
   * RecuperaVendas ja recebe por webhook das plataformas de checkout.
   * A ordem aqui e a ordem de urgencia comercial. */

  const EVENTOS = [
    { slug: "carrinho_abandonado", label: "Carrinho abandonado", curto: "Carrinho", glifo: "carrinho", canais: ["whatsapp", "email"] },
    { slug: "boleto", label: "Boleto emitido", curto: "Boleto", glifo: "boleto", canais: ["whatsapp", "email"] },
    { slug: "pix", label: "Pix gerado", curto: "Pix", glifo: "pix", canais: ["whatsapp", "email"] },
    { slug: "cartao_recusado", label: "Cartão recusado", curto: "Recusado", glifo: "cartao", canais: ["whatsapp"] },
    { slug: "compra_aprovada", label: "Compra aprovada", curto: "Aprovada", glifo: "aprovada", canais: ["whatsapp", "email"] },
    { slug: "disputa", label: "Disputa aberta", curto: "Disputa", glifo: "disputa", canais: ["whatsapp", "email"] }
  ];

  const POR_EVENTO = new Map(EVENTOS.map((e) => [e.slug, e]));
  const PLATAFORMAS_CHECKOUT = Object.keys(FERRAMENTAS).filter((s) => FERRAMENTAS[s].checkout);

  /* O recuperador e um ramal do SAC: cada par plataforma x evento e uma
   * origem. Geradas, nao escritas a mao - plataforma nova entra so em
   * FERRAMENTAS com checkout:true. */

  const origensRecuperador = () => {
    const lista = [];
    for (const p of PLATAFORMAS_CHECKOUT)
      for (const e of EVENTOS)
        lista.push({
          slug: p + "_" + e.slug,
          ferramenta: p,
          ramal: "recuperador",
          evento: e.slug,
          label: e.label,
          curto: e.curto,
          canais: e.canais.slice(),
          estado: "planejado",
          glifo: e.glifo
        });
    return lista;
  };

  const ORIGENS = [
    { slug: "ads", ferramenta: "meta_ads", ramal: "sac", label: "Anúncios", curto: "Anúncios", canais: ["whatsapp", "instagram"], estado: "ativo", glifo: "meta" },
    { slug: "mining_whatsapp", ferramenta: "mineracao", ramal: "sac", label: "Mineração WhatsApp", curto: "Mineração", canais: ["whatsapp"], estado: "ativo", glifo: "pin" },
    { slug: "mining_email", ferramenta: "mineracao", ramal: "sac", label: "Mineração E-mail", curto: "Mineração", canais: ["email"], estado: "ativo", glifo: "pin" },
    { slug: "google_ads", ferramenta: "google_ads", ramal: "sac", label: "Google Ads", curto: "Google", canais: ["whatsapp"], estado: "planejado", glifo: "google" },
    { slug: "link_bio", ferramenta: "link_bio", ramal: "sac", label: "Link da Bio", curto: "Bio", canais: ["instagram", "whatsapp"], estado: "planejado", glifo: "bio" },
    { slug: "captacao_ativa", ferramenta: "captacao_ativa", ramal: "sac", label: "Captação ativa", curto: "Ativa", canais: ["whatsapp"], estado: "planejado", glifo: "prospeccao" },
    { slug: "organicos", ferramenta: "organicos", ramal: "sac", label: "Orgânicos", curto: "Orgânico", canais: ["whatsapp", "email"], estado: "planejado", glifo: "organico" },
    { slug: "minerador", ferramenta: "minerador", ramal: "sac", label: "Minerador", curto: "Minerador", canais: ["whatsapp", "email"], estado: "ativo", glifo: "pin" },
    { slug: "chatgpt", ferramenta: "chatgpt", ramal: "sac", label: "ChatGPT", curto: "ChatGPT", canais: ["whatsapp"], estado: "planejado", glifo: "chatgpt" },
    { slug: "claude", ferramenta: "claude", ramal: "sac", label: "Claude", curto: "Claude", canais: ["whatsapp"], estado: "planejado", glifo: "claude" },
    { slug: "gemini", ferramenta: "gemini", ramal: "sac", label: "Gemini", curto: "Gemini", canais: ["whatsapp"], estado: "planejado", glifo: "gemini" },
    { slug: "grok", ferramenta: "grok", ramal: "sac", label: "Grok", curto: "Grok", canais: ["whatsapp"], estado: "planejado", glifo: "grok" },
    { slug: "ia_busca", ferramenta: "ia_busca", ramal: "sac", label: "Busca por IA", curto: "IA", canais: ["whatsapp"], estado: "planejado", glifo: "ia_busca" },
    { slug: "site", ferramenta: "site", ramal: "sac", label: "Formulário do site", curto: "Site", canais: ["whatsapp", "email"], estado: "planejado", glifo: "site" },
    { slug: "indicacao", ferramenta: "indicacao", ramal: "sac", label: "Indicação", curto: "Indicação", canais: ["whatsapp"], estado: "planejado", glifo: "indicacao" }
  ].concat(origensRecuperador());

  const POR_SLUG = new Map(ORIGENS.map((o) => [o.slug, o]));

  /* Rotulos livres que o backend legado ainda manda como string. Mapeados
   * para slug para que a apresentacao seja a mesma. Nao adicione logica nova
   * aqui: o caminho certo e o backend mandar slug. */
  const ALIAS_LEGADO = {
    "anúncios": "ads",
    "anuncios": "ads",
    "ads": "ads",
    "mineração whatsapp": "mining_whatsapp",
    "mineracao whatsapp": "mining_whatsapp",
    "mineração e-mail": "mining_email",
    "mineracao e-mail": "mining_email",
    "mineração email": "mining_email",
    meta_anuncio: "ads",
    meta_ads: "ads",
    anuncio: "ads",
    /* Chaves do crm-unico (leads.campaign_source). A lista canonica dele esta
     * em src/lib/origin-keys.ts; manter os dois nomes casando evita o problema
     * que eles ja tiveram: origem nova entrar num lugar e faltar no outro. */
    google: "google_ads",
    "google ads": "google_ads",
    meta: "ads",
    "meta ads": "ads",
    whatsapp: "mining_whatsapp",
    direct: "instagram_direct",
    "instagram direct": "instagram_direct",
    "link da bio": "link_bio",
    "captacao ativa": "captacao_ativa",
    "captação ativa": "captacao_ativa",
    "indicacao": "indicacao",
    "indicação": "indicacao",
    "organicos": "organicos",
    "orgânicos": "organicos",
    minerador: "minerador",
    chatgpt: "chatgpt",
    claude: "claude",
    gemini: "gemini",
    grok: "grok",
    "ai search": "ia_busca",
    "busca por ia": "ia_busca"
  };

  const ESTADOS = {
    ativo: { label: "Ativo", classe: "e-ativo" },
    homologacao: { label: "Homologação", classe: "e-homologacao" },
    planejado: { label: "Planejado", classe: "e-planejado" },
    desativado: { label: "Desativado", classe: "e-desativado" }
  };

  const DESCONHECIDA = {
    slug: "desconhecida",
    ferramenta: null,
    label: "Origem não identificada",
    curto: "Sem origem",
    canais: [],
    estado: "desativado",
    glifo: null
  };

  /* ------------------------------------------------------------ resolucao */

  function resolverOrigem(valor) {
    if (!valor) return DESCONHECIDA;
    if (typeof valor === "object") {
      if (valor.slug && POR_SLUG.has(valor.slug)) return POR_SLUG.get(valor.slug);
      /* O backend manda objeto; o apelido precisa valer aqui tambem, senao
       * `meta_anuncio` aparecia como "Meta · anuncio" em vez de "Anúncios". */
      if (valor.slug) {
        const apelido = ALIAS_LEGADO[String(valor.slug).toLowerCase()];
        if (apelido && POR_SLUG.has(apelido)) return POR_SLUG.get(apelido);
      }
      if (valor.slug) {
        /* Origem que o catalogo ainda nao conhece. O backend manda platform e
         * channel separados (backend/origins.py), entao da pra desenhar direito
         * sem adivinhar: a marca vem de platform, o icone do evento vem do
         * sufixo do slug. */
        const plataforma = valor.platform ? String(valor.platform).toLowerCase() : null;
        let evento = null;
        for (const e of EVENTOS)
          if (valor.slug === e.slug || valor.slug.endsWith("_" + e.slug)) { evento = e; break; }
        const canais = valor.channel ? [String(valor.channel).toLowerCase()] : evento ? evento.canais.slice() : [];
        return {
          slug: valor.slug,
          ferramenta: plataforma,
          ramal: evento ? "recuperador" : "sac",
          evento: evento ? evento.slug : null,
          label: valor.label || (evento ? evento.label : valor.slug),
          curto: evento ? evento.curto : valor.label || valor.slug,
          canais: canais,
          estado: "ativo",
          glifo: evento ? evento.glifo : null
        };
      }
      valor = valor.label || valor.origin || "";
    }
    const bruto = String(valor).trim();
    if (POR_SLUG.has(bruto)) return POR_SLUG.get(bruto);
    const chave = ALIAS_LEGADO[bruto.toLowerCase()];
    if (chave && POR_SLUG.has(chave)) return POR_SLUG.get(chave);
    return Object.assign({}, DESCONHECIDA, { label: bruto, curto: bruto });
  }

  const resolverCanal = (slug) =>
    CANAIS[slug] || { slug: slug || "desconhecido", label: slug || "Não informado", glifo: null, cor: "#7C868E" };

  /* Plataforma que ainda nao esta no catalogo nao pode virar "?": o backend
   * aceita provedor novo sem mudar codigo, e a apresentacao precisa acompanhar.
   * Cor derivada do proprio nome, entao ela e estavel entre recarregamentos. */
  const PALETA_AUTO = ["#6C8DFF", "#E0736B", "#39B7A6", "#C98BE8", "#E0A245", "#7FB069"];

  function ferramentaSintetica(slug) {
    let soma = 0;
    for (let i = 0; i < slug.length; i++) soma = (soma * 31 + slug.charCodeAt(i)) >>> 0;
    const nome = slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      slug: slug,
      nome: nome,
      cor: PALETA_AUTO[soma % PALETA_AUTO.length],
      tipo: "monograma",
      monograma: nome.charAt(0).toUpperCase(),
      nota: "Plataforma ainda não catalogada",
      sintetica: true
    };
  }

  const resolverFerramenta = (slug) => (slug ? FERRAMENTAS[slug] || ferramentaSintetica(slug) : null);

  const escapar = (texto) =>
    String(texto == null ? "" : texto).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  /* ------------------------------------------------------------ desenhos */

  /* Selo da ferramenta: quadradinho colorido com o logo ou o monograma. */
  function seloFerramenta(slugFerramenta, tamanho) {
    const f = resolverFerramenta(slugFerramenta);
    const classe = "selo selo-" + (tamanho || "md");
    if (!f) return '<span class="' + classe + ' selo-vazio" aria-hidden="true">?</span>';
    const corpo =
      f.tipo === "monograma"
        ? '<b>' + escapar(f.monograma || f.nome.charAt(0)) + "</b>"
        : desenho(f.glifo);
    const colorido = f.glifo === "google";
    return (
      '<span class="' + classe + (colorido ? " selo-colorido" : "") + '" style="--marca:' + f.cor + '" title="' + escapar(f.nome) + '">' +
      corpo +
      "</span>"
    );
  }

  /* Icone do canal, para usar em linha com texto. */
  function iconeCanal(slugCanal, comRotulo) {
    const c = resolverCanal(slugCanal);
    const svgTag = c.glifo ? desenho(c.glifo) : '<span class="ponto"></span>';
    return (
      '<span class="canal canal-' + escapar(c.slug) + '" style="--marca:' + c.cor + '" title="' + escapar(c.label) + '">' +
      svgTag +
      (comRotulo ? "<span>" + escapar(c.label) + "</span>" : '<span class="sr">' + escapar(c.label) + "</span>") +
      "</span>"
    );
  }

  function iconesCanais(lista) {
    const canais = (lista && lista.length ? lista : []).filter((s) => CANAIS[s]);
    if (!canais.length) return "";
    return '<span class="canais">' + canais.map((s) => iconeCanal(s, false)).join("") + "</span>";
  }

  /* Chip de origem: selo da ferramenta + rotulo. E o bloco que aparece em
   * cada linha da caixa de entrada e nos filtros. */
  function chipOrigem(valor, opcoes) {
    const o = resolverOrigem(valor);
    const op = opcoes || {};
    const f = resolverFerramenta(o.ferramenta);
    const rotulo = op.curto ? o.curto || o.label : o.label;
    const marca = f ? f.cor : "#7C868E";
    const glifo = o.glifo && GLIFOS[o.glifo] ? desenho(o.glifo) : "";
    return (
      '<span class="chip-origem' + (op.mini ? " chip-mini" : "") + '" style="--marca:' + marca + '" data-origem="' + escapar(o.slug) + '">' +
      (glifo ? '<span class="chip-glifo">' + glifo + "</span>" : seloFerramenta(o.ferramenta, "xs")) +
      '<span class="chip-texto">' +
      (f && !op.curto ? '<small>' + escapar(f.nome) + "</small>" : "") +
      "<strong>" + escapar(rotulo) + "</strong>" +
      "</span>" +
      (op.canais === false ? "" : iconesCanais(o.canais)) +
      "</span>"
    );
  }

  function selo(estado) {
    const e = ESTADOS[estado] || ESTADOS.desativado;
    return '<span class="estado ' + e.classe + '">' + escapar(e.label) + "</span>";
  }

  /* Cartao de ferramenta para o painel "Canais e origens": mostra a
   * ferramenta, cada origem dela, os canais de entrega e quanto entrou. */
  function cartaoFerramenta(slugFerramenta, contagens) {
    const f = resolverFerramenta(slugFerramenta);
    if (!f) return "";
    const conta = contagens || {};
    const origens = ORIGENS.filter((o) => o.ferramenta === slugFerramenta);
    const total = origens.reduce((soma, o) => soma + (Number(conta[o.slug]) || 0), 0);
    const linhas = origens
      .map(
        (o) =>
          '<li class="linha-origem">' +
          '<span class="linha-glifo">' + (o.glifo ? desenho(o.glifo) : "") + "</span>" +
          '<span class="linha-nome">' + escapar(o.label) + "</span>" +
          iconesCanais(o.canais) +
          '<span class="linha-total">' + (conta[o.slug] != null ? escapar(conta[o.slug]) : "—") + "</span>" +
          selo(o.estado) +
          "</li>"
      )
      .join("");
    return (
      '<article class="cartao-ferramenta" style="--marca:' + f.cor + '">' +
      '<header>' +
      seloFerramenta(slugFerramenta, "md") +
      "<div><strong>" + escapar(f.nome) + "</strong><small>" + escapar(f.nota || "") + "</small></div>" +
      '<span class="cartao-total">' + escapar(total || "—") + "</span>" +
      "</header>" +
      '<ul class="lista-origens">' + linhas + "</ul>" +
      "</article>"
    );
  }

  function grade(contagens) {
    const usadas = [];
    for (const o of ORIGENS) if (!usadas.includes(o.ferramenta)) usadas.push(o.ferramenta);
    return '<div class="grade-ferramentas">' + usadas.map((s) => cartaoFerramenta(s, contagens)).join("") + "</div>";
  }

  /* Botoes de filtro por origem, agrupados por ferramenta. */
  function filtros(ativo, disponiveis) {
    const permitido = disponiveis && disponiveis.length ? new Set(disponiveis) : null;
    const itens = ORIGENS.filter((o) => !permitido || permitido.has(o.slug));
    const botao = (slug, rotulo, marca, glifo) =>
      '<button class="filtro-origem' + (ativo === slug ? " ativo" : "") + '" data-origem="' + escapar(slug) + '"' +
      (marca ? ' style="--marca:' + marca + '"' : "") + ">" +
      (glifo ? '<span class="filtro-glifo">' + desenho(glifo) + "</span>" : "") +
      "<span>" + escapar(rotulo) + "</span></button>";
    return (
      '<div class="filtros-origem"><span class="filtros-rotulo">Origem</span>' +
      botao("all", "Todas", null, null) +
      itens
        .map((o) => {
          const f = resolverFerramenta(o.ferramenta);
          return botao(o.slug, o.label, f ? f.cor : null, o.glifo);
        })
        .join("") +
      "</div>"
    );
  }

  global.SACOrigens = {
    CANAIS: CANAIS,
    ORDEM_CANAIS: ORDEM_CANAIS,
    FERRAMENTAS: FERRAMENTAS,
    ORIGENS: ORIGENS,
    EVENTOS: EVENTOS,
    PLATAFORMAS_CHECKOUT: PLATAFORMAS_CHECKOUT,
    porEvento: (slug) => POR_EVENTO.get(slug) || null,
    ESTADOS: ESTADOS,
    resolverOrigem: resolverOrigem,
    resolverCanal: resolverCanal,
    resolverFerramenta: resolverFerramenta,
    desenho: desenho,
    seloFerramenta: seloFerramenta,
    iconeCanal: iconeCanal,
    iconesCanais: iconesCanais,
    chipOrigem: chipOrigem,
    selo: selo,
    cartaoFerramenta: cartaoFerramenta,
    grade: grade,
    filtros: filtros
  };
})(typeof window !== "undefined" ? window : globalThis);
