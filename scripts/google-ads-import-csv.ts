/**
 * scripts/google-ads-import-csv.ts (#5503)
 *
 * CLI fino em cima de `scripts/lib/google-ads-csv.ts` (núcleo puro/testável).
 * Lê os exports MANUAIS do painel Google Ads (`data/aquisicao/google-ads/`,
 * ver #5254) e:
 *
 * - (default) importa `campanhas-*.csv` → `SpendRow[]` (1 linha por
 *   sub-canal PMax/Search/Outros presente, #5503 item 6 — reusa
 *   `SpendRow.subcanal`, já existente desde #5496) e faz o MERGE em
 *   `data/aquisicao/spend.csv` via `mergeSpendRows` (mesmo helper de
 *   `google-ads-ingest.ts`/`spend-ingest.ts`, nunca duplicado).
 * - (`--report`) imprime keywords com zero impressão
 *   (`palavras-chave-*.csv`) e termos com custo > 0
 *   (`termos-de-pesquisa-*.csv`), sem tocar `spend.csv`.
 *
 * ## `--mes` é OBRIGATÓRIO no modo import (não no `--report`)
 *
 * Os exports do painel vêm em "Todo o período", sem coluna de data — não há
 * como este script adivinhar o mês (#5503, limitação documentada na issue:
 * a única saída real é re-exportar com segmentação por data, ação futura do
 * editor). Rodar sem `--mes` no modo import é erro duro, não default
 * silencioso — decidir o mês errado contaminaria `spend.csv` pior que não
 * rodar o import.
 *
 * ## Uso
 *
 *   npx tsx scripts/google-ads-import-csv.ts --mes 2026-02
 *   npx tsx scripts/google-ads-import-csv.ts --mes 2026-02 --dir data/aquisicao/google-ads
 *   npx tsx scripts/google-ads-import-csv.ts --report
 *
 * **`data/` é gitignored e ausente em clone fresco** — este script (assim
 * como `readSpendCsv`) lança com mensagem clara quando o diretório/arquivo
 * não existe; nunca degrada silenciosamente pra "nenhum CSV encontrado" sem
 * dizer o path checado.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, getStringArg, hasFlag } from "./lib/cli-args.ts";
import { readSpendCsv, formatSpendCsv, type SpendRow } from "./lib/aquisicao-spend.ts";
import { mergeSpendRows } from "./lib/spend-ingest.ts";
import {
  parseGoogleAdsCampanhasCsv,
  parseGoogleAdsKeywordsCsv,
  parseGoogleAdsTermosCsv,
  buildSpendRowsFromCampanhas,
  zeroImpressionKeywords,
  termsWithCost,
} from "./lib/google-ads-csv.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CSV_DIR = resolve(ROOT, "data", "aquisicao", "google-ads");
export const DEFAULT_SPEND_CSV_PATH = resolve(ROOT, "data", "aquisicao", "spend.csv");

function listFilesByPrefix(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".csv"))
    .sort()
    .map((f) => resolve(dir, f));
}

function requireDir(dir: string): void {
  if (!existsSync(dir)) {
    throw new Error(
      `[google-ads-import-csv] diretório não encontrado: ${dir}. Exportar os relatórios do painel Google Ads ` +
        `(campanhas/anúncios/palavras-chave/termos de pesquisa) pra este diretório antes de rodar (#5254).`,
    );
  }
}

/** Modo import (default): campanhas-*.csv -> SpendRow[] com sub-canal,
 *  merge em spend.csv. Exportado pra ser testável sem tocar disco de
 *  verdade (injeta `dir`/`spendPath`/leitura de arquivo). */
export function runImport(opts: { dir: string; mes: string; canal?: string; moeda?: string; readFile: (path: string) => string }): {
  spendRows: SpendRow[];
  filesRead: string[];
} {
  const files = listFilesByPrefix(opts.dir, "campanhas-");
  if (files.length === 0) {
    throw new Error(`[google-ads-import-csv] nenhum arquivo "campanhas-*.csv" encontrado em ${opts.dir}.`);
  }

  const canal = opts.canal ?? "Google Ads";
  const moeda = opts.moeda ?? "BRL";
  let spendRows: SpendRow[] = [];
  for (const file of files) {
    const content = opts.readFile(file);
    const { rows } = parseGoogleAdsCampanhasCsv(content);
    const built = buildSpendRowsFromCampanhas(rows, {
      canal,
      mes: opts.mes,
      moeda,
      fonteLabel: `painel Google Ads, export manual (${file.split("/").pop()}, #5254)`,
    });
    spendRows = mergeSpendRows(spendRows, built);
  }
  return { spendRows, filesRead: files };
}

/** Modo `--report`: keywords zero-impressão + termos com custo>0. */
export function runReport(opts: { dir: string; readFile: (path: string) => string }): string[] {
  const lines: string[] = [];

  const kwFiles = listFilesByPrefix(opts.dir, "palavras-chave-");
  for (const file of kwFiles) {
    const { rows } = parseGoogleAdsKeywordsCsv(opts.readFile(file));
    const zero = zeroImpressionKeywords(rows);
    lines.push(`## ${file.split("/").pop()} — ${zero.length}/${rows.length} keyword(s) com 0 impressão`);
    for (const r of zero) lines.push(`  - ${r.palavraChave}`);
  }

  const termFiles = listFilesByPrefix(opts.dir, "termos-de-pesquisa-");
  for (const file of termFiles) {
    const { rows } = parseGoogleAdsTermosCsv(opts.readFile(file));
    const withCost = termsWithCost(rows);
    lines.push(`## ${file.split("/").pop()} — ${withCost.length}/${rows.length} termo(s) com custo > 0`);
    for (const r of withCost) lines.push(`  - ${r.termoDePesquisa}: R$ ${r.custo!.toFixed(2).replace(".", ",")}`);
  }

  if (kwFiles.length === 0 && termFiles.length === 0) {
    lines.push(`[google-ads-import-csv] nenhum "palavras-chave-*.csv" nem "termos-de-pesquisa-*.csv" encontrado em ${opts.dir}.`);
  }

  return lines;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const dir = getStringArg(argv, "dir") ?? DEFAULT_CSV_DIR;
  const spendPath = getStringArg(argv, "spend") ?? DEFAULT_SPEND_CSV_PATH;
  const report = hasFlag(argv, "report");

  try {
    requireDir(dir);

    if (report) {
      const lines = runReport({ dir, readFile: (p) => readFileSync(p, "utf8") });
      console.log(lines.join("\n"));
      return 0;
    }

    const mes = getStringArg(argv, "mes");
    if (!mes) {
      console.error(
        `[google-ads-import-csv] --mes AAAA-MM é obrigatório no modo import — os exports do painel vêm em ` +
          `"Todo o período", sem coluna de data (#5503). Rode com --report pra ver keywords/termos sem precisar do mês.`,
      );
      return 1;
    }

    const { spendRows: importedRows, filesRead } = runImport({ dir, mes, readFile: (p) => readFileSync(p, "utf8") });
    const existingRows = existsSync(spendPath) ? readSpendCsv(spendPath).rows : [];
    const merged = mergeSpendRows(existingRows, importedRows);
    writeFileSync(spendPath, formatSpendCsv(merged), "utf8");
    console.log(
      `[google-ads-import-csv] ✔ ${spendPath} atualizado (${importedRows.length} linha(s) de ${filesRead.length} arquivo(s): ${filesRead
        .map((f) => f.split("/").pop())
        .join(", ")}).`,
    );
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
