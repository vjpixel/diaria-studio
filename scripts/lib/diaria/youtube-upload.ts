/**
 * scripts/lib/diaria/youtube-upload.ts (#10659)
 *
 * Upload REAL do vídeo diário no `@diariabr` (YouTube Data API v3), usado por
 * `scripts/publish-youtube.ts --upload`. Toda a rede passa por `deps.fetch`
 * (injetável), então os testes cobrem o fluxo inteiro com fetch mockado.
 *
 * Sequência:
 *   1. refresh token → access token (`oauth2.googleapis.com/token`), com o
 *      MESMO client OAuth do `youtube-oauth-setup.ts` (PR #10757) e o
 *      `YOUTUBE_REFRESH_TOKEN` que ele grava. Este módulo não muda o fluxo de
 *      auth, só consome o token;
 *   2. `channels.list?mine=true` — confere que o token é do canal esperado
 *      (`YOUTUBE_CHANNEL_ID`) ANTES de subir qualquer byte;
 *   3. `videos.insert` resumable: POST de início (metadados + status com
 *      `privacyStatus`/`publishAt` do plano) → `Location` → PUT dos bytes,
 *      retomado na mesma sessão em falha transitória (#10875);
 *   4. `thumbnails.set` com a capa — falha aqui NÃO desfaz o vídeo, só vira
 *      `thumbnail.ok = false` no resultado;
 *   5. releitura de `videos.list?part=status` e normalização por
 *      `resolveYouTubeState` (#573) — o estado relatado é o RELIDO, nunca o
 *      pedido. Sem a auditoria do YouTube API Services o vídeo PODE sair
 *      travado em `private` (restrição de 28/07/2020 no revision history; a
 *      página atual de `videos.insert` diz o contrário — o 1º upload real
 *      confirma pela releitura, que mostra `draft` ou `scheduled`).
 *
 * Quota (determine_quota_cost, conferido em 22/10/2026): `videos.insert`
 * custa 1 unidade no balde próprio "Video Uploads", limite 100 chamadas/dia;
 * `thumbnails.set` custa 50 unidades no balde geral de 10.000/dia.
 *
 * Erros saem como `YouTubeUploadError` com mensagem curta e acionável, sem
 * token nem stack trace. A mensagem nunca inclui o access/refresh token.
 */

import { resolveYouTubeState, type PublishState } from "../publish-state.ts";
import type { YouTubeInsertRequest } from "./youtube-video.ts";
import { YOUTUBE_THUMBNAIL_ENDPOINT } from "./youtube-video.ts";

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

/** Registro do upload, em `_internal/` da edição. */
export const YOUTUBE_PUBLISHED_FILE = "_internal/05-youtube-published.json";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface YouTubeUploadDeps {
  fetch: FetchLike;
  now: () => Date;
  /** Espera entre retomadas do PUT (#10875). Ausente = sem espera (testes). */
  sleep?: (ms: number) => Promise<void>;
}

export const defaultYouTubeUploadDeps: YouTubeUploadDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Quantas vezes o PUT dos bytes é retomado na MESMA sessão resumable depois de
 * uma falha transitória (rede caindo, 5xx) antes de desistir (#10875).
 */
export const YOUTUBE_UPLOAD_MAX_RESUMES = 5;

/** Backoff exponencial entre retomadas: 1s, 2s, 4s… teto de 30s. */
export function resumeBackoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/** Status que a doc do resumable upload manda retomar (não recomeçar). */
const RETRYABLE_UPLOAD_STATUS = new Set([500, 502, 503, 504]);

/** Etapas que lançam `YouTubeUploadError` (antes do vídeo estar confirmado). */
export type YouTubeUploadStep = "token" | "channel" | "insert" | "upload";
/** Etapas de chamada à API, inclusive as pós-upload que não lançam. */
export type YouTubeApiStep = YouTubeUploadStep | "thumbnail" | "reread";

export class YouTubeUploadError extends Error {
  constructor(
    message: string,
    /**
     * Etapa em que falhou. Até `insert` nenhum byte foi enviado e nada existe
     * no canal. A partir de `upload` o vídeo PODE existir: o PUT pode ter sido
     * aceito mesmo quando a resposta falhou (5xx, rede caindo, corpo sem id).
     */
    readonly step: YouTubeUploadStep,
  ) {
    super(message);
    this.name = "YouTubeUploadError";
  }
}

/** true quando a falha deixa o vídeo em estado incerto (pode ter sido criado). */
export function isIndeterminateUploadFailure(e: unknown): boolean {
  return !(e instanceof YouTubeUploadError) || e.step === "upload";
}

export interface YouTubeCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Canal esperado (`YOUTUBE_CHANNEL_ID`); obrigatório — vazio lança na etapa `channel`. */
  channelId: string;
}

