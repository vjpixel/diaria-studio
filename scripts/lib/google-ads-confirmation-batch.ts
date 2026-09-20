/**
 * scripts/lib/google-ads-confirmation-batch.ts (#8555)
 *
 * Miolo do lote diário que sobe a CONFIRMAÇÃO (DOI) do Kit pro Google Ads
 * como Enhanced Conversion for Leads — o par Google do `reativar`/CAPI da
 * Meta (#8551), sem o defeito de misturar cadastro e confirmação: a ação de
 * destino é uma `UPLOAD_CLICKS` SEPARADA (a do CADASTRO é outra), passada por
 * id explícito (`--conversion-action-id` / `GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID`),
 * nunca hardcoded.
 *
 * ## Como detecta "confirmação nova"
 *
 * O Kit não guarda o instante da confirmação. `scripts/subscriber-state-snapshot.ts`
 * (#8552) grava todo dia `(id, state, created_at)` do roster; aqui compara-se
 * o roster de agora com um snapshot BASE (o mais antigo dentro da janela de
 * lookback, ver `pickBaseSnapshotDate`) e sobem os ids que estavam
 * não-`active` na base e hoje são `active`. O lookback (default 7d) cobre dias
 * em que o lote não rodou; a duplicidade entre rodadas sobrepostas é
 * eliminada pelo índice de idempotência, não pela janela.
 *
 * Os dois caminhos de confirmação do Kit caem no mesmo critério (ficou
 * `active`): o link do e-mail do próprio Kit e o botão da Brevo (#8194, que
 * carimba o custom field `confirmou_via = "brevo-reativar"`, #8438). O campo
 * só distingue o CAMINHO no relatório — nenhum dos dois é filtrado fora.
 *
 * Assinante que aparece pela 1ª vez já `active` (sem estado anterior na base)
 * NÃO é confirmação — é cadastro single-opt-in, coberto pela ação de cadastro
 * — a menos que carregue `confirmou_via` (prova positiva do botão Brevo).
 * Resíduo conhecido: quem se cadastra inactive E confirma entre dois
 * snapshots do mesmo dia nasce `active` na visão do snapshot e só sobe se
 * tiver `confirmou_via`.
 *
 * ## gclid opcional, hash de e-mail sempre
 *
 * `gclid` vem do custom field `origem_click_id` (#8003, formato
 * `gclid:XXXX`) quando existe; o hash SHA-256 do e-mail sobe SEMPRE (é isso
 * que cobre os ~21% de cadastros sem gclid). `wbraid`/`gbraid` não são
 * capturados no cadastro.
 *
 * ## Janela de 90 dias
 *
 * O import do Google aceita conversão até 90 dias após o clique. O instante
 * do clique não é gravado; usa-se `created_at` (cadastro, sempre posterior ao
 * clique) como aproximação conservadora. Fora da janela: REGISTRADO no índice
 * como `skipped-out-of-window` e pulado — nunca some em silêncio, nunca é
 * reenviado.
 *
 * ## Idempotência
 *
 * Índice local cumulativo (mesmo padrão de `_meta-capi-sent.json`, #5504),
 * chaveado por `kit-{id}` (id numérico do Kit — nenhum e-mail em claro).
 * Segunda rede: `order_id = diaria-confirmacao-kit-{id}` no payload, que o
 * Google usa pra deduplicar do lado dele.
 *
 * ## conversion_date_time
 *
 * Instante da DETECÇÃO (o Kit não expõe o da confirmação), com offset BRT
 * fixo -03:00. Sempre posterior ao clique. O corte de segurança do #7770
 * (`validateSignupRecords`) protege o CADASTRO já contado pela tag ao vivo —
 * não se aplica a uma ação nova de confirmação, então o lote passa
 * `allowPastCutoff: true`.
 *
 * Tudo aqui é injetável (roster, snapshot, relógio, envio, disco de índice):
 * nenhum teste toca a Google Ads API.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import {
  buildUploadClickConversionsPayload,
  validateSignupRecords,
  type SignupRecordInput,
  type UploadClickConversionsPayload,
} from "./google-ads-enhanced-conversions.ts";
import { extractPartialFailureIndexes, type SendPayloadResult } from "./google-ads-conversion-sender.ts";
import { REATIVAR_CONFIRMOU_VIA_FIELD_NAME, REATIVAR_CONFIRMOU_VIA_VALUE } from "./shared/reativar-confirmou-via.ts";
import type { SubscriberStateRecord } from "./subscriber-state-snapshot.ts";

export const GOOGLE_ADS_CLICK_CONVERSION_WINDOW_DAYS = 90;
/** Custom field do Kit que carrega `gclid:XXXX` (#8003, `KIT_ORIGEM_CLICKID_FIELD`). */
export const KIT_CLICK_ID_FIELD_NAME = "origem_click_id";
export const DEFAULT_LOOKBACK_DAYS = 7;
export const CONFIRMATION_ORDER_ID_PREFIX = "diaria-confirmacao-kit-";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Subconjunto do `KitSubscriberSummary` que este lote precisa. */
export interface ConfirmationRosterEntry {
  id: number;
  email_address: string;
  state: string;
  created_at: string;
  fields?: Record<string, string>;
}

