/**
 * threads-personal-video.ts (#10772) — vídeo vertical da edição no Threads
 * PESSOAL do editor (destino `threads_profile` de `_internal/06-shorts-published.json`).
 *
 * Fluxo oficial da Threads API (https://developers.facebook.com/docs/threads/posts):
 *   1. `POST /{threads-user-id}/threads` com `media_type=VIDEO`, `video_url`
 *      PÚBLICO (o mesmo `-short.mp4` que o `publish-shorts.ts` sobe pro R2) e `text`;
 *   2. espera o container sair de `IN_PROGRESS` (`GET /{container-id}?fields=status,error_message`).
 *      A Meta recomenda ~30 s de espera e 1 consulta/min por até 5 min; aqui
 *      são 30 s de espera e 1 consulta a cada 30 s (o DOBRO da cadência
 *      recomendada, 10 GETs no total, ainda dentro dos 5 min). Volume baixo
 *      (1 vídeo/dia) e sem rate limit documentado para o GET de status —
 *      escolha consciente pra publicar mais cedo quando o processamento é rápido;
 *   3. `POST /{threads-user-id}/threads_publish` com `creation_id`.
 * Cliente HTTP compartilhado com os posts da diar.ia.br: `scripts/lib/threads-api.ts`.
 *
 * Credenciais (Doppler `diaria-studio/dev` → `npm run sync-env`), mesmo padrão de
 * `LINKEDIN_PERSONAL_*`: `THREADS_PERSONAL_ACCESS_TOKEN` (longa duração, 60 dias,
 * renovado por `scripts/threads-personal-token-refresh.ts`) e `THREADS_PERSONAL_USER_ID`.
 * Ausentes → o destino é pulado (fail-soft), com aviso nomeando as vars.
 *
 * O repost pela conta da diar.ia.br não está aqui: a Threads API pública não
 * documenta repost; segue manual (passo guiado).
 *
 * #11410: a rodada do timer do 300 (`--threads-timer`) confere o perfil antes
 * de publicar (`threadsProfilePreflight`): o vídeo da edição já no perfil
 * (postado à mão depois de um `skip_late`, ou por uma rodada cujo registro não
 * sincronizou) vira registro em vez de um segundo post.
 *
 * Ainda SEM validação real: o token pessoal não existe (comentários de 23/10 e
 * 25/10/2026 na #10772). Consumidor: `publish-shorts.ts`, destino
 * `threads_profile` (#11122) — fail-soft (pulado com aviso) até o token existir;
 * `--mark threads_profile=URL` registra o resultado de um `send_unknown`.
 */

import { THREADS_API_BASE, THREADS_API_VERSION, ThreadsApiError, createThreadsContainer, fetchThreadsPermalink, publishThreadsContainer, waitForThreadsContainer, type ThreadsFetch } from "./threads-api.ts";
import type { ShortPublishedEntry } from "./diaria/short-video.ts";

export const THREADS_PROFILE_DESTINATION = "threads_profile";

export const THREADS_PERSONAL_ENV = {
  accessToken: "THREADS_PERSONAL_ACCESS_TOKEN",
  userId: "THREADS_PERSONAL_USER_ID",
  /** ISO de vencimento, gravado pelo refresh (opcional; ausente = idade desconhecida). */
  expiresAt: "THREADS_PERSONAL_TOKEN_EXPIRES_AT",
} as const;

/** Espera inicial antes do 1º poll (recomendação da Meta: ~30 s em média). */
export const THREADS_VIDEO_INITIAL_WAIT_MS = 30_000;
/** Intervalo entre polls do container de vídeo (2× a cadência de 1/min da Meta; ver docblock). */
export const THREADS_VIDEO_POLL_INTERVAL_MS = 30_000;
/** Polls do container de vídeo: 30 s de espera + 9 intervalos de 30 s = 5 min, o teto que a Meta recomenda. */
export const THREADS_VIDEO_POLL_ATTEMPTS = 10;

export interface ThreadsPersonalCreds {
  accessToken: string;
  userId: string;
  apiVersion: string;
}

export type ThreadsPersonalCredsResult = { ready: true; creds: ThreadsPersonalCreds } | { ready: false; reason: string };

