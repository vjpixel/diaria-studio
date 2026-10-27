/**
 * scripts/lib/diaria/youtube-short-related.ts (#10811)
 *
 * Lógica pura do vínculo "vídeo relacionado" do Short ao horizontal da mesma
 * edição. A YouTube Data API não expõe esse campo (`docs/youtube-short-related-video.md`),
 * então quem vincula é uma task LOCAL do app Claude desktop no Neo, às 06:30
 * BRT, com o Claude in Chrome no YouTube Studio logado no @diariabr (decisão
 * do editor de 22/10, reconfirmada em 26/10; roteiro em
 * `.claude/skills/diaria-publica-video/short-related-task.md`). Este módulo
 * só decide O QUE a task faz, de forma determinística (#573):
 *
 *   - `skip`  — fim de semana, sem edição, edição sem vídeo, ou já vinculado;
 *   - `link`  — horizontal confirmado PÚBLICO pela API: abrir o Studio e vincular;
 *   - `wait`  — horizontal (ou um dos IDs) ainda não está pronto e o horário
 *               do Short não passou: tentar de novo;
 *   - `alert` — passou o horário do Short sem dar pra vincular: avisar o editor.
 *
 * O resultado do Studio volta pelo registro `_internal/06-short-related.json`
 * (`--record linked|failed` do CLI `scripts/youtube-short-related-plan.ts`).
 * Registro `linked` com os mesmos IDs torna a task idempotente.
 */

import type { PublishState } from "../publish-state.ts";
import { extractYouTubeVideoId } from "./d1-video-link.ts";
import type { ShortsPublishedFile } from "./short-video.ts";
import type { YouTubeRecordSummary } from "./youtube-video-link-gate.ts";

/** Registro do vínculo, em `_internal/` da edição. */
export const SHORT_RELATED_FILE = "_internal/06-short-related.json";

/** Canal @diariabr. O Studio precisa ser aberto pela lista DESTE canal (#10811). */
export const DIARIA_YOUTUBE_CHANNEL_ID = "UCSsppeUnBy6q-4a5hsl5u0w";

/** Intervalo entre tentativas enquanto o plano diz `wait`. */
export const SHORT_RELATED_RETRY_MINUTES = 10;

/**
 * Lista de Shorts do canal no Studio. Abrir `/video/{id}/edit` direto às vezes
 * carrega no contexto do canal pessoal e dá "Ops! Algo deu errado" (observado
 * em 261022), então a task sempre parte desta lista.
 */
export function studioShortsListUrl(channelId: string = DIARIA_YOUTUBE_CHANNEL_ID): string {
  return `https://studio.youtube.com/channel/${channelId}/videos/short`;
}

const BARE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** ID de vídeo a partir de URL ou de um ID cru; `null` se não for nenhum dos dois. */
function videoIdOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (BARE_VIDEO_ID.test(trimmed)) return trimmed;
  try {
    return extractYouTubeVideoId(trimmed);
  } catch {
    return null;
  }
}

export type VideoIdSource = "upload-record" | "video-url-file" | "shorts-registry" | "channel-listing";

export interface ResolvedVideoId {
  id: string;
  source: VideoIdSource;
}

/**
 * ID do horizontal: o registro do upload (`05-youtube-published.json`) vence;
 * sem ele (ou em estado incerto), o link do D1 (`05-video-url.txt`).
 */
export function resolveHorizontalId(input: {
  record: YouTubeRecordSummary | null;
  videoUrl: string | null;
}): ResolvedVideoId | null {
  const rec = input.record;
  if (rec && !rec.sentinel) {
    const id = videoIdOf(rec.videoId) ?? videoIdOf(rec.url);
    if (id) return { id, source: "upload-record" };
  }
  const fromUrl = videoIdOf(input.videoUrl);
  return fromUrl ? { id: fromUrl, source: "video-url-file" } : null;
}

/**
 * ID do Short pelo registro do vertical (destino `youtube_shorts`). Entrada
 * `send_unknown` não tem ID confiável (o upload pode ter criado o vídeo ou
 * não) e devolve `null` — a listagem do canal decide.
 */
export function resolveShortId(registry: ShortsPublishedFile | null): ResolvedVideoId | null {
  const entry = registry?.entries.find((e) => e.destination === "youtube_shorts");
  if (!entry || entry.status === "send_unknown") return null;
  const id = videoIdOf(entry.url) ?? videoIdOf(entry.id);
  return id ? { id, source: "shorts-registry" } : null;
}

