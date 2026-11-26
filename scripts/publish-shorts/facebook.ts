/**
 * Cliente da Graph API (Meta) e o Reel da página do Facebook: upload resumível, capa, agendamento, cancelamento.
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import { CORTE_LIFECYCLE_MIN_LEAD_MS } from "../lib/diaria/short-corte-lifecycle.ts";
import type { ResolvedFacebookPage } from "../lib/facebook-pages.ts";
import { facebookDestinationId, facebookUploadRoute, mp4DurationSeconds, type ShortPublishedEntry } from "../lib/diaria/short-video.ts";
import { withCoverRecord, type ShortCoverRecord } from "../lib/diaria/short-cover.ts";
import { GRAPH, GRAPH_VIDEO, RUPLOAD } from "./_shared.ts";

// ── Graph API ────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GraphDeps {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (msg: string) => void;
}

export const defaultGraphDeps: GraphDeps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
  log: (m) => console.error(m),
};

export async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

/**
 * #11774: teto de cada chamada à Graph (`graphPost`/`graphGet`). Sem ele, uma
 * conexão travada segurava o lock do timer até a idade de lock velho (90 min,
 * `SHORTS_TIMER_LOCK_STALE_MS`), e aí outra rodada podia publicar junto.
 */
export const GRAPH_REQUEST_TIMEOUT_MS = 60_000;

/**
 * #11774: a Graph RESPONDEU com erro (HTTP não-ok, `error` no JSON ou resposta
 * sem o campo esperado). Falha de transporte (timeout, conexão) não vira esta
 * classe: ela não prova o que aconteceu do outro lado.
 */
export class GraphResponseError extends Error {
  readonly status: number;
  /** `error.code` da Graph (190 = token inválido ou revogado). */
  readonly code: number | null;
  constructor(message: string, status: number, code: number | null) {
    super(message);
    this.name = "GraphResponseError";
    this.status = status;
    this.code = code;
  }
}

/** Token inválido/revogado (OAuthException 190): repetir a consulta não adianta. */
export function isGraphAuthError(e: unknown): boolean {
  return e instanceof GraphResponseError && e.code === 190;
}

function graphError(method: string, path: string, res: Response, json: any): GraphResponseError {
  const code = typeof json?.error?.code === "number" ? json.error.code : null;
  return new GraphResponseError(`${method} ${path}: ${res.status} ${JSON.stringify(json?.error ?? json)}`, res.status, code);
}

export async function graphPost(deps: GraphDeps, path: string, params: Record<string, string>, apiVersion: string, base = GRAPH): Promise<any> {
  const res = await deps.fetch(`${base}/${apiVersion}/${path}`, { method: "POST", body: new URLSearchParams(params), signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS) });
  const json = await readJson(res);
  if (!res.ok || json.error) throw graphError("POST", path, res, json);
  return json;
}

