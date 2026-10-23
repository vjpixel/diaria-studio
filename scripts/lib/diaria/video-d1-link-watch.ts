/**
 * scripts/lib/diaria/video-d1-link-watch.ts (#10941, item 1)
 *
 * Miolo da task `Diaria-Video-D1-Link-Watch`: tira do editor o "liberar o link
 * do vídeo horizontal no D1" depois das 06:00. Antes, ele conferia no Studio
 * se o vídeo tinha ficado público e rodava
 * `link-video-d1.ts {AAMMDD} --save --assume-public`.
 *
 * O que faz (decisão do editor no briefing 261023 da #10941 — só LÊ o estado
 * do vídeo; não muda o escopo do token, não chama `videos.update`, que dá 403
 * com o token de upload):
 *   1. lê o registro do upload (`_internal/05-youtube-published.json`); sem
 *      registro com `videoId` não há o que vigiar (upload à mão no Studio) e
 *      sai sem fazer nada;
 *   2. relê `videos.list?part=status` a cada `intervalMs` até `deadline`
 *      (default 10:00 BRT), normalizando com `resolveYouTubeState` (#573);
 *   3. com o vídeo `published`, grava `_internal/05-video-url.txt` SEM
 *      `--assume-public` — a releitura É a prova de que o leitor abre o link;
 *   4. monta o plano de `planD1VideoLink` (o mesmo de `link-video-d1.ts`) e
 *      aplica o que tem executor: Facebook diar.ia.br pela Graph API
 *      (`edit_scheduled` → edita a mensagem do post agendado;
 *      `comment_after` → comenta no post publicado). LinkedIn (1º comentário
 *      como organização), X (Buffer) e Threads (fila do Worker) ainda não têm
 *      executor por script: viram `manual`, com o texto pronto no log e no
 *      estado;
 *   5. grava o resultado por destino em `_internal/05-video-link-apply.json`.
 *      Rodar de novo nunca repete um destino já `applied` (não comenta 2×).
 *
 * Nunca apaga nem recria post: falha de um executor vira `failed` com o motivo
 * e o resto segue. Toda rede passa por `deps.fetch` (testes com fetch mockado).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveYouTubeState, type PublishState } from "../publish-state.ts";
import {
  D1_VIDEO_URL_FILE,
  extractYouTubeVideoId,
  insertVideoLinkLine,
  parseD1VideoUrlFile,
  planD1VideoLink,
  textHasVideoLink,
  type D1PostEntryLike,
  type D1VideoLinkDestination,
  type D1VideoLinkStep,
} from "./d1-video-link.ts";
import { readYouTubeRecordSummary, type YouTubeRecordSummary } from "./youtube-video-link-gate.ts";
import {
  fetchVideoStatus,
  refreshYouTubeAccessToken,
  type FetchLike,
  type YouTubeCredentials,
} from "./youtube-upload.ts";

/** Estado da aplicação, relativo ao diretório da edição. */
export const VIDEO_LINK_APPLY_FILE = "_internal/05-video-link-apply.json";

/** Fim default da janela de releitura (BRT). */
export const VIDEO_D1_WATCH_DEADLINE_BRT = "10:00";

/** Intervalo default entre releituras. 48 chamadas de 1 unidade numa janela de 4h. */
export const VIDEO_D1_WATCH_INTERVAL_MS = 5 * 60 * 1000;

const BRT_OFFSET = "-03:00";

export interface FacebookTarget {
  pageId: string;
  token: string;
  apiVersion: string;
}

