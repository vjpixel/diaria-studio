/**
 * scripts/lib/diaria/youtube-video.ts (#10659)
 *
 * Miolo PURO do publisher do YouTube diário (`scripts/publish-youtube.ts`):
 * deriva metadados do vídeo comentado do D1 a partir da edição e monta o
 * request de `videos.insert` (YouTube Data API v3, resumable upload). Sem I/O,
 * sem rede — quem lê arquivo e (no futuro) chama a API é o CLI.
 *
 * Decisões do editor que este módulo codifica (comentários do #10659,
 * 21/10/2026, 1º vídeo https://youtu.be/QRbXMprk9o0):
 *   - título = título do D1, sem sufixo (decisão do editor, 22/10/2026: o
 *     `| diar.ia.br comentada #{N}` do 1º vídeo saiu);
 *   - descrição = 1ª frase do resumo do D1 + link da edição com UTM nas 2
 *     primeiras linhas (o que aparece antes do "mais", #12077), resto do
 *     resumo, CTA de assinatura
 *     `https://diar.ia.br/?utm_source=youtube&utm_medium=video&utm_campaign={AAMMDD}`
 *     e até 3 hashtags do ator do D1 (#12077);
 *   - 6 tags; idioma pt-BR; "não é conteúdo para crianças";
 *   - agendado pras 06:00 BRT do dia da edição (`publishAt`); se esse horário
 *     já passou ou falta menos de 15 min (#10875), publica na hora (premissa
 *     registrada no plano, issue item 6).
 *
 * Limites da API respeitados aqui (documentação `videos` resource):
 *   - `snippet.title` ≤ 100 caracteres, `snippet.description` ≤ 5000 bytes,
 *     nenhum dos dois aceita `<` nem `>`;
 *   - `snippet.tags` soma ≤ 500 caracteres (tag com espaço conta +2 pelas
 *     aspas que a API adiciona);
 *   - `status.publishAt` só é aceito com `privacyStatus: "private"`.
 */

import { BEEHIIV_BASE_URL } from "../edition-url.ts";
import { resolveEditionScheduledAt, DEFAULT_EDITION_SCHEDULE_HHMM } from "../edition-scheduled-at.ts";

/** Edição do 1º vídeo (#1) da série "diar.ia.br comentada". */
export const YOUTUBE_FIRST_EPISODE_AAMMDD = "261021";

export const YOUTUBE_TITLE_MAX_CHARS = 100;
export const YOUTUBE_DESCRIPTION_MAX_BYTES = 5000;
export const YOUTUBE_TAGS_MAX_CHARS = 500;

/** Categoria 28 = "Science & Technology" (videoCategories, região BR). */
export const YOUTUBE_CATEGORY_ID = "28";

/** Tags fixas da série; a categoria do D1 entra como 6ª quando cabe. */
export const YOUTUBE_BASE_TAGS = [
  "diar.ia.br",
  "inteligência artificial",
  "IA",
  "notícias de IA",
  "diar.ia.br comentada",
] as const;

export const YOUTUBE_UPLOAD_ENDPOINT =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
export const YOUTUBE_THUMBNAIL_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";

/** Recorte mínimo de um destaque que o vídeo precisa (sem acoplar ao parser). */
export interface YouTubeD1Input {
  title: string;
  /** Corpo do D1 (parágrafos antes de "Por que isso importa:"), pode ter markdown. */
  body: string;
  /** URL da fonte primária do D1 — não usar na descrição (#10799). */
  url: string;
  /** Categoria do header `DESTAQUE 1 | CATEGORIA`. */
  category?: string;
}

export interface YouTubeMetadataInput {
  aammdd: string;
  episode: number;
  d1: YouTubeD1Input;
  /** URL pública da edição (sem UTM — a UTM é aplicada aqui). */
  editionUrl: string;
}

export interface YouTubeMetadata {
  title: string;
  description: string;
  tags: string[];
}

/** Remove markdown inline (negrito, itálico, links) e normaliza espaços. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()\s]*\))+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    // Itálico só com delimitador "de palavra": `*x*` vira `x`, mas asterisco
    // literal colado em alfanumérico (`2*3*4`, `a*b`) fica intacto.
    .replace(/(^|[^\p{L}\p{N}*])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}*])/gu, "$1$2")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/[ \t]+/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A API recusa `<` e `>` em título e descrição. */