/** Lê as credenciais do Threads pessoal. Ausentes → `ready: false` com a mensagem de skip. */
export function readThreadsPersonalCreds(env: Record<string, string | undefined>): ThreadsPersonalCredsResult {
  const accessToken = (env[THREADS_PERSONAL_ENV.accessToken] ?? "").trim();
  const userId = (env[THREADS_PERSONAL_ENV.userId] ?? "").trim();
  const missing = [!accessToken && THREADS_PERSONAL_ENV.accessToken, !userId && THREADS_PERSONAL_ENV.userId].filter(Boolean);
  if (missing.length > 0) {
    return {
      ready: false,
      reason:
        `threads_profile pulado: ${missing.join(" e ")} ausente(s). Gere o token da conta pessoal ` +
        `(passo a passo na #10772), grave no Doppler diaria-studio/dev e rode npm run sync-env.`,
    };
  }
  return { ready: true, creds: { accessToken, userId, apiVersion: env.THREADS_API_VERSION?.trim() || THREADS_API_VERSION } };
}

export interface ThreadsVideoDeps {
  fetch?: ThreadsFetch;
  sleep?: (ms: number) => Promise<void>;
  now: () => Date;
}

export interface ThreadsVideoOutcome {
  entry: ShortPublishedEntry;
  warnings?: string[];
}

/**
 * Publica o vertical no Threads pessoal. Falha ANTES do publish (container,
 * processamento `ERROR`/`EXPIRED`/timeout, 4xx no publish) lança: nada saiu no
 * perfil e dá pra tentar de novo. Envio AMBÍGUO no `threads_publish`
 * (`ThreadsApiError.sendMayHaveSucceeded`: rede/timeout, 5xx, ou 2xx sem `id`
 * usável — a Meta pode ter publicado) volta como `send_unknown`, mesmo contrato
 * do `linkedin_profile`: conta como feito e a rodada seguinte não re-posta. Um
 * container que o poll já vê `PUBLISHED` também vira `send_unknown` (o post
 * existe, mas não temos o media id).
 */
export async function publishThreadsProfileVideo(args: {
  creds: ThreadsPersonalCreds;
  videoUrl: string;
  text: string;
  deps: ThreadsVideoDeps;
}): Promise<ThreadsVideoOutcome> {
  const { creds, videoUrl, text, deps } = args;
  if (!/^https:\/\//.test(videoUrl)) throw new Error(`threads_profile: video_url precisa ser https público (recebido: ${videoUrl.slice(0, 80)})`);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const containerId = await createThreadsContainer(creds.userId, creds.accessToken, { mediaType: "VIDEO", text, videoUrl }, creds.apiVersion, deps.fetch);
  await sleep(THREADS_VIDEO_INITIAL_WAIT_MS);
  const ready = await waitForThreadsContainer(containerId, creds.accessToken, creds.apiVersion, {
    maxAttempts: THREADS_VIDEO_POLL_ATTEMPTS,
    intervalMs: THREADS_VIDEO_POLL_INTERVAL_MS,
    onTimeout: "throw",
    sleep,
    fetchFn: deps.fetch,
  });
  if (ready === "published") return sendUnknown(deps, `o container ${containerId} já está PUBLISHED`);
  let mediaId: string;
  try {
    mediaId = await publishThreadsContainer(creds.userId, creds.accessToken, containerId, creds.apiVersion, deps.fetch);
  } catch (e) {
    if (!(e instanceof ThreadsApiError) || !e.sendMayHaveSucceeded) throw e;
    return sendUnknown(deps, `envio ambíguo no threads_publish (${e.message}; container ${containerId})`);
  }
  const url = await fetchThreadsPermalink(mediaId, creds.accessToken, creds.apiVersion, deps.fetch);
  const at = deps.now().toISOString();
  return {
    entry: { destination: THREADS_PROFILE_DESTINATION, status: "published", id: mediaId, ...(url ? { url } : {}), scheduled_at: null, at },
    ...(url ? {} : { warnings: ["o Threads publicou mas não devolveu o permalink — confira o perfil"] }),
  };
}

/**
 * Registro `send_unknown`. Conta como feito (a rodada seguinte não re-posta);
 * o editor confere o perfil e registra a URL com `--mark threads_profile=URL`
 * (`MARKABLE_DESTINATIONS` do `publish-shorts.ts`, #11122).
 */
function sendUnknown(deps: ThreadsVideoDeps, detail: string): ThreadsVideoOutcome {
  const at = deps.now().toISOString();
  return {
    entry: { destination: THREADS_PROFILE_DESTINATION, status: "send_unknown", id: `send_unknown-${at}`, scheduled_at: null, at },
    warnings: [
      `${detail} — não tente de novo antes de conferir no perfil do Threads se o vídeo saiu; ` +
        `se saiu, registre com publish-shorts.ts {AAMMDD} --mark threads_profile=URL`,
    ],
  };
}

/** #11410: post do perfil pessoal, como `GET /{user-id}/threads` devolve. */
export interface ThreadsProfilePost {
  id: string;
  mediaType: string;
  text: string;
  /** ISO normalizado (`+0000` → `+00:00`); null = ilegível. */
  timestamp: string | null;
  permalink: string | null;
}

/** Páginas lidas no máximo (50 posts cada): um dia do perfil pessoal cabe com folga. */
export const THREADS_PROFILE_LIST_MAX_PAGES = 4;

/** A Threads API devolve `2026-10-28T09:31:02+0000`; `Date.parse` só garante o formato com `:`. */
function normalizeThreadsTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const iso = raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * #11410: posts do perfil desde `sinceIso` (`GET /{user-id}/threads`, campos
 * `id,media_type,text,timestamp,permalink`, `since` em segundos). Só leitura.
 * Qualquer falha (rede, HTTP, corpo ilegível, `error` no corpo, mais páginas do
 * que o teto) LANÇA: o chamador nunca pode tratar "não consegui ler" como
 * "o perfil não tem o vídeo" (publicaria em duplicata).
 */