export async function graphGet(deps: GraphDeps, path: string, params: Record<string, string>, apiVersion: string): Promise<any> {
  const res = await deps.fetch(`${GRAPH}/${apiVersion}/${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS) });
  const json = await readJson(res);
  if (!res.ok || json.error) throw graphError("GET", path, res, json);
  return json;
}

/** Envia o arquivo inteiro num POST ao rupload (offset 0). Só `success: true` conta. */
export async function ruploadBinary(deps: GraphDeps, url: string, token: string, file: Buffer): Promise<void> {
  const res = await deps.fetch(url, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(file.length) },
    body: new Uint8Array(file),
  });
  const json = await readJson(res);
  if (!res.ok || json.success !== true) throw new Error(`rupload: ${res.status} ${JSON.stringify(json.error ?? json)}`);
}

/** Folga mínima do Facebook pra agendar (10 min); abaixo disso, publica na hora. */
function stillSchedulable(scheduledAt: string | null, now: Date): string | null {
  if (!scheduledAt) return null;
  return Date.parse(scheduledAt) - now.getTime() > 10 * 60_000 ? scheduledAt : null;
}

/**
 * Espera o Facebook processar o vídeo (até 5 min). Erro de processamento
 * lança; tempo esgotado só avisa (o vídeo pode terminar depois) — o registro
 * sai com `unconfirmed` pra o relatório dizer "confira".
 */
async function waitFacebookProcessing(deps: GraphDeps, videoId: string, token: string, apiVersion: string): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    let st: any;
    try {
      st = (await graphGet(deps, videoId, { fields: "status", access_token: token }, apiVersion)).status ?? {};
    } catch (e) {
      deps.log(`[aviso] status do vídeo ${videoId}: ${(e as Error).message} — tentando de novo`);
      await deps.sleep(10_000);
      continue;
    }
    const phases = [st.uploading_phase, st.processing_phase, st.publishing_phase].map((p: any) => p?.status);
    if (st.video_status === "error" || st.video_status === "expired" || phases.includes("error")) {
      throw new Error(`Facebook recusou o vídeo ${videoId} no processamento: ${JSON.stringify(st)}`);
    }
    if (st.video_status === "ready" || st.processing_phase?.status === "complete") return true;
    await deps.sleep(10_000);
  }
  return false;
}

export interface PublishOutcome {
  entry: ShortPublishedEntry;
  /** true quando o processamento não foi confirmado no tempo de espera. */
  unconfirmed?: boolean;
  /** Avisos pós-publicação (ex.: convite de collab descartado, #10820). */
  warnings?: string[];
  /** #11355: outro processo registrou o destino antes do publish; nada saiu nesta rodada e `entry` é o registro dele. */
  alreadyRegistered?: true;
}

/**
 * #11869: o `finish` do Facebook (`/videos` ou `video_reels`) falhou sem resposta
 * definitiva da Graph — timeout de 60 s (`GRAPH_REQUEST_TIMEOUT_MS`), queda de
 * conexão ou 5xx. A Meta pode ter processado o `finish` e agendado (ou
 * publicado) o vídeo. Tratar como falha comum fazia a próxima rodada subir o
 * vídeo de novo e criar um 2º Reel na página pública; `publishFacebookReel`
 * converte este erro num registro `send_unknown` (conta como feito, nunca
 * re-posta), como o `media_publish` do Instagram (#11774).
 */
export class FacebookFinishUncertainError extends Error {
  readonly videoId: string;
  constructor(message: string, videoId: string) {
    super(message);
    this.name = "FacebookFinishUncertainError";
    this.videoId = videoId;
  }
}

/**
 * #11869: o `finish` do upload do Facebook. Resposta da Graph com erro 4xx (ou
 * 200 sem `success: true`) prova que o `finish` não valeu e lança o erro comum;
 * falha de transporte ou 5xx lança `FacebookFinishUncertainError`.
 */
async function facebookFinish(deps: GraphDeps, path: string, params: Record<string, string>, apiVersion: string, base: string, videoId: string): Promise<void> {
  let done: any;
  try {
    done = await graphPost(deps, path, params, apiVersion, base);
  } catch (e) {
    if (mediaPublishFailureIsDefinitive(e)) throw e;
    throw new FacebookFinishUncertainError(`POST ${path} (finish) sem resposta definitiva: ${(e as Error).message}`, videoId);
  }
  if (done.success !== true) throw new Error(`POST ${path} (finish) sem success: ${JSON.stringify(done)}`);
}

/** Teto de blocos do upload resumable — só existe pra nunca virar loop infinito (o servidor dita o tamanho do bloco). */
const FACEBOOK_RESUMABLE_MAX_CHUNKS = 10_000;
/** Tentativas por bloco no `transfer` (falha transitória não joga fora o que já subiu). */
const FACEBOOK_RESUMABLE_CHUNK_ATTEMPTS = 3;

/**
 * Upload RESUMABLE em `/{page-id}/videos` (#10815): `start` (tamanho) →
 * `transfer` dos blocos que o servidor pedir (offsets devolvidos a cada
 * resposta) → `finish` com legenda e agendamento. Substitui o POST único,
 * que dava `413` com o vertical exportado (275 MB em 261022). Devolve o
 * `video_id`.
 */
export async function uploadFacebookVideoResumable(
  deps: GraphDeps,
  page: ResolvedFacebookPage,
  apiVersion: string,
  file: Buffer,
  caption: string,
  scheduledAt: string | null,
): Promise<string> {
  const path = `${page.pageId}/videos`;
  const start = await graphPost(deps, path, { upload_phase: "start", file_size: String(file.length), access_token: page.token }, apiVersion, GRAPH_VIDEO);
  const sessionId: string | undefined = start.upload_session_id;
  const videoId: string | undefined = start.video_id;
  if (!sessionId || !videoId) throw new Error(`POST ${path} (start) sem upload_session_id/video_id: ${JSON.stringify(start)}`);
  let from = Number(start.start_offset);
  let to = Number(start.end_offset);
  for (let chunk = 0; from < file.length; chunk++) {
    if (chunk >= FACEBOOK_RESUMABLE_MAX_CHUNKS) throw new Error(`POST ${path} (transfer): mais de ${FACEBOOK_RESUMABLE_MAX_CHUNKS} blocos — abortado`);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > file.length) {
      throw new Error(`POST ${path} (transfer): offsets inválidos do servidor (start ${from}, end ${to}, arquivo ${file.length})`);
    }
    let json: any;
    for (let attempt = 1; ; attempt++) {
      const form = new FormData();
      form.append("access_token", page.token);
      form.append("upload_phase", "transfer");
      form.append("upload_session_id", sessionId);
      form.append("start_offset", String(from));
      form.append("video_file_chunk", new Blob([new Uint8Array(file.subarray(from, to))], { type: "application/octet-stream" }), "chunk");
      const res = await deps.fetch(`${GRAPH_VIDEO}/${apiVersion}/${path}`, { method: "POST", body: form });
      json = await readJson(res);
      if (res.ok && !json.error) break;
      const msg = `POST ${path} (transfer ${from}-${to}): ${res.status} ${JSON.stringify(json.error ?? json)}`;
      if (attempt >= FACEBOOK_RESUMABLE_CHUNK_ATTEMPTS) throw new Error(msg);
      deps.log(`[aviso] ${msg} — tentando o bloco de novo (${attempt}/${FACEBOOK_RESUMABLE_CHUNK_ATTEMPTS})`);
      await deps.sleep(5_000);
    }
    const next = Number(json.start_offset);
    if (!Number.isInteger(next) || next <= from) {
      throw new Error(`POST ${path} (transfer): o upload não avançou (start ${from} → ${json.start_offset})`);
    }
    from = next;
    to = Number(json.end_offset);
  }
  const finish: Record<string, string> = { upload_phase: "finish", upload_session_id: sessionId, description: caption, access_token: page.token };
  if (scheduledAt) {
    finish.published = "false";
    finish.scheduled_publish_time = String(Math.floor(Date.parse(scheduledAt) / 1000));
  }
  await facebookFinish(deps, path, finish, apiVersion, GRAPH_VIDEO, videoId); // #11869
  return videoId;
}

/**
 * #11547: capa do vídeo da Página — `POST /{video-id}/thumbnails` com o JPEG
 * (`source`) e `is_preferred=true`, o mesmo que o editor fez à mão na 261029
 * (HTTP 200 nas duas páginas). Nunca lança: a capa é opcional e o vídeo já
 * subiu; a falha volta no registro (`ok: false`).
 */
export async function setFacebookVideoThumbnail(
  deps: GraphDeps,
  videoId: string,
  token: string,
  apiVersion: string,
  jpeg: Buffer,
): Promise<ShortCoverRecord> {
  try {
    const form = new FormData();
    form.append("access_token", token);
    form.append("is_preferred", "true");
    form.append("source", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "capa.jpg");
    const res = await deps.fetch(`${GRAPH}/${apiVersion}/${videoId}/thumbnails`, { method: "POST", body: form });
    const json = await readJson(res);
    if (!res.ok || json.error || json.success === false) {
      return { method: "thumbnail_upload", ok: false, error: `POST ${videoId}/thumbnails: ${res.status} ${JSON.stringify(json.error ?? json)}` };
    }
    return { method: "thumbnail_upload", ok: true };
  } catch (e) {
    return { method: "thumbnail_upload", ok: false, error: `POST ${videoId}/thumbnails: ${(e as Error).message}` };
  }
}

/**
 * #11795: troca a descrição (e a capa) de um vídeo AGENDADO numa Página.
 * Reconfere antes que ele não foi ao ar (`published: false`): vídeo no ar não é
 * tocado. Capa é opcional e nunca derruba a troca do texto.
 */
export async function updateFacebookScheduledVideo(
  deps: GraphDeps,
  page: ResolvedFacebookPage,
  apiVersion: string,
  videoId: string,
  description: string,
  cover: Buffer | null,
): Promise<{ cover: ShortCoverRecord | null }> {
  const cur = await graphGet(deps, videoId, { fields: "published,scheduled_publish_time", access_token: page.token }, apiVersion);
  if (cur?.published === true) throw new Error(`o vídeo ${videoId} já está publicado na página — nada alterado; troque no Meta Business Suite`);
  await graphPost(deps, videoId, { description, access_token: page.token }, apiVersion);
  return { cover: cover ? await setFacebookVideoThumbnail(deps, videoId, page.token, apiVersion, cover) : null };
}

/**
 * #12936: troca a descrição de um vídeo JÁ PUBLICADO numa Página (`POST
 * /{video-id}` com `description`). Relê antes: vídeo ainda agendado
 * (`published: false`) é do `--update-scheduled`. Relê depois e confere a
 * descrição gravada.
 */
export async function updateFacebookPublishedVideoText(
  deps: GraphDeps,
  page: ResolvedFacebookPage,
  apiVersion: string,
  videoId: string,
  description: string,
): Promise<void> {
  const cur = await graphGet(deps, videoId, { fields: "published", access_token: page.token }, apiVersion);
  if (cur?.published !== true) {
    throw new Error(`o vídeo ${videoId} não está publicado na página (published ${String(cur?.published)}) — nada alterado; ainda agendado é com --update-scheduled`);
  }
  await graphPost(deps, videoId, { description, access_token: page.token }, apiVersion);
  const after = await graphGet(deps, videoId, { fields: "description", access_token: page.token }, apiVersion);
  if (after?.description !== description) {
    throw new Error(`POST ${videoId} aceitou, mas a releitura mostra outra descrição — confira no Meta Business Suite`);
  }
}

/**
 * #13000: `scheduled_publish_time` da Graph em ms (a API devolve segundos
 * unix, às vezes como string; aceita também ISO). `null` = sem horário.
 */
export function facebookScheduledMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v * 1000;
  if (typeof v === "string" && v.trim()) {
    if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * #13000: relê o vídeo da Página e recusa (lança) se ele não está agendado com
 * folga: `published: true`, sem `scheduled_publish_time`, ou horário a menos de
 * `minLeadMs`. É a trava que impede o cancelamento de apagar um Reels no ar.
 */
async function assertFacebookStillScheduled(deps: GraphDeps, page: ResolvedFacebookPage, apiVersion: string, videoId: string, minLeadMs: number, expectedAt?: string): Promise<void> {
  const cur = await graphGet(deps, videoId, { fields: "published,scheduled_publish_time", access_token: page.token }, apiVersion);
  const ms = facebookScheduledMs(cur?.scheduled_publish_time);
  // #12279: com `expectedAt`, o vídeo relido em outro horário também não é tocado.
  if (cur?.published === false && ms !== null && expectedAt !== undefined && ms !== Date.parse(expectedAt)) {
    throw new Error(
      `o vídeo ${videoId} está agendado na página para ${new Date(ms).toISOString()}, não para o horário esperado ${new Date(Date.parse(expectedAt)).toISOString()} — nada alterado; confira no Meta Business Suite (#12279)`,
    );
  }
  if (cur?.published !== false || ms === null || ms - deps.now().getTime() <= minLeadMs) {
    throw new Error(
      `o vídeo ${videoId} não está agendado com folga na página (published ${String(cur?.published)}, scheduled_publish_time ${String(cur?.scheduled_publish_time ?? "nenhum")}, folga mínima ${Math.round(minLeadMs / 60_000)} min) — nada alterado; confira no Meta Business Suite`,
    );
  }
}

