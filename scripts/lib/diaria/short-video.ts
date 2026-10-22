/**
 * scripts/lib/diaria/short-video.ts (#10769)
 *
 * Miolo PURO da publicação do vídeo CURTO (vertical) de cada edição: o recorte
 * de ~2 min do "diar.ia.br comentada" (#10659) que sai como YouTube Shorts e
 * como Reels no Facebook e no Instagram. Sem I/O, sem rede — quem lê arquivo e
 * chama a Graph API é `scripts/publish-shorts.ts`.
 *
 * Decisões do editor que este módulo codifica (#10769, 21-22/10/2026):
 *   - objetivo é levar gente pro canal do YouTube (@diariabr) — o CTA aponta
 *     pro canal, e o link da edição vai junto;
 *   - Reels TODO DIA nas páginas diar.ia.br, VJ Pixel e MemeLab e no perfil
 *     pessoal do editor (Jandig, Teatro vs Game e Criaturas Afetivas só quando o
 *     tema casar — fora da rotina, nunca automático);
 *   - YouTube Shorts: título `{D1} #Shorts`, descrição curta, vídeo
 *     relacionado = o longo da edição, e o link da edição num comentário FIXADO
 *     (link na descrição de Short não é clicável) — fluxo validado à mão no 1º
 *     Short, https://youtube.com/shorts/nhMUtgPPs4U.
 *
 * Por que YouTube Shorts e o perfil pessoal são passos GUIADOS (Chrome, com o
 * editor escolhendo o arquivo) e não API:
 *   - YouTube: sem a auditoria do projeto GCP, todo `videos.insert` sai travado
 *     em `private` (`YOUTUBE_API_PROJECT_AUDITED`, #10659) — o Short não fica
 *     público por API até a auditoria;
 *   - perfil pessoal: a Graph API não publica em perfil de pessoa, só em Página.
 */

import { BEEHIIV_BASE_URL } from "../edition-url.ts";
import { YOUTUBE_TITLE_MAX_CHARS, sanitizeForYouTube, stripInlineMarkdown } from "./youtube-video.ts";

/** Canal do YouTube que os Shorts/Reels divulgam. */
export const DIARIA_YOUTUBE_CHANNEL_URL = "https://www.youtube.com/@diariabr";

/** Convenção de nome do vertical por edição (ao lado do longo, `diaria-comentada-{AAMMDD}.mp4`). */
export function shortVideoFileName(aammdd: string): string {
  return `diaria-comentada-${aammdd}-short.mp4`;
}

/** Registro do que já saiu, por destino (idempotência do `publish-shorts.ts`). */
export const SHORTS_PUBLISHED_FILE = "_internal/06-shorts-published.json";

/** Teto da legenda do Reels no Instagram (2.200 caracteres, doc `ig-user/media`). */
export const INSTAGRAM_CAPTION_MAX_CHARS = 2200;

/** Hashtags fixas — `#Shorts` só no YouTube, onde ajuda a classificação. */
export const SHORTS_HASHTAGS = ["#IA", "#inteligênciaartificial"] as const;

export interface ShortD1Input {
  title: string;
  /** Corpo do D1 (pode ter markdown). */
  body: string;
}

/**
 * 1ª frase do corpo do D1, sem markdown — o "gancho" das legendas curtas.
 * Frase longa demais é cortada na última palavra que cabe (com "…").
 */
