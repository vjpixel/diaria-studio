#!/usr/bin/env node
/**
 * clarice-split-group-cells.ts (#4657 — fecha o item 3 da #4449)
 *
 * Divide o CSV de um grupo em 3 células A/B/C e escreve o manifest que
 * `clarice-import-waves.ts --group {dia}` lê — com as chaves GERADAS por
 * `waveKey()`, nunca digitadas.
 *
 * Por que este script precisa existir: `clarice-build-segment.ts` escreve um
 * manifest de UMA entrada, com `key` = nome do grupo (`ramp-warm`), que nunca
 * termina em `-A`/`-B`/`-C`. E `clarice-import-waves.ts` só usa
 * `groupCellListNameFor` (o único naming que o painel consegue parsear pro
 * fluxo `--group`, #4447) quando a `key` TEM esse sufixo. Pelo caminho
 * scriptado, portanto, nunca se chegava a uma lista com célula: o ciclo
 * 2607-08 só conseguiu porque alguém escreveu `d1-sab01-manifest.json` com 3
 * entradas à mão. O #4471 ligou o gerador de NOME, mas quem continuava sendo
 * digitado era a CHAVE — este script fecha isso.
 *
 * SEGURANÇA: só LÊ um CSV e ESCREVE CSVs + manifest LOCAIS. Não fala com a
 * Brevo. O envio segue gated no import (dry-run por padrão) + schedule.
 *
 * Uso:
 *   npx tsx scripts/clarice-split-group-cells.ts --cycle 2607-08 --wave 6 \
 *     --date 2026-08-06 --from segments/ramp-warm.csv [--dry-run]
 *
 *   --cycle X   OBRIGATÓRIO — {conteúdo}-{envio}.
 *   --wave N    OBRIGATÓRIO — número da onda (vem de `startingWaveNumber` da
 *               proposta; continua a numeração do ciclo, nunca reinicia).
 *   --date D    OBRIGATÓRIO — YYYY-MM-DD do envio (explícita, nunca inferida).
 *   --from P    OBRIGATÓRIO — CSV de origem, relativo ao dir do ciclo.
 *   --dry-run   só imprime o plano.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { clariceCycleDir, clariceSegmentsDir, ensureDir, requireCycleArg } from "./lib/clarice-paths.ts";
import { getArg, getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { buildGroupCells, cellManifestFileName } from "./lib/clarice-group-cells.ts";

type Row = Record<string, string>;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cycle = requireCycleArg(argv);
  const wave = getIntArg(argv, "wave");
  const date = getArg(argv, "date");
  const from = getArg(argv, "from");
  const dryRun = hasFlag(argv, "dry-run");

  if (wave === undefined || wave <= 0) {
    console.error("❌ --wave N é obrigatório (inteiro > 0 — o número da onda, vindo da proposta).");
    process.exit(1);
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("❌ --date YYYY-MM-DD é obrigatório (explícita, nunca inferida).");
    process.exit(1);
  }
  if (!from) {
    console.error("❌ --from é obrigatório (CSV de origem, relativo ao dir do ciclo).");
    process.exit(1);
  }

  const cycleDir = clariceCycleDir(cycle);
  const srcPath = resolve(cycleDir, from);
  if (!existsSync(srcPath)) {
    console.error(`❌ CSV de origem não existe: ${srcPath}`);
    process.exit(1);
  }

  const parsed = Papa.parse<Row>(readFileSync(srcPath, "utf8"), { header: true, skipEmptyLines: true });
  const rows = parsed.data;
  if (rows.length === 0) {
    console.error(`❌ CSV de origem vazio: ${srcPath} — nada a dividir.`);
    process.exit(1);
  }

  const { groupKey, manifest, cells } = buildGroupCells(rows, wave, date);
  const fields = parsed.meta.fields ?? Object.keys(rows[0]);

  console.log(`Onda d${wave} · ${date} · grupo '${groupKey}' · ${rows.length} contatos`);
  for (const e of manifest) console.log(`  ${e.key.padEnd(16)} ${String(e.count).padStart(6)} contatos → ${e.file}`);

  if (dryRun) {
    console.log("(dry-run — nada escrito.)");
    return;
  }

  const dir = clariceSegmentsDir(cycle);
  ensureDir(dir);
  manifest.forEach((entry, i) => {
    writeFileAtomic(resolve(dir, entry.file), Papa.unparse({ fields, data: cells[i] }));
  });
  const manifestPath = resolve(dir, cellManifestFileName(groupKey));
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`✅ ${manifest.length} células + manifest em ${manifestPath}`);
  console.log(`Próximo passo: npx tsx scripts/clarice-import-waves.ts --cycle ${cycle} --group ${groupKey} --label "..." --execute`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