export function sanitizeForYouTube(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

/** Anexa as UTMs do canal YouTube (`utm_source=youtube&utm_medium=video&utm_campaign={AAMMDD}`). */
export function withYouTubeUtm(url: string, aammdd: string): string {
  const u = new URL(url);
  u.searchParams.set("utm_source", "youtube");
  u.searchParams.set("utm_medium", "video");
  u.searchParams.set("utm_campaign", aammdd);
  return u.toString();
}

/** CTA de assinatura: home do site com as UTMs do canal. */
export function youtubeSubscribeCtaUrl(aammdd: string): string {
  return withYouTubeUtm(`${BEEHIIV_BASE_URL}/`, aammdd);
}

function utcDayNumber(aammdd: string): number {
  if (!/^\d{6}$/.test(aammdd)) throw new Error(`AAMMDD inválido: ${JSON.stringify(aammdd)}`);
  const y = 2000 + Number(aammdd.slice(0, 2));
  const m = Number(aammdd.slice(2, 4));
  const d = Number(aammdd.slice(4, 6));
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/**
 * Número do episódio pela cadência diária (1 vídeo/dia desde 261021 = #1).
 * É uma premissa: dia sem vídeo desalinha a contagem — o CLI aceita
 * `--episode N` explícito e imprime a premissa quando deriva.
 */
export function deriveEpisodeNumber(aammdd: string, firstAammdd: string = YOUTUBE_FIRST_EPISODE_AAMMDD): number {
  const n = utcDayNumber(aammdd) - utcDayNumber(firstAammdd) + 1;
  if (n < 1) {
    throw new Error(`edição ${aammdd} é anterior ao 1º vídeo da série (${firstAammdd})`);
  }
  return n;
}

/** Título = título do D1, sem sufixo, truncado com "…" se passar de 100 caracteres. */
export function buildYouTubeTitle(d1Title: string): string {
  const base = sanitizeForYouTube(stripInlineMarkdown(d1Title).replace(/\s+/g, " ").trim());
  const chars = Array.from(base);
  return chars.length <= YOUTUBE_TITLE_MAX_CHARS ? base : `${chars.slice(0, YOUTUBE_TITLE_MAX_CHARS - 1).join("").trimEnd()}…`;
}

/** Tamanho que a API contabiliza por tag: +2 quando tem espaço (aspas). */
function tagCost(tag: string): number {
  return tag.length + (/\s/.test(tag) ? 2 : 0);
}

/**
 * Normaliza o rótulo da seção do D1 pra tag (#10798): o header vem como
 * `🔬 PESQUISA`, e tag com emoji é ruído na busca. Remove pictogramas, o
 * seletor de variação (U+FE0F), ZWJ e modificadores de tom de pele, colapsa
 * espaços e apara as pontas.
 */
export function normalizeCategoryTag(category?: string): string {
  return (category ?? "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function buildYouTubeTags(category?: string): string[] {
  const tags: string[] = [...YOUTUBE_BASE_TAGS];
  const cat = normalizeCategoryTag(category);
  if (cat && !tags.some((t) => t.toLowerCase() === cat)) tags.push(cat);
  else tags.push("newsletter");
  const out: string[] = [];
  let total = 0;
  for (const t of tags) {
    const cost = tagCost(t) + (out.length > 0 ? 1 : 0);
    if (total + cost > YOUTUBE_TAGS_MAX_CHARS) break;
    out.push(t);
    total += cost;
  }
  return out;
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Ator principal do D1 (#12077): a empresa/produto que a notícia cita primeiro,
 * no título e depois no corpo. Vira o termo da 1ª linha da descrição, as
 * hashtags e a playlist temática. Ordem da tabela = desempate quando dois
 * casam na mesma posição.
 */
export interface YouTubeD1Actor {
  key: string;
  /** Termo para a 1ª linha da descrição (o nome que a busca usa). */
  label: string;
  /** Hashtags do ator, da mais buscada para a menos. */
  hashtags: string[];
  /** Playlist temática (`publishing.youtube.theme_playlists`), quando há uma para o ator. */
  theme?: string;
}

const YOUTUBE_ACTORS: ReadonlyArray<YouTubeD1Actor & { re: RegExp; labelFor?: (m: string) => string }> = [
  { key: "openai", label: "OpenAI", hashtags: ["#ChatGPT", "#OpenAI"], theme: "openai", re: /\b(?:OpenAI|ChatGPT|GPT-?\d[\w.]*|Sora|Sam Altman)\b/i, labelFor: (m) => (/chatgpt/i.test(m) ? "ChatGPT" : "OpenAI") },
  { key: "anthropic", label: "Anthropic", hashtags: ["#Claude", "#Anthropic"], theme: "anthropic", re: /\b(?:Anthropic|Claude)\b/i, labelFor: (m) => (/claude/i.test(m) ? "Claude" : "Anthropic") },
  { key: "google", label: "Google", hashtags: ["#Gemini", "#Google"], theme: "google", re: /\b(?:Google|Gemini|DeepMind|YouTube|Android)\b/i, labelFor: (m) => (/gemini/i.test(m) ? "Gemini" : /deepmind/i.test(m) ? "DeepMind" : "Google") },
  { key: "meta", label: "Meta", hashtags: ["#Meta"], re: /\b(?:Meta|Llama|Instagram|WhatsApp|Facebook|Zuckerberg)\b/ },
  { key: "microsoft", label: "Microsoft", hashtags: ["#Copilot", "#Microsoft"], re: /\b(?:Microsoft|Copilot)\b/i, labelFor: (m) => (/copilot/i.test(m) ? "Copilot" : "Microsoft") },
  { key: "xai", label: "Grok", hashtags: ["#Grok"], re: /\b(?:xAI|Grok)\b/ },
  { key: "deepseek", label: "DeepSeek", hashtags: ["#DeepSeek"], re: /\bDeepSeek\b/i },
  { key: "mistral", label: "Mistral", hashtags: ["#Mistral"], re: /\bMistral\b/ },
  { key: "nvidia", label: "Nvidia", hashtags: ["#Nvidia"], re: /\bNvidia\b/i },
  { key: "apple", label: "Apple", hashtags: ["#Apple"], re: /\b(?:Apple|iPhone|Siri)\b/ },
];

function plainD1(d1: Pick<YouTubeD1Input, "title" | "body">): { title: string; body: string } {
  return { title: stripInlineMarkdown(d1.title), body: stripInlineMarkdown(d1.body) };
}

/** Puro (#12077): ator principal do D1, ou `null`. O título pesa antes do corpo. */
export function detectYouTubeD1Actor(d1: Pick<YouTubeD1Input, "title" | "body">): YouTubeD1Actor | null {
  const { title, body } = plainD1(d1);
  for (const text of [title, body]) {
    let best: { idx: number; order: number; actor: YouTubeD1Actor } | null = null;
    YOUTUBE_ACTORS.forEach((a, order) => {
      const m = a.re.exec(text);
      if (!m) return;
      if (!best || m.index < best.idx || (m.index === best.idx && order < best.order)) {
        const { re: _re, labelFor, ...actor } = a;
        best = { idx: m.index, order, actor: { ...actor, label: labelFor ? labelFor(m[0]) : a.label } };
      }
    });
    if (best) return (best as { actor: YouTubeD1Actor }).actor;
  }
  return null;
}

/** O texto cita o ator por qualquer um dos nomes dele (ex.: "OpenAI" conta para o ChatGPT). */
export function youtubeActorMentioned(key: string, text: string): boolean {
  const a = YOUTUBE_ACTORS.find((x) => x.key === key);
  return a ? a.re.test(stripInlineMarkdown(text)) : false;
}

/** Máximo de hashtags que o YouTube mostra acima do título (#12077). */
export const YOUTUBE_MAX_HASHTAGS = 3;

/** Hashtag a partir de um rótulo livre (sem espaço, sem pontuação; acentos ficam). */
function toHashtag(label: string): string | null {
  const words = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return null;
  return `#${words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("")}`;
}

/**
 * Puro (#12077): até 3 hashtags, `#IA` primeiro, depois as do ator do D1; sem
 * ator, `#InteligênciaArtificial` e a categoria. Sem repetição (caixa ignorada).
 */
export function buildYouTubeHashtags(d1: Pick<YouTubeD1Input, "title" | "body" | "category">): string[] {
  const actor = detectYouTubeD1Actor(d1);
  const cat = toHashtag(normalizeCategoryTag(d1.category));
  const pool = ["#IA", ...(actor ? actor.hashtags : ["#InteligênciaArtificial"]), ...(cat ? [cat] : [])];
  const out: string[] = [];
  for (const h of pool) {
    if (out.length >= YOUTUBE_MAX_HASHTAGS) break;
    if (!out.some((o) => o.toLowerCase() === h.toLowerCase())) out.push(h);
  }
  return out;
}

/** Playlists temáticas que o mapeamento conhece (#12077): ator ou tema. */
export const YOUTUBE_THEMES = ["openai", "google", "anthropic", "brasil", "seguranca"] as const;
export type YouTubeTheme = (typeof YOUTUBE_THEMES)[number];

const BRASIL_RE = /\b(?:Brasil|brasileir[oa]s?|SUS|Anatel|ANPD|STF|Pix)\b/;
const SEGURANCA_RE = /\b(?:golpes?|fraudes?|deepfakes?|vazamentos?|ataques?|hackers?|ciberseguran[çc]a|malware|phishing|vulnerabilidades?|riscos?)\b/i;

/**
 * Puro (#12077): temas do D1 para as playlists, na ordem ator → Brasil →
 * segurança. O ator só entra quando tem playlist (OpenAI, Google, Anthropic).
 */
export function youtubeD1Themes(d1: Pick<YouTubeD1Input, "title" | "body" | "category">): YouTubeTheme[] {
  const { title, body } = plainD1(d1);
  const cat = normalizeCategoryTag(d1.category);
  const text = `${title}\n${body}`;
  const out: YouTubeTheme[] = [];
  const actor = detectYouTubeD1Actor(d1);
  if (actor?.theme && (YOUTUBE_THEMES as readonly string[]).includes(actor.theme)) out.push(actor.theme as YouTubeTheme);
  if (BRASIL_RE.test(text) || /brasil/.test(cat)) out.push("brasil");
  if (/seguran[çc]a|risco/.test(cat) || SEGURANCA_RE.test(title) || SEGURANCA_RE.test(firstSentenceOf(body))) out.push("seguranca");
  return out;
}

/**
 * Separa a 1ª frase do texto (até `.`, `!` ou `?` seguido de espaço/fim, sem atravessar
 * parágrafo) do resto. Sem ponto no 1º parágrafo, a "frase" é o parágrafo inteiro.
 *
 * O corte é feito no texto ORIGINAL, pela posição final do match (#12161): antes a
 * frase era achada na versão com espaços colapsados e o comprimento dela cortava o
 * original, o que perdia ou repetia caracteres quando havia espaço duplo, quebra de
 * linha ou espaço no início. Só a frase devolvida é normalizada.
 */
export function splitFirstSentence(text: string): { sentence: string; rest: string } {
  const m = text.match(/^\s*(?:(?!\n[ \t]*\n)[\s\S])+?[.!?](?=\s|$)/);
  const paragraphEnd = text.search(/\n[ \t]*\n/);
  const end = m ? m[0].length : paragraphEnd >= 0 ? paragraphEnd : text.length;
  return { sentence: text.slice(0, end).replace(/\s+/g, " ").trim(), rest: text.slice(end).trim() };
}

/** 1ª frase do texto (ver `splitFirstSentence`). */
function firstSentenceOf(text: string): string {
  return splitFirstSentence(text).sentence;
}

/** Teto da 1ª linha da descrição (a frase antes do "mais"). */
export const YOUTUBE_DESCRIPTION_LEAD_MAX_BYTES = 600;

function cutToBytes(text: string, budget: number): string {
  if (utf8Bytes(text) <= budget) return text;
  // Corte linear: soma os bytes por code point até o orçamento (menos o "…").
  const limit = budget - utf8Bytes("…");
  let used = 0;
  let cut = "";
  for (const ch of text) {
    const b = utf8Bytes(ch);
    if (used + b > limit) break;
    used += b;
    cut += ch;
  }
  return `${cut.trimEnd()}…`;
}

/**
 * Descrição (#12077): as 2 primeiras linhas são o que aparece antes do "mais"
 * — a 1ª frase do resumo (com o termo do ator na frente quando ela não o cita)
 * e o link da edição. Depois o resto do resumo, o CTA de assinatura e as
 * hashtags (até 3; o YouTube mostra acima do título).
 */
export function buildYouTubeDescription(input: YouTubeMetadataInput): string {
  const { aammdd, d1, editionUrl } = input;
  const editionLine = `Leia a edição completa: ${withYouTubeUtm(editionUrl, aammdd)}`;
  const tail = [`Receba a diar.ia.br de graça todo dia de manhã: ${youtubeSubscribeCtaUrl(aammdd)}`, "", buildYouTubeHashtags(d1).join(" ")].join("\n");
  const summary = sanitizeForYouTube(stripInlineMarkdown(d1.body));
  const actor = detectYouTubeD1Actor(d1);
  const { sentence, rest: afterSentence } = splitFirstSentence(summary);
  // A 1ª frase é a linha antes do "mais": frase sem ponto (o resumo inteiro) é cortada.
  let lead = cutToBytes(sentence, YOUTUBE_DESCRIPTION_LEAD_MAX_BYTES);
  if (lead && actor && !youtubeActorMentioned(actor.key, lead)) lead = `${actor.label}: ${lead}`;
  const rest = lead.endsWith("…") ? "" : afterSentence;
  const head = lead ? `${lead}\n${editionLine}` : editionLine;
  // Orçamento: cabeçalho e cauda inteiros; o resto do resumo é o que encolhe.
  const fixed = utf8Bytes(head) + utf8Bytes(tail) + 4;
  const restCut = rest ? cutToBytes(rest, Math.max(0, YOUTUBE_DESCRIPTION_MAX_BYTES - fixed)) : "";
  const parts = [head, ...(restCut && restCut !== "…" ? [restCut] : []), tail];
  return sanitizeForYouTube(parts.join("\n\n"));
}

export function buildYouTubeMetadata(input: YouTubeMetadataInput): YouTubeMetadata {
  if (!Number.isInteger(input.episode) || input.episode < 1) {
    throw new Error(`episódio inválido: ${input.episode}`);
  }
  const title = buildYouTubeTitle(input.d1.title);
  // Checa o RESULTADO: um título só de markdown ("** **") vira vazio depois do strip, e sem o sufixo
  // antigo a API receberia `snippet.title` vazio.
  if (!title) throw new Error("D1 sem título");
  return {
    title,
    description: buildYouTubeDescription(input),
    tags: buildYouTubeTags(input.d1.category),
  };
}

export type YouTubeScheduleDecision =
  | { mode: "scheduled"; publishAt: string; privacyStatus: "private"; premise: string }
  | { mode: "immediate"; publishAt: null; privacyStatus: "public"; premise: string };

/**
 * Folga mínima entre a decisão do agendamento e o `publishAt` (#10875). O
 * `publishAt` é decidido ANTES do upload; se faltar menos que isso, o envio
 * dos bytes pode terminar com o horário já no passado (o YouTube recusa ou a
 * releitura fica `unknown`) — então publica na hora.
 */
export const YOUTUBE_SCHEDULE_MIN_LEAD_MS = 15 * 60_000;

/**
 * 06:00 BRT do dia da edição (ou `--publish-at` explícito). Se o instante já
 * passou em `now` — ou falta menos que `YOUTUBE_SCHEDULE_MIN_LEAD_MS` (#10875)
 * —, publica na hora; premissa registrada (issue item 6).
 */
export function resolveYouTubeSchedule(
  aammdd: string,
  now: Date,
  publishAtOverride?: string | null,
  minLeadMs: number = YOUTUBE_SCHEDULE_MIN_LEAD_MS,
): YouTubeScheduleDecision {
  const target = publishAtOverride ?? resolveEditionScheduledAt(aammdd, DEFAULT_EDITION_SCHEDULE_HHMM);
  const targetMs = Date.parse(target);
  if (Number.isNaN(targetMs)) throw new Error(`publishAt não é ISO 8601 válido: ${JSON.stringify(target)}`);
  const iso = new Date(targetMs).toISOString();
  const leadMs = targetMs - now.getTime();
  if (leadMs > 0 && leadMs < minLeadMs) {
    return {
      mode: "immediate",
      publishAt: null,
      privacyStatus: "public",
      premise:
        `horário-alvo ${iso} está a ${Math.ceil(leadMs / 60_000)} min de ${now.toISOString()} — menos que a folga de ` +
        `${Math.round(minLeadMs / 60_000)} min para o upload terminar antes dele; publicando na hora (#10875)`,
    };
  }
  if (leadMs > 0) {
    return {
      mode: "scheduled",
      publishAt: iso,
      privacyStatus: "private",
      premise: `agendado para ${iso} (${publishAtOverride ? "--publish-at explícito" : "06:00 BRT do dia da edição"})`,
    };
  }
  return {
    mode: "immediate",
    publishAt: null,
    privacyStatus: "public",
    premise: `horário-alvo ${iso} já passou em ${now.toISOString()} — publicando na hora (issue #10659 item 6)`,
  };
}

/**
 * Sem a auditoria do projeto GCP (pendência do #10659), o vídeo enviado via
 * `videos.insert` PODE sair travado em `private` — restrição de 28/07/2020 no
 * revision history; a página atual de `videos.insert` diz o contrário ("not
 * restricted to private viewing mode"), e o 1º upload real confirma pela
 * releitura. Enquanto não confirmado, o plano trata o pedido como rebaixável
 * (`public` ignorado, `publishAt` sem efeito). Virar `true` depois da
 * auditoria aprovada ou da releitura mostrar que a restrição não vale.
 */
export const YOUTUBE_API_PROJECT_AUDITED = false;

export interface YouTubeEffectiveVisibility {
  /** O que o vídeo de fato fica após o upload (não o que o request pede). */
  privacyStatus: "private" | "public";
  /** `publishAt` que de fato vai virar o vídeo público; null se nenhum. */
  publishAt: string | null;
  /** true quando a falta de auditoria rebaixa o pedido para `private`. */
  auditBlocked: boolean;
}

/** Visibilidade EFETIVA do upload, dado o estado de auditoria do projeto GCP. */
export function resolveEffectiveVisibility(
  schedule: YouTubeScheduleDecision,
  projectAudited: boolean = YOUTUBE_API_PROJECT_AUDITED,
): YouTubeEffectiveVisibility {
  if (projectAudited) {
    return { privacyStatus: schedule.privacyStatus, publishAt: schedule.publishAt, auditBlocked: false };
  }
  return { privacyStatus: "private", publishAt: null, auditBlocked: true };
}

export interface YouTubeInsertRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: {
    snippet: {
      title: string;
      description: string;
      tags: string[];
      categoryId: string;
      defaultLanguage: string;
      defaultAudioLanguage: string;
    };
    status: {
      privacyStatus: "private" | "public";
      publishAt?: string;
      selfDeclaredMadeForKids: false;
      embeddable: true;
    };
  };
}

/**
 * Request de início do resumable upload (`videos.insert`). O header
 * `Authorization` NÃO entra aqui — é responsabilidade de quem envia, e o
 * dry-run nunca deve imprimir credencial.
 */
export function buildYouTubeInsertRequest(
  meta: YouTubeMetadata,
  schedule: YouTubeScheduleDecision,
  video: { contentType?: string; contentLength?: number | null } = {},
): YouTubeInsertRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=UTF-8",
    "X-Upload-Content-Type": video.contentType ?? "video/mp4",
  };
  if (typeof video.contentLength === "number" && video.contentLength > 0) {
    headers["X-Upload-Content-Length"] = String(video.contentLength);
  }
  const status: YouTubeInsertRequest["body"]["status"] = {
    privacyStatus: schedule.privacyStatus,
    selfDeclaredMadeForKids: false,
    embeddable: true,
  };
  if (schedule.mode === "scheduled") status.publishAt = schedule.publishAt;
  return {
    method: "POST",
    url: YOUTUBE_UPLOAD_ENDPOINT,
    headers,
    body: {
      snippet: {
        title: meta.title,
        description: meta.description,
        tags: meta.tags,
        categoryId: YOUTUBE_CATEGORY_ID,
        defaultLanguage: "pt-BR",
        defaultAudioLanguage: "pt-BR",
      },
      status,
    },
  };
}

/** Convenção de nome do arquivo de vídeo por edição (issue item 3). */
export function youtubeVideoFileName(aammdd: string): string {
  return `diaria-comentada-${aammdd}.mp4`;
}

/** Capa 1280x720 aprovada pelo editor (`04-youtube-thumb.jpg`, comentário do #10659). */
export const YOUTUBE_THUMB_FILE = "04-youtube-thumb.jpg";
