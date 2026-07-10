#!/usr/bin/env npx tsx
/**
 * validate-stage-1-completeness.ts
 *
 * Validador anti-skip: garante que todos os passos do orchestrator-stage-1
 * que produzem outputs determinísticos rodaram. Roda antes do gate humano da
 * Etapa 1, depois do `validate-stage-1-injection.ts` (#625) e
 * `check-drive-push.ts` (#577).
 *
 * Cobre:
 *   1. `researcher-results.json` existe E tem entries de `source-researcher`
 *      ou `discovery` (não só RSS) — anti-skip do passo 1f (#1074).
 *      Em prod, `/diaria-edicao` exige dispatch completo independente do
 *      RSS batch ter trazido artigos. `/diaria-test` com `rss_only=true`
 *      explicitamente pula 1f — nesse caso, o validador é pulado via
 *      `--allow-rss-only`.
 *
 * Por que: incidente 2026-05-11, edição 260512. RSS batch trouxe 109
 * artigos, passo 1f foi skipado silenciosamente. Mesma classe do `#594`
 * (passo 1h skipado em 260505).
 *
 * Uso:
 *   npx tsx scripts/validate-stage-1-completeness.ts \
 *     --edition-dir data/editions/260512
 *
 *   npx tsx scripts/validate-stage-1-completeness.ts \
 *     --edition-dir data/editions/260512 --allow-rss-only
 *
 * Exit codes:
 *   0 = todos os passos executaram
 *   1 = passo 1f skipado (sem entries de source-researcher/discovery)
 *   2 = erro de leitura (arquivo ausente, JSON inválido)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

interface ResearcherRun {
  source: string;
  outcome: "ok" | "fail";
  method?: string;
  articles?: unknown[];
  duration_ms?: number;
}

/**
 * Pure: dado o array de runs do researcher-results.json, retorna
 * `{ ok, reason?, stats }` indicando se o passo 1f rodou (tem entries
 * que NÃO são puramente RSS).
 */
export function checkResearcherCompleteness(
  runs: ResearcherRun[],
): { ok: boolean; reason?: string; stats: { total: number; rss: number; researcher: number; discovery: number } } {
  let rss = 0;
  let researcher = 0;
  let discovery = 0;
  for (const r of runs) {
    if (r.source?.startsWith("discovery:")) {
      discovery++;
    } else if (r.method === "rss" || r.method === "sitemap") {
      rss++;
    } else {
      // Source-researcher real escreve method: "websearch" (validado em
      // edições passadas — ex: 260508 tem 5 entries com método websearch).
      // Default cobre também ausência de method (defensive).
      researcher++;
    }
  }
  if (researcher === 0 && discovery === 0) {
    return {
      ok: false,
      reason:
        "passo 1f não rodou: 0 entries de source-researcher OU discovery " +
        `(${rss} RSS, ${researcher} researcher, ${discovery} discovery). ` +
        "Per #1074, /diaria-edicao em prod exige dispatch completo. " +
        "Re-rode o passo 1f antes do gate humano. " +
        "Pra modo `rss_only` (/diaria-test), use --allow-rss-only.",
      stats: { total: runs.length, rss, researcher, discovery },
    };
  }
  return { ok: true, stats: { total: runs.length, rss, researcher, discovery } };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const editionDir = args.values["edition-dir"];
  const allowRssOnly = args.flags.has("allow-rss-only");

  if (!editionDir) {
    console.error(
      "Uso: validate-stage-1-completeness.ts --edition-dir <path> [--allow-rss-only]",
    );
    process.exit(2);
  }

  const path = resolve(process.cwd(), editionDir, "_internal/researcher-results.json");
  if (!existsSync(path)) {
    // Sem researcher-results.json: passo 1f não rodou OU 1g (record-source-runs) não rodou
    if (allowRssOnly) {
      console.log(JSON.stringify({ ok: true, skipped: true, reason: "rss_only mode" }));
      process.exit(0);
    }
    console.error(
      JSON.stringify({
        ok: false,
        reason: `researcher-results.json não existe em ${path}. Passo 1f (dispatch researchers + discovery) foi skipado silenciosamente.`,
      }),
    );
    process.exit(1);
  }

  let runs: ResearcherRun[];
  try {
    runs = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, reason: `JSON inválido: ${(e as Error).message}` }));
    process.exit(2);
  }

  if (!Array.isArray(runs)) {
    console.error(JSON.stringify({ ok: false, reason: "researcher-results.json não é array" }));
    process.exit(2);
  }

  const result = checkResearcherCompleteness(runs);
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    if (allowRssOnly) {
      console.error("[validate-stage-1-completeness] WARN: passo 1f skipado, mas --allow-rss-only setado");
      process.exit(0);
    }
    process.exit(1);
  }

  process.exit(0);
}

// #2834: guard anterior comparava só `file://${path}` (sem a variante
// `file:///` de 3 barras) — nunca batia no Windows (drive letter), então
// main() nunca rodava quando invocado via CLI (bug real, não só duplicação;
// mascarado porque o passo falha "silenciosamente em sucesso": exit 0, sem
// output, sem quebrar o pipeline — exatamente a classe de bug que este
// script existe pra detectar, #1091).
if (isMainModule(import.meta.url)) {
  main();
}
