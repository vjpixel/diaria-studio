/**
 * scripts/lib/diaria/youtube-link-refresh.ts (#12655, A4)
 *
 * Antes de o `link-video-d1.ts` decidir se o link do horizontal entra no D1
 * (`gateVideoLink`), relê o estado do vídeo na API oficial autenticada
 * (`videos.list?part=snippet,status`, o mesmo token do upload) em vez de
 * confiar só no estado gravado no momento do upload. Caso que motivou: o
 * editor publicou no Studio depois do upload privado; o registro ainda diz
 * `draft`, e a única saída era perguntar e rodar com `--assume-public`.
 *
 * Regras (docs/publica-video-fluxo-hibrido.md, #12655):
 * - só relê quando o registro do upload é DESTE vídeo (mesmo id) — sem
 *   registro, ou registro de outro vídeo (obsoleto), não há o que atualizar e
 *   o gate segue como antes;
 * - o registro só é atualizado com o id E o canal conferidos (`snippet.
 *   channelId` igual a `YOUTUBE_CHANNEL_ID`);
 * - falha de API (sem credencial, timeout, HTTP de erro, vídeo fora da
 *   resposta, canal diferente) NUNCA vira público: o registro fica como
 *   estava e o gate decide pelo estado antigo, com o fallback humano de
 *   sempre (pergunta + `--assume-public`, que nunca é automático);
 * - `failed`/`rejected`/`deleted` na releitura é terminal: o link não entra,
 *   nem com `--assume-public`. O registro grava o marcador
 *   `terminal_upload_status`, que o `gateVideoLink` recusa SEMPRE, também
 *   numa execução seguinte inconclusiva ou com `--no-refresh-status`; se a
 *   gravação falhar, o resultado continua `terminal` (a recusa desta
 *   execução não depende do disco).
 *
 * O estado relido é normalizado por `resolveYouTubeState` (#573); a decisão
 * de horário (D1, envio da newsletter, auditoria) continua no
 * `gateVideoLink`, que recebe o registro atualizado.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveYouTubeState, type PublishState } from "../publish-state.ts";
import { extractYouTubeVideoId } from "./d1-video-link.ts";
import {
  YOUTUBE_API_BASE,
  YOUTUBE_PUBLISHED_FILE,
  missingYouTubeCredentials,
  refreshYouTubeAccessToken,
  type YouTubeUploadDeps,
} from "./youtube-upload.ts";

export const YOUTUBE_STATUS_REFRESH_SOURCE = "youtube videos.list part=snippet,status";
export const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

export interface RefreshedVideoStatus {
  uploadStatus?: string;
  privacyStatus?: string;
  publishAt?: string | null;
}

/** O que a API devolveu (já buscado), ou o motivo de não ter devolvido. */
export type VideoStatusFetch =
  | { kind: "ok"; channelId: string | null; status: RefreshedVideoStatus | null }
  | { kind: "not-found" }
  | { kind: "error"; reason: string };

export type RefreshOutcome =
  /** Releitura conferida (id e canal): o registro foi atualizado com `state`. */
  | { kind: "refreshed"; state: PublishState; status: RefreshedVideoStatus; at: string }
  /**
   * O YouTube diz que o vídeo falhou, foi rejeitado ou apagado: o link nunca
   * entra. `persisted: false` = o marcador não foi gravado no registro.
   */
  | { kind: "terminal"; uploadStatus: string; at: string; reason: string; persisted?: boolean; persistError?: string }
  /** Nada conferido: o registro fica como estava (nunca vira público). */
  | { kind: "inconclusive"; reason: string }
  /** Não se aplica: sem registro deste vídeo, ou pulado. */
  | { kind: "skipped"; reason: string };

const TERMINAL_UPLOAD = new Set(["failed", "rejected", "deleted"]);

/**
 * Pure: decide o que a releitura prova, dado o id do link, o id do registro,
 * o canal esperado e o resultado da API.
 */
export function decideRefresh(input: {
  linkVideoId: string | null;
  recordVideoId: string | null;
  expectedChannelId: string;
  fetched: VideoStatusFetch;
  now: Date;
}): RefreshOutcome {
  if (!input.recordVideoId) return { kind: "skipped", reason: "sem registro de upload com videoId" };
  if (!input.linkVideoId || input.linkVideoId !== input.recordVideoId) {
    return { kind: "skipped", reason: `registro obsoleto: é do vídeo ${input.recordVideoId}, o link é de ${input.linkVideoId ?? "?"}` };
  }
  const f = input.fetched;
  if (f.kind === "error") return { kind: "inconclusive", reason: f.reason };
  if (f.kind === "not-found" || !f.status) {
    return { kind: "inconclusive", reason: `videos.list não devolveu o vídeo ${input.recordVideoId} (removido, de outro canal ou ainda não indexado)` };
  }
  const expected = input.expectedChannelId.trim();
  if (!f.channelId || f.channelId !== expected) {
    return { kind: "inconclusive", reason: `canal do vídeo (${f.channelId ?? "?"}) não confere com YOUTUBE_CHANNEL_ID (${expected || "?"})` };
  }
  const at = input.now.toISOString();
  const upload = (f.status.uploadStatus ?? "").toLowerCase();
  if (TERMINAL_UPLOAD.has(upload)) {
    return { kind: "terminal", uploadStatus: upload, at, reason: `o YouTube marcou o vídeo como ${upload}` };
  }
  return { kind: "refreshed", state: resolveYouTubeState({ status: f.status }, input.now), status: f.status, at };
}

