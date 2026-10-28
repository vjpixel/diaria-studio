/**
 * scripts/lib/diaria/d1-video-link.ts (#10772)
 *
 * Miolo PURO do "link do vídeo do dia no post do D1". Sem I/O, sem rede.
 *
 * Decisão do editor (22/10/2026, #10772): no LinkedIn, no X e no Threads não
 * entra vídeo nativo — entra o LINK do vídeo do YouTube no próprio post do D1,
 * sem post separado, em 4 destinos:
 *   - LinkedIn (página diar.ia.br): 1º comentário do post do D1 (o corpo
 *     continua sem link, #595);
 *   - X (@diariabr): link do YouTube como 1º link do texto curto do D1 (o X
 *     monta o card de prévia com o primeiro link);
 *   - Threads (diar.ia.br): link no texto curto do D1;
 *   - Facebook (página diar.ia.br): linha com o link no post do D1.
 *
 * Dois momentos possíveis:
 *   1. a URL do vídeo já existe quando o post do D1 é montado (Stage 5) → o
 *      link entra direto no texto (X, Threads, Facebook). Arquivo-fonte:
 *      `_internal/05-video-url.txt` (`D1_VIDEO_URL_FILE`), gravado por
 *      `scripts/link-video-d1.ts --save`;
 *   2. a URL chega depois → editar o post ainda agendado, ou comentar/
 *      responder no post já publicado. `planD1VideoLink` decide qual, por
 *      destino; a EXECUÇÃO dessas ações ainda não existe (ver #10772).
 */

/** Arquivo com a URL do vídeo do dia, relativo ao diretório da edição. */
export const D1_VIDEO_URL_FILE = "_internal/05-video-url.txt";

/** Rótulo da linha do link. Premissa do #10772 (a issue não fixa o texto). */
export const VIDEO_LINK_LABEL = "Assista no YouTube:";

/** Destinos aprovados no #10772. */
export type D1VideoLinkDestination = "linkedin" | "twitter" | "threads" | "facebook";
export const D1_VIDEO_LINK_DESTINATIONS: readonly D1VideoLinkDestination[] = [
  "linkedin",
  "twitter",
  "threads",
  "facebook",
];

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Extrai o id de 11 caracteres de uma URL de vídeo do YouTube (`watch?v=`,
 * `youtu.be/`, `/shorts/`, `/live/`, `/embed/`; hosts `www.`/`m.`). `null`
 * para qualquer outra coisa — nunca adivinha.
 */
export function extractYouTubeVideoId(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = u.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "m.youtube.com") {
    if (u.pathname === "/watch") {
      id = u.searchParams.get("v");
    } else {
      const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/);
      id = m ? m[1] : null;
    }
  }
  return id && YOUTUBE_ID_RE.test(id) ? id : null;
}

/**
 * Normaliza para `https://youtu.be/{id}` — a forma mais curta (conta no limite
 * do Threads; no X qualquer URL pesa 23). Lança se não for vídeo do YouTube.
 */
export function normalizeYouTubeVideoUrl(raw: string): string {
  const id = extractYouTubeVideoId(raw);
  if (!id) {
    throw new Error(`URL não é de vídeo do YouTube: ${JSON.stringify(raw)} (#10772)`);
  }
  return `https://youtu.be/${id}`;
}

/** Linha do link, igual em todos os destinos. */
export function videoLinkLine(videoUrl: string): string {
  return `${VIDEO_LINK_LABEL} ${videoUrl}`;
}

/** Texto do 1º comentário no post do D1 da página do LinkedIn. */
export function buildLinkedInVideoComment(videoUrl: string): string {
  return videoLinkLine(videoUrl);
}

const URL_IN_LINE_RE = /https?:\/\/\S+/;

/** `true` se o texto já cita o vídeo (mesmo id, qualquer forma de URL). */
export function textHasVideoLink(text: string, videoUrl: string): boolean {
  const id = extractYouTubeVideoId(videoUrl);
  if (!id) return false;
  const urls = text.match(/https?:\/\/\S+/g) ?? [];
  return urls.some((u) => extractYouTubeVideoId(u.replace(/[).,;!?]+$/, "")) === id);
}

/**
 * Insere a linha do vídeo como parágrafo próprio ANTES da 1ª linha que tem
 * URL — o link do vídeo vira o 1º link do texto (requisito do X, #10772). Sem
 * URL no texto, entra no fim. Idempotente: texto que já cita o vídeo volta
 * igual.
 */
