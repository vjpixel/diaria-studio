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
 *     pro canal; o link da edição vai na legenda do Facebook (no Instagram,
 *     "link da bio");
 *   - Reels TODO DIA nas páginas diar.ia.br e VJ Pixel (MemeLab saiu, #10790)
 *     e no perfil pessoal do editor. Jandig, Teatro vs Game e Criaturas Afetivas ficam fora
 *     da rotina — só quando o editor pedir, nunca automático;
 *   - YouTube Shorts: título `{D1} #Shorts`, descrição curta, vídeo
 *     relacionado = o longo da edição — fluxo validado à mão no 1º Short,
 *     https://youtube.com/shorts/nhMUtgPPs4U. SEM comentário fixado (#10831):
 *     desde 2023 link em descrição E em comentário de Short não é clicável; o
 *     único caminho clicável é o vídeo relacionado, vinculado depois que o
 *     horizontal publica (#10811);
 *   - horário próprio do vertical (#10831): o horizontal sai às 06:00 junto da
 *     newsletter; o vertical sai num teste de 15 dias úteis alternando 06:30, 08:00 e
 *     12:00 BRT (`resolveShortTime`, config `publishing.shorts.schedule`).
 *
 * Por que YouTube Shorts e o perfil pessoal são passos GUIADOS (Chrome, com o
 * editor escolhendo o arquivo) e não API:
 *   - YouTube: sem a auditoria do projeto GCP, todo `videos.insert` sai travado
 *     em `private` (`YOUTUBE_API_PROJECT_AUDITED`, #10659) — o Short não fica
 *     público por API até a auditoria;
 *   - perfil pessoal: a Graph API não publica em perfil de pessoa, só em Página.
 *
 * LinkedIn e X (#10772, tabela confirmada pelo editor no briefing 261022b): o
 * vertical sobe NATIVO no perfil pessoal do LinkedIn (Videos API, mesmo app e
 * token do `publish-linkedin-personal.ts`) com repost pela página — passo
 * guiado, num horário da grade da página que não cola nos 4 posts do dia — e
 * no X @diariabr via Buffer (MCP, só a skill alcança), com o vídeo por URL
 * pública (R2). O horizontal fica só no YouTube. Threads (conta pessoal +
 * repost) ainda não entrou: falta o token da conta pessoal.
 */

import { BEEHIIV_BASE_URL } from "../edition-url.ts";
import { TWITTER_CHAR_LIMIT, computeTwitterWeightedLength } from "../twitter-weight.ts";
import { THREADS_TEXT_MAX_CHARS } from "../threads-api.ts"; // #10772
import { civilDayNumber, formatCivilDate, parseIsoCivilDate, type CivilDate } from "../social-schedule-rotation.ts";
import {
  DEFAULT_MIN_GAP_MINUTES,
  brtDayWindow,
  instagramCollabAccounts,
  planSlot,
  planSlots,
  slotAccounts,
  socialAccountKey,
  type ScheduledSlot,
  type SlotRule,
} from "../social-slot-planner.ts";
import { YOUTUBE_TITLE_MAX_CHARS, sanitizeForYouTube, stripInlineMarkdown } from "./youtube-video.ts";

/** Canal do YouTube que os Shorts/Reels divulgam. */
export const DIARIA_YOUTUBE_CHANNEL_URL = "https://www.youtube.com/@diariabr";

/** Convenção de nome do vertical por edição (ao lado do longo, `diaria-comentada-{AAMMDD}.mp4`). */
export function shortVideoFileName(aammdd: string): string {
  return `diaria-comentada-${aammdd}-short.mp4`;
}

/**
 * #11265: o corte do Instagram (`_Instagram_` na pasta `Final/` do Drive,
 * #11222) baixado na pasta da edição. É o arquivo que o timer do 300
 * (`scripts/shorts-instagram-timer.ts`) publica pela API; a limpeza do
 * vertical (#11240) o apaga quando o `instagram` fica registrado como
 * `published` ou `scheduled` (`send_unknown` mantém o arquivo, pra conferir).
 */
export function shortInstagramVideoFileName(aammdd: string): string {
  return `diaria-comentada-${aammdd}-short-instagram.mp4`;
}

/**
 * #11265: quem publica o Reels do Instagram com horário futuro.
 *   - `timer-300` (default, decisão do editor 27/10/2026): o timer do 300
 *     (`Diaria-Shorts-Instagram`) roda `publish-shorts.ts --only instagram
 *     --publish --instagram-timer` no horário do vertical e sobe pelo upload
 *     resumível da Graph API, sem URL pública. A rodada do `/diaria-shorts`
 *     devolve `skip_delegated`, como o `linkedin_profile` (#10982).
 *   - `worker-r2` (#10823, opção antiga): sobe o vertical pro R2 e põe o
 *     Reels na fila do Worker `diaria-linkedin-cron`. Exige os 5 secrets do
 *     R2 (habilitado em 27/10/2026 para X/Threads, #10772) e o Worker.
 */
export const INSTAGRAM_BACKENDS = ["timer-300", "worker-r2"] as const;
export type InstagramBackend = (typeof INSTAGRAM_BACKENDS)[number];

export function isInstagramBackend(v: unknown): v is InstagramBackend {
  return typeof v === "string" && (INSTAGRAM_BACKENDS as readonly string[]).includes(v);
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
 * Frase longa demais é cortada na última palavra que cabe (com "…"); se a
 * última palavra começar antes da metade do limite, corta seco no caractere.
 * O fim de frase é o 1º `.`/`!`/`?` seguido de espaço — abreviação ("Dr. X")
 * corta antes; aceitável pra um gancho, e o texto inteiro está no vídeo.
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

/** UTMs de um link do projeto num vídeo curto (`utm_medium=shorts|reels|video`). */
export function withShortUtm(
  url: string,
  utm: {
    source: "youtube" | "facebook" | "instagram" | "linkedin" | "twitter" | "threads";
    medium: "shorts" | "reels" | "video";
    campaign: string;
    content?: string | null;
  },
): string {
  const u = new URL(url);
  u.searchParams.set("utm_source", utm.source);
  u.searchParams.set("utm_medium", utm.medium);
  u.searchParams.set("utm_campaign", utm.campaign);
  if (utm.content) u.searchParams.set("utm_content", utm.content);
  return u.toString();
}

/**
 * Metadados do Short. Sem comentário fixado (#10831): link em comentário de
 * Short não é clicável desde 2023 — o funil clicável é o vídeo relacionado.
 */
export interface YouTubeShortMetadata {
  title: string;
  description: string;
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

export function buildYouTubeShortMetadata(input: { d1: ShortD1Input }): YouTubeShortMetadata {
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
  return { title: buildYouTubeShortTitle(input.d1.title), description };
}

export type ReelsPlatform = "facebook" | "instagram";

/**
 * #11388 (decisão do editor, 27/10/2026, testada à mão na legenda do Reels de
 * 261027): a legenda do Reels diz o que é a diar.ia.br em vez de pressupor que
 * o leitor já conhece a newsletter. Sem "grátis": a oferta não foi confirmada.
 */
export const REELS_NEWSLETTER_SENTENCE = "A diar.ia.br é a newsletter que resume as notícias de IA do dia em 5 minutos.";

/** #11388: CTA do Reels no Instagram, o texto final aprovado pelo editor (o link da bio é o único clicável). */
export const INSTAGRAM_REELS_CTA = `${REELS_NEWSLETTER_SENTENCE} Assine pelo link da bio.`;

/**
 * Legenda do Reels. Tratamos link em legenda de Reels como não clicável nas
 * duas redes (é o comportamento do app hoje). #11388: o CTA explica a
 * newsletter (`REELS_NEWSLETTER_SENTENCE`) e o link do canal do YouTube saiu
 * da legenda. No Instagram a chamada é pro link da bio (`INSTAGRAM_REELS_CTA`);
 * no Facebook, que não tem bio, o link da edição vai com UTM (atribuível se
 * alguém copiar).
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
  const cta =
    input.platform === "instagram"
      ? INSTAGRAM_REELS_CTA
      : `${REELS_NEWSLETTER_SENTENCE} Leia a edição de hoje e assine: ${withShortUtm(input.editionUrl, {
          source: "facebook",
          medium: "reels",
          campaign: input.aammdd,
          content: input.utmContent ?? null,
        })}`;
  const caption = [title, hook, cta, SHORTS_HASHTAGS.join(" ")].filter(Boolean).join("\n\n");
  if (input.platform === "instagram" && Array.from(caption).length > INSTAGRAM_CAPTION_MAX_CHARS) {
    throw new Error(`legenda do Instagram passou de ${INSTAGRAM_CAPTION_MAX_CHARS} caracteres`);
  }
  return caption;
}

/** Plataformas do vertical NATIVO com link clicável no texto (#10772). */
export type ShortLinkPlatform = "linkedin" | "x" | "threads";

/** Teto do texto do post no LinkedIn (`commentary` da Posts API). */
export const LINKEDIN_COMMENTARY_MAX_CHARS = 3000;

/**
 * Texto do post do vertical no LinkedIn pessoal e no X (#10772). Ao contrário
 * da legenda do Reels, o link é clicável nas duas redes: o vídeo completo
 * (horizontal, URL do YouTube de `_internal/05-video-url.txt`; ausente = canal)
 * e a edição com UTM `utm_source={linkedin|twitter}&utm_medium=video&utm_campaign={AAMMDD}`
 * (a fonte do X segue o `utm_source=twitter` dos posts diários, #4295).
 *
 * X: título + vídeo + edição, sem o gancho; título longo é cortado até caber
 * em 280 com URL pesando 23 (`computeTwitterWeightedLength`). Lança se nem o
 * título mínimo couber (não acontece com URL de 23).
 *
 * Threads (perfil pessoal, #10772): `utm_source=threads`; ver `buildThreadsShortText`.
 */
export function buildShortSocialText(input: {
  platform: ShortLinkPlatform;
  aammdd: string;
  d1: ShortD1Input;
  editionUrl: string;
  /** URL do vídeo completo no YouTube; null = link do canal. */
  videoUrl: string | null;
}): string {
  const title = stripInlineMarkdown(input.d1.title).replace(/\s+/g, " ").trim();
  if (!title) throw new Error("D1 sem título");
  const video = input.videoUrl ?? DIARIA_YOUTUBE_CHANNEL_URL;
  const source = input.platform === "x" ? "twitter" : input.platform;
  const edition = withShortUtm(input.editionUrl, { source, medium: "video", campaign: input.aammdd });
  if (input.platform === "linkedin") {
    const text = [title, firstSentence(input.d1.body), `Vídeo completo no YouTube: ${video}`, `Edição completa: ${edition}`, SHORTS_HASHTAGS.join(" ")]
      .filter(Boolean)
      .join("\n\n");
    if (Array.from(text).length > LINKEDIN_COMMENTARY_MAX_CHARS) throw new Error(`texto do LinkedIn passou de ${LINKEDIN_COMMENTARY_MAX_CHARS} caracteres`);
    return text;
  }
  if (input.platform === "threads") return buildThreadsShortText(title, input.d1.body, video, edition);
  const tail = `\n\nVídeo completo: ${video}\nEdição: ${edition}`;
  const chars = Array.from(title);
  for (let n = chars.length; n >= 10; n--) {
    const head = n === chars.length ? title : `${chars.slice(0, n - 1).join("").trimEnd()}…`;
    const text = head + tail;
    if (computeTwitterWeightedLength(text) <= TWITTER_CHAR_LIMIT) return text;
  }
  throw new Error(`texto do X não cabe em ${TWITTER_CHAR_LIMIT} caracteres`);
}

const UTF8 = new TextEncoder();
/** Emoji e os modificadores que o compõem (ZWJ, seletor de variação, tom de pele, keycap). */
const EMOJI_PART_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣]/u;

/**
 * Tamanho do texto como o Threads conta (#10772): 1 por caractere (code point),
 * exceto emoji, que pesa o tamanho em bytes UTF-8 (doc da Meta, posts: "emojis
 * count as their UTF-8 byte length"). Ex.: "🤖" pesa 4.
 */
export function threadsTextLength(text: string): number {
  let n = 0;
  for (const ch of text) n += EMOJI_PART_RE.test(ch) ? UTF8.encode(ch).length : 1;
  return n;
}

/**
 * Texto do vertical no Threads (#10772): título, gancho (1ª frase do D1), vídeo
 * completo e edição, em até 500 caracteres (o Threads conta caractere, URL
 * inteira — mas emoji conta pelo tamanho em BYTES UTF-8, ver `threadsTextLength`).
 * Sem hashtags: no Threads só a 1ª vira tag de tópico. Não cabe →
 * tira o gancho; ainda não cabe → corta o título. Lança se nem o título mínimo couber.
 */
function buildThreadsShortText(title: string, body: string, video: string, edition: string): string {
  const tail = `\n\nVídeo completo no YouTube: ${video}\nEdição completa: ${edition}`;
  const hook = firstSentence(body);
  const withHook = hook ? `${title}\n\n${hook}${tail}` : `${title}${tail}`;
  if (threadsTextLength(withHook) <= THREADS_TEXT_MAX_CHARS) return withHook;
  const chars = Array.from(title);
  for (let n = chars.length; n >= 10; n--) {
    const head = n === chars.length ? title : `${chars.slice(0, n - 1).join("").trimEnd()}…`;
    const text = head + tail;
    if (threadsTextLength(text) <= THREADS_TEXT_MAX_CHARS) return text;
  }
  throw new Error(`texto do Threads não cabe em ${THREADS_TEXT_MAX_CHARS} caracteres`);
}

/** Configuração `publishing.shorts` em `platform.config.json`. */
export interface ShortsConfig {
  /** Slugs de `publishing.social.facebook.pages` que recebem o Reels (ignora o `enabled` de lá — aquele é o dos posts diários). */
  facebookPages: string[];
  /** Publica o Reels no Instagram. */
  instagram: boolean;
  /**
   * Slug de `publishing.social.facebook.pages` cuja conta do Instagram VINCULADA é a autora do Reels
   * (#10790: conta pessoal do editor, ligada à página VJ pixel). `null` = conta da diar.ia.br
   * (`INSTAGRAM_BUSINESS_ACCOUNT_ID`/`INSTAGRAM_ACCESS_TOKEN`).
   */
  instagramAuthorPage: string | null;
  /** Usernames convidados como collab no Reels (#11223: `vjpixel`; antes, #10790: `diar.ia.br`). Máx. 3 (limite da Graph API). */
  instagramCollaborators: string[];
  /** #10772: vídeo nativo no perfil pessoal do LinkedIn (Videos API, token `LINKEDIN_PERSONAL_*`). */
  linkedinProfile: boolean;
  /** #10772: repost do vídeo do perfil pela página diar.ia.br (passo guiado, horário da grade da página). */
  linkedinPageRepost: boolean;
  /** #10772: vídeo no X @diariabr via Buffer (MCP, passo da skill), com o vertical por URL pública (R2). */
  x: boolean;
  /**
   * #10772/#11122: vertical no Threads PESSOAL do editor (`threads_profile`,
   * `scripts/lib/threads-personal-video.ts`), com o vídeo por URL pública (R2).
   * Sem `THREADS_PERSONAL_*` o destino é pulado com aviso (fail-soft).
   */
  threadsProfile: boolean;
  /**
   * #11070: Short pela YouTube Data API (`videos.insert` com `publishAt`, o
   * mesmo publisher do horizontal). Sem `YOUTUBE_*` no ambiente o destino
   * volta a ser o passo guiado no Studio (fail-soft). `false` força o guiado.
   */
  youtubeShortsApi: boolean;
  /**
   * #10982: o vídeo do perfil pessoal do LinkedIn sai pelo timer do `300`
   * (`scripts/shorts-linkedin-profile-timer.ts`), não pela rodada do
   * `/diaria-shorts`. Com `true`, uma rodada sem `--linkedin-timer` pula o
   * `linkedin_profile` (`skip_delegated`): duas máquinas publicando o mesmo
   * vídeo, com o registro ainda não sincronizado, duplicariam o post.
   */
  linkedinProfileViaTimer: boolean;
  /** #11265: quem publica o Reels do Instagram (`InstagramBackend`). */
  instagramBackend: InstagramBackend;
  /**
   * #11223: Reel no perfil PESSOAL do Facebook (passo guiado no Chrome — a
   * Graph API não publica em perfil). `false` tira o destino do plano: o
   * `/diaria-publica-video` não o oferece nem cobra, e a limpeza do vertical
   * (#11240) deixa de esperar por ele. Decisão do editor (27/10/2026): pausado
   * durante a viagem, sem o Neo.
   */
  facebookProfile: boolean;
}

/** Limite de collaborators por mídia na Graph API do Instagram. */
export const INSTAGRAM_MAX_COLLABORATORS = 3;

export const DEFAULT_SHORTS_CONFIG: Readonly<ShortsConfig> = Object.freeze({
  // #10790 (decisão do editor, 22/10/2026): MemeLab fora da rotina.
  facebookPages: Object.freeze(["diaria", "vjpixel"]) as unknown as string[],
  instagram: true,
  // #11223 (decisão do editor, 27/10/2026): autora @diar.ia.br (conta do env), @vjpixel em collab.
  instagramAuthorPage: null,
  instagramCollaborators: Object.freeze(["vjpixel"]) as unknown as string[],
  // #10772 (tabela confirmada no briefing 261022b): LinkedIn pessoal + repost da página, X @diariabr.
  linkedinProfile: true,
  linkedinPageRepost: true,
  x: true,
  // #11122: código pronto e fail-soft até o token do Threads pessoal existir (#10772/#11077).
  threadsProfile: true,
  // #11070: o publishAt publica sozinho mesmo sem a auditoria (medido em 23/10/2026).
  youtubeShortsApi: true,
  // #10982: desligado no código; o platform.config.json liga junto com o timer.
  linkedinProfileViaTimer: false,
  // #11265 (decisão do editor, 27/10/2026): timer no 300, sem R2.
  instagramBackend: "timer-300",
  // #11223: ligado no código; o platform.config.json pausa durante a viagem.
  facebookProfile: true,
});

function defaultShortsConfig(): ShortsConfig {
  return {
    facebookPages: [...DEFAULT_SHORTS_CONFIG.facebookPages],
    instagram: DEFAULT_SHORTS_CONFIG.instagram,
    instagramAuthorPage: DEFAULT_SHORTS_CONFIG.instagramAuthorPage,
    instagramCollaborators: [...DEFAULT_SHORTS_CONFIG.instagramCollaborators],
    linkedinProfile: DEFAULT_SHORTS_CONFIG.linkedinProfile,
    linkedinPageRepost: DEFAULT_SHORTS_CONFIG.linkedinPageRepost,
    x: DEFAULT_SHORTS_CONFIG.x,
    threadsProfile: DEFAULT_SHORTS_CONFIG.threadsProfile,
    youtubeShortsApi: DEFAULT_SHORTS_CONFIG.youtubeShortsApi,
    linkedinProfileViaTimer: DEFAULT_SHORTS_CONFIG.linkedinProfileViaTimer,
    instagramBackend: DEFAULT_SHORTS_CONFIG.instagramBackend,
    facebookProfile: DEFAULT_SHORTS_CONFIG.facebookProfile,
  };
}

/** Booleano opcional do config: ausente = default; qualquer outra coisa que não boolean lança. */
function optionalBool(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new Error(`[shorts] publishing.shorts.${key} precisa ser boolean (#10772).`);
  return v;
}

/** Lê e valida `publishing.shorts`; ausente → default (decisão do editor, #10769/#10790). */
export function loadShortsConfig(config: unknown): ShortsConfig {
  const raw = (config as any)?.publishing?.shorts;
  if (raw === undefined) return defaultShortsConfig();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("[shorts] publishing.shorts precisa ser um objeto (#10769).");
  }
  const pages = raw.facebook_pages;
  if (!Array.isArray(pages) || pages.some((p: unknown) => typeof p !== "string" || !p)) {
    throw new Error("[shorts] publishing.shorts.facebook_pages precisa ser uma lista de slugs (#10769).");
  }
  if (new Set(pages).size !== pages.length) throw new Error("[shorts] slug repetido em publishing.shorts.facebook_pages.");
  if (typeof raw.instagram !== "boolean") throw new Error("[shorts] publishing.shorts.instagram precisa ser boolean.");
  const author = raw.instagram_author_page ?? null;
  if (author !== null && (typeof author !== "string" || !author)) {
    throw new Error("[shorts] publishing.shorts.instagram_author_page precisa ser o slug de uma página ou null (#10790).");
  }
  const collabs = raw.instagram_collaborators ?? [];
  if (!Array.isArray(collabs) || collabs.some((c: unknown) => typeof c !== "string" || !/^[A-Za-z0-9._]{1,30}$/.test(c))) {
    throw new Error("[shorts] publishing.shorts.instagram_collaborators precisa ser uma lista de usernames do Instagram, sem @ (#10790).");
  }
  if (collabs.length > INSTAGRAM_MAX_COLLABORATORS) {
    throw new Error(`[shorts] publishing.shorts.instagram_collaborators aceita no máximo ${INSTAGRAM_MAX_COLLABORATORS} contas.`);
  }
  const linkedinProfile = optionalBool(raw, "linkedin_profile", DEFAULT_SHORTS_CONFIG.linkedinProfile);
  const linkedinPageRepost = optionalBool(raw, "linkedin_page_repost", DEFAULT_SHORTS_CONFIG.linkedinPageRepost);
  const backend = raw.instagram_backend ?? DEFAULT_SHORTS_CONFIG.instagramBackend;
  if (!isInstagramBackend(backend)) {
    throw new Error(`[shorts] publishing.shorts.instagram_backend precisa ser ${INSTAGRAM_BACKENDS.map((b) => `"${b}"`).join(" ou ")} (#11265).`);
  }
  if (linkedinPageRepost && !linkedinProfile) {
    throw new Error("[shorts] publishing.shorts.linkedin_page_repost exige linkedin_profile: o repost é do vídeo do perfil (#10772).");
  }
  return {
    facebookPages: [...pages],
    instagram: raw.instagram,
    instagramAuthorPage: author,
    instagramCollaborators: [...collabs],
    linkedinProfile,
    linkedinPageRepost,
    x: optionalBool(raw, "x", DEFAULT_SHORTS_CONFIG.x),
    threadsProfile: optionalBool(raw, "threads_profile", DEFAULT_SHORTS_CONFIG.threadsProfile),
    youtubeShortsApi: optionalBool(raw, "youtube_shorts_api", DEFAULT_SHORTS_CONFIG.youtubeShortsApi),
    linkedinProfileViaTimer: optionalBool(raw, "linkedin_profile_via_timer", DEFAULT_SHORTS_CONFIG.linkedinProfileViaTimer),
    instagramBackend: backend,
    facebookProfile: optionalBool(raw, "facebook_profile", DEFAULT_SHORTS_CONFIG.facebookProfile),
  };
}

/** Um destino do vídeo curto. `api` = o script publica; `guided` = passo no Chrome com o editor. */
export type ShortDestination =
  | { id: FacebookDestinationId; kind: "facebook_page"; mode: "api"; slug: string }
  | { id: "instagram"; kind: "instagram"; mode: "api" }
  | { id: "youtube_shorts"; kind: "youtube_shorts"; mode: "guided" }
  | { id: "facebook_profile"; kind: "facebook_profile"; mode: "guided" }
  /** #10772: Videos API no perfil pessoal (a Posts API não agenda — publica na hora). */
  | { id: "linkedin_profile"; kind: "linkedin_profile"; mode: "api" }
  /** #10772: repost do vídeo do perfil pela página (sem token de organização local — Chrome). */
  | { id: "linkedin_page_repost"; kind: "linkedin_page_repost"; mode: "guided" }
  /** #10772: Buffer só é alcançável pela skill (MCP); o script prepara texto, horário e URL do vídeo. */
  | { id: "x"; kind: "x"; mode: "guided" }
  /** #11122: Threads API no perfil pessoal (não agenda — publica na hora, como o LinkedIn). */
  | { id: "threads_profile"; kind: "threads_profile"; mode: "api" };

export type FacebookDestinationId = `facebook:${string}`;

export function facebookDestinationId(slug: string): FacebookDestinationId {
  return `facebook:${slug}`;
}

/** Todos os destinos da rotina diária, na ordem em que o skill os percorre. */
export function listShortDestinations(cfg: ShortsConfig): ShortDestination[] {
  const out: ShortDestination[] = [{ id: "youtube_shorts", kind: "youtube_shorts", mode: "guided" }];
  for (const slug of cfg.facebookPages) out.push({ id: facebookDestinationId(slug), kind: "facebook_page", mode: "api", slug });
  if (cfg.instagram) out.push({ id: "instagram", kind: "instagram", mode: "api" });
  if (cfg.linkedinProfile) out.push({ id: "linkedin_profile", kind: "linkedin_profile", mode: "api" });
  if (cfg.linkedinProfile && cfg.linkedinPageRepost) out.push({ id: "linkedin_page_repost", kind: "linkedin_page_repost", mode: "guided" });
  if (cfg.x) out.push({ id: "x", kind: "x", mode: "guided" });
  if (cfg.threadsProfile) out.push({ id: "threads_profile", kind: "threads_profile", mode: "api" });
  if (cfg.facebookProfile) out.push({ id: "facebook_profile", kind: "facebook_profile", mode: "guided" });
  return out;
}

/** Ids válidos de destino pra uma config (pra validar `--only`/`--mark`). */
export function knownDestinationIds(cfg: ShortsConfig): Set<string> {
  return new Set(listShortDestinations(cfg).map((d) => d.id));
}

/** Entrada de `_internal/06-shorts-published.json`. */
export interface ShortPublishedEntry {
  destination: string;
  /**
   * `send_unknown` (#10772): o envio pode ter sido aceito (timeout/5xx na
   * criação do post do LinkedIn, ou no `threads_publish` do Threads, #11122). Conta como feito — re-tentar arriscaria
   * vídeo duplicado no perfil; o editor confere e registra com `--mark`.
   */
  status: "published" | "scheduled" | "send_unknown";
  /** id do vídeo/mídia na plataforma; nos destinos guiados (`--mark`), a própria URL. */
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
  if (!entry.destination) throw new Error("entrada sem destino");
  return { ...file, entries: [...file.entries.filter((e) => e.destination !== entry.destination), entry] };
}

/** Destino já tem registro (publicado ou agendado)? */
export function isDestinationDone(file: ShortsPublishedFile, destination: string): boolean {
  return file.entries.some((e) => e.destination === destination);
}

/**
 * Lê o registro de forma ESTRITA. Um registro quebrado nunca vira "nada
 * publicado": isso republicaria Reels públicos em duplicata. Arquivo de outra
 * edição também é recusado.
 */
export function parseShortsPublishedFile(raw: string, aammdd: string, where = SHORTS_PUBLISHED_FILE): ShortsPublishedFile {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${where}: JSON inválido (${(e as Error).message}) — corrija ou apague à mão, conferindo antes o que já foi publicado`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error(`${where}: sem lista "entries" — corrija à mão antes de publicar (risco de duplicar Reels)`);
  }
  if (parsed.aammdd !== aammdd) throw new Error(`${where}: é da edição ${parsed.aammdd}, não de ${aammdd}`);
  for (const [i, e] of parsed.entries.entries()) {
    if (!e || typeof e.destination !== "string" || !e.destination || typeof e.id !== "string" || !e.id) {
      throw new Error(`${where}: entrada ${i} sem destination/id`);
    }
    if (e.status !== "published" && e.status !== "scheduled" && e.status !== "send_unknown") {
      throw new Error(`${where}: entrada ${i} com status inválido (${e.status})`);
    }
  }
  return { aammdd, entries: parsed.entries };
}

/**
 * Horário do vertical (#10831). O horizontal sai às 06:00 BRT junto da
 * newsletter; o vertical sai em horário PRÓPRIO, num teste de 15 dias úteis que
 * alterna `rotation_times` dia a dia a partir de `rotation_start` (261022 saiu
 * às 12:00, à mão), comparando as visualizações nas primeiras 24 h. Fora da
 * janela `[rotation_start, rotation_end]` vale `default_time`.
 *
 * Premissas registradas (não documentadas na decisão do editor):
 *   - o horário vale pro vertical em TODOS os destinos (Shorts, Reels das
 *     páginas, Instagram, perfil) — em 261022 "tudo foi ajustado à mão pra 12:00";
 *   - a alternância conta dias CORRIDOS, não edições publicadas: dia sem
 *     edição não desloca o horário dos seguintes (plano reconstruível);
 *   - fora da janela, `default_time` = 12:00 (o horário de 261022) até o
 *     editor decidir o vencedor do teste e mudar o config.
 *
 * A regra de grade da #10819 (alinhar com o que já está agendado em outras
 * contas / espaçar na mesma conta) entra por `planShortSlots`, abaixo: durante
 * o teste este horário tem precedência; fora dele, a grade decide.
 */
export interface ShortScheduleConfig {
  rotationTimes: string[];
  rotationStart: CivilDate;
  /** Inclusivo. `null` = sem fim. */
  rotationEnd: CivilDate | null;
  defaultTime: string;
}

const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Decisão do editor de 22/10/2026 (#10831, #10939): 15 dias úteis alternando 06:30/08:00/12:00, de 261026 a 261113 (só há edição de segunda a sexta). */
export const DEFAULT_SHORT_SCHEDULE_RAW = Object.freeze({
  rotation_times: Object.freeze(["06:30", "08:00", "12:00"]),
  rotation_start: "2026-10-26",
  rotation_end: "2026-11-13",
  default_time: "12:00",
});

/** Lê `publishing.shorts.schedule`; ausente → default (#10831). Malformado LANÇA (estragaria o teste em silêncio). */
export function loadShortScheduleConfig(config: unknown): ShortScheduleConfig {
  const raw = (config as any)?.publishing?.shorts?.schedule ?? DEFAULT_SHORT_SCHEDULE_RAW;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("[shorts] publishing.shorts.schedule precisa ser um objeto (#10831).");
  }
  const times = raw.rotation_times;
  if (!Array.isArray(times) || !times.length || times.some((t: unknown) => typeof t !== "string" || !HHMM_RE.test(t))) {
    throw new Error("[shorts] publishing.shorts.schedule.rotation_times precisa ser uma lista não vazia de HH:MM (#10831).");
  }
  if (typeof raw.default_time !== "string" || !HHMM_RE.test(raw.default_time)) {
    throw new Error("[shorts] publishing.shorts.schedule.default_time precisa ser HH:MM (#10831).");
  }
  if (typeof raw.rotation_start !== "string") throw new Error("[shorts] publishing.shorts.schedule.rotation_start precisa ser AAAA-MM-DD (#10831).");
  const start = parseIsoCivilDate(raw.rotation_start, "publishing.shorts.schedule.rotation_start");
  let end: CivilDate | null = null;
  if (raw.rotation_end !== null && raw.rotation_end !== undefined) {
    if (typeof raw.rotation_end !== "string") throw new Error("[shorts] publishing.shorts.schedule.rotation_end precisa ser AAAA-MM-DD ou null (#10831).");
    end = parseIsoCivilDate(raw.rotation_end, "publishing.shorts.schedule.rotation_end");
    if (civilDayNumber(end) < civilDayNumber(start)) throw new Error("[shorts] publishing.shorts.schedule.rotation_end antes de rotation_start.");
  }
  return { rotationTimes: [...times], rotationStart: start, rotationEnd: end, defaultTime: raw.default_time };
}

export interface ShortTime {
  /** HH:MM em BRT, no dia da edição. */
  hhmm: string;
  source: "rotation" | "default";
  /** Explicação curta pra premissa do plano. */
  reason: string;
}

/** Pure: horário (BRT) do vertical da edição `AAMMDD` (#10831). */
export function resolveShortTime(sched: ShortScheduleConfig, aammdd: string): ShortTime {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(aammdd);
  if (!m) throw new Error(`AAMMDD inválido: ${JSON.stringify(aammdd)}`);
  const date = parseIsoCivilDate(`20${m[1]}-${m[2]}-${m[3]}`, "data da edição");
  const day = civilDayNumber(date);
  const start = civilDayNumber(sched.rotationStart);
  const inWindow = day >= start && (sched.rotationEnd === null || day <= civilDayNumber(sched.rotationEnd));
  if (!inWindow) {
    return { hhmm: sched.defaultTime, source: "default", reason: `fora do teste de horário (${formatCivilDate(sched.rotationStart)} a ${sched.rotationEnd ? formatCivilDate(sched.rotationEnd) : "sem fim"}) — horário fixo` };
  }
  const k = day - start;
  const hhmm = sched.rotationTimes[k % sched.rotationTimes.length];
  return { hhmm, source: "rotation", reason: `teste de horário do vertical, dia ${k + 1} (alterna ${sched.rotationTimes.join("/")})` };
}

/** Horário escolhido pra um destino de API do vertical (#10819). */
export interface ShortSlot {
  destination: string;
  /** Chave de conta da grade (`socialAccountKey`). */
  account: string;
  /** Contas em collab (Instagram): o slot também ocupa a grade delas (decisão do editor 261023). */
  alsoAccounts?: string[];
  /** ISO UTC. */
  at: string;
  /** HH:MM BRT. */
  hhmm: string;
  /** `test-schedule` = horário do teste do #10831 mantido; o resto vem do planner. */
  /** `timer-300` (#11265): Instagram pelo timer do 300, sempre no horário do vertical, fora da grade. */
  rule: "test-schedule" | "timer-300" | SlotRule;
  premise: string;
  warning?: string;
}

/** Conta da grade de um destino de API do vertical; guiados não entram (`null`). */
export function shortDestinationAccount(dest: ShortDestination, cfg: Pick<ShortsConfig, "instagramAuthorPage">): string | null {
  if (dest.kind === "facebook_page") return socialAccountKey("facebook", dest.slug);
  if (dest.kind === "instagram") return socialAccountKey("instagram", cfg.instagramAuthorPage ?? "diaria");
  if (dest.kind === "linkedin_profile") return LINKEDIN_PERSONAL_ACCOUNT;
  // X sai pela skill (Buffer), mas o horário (`dueAt`) vem da grade como os destinos de API.
  if (dest.kind === "x") return socialAccountKey("twitter", "diaria");
  if (dest.kind === "threads_profile") return THREADS_PERSONAL_ACCOUNT;
  // O repost tem regra própria (`planLinkedInRepostSlot`); os outros guiados seguem `shortTime`.
  return null;
}

/**
 * Contas em collab de um destino de API do vertical (#10819, decisão do editor
 * 261023): o Reels do Instagram sai na autora com `instagram_collaborators` em
 * collab e aparece no feed deles, então conta como post de cada um. Os outros
 * destinos não têm collab.
 */
export function shortDestinationAlsoAccounts(
  dest: ShortDestination,
  cfg: Pick<ShortsConfig, "instagramAuthorPage"> & Partial<Pick<ShortsConfig, "instagramCollaborators">>,
): string[] {
  if (dest.kind !== "instagram") return [];
  return instagramCollabAccounts(cfg.instagramCollaborators, socialAccountKey("instagram", cfg.instagramAuthorPage ?? "diaria"));
}

/** Conta da grade do perfil pessoal do LinkedIn (o 4º post do `publish-linkedin-personal.ts` e o vertical). */
export const LINKEDIN_PERSONAL_ACCOUNT = socialAccountKey("linkedin", "pessoal");
/** Conta da grade do perfil pessoal do Threads (vertical, #11122). */
export const THREADS_PERSONAL_ACCOUNT = socialAccountKey("threads", "pessoal");
/** Conta da grade da página diar.ia.br no LinkedIn (os posts diários da rotação #10305). */
export const LINKEDIN_PAGE_ACCOUNT = socialAccountKey("linkedin", "diaria");
/** Folga mínima entre o vídeo no perfil e o repost da página. */
export const LINKEDIN_REPOST_MIN_DELAY_MINUTES = 30;

/**
 * Pure (#10772): horário do repost do vertical pela página diar.ia.br. A
 * página já recebe os posts diários da rotação (#10305), então o repost passa
 * pelo `planSlot` na conta da página — espaçamento mínimo de 2 h e picos de
 * uso (#10819) — e nunca antes de `LINKEDIN_REPOST_MIN_DELAY_MINUTES` depois do
 * vídeo do perfil (não existe repost de post que ainda não saiu). Vale também
 * durante o teste de horário do #10831: o repost não é o vertical, é o
 * compartilhamento dele. Sem horário na janela, cai na folga mínima com aviso.
 */
export function planLinkedInRepostSlot(input: { aammdd: string; profileAt: string; grid: readonly ScheduledSlot[] }): ShortSlot {
  const notBefore = new Date(Date.parse(input.profileAt) + LINKEDIN_REPOST_MIN_DELAY_MINUTES * 60_000).toISOString();
  const d = planSlot(input.grid, {
    account: LINKEDIN_PAGE_ACCOUNT,
    window: brtDayWindow(input.aammdd),
    notBefore,
    preferredAt: notBefore,
  });
  if (!d.at) {
    return {
      destination: "linkedin_page_repost",
      account: LINKEDIN_PAGE_ACCOUNT,
      at: notBefore,
      hhmm: brtHHMM(notBefore),
      rule: d.rule,
      premise: d.premise,
      warning: `linkedin_page_repost: a grade da página não achou horário (${d.premise}) — ${brtHHMM(notBefore)} BRT, ${LINKEDIN_REPOST_MIN_DELAY_MINUTES} min depois do perfil`,
    };
  }
  return {
    destination: "linkedin_page_repost",
    account: LINKEDIN_PAGE_ACCOUNT,
    at: d.at,
    hhmm: brtHHMM(d.at),
    rule: d.rule,
    premise: d.premise,
    ...(d.warning ? { warning: `linkedin_page_repost: ${d.warning}` } : {}),
  };
}

const brtHHMM = (iso: string) => new Date(Date.parse(iso) - 3 * 3_600_000).toISOString().slice(11, 16);

/**
 * Pure (#10819): horário de cada destino de API do vertical contra a grade já
 * agendada (`gridFromSocialPublished` + `gridFromShortsPublished`).
 *
 * Premissas (registradas em `premise`; a precedência do teste veio do
 * coordenador da rodada, o resto não veio do editor):
 *   - DURANTE o teste de horário do #10831 (`time.source === "rotation"`) o
 *     horário do teste vale pra todos os destinos: mover um destino tiraria
 *     aquele dia da comparação entre horários. A grade só gera AVISO quando o
 *     horário do teste cai a menos de `DEFAULT_MIN_GAP_MINUTES` de um post da
 *     MESMA conta (colado/empilhado), pro editor decidir à mão;
 *   - FORA do teste (`default_time`), `planSlots` decide por destino com
 *     `preferredAt` = `default_time`, janela 06:00–22:00 BRT do dia da edição e
 *     sem `notBefore` (o plano não depende da hora em que roda; horário que já
 *     passou cai em "publica na hora" no `resolveReelsSchedule`, como antes).
 *     Cada destino planejado entra na grade antes do seguinte;
 *   - destinos guiados (YouTube Shorts, perfil pessoal) seguem `shortTime`: o
 *     skill lê um horário só pra eles;
 *   - o Instagram conta também como post dos collabs (`cfg.instagramCollaborators`,
 *     decisão do editor 261023): o aviso do teste e o espaçamento do planner
 *     olham os posts da autora E os dos collabs (hoje a @vjpixel, #11223).
 */
export function planShortSlots(input: {
  aammdd: string;
  time: ShortTime;
  /** ISO do `time.hhmm` no dia da edição. */
  timeAt: string;
  destinations: readonly ShortDestination[];
  cfg: Pick<ShortsConfig, "instagramAuthorPage"> & Partial<Pick<ShortsConfig, "instagramCollaborators">>;
  grid: readonly ScheduledSlot[];
}): ShortSlot[] {
  const api = input.destinations
    .map((d) => ({ dest: d, account: shortDestinationAccount(d, input.cfg), also: shortDestinationAlsoAccounts(d, input.cfg) }))
    .filter((x): x is { dest: ShortDestination; account: string; also: string[] } => x.account !== null);
  const withAlso = (also: string[]) => (also.length ? { alsoAccounts: also } : {});

  if (input.time.source === "rotation") {
    const t = Date.parse(input.timeAt);
    return api.map(({ dest, account, also }) => {
      const mine = new Set([account, ...also]);
      const close = input.grid
        .filter((s) => slotAccounts(s).some((a) => mine.has(a)) && Math.abs(Date.parse(s.at) - t) < DEFAULT_MIN_GAP_MINUTES * 60_000)
        .map((s) => brtHHMM(s.at));
      const slot: ShortSlot = {
        destination: dest.id,
        account,
        ...withAlso(also),
        at: new Date(t).toISOString(),
        hhmm: input.time.hhmm,
        rule: "test-schedule",
        premise: `teste de horário do vertical (#10831) tem precedência sobre a grade (#10819)`,
      };
      if (close.length) {
        slot.warning =
          `${dest.id}: o horário do teste (${input.time.hhmm} BRT) fica a menos de ${DEFAULT_MIN_GAP_MINUTES} min de post da mesma conta${also.length ? ` (ou de ${also.join(", ")}, em collab)` : ""} ` +
          `(${[...new Set(close)].join(", ")} BRT) — mantido por causa do teste; mova à mão se não quiser colado`;
      }
      return slot;
    });
  }

  const window = brtDayWindow(input.aammdd);
  const decisions = planSlots(
    input.grid,
    api.map(({ account, also }) => ({ account, ...withAlso(also), window, preferredAt: input.timeAt })),
  );
  return api.map(({ dest, account, also }, i) => {
    const d = decisions[i];
    if (!d.at) {
      return {
        destination: dest.id,
        account,
        ...withAlso(also),
        at: new Date(Date.parse(input.timeAt)).toISOString(),
        hhmm: input.time.hhmm,
        rule: d.rule,
        premise: d.premise,
        warning: `${dest.id}: a grade não achou horário (${d.premise}) — mantido ${input.time.hhmm} BRT`,
      };
    }
    return {
      destination: dest.id,
      account,
      ...withAlso(also),
      at: d.at,
      hhmm: brtHHMM(d.at),
      rule: d.rule,
      premise: d.premise,
      ...(d.warning ? { warning: `${dest.id}: ${d.warning}` } : {}),
    };
  });
}

/**
 * Agendar ou publicar já: o Facebook só aceita agendar de 10 min a 75 dias à
 * frente. Com menos de 10 min de folga (ou já passado), na hora.
 */
export function resolveReelsSchedule(targetIso: string, now: Date): { mode: "scheduled"; at: string } | { mode: "immediate" } {
  const t = Date.parse(targetIso);
  if (Number.isNaN(t)) throw new Error(`horário inválido: ${JSON.stringify(targetIso)}`);
  return t - now.getTime() > 10 * 60_000 ? { mode: "scheduled", at: new Date(t).toISOString() } : { mode: "immediate" };
}

/**
 * Teto da API de Reels de Página (`/{page-id}/video_reels`): 90 s. Vídeo
 * maior vai pelo endpoint de vídeo da Página (`/{page-id}/videos`), que o
 * Facebook exibe como Reel quando é vertical.
 */
export const FACEBOOK_REELS_API_MAX_SECONDS = 90;

/**
 * Duração (s) de um MP4 lida do átomo `moov/mvhd`, sem ffprobe. Devolve null
 * se não achar (arquivo truncado, contêiner não-MP4) — o caller decide o
 * fallback. Só lê cabeçalhos de caixa; não decodifica nada.
 */
export function mp4DurationSeconds(buf: Buffer): number | null {
  const findBox = (start: number, end: number, type: string): { start: number; end: number } | null => {
    let off = start;
    while (off + 8 <= end) {
      let size = buf.readUInt32BE(off);
      const t = buf.toString("latin1", off + 4, off + 8);
      let header = 8;
      if (size === 1) {
        if (off + 16 > end) return null;
        size = Number(buf.readBigUInt64BE(off + 8));
        header = 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < header || off + size > end) return null;
      if (t === type) return { start: off + header, end: off + size };
      off += size;
    }
    return null;
  };
  const moov = findBox(0, buf.length, "moov");
  if (!moov) return null;
  const mvhd = findBox(moov.start, moov.end, "mvhd");
  if (!mvhd) return null;
  const version = buf.readUInt8(mvhd.start);
  const timescaleOff = mvhd.start + (version === 1 ? 20 : 12);
  const durationOff = timescaleOff + 4;
  if (durationOff + (version === 1 ? 8 : 4) > mvhd.end) return null;
  const timescale = buf.readUInt32BE(timescaleOff);
  const duration = version === 1 ? Number(buf.readBigUInt64BE(durationOff)) : buf.readUInt32BE(durationOff);
  if (!timescale) return null;
  return duration / timescale;
}

/**
 * Teto MEDIDO do Reels pela Content Publishing API do Instagram (#10893): em
 * 22/10/2026 a conta @vjpixel aceitou 35 s e 40 s e recusou 42 s em diante no
 * rupload (`400 ProcessingFailedError`), e a rota `video_url` deu container
 * `ERROR` 2207076 com o vertical de 113,9 s — apesar da doc pública falar em
 * 3 s–15 min. A causa do lado da Meta segue em aberto; o teto é configurável
 * por conta (`publishing.shorts.instagram_api_max_seconds_by_account`, #10916)
 * e `null` desliga, pra sumir sem deploy quando a Meta liberar. Este é o
 * fallback quando o config não diz nada.
 */
export const INSTAGRAM_REELS_API_MAX_SECONDS = 40;

/** Contas do Instagram que a fila do Worker sabe publicar (`ig_account`, #10823). */
export type WorkerInstagramAccount = "diaria" | "vjpixel";

export const INSTAGRAM_ENV_ACCOUNT_KEY: WorkerInstagramAccount = "diaria";

/**
 * #11390: rota do Reels postado à mão (Passo B3b do `/diaria-publica-video`,
 * Chrome ou app), a que o editor usa: @vjpixel é o AUTOR e a @diar.ia.br entra
 * como colaboradora. É o inverso da rota da API (autora @diar.ia.br com a
 * @vjpixel em collab, #11223, `instagram_author_page`/`instagram_collaborators`).
 * Enquanto o convite de collab está pendente, o post só aparece no perfil do
 * autor, então o `--confirm-instagram` procura também nele (`authorPage` = slug
 * de `publishing.social.facebook.pages` cuja conta vinculada é a @vjpixel).
 */
export const INSTAGRAM_CHROME_ROUTE = {
  authorUsername: "vjpixel",
  authorPage: "vjpixel",
  collaboratorUsername: "diar.ia.br",
} as const;

/** #11390: a rota do B3b em texto, pros avisos e alarmes (nunca "como a autora"). */
export function instagramChromeRouteText(): string {
  return `como @${INSTAGRAM_CHROME_ROUTE.authorUsername} (autor), com a @${INSTAGRAM_CHROME_ROUTE.collaboratorUsername} como colaboradora`;
}

/**
 * Qualquer slug de página pode ser autora; as contas que o Worker conhece
 * (`WorkerInstagramAccount`) são o caso que importa. `string & {}` mantém o
 * autocomplete das duas sem fechar o tipo.
 */
export type InstagramAccountKey = WorkerInstagramAccount | (string & {});

/**
 * Chave da conta do Instagram no mapa de tetos (#10916): o slug de
 * `instagram_author_page`, ou `diaria` quando a autora é `null` (a conta da
 * diar.ia.br, `INSTAGRAM_BUSINESS_ACCOUNT_ID`/`INSTAGRAM_ACCESS_TOKEN`). Mesma
 * convenção da fila do Worker (`ig_account`, #10823).
 */
export function instagramAccountKey(authorPage: string | null): InstagramAccountKey {
  return authorPage ?? INSTAGRAM_ENV_ACCOUNT_KEY;
}

function validMaxSeconds(v: unknown, field: string): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(`[shorts] publishing.shorts.${field} precisa ser um número de segundos > 0 ou null (#10893/#10916).`);
  }
  return v;
}