/** Rejeita depois de `ms`, para a releitura nunca segurar o passo. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: timeout de ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** I/O: busca `snippet.channelId` e `status` do vídeo. Erros viram `{kind: "error"}`. */
export async function fetchVideoStatusWithChannel(
  deps: YouTubeUploadDeps,
  env: Record<string, string | undefined>,
  videoId: string,
  timeoutMs: number = DEFAULT_REFRESH_TIMEOUT_MS,
): Promise<VideoStatusFetch> {
  const missing = missingYouTubeCredentials(env);
  if (missing.length) return { kind: "error", reason: `sem credencial do YouTube (${missing.join(", ")})` };
  try {
    return await withTimeout(
      (async (): Promise<VideoStatusFetch> => {
        const token = await refreshYouTubeAccessToken(deps, {
          clientId: (env.GOOGLE_CLIENT_ID ?? "").trim(),
          clientSecret: (env.GOOGLE_CLIENT_SECRET ?? "").trim(),
          refreshToken: (env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
          channelId: (env.YOUTUBE_CHANNEL_ID ?? "").trim(),
        });
        const res = await deps.fetch(`${YOUTUBE_API_BASE}/videos?part=snippet,status&id=${encodeURIComponent(videoId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return { kind: "error", reason: `videos.list HTTP ${res.status}` };
        let json: { items?: Array<{ id?: string; snippet?: { channelId?: string }; status?: RefreshedVideoStatus }> } | null;
        try {
          json = (await res.json()) as typeof json;
        } catch {
          return { kind: "error", reason: "videos.list devolveu corpo não-JSON" };
        }
        const item = json?.items?.find((i) => i.id === videoId);
        if (!item) return { kind: "not-found" };
        return { kind: "ok", channelId: item.snippet?.channelId ?? null, status: item.status ?? null };
      })(),
      timeoutMs,
      "videos.list",
    );
  } catch (e) {
    return { kind: "error", reason: (e as Error).message };
  }
}

/**
 * Grava a releitura no registro do upload (`_internal/05-youtube-published.json`):
 * `state`, `rereadStatus`, `rereadAt` e uma entrada em `status_refreshes`; no
 * terminal, também `terminal_upload_status`/`terminal_at` (marcador que o
 * `gateVideoLink` recusa sempre). Só chamado com o id e o canal conferidos. O
 * `status` do registro (sentinela de upload) não é tocado. Escrita atômica
 * (tmp + rename): o registro nunca fica pela metade.
 */
export function writeRefreshToRecord(editionDir: string, outcome: Extract<RefreshOutcome, { kind: "refreshed" | "terminal" }>): void {
  const path = join(editionDir, YOUTUBE_PUBLISHED_FILE);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const refreshes = Array.isArray(raw.status_refreshes) ? (raw.status_refreshes as unknown[]) : [];
  if (outcome.kind === "refreshed") {
    raw.state = outcome.state;
    raw.rereadStatus = outcome.status;
    raw.rereadAt = outcome.at;
    refreshes.push({ at: outcome.at, source: YOUTUBE_STATUS_REFRESH_SOURCE, state: outcome.state, status: outcome.status });
  } else {
    raw.state = "unknown";
    raw.rereadStatus = { ...((raw.rereadStatus as object | null) ?? {}), uploadStatus: outcome.uploadStatus };
    raw.rereadAt = outcome.at;
    raw.terminal_upload_status = outcome.uploadStatus;
    raw.terminal_at = outcome.at;
    refreshes.push({ at: outcome.at, source: YOUTUBE_STATUS_REFRESH_SOURCE, state: "unknown", uploadStatus: outcome.uploadStatus });
  }
  raw.status_refreshes = refreshes;
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * Orquestra: registro → API → decisão → gravação. Nunca lança: erro de
 * leitura do registro vira `inconclusive`.
 */
export async function refreshYouTubeRecordState(input: {
  editionDir: string;
  videoUrl: string;
  env: Record<string, string | undefined>;
  deps: YouTubeUploadDeps;
  timeoutMs?: number;
}): Promise<RefreshOutcome> {
  const path = join(input.editionDir, YOUTUBE_PUBLISHED_FILE);
  if (!existsSync(path)) return { kind: "skipped", reason: "sem registro de upload (link vindo de fora)" };
  let recordVideoId: string | null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { videoId?: unknown };
    recordVideoId = typeof raw.videoId === "string" && raw.videoId ? raw.videoId : null;
  } catch (e) {
    return { kind: "inconclusive", reason: `registro do upload ilegível (${(e as Error).message})` };
  }
  const linkVideoId = extractYouTubeVideoId(input.videoUrl);
  const pre = decideRefresh({
    linkVideoId,
    recordVideoId,
    expectedChannelId: input.env.YOUTUBE_CHANNEL_ID ?? "",
    fetched: { kind: "error", reason: "não buscado" },
    now: input.deps.now(),
  });
  if (pre.kind === "skipped") return pre;
  const fetched = await fetchVideoStatusWithChannel(input.deps, input.env, recordVideoId as string, input.timeoutMs);
  const outcome = decideRefresh({ linkVideoId, recordVideoId, expectedChannelId: input.env.YOUTUBE_CHANNEL_ID ?? "", fetched, now: input.deps.now() });
  if (outcome.kind === "refreshed" || outcome.kind === "terminal") {
    try {
      writeRefreshToRecord(input.editionDir, outcome);
    } catch (e) {
      // Terminal continua terminal: a recusa não pode depender de o disco aceitar a escrita.
      if (outcome.kind === "terminal") return { ...outcome, persisted: false, persistError: (e as Error).message };
      return { kind: "inconclusive", reason: `releitura feita, mas o registro não foi gravado (${(e as Error).message})` };
    }
    if (outcome.kind === "terminal") return { ...outcome, persisted: true };
  }
  return outcome;
}
