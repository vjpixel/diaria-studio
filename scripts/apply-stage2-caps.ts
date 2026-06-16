#!/usr/bin/env tsx
/**
 * apply-stage2-caps.ts (#358, #907) — CLI
 *
 * Lê `_internal/01-approved.json`, aplica caps editoriais de Stage 2
 * (#358) e grava `_internal/01-approved-capped.json` (ou `--out` custom).
 *
 * Uso:
 *   npx tsx scripts/apply-stage2-caps.ts \
 *     --in data/editions/{AAMMDD}/_internal/01-approved.json \
 *     --out data/editions/{AAMMDD}/_internal/01-approved-capped.json
 *
 * Stdout: JSON com `report` (before/after/caps/truncated). Stderr: linha
 * humana com resumo. Exit 0 sempre que conseguir escrever output (mesmo
 * sem nenhum bucket precisando truncar).
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyStage2Caps,
  STAGE_2_MIN_USE_MELHOR,
  STAGE_2_MAX_USE_MELHOR,
  type ApprovedJson,
} from "./lib/apply-stage2-caps.ts";
import { formatCoverageLine } from "./lib/inbox-stats.ts";

interface CoverageLike {
  editor_submitted?: number;
  diaria_discovered?: number;
  selected?: number;
  line?: string;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.out) {
    console.error(
      "Uso: apply-stage2-caps.ts --in <approved.json> --out <approved-capped.json>",
    );
    process.exit(1);
  }
  const inPath = resolve(ROOT, args.in);
  const outPath = resolve(ROOT, args.out);
  if (!existsSync(inPath)) {
    console.error(`Arquivo não existe: ${inPath}`);
    process.exit(1);
  }

  const approved = JSON.parse(readFileSync(inPath, "utf8")) as ApprovedJson;
  const { approved: capped, report } = applyStage2Caps(approved);

  // #906 — recalcular coverage.line com o `selected` real pós-caps. Sem
  // isso, o writer copia coverage.line literal e a intro fica com "30
  // mais relevantes" mesmo quando a edição publica 12 artigos.
  const cov = capped.coverage as CoverageLike | undefined;
  if (cov && typeof cov.editor_submitted === "number" && typeof cov.diaria_discovered === "number") {
    const selectedCapped =
      (capped.highlights?.length ?? 0) +
      (capped.lancamento?.length ?? 0) +
      (capped.radar?.length ?? 0) +
      ((capped.use_melhor as unknown[] | undefined)?.length ?? 0) +
      ((capped.video as unknown[] | undefined)?.length ?? 0);
    capped.coverage = {
      ...cov,
      selected: selectedCapped,
      line: formatCoverageLine({
        editorSubmissions: cov.editor_submitted,
        diariaDiscovered: cov.diaria_discovered,
        selected: selectedCapped,
      }),
    };
  }

  // Atomic write via .tmp + rename — previne corrupção do output em
  // caso de crash mid-write (review #921 P1). Padrão consistente com
  // `savePublished` em scripts/publish-linkedin.ts.
  const tmpPath = outPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(capped, null, 2) + "\n", "utf8");
  renameSync(tmpPath, outPath);

  console.error(
    `[apply-stage2-caps] dest=${approved.highlights?.length ?? 0}, ` +
      `lanç=${report.before.lancamento}→${report.after.lancamento} (cap ${report.caps.lancamento}), ` +
      `radar=${report.before.radar}→${report.after.radar} (cap ${report.caps.radar}), ` +
      `use_melhor=${report.use_melhor.before}→${report.use_melhor.after}` +
      (report.use_melhor.promoted > 0 ? ` (+${report.use_melhor.promoted} promovidos)` : "") +
      (report.use_melhor.truncated > 0 ? ` (−${report.use_melhor.truncated} pelo cap máximo ${STAGE_2_MAX_USE_MELHOR}, #2313)` : ""),
  );
  // #1855: warn loud quando nem com runners-up dá pra bater o mínimo de USE
  // MELHOR — o orchestrator surfa no gate. NUNCA preencher com não-tutorial.
  if (report.use_melhor.shortfall > 0) {
    console.error(
      `[apply-stage2-caps] ⚠️ USE MELHOR abaixo do mínimo: ${report.use_melhor.after}/${STAGE_2_MIN_USE_MELHOR} ` +
        `tutoriais (faltam ${report.use_melhor.shortfall}). Pool sem candidatos use_melhor suficientes — ` +
        `surfar no gate; NÃO completar com notícia/análise (editorial-rules.md:146).`,
    );
  }
  process.stdout.write(
    JSON.stringify({ out: outPath, report }, null, 2) + "\n",
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