/** Variáveis exigidas pelo upload; devolve as ausentes (só nomes, nunca valores). */
export function missingYouTubeCredentials(env: Record<string, string | undefined>): string[] {
  return ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN", "YOUTUBE_CHANNEL_ID"].filter(
    (k) => !(env[k] ?? "").trim(),
  );
}

/** Buffer → corpo de fetch sem copiar os bytes (o vídeo pode ter centenas de MB). */
function asBody(buf: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.length);
}

/** Lê um trecho do corpo de erro sem estourar (e sem nunca ecoar o request). */
async function errorSnippet(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/** Lê o corpo como JSON; `undefined` quando o corpo não é JSON (distinto de `null`). */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * Explica falhas de `videos.insert`/`thumbnails.set`/token sem expor nada
 * sensível. Cobre os motivos que o editor consegue resolver sozinho. `step`
 * restringe mensagens que só fazem sentido numa etapa (ex.: capa customizada).
 */
export function explainYouTubeUploadError(status: number, body: string, step?: YouTubeApiStep): string {
  if (/invalid_grant/i.test(body)) {
    return "refresh token do YouTube inválido ou expirado — rode `npx tsx scripts/youtube-oauth-setup.ts` de novo (e `npm run sync-env` no 300)";
  }
  if (/invalid_client|unauthorized_client/i.test(body)) {
    // #8237: o app desktop injeta GOOGLE_CLIENT_* no ambiente com valores de OUTRO
    // client, e `loadProjectEnv` não sobrescreve var já presente. Refazer o
    // consentimento não resolve — o client errado é o do ambiente.
    return (
      "o Google recusou o client OAuth (invalid_client/unauthorized_client) — provável divergência entre " +
      "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET do ambiente do processo e os do `.env` (#8237, ver o aviso de divergência " +
      "do `loadProjectEnv` no stderr). Rode com as vars do ambiente removidas antes de refazer o consentimento"
    );
  }
  if (status === 401) {
    return "o YouTube recusou o token (401) — refaça o consentimento com `npx tsx scripts/youtube-oauth-setup.ts`";
  }
  if (status === 403 && /quotaExceeded|dailyLimitExceeded/i.test(body)) {
    return (
      "quota diária da YouTube Data API esgotada (videos.insert: balde próprio \"Video Uploads\", 100 chamadas/dia; " +
      "thumbnails.set: 50 unidades do balde geral de 10.000/dia) — tente amanhã ou suba à mão no Studio"
    );
  }
  if (status === 403 && /uploadLimitExceeded/i.test(body)) {
    return "o canal atingiu o limite de uploads do YouTube — suba à mão no Studio mais tarde";
  }
  if (status === 403 && /insufficientPermissions|insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(body)) {
    return "token sem o escopo youtube.upload — refaça o consentimento deixando os 2 escopos marcados (`scripts/youtube-oauth-setup.ts`)";
  }
  if (status === 403 && /accessNotConfigured|has not been used|is disabled/i.test(body)) {
    return "YouTube Data API v3 não está ativada no projeto GCP do client OAuth";
  }
  if (status === 403 && /forbidden/i.test(body)) {
    return step === "thumbnail"
      ? "o YouTube recusou a capa (403 forbidden) — para capa customizada o canal precisa estar verificado (youtube.com/verify)"
      : `o YouTube recusou (403 forbidden${step ? `, etapa ${step}` : ""}) — o token não tem permissão para essa operação neste canal`;
  }
  return `YouTube API respondeu ${status}: ${body.slice(0, 300)}`;
}

/** Troca o refresh token por um access token. */
export async function refreshYouTubeAccessToken(deps: YouTubeUploadDeps, creds: YouTubeCredentials): Promise<string> {
  let res: Response;
  try {
    res = await deps.fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch (e) {
    throw new YouTubeUploadError(`sem rede para renovar o token do YouTube: ${(e as Error).message}`, "token");
  }
  if (!res.ok) throw new YouTubeUploadError(explainYouTubeUploadError(res.status, await errorSnippet(res), "token"), "token");
  const json = (await readJson(res)) as { access_token?: unknown } | null | undefined;
  if (json === undefined) {
    throw new YouTubeUploadError(`a troca do refresh token devolveu corpo não-JSON (HTTP ${res.status})`, "token");
  }
  if (!json || typeof json.access_token !== "string" || !json.access_token) {
    throw new YouTubeUploadError("a troca do refresh token não devolveu access_token", "token");
  }
  return json.access_token;
}

/** Confere que o token pertence ao canal esperado antes de subir qualquer byte. */
export async function assertExpectedChannel(deps: YouTubeUploadDeps, token: string, expectedChannelId: string): Promise<void> {
  if (!expectedChannelId.trim()) {
    throw new YouTubeUploadError("canal esperado vazio (YOUTUBE_CHANNEL_ID) — sem ele não dá para conferir o token; nada foi enviado", "channel");
  }
  let res: Response;
  try {
    res = await deps.fetch(`${YOUTUBE_API_BASE}/channels?part=id&mine=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    throw new YouTubeUploadError(`sem rede para conferir o canal do token: ${(e as Error).message}`, "channel");
  }
  if (!res.ok) throw new YouTubeUploadError(explainYouTubeUploadError(res.status, await errorSnippet(res), "channel"), "channel");
  const json = (await readJson(res)) as { items?: Array<{ id?: unknown }> } | null | undefined;
  if (json === undefined) {
    throw new YouTubeUploadError(`channels.list devolveu corpo não-JSON (HTTP ${res.status}) — nada foi enviado`, "channel");
  }
  const ids = (json?.items ?? []).map((i) => i.id).filter((id): id is string => typeof id === "string");
  if (!ids.includes(expectedChannelId)) {
    throw new YouTubeUploadError(
      `o token não é do canal esperado (YOUTUBE_CHANNEL_ID=${expectedChannelId}; token vê ${ids.join(", ") || "nenhum canal"}) — nada foi enviado`,
      "channel",
    );
  }
}

/** POST de início do resumable upload; devolve a URL de sessão (`Location`). */
export async function startResumableUpload(deps: YouTubeUploadDeps, token: string, request: YouTubeInsertRequest): Promise<string> {
  let res: Response;
  try {
    res = await deps.fetch(request.url, {
      method: request.method,
      headers: { ...request.headers, Authorization: `Bearer ${token}` },
      body: JSON.stringify(request.body),
    });
  } catch (e) {
    throw new YouTubeUploadError(`sem rede para abrir a sessão de upload (videos.insert): ${(e as Error).message}`, "insert");
  }
  if (!res.ok) throw new YouTubeUploadError(explainYouTubeUploadError(res.status, await errorSnippet(res), "insert"), "insert");
  const location = res.headers.get("location");
  if (!location) throw new YouTubeUploadError("videos.insert não devolveu a URL de upload (header Location)", "insert");
  return location;
}

export interface UploadedVideoResource {
  id: string;
  snippet?: { channelId?: string; title?: string };
  status?: {
    uploadStatus?: string;
    privacyStatus?: string;
    publishAt?: string | null;
    /** Presente quando `uploadStatus = rejected`. */
    rejectionReason?: string;
    /** Presente quando `uploadStatus = failed`. */
    failureReason?: string;
  };
}

/**
 * Bytes já confirmados pelo servidor a partir do header `Range` de uma
 * resposta 308 (`bytes=0-N` → N+1). Sem header = nada recebido (0).
 */
export function parseUploadedRange(range: string | null, total: number): number {
  if (!range) return 0;
  const m = /^bytes=0-(\d+)$/.exec(range.trim());
  if (!m) throw new YouTubeUploadError(`a sessão de upload devolveu Range inesperado: ${JSON.stringify(range.slice(0, 80))}`, "upload");
  const received = Number(m[1]) + 1;
  if (received > total) {
    throw new YouTubeUploadError(`a sessão de upload diz ter recebido ${received} bytes de um vídeo de ${total}`, "upload");
  }
  return received;
}

/** Resultado de uma ida à sessão resumable (envio de bytes ou consulta de status). */
type UploadAttempt =
  | { kind: "done"; res: Response }
  | { kind: "incomplete"; received: number }
  | { kind: "transient"; why: string };

/**
 * Classifica a resposta de um PUT na sessão: 2xx = terminou; 308 = parcial
 * (retomar do `Range`); 5xx da lista de retomada = transitório; resto lança.
 */
async function classifyUploadResponse(res: Response, total: number): Promise<UploadAttempt> {
  if (res.ok) return { kind: "done", res };
  if (res.status === 308) return { kind: "incomplete", received: parseUploadedRange(res.headers.get("range"), total) };
  const body = await errorSnippet(res);
  if (RETRYABLE_UPLOAD_STATUS.has(res.status)) return { kind: "transient", why: explainYouTubeUploadError(res.status, body, "upload") };
  if (res.status === 404 || res.status === 410) {
    throw new YouTubeUploadError(
      `a sessão de upload expirou (HTTP ${res.status}) — não dá para retomar; confira o canal antes de subir de novo`,
      "upload",
    );
  }
  throw new YouTubeUploadError(explainYouTubeUploadError(res.status, body, "upload"), "upload");
}

/**
 * PUT dos bytes na sessão resumable; devolve o resource `videos` criado.
 *
 * Retomável (#10875): em falha transitória (rede caindo, 500/502/503/504) ou
 * resposta 308 parcial, consulta a MESMA `sessionUrl` (PUT vazio com o
 * Content-Range de consulta, `bytes ` + `*` + `/N`) e reenvia só a partir do último byte
 * confirmado, até `maxResumes` retomadas. Esgotadas, lança na etapa `upload`
 * (o vídeo PODE existir — `isIndeterminateUploadFailure`).
 */
export async function putVideoBytes(
  deps: YouTubeUploadDeps,
  token: string,
  sessionUrl: string,
  file: Buffer,
  contentType: string,
  opts: { maxResumes?: number } = {},
): Promise<UploadedVideoResource> {
  const total = file.length;
  const maxResumes = opts.maxResumes ?? YOUTUBE_UPLOAD_MAX_RESUMES;
  const sleep = deps.sleep ?? (async () => {});

  /** Envia `file[offset..]`. offset 0 = PUT inteiro, como na 1ª tentativa. */
  const sendFrom = async (offset: number): Promise<UploadAttempt> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
      "Content-Length": String(total - offset),
    };
    if (offset > 0) headers["Content-Range"] = `bytes ${offset}-${total - 1}/${total}`;
    let res: Response;
    try {
      res = await deps.fetch(sessionUrl, {
        method: "PUT",
        headers,
        body: asBody(offset > 0 ? file.subarray(offset) : file),
        redirect: "manual",
      });
    } catch (e) {
      return { kind: "transient", why: `envio dos bytes do vídeo falhou (rede): ${(e as Error).message}` };
    }
    return classifyUploadResponse(res, total);
  };

  /** Consulta quantos bytes a sessão já confirmou. */
  const queryStatus = async (): Promise<UploadAttempt> => {
    let res: Response;
    try {
      res = await deps.fetch(sessionUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Length": "0", "Content-Range": `bytes */${total}` },
        redirect: "manual",
      });
    } catch (e) {
      return { kind: "transient", why: `consulta da sessão de upload falhou (rede): ${(e as Error).message}` };
    }
    return classifyUploadResponse(res, total);
  };

  let offset = 0;
  let resumes = 0;
  let next: "send" | "query" = "send";
  let res: Response;
  for (;;) {
    const attempt = next === "send" ? await sendFrom(offset) : await queryStatus();
    if (attempt.kind === "done") {
      res = attempt.res;
      break;
    }
    if (attempt.kind === "incomplete" && next === "query" && attempt.received < total) {
      // Resposta da consulta: retoma do byte confirmado sem contar tentativa.
      offset = attempt.received;
      next = "send";
      continue;
    }
    // Falha transitória, ou envio que terminou parcial: conta uma retomada.
    resumes++;
    const why = attempt.kind === "transient" ? attempt.why : `a sessão confirmou só ${attempt.received} de ${total} bytes`;
    if (resumes > maxResumes) {
      throw new YouTubeUploadError(`${why} — upload interrompido após ${maxResumes} retomadas da mesma sessão`, "upload");
    }
    if (attempt.kind === "incomplete" && attempt.received < total) {
      offset = attempt.received;
      next = "send";
    } else {
      next = "query";
    }
    await sleep(resumeBackoffMs(resumes));
  }

  const json = (await readJson(res)) as UploadedVideoResource | null | undefined;
  if (json === undefined) {
    throw new YouTubeUploadError(`o upload terminou com corpo não-JSON (HTTP ${res.status}), sem o id do vídeo`, "upload");
  }
  if (!json || typeof json.id !== "string" || !json.id) {
    throw new YouTubeUploadError("o upload terminou sem devolver o id do vídeo — confira no YouTube Studio antes de tentar de novo", "upload");
  }
  return json;
}

/** `thumbnails.set` com a capa JPEG. */
export async function setThumbnail(deps: YouTubeUploadDeps, token: string, videoId: string, jpeg: Buffer): Promise<void> {
  const res = await deps.fetch(`${YOUTUBE_THUMBNAIL_ENDPOINT}?videoId=${encodeURIComponent(videoId)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/jpeg", "Content-Length": String(jpeg.length) },
    body: asBody(jpeg),
  });
  if (!res.ok) throw new Error(explainYouTubeUploadError(res.status, await errorSnippet(res), "thumbnail"));
}

/** Relê `status` do vídeo. `null` se a API não devolver o item. */
export async function fetchVideoStatus(
  deps: YouTubeUploadDeps,
  token: string,
  videoId: string,
): Promise<UploadedVideoResource["status"] | null> {
  const res = await deps.fetch(`${YOUTUBE_API_BASE}/videos?part=status&id=${encodeURIComponent(videoId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(explainYouTubeUploadError(res.status, await errorSnippet(res), "reread"));
  const json = (await readJson(res)) as { items?: UploadedVideoResource[] } | null | undefined;
  if (json === undefined) throw new Error(`videos.list devolveu corpo não-JSON (HTTP ${res.status})`);
  const item = json?.items?.find((i) => i.id === videoId);
  return item?.status ?? null;
}

// ─── Vídeo da edição já no canal (#11080) ────────────────────────────────────

/** Critérios para reconhecer um vídeo da MESMA edição já no canal. */
export interface EditionVideoCriteria {
  aammdd: string;
  /** Título que o upload usaria (o do D1). */
  title: string;
}

/** Como o vídeo existente foi reconhecido (do sinal mais forte ao mais fraco). */
export type EditionVideoMatch = "edition-tag" | "title" | "period";

export interface ExistingEditionVideo {
  videoId: string;
  url: string;
  title: string;
  matchedBy: EditionVideoMatch;
  publishedAt: string | null;
  status: UploadedVideoResource["status"] | null;
}

/** Quantos uploads recentes o canal é varrido (1 unidade de quota por página). */
export const EXISTING_VIDEO_SCAN_SIZE = 25;

/** Janela [início, fim) do dia da edição em BRT (UTC-3), em ms. */
export function editionDayWindowMs(aammdd: string): { startMs: number; endMs: number } {
  if (!/^\d{6}$/.test(aammdd)) throw new Error(`AAMMDD inválido: ${JSON.stringify(aammdd)}`);
  const startMs = Date.UTC(2000 + Number(aammdd.slice(0, 2)), Number(aammdd.slice(2, 4)) - 1, Number(aammdd.slice(4, 6)), 3);
  return { startMs, endMs: startMs + 86_400_000 };
}

interface VideoListItem {
  id?: string;
  snippet?: { title?: string; description?: string; tags?: string[]; publishedAt?: string };
  status?: UploadedVideoResource["status"];
}

function normalizeTitle(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Decide se algum dos vídeos é o desta edição. Sinais, do mais forte ao mais
 * fraco: (1) AAMMDD — `utm_campaign=AAMMDD` na descrição (nosso upload) ou
 * AAMMDD como token no título/tags; (2) título igual ao do D1; (3) período —
 * `publishAt` ou `publishedAt` dentro do dia BRT da edição. Shorts (vertical,
 * `/diaria-shorts`) ficam de fora do sinal de período: são OUTRO vídeo.
 *
 * #11103: (a) descrição com `utm_campaign=` de OUTRA edição (e nenhum da
 * nossa) prova que o vídeo é daquela edição — título e período deixam de
 * valer (ex.: o vídeo de ontem que virou público hoje); (b) vídeo com
 * `uploadStatus` falho (`failedUploadStatus`) nunca é reconhecido — não vai
 * ao ar, então o upload normal segue em vez de gravar um link morto no D1.
 *
 * #11132: `period` é o sinal fraco — qualquer vídeo não-Short do dia (live,
 * avulso) casa. O chamador (`publish-youtube.ts`) não o trata como prova: sem
 * confirmação do editor (`--accept-period-match`) não envia nem grava o link.
 * Puro: sem rede.
 */
export function matchEditionVideo(videos: VideoListItem[], criteria: EditionVideoCriteria): ExistingEditionVideo | null {
  const { aammdd } = criteria;
  const token = new RegExp(`(?<!\\d)${aammdd}(?!\\d)`);
  const campaignRe = /utm_campaign=(\d{6})(?!\d)/g;
  const want = normalizeTitle(criteria.title);
  const { startMs, endMs } = editionDayWindowMs(aammdd);
  const inDay = (iso?: string | null): boolean => {
    if (!iso) return false;
    const ms = Date.parse(iso);
    return !Number.isNaN(ms) && ms >= startMs && ms < endMs;
  };
  const found: ExistingEditionVideo[] = [];
  for (const v of videos) {
    if (!v.id) continue;
    if (failedUploadStatus(v.status ?? null)) continue;
    const title = v.snippet?.title ?? "";
    const description = v.snippet?.description ?? "";
    const tags = v.snippet?.tags ?? [];
    const isShort = /#shorts?\b/i.test(`${title} ${description}`) || tags.some((t) => /^#?shorts?$/i.test(t));
    const campaigns = [...description.matchAll(campaignRe)].map((m) => m[1]);
    const otherEdition = campaigns.length > 0 && !campaigns.includes(aammdd);
    let matchedBy: EditionVideoMatch | null = null;
    if (campaigns.includes(aammdd) || token.test(title) || tags.some((t) => token.test(t))) {
      matchedBy = "edition-tag";
    } else if (otherEdition) {
      matchedBy = null;
    } else if (want && normalizeTitle(title) === want) {
      matchedBy = "title";
    } else if (!isShort && (inDay(v.status?.publishAt) || inDay(v.snippet?.publishedAt))) {
      matchedBy = "period";
    }
    if (matchedBy) {
      found.push({
        videoId: v.id,
        url: `https://youtu.be/${v.id}`,
        title,
        matchedBy,
        publishedAt: v.snippet?.publishedAt ?? null,
        status: v.status ?? null,
      });
    }
  }
  const rank: Record<EditionVideoMatch, number> = { "edition-tag": 0, title: 1, period: 2 };
  found.sort((a, b) => rank[a.matchedBy] - rank[b.matchedBy]);
  return found[0] ?? null;
}

