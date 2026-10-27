/**
 * scripts/lib/diaria/youtube-short-related.ts (#10811)
 *
 * Lógica pura do vínculo "vídeo relacionado" do Short ao horizontal da mesma
 * edição. A YouTube Data API não expõe esse campo (`docs/youtube-short-related-video.md`),
 * então quem vincula é uma task LOCAL do app Claude desktop no Neo, dias úteis
 * às 06:05 BRT, com o Claude in Chrome no YouTube Studio logado no @diariabr
 * (decisão do editor de 22/10, reconfirmada em 26/10; roteiro em
 * `.claude/skills/diaria-publica-video/short-related-task.md`). Este módulo
 * só decide O QUE a task faz, de forma determinística (#573):
 *
 *   - `skip`  — fim de semana, sem edição, edição sem vídeo, ou já vinculado;
 *   - `link`  — horizontal confirmado PÚBLICO pela API (e com título lido, que
 *               é o que o seletor do Studio mostra): abrir o Studio e vincular;
 *   - `wait`  — algo ainda não está pronto (horizontal não público, ID ainda
 *               não registrado, título não lido, estado não conferido por
 *               falha TRANSITÓRIA de rede/5xx) e o prazo de desistência não
 *               passou: tentar de novo. Depois do horário do Short o `wait`
 *               vem com `alertDue: true` — o editor é avisado no prazo, mas a
 *               task segue tentando por `SHORT_RELATED_GIVE_UP_MINUTES`,
 *               porque o vínculo depois do Short no ar ainda vale;
 *   - `alert` — não adianta esperar: erro PERMANENTE (credencial ausente ou
 *               recusada, 401/403, quota), horizontal e Short com o mesmo ID,
 *               horário do Short desconhecido, ou passou o prazo de desistência.
 *
 * O resultado do Studio volta pelo registro `_internal/06-short-related.json`
 * (`--record linked|failed` e `--alert` do CLI `scripts/youtube-short-related-plan.ts`).
 * Registro `linked` com os mesmos IDs torna a task idempotente.
 */

import type { PublishState } from "../publish-state.ts";
import { extractYouTubeVideoId } from "./d1-video-link.ts";
import type { ShortsPublishedFile } from "./short-video.ts";
import type { ExistingEditionVideo } from "./youtube-upload.ts";
import type { YouTubeRecordSummary } from "./youtube-video-link-gate.ts";

/** Registro do vínculo, em `_internal/` da edição. */
export const SHORT_RELATED_FILE = "_internal/06-short-related.json";

/** Canal @diariabr. O Studio precisa ser aberto pela lista DESTE canal (#10811). */
export const DIARIA_YOUTUBE_CHANNEL_ID = "UCSsppeUnBy6q-4a5hsl5u0w";

/** Intervalo entre conferências enquanto o plano diz `wait` (o `--poll-minutes` do CLI usa o mesmo). */
export const SHORT_RELATED_RETRY_MINUTES = 2;

/** Quanto tempo depois do horário do Short a task ainda tenta vincular. */
export const SHORT_RELATED_GIVE_UP_MINUTES = 60;

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

/**
 * Aceita o vídeo achado pela listagem do canal? Marca da edição ou título
 * valem; o sinal fraco (só o dia da edição) vale com um único candidato —
 * vários vídeos no dia (live, avulso) seriam chute.
 */
