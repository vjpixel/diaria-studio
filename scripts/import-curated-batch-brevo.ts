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
 *    Só bucket `verified` (ok/catch_all) prossegue — `--allow-mv-unknown`
 *    admite também `unknown` (ausência de veredito), nunca `rejected`.
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
 *   npx tsx scripts/import-curated-batch-brevo.ts --input <arquivo> --push --limit 12 --prioritize-clicked
 *
 * `--limit N` corta o lote nos N primeiros elegíveis, na ordem do arquivo (a
 * curadoria do editor). Para envio graduado começando por quem tem clique na
 * vida — leitor real com pixel de abertura bloqueado — combinar com
 * `--prioritize-clicked`, que ordena por cliques (desc) ANTES do corte. Sem
 * essa flag o corte é posicional e não tem relação com engajamento: no lote de
 * referência, o 1º contato com clique está no índice 6.
 *
 * `--allow-mv-unknown` admite o bucket `unknown` da MV. Justificativa completa
 * em `decideFromMvBucket`: para um lote de ex-assinantes, as dezenas de
 * entregas já registradas são evidência mais forte que uma sondagem SMTP
 * inconclusiva. NUNCA afrouxa `rejected` (veredito negativo do destino).
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
  type SkipReason,
} from "./lib/curated-batch-import.ts";
import { buildOrigin } from "./lib/shared/brevo-diaria-origin.ts"; // #6678

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CURATED_LOG_PATH = resolve(ROOT, "data/brevo-diaria/curated-import-log.jsonl");

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

export type CuratedImportOutcome =
  | { kind: "imported"; mvResult: string; warning?: string }
  | { kind: "skipped"; reason: SkipReason; detail: string };

/**
 * I/O — importa 1 contato do lote curado: verifica na MV, ingere na lista
 * Brevo, registra no store (persistindo já) e grava a auditoria.
 *
 * Extraída do `main()` para ter seam de injeção (`verify`, `ingest`,
 * `appendLog`, `persistStore`) — sem isso a ordem das mutações, que é
 * exatamente o que o #5843 quebrou no script irmão, não teria como ser
 * travada por teste. Mesmo padrão de `applySunsetOne`.
 *
 * A ordem é deliberada e espelha o sunset:
 *  1. MV falha       → nada aconteceu, skip tipado.
 *  2. Ingestão falha → nada aconteceu, skip tipado.
 *  3. Ingestão OK    → store atualizado e PERSISTIDO antes de qualquer outra
 *                      coisa (é o que governa dedup e cap; um kill aqui não
 *                      pode perder a ingestão real que já ocorreu).
 *  4. Auditoria falha → aviso, nunca reversão: o registro some, o efeito não.
 */
export async function importOneCuratedContact(params: {
  entry: CuratedEntry;
  store: BrevoDiariaStore;
  sourceFile: string;
  mvApiKey: string;
  brevoApiKey: string;
  brevoListId: number;
  logPath: string;
  persistStore: (store: BrevoDiariaStore) => void;
  /** Admite bucket `unknown` da MV — ver `decideFromMvBucket`. */
  allowMvUnknown?: boolean;
  now?: () => string;
  verify?: (apiKey: string, email: string) => Promise<{ result: string; bucket: "verified" | "rejected" | "unknown" }>;
  ingest?: (apiKey: string, listId: number, email: string) => Promise<void>;
  appendLog?: (entry: CuratedImportLogEntry, path: string) => void;
}): Promise<{ outcome: CuratedImportOutcome; nextStore: BrevoDiariaStore }> {
  const {
    entry,
    store,
    sourceFile,
    mvApiKey,
    brevoApiKey,
    brevoListId,
    logPath,
    persistStore,
    allowMvUnknown = false,
    now = () => new Date().toISOString(),
    verify = (apiKey, email) => verifyOnMv(apiKey, email, fetch),
    ingest = ingestContactToBrevo,
    appendLog = appendCuratedImportLog,
  } = params;

  let mv: { result: string; bucket: "verified" | "rejected" | "unknown" };
  try {
    mv = await verify(mvApiKey, entry.email);
  } catch (e) {
    return {
      outcome: { kind: "skipped", reason: "mv_falhou", detail: (e as Error).message },
      nextStore: store,
    };
  }

  const decision = decideFromMvBucket(mv.bucket, allowMvUnknown);
  if (!decision.ingest) {
    return { outcome: { kind: "skipped", reason: decision.reason, detail: mv.result }, nextStore: store };
  }

  try {
    await ingest(brevoApiKey, brevoListId, normalizeEmail(entry.email));
  } catch (e) {
    return {
      outcome: { kind: "skipped", reason: "ingestao_falhou", detail: (e as Error).message },
      nextStore: store,
    };
  }

  const nextStore = upsertIngested(
    store,
    { email: entry.email, beehiiv_subscription_id: buildOrigin("curated", normalizeEmail(entry.email)) },
    now(),
  );
  persistStore(nextStore);

  try {
    appendLog(
      {
        email: normalizeEmail(entry.email),
        imported_at: now(),
        source_file: sourceFile,
        received: entry.received,
        opened: entry.opened,
        clicked: entry.clicked,
        mv_result: mv.result,
        origem: "curated",
      },
      logPath,
    );
  } catch (e) {
    return {
      outcome: { kind: "imported", mvResult: mv.result, warning: `o log de auditoria falhou: ${(e as Error).message}` },
      nextStore,
    };
  }

  return { outcome: { kind: "imported", mvResult: mv.result }, nextStore };
}

