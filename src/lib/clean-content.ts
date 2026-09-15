// Limpeza e normalização do conteúdo das mensagens antes de renderizar.
// Trata mensagens de WhatsApp, Instagram, e-mails (Brevo/Inbound), áudios e mídias.

const EMAIL_FALLBACK = "📧 E-mail recebido";

const BOILERPLATE_PATTERNS: RegExp[] = [
  /voc[êe] [ée] o agente de e-?mail/i,
  /you are the email agent/i,
  /voc[êe] [ée] o assistente virtual/i,
];

export type MediaKind = "audio" | "image" | "video" | "document";
export type MediaItem = { kind: MediaKind; file: string };
export type CleanedMessage = { text: string; media: MediaItem[] };

// Marcador padrão para mídias: [[HMEDIA:<kind>:<filename_or_url>]]
const MEDIA_PATTERN =
  /\[\[HMEDIA:(audio|image|video|document):([^\]]+)\]\]/g;

export function cleanMessage(
  content: string | null | undefined,
  role: string = "user",
  _channel?: string | null,
): CleanedMessage {
  if (!content) return { text: "", media: [] };

  // Extrai a mídia primeiro e remove os marcadores do texto.
  const { text: withoutMedia, media } = extractMedia(content);

  // Tira o wrapper de transcrição de áudio, deixando o texto limpo.
  let text = stripVoiceMarker(withoutMedia);

  // Limpeza de payload de e-mail (caso venha JSON cru ou cabeçalho)
  if (role === "user" && looksLikeEmailPayload(text)) {
    return { text: extractEmailBody(text) ?? EMAIL_FALLBACK, media };
  }

  return { text: text.trim(), media };
}

function extractMedia(content: string): { text: string; media: MediaItem[] } {
  const media: MediaItem[] = [];
  const text = content
    .replace(MEDIA_PATTERN, (_m, kind: MediaKind, file: string) => {
      media.push({ kind, file: file.trim() });
      return "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, media };
}

function stripVoiceMarker(text: string): string {
  // Padrões comuns de transcrição de voz ("O usuário enviou um áudio e disse: ...")
  const pattern =
    /\[\s*(?:the user sent a voice message|o usu[áa]rio enviou (?:um [áa]udio|uma mensagem de voz))[\s\S]*?(?:said|disse(?:ram)?)\s*:?\s*["“]([\s\S]*?)["”]?\s*\]/gi;
  const replaced = text.replace(pattern, (_m, said: string) => said.trim());
  return replaced.trim();
}

function looksLikeEmailPayload(text: string): boolean {
  if (BOILERPLATE_PATTERNS.some((re) => re.test(text))) return true;
  if (/"items"\s*:/.test(text) && /"(?:From|Subject|RawTextBody)"\s*:/.test(text))
    return true;
  if (/"From"\s*:\s*\{/.test(text)) return true;
  return false;
}

function extractEmailBody(text: string): string | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return text;
    const obj = JSON.parse(jsonMatch[0]);

    const item =
      obj && Array.isArray(obj.items) && obj.items.length ? obj.items[0] : obj;
    if (!item || typeof item !== "object") return text;

    const fromRaw = item.From ?? obj.From;
    const fromName =
      typeof fromRaw === "object" && fromRaw
        ? fromRaw.Name || fromRaw.Address || null
        : typeof fromRaw === "string"
          ? fromRaw
          : null;

    const subjectRaw = item.Subject ?? obj.Subject;
    const subject = typeof subjectRaw === "string" ? subjectRaw.trim() : null;

    let body = item.RawTextBody || item.TextBody || item.body || item.content || null;
    if (typeof body === "string") {
      body = body
        .replace(/\r\n/g, "\n")
        .replace(/^[>\s]+.*$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    const header = [
      fromName ? `De: ${fromName}` : null,
      subject ? `Assunto: ${subject}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    if (header && body) return `${header}\n\n${body}`;
    if (body) return body;
    if (header) return header;
    return text;
  } catch {
    return text;
  }
}