/**
 * Teto de duração do Reels pela API para a conta que publica (#10916). O teto
 * é POR CONTA: a @vjpixel aceita 40 s e recusa 42 s (#10893, 22/10/2026). Na
 * @diar.ia.br as medições divergem — sintéticos de até 55 s passaram em 23/10
 * (#10916), mas um sintético de 40 s (22/10) e o vertical REAL de 49,9 s (27/10)
 * foram recusados —, então o config usa 30 s, o maior valor sem recusa
 * registrada (#11281). Os valores vivem no config, não aqui. Ordem:
 *   1. `publishing.shorts.instagram_api_max_seconds_by_account[chave]`, com a
 *      chave de `instagramAccountKey(authorPage)`;
 *   2. `publishing.shorts.instagram_api_max_seconds` (legado, vale pra
 *      qualquer conta);
 *   3. `INSTAGRAM_REELS_API_MAX_SECONDS` (40 s).
 * Em 1 e 2, `null` desliga o teto (a API decide). Valor inválido LANÇA, em
 * QUALQUER entrada do mapa (não só na da conta ativa): um teto quebrado
 * mandaria o Reels pro rupload que já sabemos que falha, ou tiraria da API um
 * vídeo que caberia — e um typo na conta inativa não pode esperar a troca de
 * autora pra aparecer.
 */
