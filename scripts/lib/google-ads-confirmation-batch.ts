/**
 * scripts/lib/google-ads-confirmation-batch.ts (#8555)
 *
 * Miolo do lote diário que sobe a CONFIRMAÇÃO (DOI) do Kit pro Google Ads
 * como Enhanced Conversion for Leads — o par Google do `reativar`/CAPI da
 * Meta (#8551), sem o defeito de misturar cadastro e confirmação: a ação de
 * destino é uma `UPLOAD_CLICKS` SEPARADA da de cadastro, passada por id
 * explícito (`--conversion-action-id` / `GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID`),
 * nunca hardcoded.
 *
 * ## Como detecta "confirmação nova"
 *
 * O Kit não guarda o instante da confirmação. `scripts/subscriber-state-snapshot.ts`
 * (#8552) grava todo dia `(id, state, created_at)` do roster; aqui compara-se
 * o roster de agora com um snapshot BASE (o mais antigo dentro do lookback,
 * ver `pickBaseSnapshotDate`). Sobem:
 *
 *   - ids `inactive` na base que hoje são `active` (`confirmed`; outros estados
 *     não-active, como cancelled/bounced/complained, NÃO são confirmação DOI);
 *   - ids AUSENTES da base, hoje `active`, cadastrados DEPOIS do snapshot base
 *     (`ambiguous`, contados em `unattributedNewActive`). Premissa
 *     documentada: não dá pra distinguir "cadastrou inactive e confirmou
 *     entre snapshots" de "cadastro single-opt-in já active" — como a ação de
 *     destino é de CONFIRMAÇÃO (distinta da de cadastro), o custo de subir o
 *     ambíguo é baixo e descartá-lo perderia o caso dominante. O resumo os
 *     conta à parte pra o editor calibrar;
 *   - ids ausentes da base E cadastrados antes dela (anomalia: o snapshot
 *     deveria tê-los) são pulados e contados em `skippedNoBase`, não somem.
 *
 * `confirmou_via = "brevo-reativar"` (#8438) só rotula o caminho
 * (`brevo-botao` vs `kit-email`) e promove um ausente-da-base a candidato
 * mesmo se antigo. O endpoint de lista do Kit pode servir `fields` defasado
 * logo após um PATCH — afeta no máximo o rótulo, não a detecção.
 *
 * ## gclid opcional, hash de e-mail sempre
 *
 * `gclid` vem do custom field `origem_click_id` (#8003, `gclid:XXXX`) quando
 * existe; o hash SHA-256 do e-mail sobe SEMPRE (cobre os cadastros sem
 * gclid). Se o Google recusar uma linha COM gclid, o lote reenvia UMA vez só
 * com o hash (ECL não precisa de click id).
 *
 * ## Janela de 90 dias
 *
 * O import do Google aceita conversão até 90 dias após o clique. O clique não
 * é gravado; usa-se `created_at` como aproximação conservadora. Fora da
 * janela: REGISTRADO no índice como `skipped-out-of-window`, logado, nunca
 * reenviado.
 *
 * ## Idempotência
 *
 * Índice local cumulativo (padrão `_meta-capi-sent.json`, #5504), chaveado por
 * `kit-{id}` (nenhum e-mail em claro). Status: `sent`, `skipped-out-of-window`,
 * `skipped-test-email`, `skipped-malformed`, `skipped-failed-permanent` e
 * `failed` (recusa por linha, com contador de tentativas; após
 * `MAX_FAILED_ATTEMPTS` vira `skipped-failed-permanent`). Falha de transporte
 * do lote inteiro NÃO conta tentativa. Índice ilegível/corrompido LANÇA
 * (nunca vira `{}`, senão reenviaria tudo). Segunda rede, best-effort:
 * `order_id = diaria-confirmacao-kit-{id}` — o Google deduplica por ele, mas
 * não é garantia contratual; a garantia é o índice.
 *
 * ## conversion_date_time
 *
 * Instante da DETECÇÃO (o Kit não expõe o da confirmação), offset BRT fixo
 * -03:00. O corte de segurança do #7770 protege o CADASTRO já contado pela
 * tag ao vivo; não se aplica a uma ação nova de confirmação, então o lote
 * passa `allowPastCutoff: true`.
 *
 * Tudo é injetável (roster, snapshot, relógio, envio, disco do índice):
 * nenhum teste toca a Google Ads API.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import {
  buildUploadClickConversionsPayload,
  validateSignupRecords,
  type UploadClickConversionsPayload,
  type ValidatedConversion,
} from "./google-ads-enhanced-conversions.ts";
import { extractPartialFailureIndexes, extractPartialFailureMessages, type SendPayloadResult } from "./google-ads-conversion-sender.ts";
import { REATIVAR_CONFIRMOU_VIA_FIELD_NAME, REATIVAR_CONFIRMOU_VIA_VALUE } from "./shared/reativar-confirmou-via.ts";
import type { SubscriberStateRecord } from "./subscriber-state-snapshot.ts";

export const GOOGLE_ADS_CLICK_CONVERSION_WINDOW_DAYS = 90;
/** Custom field do Kit que carrega `gclid:XXXX` (#8003, `KIT_ORIGEM_CLICKID_FIELD`). */
export const KIT_CLICK_ID_FIELD_NAME = "origem_click_id";
export const DEFAULT_LOOKBACK_DAYS = 7;
export const CONFIRMATION_ORDER_ID_PREFIX = "diaria-confirmacao-kit-";
export const MAX_FAILED_ATTEMPTS = 3;

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
  /** #8543: valor CRU de `origem_click_id` (`gclid:`/`fbclid:`/`msclkid:` + id),
   * pra o lote da Meta reusar esta mesma detecção sem duplicá-la. */
  clickId?: string;
  /** `true` = sem estado anterior na base (cadastrou depois dela). */
  ambiguous: boolean;
}

