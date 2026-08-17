/**
 * meta-capi-batch-send.ts (#5504, item (b) do escopo)
 *
 * Batch server-side de `CompleteRegistration` pra Meta Conversions API, a
 * partir do snapshot Beehiiv já produzido por `scripts/backup-beehiiv.ts`
 * (`data/beehiiv-backup/{YYYY-MM-DD}/subscribers.jsonl`, task
 * `Diaria-Beehiiv-Backup`, semanal). Cobre o gap que os 3 handlers de
 * formulário (item (a) — `workers/poll/src/subscribe.ts`,
 * `workers/cursos/src/subscribe.ts`, `workers/reativar/src/index.ts`) NÃO
 * cobrem: cadastro feito na home hospedada na Beehiiv, fora dos nossos
 * Workers.
 *
 * ## Limitação de janela — a Conversions API só aceita evento cujo
 * `event_time` esteja dentro de ~7 dias do momento do envio (doc oficial da
 * Meta). O snapshot semanal (`Diaria-Beehiiv-Backup`, domingo 03:00) roda
 * uma vez por semana — na PIOR janela (assinante cadastrado na segunda,
 * snapshot só de domingo seguinte), o `created` já teria ~6 dias quando o
 * snapshot aparece, e viraria inaceitável se este script rodasse
 * imediatamente depois do próximo snapshot em vez de logo após o atual.
 * **Esta issue NÃO muda a cadência da task** (decisão de infra fora do
 * escopo, ver corpo da #5504) — o script só filtra pra dentro da janela
 * aceita e documenta a perda: rodando semanal, uma fatia dos cadastros da
 * semana vai cair fora da janela de 7 dias antes deste script rodar de
 * novo, e esses ficam sem sinal server-side (mas ainda têm o `PageView`
 * client-side de sempre — não é regressão, é o teto do desenho atual). Se o
 * editor decidir tornar o backup diário no futuro, este script não muda:
 * `--window-days` já é parametrizável e o filtro já é por `created`, não por
 * "todo o snapshot".
 *
 * ## Idempotência
 *
 * O `event_id` determinístico (`computeCompleteRegistrationEventId`,
 * `scripts/lib/shared/meta-capi.ts`) já garante que reenviar o MESMO
 * cadastro no MESMO dia é uma duplicata pra Meta, não uma 2ª conversão —
 * mas reenviar ainda gasta 1 chamada de rede por vez. Este script também
 * mantém um índice local (`data/beehiiv-backup/_meta-capi-sent.json`,
 * cumulativo — não por snapshot) de `event_id`s já enviados com sucesso,
 * pulando quem já foi processado em execuções anteriores. Guarda só o
 * `event_id` (hash, não reversível pro e-mail) + timestamp — nunca o
 * e-mail em claro.
 *
 * ## Guard de publicação
 *
 * Fail-soft herdado de `sendCompleteRegistrationEvent`: sem
 * `META_CAPI_ACCESS_TOKEN`, o script identifica os candidatos e imprime o
 * plano, mas cada envio individual volta `not_configured` — nunca lança.
 * `--dry-run` pula a chamada de rede inteiramente (só imprime o plano),
 * pra inspecionar candidatos sem consumir chamadas nem tocar o índice de
 * idempotência.
 *
 * Uso:
 *   npx tsx scripts/meta-capi-batch-send.ts --dry-run
 *   npx tsx scripts/meta-capi-batch-send.ts [--snapshot YYYY-MM-DD] [--root data/beehiiv-backup]
 *     [--window-days 7] [--limit N] [--test-event-code CODE]
 *
 * Env:
 *   META_CAPI_ACCESS_TOKEN   necessário pro envio real (ausente = dry-run efetivo)
 *
 * Output (stdout): JSON do resumo. Stderr: progresso humano.
 * Exit codes: 0=sucesso (mesmo com 0 candidatos), 1=erro fatal de IO.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  latestSnapshotDate,
  readSnapshotSubscribers,
  type BeehiivBackupSubscriber,
} from "./lib/beehiiv-backup-snapshots.ts";
import {
  sendCompleteRegistrationEvent,
  computeCompleteRegistrationEventId,
  META_CAPI_DEFAULT_DATASET_ID,
  type MetaCapiSendResult,
} from "./lib/shared/meta-capi.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data/beehiiv-backup");
export const DEFAULT_SENT_INDEX_PATH = resolve(ROOT, "data/beehiiv-backup/_meta-capi-sent.json");
export const DEFAULT_WINDOW_DAYS = 7;
/** Home pública — todo cadastro via Beehiiv nativa cai aqui (o item (b) só
 * cobre exatamente essa origem, ver docstring do módulo). */
