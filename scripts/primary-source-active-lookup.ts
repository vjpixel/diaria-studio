#!/usr/bin/env npx tsx
/**
 * primary-source-active-lookup.ts (#10137) — Stage 1 §1u-sexies
 *
 * Busca ATIVA de fonte primária para os destaques D1-D3, executada pelo
 * próprio runner (`stage-1-run.ts`, fase `post-select-render`), logo depois
 * dos rebaixamentos §1u-quater/§1u-quinquies (top-3 já final) e ANTES do
 * dedup intra-edição (§1u-bis) e do render do MD (§1v) — o gate 1, o
 * `--auto` e o writer já veem a URL oficial.
 *
 * Por que existe: §1m-ter (#1699) e §1y (#5664) dependiam de um dispatch de
 * `discovery-searcher` pelo orchestrator; desde o runner (#5415) os dois
 * ficaram em `DELEGATED_STEPS` e ninguém os rodava — zero
 * `primary_source_substituted` em todas as edições depois de 260818, e o
 * editor trocando a URL secundária pela oficial à mão no gate 4.
 *
 * Mecanismo (determinístico, sem Agent): para cada destaque do top-N cuja
 * manchete cita uma empresa conhecida (`detectDomainMismatchCandidate`) ou que
 * já tem `suggested_primary_domain`, roda 1 query Brave
 * `site:{domínio oficial} {título}` e aplica a regra de
 * `choosePrimarySource` (#5664): resultado no domínio oficial (ou subdomínio)
 * E mesmo assunto — similaridade de título >= 0,60 OU o MESMO produto com
 * versão idêntica nos dois títulos (`sameStoryByExactProductVersion`:
 * "Haiku 5.5" ↔ "Haiku 5.5"; nunca só "Claude"/"GPT", nunca "GPT-5.5" ↔
 * "GPT-5"). #10141: o matcher do dedup intra-edição (`isIntraEditionDuplicate`)
 * NÃO serve aqui — os ramos `cross_vehicle`/`entity` aceitavam "mesma empresa
 * + 1 palavra" e trocavam manchete de processo/multa/demissão por página de
 * produto sem relação. Só roda para destaque com `suggested_primary_domain`
 * E verbo de lançamento no título; na dúvida, mantém a URL secundária.
 *
 * Fail-soft em tudo: sem `BRAVE_API_KEY`, sem `past-editions.md`, busca com
 * erro, JSON ilegível → nada muda e exit 0. URL oficial que repete edição
 * passada (janela `DEDUP_URL_WINDOW_DAYS`) ou já está nesta edição nunca é
 * usada (fica para o `review-highlight-official-swap` sugerir no gate).
 * A URL secundária fica em `primary_source_substituted.from`.
 *
 * Uso:
 *   npx tsx scripts/primary-source-active-lookup.ts \
 *     --categorized data/editions/2610/261008/_internal/01-categorized.json \
 *     [--edition 261008] [--past-editions data/past-editions.md] \
 *     [--destaque-count 3] [--out-log .../_internal/01-primary-source-lookup.json]
 *
 * Stdout: JSON `{ skipped?, attempted, replaced, notes[] }`.
 */

import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import { braveSearch } from "./lib/brave-search.ts";
import { recordBraveCredit } from "./lib/brave-credits.ts";
import { canonicalize } from "./lib/url-utils.ts";
import {
  DEDUP_URL_WINDOW_DAYS,
  deriveCurrentEdition,
  extractPastUrlsWithinDays,
  readPastEditionsMd,
} from "./lib/past-editions-extract.ts";
import {
  runActivePrimarySourceLookup,
  type ActiveLookupAttempt,
  type ActiveLookupInput,
  type PrimarySourceCandidate,
  sameStoryByExactProductVersion,
} from "./lib/primary-source-lookup.ts";

export function formatAttemptNote(a: ActiveLookupAttempt): string {
  const d = a.rank ? `D${a.rank}` : "destaque";
  if (a.status === "replaced") return `🔗 fonte primária (${d}): ${a.from} → ${a.to} [${a.match}]`;
  return `🔎 fonte primária (${d}) mantida: ${a.reason}${a.to ? ` (${a.to})` : ""}`;
}