export async function listThreadsProfilePosts(args: { creds: ThreadsPersonalCreds; sinceIso: string; fetch?: ThreadsFetch }): Promise<ThreadsProfilePost[]> {
  const { creds } = args;
  const fetchFn = args.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const sinceS = Math.floor(Date.parse(args.sinceIso) / 1000);
  if (!Number.isFinite(sinceS)) throw new Error(`threads_profile: sinceIso inválido (${args.sinceIso})`);
  const params = new URLSearchParams({ fields: "id,media_type,text,timestamp,permalink", since: String(sinceS), limit: "50" });
  let url: string | null = `${THREADS_API_BASE}/${creds.apiVersion}/${creds.userId}/threads?${params}`;
  const out: ThreadsProfilePost[] = [];
  for (let page = 0; url; page++) {
    if (page >= THREADS_PROFILE_LIST_MAX_PAGES) throw new Error(`threads_profile: o perfil tem mais de ${THREADS_PROFILE_LIST_MAX_PAGES} páginas de posts desde ${args.sinceIso} — não deu pra conferir tudo`);
    const res = await fetchFn(url, { method: "GET", headers: { Authorization: `Bearer ${creds.accessToken}` } });
    const raw = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`threads_profile: leitura do perfil HTTP ${res.status}: ${raw.slice(0, 300)}`);
    let data: { data?: unknown; paging?: { next?: unknown }; error?: unknown } | null;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`threads_profile: leitura do perfil com corpo ilegível: ${raw.slice(0, 200)}`);
    }
    if (data?.error) throw new Error(`threads_profile: leitura do perfil com erro: ${JSON.stringify(data.error).slice(0, 300)}`);
    if (!Array.isArray(data?.data)) throw new Error("threads_profile: leitura do perfil sem lista de posts (data)");
    for (const p of data.data as Array<Record<string, unknown>>) {
      if (typeof p?.id !== "string" || !p.id) continue;
      out.push({
        id: p.id,
        mediaType: typeof p.media_type === "string" ? p.media_type : "",
        text: typeof p.text === "string" ? p.text : "",
        timestamp: normalizeThreadsTimestamp(p.timestamp),
        permalink: typeof p.permalink === "string" && p.permalink ? p.permalink : null,
      });
    }
    const next = data?.paging?.next;
    url = typeof next === "string" && next ? next : null;
  }
  return out;
}

