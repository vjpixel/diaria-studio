/**
 * scripts/lib/meta-capi-confirmation-batch.ts (#8543, lado Meta)
 *
 * Miolo do lote que sobe a CONFIRMAÇÃO (DOI) do Kit pra Meta Conversions API
 * como evento SECUNDÁRIO — par do lote do Google (#8555). Generaliza o desenho
 * de `scripts/meta-capi-batch-send.ts` (#5504): mesma CAPI, mesmo índice local
 * sem e-mail em claro, mesmo filtro de janela de 7 dias, mesma regra "sem token
 * = dry-run efetivo" — mudando a FONTE (confirmações do Kit em vez do snapshot
 * Beehiiv) e o `event_name`.
 *
 * ## Detecção — reuso, não cópia
 *
 * `selectConfirmationCandidates` / `pickBaseSnapshotDate` /
 * `assessBaseSnapshot` vêm de `google-ads-confirmation-batch.ts` (#8552 snapshot
 * de estado). Uma só definição de "confirmação nova" para os dois canais.
 *
 * ## event_name
 *
 * `SubscriptionConfirmed` (evento custom), PARAMETRIZÁVEL via `--event-name`,
 * e nunca `CompleteRegistration`: esse é o evento que hoje otimiza o conjunto
 * "BR · conversao · sem teto" (cadastro/submit). Subir a confirmação sob o
 * mesmo nome a fundiria com o sinal de otimização, o oposto do item 3 da #8543
 * ("ação nova e SECUNDÁRIA"). `assertConfirmationEventName` recusa o nome do
 * cadastro; teste de regressão trava.
 *
 * ## event_id
 *
 * `computeConfirmationEventId(kitId)` (sha256 de `capi:subscriptionconfirmed:kit:{id}`):
 * uma confirmação por assinante, distinto do id do cadastro. Como não existe
 * lado browser para este evento (o pixel dispara só no submit), o id serve
 * apenas de dedup server-side na Meta e de chave do índice.
 *
 * ## click id / fbc
 *
 * - `fbclid:XXXX` -> `fbc = fb.1.{created_at ms}.{fbclid}` (`buildFbcFromClickId`,
 *   #8003) + hash do e-mail.
 * - SEM click id: DECISÃO documentada — sobe SÓ com o hash do e-mail (a Meta casa
 *   por `em`; é o mesmo caminho do batch de cadastro, #5504, e o análogo ao ECL
 *   do Google sem gclid). Contado em `withoutClickId`. `requireClickId: true`
 *   (`--require-click-id`) inverte: não sobe, registra `skipped-no-click-id`.
 * - click id de OUTRO canal (`gclid:`/`msclkid:`): NÃO sobe pra Meta — mandar
 *   o e-mail de quem clicou num anúncio do Google deixaria a Meta reivindicar
 *   crédito por view-through de um cadastro que não veio dela. Registrado como
 *   `skipped-other-channel`.
 *
 * ## Janela de 7 dias — perda registrada, nunca silenciosa
 *
 * A CAPI só aceita `event_time` dentro de ~7 dias, e a atribuição da Meta é
 * janela de 7 dias de clique. O instante real da confirmação não é exposto pelo
 * Kit; `event_time` = instante da DETECÇÃO (sempre dentro do prazo) e o clique é
 * aproximado por `created_at` (mesma premissa conservadora do Google). Cadastro
 * mais velho que `windowDays` = fora do prazo: gravado no índice como
 * `skipped-out-of-window`, logado com os ids e contado no resumo, nunca enviado.
 *
 * ## Idempotência
 *
 * Índice cumulativo chaveado por `kit-{id}` (nenhum e-mail em claro; guarda
 * também o `eventId` hash). Já enviado / já registrado como pulado não reenvia.
 * Índice ilegível LANÇA (nunca `{}` silencioso, senão reenviaria tudo).
 * Recusa por linha: `failed` com contador; após `MAX_FAILED_ATTEMPTS` vira
 * `skipped-failed-permanent`. Falha de rede/`not_configured` não conta tentativa.
 *
 * ## Guard de publicação
 *
 * `dryRun` (default do CLI) não faz chamada nenhuma nem toca o índice. Sem
 * `accessToken` o envio real vira dry-run efetivo (nada enviado, nada gravado).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import {
  KIT_CLICK_ID_FIELD_NAME,
  selectConfirmationCandidates,
  type ConfirmationCandidate,
  type ConfirmationPath,
  type ConfirmationRosterEntry,
} from "./google-ads-confirmation-batch.ts";
import type { SubscriberStateRecord } from "./subscriber-state-snapshot.ts";
import {
  META_CAPI_CONFIRMATION_EVENT_NAME,
  META_CAPI_DEFAULT_DATASET_ID,
  META_CLICK_ID_PREFIX,
  buildFbcFromClickId,
  computeConfirmationEventId,
  sendCompleteRegistrationEvent,
  type BuildCompleteRegistrationEventInput,
  type MetaCapiSendResult,
  type SendMetaCapiEventOptions,
} from "./shared/meta-capi.ts";

export const META_CONFIRMATION_DEFAULT_WINDOW_DAYS = 7;
export const META_CONFIRMATION_MAX_FAILED_ATTEMPTS = 3;
export const META_CONFIRMATION_EVENT_SOURCE_URL = "https://diar.ia.br/confirmada";
const EVENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
const REGISTRATION_EVENT_NAME = "CompleteRegistration";

export function assertConfirmationEventName(name: string): string {
  const trimmed = name.trim();
  if (!EVENT_NAME_RE.test(trimmed)) {
    throw new Error(`event_name inválido: "${name}" (esperado [A-Za-z][A-Za-z0-9_]{0,49})`);
  }
  if (trimmed.toLowerCase() === REGISTRATION_EVENT_NAME.toLowerCase()) {
    throw new Error(
      `event_name "${name}" é o evento de OTIMIZAÇÃO do cadastro — a confirmação precisa de nome distinto ` +
        "(#8543: sinal secundário, sem fundir com o evento que otimiza o conjunto).",
    );
  }
  return trimmed;
}

export type MetaConfirmationStatus =
  | "sent"
  | "failed"
  | "skipped-out-of-window"
  | "skipped-no-click-id"
  | "skipped-other-channel"
  | "skipped-failed-permanent";
const VALID_STATUSES: ReadonlySet<string> = new Set<MetaConfirmationStatus>([
  "sent",
  "failed",
  "skipped-out-of-window",
  "skipped-no-click-id",
  "skipped-other-channel",
  "skipped-failed-permanent",
]);
export interface MetaConfirmationIndexEntry {
  status: MetaConfirmationStatus;
  at: string;
  path: ConfirmationPath;
  eventId?: string;
  attempts?: number;
}
export type MetaConfirmationIndex = Record<string, MetaConfirmationIndexEntry>;

export function metaIndexKey(id: number): string {
  return `kit-${id}`;
}

export function loadMetaConfirmationIndex(path: string): MetaConfirmationIndex {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`índice de idempotência ilegível (${path}): ${e instanceof Error ? e.message : e}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`índice de idempotência inválido (${path}): esperado objeto JSON`);
  }
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const status = (v as { status?: unknown } | null)?.status;
    if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
      throw new Error(`índice de idempotência inválido (${path}): entrada "${k}" com status "${String(status)}"`);
    }
  }
  return parsed as MetaConfirmationIndex;
}

export function saveMetaConfirmationIndex(path: string, index: MetaConfirmationIndex): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(index, null, 2) + "\n");
}

export type ClickIdKind = "meta" | "other" | "none";

/** Classifica o `origem_click_id` cru. @pure */
export function classifyClickId(clickId: string | undefined): ClickIdKind {
  const raw = (clickId ?? "").trim();
  if (!raw) return "none";
  return raw.toLowerCase().startsWith(META_CLICK_ID_PREFIX) ? "meta" : "other";
}