export type ConfirmationIndexStatus =
  | "sent"
  | "failed"
  | "skipped-out-of-window"
  | "skipped-test-email"
  | "skipped-malformed"
  | "skipped-failed-permanent";
const VALID_STATUSES: ReadonlySet<string> = new Set<ConfirmationIndexStatus>([
  "sent",
  "failed",
  "skipped-out-of-window",
  "skipped-test-email",
  "skipped-malformed",
  "skipped-failed-permanent",
]);
export interface ConfirmationIndexEntry {
  status: ConfirmationIndexStatus;
  at: string;
  path: ConfirmationPath;
  attempts?: number;
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

/** Instante → ISO 8601 com offset BRT fixo (-03:00). @pure */
export function toBrtIso(ms: number): string {
  const shifted = new Date(ms - 3 * 60 * 60 * 1000);
  return shifted.toISOString().replace(/\.\d{3}Z$/, "-03:00");
}

function dateKeyMs(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

function brtDayKey(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/**
 * Data do snapshot BASE: a mais antiga em `[todayKey - lookbackDays, todayKey)`.
 * `null` quando não há nenhuma — o chamador deve falhar alto. @pure
 */
export function pickBaseSnapshotDate(
  dates: readonly string[],
  todayKey: string,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
): string | null {
  const floor = dateKeyMs(todayKey) - lookbackDays * 24 * 60 * 60 * 1000;
  const eligible = dates.filter((d) => d < todayKey && dateKeyMs(d) >= floor).sort();
  return eligible.length > 0 ? eligible[0] : null;
}

export interface SelectionResult {
  candidates: ConfirmationCandidate[];
  /** Ausentes da base, ativos, cadastrados ANTES do snapshot base (anomalia). */
  skippedNoBase: number;
}

/** Ver docstring do módulo pra critério. `baseDate` = `AAAA-MM-DD` do snapshot base. @pure */
export function selectConfirmationCandidates(
  roster: readonly ConfirmationRosterEntry[],
  baseSnapshot: readonly SubscriberStateRecord[],
  baseDate: string,
): SelectionResult {
  const baseById = new Map(baseSnapshot.map((r) => [r.id, r]));
  const candidates: ConfirmationCandidate[] = [];
  let skippedNoBase = 0;
  for (const s of roster) {
    if (s.state !== "active") continue;
    const base = baseById.get(s.id);
    if (base && base.state !== "inactive") continue; // só inactive->active é DOI (cancelled/bounced/complained reativados não são)
    const viaBotao = (s.fields?.[REATIVAR_CONFIRMOU_VIA_FIELD_NAME] ?? "").trim() === REATIVAR_CONFIRMOU_VIA_VALUE;
    if (!base && !viaBotao) {
      const day = brtDayKey(s.created_at);
      if (!day || day < baseDate) {
        skippedNoBase++;
        continue;
      }
    }
    candidates.push({
      id: s.id,
      email: (s.email_address ?? "").trim(),
      createdAt: s.created_at,
      path: viaBotao ? "brevo-botao" : "kit-email",
      gclid: extractGclid(s.fields),
      clickId: (s.fields?.[KIT_CLICK_ID_FIELD_NAME] ?? "").trim() || undefined,
      ambiguous: !base,
    });
  }
  return { candidates, skippedNoBase };
}

/** `true` quando o cadastro é mais antigo que 90 dias (ou ilegível). @pure */
export function isOutOfWindow(createdAtIso: string, nowMs: number): boolean {
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) return true;
  return nowMs - created > GOOGLE_ADS_CLICK_CONVERSION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Índice de idempotência (disco)
// ---------------------------------------------------------------------------

/** Ausente → `{}`. Existente porém ilegível/inválido → LANÇA (nunca `{}`
 *  silencioso: um índice perdido faria o lote reenviar tudo). */
export function loadConfirmationIndex(path: string): ConfirmationIndex {
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
  return parsed as ConfirmationIndex;
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
  /** Detectados sem estado anterior na base (subidos como confirmação — premissa no docstring). */
  unattributedNewActive: number;
  skippedNoBase: number;
  alreadyIndexed: number;
  outOfWindow: number;
  outOfWindowIds: number[];
  skippedTestEmails: number;
  skippedMalformed: number;
  toSend: number;
  withGclid: number;
  sent: number;
  failed: number;
  /** Ids que viraram `skipped-failed-permanent` nesta rodada. */
  failedPermanent: number;
  /** Ids do Kit recusados pelo Google (ou sem confirmação de envio) nesta rodada. */
  failedIds: number[];
  /** Mensagens/códigos do `partialFailureError` do Google (até 10). */
  googleErrors: string[];
  /** created_at ilegível: NÃO indexado, tenta de novo amanhã. */
  skippedBadDate: number;
  error?: string;
  /** Presente em dry-run: o payload que SERIA enviado. */
  payload?: UploadClickConversionsPayload;
}

export interface RunConfirmationBatchDeps {
  roster: readonly ConfirmationRosterEntry[];
  baseSnapshot: readonly SubscriberStateRecord[];
  /** `AAAA-MM-DD` do snapshot base. */
  baseDate: string;
  indexPath: string;
  conversionActionResourceName: string;
  /** `true` = nada é enviado nem gravado no índice. */
  dryRun: boolean;
  sendFn: (payload: UploadClickConversionsPayload) => Promise<SendPayloadResult>;
  now?: Date;
  log?: (msg: string) => void;
}

interface Entry {
  cand: ConfirmationCandidate;
  conv: ValidatedConversion;
}

type Outcome = { kind: "sent" } | { kind: "rejected" } | { kind: "unknown" } | { kind: "transport"; error: string };

/** Um envio; devolve o resultado por posição de `entries` (mapeia por id, não por e-mail). */
async function sendEntries(
  entries: Entry[],
  deps: RunConfirmationBatchDeps,
): Promise<{ outcomes: Outcome[]; error?: string; messages: string[] }> {
  const payload = buildUploadClickConversionsPayload(entries.map((e) => e.conv), {
    conversionActionResourceName: deps.conversionActionResourceName,
  });
  const result = await deps.sendFn(payload);
  if (!result.ok) {
    return { outcomes: entries.map(() => ({ kind: "transport", error: result.error })), error: result.error, messages: [] };
  }
  const failedIdx = extractPartialFailureIndexes(result.response);
  const messages = extractPartialFailureMessages(result.response);
  if (failedIdx === null) {
    return {
      messages,
      outcomes: entries.map(() => ({ kind: "unknown" })),
      error: "partialFailureError sem índices legíveis — nenhuma conversão marcada como enviada",
    };
  }
  const failed = new Set(failedIdx);
  return { messages, outcomes: entries.map((_, i) => (failed.has(i) ? { kind: "rejected" } : { kind: "sent" })) };
}

export async function runConfirmationBatch(deps: RunConfirmationBatchDeps): Promise<ConfirmationBatchSummary> {
  const log = deps.log ?? ((m: string) => process.stderr.write(`[google-ads-confirmations] ${m}\n`));
  const nowMs = (deps.now ?? new Date()).getTime();
  const nowIso = new Date(nowMs).toISOString();

  const { candidates: detected, skippedNoBase } = selectConfirmationCandidates(deps.roster, deps.baseSnapshot, deps.baseDate);
  const index = loadConfirmationIndex(deps.indexPath); // lança se corrompido
  const isPending = (c: ConfirmationCandidate): boolean => {
    const e = index[indexKey(c.id)];
    if (!e) return true;
    return e.status === "failed" && (e.attempts ?? 0) < MAX_FAILED_ATTEMPTS;
  };
  // Recusas anteriores (status failed) que saíram da janela do snapshot base
  // continuam elegíveis a retry enquanto active e abaixo do teto de tentativas.
  const detectedIds = new Set(detected.map((c) => c.id));
  for (const s of deps.roster) {
    const e = index[indexKey(s.id)];
    if (s.state === "active" && e?.status === "failed" && !detectedIds.has(s.id)) {
      detected.push({
        id: s.id,
        email: (s.email_address ?? "").trim(),
        createdAt: s.created_at,
        path: e.path,
        gclid: extractGclid(s.fields),
        ambiguous: false,
      });
    }
  }
  const pending = detected.filter(isPending);

  const summary: ConfirmationBatchSummary = {
    dryRun: deps.dryRun,
    detected: detected.length,
    unattributedNewActive: detected.filter((c) => c.ambiguous).length,
    skippedNoBase,
    alreadyIndexed: detected.length - pending.length,
    outOfWindow: 0,
    outOfWindowIds: [],
    skippedTestEmails: 0,
    skippedMalformed: 0,
    toSend: 0,
    withGclid: 0,
    sent: 0,
    failed: 0,
    failedPermanent: 0,
    failedIds: [],
    googleErrors: [],
    skippedBadDate: 0,
  };
  let dirty = false;
  const record = (c: ConfirmationCandidate, entry: Omit<ConfirmationIndexEntry, "at" | "path">): void => {
    if (deps.dryRun) return;
    index[indexKey(c.id)] = { at: nowIso, path: c.path, ...entry };
    dirty = true;
  };
  const flush = (): void => {
    if (dirty) saveConfirmationIndex(deps.indexPath, index);
  };
  if (skippedNoBase > 0) {
    log(`${skippedNoBase} assinante(s) active ausente(s) da base e cadastrado(s) antes dela — pulados (anomalia do snapshot).`);
  }

  const nowBrt = toBrtIso(nowMs);
  const entries: Entry[] = [];
  const outOfWindow: ConfirmationCandidate[] = [];
  for (const c of pending) {
    if (!Number.isFinite(Date.parse(c.createdAt))) {
      summary.skippedBadDate++;
      log(`kit id ${c.id}: created_at ilegível — não indexado, tenta de novo na próxima rodada.`);
      continue;
    }
    if (isOutOfWindow(c.createdAt, nowMs)) {
      outOfWindow.push(c);
      record(c, { status: "skipped-out-of-window" });
      continue;
    }
    // Validação 1 a 1: preserva a ligação candidato <-> conversão (por id, nunca por e-mail).
    const v = validateSignupRecords(
      [{ email: c.email, signupTimestamp: nowBrt, gclid: c.gclid, orderId: `${CONFIRMATION_ORDER_ID_PREFIX}${c.id}` }],
      { allowPastCutoff: true },
    );
    if (!v.ok) {
      summary.skippedMalformed++;
      record(c, { status: "skipped-malformed" });
    } else if (v.skippedTestEmails.length > 0) {
      summary.skippedTestEmails++;
      record(c, { status: "skipped-test-email" });
    } else if (v.skippedMalformed.length > 0 || v.conversions.length === 0) {
      summary.skippedMalformed++;
      record(c, { status: "skipped-malformed" });
    } else {
      entries.push({ cand: c, conv: v.conversions[0] });
    }
  }
  summary.outOfWindow = outOfWindow.length;
  summary.outOfWindowIds = outOfWindow.map((c) => c.id);
  if (outOfWindow.length > 0) {
    log(
      `${outOfWindow.length} confirmação(ões) fora da janela de ${GOOGLE_ADS_CLICK_CONVERSION_WINDOW_DAYS} dias ` +
        `(kit ids ${summary.outOfWindowIds.join(", ")}) — ${deps.dryRun ? "seriam registradas" : "registradas"} como ` +
        `skipped-out-of-window e NÃO enviadas.`,
    );
  }

  summary.toSend = entries.length;
  summary.withGclid = entries.filter((e) => e.conv.gclid).length;

  if (entries.length === 0) {
    flush();
    return summary;
  }

  if (deps.dryRun) {
    summary.payload = buildUploadClickConversionsPayload(entries.map((e) => e.conv), {
      conversionActionResourceName: deps.conversionActionResourceName,
    });
    return summary;
  }

  const first = await sendEntries(entries, deps);
  if (first.error) summary.error = first.error;
  let outcomes = first.outcomes;
  const googleErrors = new Set<string>(first.messages);

  // Recusa por linha COM gclid: 2ª passada só com o hash do e-mail.
  const retry = entries.map((e, i) => ({ e, i })).filter(({ e, i }) => outcomes[i].kind === "rejected" && e.conv.gclid);
  if (retry.length > 0) {
    log(`${retry.length} linha(s) com gclid recusada(s) — reenviando só com o hash do e-mail.`);
    const stripped = retry.map(({ e }) => ({ cand: e.cand, conv: { ...e.conv, gclid: undefined } }));
    const second = await sendEntries(stripped, deps);
    outcomes = [...outcomes];
    retry.forEach(({ i }, k) => {
      outcomes[i] = second.outcomes[k];
    });
    if (second.error && !summary.error) summary.error = second.error;
    second.messages.forEach((m) => googleErrors.add(m));
  }

  entries.forEach(({ cand }, i) => {
    const o = outcomes[i];
    if (o.kind === "sent") {
      summary.sent++;
      record(cand, { status: "sent" });
    } else if (o.kind === "rejected") {
      summary.failed++;
      summary.failedIds.push(cand.id);
      const attempts = (index[indexKey(cand.id)]?.attempts ?? 0) + 1;
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        summary.failedPermanent++;
        record(cand, { status: "skipped-failed-permanent", attempts });
        log(`kit id ${cand.id} recusado ${attempts}x pelo Google — desistindo (skipped-failed-permanent).`);
      } else {
        record(cand, { status: "failed", attempts });
      }
    } else {
      summary.failed++; // transporte/unknown: não conta tentativa, reprocessa na próxima
      summary.failedIds.push(cand.id);
    }
  });
  summary.googleErrors = [...googleErrors].slice(0, 10);
  const sentIds = entries.filter((_, i) => outcomes[i].kind === "sent").map((e) => e.cand.id);
  // Enviado ao Google mas ainda não indexado: se a escrita do índice falhar,
  // estes ids ficam no stderr pra reconciliação manual.
  if (sentIds.length > 0) log(`enviados ao Google (kit ids): ${sentIds.join(", ")} — gravando índice.`);
  try {
    flush();
  } catch (e) {
    log(`FALHA ao gravar o índice após envio bem-sucedido (${e instanceof Error ? e.message : e}); ids enviados: ${sentIds.join(", ")}`);
    throw e;
  }
  return summary;
}

/**
 * Sanidade do snapshot base: vazio, ou muito menor que o roster, indica
 * snapshot truncado/corrompido. Devolve a mensagem de erro ou `null`. @pure
 */
export function assessBaseSnapshot(baseLen: number, rosterLen: number): string | null {
  if (baseLen === 0) return "snapshot base vazio ou ilegível (0 linhas)";
  if (rosterLen > 0 && baseLen < rosterLen * 0.5) {
    return `snapshot base suspeito: ${baseLen} linha(s) contra ${rosterLen} no roster (< 50%) — provável truncamento`;
  }
  return null;
}