/**
 * Lista os uploads recentes do canal (playlist de uploads: 1 unidade por
 * chamada, ao contrário de `search.list`, 100) e devolve o vídeo desta
 * edição, se houver. Com o token do dono a playlist inclui privados e
 * agendados. Falha de API lança `YouTubeUploadError` na etapa `channel`
 * (nada foi enviado): sem a checagem não dá para afirmar que não duplica.
 */
export async function findExistingEditionVideo(
  deps: YouTubeUploadDeps,
  token: string,
  channelId: string,
  criteria: EditionVideoCriteria,
): Promise<ExistingEditionVideo | null> {
  if (!/^UC/.test(channelId)) {
    throw new YouTubeUploadError(`YOUTUBE_CHANNEL_ID inesperado (${channelId}) — não dá para achar a playlist de uploads; nada foi enviado`, "channel");
  }
  const get = async (url: string, what: string): Promise<{ items?: unknown[] }> => {
    let res: Response;
    try {
      res = await deps.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) {
      throw new YouTubeUploadError(`sem rede para conferir se o vídeo já está no canal (${what}): ${(e as Error).message} — nada foi enviado`, "channel");
    }
    if (!res.ok) {
      throw new YouTubeUploadError(
        `não deu para conferir se o vídeo já está no canal (${what}): ${explainYouTubeUploadError(res.status, await errorSnippet(res), "channel")} — nada foi enviado (--force pula a conferência)`,
        "channel",
      );
    }
    const json = (await readJson(res)) as { items?: unknown[] } | null | undefined;
    if (json === undefined) {
      throw new YouTubeUploadError(`${what} devolveu corpo não-JSON (HTTP ${res.status}) — nada foi enviado`, "channel");
    }
    return json ?? {};
  };

  const uploads = `UU${channelId.slice(2)}`;
  const list = await get(
    `${YOUTUBE_API_BASE}/playlistItems?part=contentDetails&maxResults=${EXISTING_VIDEO_SCAN_SIZE}&playlistId=${encodeURIComponent(uploads)}`,
    "playlistItems.list",
  );
  const ids = ((list.items ?? []) as Array<{ contentDetails?: { videoId?: unknown } }>)
    .map((i) => i.contentDetails?.videoId)
    .filter((id): id is string => typeof id === "string" && id !== "");
  if (ids.length === 0) return null;
  const details = await get(`${YOUTUBE_API_BASE}/videos?part=snippet,status&id=${ids.map(encodeURIComponent).join(",")}`, "videos.list");
  return matchEditionVideo((details.items ?? []) as VideoListItem[], criteria);
}