export function insertVideoLinkLine(text: string, videoUrl: string): string {
  if (textHasVideoLink(text, videoUrl)) return text;
  const line = videoLinkLine(videoUrl);
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => URL_IN_LINE_RE.test(l));
  if (idx === -1) return `${text.replace(/\s+$/, "")}\n\n${line}`;
  const before = lines.slice(0, idx).join("\n").replace(/\s+$/, "");
  const after = lines.slice(idx).join("\n");
  return before ? `${before}\n\n${line}\n\n${after}` : `${line}\n\n${after}`;
}

export type InjectVideoLinkResult =
  /** `droppedHashtags`: o link só coube sem a(s) linha(s) final(is) de hashtags (#11402). */
  | { injected: true; text: string; droppedHashtags: boolean }
  | { injected: false; text: string; reason: string };

/** Linha feita só de hashtags (`#OpenAI #GPT61`, `#Segurança`). */
const HASHTAG_ONLY_LINE_RE = /^\s*#[\p{L}\p{N}_]+(?:\s+#[\p{L}\p{N}_]+)*\s*$/u;

/**
 * Remove as linhas de hashtags do FIM do texto (e o espaço em branco que
 * sobra). Hashtag no meio do texto fica. Sem linha de hashtags no fim, o texto
 * volta igual.
 */
export function stripTrailingHashtagLines(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1].trim() === "" || HASHTAG_ONLY_LINE_RE.test(lines[end - 1]))) end--;
  if (end === lines.length) return text;
  // Só linhas em branco no fim, sem hashtag: nada a tirar.
  if (!lines.slice(end).some((l) => HASHTAG_ONLY_LINE_RE.test(l))) return text;
  return lines.slice(0, end).join("\n").replace(/\s+$/, "");
}

/**
 * Versão com teto: insere o link só se o texto resultante couber em
 * `measure(text) <= limit`. Não coube com o texto inteiro → tenta de novo
 * sem as hashtags do fim (#11402: na 261028 o D1 do X ficou com 287 de 280 e
 * o link, que é o objetivo do post, caiu inteiro; as hashtags são a parte de
 * menor valor do texto curto). Nem assim coube → devolve o texto ORIGINAL com
 * o motivo — nunca derruba o post do D1 por causa do link.
 */
export function injectVideoLinkWithinLimit(
  text: string,
  videoUrl: string,
  limit: number,
  measure: (t: string) => number = (t) => t.length,
): InjectVideoLinkResult {
  if (textHasVideoLink(text, videoUrl)) return { injected: false, text, reason: "texto já cita o vídeo" };
  const next = insertVideoLinkLine(text, videoUrl);
  const size = measure(next);
  if (size <= limit) return { injected: true, text: next, droppedHashtags: false };

  const withoutHashtags = stripTrailingHashtagLines(text);
  let leanNote = "";
  if (withoutHashtags !== text) {
    const lean = insertVideoLinkLine(withoutHashtags, videoUrl);
    const leanSize = measure(lean);
    if (leanSize <= limit) return { injected: true, text: lean, droppedHashtags: true };
    leanNote = `; sem as hashtags, ${leanSize}`;
  }
  return {
    injected: false,
    text,
    reason: `com o link do vídeo o texto ficaria com ${size} chars${leanNote} (limite ${limit}) — link fica para depois (#10772)`,
  };
}

/** Parse do conteúdo de `_internal/05-video-url.txt` (vazio → null). */
export function parseD1VideoUrlFile(content: string): string | null {
  const first = content.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  return normalizeYouTubeVideoUrl(first);
}

// ── Plano pós-agendamento ────────────────────────────────────────────────

/** Subconjunto de `PostEntry` (`social-published-store.ts`) que o plano lê. */
export interface D1PostEntryLike {
  platform: string;
  destaque: string;
  subtype?: string;
  page?: string;
  status: string;
  scheduled_at: string | null;
  url?: string | null;
  [key: string]: unknown;
}

export type D1VideoLinkAction =
  /** Post do D1 ainda agendado com folga: editar o texto/payload antes do disparo. */
  | "edit_scheduled"
  /**
   * Comentar/responder no post do D1: ele já saiu, sai em menos de
   * `minLeadMs`, ou é o LinkedIn (link sempre no 1º comentário, #595).
   */
  | "comment_after"
  /** Texto do post do D1 já leva o link (injetado no Stage 5). */
  | "already_in_post"
  /** Sem post do D1 registrado (canal pulado, falhou ou ainda não rodou). */
  | "no_post";