export function loadInstagramApiMaxSeconds(config: unknown, authorPage: string | null): number | null {
  return resolveInstagramApiMaxSeconds(config, authorPage).maxSeconds;
}

/** De onde veio o teto (#10916): pra premissa quando o mapa existe e não tem a conta. */
export interface InstagramApiMaxSecondsResolution {
  maxSeconds: number | null;
  key: InstagramAccountKey;
  source: "by_account" | "legacy" | "default";
  /** O mapa por conta existe (mesmo que sem esta conta). */
  hasMap: boolean;
}

export function resolveInstagramApiMaxSeconds(config: unknown, authorPage: string | null): InstagramApiMaxSecondsResolution {
  const key = instagramAccountKey(authorPage);
  const shorts = (config as any)?.publishing?.shorts;
  if (!shorts || typeof shorts !== "object") return { maxSeconds: INSTAGRAM_REELS_API_MAX_SECONDS, key, source: "default", hasMap: false };
  const map = shorts.instagram_api_max_seconds_by_account;
  const hasMap = map !== undefined;
  if (hasMap) {
    if (map === null || typeof map !== "object" || Array.isArray(map)) {
      throw new Error("[shorts] publishing.shorts.instagram_api_max_seconds_by_account precisa ser um objeto {conta: segundos} (#10916).");
    }
    for (const [k, v] of Object.entries(map)) validMaxSeconds(v, `instagram_api_max_seconds_by_account.${k}`);
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      return { maxSeconds: validMaxSeconds(map[key], `instagram_api_max_seconds_by_account.${key}`), key, source: "by_account", hasMap };
    }
  }
  if ("instagram_api_max_seconds" in shorts) {
    return { maxSeconds: validMaxSeconds(shorts.instagram_api_max_seconds, "instagram_api_max_seconds"), key, source: "legacy", hasMap };
  }
  return { maxSeconds: INSTAGRAM_REELS_API_MAX_SECONDS, key, source: "default", hasMap };
}