/** Lançada quando a conferência acha o vídeo da edição no canal — nada foi enviado. */
export class ExistingEditionVideoError extends Error {
  constructor(readonly video: ExistingEditionVideo) {
    super(`o vídeo desta edição já está no canal (${video.url}, reconhecido por ${video.matchedBy}) — nada foi enviado`);
    this.name = "ExistingEditionVideoError";
  }
}

export interface YouTubeUploadInput {
  creds: YouTubeCredentials;
  /**
   * Quando presente, confere o canal ANTES de abrir a sessão de upload e lança
   * `ExistingEditionVideoError` se a edição já tem vídeo lá (#11080) — o editor
   * pode ter subido à mão, sem `05-youtube-published.json`.
   */
  existingVideoCheck?: EditionVideoCriteria;
  request: YouTubeInsertRequest;
  video: Buffer;
  contentType?: string;
  /** Capa (JPEG); null = sem `thumbnails.set`. */
  thumbnail: Buffer | null;
  /**
   * Chamado logo antes do PUT dos bytes — o ponto a partir do qual o vídeo
   * pode existir. O CLI grava aqui o marcador `in_progress`. Se lançar, o PUT
   * não acontece (falha na etapa `insert`, nada enviado).
   */
  beforeVideoBytes?: () => void;
}