/** `true` quando o cadastro é mais velho que a janela (ou `created_at` ilegível). @pure */
export function isOutOfMetaWindow(createdAtIso: string, nowMs: number, windowDays: number): boolean {
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) return true;
  return nowMs - created > windowDays * 24 * 60 * 60 * 1000;
}

export interface MetaConfirmationSummary {
  dryRun: boolean;
  /** Sem token no envio real: nada foi enviado nem indexado. */
  effectiveDryRun: boolean;
  eventName: string;
  detected: number;
  unattributedNewActive: number;
  skippedNoBase: number;
  alreadyIndexed: number;
  outOfWindow: number;
  outOfWindowIds: number[];
  skippedNoClickId: number;
  skippedOtherChannel: number;
  toSend: number;
  withFbc: number;
  withoutClickId: number;
  sent: number;
  failed: number;
  failedPermanent: number;
  failedIds: number[];
  notConfigured: number;
}

export type MetaSendFn = (
  input: BuildCompleteRegistrationEventInput,
  options: SendMetaCapiEventOptions,
) => Promise<MetaCapiSendResult>;

export interface RunMetaConfirmationBatchDeps {
  roster: readonly ConfirmationRosterEntry[];
  baseSnapshot: readonly SubscriberStateRecord[];
  baseDate: string;
  indexPath: string;
  dryRun: boolean;
  eventName?: string;
  windowDays?: number;
  requireClickId?: boolean;
  limit?: number;
  accessToken?: string;
  testEventCode?: string;
  fetchImpl?: typeof fetch;
  sendFn?: MetaSendFn;
  now?: Date;
  log?: (msg: string) => void;
}