/**
 * #13000: cancela um Reels AGENDADO numa Página (`DELETE /{video-id}`), só
 * depois de reler `published: false` e o horário com folga. A Graph não tem
 * "desagendar": o vídeo agendado é apagado. A folga mínima cobre a janela
 * entre a releitura e o DELETE (a Meta só publica no horário agendado).
 */
export async function cancelFacebookScheduledVideo(
  deps: GraphDeps,
  page: ResolvedFacebookPage,
  apiVersion: string,
  videoId: string,
  minLeadMs = CORTE_LIFECYCLE_MIN_LEAD_MS,
  /** #12279: horário esperado na releitura, e o gancho logo antes do DELETE (falha depois dele = desfecho incerto). */
  opts: { expectedAt?: string; onBeforeWrite?: () => void } = {},
): Promise<void> {
  await assertFacebookStillScheduled(deps, page, apiVersion, videoId, minLeadMs, opts.expectedAt);
  const path = videoId;
  opts.onBeforeWrite?.();
  const res = await deps.fetch(`${GRAPH}/${apiVersion}/${path}?${new URLSearchParams({ access_token: page.token })}`, { method: "DELETE", signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS) });
  const json = await readJson(res);
  if (!res.ok || json.error || json.success !== true) throw graphError("DELETE", path, res, json);
}