export interface YouTubeUploadResult {
  videoId: string;
  url: string;
  channelId: string | null;
  /** O que o request pediu (não o que o YouTube aplicou). */
  requested: { privacyStatus: string; publishAt: string | null };
  thumbnail: { attempted: boolean; ok: boolean; error: string | null };
  /** Estado RELIDO (#573), normalizado por `resolveYouTubeState`. */
  state: PublishState;
  /** `status` cru da releitura (null se a releitura falhou). */
  rereadStatus: UploadedVideoResource["status"] | null;
  rereadError: string | null;
  uploadedAt: string;
  rereadAt: string;
}

/**
 * Upload completo. Lança `YouTubeUploadError` até o vídeo estar confirmado (com
 * `step: "upload"` o vídeo PODE existir — ver `isIndeterminateUploadFailure`); depois
 * disso (capa, releitura) nunca lança — falha vira campo no resultado, pra o
 * caller sempre conseguir gravar o videoId e não duplicar o upload.
 */
export async function uploadYouTubeVideo(deps: YouTubeUploadDeps, input: YouTubeUploadInput): Promise<YouTubeUploadResult> {
  const token = await refreshYouTubeAccessToken(deps, input.creds);
  await assertExpectedChannel(deps, token, input.creds.channelId);
  if (input.existingVideoCheck) {
    const existing = await findExistingEditionVideo(deps, token, input.creds.channelId, input.existingVideoCheck);
    if (existing) throw new ExistingEditionVideoError(existing);
  }
  const sessionUrl = await startResumableUpload(deps, token, input.request);
  if (input.beforeVideoBytes) {
    try {
      input.beforeVideoBytes();
    } catch (e) {
      throw new YouTubeUploadError(`marcador de upload em andamento não gravado (${(e as Error).message}) — bytes não enviados`, "insert");
    }
  }
  const resource = await putVideoBytes(deps, token, sessionUrl, input.video, input.contentType ?? "video/mp4");
  const uploadedAt = deps.now().toISOString();
  const videoId = resource.id;

  const thumbnail: YouTubeUploadResult["thumbnail"] = { attempted: false, ok: false, error: null };
  if (input.thumbnail) {
    thumbnail.attempted = true;
    try {
      await setThumbnail(deps, token, videoId, input.thumbnail);
      thumbnail.ok = true;
    } catch (e) {
      thumbnail.error = (e as Error).message;
    }
  }

  let rereadStatus: YouTubeUploadResult["rereadStatus"] = null;
  let rereadError: string | null = null;
  try {
    rereadStatus = await fetchVideoStatus(deps, token, videoId);
    if (!rereadStatus) rereadError = "videos.list não devolveu o vídeo recém-enviado (processamento ainda não indexado?)";
  } catch (e) {
    rereadError = (e as Error).message;
  }
  const rereadAt = deps.now();
  const state: PublishState = rereadStatus ? resolveYouTubeState({ status: rereadStatus }, rereadAt) : "unknown";

  return {
    videoId,
    url: `https://youtu.be/${videoId}`,
    channelId: resource.snippet?.channelId ?? null,
    requested: {
      privacyStatus: input.request.body.status.privacyStatus,
      publishAt: input.request.body.status.publishAt ?? null,
    },
    thumbnail,
    state,
    rereadStatus,
    rereadError,
    uploadedAt,
    rereadAt: rereadAt.toISOString(),
  };
}