/**
 * Pure (#10916): premissa quando o mapa por conta existe mas não tem a chave
 * da autora — o teto que valeu veio do legado ou do default, e isso tem que
 * aparecer no log em vez de passar calado. null = nada a declarar.
 */
export function instagramApiMaxSecondsPremise(r: InstagramApiMaxSecondsResolution): string | null {
  if (!r.hasMap || r.source === "by_account") return null;
  const value = r.maxSeconds === null ? "sem teto" : `${r.maxSeconds} s`;
  const from =
    r.source === "legacy"
      ? "publishing.shorts.instagram_api_max_seconds (legado, global)"
      : `o default INSTAGRAM_REELS_API_MAX_SECONDS (${INSTAGRAM_REELS_API_MAX_SECONDS} s)`;
  return `teto do Reels pela API: ${value}, de ${from} — a conta "${r.key}" não está em publishing.shorts.instagram_api_max_seconds_by_account (#10916)`;
}

/**
 * Pure (#10893): o vertical cabe no Reels pela API do Instagram? Duração
 * desconhecida (`mp4DurationSeconds` null) segue pela API — o teto é medido,
 * não documentado, e travar o destino por falta de leitura seria pior; o
 * caller avisa. Acima do teto o Instagram vira passo GUIADO — pelo
 * instagram.com no Claude in Chrome (Passo 3b do /diaria-shorts, com a versão
 * comprimida que o `--publish` gera, #10915) ou no app — registrado com
 * `--confirm-instagram` (lê a mídia pela API) ou `--mark instagram=URL`. Nunca
 * um corte automático do vídeo: recortar uma versão ≤ teto muda o conteúdo e
 * é decisão editorial (corpo da #10893).
 */