/** Edição cai de segunda a sexta? Só há edição nesses dias. */
export function isWeekdayEdition(aammdd: string): boolean {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(aammdd);
  if (!m) throw new Error(`AAMMDD inválido: ${JSON.stringify(aammdd)}`);
  const dow = new Date(Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/** AAMMDD do dia em BRT (UTC-3 fixo, sem horário de verão desde 2019). */
export function brtTodayAammdd(now: Date): string {
  const d = new Date(now.getTime() - 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** Instante do horário `HH:MM` BRT no dia da edição. */
export function brtInstant(aammdd: string, hhmm: string): Date {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(aammdd);
  const t = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m || !t) throw new Error(`data/hora inválida: ${aammdd} ${hhmm}`);
  return new Date(Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]) + 3, Number(t[2])));
}

// ─── Registro do resultado ───────────────────────────────────────────────────

export type ShortRelatedStatus = "linked" | "failed";

export interface ShortRelatedRecord {
  aammdd: string;
  status: ShortRelatedStatus;
  horizontalId: string | null;
  shortId: string | null;
  note: string | null;
  at: string;
  /** Quando o alerta ao editor saiu (um por edição). */
  alertedAt?: string | null;
}

/** Lê o registro de forma estrita: registro ilegível nunca vira "não vinculado". */
export function parseShortRelatedRecord(raw: string, aammdd: string, where = SHORT_RELATED_FILE): ShortRelatedRecord {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${where}: JSON inválido (${(e as Error).message}) — corrija ou apague à mão`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`${where}: não é um objeto`);
  if (parsed.aammdd !== aammdd) throw new Error(`${where}: é da edição ${parsed.aammdd}, não de ${aammdd}`);
  if (parsed.status !== "linked" && parsed.status !== "failed") throw new Error(`${where}: status inválido (${parsed.status})`);
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    aammdd,
    status: parsed.status,
    horizontalId: str(parsed.horizontalId),
    shortId: str(parsed.shortId),
    note: str(parsed.note),
    at: str(parsed.at) ?? "",
    alertedAt: str(parsed.alertedAt),
  };
}

/**
 * Novo registro a partir do resultado do Studio. Preserva `alertedAt` do
 * anterior (um alerta por edição). `linked` sem IDs é recusado: o registro é
 * a prova de idempotência e precisa dizer o que foi vinculado a quê.
 */
export function buildShortRelatedRecord(input: {
  aammdd: string;
  status: ShortRelatedStatus;
  horizontalId: string | null;
  shortId: string | null;
  note: string | null;
  now: Date;
  previous: ShortRelatedRecord | null;
}): ShortRelatedRecord {
  if (input.status === "linked" && (!input.horizontalId || !input.shortId)) {
    throw new Error("--record linked exige os IDs do horizontal e do Short (o plano não resolveu algum dos dois)");
  }
  return {
    aammdd: input.aammdd,
    status: input.status,
    horizontalId: input.horizontalId,
    shortId: input.shortId,
    note: input.note,
    at: input.now.toISOString(),
    alertedAt: input.previous?.alertedAt ?? null,
  };
}

// ─── Decisão ─────────────────────────────────────────────────────────────────

export type ShortRelatedAction = "link" | "wait" | "skip" | "alert";

export interface ShortRelatedPlan {
  aammdd: string;
  action: ShortRelatedAction;
  horizontalId: string | null;
  shortId: string | null;
  horizontalSource: VideoIdSource | null;
  shortSource: VideoIdSource | null;
  /** Estado do horizontal relido pela API (`resolveYouTubeState`); `null` = não conferido. */
  horizontalState: PublishState | null;
  /** Título do horizontal pela API — é o que o seletor do Studio mostra. */
  horizontalTitle: string | null;
  studioUrl: string;
  /** Horário do Short (ISO) — prazo do `wait`; `null` se não derivado. */
  shortAt: string | null;
  retryAfterMinutes: number | null;
  /** Alerta já enviado nesta edição (o CLI não reenvia). */
  alreadyAlerted: boolean;
  reason: string;
}

export interface ShortRelatedPlanInput {
  aammdd: string;
  now: Date;
  editionExists: boolean;
  noVideo: boolean;
  horizontal: ResolvedVideoId | null;
  short: ResolvedVideoId | null;
  horizontalState: PublishState | null;
  horizontalTitle?: string | null;
  /** Motivo de não ter conferido o estado (sem credencial, erro da API). */
  stateError?: string | null;
  shortAt: Date | null;
  record: ShortRelatedRecord | null;
  channelId?: string;
}

/** Pure: o que a task das 06:30 faz agora. */
export function decideShortRelatedPlan(input: ShortRelatedPlanInput): ShortRelatedPlan {
  const base = {
    aammdd: input.aammdd,
    horizontalId: input.horizontal?.id ?? null,
    shortId: input.short?.id ?? null,
    horizontalSource: input.horizontal?.source ?? null,
    shortSource: input.short?.source ?? null,
    horizontalState: input.horizontalState,
    horizontalTitle: input.horizontalTitle ?? null,
    studioUrl: studioShortsListUrl(input.channelId),
    shortAt: input.shortAt ? input.shortAt.toISOString() : null,
    alreadyAlerted: Boolean(input.record?.alertedAt),
  };
  const done = (action: ShortRelatedAction, reason: string, retry: number | null = null): ShortRelatedPlan => ({
    ...base,
    action,
    reason,
    retryAfterMinutes: retry,
  });

  if (!isWeekdayEdition(input.aammdd)) return done("skip", "fim de semana: não há edição");
  if (!input.editionExists) return done("skip", "sem edição neste dia (pasta da edição não existe)");
  if (input.noVideo) return done("skip", "edição marcada sem vídeo (_internal/no-video.json)");

  const rec = input.record;
  if (rec?.status === "linked") {
    const sameIds =
      (!input.horizontal || rec.horizontalId === input.horizontal.id) && (!input.short || rec.shortId === input.short.id);
    if (sameIds) return done("skip", `já vinculado (${rec.shortId} → ${rec.horizontalId}, em ${rec.at})`);
    // IDs mudaram (vídeo re-subido): o vínculo gravado aponta para outro par.
  }

  const pastDeadline = input.shortAt !== null && input.now.getTime() >= input.shortAt.getTime();
  const deadlineText = input.shortAt ? input.shortAt.toISOString() : "desconhecido";
  const waitOrAlert = (why: string): ShortRelatedPlan =>
    pastDeadline || input.shortAt === null
      ? done("alert", `${why}; horário do Short (${deadlineText}) ${input.shortAt ? "já passou" : "não derivado"} — vincule à mão no Studio`)
      : done("wait", `${why}; tentar de novo até o horário do Short (${deadlineText})`, SHORT_RELATED_RETRY_MINUTES);

  if (!input.horizontal && !input.short) return waitOrAlert("horizontal e Short não encontrados (registros nem listagem do canal)");
  if (!input.horizontal) return waitOrAlert("horizontal não encontrado (registro do upload, 05-video-url.txt nem listagem do canal)");
  if (!input.short) return waitOrAlert("Short não encontrado (06-shorts-published.json nem listagem do canal)");

  if (input.horizontalState === "published") {
    const late = pastDeadline ? " (depois do horário do Short — o vínculo ainda vale)" : "";
    return done("link", `horizontal ${input.horizontal.id} público pela API${late}`);
  }
  const stateText = input.horizontalState
    ? `horizontal ${input.horizontal.id} ainda não está público (estado ${input.horizontalState})`
    : `estado do horizontal ${input.horizontal.id} não conferido pela API (${input.stateError ?? "motivo desconhecido"})`;
  return waitOrAlert(stateText);
}

/** Pure: texto do alerta ao editor. */
export function buildShortRelatedAlert(plan: ShortRelatedPlan, note: string | null): { subject: string; body: string } {
  return {
    subject: `[diar.ia.br] Vídeo relacionado do Short ${plan.aammdd} não vinculado`,
    body: [
      `A task das 06:30 não vinculou o horizontal como vídeo relacionado do Short da edição ${plan.aammdd} (#10811).`,
      "",
      `Motivo: ${note ?? plan.reason}`,
      `Horizontal: ${plan.horizontalId ?? "não encontrado"}${plan.horizontalTitle ? ` "${plan.horizontalTitle}"` : ""} (${plan.horizontalState ?? "estado não conferido"})`,
      `Short: ${plan.shortId ?? "não encontrado"}`,
      `Horário do Short: ${plan.shortAt ?? "desconhecido"}`,
      "",
      `Para vincular à mão: ${plan.studioUrl} → o Short → Elementos do vídeo → Vídeo relacionado → Adicionar → Escolha um vídeo específico → o horizontal → Salvar.`,
    ].join("\n"),
  };
}