export type ThreadsProfileDuplicateDecision =
  | { kind: "none" }
  /** O vídeo da edição já está no perfil: registrar, nunca postar de novo. */
  | { kind: "found"; post: ThreadsProfilePost }
  /** Vídeo no perfil no dia da edição sem marcador: não dá pra afirmar que não é o da edição. */
  | { kind: "blocked"; reason: string; candidates: ThreadsProfilePost[] };

/**
 * Pure (#11410): o vídeo da edição já está no perfil? Só posts de VÍDEO desde
 * `sinceIso` (o dia da edição, 00:00 BRT) contam. Vídeo cujo texto tem um dos
 * `markers` (o `utm_campaign={AAMMDD}` do link da edição, o título do D1) é o
 * da edição. Vídeo do dia SEM marcador bloqueia (premissa conservadora: um
 * post à mão com outro texto não pode virar um segundo post do mesmo vídeo;
 * o editor confere e registra com `--mark`). Timestamp ilegível conta como
 * do dia (nunca exclui um candidato por falta de dado).
 */
export function decideThreadsProfileDuplicate(posts: readonly ThreadsProfilePost[], opts: { sinceIso: string; markers: readonly string[] }): ThreadsProfileDuplicateDecision {
  const sinceMs = Date.parse(opts.sinceIso);
  const markers = opts.markers.map((m) => m.trim().toLowerCase()).filter((m) => m.length >= 4);
  const videos = posts.filter((p) => p.mediaType === "VIDEO" && (p.timestamp === null || Date.parse(p.timestamp) >= sinceMs));
  const marked = videos.filter((p) => markers.some((m) => p.text.toLowerCase().includes(m)));
  if (marked.length > 0) return { kind: "found", post: marked[0] };
  if (videos.length > 0) {
    return {
      kind: "blocked",
      reason:
        `o perfil já tem ${videos.length} vídeo(s) no dia da edição sem o marcador dela (${videos.map((v) => v.permalink ?? v.id).join(", ")}) — ` +
        "confira se é o vertical; se for, registre com --mark threads_profile=URL",
      candidates: videos,
    };
  }
  return { kind: "none" };
}

export type ThreadsTimerGateFailure = "blocked" | "read-failed";

/** #11410: a conferência do perfil não deixou o timer publicar. */
export class ThreadsTimerGateError extends Error {
  constructor(
    message: string,
    readonly failure: ThreadsTimerGateFailure,
  ) {
    super(message);
    this.name = "ThreadsTimerGateError";
  }
}

/**
 * #11410: conferência do perfil antes da rodada do timer publicar. Achou o
 * vídeo da edição → `already` com a entrada a registrar (status `published`).
 * Leitura falhou → `ThreadsTimerGateError("read-failed")`; vídeo do dia sem
 * marcador → `ThreadsTimerGateError("blocked")`. Nos dois, nada é publicado.
 */
export async function threadsProfilePreflight(args: {
  creds: ThreadsPersonalCreds;
  sinceIso: string;
  markers: readonly string[];
  fetch?: ThreadsFetch;
  now: () => Date;
}): Promise<{ kind: "publish" } | { kind: "already"; entry: ShortPublishedEntry }> {
  let posts: ThreadsProfilePost[];
  try {
    posts = await listThreadsProfilePosts({ creds: args.creds, sinceIso: args.sinceIso, fetch: args.fetch });
  } catch (e) {
    throw new ThreadsTimerGateError(`não deu pra ler o perfil do Threads antes de publicar: ${(e as Error).message}`, "read-failed");
  }
  const d = decideThreadsProfileDuplicate(posts, { sinceIso: args.sinceIso, markers: args.markers });
  if (d.kind === "blocked") throw new ThreadsTimerGateError(d.reason, "blocked");
  if (d.kind === "none") return { kind: "publish" };
  return {
    kind: "already",
    entry: {
      destination: THREADS_PROFILE_DESTINATION,
      status: "published",
      id: d.post.id,
      ...(d.post.permalink ? { url: d.post.permalink } : {}),
      scheduled_at: null,
      at: d.post.timestamp ?? args.now().toISOString(),
    },
  };
}