interface Output {
  skipped?: string;
  attempted: number;
  replaced: number;
  notes: string[];
  attempts?: ActiveLookupAttempt[];
}

function emit(out: Output, outLog?: string): void {
  if (outLog) {
    try {
      writeFileSync(outLog, JSON.stringify(out, null, 2) + "\n", "utf8");
    } catch (err) {
      out.notes.push(`⚠️  primary-source-active-lookup: não gravou ${outLog}: ${(err as Error).message}`);
    }
  }
  process.stdout.write(JSON.stringify(out) + "\n");
}

async function main(): Promise<void> {
  const args = parseArgsSimple(process.argv.slice(2));
  const categorizedPath = args.categorized ?? "";
  const outLog = args["out-log"];
  if (!categorizedPath) {
    console.error("Uso: primary-source-active-lookup.ts --categorized <01-categorized.json> [--edition AAMMDD] [--past-editions <md>] [--destaque-count 3] [--out-log <json>]");
    process.exit(1);
  }
  const skip = (reason: string, note: string) => emit({ skipped: reason, attempted: 0, replaced: 0, notes: [note] }, outLog);

  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return skip("no-brave-api-key", "ℹ️  fonte primária (§1u-sexies): BRAVE_API_KEY ausente — pulado, destaques mantêm a URL atual.");

  const pastPath = args["past-editions"] ?? "data/past-editions.md";
  if (!existsSync(pastPath)) return skip("no-past-editions", `ℹ️  fonte primária (§1u-sexies): ${pastPath} ausente — pulado (sem histórico não dá pra garantir URL inédita).`);
  if (!existsSync(categorizedPath)) return skip("no-categorized", `⚠️  fonte primária (§1u-sexies): ${categorizedPath} ausente — pulado.`);

  let input: ActiveLookupInput;
  try {
    input = JSON.parse(readFileSync(categorizedPath, "utf8")) as ActiveLookupInput;
  } catch (err) {
    return skip("invalid-categorized", `⚠️  fonte primária (§1u-sexies): JSON ilegível (${(err as Error).message}) — pulado.`);
  }

  const edition = args.edition ?? deriveCurrentEdition(categorizedPath);
  const pastUrls = extractPastUrlsWithinDays(readPastEditionsMd(pastPath), DEDUP_URL_WINDOW_DAYS, edition);
  const destaqueCount = Number.parseInt(args["destaque-count"] ?? "3", 10) || 3;

  const search = async (query: string): Promise<PrimarySourceCandidate[] | null> => {
    const response = await braveSearch(query, { apiKey, count: 5 });
    if (response.status === "ok" || response.status === "rate_limited") {
      recordBraveCredit({ edition, query, status: response.status, http_status: response.http_status });
    }
    if (response.status !== "ok") return null;
    return response.results.map((r) => ({ url: r.url, title: r.title }));
  };

  const result = await runActivePrimarySourceLookup(input, {
    search,
    pastUrls,
    canonicalize,
    sameStory: sameStoryByExactProductVersion,
    destaqueCount,
  });

  // Grava também quando nada foi trocado: a anotação `primary_source_lookup`
  // registra a tentativa (e o motivo de manter) para o gate e para auditoria.
  if (result.attempts.length > 0) {
    writeFileSync(categorizedPath, JSON.stringify(result.output, null, 2) + "\n", "utf8");
  }

  emit(
    {
      attempted: result.attempts.length,
      replaced: result.replaced,
      notes: result.attempts.map(formatAttemptNote),
      attempts: result.attempts,
    },
    outLog,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    // Fail-soft: o runner trata exit != 0 como aviso, mas nunca deixamos o
    // JSON de categorized pela metade (a escrita é a última coisa).
    console.error(`[primary-source-active-lookup] erro: ${(err as Error).stack ?? err}`);
    process.stdout.write(JSON.stringify({ skipped: "error", attempted: 0, replaced: 0, notes: [`⚠️  fonte primária (§1u-sexies) falhou: ${(err as Error).message}`] }) + "\n");
    process.exit(0);
  });
}
