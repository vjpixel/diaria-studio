/**
 * Importa um lote CURADO de contatos pro canal `brevo_diaria` (#5841).
 *
 * Caso que motivou: os 65 contatos que o editor descadastrou manualmente em
 * 11 e 13/07/2026 (`data/analysis/descadastrados-manuais-2607.json`), que
 * nunca passaram pelo funil e não têm caminho de entrada — `refresh-pending-pool`
 * (#5183) só enxerga o segmento **Pending** da Beehiiv, e estes estão
 * descadastrados.
 *
 * ## O que faz, nesta ordem
 *
 * 1. Lê e valida o arquivo de lote (`--input`).
 * 2. Dedup contra `data/brevo-diaria/contacts.json` + cap da fila compartilhada
 *    (`brevo_diaria.daily_send_cap`, o mesmo do backfill e do sunset).
 * 3. **Verifica cada e-mail na MillionVerifier** (regra #1297 — são
 *    não-assinantes agora; mandar sem verificar arrisca bounce de 5-10% e
 *    contamina a reputação do domínio compartilhado com a base ativa).
 *    Só bucket `verified` (ok/catch_all) prossegue.
 * 4. `ingestContactToBrevo` (escrita real na lista, com releitura de
 *    confirmação) e **só então** `upsertIngested` no store — a ordem cuja
 *    inversão causou o #5843.
 * 5. Log append-only em `data/brevo-diaria/curated-import-log.jsonl`.
 *
 * ## Dry-run por padrão
 *
 * Sem `--push` nada é escrito e a MV **não é chamada** (não gasta crédito só
 * pra planejar). O relatório de dry-run mostra quantos entrariam depois do
 * dedup e do cap; a contagem final pós-MV só existe no `--push`.
 *
 * ## Uso
 *
 *   npx tsx scripts/import-curated-batch-brevo.ts --input data/analysis/descadastrados-manuais-2607.json
 *   npx tsx scripts/import-curated-batch-brevo.ts --input <arquivo> --push
 *   npx tsx scripts/import-curated-batch-brevo.ts --input <arquivo> --push --limit 17
 *
 * `--limit N` corta o lote nos N primeiros elegíveis — para envio graduado
 * (ex: começar só pelos que têm clique na vida) sem editar o arquivo.
 *
 * @see scripts/lib/curated-batch-import.ts (núcleo puro)
 * @see scripts/sync-pending-to-brevo.ts (ingestContactToBrevo, cap da fila)
 * @see scripts/verify-emails-mv.ts (buildVerifyUrl/classifyResult — reusados)
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getIntArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  readStore,
  writeStore,
  upsertIngested,
  normalizeEmail,
  DEFAULT_STORE_PATH,
  type BrevoDiariaStore,
} from "./lib/brevo-diaria-store.ts";
import { computeAvailableSlots, computeCurrentActiveCount, ingestContactToBrevo } from "./sync-pending-to-brevo.ts";
import { loadBrevoDiariaTarget } from "./lib/brevo-diaria-target.ts";
import { buildVerifyUrl, classifyResult } from "./verify-emails-mv.ts";
import {
  parseCuratedBatch,
  selectCuratedCandidates,
  decideFromMvBucket,
  summarizeSkips,
  type CuratedEntry,
  type SkippedEntry,
} from "./lib/curated-batch-import.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CURATED_LOG_PATH = resolve(ROOT, "data/brevo-diaria/curated-import-log.jsonl");
const DEFAULT_QUEUE_CAP = 300;

export interface CuratedImportLogEntry {
  email: string;
  imported_at: string;
  source_file: string;
  received: number;
  opened: number;
  clicked: number;
  mv_result: string;
  origem: "curated";
}

/** I/O — grava 1 linha jsonl append-only (cria o diretório pai se necessário). */
export function appendCuratedImportLog(entry: CuratedImportLogEntry, path: string = DEFAULT_CURATED_LOG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

/** I/O — 1 chamada à Single Verification API da MillionVerifier. */
async function verifyOnMv(
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch,
): Promise<{ result: string; bucket: "verified" | "rejected" | "unknown" }> {
  const res = await fetchImpl(buildVerifyUrl(apiKey, email));
  if (!res.ok) throw new Error(`MillionVerifier HTTP ${res.status} para ${email}`);
  const body = (await res.json()) as { result?: string };
  const result = body?.result ?? "";
  return { result, bucket: classifyResult(result) };
}

function readQueueCap(log: (msg: string) => void): number {
  try {
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as {
      brevo_diaria?: { daily_send_cap?: number };
    };
    return cfg.brevo_diaria?.daily_send_cap ?? DEFAULT_QUEUE_CAP;
  } catch (e) {
    log(`aviso: falha ao ler platform.config.json (${(e as Error).message}) — usando cap default ${DEFAULT_QUEUE_CAP}.`);
    return DEFAULT_QUEUE_CAP;
  }
}

export function formatPlanReport(params: {
  inputPath: string;
  total: number;
  selected: CuratedEntry[];
  skipped: SkippedEntry[];
  currentActiveCount: number;
  cap: number;
}): string {
  const lines: string[] = [];
  lines.push(`[import-curated-batch-brevo] arquivo: ${params.inputPath}`);
  lines.push(`[import-curated-batch-brevo] ${params.total} registro(s) no lote.`);
  lines.push(
    `[import-curated-batch-brevo] fila compartilhada: ${params.currentActiveCount}/${params.cap} ocupados, ` +
      `${computeAvailableSlots(params.currentActiveCount, params.cap)} slot(s) livre(s).`,
  );
  lines.push(`[import-curated-batch-brevo] ${params.selected.length} elegível(is) após dedup + cap.`);
  const summary = summarizeSkips(params.skipped);
  for (const [reason, n] of Object.entries(summary)) {
    lines.push(`[import-curated-batch-brevo]   ${n} pulado(s): ${reason}`);
  }
  const comCliques = params.selected.filter((e) => e.clicked > 0).length;
  if (params.selected.length > 0) {
    lines.push(
      `[import-curated-batch-brevo] destes, ${comCliques} têm clique na vida (leitores reais com pixel bloqueado).`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const log = (msg: string) => process.stderr.write(`[import-curated-batch-brevo] ${msg}\n`);
  const push = hasFlag(argv, "push");
  const inputPath = getStringArg(argv, "input");
  const limit = getIntArg(argv, "limit");

  if (!inputPath) {
    log("ERRO: --input <arquivo.json> é obrigatório.");
    process.exitCode = 1;
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(ROOT, inputPath), "utf8"));
  } catch (e) {
    log(`ERRO: falha ao ler ${inputPath}: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const parsed = parseCuratedBatch(raw);
  let store = readStore(DEFAULT_STORE_PATH);
  const cap = readQueueCap(log);
  const currentActiveCount = computeCurrentActiveCount(store.contacts);
  const availableSlots = computeAvailableSlots(currentActiveCount, cap);
  const effectiveSlots = typeof limit === "number" ? Math.min(availableSlots, limit) : availableSlots;

  const selection = selectCuratedCandidates({
    entries: parsed.entries,
    storeEmails: store.contacts.map((c) => c.email),
    availableSlots: effectiveSlots,
  });
  const allSkipped = [...parsed.skipped, ...selection.skipped];

  process.stdout.write(
    formatPlanReport({
      inputPath,
      total: parsed.entries.length + parsed.skipped.length,
      selected: selection.selected,
      skipped: allSkipped,
      currentActiveCount,
      cap,
    }) + "\n",
  );

  if (!push) {
    log("dry-run (default) — NENHUMA mutação aplicada e MillionVerifier NÃO chamada. Use --push para executar.");
    return;
  }

  const brevoTarget = loadBrevoDiariaTarget();
  if (!brevoTarget.ok) {
    log(`ERRO: ${brevoTarget.reason} — nenhuma mutação aplicada.`);
    process.exitCode = 1;
    return;
  }
  const mvApiKey = process.env.MILLION_VERIFIER_API_KEY;
  if (!mvApiKey) {
    log("ERRO: MILLION_VERIFIER_API_KEY ausente — regra #1297 exige verificação antes do 1º envio a não-assinantes.");
    process.exitCode = 1;
    return;
  }

  let imported = 0;
  let failed = 0;
  const mvSkipped: SkippedEntry[] = [];
  const now = () => new Date().toISOString();

  for (const entry of selection.selected) {
    let mv: { result: string; bucket: "verified" | "rejected" | "unknown" };
    try {
      mv = await verifyOnMv(mvApiKey, entry.email, fetch);
    } catch (e) {
      failed++;
      log(`  FALHA na verificação MV de ${entry.email}: ${(e as Error).message} — não ingerido.`);
      continue;
    }

    const decision = decideFromMvBucket(mv.bucket);
    if (!decision.ingest) {
      mvSkipped.push({ email: entry.email, reason: decision.reason!, detail: mv.result });
      log(`  ${entry.email} — pulado (MV: ${mv.result}).`);
      continue;
    }

    try {
      await ingestContactToBrevo(brevoTarget.apiKey, brevoTarget.listId, normalizeEmail(entry.email));
      store = upsertIngested(
        store,
        { email: entry.email, beehiiv_subscription_id: `curated:${normalizeEmail(entry.email)}` },
        now(),
      );
      appendCuratedImportLog({
        email: normalizeEmail(entry.email),
        imported_at: now(),
        source_file: inputPath,
        received: entry.received,
        opened: entry.opened,
        clicked: entry.clicked,
        mv_result: mv.result,
        origem: "curated",
      });
      imported++;
      log(`  ${entry.email} — ingerido na lista Brevo ${brevoTarget.listId} (MV: ${mv.result}).`);
    } catch (e) {
      failed++;
      log(`  FALHA na ingestão de ${entry.email}: ${(e as Error).message}`);
    }
  }

  writeStore(store, DEFAULT_STORE_PATH);
  const mvSummary = summarizeSkips(mvSkipped);
  log(
    `push concluído: ${imported} importado(s), ${failed} falha(s), ` +
      `${mvSkipped.length} pulado(s) por MV (${JSON.stringify(mvSummary)}).`,
  );
  log(`fila agora: ${computeCurrentActiveCount(store.contacts)}/${cap}.`);
  if (failed > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[import-curated-batch-brevo] erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