export type ConfirmationPath = "kit-email" | "brevo-botao";

export interface ConfirmationCandidate {
  id: number;
  email: string;
  createdAt: string;
  path: ConfirmationPath;
  gclid?: string;
}

export type ConfirmationIndexStatus = "sent" | "skipped-out-of-window";
export interface ConfirmationIndexEntry {
  status: ConfirmationIndexStatus;
  at: string;
  path: ConfirmationPath;
}
export type ConfirmationIndex = Record<string, ConfirmationIndexEntry>;

export function indexKey(id: number): string {
  return `kit-${id}`;
}

// ---------------------------------------------------------------------------
// Puros
// ---------------------------------------------------------------------------

/** `gclid:XXXX` → `XXXX`; qualquer outro prefixo/vazio → `undefined`. @pure */
export function extractGclid(fields: Record<string, string> | undefined): string | undefined {
  const raw = (fields?.[KIT_CLICK_ID_FIELD_NAME] ?? "").trim();
  if (!raw.toLowerCase().startsWith("gclid:")) return undefined;
  const value = raw.slice("gclid:".length).trim();
  return value || undefined;
}

/** Instante → ISO 8601 com offset BRT fixo (-03:00; o Brasil não tem horário
 *  de verão desde 2019). @pure */
export function toBrtIso(ms: number): string {
  const shifted = new Date(ms - 3 * 60 * 60 * 1000);
  return shifted.toISOString().replace(/\.\d{3}Z$/, "-03:00");
}

function dateKeyMs(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

/**
 * Escolhe a data do snapshot BASE: o mais antigo dentro de
 * `[todayKey - lookbackDays, todayKey)`. `null` quando não há nenhum (sem
 * base não dá pra saber quem confirmou — o chamador deve falhar alto, nunca
 * tratar como "ninguém confirmou"). @pure
 */
export function pickBaseSnapshotDate(
  dates: readonly string[],
  todayKey: string,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
): string | null {
  const today = dateKeyMs(todayKey);
  const floor = today - lookbackDays * 24 * 60 * 60 * 1000;
  const eligible = dates.filter((d) => d < todayKey && dateKeyMs(d) >= floor).sort();
  return eligible.length > 0 ? eligible[0] : null;
}

/**
 * Quem estava não-`active` na base e hoje é `active` (ver docstring do
 * módulo pro tratamento de "sem estado anterior"). @pure
 */
export function selectConfirmationCandidates(
  roster: readonly ConfirmationRosterEntry[],
  baseSnapshot: readonly SubscriberStateRecord[],
): ConfirmationCandidate[] {
  const baseById = new Map(baseSnapshot.map((r) => [r.id, r]));
  const out: ConfirmationCandidate[] = [];
  for (const s of roster) {
    if (s.state !== "active") continue;
    const base = baseById.get(s.id);
    if (base?.state === "active") continue;
    const viaBotao = (s.fields?.[REATIVAR_CONFIRMOU_VIA_FIELD_NAME] ?? "").trim() === REATIVAR_CONFIRMOU_VIA_VALUE;
    if (!base && !viaBotao) continue; // nasceu active sem prova de confirmação = cadastro, não confirmação
    out.push({
      id: s.id,
      email: (s.email_address ?? "").trim(),
      createdAt: s.created_at,
      path: viaBotao ? "brevo-botao" : "kit-email",
      gclid: extractGclid(s.fields),
    });
  }
  return out;
}

/** `true` quando o cadastro é mais antigo que a janela de 90 dias. Data
 *  ilegível também conta como fora (não dá pra provar que está dentro). @pure */
export function isOutOfWindow(createdAtIso: string, nowMs: number): boolean {
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) return true;
  return nowMs - created > GOOGLE_ADS_CLICK_CONVERSION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Índice de idempotência (disco)
// ---------------------------------------------------------------------------

/** Ausente/corrompido → `{}` (mesmo fail-soft de `loadCapiSentIndex`). */
export function loadConfirmationIndex(path: string): ConfirmationIndex {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ConfirmationIndex) : {};
  } catch {
    return {};
  }
}