interface Planned {
  cand: ConfirmationCandidate;
  eventId: string;
  fbc?: string;
}

export async function runMetaConfirmationBatch(deps: RunMetaConfirmationBatchDeps): Promise<MetaConfirmationSummary> {
  const log = deps.log ?? ((m: string) => process.stderr.write(`[meta-capi-confirmations] ${m}\n`));
  const eventName = assertConfirmationEventName(deps.eventName ?? META_CAPI_CONFIRMATION_EVENT_NAME);
  const windowDays = deps.windowDays ?? META_CONFIRMATION_DEFAULT_WINDOW_DAYS;
  const now = deps.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const accessToken = deps.accessToken ?? process.env.META_CAPI_ACCESS_TOKEN;
  const sendFn = deps.sendFn ?? sendCompleteRegistrationEvent;
  const effectiveDryRun = deps.dryRun || !accessToken;

  const { candidates: detected, skippedNoBase } = selectConfirmationCandidates(deps.roster, deps.baseSnapshot, deps.baseDate);
  const index = loadMetaConfirmationIndex(deps.indexPath);
  const detectedIds = new Set(detected.map((c) => c.id));
  // Recusas anteriores que já saíram da janela do snapshot base seguem elegíveis a retry.
  for (const s of deps.roster) {
    const e = index[metaIndexKey(s.id)];
    if (s.state === "active" && e?.status === "failed" && !detectedIds.has(s.id)) {
      detected.push({
        id: s.id,
        email: (s.email_address ?? "").trim(),
        createdAt: s.created_at,
        path: e.path,
        clickId: (s.fields?.[KIT_CLICK_ID_FIELD_NAME] ?? "").trim() || undefined,
        ambiguous: false,
      });
    }
  }
  const pending = detected.filter((c) => {
    const e = index[metaIndexKey(c.id)];
    return !e || (e.status === "failed" && (e.attempts ?? 0) < META_CONFIRMATION_MAX_FAILED_ATTEMPTS);
  });

  const summary: MetaConfirmationSummary = {
    dryRun: deps.dryRun,
    effectiveDryRun,
    eventName,
    detected: detected.length,
    unattributedNewActive: detected.filter((c) => c.ambiguous).length,
    skippedNoBase,
    alreadyIndexed: detected.length - pending.length,
    outOfWindow: 0,
    outOfWindowIds: [],
    skippedNoClickId: 0,
    skippedOtherChannel: 0,
    toSend: 0,
    withFbc: 0,
    withoutClickId: 0,
    sent: 0,
    failed: 0,
    failedPermanent: 0,
    failedIds: [],
    notConfigured: 0,
  };

  // #8616 item 2: grava o índice a cada entrada (não só no fim do lote) — um
  // kill no meio do processamento não deixa entradas já resolvidas sem
  // registro, o que reenviaria com `event_time` novo na próxima rodada.
  const record = (c: ConfirmationCandidate, entry: Omit<MetaConfirmationIndexEntry, "at" | "path">): void => {
    if (effectiveDryRun) return;
    index[metaIndexKey(c.id)] = { at: nowIso, path: c.path, ...entry };
    saveMetaConfirmationIndex(deps.indexPath, index);
  };

  if (skippedNoBase > 0) {
    log(`${skippedNoBase} assinante(s) active ausente(s) da base e cadastrado(s) antes dela — pulados (anomalia do snapshot).`);
  }

  const planned: Planned[] = [];
  for (const c of pending) {
    const eventId = await computeConfirmationEventId(c.id);
    if (isOutOfMetaWindow(c.createdAt, nowMs, windowDays)) {
      summary.outOfWindow++;
      summary.outOfWindowIds.push(c.id);
      record(c, { status: "skipped-out-of-window", eventId });
      continue;
    }
    const kind = classifyClickId(c.clickId);
    if (kind === "other") {
      summary.skippedOtherChannel++;
      record(c, { status: "skipped-other-channel", eventId });
      continue;
    }
    if (kind === "none" && deps.requireClickId) {
      summary.skippedNoClickId++;
      record(c, { status: "skipped-no-click-id", eventId });
      continue;
    }
    const fbc = kind === "meta" ? buildFbcFromClickId(c.clickId, Date.parse(c.createdAt)) : undefined;
    if (fbc) summary.withFbc++;
    else summary.withoutClickId++; // sem click id, ou fbclid malformado: só hash de e-mail
    planned.push({ cand: c, eventId, fbc });
  }
  if (summary.outOfWindow > 0) {
    log(
      `${summary.outOfWindow} confirmação(ões) fora da janela de ${windowDays} dias (kit ids ${summary.outOfWindowIds.join(", ")}) — ` +
        `${effectiveDryRun ? "seriam registradas" : "registradas"} como skipped-out-of-window e NÃO enviadas.`,
    );
  }

  const toSend = typeof deps.limit === "number" ? planned.slice(0, deps.limit) : planned;
  summary.toSend = toSend.length;

  if (effectiveDryRun) {
    if (!deps.dryRun) log("META_CAPI_ACCESS_TOKEN ausente — dry-run efetivo: nada enviado, índice intocado.");
    log(`dry-run: ${toSend.length} confirmação(ões) seriam enviadas como "${eventName}".`);
    return summary;
  }

  for (const { cand, eventId, fbc } of toSend) {
    const result = await sendFn(
      {
        email: cand.email,
        eventSourceUrl: META_CONFIRMATION_EVENT_SOURCE_URL,
        // Instante da DETECÇÃO: o Kit não expõe o da confirmação e assim nunca cai fora dos 7 dias da CAPI.
        eventTimeSeconds: Math.floor(nowMs / 1000),
        actionSource: "system_generated",
        eventName,
        eventId,
        clientSignals: fbc ? { fbc } : undefined,
      },
      {
        accessToken,
        datasetId: META_CAPI_DEFAULT_DATASET_ID,
        testEventCode: deps.testEventCode,
        fetchImpl: deps.fetchImpl ?? fetch,
      },
    );
    if (result.ok) {
      summary.sent++;
      record(cand, { status: "sent", eventId });
    } else if (result.reason === "not_configured") {
      summary.notConfigured++;
    } else if (result.reason === "meta_error") {
      summary.failed++;
      summary.failedIds.push(cand.id);
      const attempts = (index[metaIndexKey(cand.id)]?.attempts ?? 0) + 1;
      if (attempts >= META_CONFIRMATION_MAX_FAILED_ATTEMPTS) {
        summary.failedPermanent++;
        record(cand, { status: "skipped-failed-permanent", eventId, attempts });
        log(`kit id ${cand.id} recusado ${attempts}x pela Meta — desistindo (skipped-failed-permanent).`);
      } else {
        record(cand, { status: "failed", eventId, attempts });
      }
    } else {
      // rede: não conta tentativa, reprocessa na próxima rodada
      summary.failed++;
      summary.failedIds.push(cand.id);
    }
  }
  log(`resumo: ${summary.sent} enviados, ${summary.failed} falharam, ${summary.outOfWindow} fora da janela.`);
  return summary;
}