export function firstSentence(body: string, maxChars = 220): string {
  const plain = stripInlineMarkdown(body).replace(/\s+/g, " ").trim();
  if (!plain) return "";
  const m = plain.match(/^.+?[.!?](?=\s|$)/);
  const sentence = (m ? m[0] : plain).trim();
  const chars = Array.from(sentence);
  if (chars.length <= maxChars) return sentence;
  const cut = chars.slice(0, maxChars - 1).join("");
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** UTMs de um link do projeto num vídeo curto (`utm_medium=shorts|reels`). */
export function withShortUtm(
  url: string,
  utm: { source: "youtube" | "facebook" | "instagram"; medium: "shorts" | "reels"; campaign: string; content?: string | null },
): string {
  const u = new URL(url);
  u.searchParams.set("utm_source", utm.source);
  u.searchParams.set("utm_medium", utm.medium);
  u.searchParams.set("utm_campaign", utm.campaign);
  if (utm.content) u.searchParams.set("utm_content", utm.content);
  return u.toString();
}

export interface YouTubeShortMetadata {
  title: string;
  description: string;
  /** Texto do comentário a fixar (o link clicável do Short). */
  pinnedComment: string;
}

/** Título `{D1} #Shorts`, truncando só o D1 se passar de 100 caracteres. */
export function buildYouTubeShortTitle(d1Title: string): string {
  const suffix = " #Shorts";
  const base = sanitizeForYouTube(stripInlineMarkdown(d1Title).replace(/\s+/g, " ").trim());
  const room = YOUTUBE_TITLE_MAX_CHARS - suffix.length;
  const chars = Array.from(base);
  const head = chars.length <= room ? base : `${chars.slice(0, room - 1).join("").trimEnd()}…`;
  return `${head}${suffix}`;
}

export function buildYouTubeShortMetadata(input: { aammdd: string; d1: ShortD1Input; editionUrl: string }): YouTubeShortMetadata {
  if (!input.d1.title.trim()) throw new Error("D1 sem título");
  const hook = sanitizeForYouTube(firstSentence(input.d1.body));
  const description = [
    hook,
    "",
    `Vídeo completo e edição: ${BEEHIIV_BASE_URL.replace(/^https:\/\//, "")}`,
    ["#Shorts", ...SHORTS_HASHTAGS].join(" "),
  ]
    .filter((l, i) => i > 0 || l)
    .join("\n")
    .trim();
  const editionLink = withShortUtm(input.editionUrl, { source: "youtube", medium: "shorts", campaign: input.aammdd });
  return {
    title: buildYouTubeShortTitle(input.d1.title),
    description,
    pinnedComment: `Leia a edição completa: ${editionLink}`,
  };
}

export type ReelsPlatform = "facebook" | "instagram";

/**
 * Legenda do Reels. O link em legenda de Reels não é clicável em nenhuma das
 * duas redes, então o CTA principal é o canal escrito por extenso; no Facebook
 * o link da edição vai com UTM (atribuível se alguém copiar), no Instagram a
 * chamada é pro link da bio (padrão dos posts diários).
 */
export function buildReelsCaption(input: {
  platform: ReelsPlatform;
  aammdd: string;
  d1: ShortD1Input;
  editionUrl: string;
  /** `utm_content` da página do Facebook (`page-memelab`…); null = sem tag. */
  utmContent?: string | null;
}): string {
  const title = stripInlineMarkdown(input.d1.title).replace(/\s+/g, " ").trim();
  if (!title) throw new Error("D1 sem título");
  const hook = firstSentence(input.d1.body);
  const channel = `Vídeo completo no YouTube: ${DIARIA_YOUTUBE_CHANNEL_URL.replace(/^https:\/\/www\./, "")}`;
  const edition =
    input.platform === "instagram"
      ? "Edição completa no link da bio."
      : `Edição completa: ${withShortUtm(input.editionUrl, {
          source: "facebook",
          medium: "reels",
          campaign: input.aammdd,
          content: input.utmContent ?? null,
        })}`;
  const caption = [title, hook, [channel, edition].join("\n"), SHORTS_HASHTAGS.join(" ")].filter(Boolean).join("\n\n");
  if (input.platform === "instagram" && Array.from(caption).length > INSTAGRAM_CAPTION_MAX_CHARS) {
    throw new Error(`legenda do Instagram passou de ${INSTAGRAM_CAPTION_MAX_CHARS} caracteres`);
  }
  return caption;
}

/** Configuração `publishing.shorts` em `platform.config.json`. */
export interface ShortsConfig {
  /** Slugs de `publishing.social.facebook.pages` que recebem o Reels (ignora o `enabled` de lá — aquele é o dos posts diários). */
  facebookPages: string[];
  /** Publica o Reels no Instagram da diar.ia.br. */
  instagram: boolean;
}

export const DEFAULT_SHORTS_CONFIG: ShortsConfig = {
  facebookPages: ["diaria", "vjpixel", "memelab"],
  instagram: true,
};

/** Lê e valida `publishing.shorts`; ausente → default (decisão do editor, #10769). */
export function loadShortsConfig(config: unknown): ShortsConfig {
  const raw = (config as any)?.publishing?.shorts;
  if (raw === undefined) return { ...DEFAULT_SHORTS_CONFIG, facebookPages: [...DEFAULT_SHORTS_CONFIG.facebookPages] };
  const pages = raw.facebook_pages;
  if (!Array.isArray(pages) || pages.some((p: unknown) => typeof p !== "string" || !p)) {
    throw new Error("[shorts] publishing.shorts.facebook_pages precisa ser uma lista de slugs (#10769).");
  }
  if (new Set(pages).size !== pages.length) throw new Error("[shorts] slug repetido em publishing.shorts.facebook_pages.");
  if (typeof raw.instagram !== "boolean") throw new Error("[shorts] publishing.shorts.instagram precisa ser boolean.");
  return { facebookPages: [...pages], instagram: raw.instagram };
}

/** Um destino do vídeo curto. `api` = o script publica; `guided` = passo no Chrome com o editor. */
export type ShortDestination =
  | { id: string; kind: "facebook_page"; mode: "api"; slug: string }
  | { id: "instagram"; kind: "instagram"; mode: "api" }
  | { id: "youtube_shorts"; kind: "youtube_shorts"; mode: "guided" }
  | { id: "facebook_profile"; kind: "facebook_profile"; mode: "guided" };

export function facebookDestinationId(slug: string): string {
  return `facebook:${slug}`;
}

/** Todos os destinos da rotina diária, na ordem em que o skill os percorre. */
export function listShortDestinations(cfg: ShortsConfig): ShortDestination[] {
  const out: ShortDestination[] = [{ id: "youtube_shorts", kind: "youtube_shorts", mode: "guided" }];
  for (const slug of cfg.facebookPages) out.push({ id: facebookDestinationId(slug), kind: "facebook_page", mode: "api", slug });
  if (cfg.instagram) out.push({ id: "instagram", kind: "instagram", mode: "api" });
  out.push({ id: "facebook_profile", kind: "facebook_profile", mode: "guided" });
  return out;
}

/** Entrada de `_internal/06-shorts-published.json`. */
export interface ShortPublishedEntry {
  destination: string;
  status: "published" | "scheduled" | "processing";
  /** id do vídeo/mídia na plataforma. */
  id: string;
  url?: string;
  scheduled_at?: string | null;
  at: string;
}

export interface ShortsPublishedFile {
  aammdd: string;
  entries: ShortPublishedEntry[];
}

/** Upsert por destino (o último registro de um destino vence). */
export function upsertShortEntry(file: ShortsPublishedFile, entry: ShortPublishedEntry): ShortsPublishedFile {
  return { ...file, entries: [...file.entries.filter((e) => e.destination !== entry.destination), entry] };
}

/** Destino já publicado/agendado? `processing` não conta — o script reconsulta. */
export function isDestinationDone(file: ShortsPublishedFile, destination: string): boolean {
  return file.entries.some((e) => e.destination === destination && (e.status === "published" || e.status === "scheduled"));
}

/**
 * Horário do Reels no Facebook: 06:00 BRT do dia da edição se ainda não
 * passou (o Facebook aceita agendar de 10 min a 75 dias à frente — abaixo de
 * 10 min, publica na hora); senão, na hora. Mesma regra do vídeo longo
 * (`resolveYouTubeSchedule`).
 */
export function resolveReelsSchedule(targetIso: string, now: Date): { mode: "scheduled"; at: string } | { mode: "immediate" } {
  const t = Date.parse(targetIso);
  if (Number.isNaN(t)) throw new Error(`horário inválido: ${JSON.stringify(targetIso)}`);
  return t - now.getTime() > 10 * 60_000 ? { mode: "scheduled", at: new Date(t).toISOString() } : { mode: "immediate" };
}