export function saveConfirmationIndex(path: string, index: ConfirmationIndex): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(index, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------

export interface ConfirmationBatchSummary {
  dryRun: boolean;
  detected: number;
  alreadyIndexed: number;
  outOfWindow: number;
  outOfWindowIds: number[];
  skippedTestEmails: number;
  skippedMalformed: number;
  toSend: number;
  withGclid: number;
  sent: number;
  failed: number;
  error?: string;
  /** Presente em dry-run (e útil pra auditoria): o payload que SERIA enviado. */
  payload?: UploadClickConversionsPayload;
}

export interface RunConfirmationBatchDeps {
  roster: readonly ConfirmationRosterEntry[];
  baseSnapshot: readonly SubscriberStateRecord[];
  indexPath: string;
  /** Resource name completo da ação de CONFIRMAÇÃO. */
  conversionActionResourceName: string;
  /** `true` = nada é enviado nem gravado no índice. */
  dryRun: boolean;
  /** Só chamado fora de dry-run. Injetável: teste passa um mock. */
  sendFn: (payload: UploadClickConversionsPayload) => Promise<SendPayloadResult>;
  now?: Date;
  log?: (msg: string) => void;
}

export async function runConfirmationBatch(deps: RunConfirmationBatchDeps): Promise<ConfirmationBatchSummary> {
  const log = deps.log ?? ((m: string) => process.stderr.write(`[google-ads-confirmations] ${m}\n`));
  const nowMs = (deps.now ?? new Date()).getTime();
  const nowIso = new Date(nowMs).toISOString();

  const detected = selectConfirmationCandidates(deps.roster, deps.baseSnapshot);
  const index = loadConfirmationIndex(deps.indexPath);
  const pending = detected.filter((c) => !(indexKey(c.id) in index));
  const alreadyIndexed = detected.length - pending.length;

  const inWindow: ConfirmationCandidate[] = [];
  const outOfWindow: ConfirmationCandidate[] = [];
  for (const c of pending) (isOutOfWindow(c.createdAt, nowMs) ? outOfWindow : inWindow).push(c);

  const summary: ConfirmationBatchSummary = {
    dryRun: deps.dryRun,
    detected: detected.length,
    alreadyIndexed,
    outOfWindow: outOfWindow.length,
    outOfWindowIds: outOfWindow.map((c) => c.id),
    skippedTestEmails: 0,
    skippedMalformed: 0,
    toSend: 0,
    withGclid: 0,
    sent: 0,
    failed: 0,
  };

  // Fora da janela: registrado (log + índice) e pulado. Nunca silencioso.
  if (outOfWindow.length > 0) {
    log(
      `${outOfWindow.length} confirmação(ões) fora da janela de ${GOOGLE_ADS_CLICK_CONVERSION_WINDOW_DAYS} dias ` +
        `(kit ids ${summary.outOfWindowIds.join(", ")}) — ${deps.dryRun ? "seriam registradas" : "registradas"} no índice como ` +
        `skipped-out-of-window e NÃO enviadas.`,
    );
    if (!deps.dryRun) {
      for (const c of outOfWindow) index[indexKey(c.id)] = { status: "skipped-out-of-window", at: nowIso, path: c.path };
    }
  }

  const nowBrt = toBrtIso(nowMs);
  const byHash = new Map<string, ConfirmationCandidate>();
  const records: SignupRecordInput[] = inWindow.map((c) => ({
    email: c.email,
    signupTimestamp: nowBrt,
    gclid: c.gclid,
    orderId: `${CONFIRMATION_ORDER_ID_PREFIX}${c.id}`,
  }));
  const validation = validateSignupRecords(records, { allowPastCutoff: true });
  if (!validation.ok) {
    // Não acontece com allowPastCutoff:true; defensivo pra o tipo.
    summary.error = validation.reason;
    summary.failed = inWindow.length;
    if (!deps.dryRun && outOfWindow.length > 0) saveConfirmationIndex(deps.indexPath, index);
    return summary;
  }
  summary.skippedTestEmails = validation.skippedTestEmails.length;
  summary.skippedMalformed = validation.skippedMalformed.length;
  for (const c of inWindow) byHash.set(hashKey(c.email), c);

  const conversions = validation.conversions;
  summary.toSend = conversions.length;
  summary.withGclid = conversions.filter((c) => c.gclid).length;

  if (conversions.length === 0) {
    if (!deps.dryRun && outOfWindow.length > 0) saveConfirmationIndex(deps.indexPath, index);
    return summary;
  }

  const payload = buildUploadClickConversionsPayload(conversions, {
    conversionActionResourceName: deps.conversionActionResourceName,
  });

  if (deps.dryRun) {
    summary.payload = payload;
    return summary;
  }

  const result = await deps.sendFn(payload);
  if (!result.ok) {
    summary.failed = conversions.length;
    summary.error = result.error;
    if (outOfWindow.length > 0) saveConfirmationIndex(deps.indexPath, index);
    return summary;
  }

  const failedIdx = extractPartialFailureIndexes(result.response);
  const failedSet = new Set<number>(failedIdx ?? conversions.map((_, i) => i));
  if (failedIdx === null) {
    summary.error = "partialFailureError sem índices legíveis — nenhuma conversão marcada como enviada (order_id evita duplicar no Google).";
  }
  conversions.forEach((conv, i) => {
    if (failedSet.has(i)) {
      summary.failed++;
      return;
    }
    const cand = byHash.get(hashKey(conv.email));
    if (!cand) return;
    index[indexKey(cand.id)] = { status: "sent", at: nowIso, path: cand.path };
    summary.sent++;
  });
  if (summary.sent > 0 || outOfWindow.length > 0) saveConfirmationIndex(deps.indexPath, index);
  return summary;
}

function hashKey(email: string): string {
  return email.trim().toLowerCase();
}