/** `uploadStatus` relido que significa que o vídeo não vai ao ar. */
export function failedUploadStatus(status: UploadedVideoResource["status"] | null): string | null {
  const s = (status?.uploadStatus ?? "").toLowerCase();
  return s === "failed" || s === "rejected" || s === "deleted" ? s : null;
}

/**
 * Explica o estado relido para o editor (nunca diz "publicado" sem `published`).
 * `auditBlocked`: projeto GCP sem auditoria — o agendamento pode não tornar o
 * vídeo público (restrição de 2020; a página atual de `videos.insert` diz o
 * contrário, então só o horário confirma).
 */
export function describeYouTubeState(state: PublishState, opts: { auditBlocked?: boolean } = {}): string {
  switch (state) {
    case "published":
      return "público";
    case "scheduled":
      return opts.auditBlocked
        ? "agendado (privado até o publishAt) — projeto GCP sem auditoria: o agendamento pode não tornar o vídeo público (restrição de 2020); confira no Studio depois do horário"
        : "agendado (privado até o publishAt)";
    case "draft":
      return "privado sem agendamento — sem a auditoria do YouTube API Services o upload via API pode sair travado em private (restrição de 2020); publique ou agende à mão no Studio";
    default:
      return "estado não confirmado na releitura — confira no YouTube Studio antes de afirmar qualquer coisa";
  }
}