/**
 * #13000: reagenda um Reels AGENDADO numa Página (`POST /{video-id}` com
 * `scheduled_publish_time`), depois de reler `published: false` com folga, e
 * relê de novo para conferir o horário gravado.
 */
export async function rescheduleFacebookScheduledVideo(deps: GraphDeps, page: ResolvedFacebookPage, apiVersion: string, videoId: string, at: string, minLeadMs = CORTE_LIFECYCLE_MIN_LEAD_MS): Promise<void> {
  await assertFacebookStillScheduled(deps, page, apiVersion, videoId, minLeadMs);
  const unix = Math.floor(Date.parse(at) / 1000);
  await graphPost(deps, videoId, { scheduled_publish_time: String(unix), access_token: page.token }, apiVersion);
  const after = await graphGet(deps, videoId, { fields: "published,scheduled_publish_time", access_token: page.token }, apiVersion);
  const ms = facebookScheduledMs(after?.scheduled_publish_time);
  if (after?.published !== false || ms === null || Math.floor(ms / 1000) !== unix) {
    throw new Error(`POST ${videoId} aceitou, mas a releitura mostra published ${String(after?.published)} e scheduled_publish_time ${String(after?.scheduled_publish_time ?? "nenhum")} — confira no Meta Business Suite`);
  }
}