export interface VideoD1WatchDeps {
  fetch: FetchLike;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

export interface VideoD1WatchInput {
  aammdd: string;
  editionDir: string;
  deadline: Date;
  intervalMs?: number;
  /** `null` = credenciais do YouTube ausentes (o caller lista quais). */
  youtubeCreds: YouTubeCredentials | null;
  missingYoutubeCreds?: string[];
  /** Página diar.ia.br; `null` = sem credencial (Facebook vira `manual`). */
  facebook: FacebookTarget | null;
  /** Só lê: não grava arquivo nem chama a Graph API. */
  dryRun?: boolean;
}

export type DestinationStatus = "applied" | "failed" | "manual" | "skipped";

export interface DestinationResult {
  destination: D1VideoLinkDestination;
  action: D1VideoLinkStep["action"];
  status: DestinationStatus;
  /** Texto aplicado (ou a aplicar à mão). */
  text: string | null;
  detail: string;
  at: string;
}

export interface VideoLinkApplyState {
  aammdd: string;
  video_url: string;
  checked_state: PublishState;
  checked_at: string;
  destinations: Partial<Record<D1VideoLinkDestination, DestinationResult>>;
}

export type VideoD1WatchOutcome =
  | { status: "sem-edicao"; detail: string }
  | { status: "sem-video"; detail: string }
  | { status: "credenciais-ausentes"; detail: string }
  | { status: "conflito"; detail: string }
  | { status: "nao-publicado"; lastState: PublishState; attempts: number; videoUrl: string; detail: string }
  | {
      status: "aplicado";
      videoUrl: string;
      urlFileWritten: boolean;
      results: DestinationResult[];
      /** Destinos que ainda pedem ação humana (manual/failed). */
      pending: DestinationResult[];
      dryRun: boolean;
    };

/** Pure: `HH:MM` em BRT do dia civil de `aammdd` → instante. `null` se inválido. */
export function deadlineForEdition(aammdd: string, hhmm: string = VIDEO_D1_WATCH_DEADLINE_BRT): Date | null {
  if (!/^\d{6}$/.test(aammdd) || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const d = new Date(`20${aammdd.slice(0, 2)}-${aammdd.slice(2, 4)}-${aammdd.slice(4, 6)}T${hhmm}:00${BRT_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new Error(`${path} ilegível (${(e as Error).message})`);
  }
}

/** Entradas de `06-social-published.json` (`_internal/` primeiro, raiz como legado). */
export function readSocialEntries(editionDir: string): D1PostEntryLike[] {
  for (const p of [join(editionDir, "_internal", "06-social-published.json"), join(editionDir, "06-social-published.json")]) {
    const parsed = readJsonFile<{ posts?: unknown }>(p);
    if (!parsed) continue;
    if (!Array.isArray(parsed.posts)) throw new Error(`${p}: campo "posts" ausente ou não é lista`);
    return parsed.posts as D1PostEntryLike[];
  }
  return [];
}

/** A mesma seleção de `planD1VideoLink`: último post principal do D1 na página diar.ia.br. */
export function findFacebookD1Entry(entries: readonly D1PostEntryLike[]): D1PostEntryLike | null {
  return (
    [...entries]
      .reverse()
      .find(
        (e) =>
          e.platform === "facebook" &&
          e.destaque === "d1" &&
          (e.subtype ?? "main") === "main" &&
          (e.page ?? "diaria") === "diaria" &&
          (e.status === "scheduled" || e.status === "published" || e.status === "draft"),
      ) ?? null
  );
}

async function graphJson(res: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!res.ok || obj.error) {
    const err = obj.error ? JSON.stringify(obj.error).slice(0, 200) : "";
    throw new Error(`Graph API HTTP ${res.status}${err ? `: ${err}` : ""}`);
  }
  return obj;
}

/** Lê a mensagem atual do post do Facebook (`null` se a Graph API não devolver). */
export async function fetchFacebookPostMessage(fetch: FetchLike, fb: FacebookTarget, postId: string): Promise<string | null> {
  // Token no header Authorization: Bearer, nunca na query string (#7893).
  const url = `https://graph.facebook.com/${fb.apiVersion}/${encodeURIComponent(postId)}?fields=message`;
  const json = await graphJson(await fetch(url, { headers: { Authorization: `Bearer ${fb.token}` } }));
  return typeof json.message === "string" ? json.message : null;
}

async function postFacebookForm(
  fetch: FetchLike,
  url: string,
  token: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(fields);
  return graphJson(
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${token}` },
      body,
    }),
  );
}

function readApplyState(editionDir: string): VideoLinkApplyState | null {
  return readJsonFile<VideoLinkApplyState>(join(editionDir, VIDEO_LINK_APPLY_FILE));
}

function writeApplyState(editionDir: string, state: VideoLinkApplyState): void {
  const p = join(editionDir, VIDEO_LINK_APPLY_FILE);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** URL do registro, normalizada; `null` se o registro não aponta pra um vídeo. */
export function recordVideoUrl(record: YouTubeRecordSummary | null): string | null {
  if (!record?.videoId) return null;
  const id = record.url ? extractYouTubeVideoId(record.url) : null;
  const videoId = id ?? record.videoId;
  return /^[A-Za-z0-9_-]{11}$/.test(videoId) ? `https://youtu.be/${videoId}` : null;
}

/** Relê o estado do vídeo até `published` ou o prazo. */
async function waitUntilPublished(
  deps: VideoD1WatchDeps,
  creds: YouTubeCredentials,
  videoId: string,
  deadline: Date,
  intervalMs: number,
): Promise<{ state: PublishState; attempts: number; checkedAt: Date }> {
  let attempts = 0;
  let state: PublishState = "unknown";
  let checkedAt = deps.now();
  for (;;) {
    attempts += 1;
    checkedAt = deps.now();
    try {
      // Token novo a cada leitura: a janela (até 4h) passa da validade de 1h.
      const token = await refreshYouTubeAccessToken({ fetch: deps.fetch, now: deps.now }, creds);
      const status = await fetchVideoStatus({ fetch: deps.fetch, now: deps.now }, token, videoId);
      state = status ? resolveYouTubeState({ status }, checkedAt) : "unknown";
      deps.log(`leitura ${attempts}: vídeo ${videoId} = ${state}${status ? "" : " (a API não devolveu o vídeo)"}`);
    } catch (e) {
      state = "unknown";
      deps.log(`leitura ${attempts}: falhou — ${(e as Error).message}`);
    }
    if (state === "published") return { state, attempts, checkedAt };
    const remaining = deadline.getTime() - deps.now().getTime();
    if (remaining <= 0) return { state, attempts, checkedAt };
    await deps.sleep(Math.min(intervalMs, remaining));
  }
}

async function applyFacebook(
  deps: VideoD1WatchDeps,
  fb: FacebookTarget,
  entry: D1PostEntryLike,
  step: D1VideoLinkStep,
  videoUrl: string,
  currentText: string | null,
): Promise<{ status: DestinationStatus; text: string | null; detail: string }> {
  const postId = typeof entry.fb_post_id === "string" && entry.fb_post_id ? entry.fb_post_id : null;
  if (!postId) return { status: "manual", text: step.text ?? step.link_line, detail: "entrada do Facebook sem fb_post_id" };
  const base = `https://graph.facebook.com/${fb.apiVersion}/${encodeURIComponent(postId)}`;
  if (step.action === "edit_scheduled") {
    if (currentText == null) {
      return { status: "manual", text: step.link_line, detail: "não deu para ler a mensagem atual do post agendado — edite à mão" };
    }
    const text = insertVideoLinkLine(currentText, videoUrl);
    await postFacebookForm(deps.fetch, base, fb.token, { message: text });
    // Releitura (#573): 2xx não prova que a mensagem mudou.
    const reread = await fetchFacebookPostMessage(deps.fetch, fb, postId);
    if (!reread || !textHasVideoLink(reread, videoUrl)) {
      return { status: "failed", text, detail: "a Graph API aceitou a edição, mas a releitura não mostra o link" };
    }
    return { status: "applied", text, detail: `mensagem do post agendado editada (${postId})` };
  }
  // comment_after
  const text = step.text ?? step.link_line;
  const res = await postFacebookForm(deps.fetch, `${base}/comments`, fb.token, { message: text });
  const commentId = typeof res.id === "string" ? res.id : null;
  if (!commentId) return { status: "failed", text, detail: "a Graph API não devolveu o id do comentário" };
  return { status: "applied", text, detail: `comentário ${commentId} no post ${postId}` };
}

const MANUAL_DETAIL: Record<Exclude<D1VideoLinkDestination, "facebook">, string> = {
  linkedin: "sem executor: 1º comentário como organização no LinkedIn segue manual",
  twitter: "sem executor: post do X é agendado na Buffer (só pelo MCP) — editar/responder à mão",
  threads: "sem executor: editar a fila do Worker / responder no Threads segue manual",
};

/**
 * Roda a vigilância inteira. Nunca lança por falha de rede do YouTube (vira
 * releitura) nem de executor (vira `failed`); lança só por arquivo de estado
 * corrompido — que não pode virar "sem registro" e liberar o link.
 */
export async function runVideoD1LinkWatch(deps: VideoD1WatchDeps, input: VideoD1WatchInput): Promise<VideoD1WatchOutcome> {
  const { editionDir } = input;
  if (!existsSync(editionDir)) return { status: "sem-edicao", detail: `${editionDir} não existe` };

  const record = readYouTubeRecordSummary(editionDir);
  const videoUrl = recordVideoUrl(record);
  if (!record || !videoUrl || record.sentinel) {
    return {
      status: "sem-video",
      detail: record?.sentinel
        ? `registro do upload em estado incerto (${record.sentinel}) — nada a vigiar`
        : "sem registro de upload com videoId (vídeo subido à mão no Studio?) — nada a vigiar",
    };
  }
  const videoId = extractYouTubeVideoId(videoUrl) as string;

  // Arquivo do link já presente com OUTRO vídeo: alguém decidiu à mão. Não mexe.
  const urlFile = join(editionDir, D1_VIDEO_URL_FILE);
  let existingUrl: string | null = null;
  if (existsSync(urlFile)) {
    try {
      existingUrl = parseD1VideoUrlFile(readFileSync(urlFile, "utf8"));
    } catch (e) {
      return { status: "conflito", detail: `${D1_VIDEO_URL_FILE} inválido (${(e as Error).message}) — confira à mão` };
    }
    if (existingUrl && extractYouTubeVideoId(existingUrl) !== videoId) {
      return {
        status: "conflito",
        detail: `${D1_VIDEO_URL_FILE} aponta para ${existingUrl}, mas o upload registrado é ${videoUrl} — nada alterado`,
      };
    }
  }

  const previous = readApplyState(editionDir);
  if (previous && previous.video_url !== videoUrl) {
    return {
      status: "conflito",
      detail: `${VIDEO_LINK_APPLY_FILE} é de outro vídeo (${previous.video_url}); o upload registrado é ${videoUrl} — nada alterado`,
    };
  }

  if (!input.youtubeCreds) {
    return {
      status: "credenciais-ausentes",
      detail: `faltam ${input.missingYoutubeCreds?.join(", ") || "credenciais do YouTube"} no ambiente — sem releitura não há prova de vídeo público`,
    };
  }

  const wait = await waitUntilPublished(deps, input.youtubeCreds, videoId, input.deadline, input.intervalMs ?? VIDEO_D1_WATCH_INTERVAL_MS);
  if (wait.state !== "published") {
    return {
      status: "nao-publicado",
      lastState: wait.state,
      attempts: wait.attempts,
      videoUrl,
      detail: `vídeo ${videoUrl} não ficou público até ${input.deadline.toISOString()} (último estado: ${wait.state}, ${wait.attempts} leituras)`,
    };
  }

  const dryRun = input.dryRun === true;
  let urlFileWritten = false;
  if (!existingUrl && !dryRun) {
    mkdirSync(dirname(urlFile), { recursive: true });
    writeFileSync(urlFile, `${videoUrl}\n`, "utf8");
    urlFileWritten = true;
    deps.log(`${D1_VIDEO_URL_FILE} gravado com ${videoUrl} (vídeo relido público)`);
  }

  const entries = readSocialEntries(editionDir);
  const fbEntry = findFacebookD1Entry(entries);
  let fbText: string | null = null;
  if (input.facebook && fbEntry && typeof fbEntry.fb_post_id === "string" && fbEntry.fb_post_id) {
    try {
      fbText = await fetchFacebookPostMessage(deps.fetch, input.facebook, fbEntry.fb_post_id);
    } catch (e) {
      deps.log(`facebook: não deu para ler a mensagem atual — ${(e as Error).message}`);
    }
  }
  const now = deps.now();
  const steps = planD1VideoLink({ videoUrl, entries, now, postTexts: { facebook: fbText } });

  const results: DestinationResult[] = [];
  const state: VideoLinkApplyState = {
    aammdd: input.aammdd,
    video_url: videoUrl,
    checked_state: wait.state,
    checked_at: wait.checkedAt.toISOString(),
    destinations: { ...(previous?.destinations ?? {}) },
  };
  for (const step of steps) {
    const done = previous?.destinations?.[step.destination];
    if (done?.status === "applied") {
      results.push(done);
      continue;
    }
    const at = deps.now().toISOString();
    let r: DestinationResult;
    if (step.action === "no_post" || step.action === "already_in_post") {
      r = { destination: step.destination, action: step.action, status: "skipped", text: null, detail: step.reason, at };
    } else if (step.destination === "facebook") {
      if (!input.facebook || !fbEntry) {
        r = {
          destination: "facebook",
          action: step.action,
          status: "manual",
          text: step.text ?? step.link_line,
          detail: input.facebook ? "post do D1 do Facebook não encontrado" : "sem credencial da página diar.ia.br no ambiente",
          at,
        };
      } else if (dryRun) {
        r = { destination: "facebook", action: step.action, status: "manual", text: step.text ?? step.link_line, detail: "--dry-run: Graph API não chamada", at };
      } else {
        try {
          const applied = await applyFacebook(deps, input.facebook, fbEntry, step, videoUrl, fbText);
          r = { destination: "facebook", action: step.action, ...applied, at };
        } catch (e) {
          r = { destination: "facebook", action: step.action, status: "failed", text: step.text ?? step.link_line, detail: (e as Error).message, at };
        }
      }
    } else {
      r = {
        destination: step.destination,
        action: step.action,
        status: "manual",
        text: step.text ?? step.link_line,
        detail: `${MANUAL_DETAIL[step.destination]} (${step.reason})`,
        at,
      };
    }
    deps.log(`${r.destination}: ${r.action} → ${r.status} — ${r.detail}`);
    results.push(r);
    state.destinations[step.destination] = r;
  }
  if (!dryRun) writeApplyState(editionDir, state);

  return {
    status: "aplicado",
    videoUrl,
    urlFileWritten,
    results,
    pending: results.filter((r) => r.status === "manual" || r.status === "failed"),
    dryRun,
  };
}