export function acceptListingMatch(v: ExistingEditionVideo | null): ExistingEditionVideo | null {
  if (!v) return null;
  if (v.matchedBy !== "period") return v;
  return (v.periodCandidates?.length ?? 1) === 1 ? v : null;
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

// ─── Credenciais (#8237) ─────────────────────────────────────────────────────

/** O que a leitura do estado precisa (o canal é fixo: `DIARIA_YOUTUBE_CHANNEL_ID`). */
export const YOUTUBE_READ_CREDENTIAL_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"] as const;

export interface YouTubeReadCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Credenciais da leitura, com o `.env` do repo VENCENDO o ambiente (#8237): no
 * Neo o app desktop injeta `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` de OUTRO
 * client OAuth no ambiente, e a task roda justamente dentro dele. Chave
 * ausente no `.env` cai no ambiente. Devolve também quais chaves o `.env`
 * sobrepôs (diagnóstico) e quais faltam nos dois.
 */
export function resolveYouTubeReadCredentials(
  fileVars: Record<string, string>,
  env: Record<string, string | undefined>,
): { credentials: YouTubeReadCredentials | null; missing: string[]; overridden: string[] } {
  const pick = (k: string): string => (fileVars[k] ?? "").trim() || (env[k] ?? "").trim();
  const missing = YOUTUBE_READ_CREDENTIAL_KEYS.filter((k) => !pick(k));
  const overridden = YOUTUBE_READ_CREDENTIAL_KEYS.filter(
    (k) => (fileVars[k] ?? "").trim() && (env[k] ?? "").trim() && fileVars[k].trim() !== env[k]!.trim(),
  );
  if (missing.length) return { credentials: null, missing: [...missing], overridden: [...overridden] };
  return {
    credentials: {
      clientId: pick("GOOGLE_CLIENT_ID"),
      clientSecret: pick("GOOGLE_CLIENT_SECRET"),
      refreshToken: pick("YOUTUBE_REFRESH_TOKEN"),
    },
    missing: [],
    overridden: [...overridden],
  };
}

// ─── Classificação de erro da API ────────────────────────────────────────────

export type StateErrorKind = "permanent" | "transient";

/**
 * Falha ao conferir o estado: TRANSITÓRIA só quando é rede ou 5xx (vale
 * esperar); o resto (credencial ausente, `invalid_grant`, `invalid_client`,
 * 401, 403, quota, resposta inesperada) é PERMANENTE no horizonte da task — esperar
 * não resolve, o editor precisa saber já. As mensagens vêm de
 * `explainYouTubeUploadError` ("sem rede…", "YouTube API respondeu 503…") ou
 * do `fetch` ("fetch failed", ECONNRESET…).
 */
export function classifyYouTubeError(message: string): StateErrorKind {
  return /sem rede|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timeout|respondeu 5\d\d|\b5\d\d\b/i.test(message)
    ? "transient"
    : "permanent";
}

// ─── Registro do resultado ───────────────────────────────────────────────────

interface ShortRelatedRecordBase {
  aammdd: string;
  note: string | null;
  /** ISO do último registro. */
  at: string;
  /** Quando o alerta ao editor saiu (um por edição); `null` = não saiu. */
  alertedAt: string | null;
}

/**
 * Registro do vínculo. `linked` exige os dois IDs (é a prova de
 * idempotência). `failed` = o Studio falhou; `alerted` = só o alerta saiu,
 * sem tentativa registrada (ex.: horizontal nunca ficou público).
 */
export type ShortRelatedRecord =
  | (ShortRelatedRecordBase & { status: "linked"; horizontalId: string; shortId: string })
  | (ShortRelatedRecordBase & { status: "failed" | "alerted"; horizontalId: string | null; shortId: string | null });

/** Valida os campos e monta o registro — mesma regra no builder e no parser. */
function makeRecord(fields: {
  aammdd: string;
  status: unknown;
  horizontalId: string | null;
  shortId: string | null;
  note: string | null;
  at: string | null;
  alertedAt: string | null;
}, where: string): ShortRelatedRecord {
  if (!fields.at || Number.isNaN(Date.parse(fields.at))) throw new Error(`${where}: sem "at" válido`);
  const base = { aammdd: fields.aammdd, note: fields.note, at: fields.at, alertedAt: fields.alertedAt };
  if (fields.status === "linked") {
    if (!fields.horizontalId || !fields.shortId) {
      throw new Error(`${where}: "linked" exige os IDs do horizontal e do Short`);
    }
    return { ...base, status: "linked", horizontalId: fields.horizontalId, shortId: fields.shortId };
  }
  if (fields.status === "failed" || fields.status === "alerted") {
    return { ...base, status: fields.status, horizontalId: fields.horizontalId, shortId: fields.shortId };
  }
  throw new Error(`${where}: status inválido (${String(fields.status)})`);
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
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  if (parsed.alertedAt !== undefined && parsed.alertedAt !== null && typeof parsed.alertedAt !== "string") {
    throw new Error(`${where}: "alertedAt" precisa ser string ou null`);
  }
  return makeRecord(
    {
      aammdd,
      status: parsed.status,
      horizontalId: str(parsed.horizontalId),
      shortId: str(parsed.shortId),
      note: str(parsed.note),
      at: str(parsed.at),
      alertedAt: str(parsed.alertedAt),
    },
    where,
  );
}

/**
 * Novo registro a partir do resultado do Studio. Preserva `alertedAt` do
 * anterior (um alerta por edição).
 */
export function buildShortRelatedRecord(input: {
  aammdd: string;
  status: "linked" | "failed";
  horizontalId: string | null;
  shortId: string | null;
  note: string | null;
  now: Date;
  previous: ShortRelatedRecord | null;
}): ShortRelatedRecord {
  return makeRecord(
    {
      aammdd: input.aammdd,
      status: input.status,
      horizontalId: input.horizontalId,
      shortId: input.shortId,
      note: input.note,
      at: input.now.toISOString(),
      alertedAt: input.previous?.alertedAt ?? null,
    },
    "--record",
  );
}

/**
 * Registro depois de um alerta enviado: o anterior ganha `alertedAt`; sem
 * anterior (ou anterior ilegível), nasce um `alerted` com os IDs que o plano
 * tiver.
 */
export function markAlerted(input: {
  aammdd: string;
  previous: ShortRelatedRecord | null;
  horizontalId: string | null;
  shortId: string | null;
  note: string | null;
  now: Date;
}): ShortRelatedRecord {
  const alertedAt = input.now.toISOString();
  if (input.previous) return { ...input.previous, alertedAt };
  return {
    aammdd: input.aammdd,
    status: "alerted",
    horizontalId: input.horizontalId,
    shortId: input.shortId,
    note: input.note,
    at: alertedAt,
    alertedAt,
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
  /** Horário do Short (ISO) — prazo do alerta; `null` se não derivado. */
  shortAt: string | null;
  /** Prazo de desistência (ISO): `shortAt` + `SHORT_RELATED_GIVE_UP_MINUTES`. */
  giveUpAt: string | null;
  /** `wait` depois do horário do Short: alertar o editor agora e continuar tentando. */
  alertDue: boolean;
  retryAfterMinutes: number | null;
  /** O registro já diz `linked` com estes IDs. */
  alreadyLinked: boolean;
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
  /** Default: `classifyYouTubeError(stateError)`. */
  stateErrorKind?: StateErrorKind | null;
  /** Motivo de um ID não ter sido resolvido (registro ilegível etc.). */
  resolveError?: string | null;
  shortAt: Date | null;
  record: ShortRelatedRecord | null;
  channelId?: string;
}

/** Pure: o que a task faz agora. */
export function decideShortRelatedPlan(input: ShortRelatedPlanInput): ShortRelatedPlan {
  const giveUp = input.shortAt ? new Date(input.shortAt.getTime() + SHORT_RELATED_GIVE_UP_MINUTES * 60_000) : null;
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
    giveUpAt: giveUp ? giveUp.toISOString() : null,
    alreadyAlerted: Boolean(input.record?.alertedAt),
  };
  const done = (
    action: ShortRelatedAction,
    reason: string,
    extra: { retry?: number | null; alertDue?: boolean; alreadyLinked?: boolean } = {},
  ): ShortRelatedPlan => ({
    ...base,
    action,
    reason,
    retryAfterMinutes: extra.retry ?? null,
    alertDue: extra.alertDue ?? false,
    alreadyLinked: extra.alreadyLinked ?? false,
  });

  if (!isWeekdayEdition(input.aammdd)) return done("skip", "fim de semana: não há edição");
  if (!input.editionExists) return done("skip", "sem edição neste dia (pasta da edição não existe)");
  if (input.noVideo) return done("skip", "edição marcada sem vídeo (_internal/no-video.json)");

  const rec = input.record;
  if (rec?.status === "linked") {
    const sameIds =
      (!input.horizontal || rec.horizontalId === input.horizontal.id) && (!input.short || rec.shortId === input.short.id);
    if (sameIds) return done("skip", `já vinculado (${rec.shortId} → ${rec.horizontalId}, em ${rec.at})`, { alreadyLinked: true });
    // IDs mudaram (vídeo re-subido): o vínculo gravado aponta para outro par.
  }

  const nowMs = input.now.getTime();
  const pastAlert = input.shortAt !== null && nowMs >= input.shortAt.getTime();
  const pastGiveUp = giveUp !== null && nowMs >= giveUp.getTime();
  const alertNow = (why: string): ShortRelatedPlan => done("alert", `${why} — vincule à mão no Studio`);
  const notReady = (why: string): ShortRelatedPlan => {
    if (input.shortAt === null) return alertNow(`${why}; horário do Short não derivado, não há prazo para esperar`);
    if (pastGiveUp) return alertNow(`${why}; passou ${SHORT_RELATED_GIVE_UP_MINUTES} min do horário do Short (${base.shortAt})`);
    if (pastAlert) {
      return done("wait", `${why}; horário do Short (${base.shortAt}) já passou — alertar e continuar tentando até ${base.giveUpAt}`, {
        retry: SHORT_RELATED_RETRY_MINUTES,
        alertDue: true,
      });
    }
    return done("wait", `${why}; tentar de novo até o horário do Short (${base.shortAt})`, { retry: SHORT_RELATED_RETRY_MINUTES });
  };

  const errorKind = input.stateError ? (input.stateErrorKind ?? classifyYouTubeError(input.stateError)) : null;
  if (input.stateError && errorKind === "permanent") {
    // Credencial ausente/recusada também impede a listagem: esperar não resolve.
    return alertNow(`erro permanente na YouTube API: ${input.stateError}`);
  }

  const causes = [input.resolveError, input.stateError].filter((c): c is string => Boolean(c));
  const resolveNote = causes.length ? ` (${causes.join("; ")})` : "";
  if (!input.horizontal && !input.short) return notReady(`horizontal e Short não encontrados (registros nem listagem do canal)${resolveNote}`);
  if (!input.horizontal) return notReady(`horizontal não encontrado (registro do upload, 05-video-url.txt nem listagem do canal)${resolveNote}`);
  if (!input.short) return notReady(`Short não encontrado (06-shorts-published.json nem listagem do canal)${resolveNote}`);
  if (input.horizontal.id === input.short.id) {
    return alertNow(`horizontal e Short resolvidos para o MESMO vídeo (${input.horizontal.id}) — algum registro está errado`);
  }

  if (input.stateError) {
    return notReady(`estado do horizontal ${input.horizontal.id} não conferido (falha transitória: ${input.stateError})`);
  }
  if (input.horizontalState !== "published") {
    return notReady(`horizontal ${input.horizontal.id} ainda não está público (estado ${input.horizontalState ?? "não conferido"})`);
  }
  if (!input.horizontalTitle) {
    return notReady(`horizontal ${input.horizontal.id} público, mas o título não foi lido pela API (o seletor do Studio escolhe pelo título)`);
  }
  const late = pastAlert ? " (depois do horário do Short — o vínculo ainda vale)" : "";
  return done("link", `horizontal ${input.horizontal.id} público pela API${late}`);
}

/**
 * Pure: IDs que o `--record linked` grava. Aceita o registro quando o plano
 * recalculado é `link` ou "já vinculado", ou — para o caso de a API cair entre
 * o plano e o registro — quando os IDs explícitos do Passo 1 vieram e não
 * divergem de nenhum ID recalculado. Divergência é sempre recusada.
 */
export function resolveLinkedRecordIds(
  plan: ShortRelatedPlan,
  explicit: { horizontalId?: string | null; shortId?: string | null },
): { horizontalId: string; shortId: string } {
  const eh = explicit.horizontalId ?? null;
  const es = explicit.shortId ?? null;
  if (eh && plan.horizontalId && eh !== plan.horizontalId) {
    throw new Error(`--horizontal-id ${eh} diverge do horizontal recalculado (${plan.horizontalId})`);
  }
  if (es && plan.shortId && es !== plan.shortId) throw new Error(`--short-id ${es} diverge do Short recalculado (${plan.shortId})`);
  const ok = plan.action === "link" || plan.alreadyLinked || (plan.action !== "skip" && Boolean(eh && es));
  if (!ok) {
    throw new Error(`--record linked recusado: o plano agora é "${plan.action}" (${plan.reason}); passe --horizontal-id/--short-id do plano que mandou vincular`);
  }
  const horizontalId = eh ?? plan.horizontalId;
  const shortId = es ?? plan.shortId;
  if (!horizontalId || !shortId) throw new Error("--record linked sem os IDs do horizontal e do Short");
  return { horizontalId, shortId };
}

/** Pure: texto do alerta ao editor. */
export function buildShortRelatedAlert(plan: ShortRelatedPlan, note: string | null): { subject: string; body: string } {
  return {
    subject: `[diar.ia.br] Vídeo relacionado do Short ${plan.aammdd} não vinculado`,
    body: [
      `A task do vídeo relacionado não vinculou o horizontal ao Short da edição ${plan.aammdd} (#10811).`,
      "",
      `Motivo: ${note ?? plan.reason}`,
      `Horizontal: ${plan.horizontalId ?? "não encontrado"}${plan.horizontalTitle ? ` "${plan.horizontalTitle}"` : ""} (${plan.horizontalState ?? "estado não conferido"})`,
      `Short: ${plan.shortId ?? "não encontrado"}`,
      `Horário do Short: ${plan.shortAt ?? "desconhecido"}`,
      plan.action === "wait" ? `A task segue tentando até ${plan.giveUpAt}.` : "A task desistiu.",
      "",
      manualStudioSteps(plan.studioUrl),
    ].join("\n"),
  };
}

function manualStudioSteps(studioUrl: string): string {
  return `Para vincular à mão: ${studioUrl} → o Short → Elementos do vídeo → Vídeo relacionado → Adicionar → Escolha um vídeo específico → o horizontal → Salvar.`;
}

/** Pure: alerta de fallback quando nem o plano deu para montar. */
export function buildShortRelatedFallbackAlert(aammdd: string, error: string, note: string | null): { subject: string; body: string } {
  return {
    subject: `[diar.ia.br] Vídeo relacionado do Short ${aammdd} não vinculado (erro no plano)`,
    body: [
      `A task do vídeo relacionado (#10811) não conseguiu nem montar o plano da edição ${aammdd}.`,
      "",
      `Erro: ${error}`,
      ...(note ? [`Nota da task: ${note}`] : []),
      "",
      manualStudioSteps(studioShortsListUrl()),
    ].join("\n"),
  };
}

// ─── Alerta (orquestração com I/O injetado) ──────────────────────────────────

export interface ShortRelatedAlertDeps {
  aammdd: string;
  note: string | null;
  now: Date;
  /** Monta o plano; pode lançar (registro ilegível, rede…). */
  computePlan: () => Promise<ShortRelatedPlan>;
  /** Lê o registro anterior; pode lançar (ilegível = envia sem dedup). */
  readRecord: () => ShortRelatedRecord | null;
  send: (message: { subject: string; body: string }) => Promise<{ ok: boolean; error?: string }>;
  writeRecord: (rec: ShortRelatedRecord) => void;
  log: (line: string) => void;
}

export type ShortRelatedAlertOutcome =
  | { kind: "skipped"; alertedAt: string }
  | { kind: "sent"; subject: string; recorded: true }
  | { kind: "sent-not-recorded"; subject: string; error: string }
  | { kind: "send-failed"; error: string };

/**
 * `--alert`: nada do que ele reporta pode impedi-lo de sair. Plano que lança
 * vira corpo de fallback; registro anterior ilegível vira envio sem dedup;
 * e-mail enviado com falha ao gravar o registro é um desfecho próprio (o
 * editor FOI avisado, só a dedup ficou sem registro).
 */
export async function runShortRelatedAlert(deps: ShortRelatedAlertDeps): Promise<ShortRelatedAlertOutcome> {
  let previous: ShortRelatedRecord | null = null;
  let previousUnreadable = false;
  try {
    previous = deps.readRecord();
  } catch (e) {
    deps.log(`[aviso] registro anterior ilegível (${(e as Error).message}) — envia sem dedup e não sobrescreve o arquivo`);
    previousUnreadable = true;
  }
  if (previous?.alertedAt) return { kind: "skipped", alertedAt: previous.alertedAt };

  let plan: ShortRelatedPlan | null = null;
  let message: { subject: string; body: string };
  try {
    plan = await deps.computePlan();
    message = buildShortRelatedAlert(plan, deps.note);
  } catch (e) {
    deps.log(`[aviso] plano falhou (${(e as Error).message}) — alerta com corpo de fallback`);
    message = buildShortRelatedFallbackAlert(deps.aammdd, (e as Error).message, deps.note);
  }

  const sent = await deps.send(message);
  if (!sent.ok) return { kind: "send-failed", error: sent.error ?? "erro desconhecido" };
  if (previousUnreadable) {
    return { kind: "sent-not-recorded", subject: message.subject, error: "registro anterior ilegível — não sobrescrito (corrija à mão)" };
  }
  try {
    deps.writeRecord(
      markAlerted({
        aammdd: deps.aammdd,
        previous,
        horizontalId: plan?.horizontalId ?? null,
        shortId: plan?.shortId ?? null,
        note: deps.note ?? plan?.reason ?? null,
        now: deps.now,
      }),
    );
  } catch (e) {
    return { kind: "sent-not-recorded", subject: message.subject, error: (e as Error).message };
  }
  return { kind: "sent", subject: message.subject, recorded: true };
}