export interface D1VideoLinkStep {
  destination: D1VideoLinkDestination;
  action: D1VideoLinkAction;
  /**
   * Texto a aplicar: post editado (edit_scheduled — `null` se o texto atual
   * não foi passado em `postTexts`; aí vale `link_line` inserida antes do 1º
   * link) ou o comentário/resposta (comment_after).
   */
  text: string | null;
  /** Linha do link (`videoLinkLine`), igual em todo destino. */
  link_line: string;
  scheduled_at: string | null;
  post_url: string | null;
  reason: string;
}

/** Folga mínima para editar um post agendado em vez de responder depois dele. */
export const D1_VIDEO_EDIT_MIN_LEAD_MS = 10 * 60 * 1000;

function isD1MainEntry(e: D1PostEntryLike, destination: D1VideoLinkDestination): boolean {
  if (e.platform !== destination || e.destaque !== "d1") return false;
  if ((e.subtype ?? "main") !== "main") return false;
  // Facebook: só a página diar.ia.br (decisão do #10772); entrada sem `page` é ela.
  if (destination === "facebook" && (e.page ?? "diaria") !== "diaria") return false;
  return e.status === "scheduled" || e.status === "published" || e.status === "draft";
}

/**
 * Decide, por destino, o que fazer com o link do vídeo depois que os posts do
 * D1 já foram agendados/publicados. `postTexts` (opcional) é o texto atual do
 * post do D1 por destino — quando dado e já com o link, a ação é
 * `already_in_post`; sem ele, a checagem usa só o que o registro guarda.
 */
export function planD1VideoLink(input: {
  videoUrl: string;
  entries: readonly D1PostEntryLike[];
  now: Date;
  postTexts?: Partial<Record<D1VideoLinkDestination, string | null>>;
  minLeadMs?: number;
}): D1VideoLinkStep[] {
  const minLead = input.minLeadMs ?? D1_VIDEO_EDIT_MIN_LEAD_MS;
  const nowMs = input.now.getTime();
  const link_line = videoLinkLine(input.videoUrl);
  return D1_VIDEO_LINK_DESTINATIONS.map((destination): D1VideoLinkStep => {
    // Última entrada vence (re-publicação grava de novo no fim do arquivo).
    const entry = [...input.entries].reverse().find((e) => isD1MainEntry(e, destination)) ?? null;
    if (!entry) {
      return {
        destination,
        link_line,
        action: "no_post",
        text: null,
        scheduled_at: null,
        post_url: null,
        reason: "sem post do D1 agendado/publicado em 06-social-published.json",
      };
    }
    const postUrl = typeof entry.url === "string" ? entry.url : null;
    const currentText = input.postTexts?.[destination] ?? null;
    if (destination !== "linkedin" && currentText && textHasVideoLink(currentText, input.videoUrl)) {
      return {
        destination,
        link_line,
        action: "already_in_post",
        text: null,
        scheduled_at: entry.scheduled_at,
        post_url: postUrl,
        reason: "o texto do post já leva o link do vídeo",
      };
    }
    const atMs = entry.scheduled_at ? Date.parse(entry.scheduled_at) : NaN;
    const pending = entry.status !== "published" && Number.isFinite(atMs) && atMs > nowMs;
    // LinkedIn: o corpo segue sem link (#595) — o link é sempre o 1º
    // comentário, que só existe depois do disparo.
    if (destination === "linkedin") {
      return {
        destination,
        link_line,
        action: "comment_after",
        text: buildLinkedInVideoComment(input.videoUrl),
        scheduled_at: entry.scheduled_at,
        post_url: postUrl,
        reason: pending
          ? `1º comentário logo após o disparo (${entry.scheduled_at})`
          : "post já saiu: 1º comentário no post do D1",
      };
    }
    if (pending && atMs - nowMs >= minLead) {
      return {
        destination,
        link_line,
        action: "edit_scheduled",
        text: currentText ? insertVideoLinkLine(currentText, input.videoUrl) : null,
        scheduled_at: entry.scheduled_at,
        post_url: postUrl,
        reason: "post agendado com folga: editar o texto antes do disparo",
      };
    }
    return {
      destination,
      link_line,
      action: "comment_after",
      text: videoLinkLine(input.videoUrl),
      scheduled_at: entry.scheduled_at,
      post_url: postUrl,
      reason:
        destination === "facebook"
          ? "post já saiu (ou sai em menos de 10 min): comentar no post do D1"
          : "post já saiu (ou sai em menos de 10 min): responder ao post do D1",
    };
  });
}