export const CAPI_BATCH_EVENT_SOURCE_URL = "https://diar.ia.br/";

// ---------------------------------------------------------------------------
// Seleção de candidatos (pure)
// ---------------------------------------------------------------------------

export interface CapiBatchOptions {
  /** Janela em dias — a partir de `nowSeconds`, subscribers com `created`
   * mais antigo que isto são excluídos (fora da janela aceita pela CAPI). */
  windowDays: number;
  nowSeconds: number;
}

/**
 * Filtra subscribers do snapshot pra quem é elegível a `CompleteRegistration`
 * via batch: `status === "active"` (cadastro completo, não pending) E
 * `created` dentro da janela aceita pela CAPI. Pure — testável sem I/O.
 */
export function selectCapiCandidates(
  subscribers: BeehiivBackupSubscriber[],
  opts: CapiBatchOptions,
): BeehiivBackupSubscriber[] {
  const windowSeconds = opts.windowDays * 24 * 60 * 60;
  const cutoff = opts.nowSeconds - windowSeconds;
  return subscribers.filter((s) => {
    if (s.status !== "active") return false;
    if (typeof s.created !== "number" || !Number.isFinite(s.created)) return false;
    return s.created >= cutoff && s.created <= opts.nowSeconds;
  });
}

// ---------------------------------------------------------------------------
// Índice de idempotência — cumulativo, chaveado por event_id (nunca e-mail)
// ---------------------------------------------------------------------------

export type CapiSentIndex = Record<string, { sentAt: string }>;

/** Lê o índice de `event_id`s já enviados com sucesso. Ausente/corrompido →
 * `{}` (fail-soft — mesmo padrão de `loadCheckpoint` em `verify-emails-mv.ts`,
 * um índice vazio só significa "reenviar tudo", nunca quebra o script). */
export function loadCapiSentIndex(path: string): CapiSentIndex {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as CapiSentIndex) : {};
  } catch {
    return {};
  }
}

