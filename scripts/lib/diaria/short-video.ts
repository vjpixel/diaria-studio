/**
 * scripts/lib/diaria/short-video.ts (#10769)
 *
 * Miolo PURO da publicação do vídeo CURTO (vertical) de cada edição: o recorte
 * de ~2 min do "diar.ia.br comentada" (#10659) que sai como YouTube Shorts e
 * como Reels no Facebook e no Instagram. Sem I/O, sem rede — quem lê arquivo e
 * chama a Graph API é `scripts/publish-shorts.ts`.
 *
 * Decisões do editor que este módulo codifica (#10769, 21-22/10/2026):
 *   - objetivo é levar gente pro canal do YouTube (@diariabr); no Instagram o
 *     CTA manda pro "link da bio". Desde #11617 (29/10/2026) nenhum texto do
 *     vertical mostra link (nem a edição com UTM, nem o vídeo completo, nem o
 *     domínio solto). Exceção do #12465 (08/11/2026): nas contas PESSOAIS
 *     (página VJ Pixel, perfil pessoal do Facebook, LinkedIn e Threads) o
 *     texto cita o perfil da diar.ia.br daquela rede (`diariaFollowLine`).
 *     Exceção do #12735 (10/11/2026): LinkedIn, X e Facebook levam o link do
 *     horizontal da edição (`shortHorizontalRoute`); TikTok, Instagram e
 *     Threads chegam a ele pelo link da bio (`diar.ia.br/video`);
 *   - Reels TODO DIA nas páginas diar.ia.br e VJ Pixel (MemeLab saiu, #10790)
 *     e no perfil pessoal do editor. Jandig, Teatro vs Game e Criaturas Afetivas ficam fora
 *     da rotina — só quando o editor pedir, nunca automático;
 *   - YouTube Shorts: título = o do D1 (sem `#Shorts` desde #12463; a tag
 *     fica na descrição), descrição curta, vídeo
 *     relacionado = o longo da edição — fluxo validado à mão no 1º Short,
 *     https://youtube.com/shorts/nhMUtgPPs4U. SEM comentário fixado (#10831):
 *     desde 2023 link em descrição E em comentário de Short não é clicável; o
 *     único caminho clicável é o vídeo relacionado, vinculado depois que o
 *     horizontal publica (#10811);
 *   - horário próprio do vertical (#10831, #12250): o horizontal sai às 06:00
 *     junto da newsletter; o vertical sai em horário FIXO POR DESTINO — o
 *     YouTube Shorts às 06:30 e os outros destinos às 12:00 BRT
 *     (`resolveShortTime(sched, aammdd, destino)`, config
 *     `publishing.shorts.schedule.by_destination` + `default_time`). O teste
 *     rotativo 06:30/08:00/12:00 (261026 a 261106) foi encerrado no #12250.
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

import { TWITTER_CHAR_LIMIT, computeTwitterWeightedLength } from "../twitter-weight.ts";
import { THREADS_TEXT_MAX_CHARS } from "../threads-api.ts"; // #10772
import { civilDayNumber, formatCivilDate, parseIsoCivilDate, type CivilDate } from "../social-schedule-rotation.ts";
import {
  DEFAULT_MIN_GAP_MINUTES,
  brtDayWindow,
  instagramCollabAccounts,
  planSlot,
  slotAccounts,
  socialAccountKey,
  type ScheduledSlot,
  type SlotRule,
} from "../social-slot-planner.ts";
import { DEFAULT_EDITION_SCHEDULE_HHMM } from "../edition-scheduled-at.ts";
import { buildYouTubeTitle, sanitizeForYouTube, stripInlineMarkdown } from "./youtube-video.ts";
import type { ShortCoverRecord } from "./short-cover.ts";
import { videoLinkLine } from "./d1-video-link.ts"; // #12735
import { SHORT_FIRST_FRAME_COVER_DEFAULT_MS, SHORT_FIRST_FRAME_COVER_MAX_MS, SHORT_FIRST_FRAME_COVER_MIN_MS } from "./short-first-frame-cover.ts"; // #12100

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
 *     --publish --instagram-timer` no horário do vertical; na @diar.ia.br o
 *     vídeo vai ao R2 e o container sai por `video_url` (#11355). A rodada do `/diaria-shorts`
 *     devolve `skip_delegated`, como o `linkedin_profile` (#10982).
 *   - `worker-r2` (#10823, opção antiga): sobe o vertical pro R2 e põe o
 *     Reels na fila do Worker `diaria-linkedin-cron`. Exige os 5 secrets do
 *     R2, que existem desde 27/10/2026 (#10772); o editor manteve o
 *     `timer-300` mesmo assim (#11411).
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

/** Hashtags fixas. `#Shorts` só na descrição do YouTube, nunca no título (#12463). */
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

/**
 * Metadados do Short. Sem comentário fixado (#10831): link em comentário de
 * Short não é clicável desde 2023 — o funil clicável é o vídeo relacionado.
 * Sem link nem domínio na descrição (#11617): gancho + citação do horizontal
 * por título (#12191) + hashtags.
 */
export interface YouTubeShortMetadata {
  title: string;
  description: string;
}

/**
 * Título do Short = título do D1 (ou o `--title` do corte), SEM sufixo
 * (#12463, decisão do editor de 08/11/2026): `#Shorts` vai só na descrição
 * (`buildYouTubeShortMetadata`). O YouTube classifica o Short pelo formato,
 * não pela tag, e no feed do celular ` #Shorts` gastava 8 dos ~40 caracteres
 * visíveis. Mesmo texto do horizontal (`buildYouTubeTitle`): o teto de 100
 * caracteres vale para o título inteiro. Os Shorts publicados até 08/11/2026
 * têm `{D1} #Shorts` no título; o reconhecimento de Short já no canal aceita
 * as duas formas (`matchEditionVideo`, `kind: "short"`).
 */
export function buildYouTubeShortTitle(d1Title: string): string {
  return buildYouTubeTitle(d1Title);
}

/**
 * #12191 (#12077 item 4): prefixo da linha que cita o horizontal do dia na
 * descrição do Short. Só texto: link em descrição de Short não é clicável
 * (#10831) e nenhum texto do vertical leva link (#11617). O caminho clicável
 * segue sendo o vídeo relacionado (#10811).
 */