/**
 * Reels numa Página. ≤90 s: `video_reels` (start → rupload → finish). >90 s: `/videos` resumable (#10815).
 * #11547: com `cover`, aplica a capa logo depois do upload (as duas rotas).
 * #11869: `finish` sem resposta definitiva (timeout, conexão, 5xx) devolve o
 * registro `send_unknown` com o `video_id`, sem esperar processamento nem capa.
 */
export async function publishFacebookReel(
  deps: GraphDeps,
  page: ResolvedFacebookPage,
  apiVersion: string,
  file: Buffer,
  caption: string,
  plannedScheduledAt: string | null,
  cover: Buffer | null = null,
  /** #12279: substituição — o envio novo sai no horário preservado ou não sai (nunca "na hora"). */
  requireScheduled = false,
): Promise<PublishOutcome> {
  const scheduledAt = stillSchedulable(plannedScheduledAt, deps.now());
  if (requireScheduled && !scheduledAt) {
    throw new Error(`${facebookDestinationId(page.slug)}: o horário preservado (${plannedScheduledAt ?? "nenhum"}) está a menos de 10 min: a substituição não publica na hora, nada enviado (#12279)`);
  }
  if (plannedScheduledAt && !scheduledAt) deps.log(`[premissa] ${facebookDestinationId(page.slug)}: menos de 10 min pro horário — publicando na hora`);
  const route = facebookUploadRoute(mp4DurationSeconds(file));
  let videoId: string;

  try {
    if (route === "video_reels") {
      const start = await graphPost(deps, `${page.pageId}/video_reels`, { upload_phase: "start", access_token: page.token }, apiVersion);
      videoId = start.video_id;
      if (!videoId) throw new Error(`video_reels start sem video_id: ${JSON.stringify(start)}`);
      await ruploadBinary(deps, start.upload_url ?? `${RUPLOAD}/video-upload/${apiVersion}/${videoId}`, page.token, file);
      const finish: Record<string, string> = { upload_phase: "finish", video_id: videoId, description: caption, access_token: page.token };
      if (scheduledAt) {
        finish.video_state = "SCHEDULED";
        finish.scheduled_publish_time = String(Math.floor(Date.parse(scheduledAt) / 1000));
      } else {
        finish.video_state = "PUBLISHED";
      }
      await facebookFinish(deps, `${page.pageId}/video_reels`, finish, apiVersion, GRAPH, videoId); // #11869
    } else {
      videoId = await uploadFacebookVideoResumable(deps, page, apiVersion, file, caption, scheduledAt);
    }
  } catch (e) {
    if (!(e instanceof FacebookFinishUncertainError)) throw e;
    // #11869: o finish pode ter valido do lado da Meta — registra estado incerto, nunca re-posta sozinho.
    const at = deps.now().toISOString();
    return {
      entry: {
        destination: facebookDestinationId(page.slug),
        status: "send_unknown",
        id: e.videoId,
        scheduled_at: scheduledAt,
        at,
      },
      warnings: [
        `${e.message}: o vídeo ${e.videoId} PODE estar ${scheduledAt ? "agendado" : "no ar"} na página — confira no Meta Business Suite antes de repostar; ` +
          `se não estiver, apague a entrada de ${facebookDestinationId(page.slug)} do registro e rode de novo`,
      ],
    };
  }

  const confirmed = await waitFacebookProcessing(deps, videoId, page.token, apiVersion);
  const coverRecord = cover ? await setFacebookVideoThumbnail(deps, videoId, page.token, apiVersion, cover) : null;
  const warnings = coverRecord && !coverRecord.ok ? [`capa não aplicada (${coverRecord.error}) — o vídeo segue com o frame automático`] : [];
  return {
    entry: withCoverRecord(
      {
        destination: facebookDestinationId(page.slug),
        status: scheduledAt ? "scheduled" : "published",
        id: videoId,
        url: route === "video_reels" ? `https://www.facebook.com/reel/${videoId}` : `https://www.facebook.com/${page.pageId}/videos/${videoId}`,
        scheduled_at: scheduledAt,
        at: deps.now().toISOString(),
      },
      coverRecord,
    ),
    unconfirmed: !confirmed,
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * #11774: a falha do `media_publish` prova que a Meta recusou? Só uma resposta
 * da Graph abaixo de 500 prova (4xx, ou 200 sem o id da mídia). Timeout, conexão caída ou 5xx deixam o publish possivelmente
 * em andamento: o container ainda aparece FINISHED (não PUBLISHED) e relançar
 * faria a próxima rodada depender só do gate do `/media`.
 */
export function mediaPublishFailureIsDefinitive(e: unknown): boolean {
  return e instanceof GraphResponseError && e.status < 500;
}
