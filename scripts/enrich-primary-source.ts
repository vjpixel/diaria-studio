/**
 * enrich-primary-source.ts (#487)
 *
 * Pós-processa o output do `categorize.ts`: detecta artigos da bucket "noticia"
 * que provavelmente são lançamentos (verbo + empresa conhecida no título) e
 * adiciona flags `launch_candidate: true` + `suggested_primary_domain` para
 * o editor revisar e (manualmente, por enquanto) substituir pela fonte oficial.
 *
 * Não faz fetch / web search — só sinaliza. A regra editorial #160 fica
 * responsabilidade do editor com base na flag. Versão futura pode integrar
 * `WebSearch` via agente.
 *
 * Uso:
 *   npx tsx scripts/enrich-primary-source.ts \
 *     --in data/editions/{AAMMDD}/_internal/tmp-categorized.json \
 *     --out data/editions/{AAMMDD}/_internal/tmp-categorized.json
 *
 * In-place também é seguro (input == output).
 *
 * Output: mesmo shape do input, com campos extras nos artigos da bucket
 * "noticias" que casarem o detector. Imprime resumo no stderr.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { detectLaunchCandidate } from "./lib/launch-detect.ts";

interface Article {
  url?: string;
  title?: string;
  summary?: string | null;
  launch_candidate?: boolean;
  suggested_primary_domain?: string;
  matched_launch_keyword?: string;
  matched_company?: string;
  [key: string]: unknown;
}

interface Categorized {
  lancamento?: Article[];
  pesquisa?: Article[];
  noticias?: Article[];
  tutorial?: Article[];
  [key: string]: unknown;
}

export function enrichPrimarySource(
  input: Categorized,
): { output: Categorized; flagged: number } {
  if (!input.noticias) return { output: input, flagged: 0 };
  let flagged = 0;
  const enriched = input.noticias.map((a) => {
    const det = detectLaunchCandidate(a);
    if (!det.is_candidate) return a;
    flagged++;
    return {
      ...a,
      launch_candidate: true,
      suggested_primary_domain: det.suggested_domain,
      matched_launch_keyword: det.matched_keyword,
      matched_company: det.matched_company,
    };
  });
  return { output: { ...input, noticias: enriched }, flagged };
}

function parseArgs(argv: string[]) {
  let inputPath = "";
  let outputPath = "";
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--in":
        inputPath = argv[++i];
        break;
      case "--out":
        outputPath = argv[++i];
        break;
    }
  }
  if (!inputPath) {
    console.error(
      "Uso: enrich-primary-source.ts --in <categorized.json> [--out <out.json>]",
    );
    process.exit(1);
  }
  return { inputPath, outputPath: outputPath || inputPath };
}

function main() {
  const { inputPath, outputPath } = parseArgs(process.argv);
  const input: Categorized = JSON.parse(readFileSync(inputPath, "utf8"));
  const { output, flagged } = enrichPrimarySource(input);
  writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
  const total = (output.noticias ?? []).length;
  console.error(
    `enrich-primary-source: ${flagged}/${total} notícia(s) sinalizadas como launch_candidate`,
  );
  if (flagged > 0) {
    for (const a of output.noticias ?? []) {
      if (a.launch_candidate) {
        console.error(
          `  - ${a.title?.slice(0, 80)} → suggested: ${a.suggested_primary_domain}`,
        );
      }
    }
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