export const SHORT_HORIZONTAL_CITATION_PREFIX = "Vídeo completo no canal:";

/** Pure (#12191): a linha da citação, ou `""` com título vazio. */
export function buildShortHorizontalCitation(horizontalTitle: string | null | undefined): string {
  const title = sanitizeForYouTube(stripInlineMarkdown(horizontalTitle ?? "").replace(/\s+/g, " ").trim());
  return title ? `${SHORT_HORIZONTAL_CITATION_PREFIX} “${title}”` : "";
}

/**
 * Pure (#12191): título do horizontal que o Short cita. O registro do upload
 * (`_internal/05-youtube-published.json`, que guarda o título real, inclusive
 * o de `--title`, #11739) vence; sem ele (o vertical pode subir antes do
 * horizontal), o título que o `publish-youtube.ts` deriva do D1
 * (`buildYouTubeTitle`). Edição marcada sem vídeo (`no-video.json`, #11125)
 * não tem horizontal: `null`, sem citação.
 */
export function resolveShortHorizontalTitle(input: {
  d1Title: string;
  recordTitle?: string | null;
  noVideo?: boolean;
}): string | null {
  if (input.noVideo) return null;
  const fromRecord = input.recordTitle?.trim();
  if (fromRecord) return fromRecord;
  const derived = buildYouTubeTitle(input.d1Title);
  return derived || null;
}

export function buildYouTubeShortMetadata(input: { d1: ShortD1Input; horizontalTitle?: string | null }): YouTubeShortMetadata {
  if (!input.d1.title.trim()) throw new Error("D1 sem título");
  const hook = sanitizeForYouTube(firstSentence(input.d1.body));
  const citation = buildShortHorizontalCitation(input.horizontalTitle);
  const description = [hook, citation, ["#Shorts", ...SHORTS_HASHTAGS].join(" ")].filter(Boolean).join("\n\n");
  return { title: buildYouTubeShortTitle(input.d1.title), description };
}

export type ReelsPlatform = "facebook" | "instagram";

// ─── Perfil da diar.ia.br nas contas pessoais (#12465) ──────────────────────

/**
 * #12465 (decisão do editor de 08/11/2026): o post do vídeo nas contas
 * PESSOAIS do editor leva a menção (ou o link) do perfil da diar.ia.br naquela
 * mesma rede — o botão Seguir ao lado do vídeo segue o editor, e o card de
 * encerramento pede "Siga a diar.ia.br". Revisa o #11617 (nenhum texto do
 * vertical mostra link) só para o perfil da diar.ia.br: menção nativa onde a
 * API aceita (LinkedIn, `@[Nome](urn:li:organization:ID)`, mantida pelo
 * `toLittleText`; Threads, `@handle`) e URL do perfil onde não há menção
 * confirmada pela API (Facebook: a tag de página na descrição de vídeo da
 * Graph API não foi medida). Fonte única dos perfis: `publishing.shorts.
 * diaria_profiles` no `platform.config.json`.
 *
 * LinkedIn: a menção só vira link quando o texto entre colchetes é o nome
 * EXATO da página, e o efeito de um nome divergente na Posts API (4xx, que
 * derrubaria o vídeo do perfil pessoal, ou texto puro) não foi medido (review
 * do PR #12489). Por isso a menção só sai com `urn` configurado E
 * `mention_verified: true` (o editor conferiu o nome atual da página); fora
 * disso a linha cai na URL do perfil, que publica em qualquer caso.
 */
export interface DiariaProfiles {
  linkedin: { name: string; urn: string | null; url: string; mentionVerified: boolean };
  threads: { handle: string | null; url: string };
  facebook: { url: string };
}

export const DEFAULT_DIARIA_PROFILES: Readonly<DiariaProfiles> = Object.freeze({
  linkedin: { name: "diar.ia.br", urn: "urn:li:organization:110742958", url: "https://www.linkedin.com/company/diar.ia.br/", mentionVerified: false },
  threads: { handle: "diar.ia.br", url: "https://www.threads.com/@diar.ia.br" },
  facebook: { url: "https://www.facebook.com/diar.ia.br" },
});

/** Slug da página diar.ia.br em `publishing.social.facebook.pages` (as outras são de terceiros/pessoais). */
export const DIARIA_FACEBOOK_PAGE_SLUG = "diaria";

/** URL sem `https://` e sem `www.` nem barra final, como entra no texto. */
function shortProfileUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

/**
 * Pure (#12465): a linha "Siga a diar.ia.br" do post do vídeo no destino, ou
 * `null` nos destinos que já publicam pela conta da diar.ia.br (YouTube,
 * página diar.ia.br, Instagram @diar.ia.br, X @diariabr, TikTok @diar.ia.br).
 */
export function diariaFollowLine(destination: string, profiles: DiariaProfiles = DEFAULT_DIARIA_PROFILES): string | null {
  if (destination === "linkedin_profile") {
    const p = profiles.linkedin;
    return p.urn && p.mentionVerified === true ? `Siga @[${p.name}](${p.urn})` : `Siga a diar.ia.br: ${shortProfileUrl(p.url)}`;
  }
  if (destination === "threads_profile") {
    const p = profiles.threads;
    return p.handle ? `Siga @${p.handle}` : `Siga a diar.ia.br: ${shortProfileUrl(p.url)}`;
  }
  if (destination === "facebook_profile" || (destination.startsWith("facebook:") && destination !== `facebook:${DIARIA_FACEBOOK_PAGE_SLUG}`)) {
    return `Siga a diar.ia.br: ${shortProfileUrl(profiles.facebook.url)}`;
  }
  return null;
}

