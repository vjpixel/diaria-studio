/**
 * Conferência do Reels já publicado no Instagram (registro, marcadores, janela de horário) e o gate do timer do 300.
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import type { ResolvedFacebookPage } from "../lib/facebook-pages.ts";
import {
  DIARIA_YOUTUBE_CHANNEL_URL,
  firstSentence,
  INSTAGRAM_CHROME_ROUTE,
  instagramAccountKey,
  REELS_NEWSLETTER_SENTENCE,
  type ShortPublishedEntry,
  type ShortsPublishedFile,
} from "../lib/diaria/short-video.ts";
import { stripInlineMarkdown } from "../lib/diaria/youtube-video.ts";
import { GRAPH } from "./_shared.ts";
import { type InstagramAuthor, resolveInstagramAuthor, checkInstagramCollaborators } from "./instagram.ts";
import { type GraphDeps, defaultGraphDeps, readJson, graphGet } from "./facebook.ts";

/** Normaliza o `timestamp` do Instagram (`2026-10-22T15:22:00+0000`) pra ISO que o Date.parse aceita. */
function parseIgTimestamp(ts: unknown): number {
  if (typeof ts !== "string") return Number.NaN;
  return Date.parse(ts.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

/**
 * Tamanho de cada página que o `--confirm-instagram` lê de `/{ig-user}/media`
 * (as mais recentes da autora primeiro). Desde #10978 a leitura pagina
 * (`paging.next`) até achar o que procura ou bater `INSTAGRAM_CONFIRM_MAX_PAGES`.
 */
export const INSTAGRAM_CONFIRM_MEDIA_LIMIT = 15;

/**
 * Teto de páginas do `/media` (#10978): 5 × 15 = as 75 mídias mais recentes.
 * Os candidatos são sempre DENTRO do que foi lido: um Reels mais antigo que
 * isso não aparece (e a recusa diz quantas mídias foram lidas).
 */
export const INSTAGRAM_CONFIRM_MAX_PAGES = 5;

export interface InstagramReelCandidate {
  id: string;
  permalink: string | null;
  timestamp: string;
  /** A legenda tem o marcador desta edição (`instagramEditionMarkers`). */
  matchesEdition: boolean;
}

/**
 * Pure (#10915): marcadores que identificam o Reels DESTA edição na legenda.
 * A legenda do Instagram (`buildReelsCaption`) não leva URL nem UTM — manda
 * pro link da bio —, então o marcador principal é o título do D1, que abre a
 * legenda. `utm_campaign={AAMMDD}` e a URL da edição entram também, pro caso
 * de a legenda colada trazer o link.
 *
 * #10978 item 5: o gancho (1ª frase do D1, 2º parágrafo da legenda) também
 * conta, então editar só a 1ª linha (o título) no Chrome não derruba o
 * match. Gancho curto demais (< `INSTAGRAM_HOOK_MARKER_MIN_CHARS`) fica de
 * fora: casaria legenda de outra edição.
 */
export function instagramEditionMarkers(input: { aammdd: string; d1Title?: string | null; d1Body?: string | null; editionUrl?: string | null }): string[] {
  const out = [`utm_campaign=${input.aammdd}`];
  if (input.editionUrl) out.push(input.editionUrl.replace(/[?#].*$/, ""));
  const title = input.d1Title ? stripInlineMarkdown(input.d1Title).replace(/\s+/g, " ").trim() : "";
  if (title) out.push(title);
  const hook = input.d1Body ? firstSentence(input.d1Body) : "";
  if (Array.from(hook).length >= INSTAGRAM_HOOK_MARKER_MIN_CHARS) out.push(hook);
  return out;
}

/** #10978 item 5: tamanho mínimo do gancho pra valer como marcador da edição. */
export const INSTAGRAM_HOOK_MARKER_MIN_CHARS = 30;

/**
 * #10978 item 5: janela em torno do horário do vertical (`resolveShortTime`,
 * o mesmo horário em que o timer do 300 publica, #11265, e o slot do
 * Instagram no plano com `timer-300`) em que um Reels SEM marcador ainda pode
 * ser o da edição.
 */
export const INSTAGRAM_CONFIRM_TIME_WINDOW_MS = 90 * 60_000;

/**
 * #10978 item 5: trecho fixo da legenda de todo vertical (`buildReelsCaption`).
 * Não identifica a edição, só o formato: entra junto com a janela de horário,
 * nunca sozinho. #11388: a frase que explica a newsletter substituiu a linha do
 * canal do YouTube.
 */
export const INSTAGRAM_CAPTION_FORMAT_MARKER = REELS_NEWSLETTER_SENTENCE;

/** #11388: o trecho fixo das legendas de antes (linha do canal do YouTube), que segue valendo pros Reels já no ar. */
export const INSTAGRAM_CAPTION_LEGACY_FORMAT_MARKER = DIARIA_YOUTUBE_CHANNEL_URL.replace(/^https:\/\/www\./, "");

function normalizeForMatch(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Pure: a legenda tem algum dos marcadores (sem diferenciar caixa nem espaços)? */
export function captionMatchesEdition(caption: unknown, markers: string[]): boolean {
  if (typeof caption !== "string" || !caption) return false;
  const c = normalizeForMatch(caption);
  return markers.some((m) => m.trim() && c.includes(normalizeForMatch(m)));
}

export type InstagramConfirmDecision =
  /** Já registrado: no-op, nada é escrito. `exitCode` 1 quando o registro não é `published` (ex.: `scheduled` na fila). */
  | { kind: "already_registered"; entry: ShortPublishedEntry; exitCode: 0 | 1 }
  /**
   * Nenhum match, mais de 1 match, ou `--media-id` fora da lista: recusa (exit 1) listando os candidatos.
   * `cause` (#11265): `none` = nenhum Reels na janela; `no-match` = há Reels, nenhum da edição;
   * `ambiguous` = mais de um candidato; `window` = a leitura não cobriu o corte; `media-id` = escolha inválida.
   */
  | { kind: "refuse"; reason: string; candidates: InstagramReelCandidate[]; cause: "none" | "no-match" | "ambiguous" | "window" | "media-id" }
  /** `matchedBy` (#10978 item 5): pelo marcador na legenda, pela janela de horário + formato, ou pelo `--media-id`. */
  | { kind: "register"; entry: ShortPublishedEntry; candidates: InstagramReelCandidate[]; matchedBy: "marker" | "time-window" | "media-id" };

/**
 * Pure (#10915): decide o que o `--confirm-instagram` grava, a partir do
 * registro atual e da resposta de `/{ig-user}/media` (com `caption`). Só
 * aceita o Reels cuja legenda tem o marcador da edição — o "mais recente
 * desde 00:00" gravava qualquer Reels que a autora tivesse postado no dia.
 * `mediaId` (escolha explícita do editor) dispensa o marcador e o corte de
 * horário, mas a mídia tem que estar entre as lidas da autora (garante que é
 * dela).
 */
/**
 * Pure (#10915): o `instagram` já tem registro? Então o `--confirm-instagram`
 * é no-op (nada é escrito) e sai não-zero quando o registro não é
 * `published` — um `scheduled` na fila do Worker não é "postado no Chrome".
 */
export function instagramAlreadyRegistered(published: ShortsPublishedFile): { entry: ShortPublishedEntry; exitCode: 0 | 1 } | null {
  const existing = published.entries.find((e) => e.destination === "instagram");
  return existing ? { entry: existing, exitCode: existing.status === "published" ? 0 : 1 } : null;
}

export function decideInstagramConfirm(input: {
  published: ShortsPublishedFile;
  media?: unknown;
  sinceIso: string;
  markers: string[];
  mediaId?: string | null;
  nowIso: string;
  /**
   * #10978: a leitura do `/media` chegou ao `sinceIso` (ou acabou)? Default:
   * o `windowCovered` que `fetchInstagramRecentMedia` devolve junto de `data`,
   * senão `true`. `false` (parou no teto de páginas) recusa o match automático
   * — pode haver outro Reels da edição não lido — e exige `--media-id`.
   */
  windowCovered?: boolean;
  /**
   * #10978 item 5: horário planejado do Reels (ISO). Sem nenhum marcador na
   * legenda, aceita o ÚNICO Reels a até `windowMs` dele cuja legenda ainda tem
   * o formato do vertical (`INSTAGRAM_CAPTION_FORMAT_MARKER`). Ausente = só marcador.
   */
  expectedAtIso?: string | null;
  windowMs?: number;
}): InstagramConfirmDecision {
  const already = instagramAlreadyRegistered(input.published);
  if (already) return { kind: "already_registered", ...already };
  const since = Date.parse(input.sinceIso);
  if (Number.isNaN(since)) throw new Error(`--since inválido: ${input.sinceIso}`);
  const data = (input.media as any)?.data;
  if (!Array.isArray(data)) throw new Error(`GET /media sem lista: ${JSON.stringify(input.media ?? null).slice(0, 200)}`);
  const toCandidate = (m: any): InstagramReelCandidate => ({
    id: m.id,
    permalink: typeof m.permalink === "string" ? m.permalink : null,
    timestamp: String(m.timestamp ?? ""),
    matchesEdition: captionMatchesEdition(m.caption, input.markers),
  });
  const valid = data.filter((m: any) => typeof m?.id === "string");
  const byNewest = (a: InstagramReelCandidate, b: InstagramReelCandidate) => parseIgTimestamp(b.timestamp) - parseIgTimestamp(a.timestamp);
  const entryFor = (c: InstagramReelCandidate): ShortPublishedEntry => {
    const timestamp = parseIgTimestamp(c.timestamp);
    return {
      destination: "instagram",
      status: "published",
      id: c.id,
      ...(c.permalink ? { url: c.permalink } : {}),
      scheduled_at: null,
      at: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : input.nowIso,
    };
  };
  const isReels = (m: any) => m.media_product_type === "REELS";
  if (input.mediaId) {
    const all = valid.map(toCandidate).sort(byNewest);
    const raw = valid.find((m: any) => m.id === input.mediaId);
    if (!raw) {
      return {
        kind: "refuse",
        reason: `--media-id ${input.mediaId} não está entre as ${data.length} mídias mais recentes lidas da autora`,
        candidates: all,
        cause: "media-id",
      };
    }
    // #10966: a escolha explícita também precisa ser um Reels — uma foto ou um
    // carrossel com o id errado viraria o registro `instagram: published` (#573).
    if (!isReels(raw)) {
      const type = typeof raw.media_product_type === "string" ? raw.media_product_type : "sem media_product_type";
      return {
        kind: "refuse",
        reason: `--media-id ${input.mediaId} não é um Reels (media_product_type: ${type}${typeof raw.media_type === "string" ? `, media_type: ${raw.media_type}` : ""}) — escolha um dos Reels listados`,
        candidates: valid.filter(isReels).map(toCandidate).sort(byNewest),
        cause: "media-id",
      };
    }
    return { kind: "register", entry: entryFor(toCandidate(raw)), candidates: all, matchedBy: "media-id" };
  }
  const reelsRaw = valid.filter((m: any) => isReels(m) && parseIgTimestamp(m.timestamp) >= since);
  const reels: InstagramReelCandidate[] = reelsRaw.map(toCandidate).sort(byNewest);
  const matches = reels.filter((c) => c.matchesEdition);
  const windowCovered = input.windowCovered ?? (input.media as any)?.windowCovered !== false;
  if (!windowCovered) {
    return {
      kind: "refuse",
      reason: `a leitura parou no teto de páginas (${data.length} mídias) sem chegar a ${input.sinceIso} — pode haver Reels da edição não lido; escolha com --media-id`,
      candidates: matches.length ? matches : reels,
      cause: "window",
    };
  }
  if (matches.length === 1) return { kind: "register", entry: entryFor(matches[0]), candidates: reels, matchedBy: "marker" };
  if (!reels.length) {
    return {
      kind: "refuse",
      reason: `nenhum Reels desde ${input.sinceIso} (entre as ${data.length} mídias mais recentes lidas) — o Share terminou? (o processamento leva ~30–60 s)`,
      candidates: [],
      cause: "none",
    };
  }
  if (matches.length > 1) {
    return {
      kind: "refuse",
      reason: `${matches.length} Reels desde ${input.sinceIso} têm o marcador desta edição na legenda — escolha com --media-id`,
      candidates: matches,
      cause: "ambiguous",
    };
  }
  // #10978 item 5: legenda editada (título e gancho trocados no Chrome). Vale o
  // ÚNICO Reels perto do horário planejado que ainda tem o formato do vertical;
  // dois ou mais na janela é ambíguo e recusa, como sempre.
  const expected = input.expectedAtIso ? Date.parse(input.expectedAtIso) : Number.NaN;
  if (!Number.isNaN(expected)) {
    const windowMs = input.windowMs ?? INSTAGRAM_CONFIRM_TIME_WINDOW_MS;
    const near = reelsRaw.filter(
      (m: any) => Math.abs(parseIgTimestamp(m.timestamp) - expected) <= windowMs && captionMatchesEdition(m.caption, [INSTAGRAM_CAPTION_FORMAT_MARKER, INSTAGRAM_CAPTION_LEGACY_FORMAT_MARKER]),
    );
    if (near.length === 1) return { kind: "register", entry: entryFor(toCandidate(near[0])), candidates: reels, matchedBy: "time-window" };
    if (near.length > 1) {
      return {
        kind: "refuse",
        reason: `nenhum Reels tem o marcador desta edição e ${near.length} Reels no formato do vertical caem a até ${Math.round(windowMs / 60_000)} min do horário planejado — escolha com --media-id`,
        candidates: near.map(toCandidate).sort(byNewest),
        cause: "ambiguous",
      };
    }
  }
  return {
    kind: "refuse",
    reason: `nenhum dos ${reels.length} Reels desde ${input.sinceIso} tem o marcador desta edição na legenda (título ou gancho do D1, utm_campaign)${Number.isNaN(expected) ? "" : " nem cai perto do horário planejado com o formato do vertical"} — escolha com --media-id`,
    candidates: reels,
    cause: "no-match",
  };
}

/**
 * #11390/#11794: recusas da conta da API em que vale procurar no perfil do autor
 * da rota do Chrome (`INSTAGRAM_CHROME_ROUTE`), quando ele é outra conta (só com
 * `instagram_author_page` apontando para outra página): nada da edição na conta,
 * ou o `--media-id` escolhido não está entre as mídias dela. Ambíguo e janela
 * incompleta não: lá a conta já tem candidato e quem escolhe é o editor.
 */
const CHROME_AUTHOR_FALLBACK_CAUSES: ReadonlySet<string> = new Set(["none", "no-match", "media-id"]);

export interface InstagramConfirmAcrossAccounts {
  decision: InstagramConfirmDecision;
  /** De onde veio a decisão: a conta da API ou o perfil do autor da rota do Chrome. */
  account: "primary" | "chrome-author";
  /** Por que o perfil do autor não resolveu (sem credencial, leitura falhou, recusa); ausente = não foi consultado ou resolveu. */
  fallbackNote?: string;
}

/**
 * #11390/#11794: o `--confirm-instagram` procura primeiro na conta da API e, se
 * ela não tem o Reels da edição, no perfil do autor da rota do Chrome, quando
 * ele é outra conta. Na config de produção a autora é a própria conta da API e
 * não há segundo perfil. `chromeAuthor` null = o perfil não é consultável (sem
 * credencial, ou é a mesma conta da API); o motivo vem em `chromeAuthorUnavailable`.
 * Falha na leitura do perfil nunca derruba a decisão da conta da API.
 */
export async function decideInstagramConfirmAcrossAccounts(deps: {
  primary: () => Promise<InstagramConfirmDecision>;
  chromeAuthor: (() => Promise<InstagramConfirmDecision>) | null;
  chromeAuthorUnavailable?: string;
}): Promise<InstagramConfirmAcrossAccounts> {
  const primary = await deps.primary();
  if (primary.kind !== "refuse" || !CHROME_AUTHOR_FALLBACK_CAUSES.has(primary.cause)) return { decision: primary, account: "primary" };
  const who = `@${INSTAGRAM_CHROME_ROUTE.authorUsername}`;
  if (!deps.chromeAuthor) {
    return { decision: primary, account: "primary", ...(deps.chromeAuthorUnavailable ? { fallbackNote: `perfil do ${who} não consultado: ${deps.chromeAuthorUnavailable}` } : {}) };
  }
  let fallback: InstagramConfirmDecision;
  try {
    fallback = await deps.chromeAuthor();
  } catch (e) {
    return { decision: primary, account: "primary", fallbackNote: `a leitura do perfil do ${who} falhou: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (fallback.kind === "register" || fallback.kind === "already_registered") return { decision: fallback, account: "chrome-author" };
  return { decision: primary, account: "primary", fallbackNote: `perfil do ${who}: ${fallback.reason}` };
}

/**
 * Pure (#11390): `--confirm-instagram --url URL` registra o Reel pela URL que
 * o editor copiou (sem conferência pela API). Só aceita permalink do instagram.com (`/reel/`, `/reels/`, `/p/`,
 * com ou sem o usuário antes); a query (`?igsh=...`) sai do registro.
 */
export function instagramConfirmUrlEntry(url: string, nowIso: string): { ok: true; entry: ShortPublishedEntry } | { ok: false; error: string } {
  const m = url.trim().match(/^https:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:reel|reels|p)\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/);
  if (!m) return { ok: false, error: `--url precisa ser o permalink do Reel no instagram.com (https://www.instagram.com/reel/CODIGO/), recebido ${JSON.stringify(url)}` };
  const clean = url.trim().replace(/[?#].*$/, "");
  return { ok: true, entry: { destination: "instagram", status: "published", id: clean, url: clean, scheduled_at: null, at: nowIso } };
}

export interface ChromeAuthorResolution {
  reader: Extract<InstagramAuthor, { ready: true }> | null;
  unavailable?: string;
  sameAccount?: true;
  /** #11427: a credencial existe, mas a leitura da conta vinculada falhou (transitório). */
  readFailed?: true;
}

/**
 * #11390: o leitor do perfil do autor da rota do Chrome (@diar.ia.br, #11794), só
 * leitura. `reader` null = não consultável (mesma conta da API, sem credencial, ou
 * a leitura falhou — `readFailed`, #11427), com o motivo em `unavailable`.
 * Compara por `instagramAccountKey`: `instagram_author_page: null` (a conta do
 * env) e a página `diaria` são a mesma conta, e nenhuma credencial de página é
 * pedida nesse caso.
 */
export async function resolveChromeAuthorReader(
  apiAuthorPage: string | null,
  pages: ResolvedFacebookPage[],
  igApiVersion: string,
  deps: Pick<GraphDeps, "fetch"> = defaultGraphDeps,
): Promise<ChromeAuthorResolution> {
  if (instagramAccountKey(apiAuthorPage) === instagramAccountKey(INSTAGRAM_CHROME_ROUTE.authorPage)) return { reader: null, unavailable: "é a mesma conta da API", sameAccount: true };
  const resolved = await resolveInstagramAuthor(deps, INSTAGRAM_CHROME_ROUTE.authorPage, pages, igApiVersion, { igUserId: "", token: "" }, { readOnly: true });
  if (resolved.ready) return { reader: resolved };
  return { reader: null, unavailable: resolved.reason, ...(resolved.readFailed ? { readFailed: true as const } : {}) };
}

/**
 * Pure (#11794): o perfil do autor resolvido → as deps do
 * `decideInstagramConfirmAcrossAccounts`. Mesma conta da API não tem segundo
 * perfil a consultar, então a recusa não leva nota de "perfil não consultado".
 */
export function confirmChromeAuthorDeps(
  chrome: ChromeAuthorResolution,
  readFor: (igUserId: string, token: string) => () => Promise<InstagramConfirmDecision>,
): { chromeAuthor: (() => Promise<InstagramConfirmDecision>) | null; chromeAuthorUnavailable?: string } {
  if (chrome.reader) return { chromeAuthor: readFor(chrome.reader.igUserId, chrome.reader.token) };
  if (chrome.sameAccount || chrome.unavailable === undefined) return { chromeAuthor: null };
  return { chromeAuthor: null, chromeAuthorUnavailable: chrome.unavailable };
}

/**
 * Pure (#11794): de quem o `--confirm-instagram` cobra o collab. O Reels achado na
 * conta da autora da rota do Chrome (no perfil dela ou porque ela é a conta da
 * API) exige a @vjpixel mesmo que `instagram_collaborators` mude; em outra conta
 * da API, valem só os do config.
 */
export function instagramConfirmExpectedCollabs(input: {
  account: InstagramConfirmAcrossAccounts["account"];
  sameAccount: boolean;
  configCollaborators: string[];
}): string[] {
  const routeCollab: string = INSTAGRAM_CHROME_ROUTE.collaboratorUsername;
  if (input.account === "chrome-author") return [routeCollab];
  if (!input.sameAccount) return input.configCollaborators;
  return input.configCollaborators.includes(routeCollab) ? input.configCollaborators : [...input.configCollaborators, routeCollab];
}

/**
 * Pure (#11427): o perfil do autor resolvido → as deps do
 * `decideInstagramTimerAcrossAccounts`. Leitura que falhou com a credencial
 * presente NÃO é "sem credencial": vira um `chromeAuthor` que lança, e o gate
 * classifica como `read-failed` (urgente, a próxima rodada tenta de novo) em
 * vez de `author-unchecked` (alarme `acao` que manda fornecer a credencial e
 * suprime o `late` da edição). Só é consultado quando a conta da API não tem
 * o Reels, como antes.
 */
export function timerChromeAuthorDeps(
  chrome: ChromeAuthorResolution,
  readFor: (igUserId: string, token: string) => () => Promise<InstagramConfirmDecision>,
): { chromeAuthor: (() => Promise<InstagramConfirmDecision>) | null; chromeAuthorUnavailable?: string } {
  if (chrome.reader) return { chromeAuthor: readFor(chrome.reader.igUserId, chrome.reader.token) };
  if (chrome.sameAccount) return { chromeAuthor: null };
  const why = chrome.unavailable ?? "sem credencial";
  if (chrome.readFailed) {
    return {
      chromeAuthor: async () => {
        throw new Error(why);
      },
    };
  }
  return { chromeAuthor: null, chromeAuthorUnavailable: why };
}

/**
 * #11389/#11390 (fix do review do PR #11395): a conferência da conta ANTES de o
 * timer publicar olha também o perfil do autor da rota do Chrome, quando ele é
 * outra conta. Na config de produção (#11794) a autora à mão é a própria conta da
 * API: o Reels aparece nela depois do processamento (30 a 60 s), e a leitura da
 * API basta; uma rodada dentro desses segundos não o vê e publica. Reel só na
 * @vjpixel não é lido, risco aceito (#11794: nunca postar por essa conta). Com
 * `instagram_author_page` em outra página, um Reels à mão não apareceria na conta
 * da API e o timer publicaria de novo, em conta pública. Regras:
 * - a conta da API acha o Reels, ou bloqueia (ambíguo/janela) → vale ela;
 * - nada na conta da API → a decisão do perfil do autor, se ele achou ou
 *   bloqueou; se ele também não tem nada, segue a da API (publica);
 * - leitura do perfil que falha → propaga (o gate vira `read-failed` e não
 *   publica: fail-closed, igual à leitura da conta da API);
 *   inclui a leitura da conta vinculada à página do autor com a credencial
 *   presente (#11427, `timerChromeAuthorDeps`): é transitória, não
 *   `author-unchecked`;
 * - perfil não consultável por ser a mesma conta da API (`chromeAuthor` null,
 *   sem `chromeAuthorUnavailable`) → segue a da API: ela já é o perfil do autor;
 * - perfil não consultável por falta da credencial da página do autor
 *   (`chromeAuthor` null com `chromeAuthorUnavailable`) → fail-closed (#11421):
 *   lança `InstagramTimerGateError` `author-unchecked` e não publica. Um Reels
 *   postado à mão seria invisível e a API duplicaria o post
 *   em conta pública; o timer alarma para o editor postar pelo Chrome ou prover
 *   a credencial. Só vale quando a conta da API não tem nada: achado/bloqueio
 *   nela continua decidindo sozinho.
 */
export async function decideInstagramTimerAcrossAccounts(deps: {
  primary: () => Promise<InstagramConfirmDecision>;
  chromeAuthor: (() => Promise<InstagramConfirmDecision>) | null;
  /** Por que o perfil do autor não é consultável (sem credencial). Ausente com `chromeAuthor` null = mesma conta da API. */
  chromeAuthorUnavailable?: string;
}): Promise<InstagramConfirmDecision> {
  const primary = await deps.primary();
  if (primary.kind !== "refuse" || (primary.cause !== "none" && primary.cause !== "no-match")) return primary;
  if (!deps.chromeAuthor) {
    if (deps.chromeAuthorUnavailable === undefined) return primary;
    throw new InstagramTimerGateError(
      `o perfil do @${INSTAGRAM_CHROME_ROUTE.authorUsername} não foi conferido (${deps.chromeAuthorUnavailable}) — um Reels postado à mão fica nesse perfil, não na conta da API; o timer não publica sem conferir. Poste pelo Chrome ou forneça a credencial da página ${INSTAGRAM_CHROME_ROUTE.authorPage} no 300`,
      "author-unchecked",
    );
  }
  const author = await deps.chromeAuthor();
  if (author.kind === "refuse" && (author.cause === "none" || author.cause === "no-match")) return primary;
  return author;
}

export type InstagramTimerAlreadyMatch = "registry" | "marker" | "time-window" | "media-id";

export type InstagramTimerPreflight =
  | { kind: "proceed" }
  /** O Reels da edição já está na conta (registrado ou achado pela API): grava, não publica. */
  | { kind: "already"; entry: ShortPublishedEntry; matchedBy: InstagramTimerAlreadyMatch }
  /** Pode haver Reels da edição na conta e não dá pra afirmar qual: não publica. */
  | { kind: "block"; reason: string };

/**
 * Pure (#11265): antes de o timer do 300 publicar o Reels, a conta já tem o da
 * edição? Cobre o Share feito por fora (Chrome/app) sem `--confirm-instagram`:
 * o registro não sabe, a conta sabe. Achou → grava e não publica; ambíguo ou
 * leitura incompleta → não publica (o timer avisa); nada → publica.
 */
export function instagramTimerPreflight(decision: InstagramConfirmDecision): InstagramTimerPreflight {
  if (decision.kind === "already_registered") return { kind: "already", entry: decision.entry, matchedBy: "registry" };
  if (decision.kind === "register") return { kind: "already", entry: decision.entry, matchedBy: decision.matchedBy };
  if (decision.cause === "none" || decision.cause === "no-match") return { kind: "proceed" };
  return { kind: "block", reason: decision.reason };
}

/**
 * #11265: por que a conferência da conta do timer não deixou publicar.
 * `blocked` = pode haver Reels da edição na conta (ambíguo, janela ou media-id);
 * `read-failed` = a leitura do `/media` falhou; `persist-failed` = o Reels foi
 * ACHADO na conta, mas o registro não foi gravado (`entry` = o achado);
 * `author-unchecked` (#11421) = nada na conta da API, mas o perfil do autor da
 * rota do Chrome, sendo outra conta, não pôde ser conferido (sem credencial).
 */
export type InstagramTimerGateFailure = "blocked" | "read-failed" | "persist-failed" | "author-unchecked";

/**
 * #11265: erro da conferência da conta do timer. O resultado do destino leva
 * `cause: "preflight"` no JSON, para o timer distinguir "o gate não deixou
 * publicar" (nunca sugerir `--publish`: pode duplicar o Reels) de "o publish
 * falhou".
 */
export class InstagramTimerGateError extends Error {
  readonly failure: InstagramTimerGateFailure;
  readonly entry?: ShortPublishedEntry;
  constructor(message: string, failure: InstagramTimerGateFailure, entry?: ShortPublishedEntry) {
    super(message);
    this.name = "InstagramTimerGateError";
    this.failure = failure;
    if (entry) this.entry = entry;
  }
}

/**
 * #11265: a conferência da conta ligada ao publish da rodada do timer, com I/O
 * injetável. Reels já no ar → grava (`persist`) e não publica; ambíguo ou
 * leitura incompleta → lança (o destino vira falha e o timer alarma, nunca
 * publica); achado só pela janela de horário → lança `blocked` sem gravar
 * (#11368); nada na conta → publica. Erro da leitura também lança
 * (fail-closed: a próxima execução de hora em hora tenta de novo). Todo erro
 * daqui é `InstagramTimerGateError` (`persist-failed` carrega o Reels achado).
 */
export async function instagramTimerGate(deps: {
  decide: () => Promise<InstagramConfirmDecision>;
  persist: (entry: ShortPublishedEntry) => void;
  /**
   * #11795: como registrar o Reels achado (a mensagem do bloqueio). Default: o
   * `--confirm-instagram --media-id` da edição; o corte avulso, que não tem
   * `--confirm-instagram`, passa o `--mark instagram=URL` do comando dele.
   */
  registerHint?: (mediaId?: string) => string;
}): Promise<{ kind: "publish" } | { kind: "already"; entry: ShortPublishedEntry; matchedBy: InstagramTimerAlreadyMatch }> {
  const hint = deps.registerHint ?? ((mediaId?: string) => `--confirm-instagram --media-id ${mediaId ?? "ID"}`);
  let decision: InstagramConfirmDecision;
  try {
    decision = await deps.decide();
  } catch (e) {
    if (e instanceof InstagramTimerGateError) throw e; // #11421: `author-unchecked` não é falha de leitura
    throw new InstagramTimerGateError(`a leitura da conta do Instagram falhou (${e instanceof Error ? e.message : String(e)}) — o timer não publica sem conferir`, "read-failed");
  }
  const pre = instagramTimerPreflight(decision);
  if (pre.kind === "block") {
    throw new InstagramTimerGateError(`a conta pode já ter o Reels da edição (${pre.reason}) — o timer não publica; confira e registre com ${hint()}`, "blocked");
  }
  if (pre.kind === "already" && pre.matchedBy === "time-window") {
    // #11368: achado só pela janela de ±90 min, sem o marcador da edição — pode
    // ser o Reels de OUTRA edição postado atrasado. O timer não registra (o
    // registro errado esconderia o Reels de hoje) nem publica: o editor confere.
    const where = pre.entry.url ?? pre.entry.id;
    throw new InstagramTimerGateError(
      `um Reels sem o marcador da edição está perto do horário (${where}, só pela janela de horário) — pode ser de outra edição; o timer não registra nem publica. Se for o desta edição, registre com ${hint(pre.entry.id)}`,
      "blocked",
    );
  }
  if (pre.kind === "already") {
    try {
      deps.persist(pre.entry);
    } catch (e) {
      throw new InstagramTimerGateError(`registro não gravado: ${e instanceof Error ? e.message : String(e)}`, "persist-failed", pre.entry);
    }
    return pre;
  }
  return { kind: "publish" };
}

/**
 * #11368: o passo do Instagram na rodada do timer, com I/O injetável — a
 * conferência da conta SEMPRE antes do upload. Reels já na conta → nada sobe;
 * gate que lança → nada sobe (o erro segue pro chamador).
 */
export async function instagramTimerPublishStep<T>(deps: {
  gate: () => ReturnType<typeof instagramTimerGate>;
  publish: () => Promise<T>;
}): Promise<{ kind: "already"; entry: ShortPublishedEntry; matchedBy: InstagramTimerAlreadyMatch } | { kind: "published"; outcome: T }> {
  const gate = await deps.gate();
  if (gate.kind === "already") return gate;
  return { kind: "published", outcome: await deps.publish() };
}

/**
 * #11828: o timer achou o Reels feito à mão na conta e o registrou sem publicar.
 * Relê `/{media}/collaborators` e devolve um aviso quando falta um collab
 * esperado (a @vjpixel, na rota do Chrome). Nunca lança nem bloqueia: o registro
 * já foi gravado e o Reels está no ar. `registry` não relê, porque nada foi
 * gravado nesta rodada (o registro veio de antes).
 */
export async function instagramTimerAlreadyCollabWarnings(
  deps: Pick<GraphDeps, "fetch">,
  input: { matchedBy: InstagramTimerAlreadyMatch; mediaId: string; token: string; apiVersion: string; expected: string[] },
): Promise<string[]> {
  if (input.matchedBy === "registry" || input.expected.length === 0) return [];
  return checkInstagramCollaborators(deps, input.mediaId, input.token, input.apiVersion, input.expected);
}

/**
 * #11774: a reconferência logo antes do `media_publish` na rodada do timer. O
 * gate da conta roda antes do upload no R2; o upload e o processamento levam
 * minutos, e um Share feito por fora nesse meio tempo não está no registro
 * local. Por isso, depois do registro local (sem custo de rede), o gate da conta
 * roda de novo: Reels achado → grava e não publica; gate que lança → não publica
 * (o erro segue como `cause: "preflight"`).
 */
export function instagramTimerBeforePublish(deps: {
  local: () => ShortPublishedEntry | null;
  gate: () => ReturnType<typeof instagramTimerGate>;
  /**
   * #11870: o gate da conta achou o Reels nesta reconferência (e gravou). Leva o
   * `matchedBy` ao chamador, que relê os collabs como no passo `already` do
   * início da rodada (#11828). O achado no registro local não chama: nada foi
   * gravado por esta rodada.
   */
  onAlready?: (hit: { entry: ShortPublishedEntry; matchedBy: InstagramTimerAlreadyMatch }) => void;
}): () => Promise<ShortPublishedEntry | null> {
  return async () => {
    const local = deps.local();
    if (local) return local;
    const gate = await deps.gate();
    if (gate.kind !== "already") return null;
    deps.onAlready?.({ entry: gate.entry, matchedBy: gate.matchedBy });
    return gate.entry;
  };
}

/**
 * Pure (#10978): a leitura do `/media` já tem o que procura? Com `mediaId`,
 * quando a mídia apareceu. Sem ele, quando a página mais recente lida já
 * chegou a uma mídia anterior ao `sinceIso` — o `/media` vem do mais novo pro
 * mais velho, então as páginas seguintes só trazem mídia fora da janela (e a
 * janela inteira precisa ser lida pra a recusa por ambiguidade valer).
 */
export function instagramMediaPagingDone(input: { lastPage: unknown[]; all: unknown[]; sinceIso?: string | null; mediaId?: string | null }): boolean {
  if (input.mediaId) return input.all.some((m: any) => m?.id === input.mediaId);
  const since = input.sinceIso ? Date.parse(input.sinceIso) : Number.NaN;
  if (Number.isNaN(since)) return false;
  return input.lastPage.some((m: any) => parseIgTimestamp(m?.timestamp) < since);
}

/**
 * #10915: lê `/{ig-user}/media` com a legenda, pro `decideInstagramConfirm`.
 * Só leitura: nunca cria container nem publica. Desde #10978 segue
 * `paging.next` (até `maxPages`, default `INSTAGRAM_CONFIRM_MAX_PAGES`) e
 * para assim que `instagramMediaPagingDone` diz que já achou. Devolve
 * `{ data }` com todas as páginas lidas, na ordem da API, e `windowCovered`:
 * `false` quando parou no teto sem chegar ao `sinceIso` (a decisão recusa).
 */
export async function fetchInstagramRecentMedia(
  deps: Pick<GraphDeps, "fetch">,
  igUserId: string,
  token: string,
  apiVersion: string,
  opts: { sinceIso?: string | null; mediaId?: string | null; maxPages?: number } = {},
): Promise<{ data: unknown[]; pages: number; more: boolean; windowCovered: boolean }> {
  // NaN/Infinity/undefined caem no teto padrão — nunca "sem limite".
  const maxPages = typeof opts.maxPages === "number" && Number.isFinite(opts.maxPages) ? Math.max(1, Math.floor(opts.maxPages)) : INSTAGRAM_CONFIRM_MAX_PAGES;
  let page: any = await graphGet(
    deps as GraphDeps,
    `${igUserId}/media`,
    { fields: "id,permalink,timestamp,media_product_type,media_type,caption", limit: String(INSTAGRAM_CONFIRM_MEDIA_LIMIT), access_token: token },
    apiVersion,
  );
  const all: unknown[] = [];
  let pages = 0;
  for (;;) {
    if (!Array.isArray(page?.data)) throw new Error(`GET ${igUserId}/media sem lista: ${JSON.stringify(page ?? null).slice(0, 200)}`);
    all.push(...page.data);
    pages++;
    const next = typeof page?.paging?.next === "string" ? page.paging.next : null;
    if (!next) return { data: all, pages, more: false, windowCovered: true };
    if (instagramMediaPagingDone({ lastPage: page.data, all, sinceIso: opts.sinceIso, mediaId: opts.mediaId })) {
      return { data: all, pages, more: true, windowCovered: true };
    }
    // Bateu o teto sem chegar ao corte: a janela pode ter mais Reels não lidos.
    if (pages >= maxPages) return { data: all, pages, more: true, windowCovered: false };
    // O `next` já traz o access_token: só segue se for o próprio Graph.
    if (new URL(next).origin !== GRAPH) throw new Error(`GET ${igUserId}/media: paging.next fora do Graph (${new URL(next).origin})`);
    const res = await deps.fetch(next);
    page = await readJson(res);
    if (!res.ok || page?.error) throw new Error(`GET ${igUserId}/media (página ${pages + 1}): ${res.status} ${JSON.stringify(page?.error ?? page)}`);
  }
}

/**
 * #10978: miolo do `--confirm-instagram` com I/O injetável — valida o
 * `--since` ANTES de qualquer leitura (um corte inválido não gasta 5 páginas
 * pra só então falhar), lê o `/media` com o corte e o `--media-id`, e decide.
 */
export async function readAndDecideInstagramConfirm(
  deps: Pick<GraphDeps, "fetch">,
  input: {
    igUserId: string;
    token: string;
    apiVersion: string;
    published: ShortsPublishedFile;
    sinceIso: string;
    markers: string[];
    mediaId?: string | null;
    nowIso: string;
    maxPages?: number;
    /** #10978 item 5: horário planejado do Reels (ver `decideInstagramConfirm`). */
    expectedAtIso?: string | null;
    /** #11795: mídias de outro vertical do dia já registradas (o Reels da edição, visto pelo corte): saem da decisão. */
    ignoreIds?: readonly string[];
  },
): Promise<InstagramConfirmDecision> {
  if (Number.isNaN(Date.parse(input.sinceIso))) throw new Error(`--since inválido: ${input.sinceIso}`);
  const read = await fetchInstagramRecentMedia(deps, input.igUserId, input.token, input.apiVersion, {
    sinceIso: input.sinceIso,
    mediaId: input.mediaId ?? null,
    maxPages: input.maxPages,
  });
  const ignore = new Set(input.ignoreIds ?? []);
  const media = ignore.size ? { ...read, data: read.data.filter((m: any) => !ignore.has(m?.id)) } : read;
  return decideInstagramConfirm({
    published: input.published,
    media,
    sinceIso: input.sinceIso,
    markers: input.markers,
    mediaId: input.mediaId ?? null,
    nowIso: input.nowIso,
    windowCovered: media.windowCovered,
    expectedAtIso: input.expectedAtIso ?? null,
  });
}