/**
 * #6793 "Faixa A" (30/08/2026, decisão do editor, item 8): freio automático
 * de VOLUME da fila compartilhada removido — este lote curado deixou de ter
 * teto de contatos ativos simultâneos. `daily_send_cap`/`DEFAULT_QUEUE_CAP`
 * continuam existindo (item 5, `checkDailySendCap` em publish-daily-brevo.ts
 * segue lendo `daily_send_cap` como teto de ENVIO diário) — só o uso daqui,
 * como cap da FILA compartilhada, foi removido. Mantida como função (em vez
 * de inlinar `Number.POSITIVE_INFINITY` nos 2 call sites) pra preservar o
 * ponto único de mudança se a decisão for revertida.
 */
function readQueueCap(_log: (msg: string) => void): number {
  return Number.POSITIVE_INFINITY;
}

export function formatPlanReport(params: {
  inputPath: string;
  total: number;
  selected: CuratedEntry[];
  skipped: SkippedEntry[];
  currentActiveCount: number;
  cap: number;
  allowMvUnknown: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`[import-curated-batch-brevo] arquivo: ${params.inputPath}`);
  lines.push(`[import-curated-batch-brevo] ${params.total} registro(s) no lote.`);
  lines.push(
    `[import-curated-batch-brevo] fila compartilhada: ${params.currentActiveCount} ocupados, sem teto (#6793) — ` +
      `${computeAvailableSlots(params.currentActiveCount, params.cap)} slot(s) livre(s).`,
  );
  lines.push(`[import-curated-batch-brevo] ${params.selected.length} elegível(is) após dedup + cap.`);
  const summary = summarizeSkips(params.skipped);
  for (const [reason, n] of Object.entries(summary)) {
    lines.push(`[import-curated-batch-brevo]   ${n} pulado(s): ${reason}`);
  }
  // A flag afrouxa um guard de segurança e só se manifesta no --push (o
  // dry-run não chama a MV). Sem ecoá-la aqui, o operador não tem como
  // confirmar que passou a flag certa antes de disparar pra valer.
  lines.push(
    `[import-curated-batch-brevo] MV: ${
      params.allowMvUnknown
        ? "bucket `unknown` ADMITIDO (--allow-mv-unknown); `rejected` segue barrado"
        : "só bucket `verified` entra (default)"
    }`,
  );
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
  const allowMvUnknown = hasFlag(argv, "allow-mv-unknown");

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
    prioritizeClicked: hasFlag(argv, "prioritize-clicked"),
  });
  const allSkipped = [...parsed.skipped, ...selection.skipped];

  process.stdout.write(
    formatPlanReport({
      inputPath,
      total: parsed.entries.length + parsed.skipped.length,
      selected: selection.selected,
      skipped: allSkipped,
      allowMvUnknown,
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
  let warned = 0;
  const runtimeSkipped: SkippedEntry[] = [];
  const now = () => new Date().toISOString();

  for (const entry of selection.selected) {
    const { outcome, nextStore } = await importOneCuratedContact({
      entry,
      store,
      sourceFile: inputPath,
      mvApiKey,
      brevoApiKey: brevoTarget.apiKey,
      brevoListId: brevoTarget.listId,
      logPath: DEFAULT_CURATED_LOG_PATH,
      persistStore: (s) => writeStore(s, DEFAULT_STORE_PATH),
      allowMvUnknown,
    });
    store = nextStore;

    if (outcome.kind === "imported") {
      imported++;
      if (outcome.warning) {
        warned++;
        log(`  ${entry.email} — ingerido na lista Brevo ${brevoTarget.listId}, mas ${outcome.warning}`);
      } else {
        log(`  ${entry.email} — ingerido na lista Brevo ${brevoTarget.listId} (MV: ${outcome.mvResult}).`);
      }
    } else {
      runtimeSkipped.push({ email: entry.email, reason: outcome.reason, detail: outcome.detail });
      if (outcome.reason === "mv_falhou" || outcome.reason === "ingestao_falhou") {
        failed++;
        log(`  FALHA em ${entry.email} (${outcome.reason}): ${outcome.detail}`);
      } else {
        log(`  ${entry.email} — pulado (MV: ${outcome.detail}).`);
      }
    }
  }

  writeStore(store, DEFAULT_STORE_PATH);
  const skipSummary = summarizeSkips(runtimeSkipped);
  log(
    `push concluído: ${imported} importado(s), ${failed} falha(s), ${warned} com auditoria pendente, ` +
      `${runtimeSkipped.length} não ingerido(s) (${JSON.stringify(skipSummary)}).`,
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