/** Lê `publishing.shorts.diaria_profiles` (ausente = `DEFAULT_DIARIA_PROFILES`); campo inválido lança. */
export function loadDiariaProfiles(raw: unknown): DiariaProfiles {
  if (raw === undefined) return structuredClone(DEFAULT_DIARIA_PROFILES) as DiariaProfiles;
  const bad = (why: string) => new Error(`[shorts] publishing.shorts.diaria_profiles: ${why} (#12465).`);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw bad("precisa ser um objeto");
  const r = raw as Record<string, any>;
  const url = (v: unknown, key: string): string => {
    if (typeof v !== "string" || !/^https:\/\/\S+$/.test(v)) throw bad(`${key} precisa ser uma URL https`);
    return v;
  };
  const d = DEFAULT_DIARIA_PROFILES;
  const li = r.linkedin ?? {};
  const th = r.threads ?? {};
  const fb = r.facebook ?? {};
  const urn = li.urn === undefined ? d.linkedin.urn : li.urn;
  if (urn !== null && (typeof urn !== "string" || !/^urn:li:organization:\d+$/.test(urn))) throw bad("linkedin.urn precisa ser urn:li:organization:ID ou null");
  const name = li.name ?? d.linkedin.name;
  if (typeof name !== "string" || !name.trim() || /[[\]()]/.test(name)) throw bad("linkedin.name precisa ser o nome da página, sem colchetes nem parênteses");
  const mentionVerified = li.mention_verified ?? d.linkedin.mentionVerified;
  if (typeof mentionVerified !== "boolean") throw bad("linkedin.mention_verified precisa ser true ou false");
  const handle = th.handle === undefined ? d.threads.handle : th.handle;
  if (handle !== null && (typeof handle !== "string" || !/^[A-Za-z0-9._]{1,30}$/.test(handle))) throw bad("threads.handle precisa ser o username sem @ ou null");
  return {
    linkedin: { name, urn, url: url(li.url ?? d.linkedin.url, "linkedin.url"), mentionVerified },
    threads: { handle, url: url(th.url ?? d.threads.url, "threads.url") },
    facebook: { url: url(fb.url ?? d.facebook.url, "facebook.url") },
  };
}

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
 * no Facebook, que não tem bio, fica só a frase da newsletter: o link da
 * edição com UTM saiu da legenda (#11617, pedido do editor: post do vídeo
 * sem link no texto). Exceção (#12465): na página VJ Pixel e no perfil
 * pessoal, `follow` acrescenta o perfil da diar.ia.br. #12735: no Facebook
 * (páginas e perfil pessoal), `horizontalLink` acrescenta o horizontal da
 * edição depois do gancho; no Instagram é ignorado (o caminho é a bio).
 */
export function buildReelsCaption(input: { platform: ReelsPlatform; d1: ShortD1Input; follow?: string | null; horizontalLink?: string | null }): string {
  const title = stripInlineMarkdown(input.d1.title).replace(/\s+/g, " ").trim();
  if (!title) throw new Error("D1 sem título");
  const hook = firstSentence(input.d1.body);
  const cta = input.platform === "instagram" ? INSTAGRAM_REELS_CTA : REELS_NEWSLETTER_SENTENCE;
  // #12735: o horizontal da edição só no Facebook (a legenda do Reels no Instagram não tem link clicável; lá o caminho é a bio).
  const link = input.platform === "facebook" ? shortHorizontalLinkLine(input.horizontalLink) : "";
  // #12465: `follow` = `diariaFollowLine(destino)`, só nas contas pessoais (página VJ Pixel, perfil pessoal).
  const caption = [title, hook, link, cta, input.follow ?? "", SHORTS_HASHTAGS.join(" ")].filter(Boolean).join("\n\n");
  if (input.platform === "instagram" && Array.from(caption).length > INSTAGRAM_CAPTION_MAX_CHARS) {
    throw new Error(`legenda do Instagram passou de ${INSTAGRAM_CAPTION_MAX_CHARS} caracteres`);
  }
  return caption;
}

/** #11515: teto da legenda do TikTok (2.200 caracteres). */
export const TIKTOK_CAPTION_MAX_CHARS = 2200;
/** #11515: teto do `metadata.tiktok.title` que a Buffer repassa ao TikTok. */
export const TIKTOK_TITLE_MAX_CHARS = 90;

/**
 * #11515: legenda e título do vertical no TikTok. A legenda segue a do Reels
 * do Facebook (título, gancho, a frase da newsletter e as hashtags), sem link:
 * a legenda do TikTok não tem link clicável e o link da bio ainda não existe
 * (conta pessoal, sem o campo Site). Sem `#Shorts`, que é só do YouTube.
 */
export function buildTikTokPost(input: { d1: ShortD1Input }): { caption: string; title: string } {
  const title = stripInlineMarkdown(input.d1.title).replace(/\s+/g, " ").trim();
  if (!title) throw new Error("D1 sem título");
  const hook = firstSentence(input.d1.body);
  const caption = [title, hook, REELS_NEWSLETTER_SENTENCE, SHORTS_HASHTAGS.join(" ")].filter(Boolean).join("\n\n");
  if (Array.from(caption).length > TIKTOK_CAPTION_MAX_CHARS) throw new Error(`legenda do TikTok passou de ${TIKTOK_CAPTION_MAX_CHARS} caracteres`);
  const chars = Array.from(title);
  const shortTitle = chars.length <= TIKTOK_TITLE_MAX_CHARS ? title : `${chars.slice(0, TIKTOK_TITLE_MAX_CHARS - 1).join("").trimEnd()}…`;
  return { caption, title: shortTitle };
}

/** Plataformas do vertical NATIVO no feed (#10772): LinkedIn pessoal, X e Threads pessoal. */
export type ShortLinkPlatform = "linkedin" | "x" | "threads";

/** Teto do texto do post no LinkedIn (`commentary` da Posts API). */
export const LINKEDIN_COMMENTARY_MAX_CHARS = 3000;

/**
 * Texto do post do vertical no LinkedIn pessoal, no X e no Threads pessoal
 * (#10772). Sem link no texto (#11617, pedido do editor em 29/10/2026): o
 * vídeo sobe nativo nas três redes, então o texto não precisa de URL pra gerar
 * card. Até o #11617 o texto levava o vídeo completo do YouTube e a edição com
 * `utm_medium=video`; essa atribuição por UTM deixou de existir.
 *
 * LinkedIn: título, gancho (1ª frase do D1) e hashtags.
 * X e Threads: título e gancho no teto da rede (`fitShortText`).
 *
 * #12465: `follow` (de `diariaFollowLine`) entra no perfil pessoal (LinkedIn,
 * Threads) antes das hashtags e nunca é cortado; o X sai pela @diariabr e não
 * leva a linha.
 *
 * #12735: `horizontalLink` (o `05-video-url.txt` da edição) volta a pôr o
 * horizontal no texto do LinkedIn e do X (`shortHorizontalLinkLine`), depois
 * do gancho; no X ele nunca é cortado (sai o gancho antes). O Threads ignora
 * o link: lá o caminho é a bio (`shortHorizontalRoute`).
 */
export function buildShortSocialText(input: { platform: ShortLinkPlatform; d1: ShortD1Input; follow?: string | null; horizontalLink?: string | null }): string {
  const title = stripInlineMarkdown(input.d1.title).replace(/\s+/g, " ").trim();
  if (!title) throw new Error("D1 sem título");
  const hook = firstSentence(input.d1.body);
  const follow = input.follow ?? "";
  // #12735: o horizontal da edição entra no LinkedIn e no X; o Threads pessoal segue sem link (o caminho é a bio).
  const link = input.platform === "threads" ? "" : shortHorizontalLinkLine(input.horizontalLink);
  if (input.platform === "linkedin") {
    const text = [title, hook, link, follow, SHORTS_HASHTAGS.join(" ")].filter(Boolean).join("\n\n");
    if (Array.from(text).length > LINKEDIN_COMMENTARY_MAX_CHARS) throw new Error(`texto do LinkedIn passou de ${LINKEDIN_COMMENTARY_MAX_CHARS} caracteres`);
    return text;
  }
  if (input.platform === "threads") return fitShortText(title, hook, threadsTextLength, THREADS_TEXT_MAX_CHARS, "Threads", follow);
  return fitShortText(title, hook, computeTwitterWeightedLength, TWITTER_CHAR_LIMIT, "X", [link, follow].filter(Boolean).join("\n\n"));
}

// ─── Caminho do vertical até o horizontal (#12735) ──────────────────────────

/**
 * #12735 (decisão do editor no briefing do overnight 261110e, 10/11/2026):
 * "link na bio + legenda". Revisa o #11617 (nenhum texto do vertical leva
 * link) para o horizontal DA edição, só onde a rede aceita link clicável no
 * texto do post:
 *   - `caption`: LinkedIn pessoal, X, páginas do Facebook e perfil pessoal do
 *     Facebook levam `Assista no YouTube: https://youtu.be/{id}` lido de
 *     `_internal/05-video-url.txt`;
 *   - `bio`: TikTok, Instagram e Threads pessoal não têm link clicável na
 *     legenda (Threads por decisão anterior, #11617); o caminho é o link da
 *     bio, `diar.ia.br/video?utm_source={rede}` (Worker do apex, sempre o
 *     horizontal mais recente). A troca da bio é passo manual do editor;
 *   - `related_video`: o YouTube Shorts leva ao horizontal pelo vídeo
 *     relacionado (#10811); link na descrição de Short não é clicável (#10831);
 *   - `repost`: o repost da página do LinkedIn herda o texto do perfil.
 */
export type ShortHorizontalRoute = "caption" | "bio" | "related_video" | "repost";

/** Destino → caminho até o horizontal (`facebook:{slug}` vale para toda página). */
export function shortHorizontalRoute(destination: string): ShortHorizontalRoute {
  if (destination === "youtube_shorts") return "related_video";
  if (destination === "linkedin_page_repost") return "repost";
  if (destination === "tiktok" || destination === "instagram" || destination === "threads_profile") return "bio";
  return "caption";
}

/** Linha do link do horizontal na legenda (`""` sem link). Mesmo rótulo dos posts do D1 (`videoLinkLine`, #10772). */
export function shortHorizontalLinkLine(url: string | null | undefined): string {
  const u = (url ?? "").trim();
  return u ? videoLinkLine(u) : "";
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
 * Título + gancho no teto da rede (#10772/#11617). X: 280 ponderado
 * (`computeTwitterWeightedLength`); Threads: 500, com emoji pesando o tamanho
 * em BYTES UTF-8 (`threadsTextLength`). Sem hashtags: no Threads só a 1ª vira
 * tag de tópico, e no X elas tirariam espaço do gancho. Não cabe → tira o
 * gancho; ainda não cabe → corta o título. Lança se nem o título mínimo couber.
 */
function fitShortText(title: string, hook: string, measure: (t: string) => number, max: number, label: string, tail = ""): string {
  // #12465: `tail` (a linha "Siga @diar.ia.br") fica sempre no fim; sai o gancho, depois encurta o título.
  const withTail = (body: string) => (tail ? `${body}\n\n${tail}` : body);
  if (hook) {
    const withHook = withTail(`${title}\n\n${hook}`);
    if (measure(withHook) <= max) return withHook;
  }
  const chars = Array.from(title);
  for (let n = chars.length; n >= 10; n--) {
    const head = withTail(n === chars.length ? title : `${chars.slice(0, n - 1).join("").trimEnd()}…`);
    if (measure(head) <= max) return head;
  }
  throw new Error(`texto do ${label} não cabe em ${max} caracteres`);
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
   * #12100 opção 2 (decisão do editor de 11/11/2026): ms da capa
   * (`04-youtube-short-capa.jpg`) nos primeiros frames do vertical enviado ao
   * YouTube Shorts (arredondado ao frame), para o frame automático do feed
   * (`oar2.jpg`) cair nela.
   * Arquivo derivado em diretório temporário: o vertical da edição não muda e
   * os outros destinos seguem com ele. `null` = desligado
   * (`publishing.shorts.youtube_first_frame_cover: false`).
   */
  youtubeFirstFrameCoverMs: number | null;
  /**
   * #10982: o vídeo do perfil pessoal do LinkedIn sai pelo timer do `300`
   * (`scripts/shorts-linkedin-profile-timer.ts`), não pela rodada do
   * `/diaria-shorts`. Com `true`, uma rodada sem `--linkedin-timer` pula o
   * `linkedin_profile` (`skip_delegated`): duas máquinas publicando o mesmo
   * vídeo, com o registro ainda não sincronizado, duplicariam o post.
   */
  linkedinProfileViaTimer: boolean;
  /**
   * #11410: o vertical do Threads PESSOAL sai pelo timer do `300`
   * (`scripts/shorts-threads-profile-timer.ts`, task
   * `Diaria-Shorts-Threads-Profile`), não pela rodada do
   * `/diaria-publica-video`: a Threads API não agenda. Com `true`, uma rodada
   * sem `--threads-timer` pula o `threads_profile` (`skip_delegated`), mesmo
   * contrato do `linkedinProfileViaTimer`.
   */
  threadsProfileViaTimer: boolean;
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
  /**
   * #11515: vertical no TikTok @diar.ia.br pela Buffer (MCP, passo da skill,
   * como o X), com o vídeo por URL pública (R2). Decisão do editor de
   * 28/10/2026: Buffer em vez da Content Posting API própria (posts públicos
   * desde o 1º dia, sem auditoria de app). `false` no código; o
   * `platform.config.json` liga.
   */
  tiktok: boolean;
  /** #11515: canal TikTok na Buffer (`list_channels`, org "My Organization"). Obrigatório com `tiktok: true`. */
  tiktokBufferChannelId: string | null;
  /**
   * #11795: os destinos do corte avulso que a API não agenda (`linkedin_profile`,
   * `threads_profile`, `instagram`) saem pelo timer do 300
   * (`Diaria-Shorts-Cortes`, `scripts/shorts-corte-timer.ts`), que também avisa
   * o editor quando um destino falha. `false` volta à task agendada one-shot da
   * skill (#11550).
   */
  corteViaTimer: boolean;
  /**
   * #12465: perfis da diar.ia.br citados no post do vídeo nas contas pessoais
   * (`publishing.shorts.diaria_profiles`). Ausente = `DEFAULT_DIARIA_PROFILES`.
   */
  diariaProfiles?: DiariaProfiles;
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
  // #12100 opção 2 (decisão do editor, 11/11/2026): ligada por padrão; medir no oar2.jpg do próximo Short.
  youtubeFirstFrameCoverMs: SHORT_FIRST_FRAME_COVER_DEFAULT_MS,
  // #10982: desligado no código; o platform.config.json liga junto com o timer.
  linkedinProfileViaTimer: false,
  // #11410: desligado; o editor liga no platform.config.json junto com o arme da task no 300.
  threadsProfileViaTimer: false,
  // #11265 (decisão do editor, 27/10/2026): timer no 300, sem depender do R2 (mantido com o R2 habilitado, #11411).
  instagramBackend: "timer-300",
  // #11223: ligado no código; o platform.config.json pausa durante a viagem.
  facebookProfile: true,
  // #11515: desligado no código; o platform.config.json liga com o canal da Buffer.
  tiktok: false,
  tiktokBufferChannelId: null,
  // #11795: desligado no código; o platform.config.json liga junto com o arme da task no 300.
  corteViaTimer: false,
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
    youtubeFirstFrameCoverMs: DEFAULT_SHORTS_CONFIG.youtubeFirstFrameCoverMs,
    linkedinProfileViaTimer: DEFAULT_SHORTS_CONFIG.linkedinProfileViaTimer,
    threadsProfileViaTimer: DEFAULT_SHORTS_CONFIG.threadsProfileViaTimer,
    instagramBackend: DEFAULT_SHORTS_CONFIG.instagramBackend,
    facebookProfile: DEFAULT_SHORTS_CONFIG.facebookProfile,
    tiktok: DEFAULT_SHORTS_CONFIG.tiktok,
    tiktokBufferChannelId: DEFAULT_SHORTS_CONFIG.tiktokBufferChannelId,
    corteViaTimer: DEFAULT_SHORTS_CONFIG.corteViaTimer,
  };
}

/** Booleano opcional do config: ausente = default; qualquer outra coisa que não boolean lança. */
function optionalBool(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new Error(`[shorts] publishing.shorts.${key} precisa ser boolean (#10772).`);
  return v;
}

/**
 * #12100 opção 2: `youtube_first_frame_cover` (boolean, default true) liga a
 * capa no 1º frame do vertical do YouTube; `youtube_first_frame_cover_ms`
 * (inteiro entre 100 e 2000, default 400) diz quanto tempo. Desligada → null.
 * `_ms` inválido NÃO derruba a rodada (review da PR #12844): a capa no 1º
 * frame é opcional e o config é lido por todos os destinos, então vira
 * `[aviso]` e cai no default 400. O boolean inválido segue lançando, como as
 * outras flags de `publishing.shorts`.
 */
export function loadYouTubeFirstFrameCoverMs(raw: Record<string, unknown>, warn: (line: string) => void = (l) => console.error(l)): number | null {
  if (!optionalBool(raw, "youtube_first_frame_cover", true)) return null;
  const ms = raw.youtube_first_frame_cover_ms;
  if (ms === undefined) return SHORT_FIRST_FRAME_COVER_DEFAULT_MS;
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms < SHORT_FIRST_FRAME_COVER_MIN_MS || ms > SHORT_FIRST_FRAME_COVER_MAX_MS) {
    warn(
      `[aviso] publishing.shorts.youtube_first_frame_cover_ms = ${JSON.stringify(ms)} inválido (inteiro entre ${SHORT_FIRST_FRAME_COVER_MIN_MS} e ` +
        `${SHORT_FIRST_FRAME_COVER_MAX_MS}) — usa o default ${SHORT_FIRST_FRAME_COVER_DEFAULT_MS} ms (#12100)`,
    );
    return SHORT_FIRST_FRAME_COVER_DEFAULT_MS;
  }
  return ms;
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
  const tiktok = optionalBool(raw, "tiktok", DEFAULT_SHORTS_CONFIG.tiktok);
  const tiktokChannel = raw.tiktok_buffer_channel_id ?? null;
  if (tiktokChannel !== null && (typeof tiktokChannel !== "string" || !/^[A-Za-z0-9]{6,64}$/.test(tiktokChannel))) {
    throw new Error("[shorts] publishing.shorts.tiktok_buffer_channel_id precisa ser o id do canal na Buffer ou null (#11515).");
  }
  if (tiktok && tiktokChannel === null) {
    throw new Error("[shorts] publishing.shorts.tiktok exige tiktok_buffer_channel_id (o canal TikTok na Buffer, list_channels) (#11515).");
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
    youtubeFirstFrameCoverMs: loadYouTubeFirstFrameCoverMs(raw),
    linkedinProfileViaTimer: optionalBool(raw, "linkedin_profile_via_timer", DEFAULT_SHORTS_CONFIG.linkedinProfileViaTimer),
    threadsProfileViaTimer: optionalBool(raw, "threads_profile_via_timer", DEFAULT_SHORTS_CONFIG.threadsProfileViaTimer),
    instagramBackend: backend,
    facebookProfile: optionalBool(raw, "facebook_profile", DEFAULT_SHORTS_CONFIG.facebookProfile),
    tiktok,
    tiktokBufferChannelId: tiktokChannel,
    corteViaTimer: optionalBool(raw, "corte_via_timer", DEFAULT_SHORTS_CONFIG.corteViaTimer),
    diariaProfiles: loadDiariaProfiles(raw.diaria_profiles),
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
  /** #11515: TikTok pela Buffer, mesmo caminho do X (a skill chama a MCP; o script prepara texto, horário e URL). */
  | { id: "tiktok"; kind: "tiktok"; mode: "guided" }
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
  if (cfg.tiktok) out.push({ id: "tiktok", kind: "tiktok", mode: "guided" });
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
  /** #11547: a capa (Still) foi aplicada neste destino? Ausente = nenhuma tentativa. */
  cover?: ShortCoverRecord;
  /** #11795: última troca de texto/capa do post já agendado (`--update-scheduled`). */
  updated_at?: string;
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
 * Horário do vertical (#10831, #12250). O horizontal sai às 06:00 BRT junto da
 * newsletter; o vertical sai em horário PRÓPRIO, fixo POR DESTINO desde o
 * #12250 (decisão do editor de 05/11/2026): o YouTube Shorts às 06:30
 * (`by_destination.youtube_shorts`) e todos os outros destinos às 12:00
 * (`default_time`). O mesmo config é lido pelo `publish-shorts.ts` E pelos
 * timers do 300 (Instagram, LinkedIn e Threads pessoais), cada um passando o
 * próprio destino a `resolveShortTime`: um horário calculado só na máquina
 * que roda a skill não chegaria neles.
 *
 * Histórico: de 261026 a 261106 o vertical saiu num teste rotativo que
 * alternava `rotation_times` (06:30/08:00/12:00) dia a dia a partir de
 * `rotation_start`, em todos os destinos. O #12250 encerrou o teste
 * (`rotation_end` = 2026-11-06); a janela continua no config só pra
 * re-derivar o horário das edições daquele período (alarmes e conferências
 * que olham um dia passado) e porque `rotation_times` é a lista de onde a
 * vertical extra escolhe um horário livre (`extraVerticalTime`).
 *
 * Por que o Short do YouTube nunca sai junto (ou antes) do horizontal das
 * 06:00 (#10831/#10811, conferido no #12250): o "vídeo relacionado" do Short
 * só aceita vídeo PÚBLICO, então o vínculo (task `diaria-short-video-relacionado`,
 * 06:05 BRT no Neo) precisa do horizontal já no ar e de folga antes do Short.
 * `loadShortScheduleConfig` recusa `by_destination.youtube_shorts` que não
 * seja estritamente depois de `DEFAULT_EDITION_SCHEDULE_HHMM`.
 */
export interface ShortScheduleConfig {
  rotationTimes: string[];
  rotationStart: CivilDate;
  /** Inclusivo. `null` = sem fim. */
  rotationEnd: CivilDate | null;
  defaultTime: string;
  /** #12250: horário fixo por destino (id do destino → HH:MM BRT); destino ausente usa `defaultTime`. */
  byDestination: Readonly<Record<string, string>>;
}

const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * Ids fixos de destino aceitos como chave de `by_destination` (#12250). Espelha
 * os ids de `ShortDestination` (exceto `facebook:{slug}`, validado por
 * prefixo): o loader não tem a `ShortsConfig` em mãos, então valida contra o
 * conjunto fixo. Chave fora dele (ex.: `youtube_short`) é erro, nunca fallback
 * silencioso pro `default_time`.
 */
export const SCHEDULE_DESTINATION_IDS: ReadonlySet<Exclude<ShortDestination["id"], FacebookDestinationId>> = new Set([
  "youtube_shorts",
  "instagram",
  "facebook_profile",
  "linkedin_profile",
  "linkedin_page_repost",
  "x",
  "tiktok",
  "threads_profile",
] as const);

function isScheduleDestinationKey(key: string): boolean {
  if ((SCHEDULE_DESTINATION_IDS as ReadonlySet<string>).has(key)) return true;
  return /^facebook:[^\s:]+$/.test(key);
}

/**
 * Decisão do editor de 05/11/2026 (#12250): YouTube Shorts às 06:30, os
 * outros destinos às 12:00. A rotação de 22/10/2026 (#10831, #10939) fica com
 * a janela encerrada em 261106 (último dia útil antes do #12250).
 */
export const DEFAULT_SHORT_SCHEDULE_RAW = Object.freeze({
  rotation_times: Object.freeze(["06:30", "08:00", "12:00"]),
  rotation_start: "2026-10-26",
  rotation_end: "2026-11-06",
  default_time: "12:00",
  by_destination: Object.freeze({ youtube_shorts: "06:30" }),
});

/** Lê `publishing.shorts.schedule`; ausente → default (#10831, #12250). Malformado LANÇA (estragaria o horário em silêncio). */
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
  const byDestination: Record<string, string> = {};
  const rawBy = raw.by_destination;
  if (rawBy !== undefined && rawBy !== null) {
    if (typeof rawBy !== "object" || Array.isArray(rawBy)) {
      throw new Error("[shorts] publishing.shorts.schedule.by_destination precisa ser um objeto { destino: \"HH:MM\" } (#12250).");
    }
    for (const [dest, hhmm] of Object.entries(rawBy as Record<string, unknown>)) {
      if (!isScheduleDestinationKey(dest)) {
        throw new Error(
          `[shorts] publishing.shorts.schedule.by_destination: destino desconhecido "${dest}" — ` +
            `use um de ${[...SCHEDULE_DESTINATION_IDS].join(", ")} ou facebook:{slug} (#12250; chave errada cairia em silêncio no default_time).`,
        );
      }
      if (typeof hhmm !== "string" || !HHMM_RE.test(hhmm)) {
        throw new Error(`[shorts] publishing.shorts.schedule.by_destination.${dest} precisa ser HH:MM (#12250).`);
      }
      byDestination[dest] = hhmm;
    }
  }
  const yt = byDestination.youtube_shorts;
  if (yt !== undefined && yt <= DEFAULT_EDITION_SCHEDULE_HHMM) {
    throw new Error(
      `[shorts] publishing.shorts.schedule.by_destination.youtube_shorts (${yt}) precisa ser depois das ${DEFAULT_EDITION_SCHEDULE_HHMM} do horizontal: ` +
        "o vídeo relacionado do Short só vincula com o horizontal já público (#10811, #12250).",
    );
  }
  return { rotationTimes: [...times], rotationStart: start, rotationEnd: end, defaultTime: raw.default_time, byDestination };
}

export interface ShortTime {
  /** HH:MM em BRT, no dia da edição. */
  hhmm: string;
  /**
   * `rotation`: dia dentro da janela do teste encerrado do #10831 (histórico);
   * `destination`: horário fixo do destino (`by_destination`, #12250);
   * `default`: horário fixo dos demais destinos (`default_time`, #12250);
   * `explicit` (#11795): corte avulso com `--at`.
   */
  source: "rotation" | "default" | "destination" | "explicit";
  /** Explicação curta pra premissa do plano. */
  reason: string;
}

/**
 * Pure: horário (BRT) do vertical da edição `AAMMDD` no destino `destination`
 * (#10831, #12250). Sem destino (ou destino sem entrada em `by_destination`)
 * = `default_time`. Dentro da janela do teste encerrado vale a rotação, em
 * todos os destinos, como valeu na época.
 */
export function resolveShortTime(sched: ShortScheduleConfig, aammdd: string, destination?: string): ShortTime {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(aammdd);
  if (!m) throw new Error(`AAMMDD inválido: ${JSON.stringify(aammdd)}`);
  const date = parseIsoCivilDate(`20${m[1]}-${m[2]}-${m[3]}`, "data da edição");
  const day = civilDayNumber(date);
  const start = civilDayNumber(sched.rotationStart);
  const inWindow = day >= start && (sched.rotationEnd === null || day <= civilDayNumber(sched.rotationEnd));
  if (inWindow) {
    const k = day - start;
    const hhmm = sched.rotationTimes[k % sched.rotationTimes.length];
    return { hhmm, source: "rotation", reason: `teste de horário do vertical, dia ${k + 1} (alterna ${sched.rotationTimes.join("/")})` };
  }
  const own = destination !== undefined ? sched.byDestination[destination] : undefined;
  if (own !== undefined) {
    return { hhmm: own, source: "destination", reason: `horário fixo de ${destination} (#12250)` };
  }
  return { hhmm: sched.defaultTime, source: "default", reason: "horário fixo do vertical (#12250)" };
}

/**
 * Horários que o timer de um destino do 300 precisa cobrir (#12250): os do
 * teste rotativo (re-derivação de dias passados), o `default_time` e o horário
 * próprio do destino em `by_destination`, sem repetição. Os guards de par
 * timer×horário (`test/shorts-*-timer-*.test.ts`) leem daqui: um horário
 * próprio fora da hora cheia sem execução diária logo depois quebra o teste,
 * em vez de sair até ~59 min atrasado pela execução de hora em hora.
 */
export function timerDueTimes(sched: ShortScheduleConfig, destination: string): string[] {
  const own = sched.byDestination[destination];
  return [...new Set([...sched.rotationTimes, sched.defaultTime, ...(own !== undefined ? [own] : [])])];
}

/** Todos os horários fixos do vertical fora do teste (`default_time` + `by_destination`), sem repetição (#12250). */
export function fixedShortTimes(sched: ShortScheduleConfig): string[] {
  return [...new Set([sched.defaultTime, ...Object.values(sched.byDestination)])];
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
  /** `test-schedule` = horário do teste (encerrado) do #10831 mantido, nas edições daquela janela. */
  /** `fixed-time` (#12250): horário fixo do destino (`by_destination`/`default_time`) mantido; a grade só avisa. */
  /** `timer-300` (#11265): Instagram pelo timer do 300, sempre no horário do vertical, fora da grade. */
  /** `explicit` (#11795): horário do corte avulso (`--at`), mantido em todos os destinos como o do teste. */
  /** `SlotRule`: só o repost da página do LinkedIn (`planLinkedInRepostSlot`) ainda passa pelo planner. */
  rule: "test-schedule" | "fixed-time" | "timer-300" | "explicit" | SlotRule;
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
  // #11515: idem pro TikTok (Buffer).
  if (dest.kind === "tiktok") return socialAccountKey("tiktok", "diaria");
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
 * Pure (#10819, #12250): horário de cada destino de API do vertical contra a
 * grade já agendada (`gridFromSocialPublished` + `gridFromShortsPublished`).
 *
 * Desde o #12250 o horário do vertical é FIXO por destino (decisão do editor
 * de 05/11/2026): cada destino sai no horário que `timeFor` devolve (o do
 * destino em `by_destination`, senão `default_time`; no corte avulso, o
 * `--at`; nas edições da janela do teste encerrado do #10831, o da rotação).
 * A grade nunca move o vídeo: quando o horário cai a menos de
 * `DEFAULT_MIN_GAP_MINUTES` de um post da MESMA conta (ou de um collab do
 * Instagram, decisão do editor 261023), o slot é mantido e sai um AVISO pro
 * editor mover à mão se quiser (premissa decidida no #12250, a mesma que o
 * teste do #10831 e o corte explícito já seguiam). Antes do #12250, fora do
 * teste, o `planSlots` escolhia outro horário por destino em silêncio.
 *
 * Destinos guiados (YouTube Shorts, perfil pessoal do Facebook) não entram:
 * a skill lê o horário deles do item do plano.
 */
export function planShortSlots(input: {
  aammdd: string;
  /** Horário dos destinos sem `timeFor` (e base do aviso). */
  time: ShortTime;
  /** ISO do `time.hhmm` no dia da edição. */
  timeAt: string;
  /** #12250: horário por destino; ausente = `time`/`timeAt` em todos. */
  timeFor?: (destinationId: string) => { time: ShortTime; at: string };
  destinations: readonly ShortDestination[];
  cfg: Pick<ShortsConfig, "instagramAuthorPage"> & Partial<Pick<ShortsConfig, "instagramCollaborators">>;
  grid: readonly ScheduledSlot[];
}): ShortSlot[] {
  const api = input.destinations
    .map((d) => ({ dest: d, account: shortDestinationAccount(d, input.cfg), also: shortDestinationAlsoAccounts(d, input.cfg) }))
    .filter((x): x is { dest: ShortDestination; account: string; also: string[] } => x.account !== null);
  const withAlso = (also: string[]) => (also.length ? { alsoAccounts: also } : {});

  return api.map(({ dest, account, also }) => {
    const { time, at } = input.timeFor ? input.timeFor(dest.id) : { time: input.time, at: input.timeAt };
    const t = Date.parse(at);
    const mine = new Set([account, ...also]);
    const close = input.grid
      .filter((s) => slotAccounts(s).some((a) => mine.has(a)) && Math.abs(Date.parse(s.at) - t) < DEFAULT_MIN_GAP_MINUTES * 60_000)
      .map((s) => brtHHMM(s.at));
    // #11795: o horário explícito do corte avulso é mantido como o do teste (o
    // editor escolheu), mas nunca leva o rótulo nem a premissa do teste.
    const kind = time.source === "explicit" ? "explicit" : time.source === "rotation" ? "test-schedule" : "fixed-time";
    const slot: ShortSlot = {
      destination: dest.id,
      account,
      ...withAlso(also),
      at: new Date(t).toISOString(),
      hhmm: time.hhmm,
      rule: kind,
      premise:
        kind === "explicit"
          ? "horário explícito do corte avulso (--at, #11795) tem precedência sobre a grade (#10819)"
          : kind === "test-schedule"
            ? "teste de horário do vertical (#10831) tem precedência sobre a grade (#10819)"
            : `horário fixo do vertical em ${dest.id} (#12250) tem precedência sobre a grade (#10819)`,
    };
    if (close.length) {
      const what = kind === "explicit" ? "do corte" : kind === "test-schedule" ? "do teste" : "fixo";
      const why = kind === "explicit" ? "porque o horário do corte é explícito" : kind === "test-schedule" ? "por causa do teste" : "porque o horário do vertical é fixo (#12250)";
      slot.warning =
        `${dest.id}: o horário ${what} (${time.hhmm} BRT) fica a menos de ${DEFAULT_MIN_GAP_MINUTES} min de post da mesma conta${also.length ? ` (ou de ${also.join(", ")}, em collab)` : ""} ` +
        `(${[...new Set(close)].join(", ")} BRT) — mantido ${why}; mova à mão se não quiser colado`;
    }
    return slot;
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
 * #11390/#11794: rota do Reels postado à mão (Passo B3b do `/diaria-publica-video`,
 * Chrome ou app). Decisão do editor (02/11/2026, #11794): a @diar.ia.br é a
 * AUTORA e a @vjpixel entra em collab, igual à rota da API (#11223). `authorPage`
 * = slug de `publishing.social.facebook.pages` da conta autora; com
 * `instagram_author_page: null` (a conta do env) ela é a própria conta da API
 * (`instagramAccountKey`), e o post à mão aparece nela depois do processamento
 * (30 a 60 s depois do Share).
 */
export const INSTAGRAM_CHROME_ROUTE = {
  authorUsername: "diar.ia.br",
  authorPage: INSTAGRAM_ENV_ACCOUNT_KEY,
  collaboratorUsername: "vjpixel",
} as const;

/** #11390/#11794: a rota do B3b em texto, pros avisos e alarmes. */
export function instagramChromeRouteText(): string {
  return `como @${INSTAGRAM_CHROME_ROUTE.authorUsername} (autora), com a @${INSTAGRAM_CHROME_ROUTE.collaboratorUsername} em collab`;
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

/** #11355: como o vídeo do Reels chega à Meta. */
export type InstagramReelUploadRoute = "video_url" | "rupload";

/**
 * Pure (#11355): rota do Reels pela autora. Na @diar.ia.br é `video_url`: o
 * rupload processa de forma síncrona e a Meta encerra a requisição em ~32,5 s
 * (23 casos em 01/11/2026), enquanto a `video_url` deu 6/6 FINISHED de 45 a 75 s.
 * A @vjpixel, sem medição nova na `video_url` (2207076 com 113,9 s, #10893),
 * segue no rupload.
 */
export function instagramReelUploadRoute(authorPage: string | null): InstagramReelUploadRoute {
  return instagramAccountKey(authorPage) === INSTAGRAM_ENV_ACCOUNT_KEY ? "video_url" : "rupload";
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
 * @diar.ia.br o config usa `null`, sem teto: o limite medido era o tempo do
 * rupload, e a conta publica por `video_url` (#11355,
 * `instagramReelUploadRoute`). Os valores vivem no config, não aqui. Ordem:
 *   1. `publishing.shorts.instagram_api_max_seconds_by_account[chave]`, com a
 *      chave de `instagramAccountKey(authorPage)`;
 *   2. `publishing.shorts.instagram_api_max_seconds` (legado, vale pra
 *      qualquer conta);
 *   3. `INSTAGRAM_REELS_API_MAX_SECONDS` (40 s).
 * Em 1 e 2, `null` desliga o teto (a API decide), mas só na conta da rota
 * `video_url`. Na rota `rupload` o limite existe de qualquer forma (a Meta
 * encerra a requisição, #11355): lá `null` vale o teto padrão, com premissa no
 * log (`nullIgnored`), e o vídeo longo vai pro passo guiado em vez de falhar.
 * Valor inválido LANÇA, em
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
  /** O config pediu `null` numa conta da rota `rupload`: vale o teto padrão (#11355). */
  nullIgnored?: true;
}

export function resolveInstagramApiMaxSeconds(config: unknown, authorPage: string | null): InstagramApiMaxSecondsResolution {
  const res = resolveConfiguredInstagramMaxSeconds(config, authorPage);
  if (res.maxSeconds === null && instagramReelUploadRoute(authorPage) === "rupload") {
    return { ...res, maxSeconds: INSTAGRAM_REELS_API_MAX_SECONDS, nullIgnored: true };
  }
  return res;
}

function resolveConfiguredInstagramMaxSeconds(config: unknown, authorPage: string | null): InstagramApiMaxSecondsResolution {
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
  if (r.nullIgnored) {
    return `teto do Reels pela API: ${r.maxSeconds} s na conta "${r.key}" — o config pede null (sem teto), que só vale na rota video_url, e esta conta sobe pelo rupload (#11355)`;
  }
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