export function instagramReelsApiFit(
  durationSeconds: number | null,
  maxSeconds: number | null,
  /** Rótulo legível da conta que publica (#10916), só pro texto do motivo; ausente = "nesta conta". */
  accountLabel?: string,
): { fits: true; unknown: boolean } | { fits: false; reason: string } {
  if (maxSeconds === null) return { fits: true, unknown: durationSeconds === null };
  if (durationSeconds === null) return { fits: true, unknown: true };
  if (durationSeconds <= maxSeconds) return { fits: true, unknown: false };
  return {
    fits: false,
    reason:
      `o vertical tem ${durationSeconds.toFixed(1)} s e a API do Instagram recusa Reels acima de ~${maxSeconds} s ${accountLabel ? `na conta ${accountLabel}` : "nesta conta"} ` +
      `(rupload 400 ProcessingFailedError / 2207076, #10893; teto por conta em publishing.shorts.instagram_api_max_seconds_by_account, #10916)`,
  };
}

/** Qual endpoint do Facebook usar pra este vídeo. */
export function facebookUploadRoute(durationSeconds: number | null): "video_reels" | "videos" {
  // Duração desconhecida → `videos`, que aceita qualquer duração (o `video_reels` recusaria >90 s depois do upload).
  return durationSeconds !== null && durationSeconds <= FACEBOOK_REELS_API_MAX_SECONDS ? "video_reels" : "videos";
}