export function saveCapiSentIndex(path: string, index: CapiSentIndex): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(index, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------

export interface CapiBatchSummary {
  snapshotDate: string | null;
  totalSubscribers: number;
  candidates: number;
  alreadySent: number;
  toSend: number;
  sent: number;
  skippedNotConfigured: number;
  failed: number;
  dryRun: boolean;
}

export interface RunCapiBatchDeps {
  root?: string;
  snapshotDate?: string;
  sentIndexPath?: string;
  windowDays?: number;
  limit?: number;
  dryRun?: boolean;
  testEventCode?: string;
  accessToken?: string;
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
  /** Injetável pra teste — evita depender de `buildCompleteRegistrationEvent`
   * real quando o teste só quer verificar orquestração (seleção, contagem,
   * gravação do índice), não o payload em si (já coberto por
   * `test/meta-capi.test.ts`). Default: `sendCompleteRegistrationEvent`. */
  sendFn?: (
    input: { email: string; eventSourceUrl: string; eventTimeSeconds: number; actionSource: "system_generated" },
    options: { accessToken: string | undefined; datasetId: string; testEventCode?: string; fetchImpl: typeof fetch },
  ) => Promise<MetaCapiSendResult & { eventId?: string }>;
  log?: (msg: string) => void;
}

async function defaultSendWithEventId(
  input: { email: string; eventSourceUrl: string; eventTimeSeconds: number; actionSource: "system_generated" },
  options: { accessToken: string | undefined; datasetId: string; testEventCode?: string; fetchImpl: typeof fetch },
): Promise<MetaCapiSendResult & { eventId?: string }> {
  // Precisa do event_id pra gravar no índice — recomputa aqui (mesma fórmula
  // determinística, sem custo de rede) em vez de mudar o contrato de
  // `sendCompleteRegistrationEvent` só pra devolver um campo extra.
  const eventId = await computeCompleteRegistrationEventId(input.email, input.eventTimeSeconds);
  const result = await sendCompleteRegistrationEvent(input, options);
  return { ...result, eventId };
}

/** Orquestra o batch inteiro: lê snapshot → seleciona candidatos → filtra
 * já-enviados → envia (ou só imprime, em `--dry-run`) → grava índice. */
export async function runCapiBatch(deps: RunCapiBatchDeps = {}): Promise<CapiBatchSummary> {
  const root = deps.root ?? DEFAULT_BACKUP_ROOT;
  const sentIndexPath = deps.sentIndexPath ?? DEFAULT_SENT_INDEX_PATH;
  const windowDays = deps.windowDays ?? DEFAULT_WINDOW_DAYS;
  const dryRun = deps.dryRun ?? false;
  const nowSeconds = deps.nowSeconds ?? Math.floor(Date.now() / 1000);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const accessToken = deps.accessToken ?? process.env.META_CAPI_ACCESS_TOKEN;
  const log = deps.log ?? ((msg: string) => process.stderr.write(`[meta-capi-batch] ${msg}\n`));
  const sendFn = deps.sendFn ?? defaultSendWithEventId;

  const snapshotDate = deps.snapshotDate ?? latestSnapshotDate(root);
  if (!snapshotDate) {
    log("nenhum snapshot encontrado — nada a fazer.");
    return {
      snapshotDate: null,
      totalSubscribers: 0,
      candidates: 0,
      alreadySent: 0,
      toSend: 0,
      sent: 0,
      skippedNotConfigured: 0,
      failed: 0,
      dryRun,
    };
  }

  const subscribers = readSnapshotSubscribers(root, snapshotDate);
  const candidates = selectCapiCandidates(subscribers, { windowDays, nowSeconds });
  log(`snapshot ${snapshotDate}: ${subscribers.length} subscribers, ${candidates.length} candidatos (janela ${windowDays}d).`);

  const sentIndex = dryRun ? {} : loadCapiSentIndex(sentIndexPath);

  // Pré-computa event_id de todo candidato pra filtrar quem já foi enviado
  // ANTES de gastar qualquer chamada de rede (mesmo espírito do checkpoint
  // de verify-emails-mv.ts — `todo = candidatos - checkpoint`).
  const withEventId = await Promise.all(
    candidates.map(async (s) => ({
      subscriber: s,
      eventId: await computeCompleteRegistrationEventId(s.email, s.created),
    })),
  );
  const pending = withEventId.filter(({ eventId }) => !(eventId in sentIndex));
  const alreadySent = withEventId.length - pending.length;

  const limited = typeof deps.limit === "number" ? pending.slice(0, deps.limit) : pending;

  let sent = 0;
  let skippedNotConfigured = 0;
  let failed = 0;

  if (dryRun) {
    log(`dry-run: ${limited.length} candidato(s) seriam enviados (${alreadySent} já no índice, pulados).`);
  } else {
    for (const { subscriber, eventId } of limited) {
      const result = await sendFn(
        {
          email: subscriber.email,
          eventSourceUrl: CAPI_BATCH_EVENT_SOURCE_URL,
          eventTimeSeconds: subscriber.created,
          actionSource: "system_generated",
        },
        { accessToken, datasetId: META_CAPI_DEFAULT_DATASET_ID, testEventCode: deps.testEventCode, fetchImpl },
      );
      if (result.ok) {
        sent++;
        sentIndex[eventId] = { sentAt: new Date().toISOString() };
      } else if (result.reason === "not_configured") {
        skippedNotConfigured++;
      } else {
        failed++;
        log(`falha ao enviar (status ${result.status}, motivo ${result.reason}) — event_id ${eventId.slice(0, 8)}…`);
      }
    }
    if (sent > 0) saveCapiSentIndex(sentIndexPath, sentIndex);
  }

  const summary: CapiBatchSummary = {
    snapshotDate,
    totalSubscribers: subscribers.length,
    candidates: candidates.length,
    alreadySent,
    toSend: limited.length,
    sent,
    skippedNotConfigured,
    failed,
    dryRun,
  };
  log(
    `resumo: ${summary.sent} enviados, ${summary.skippedNotConfigured} sem token, ${summary.failed} falharam, ${summary.alreadySent} já no índice.`,
  );
  return summary;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const root = getStringArg(argv, "root") ?? DEFAULT_BACKUP_ROOT;
  const snapshotDate = getStringArg(argv, "snapshot");
  const windowDays = getIntArg(argv, "window-days", { min: 1 }) ?? DEFAULT_WINDOW_DAYS;
  const limit = getIntArg(argv, "limit", { min: 0 });
  const testEventCode = getStringArg(argv, "test-event-code");
  const dryRun = hasFlag(argv, "dry-run");

  if (!process.env.META_CAPI_ACCESS_TOKEN && !dryRun) {
    process.stderr.write(
      "[meta-capi-batch] META_CAPI_ACCESS_TOKEN ausente — rodando em modo dry-run efetivo " +
        "(cada envio individual vai voltar not_configured, nada é enviado; use --dry-run pra deixar isso explícito).\n",
    );
  }

  const summary = await runCapiBatch({ root, snapshotDate, windowDays, limit, dryRun, testEventCode });
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[meta-capi-batch] ERRO FATAL: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
