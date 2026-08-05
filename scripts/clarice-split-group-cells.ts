#!/usr/bin/env node
/**
 * clarice-split-group-cells.ts (#4657 — fecha o item 3 da #4449)
 *
 * Divide o CSV de um grupo em 3 células A/B/C — ou, com `--no-cells`, numa
 * lista única (assunto travado) — e escreve o manifest que
 * `clarice-import-waves.ts --group {dia}` lê, com as chaves GERADAS por
 * `waveKey()`, nunca digitadas.
 *
 * Por que este script precisa existir: `clarice-build-segment.ts` escreve um
 * manifest de UMA entrada, com `key` = nome do grupo (`ramp-warm`), que nunca
 * termina em `-A`/`-B`/`-C` nem casa `d{N}-`. Pelo caminho scriptado, portanto,
 * nunca se chegava a uma lista com célula (o ciclo 2607-08 só conseguiu porque
 * alguém escreveu `d1-sab01-manifest.json` com 3 entradas à mão), e uma onda
 * de vários dias com assunto travado sairia com campanhas de nome idêntico.
 * O #4471 ligou o gerador de NOME; quem continuava digitado era a CHAVE.
 *
 * SEGURANÇA: só LÊ um CSV e ESCREVE CSVs + manifest LOCAIS. Não fala com a
 * Brevo. O envio segue gated no import (dry-run por padrão) + schedule.
 *
 * Uso:
 *   npx tsx scripts/clarice-split-group-cells.ts --cycle 2607-08 --wave 6 \
 *     --date 2026-08-06 --from segments/ramp-warm.csv [--no-cells] [--dry-run]
 *
 *   --cycle X   OBRIGATÓRIO — {conteúdo}-{envio}.
 *   --wave N    OBRIGATÓRIO — número da onda (vem de `startingWaveNumber` da
 *               proposta; continua a numeração do ciclo, nunca reinicia).
 *   --date D    OBRIGATÓRIO — YYYY-MM-DD do envio (explícita, nunca inferida).
 *   --from P    OBRIGATÓRIO — CSV de origem, relativo ao dir do ciclo.
 *   --no-cells  1 lista só (assunto travado, sem teste A/B/C).
 *   --force     sobrescreve um manifest já existente (ver guarda abaixo).
 *   --dry-run   só imprime o plano.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { clariceCycleDir, clariceSegmentsDir, ensureDir, requireCycleArg } from "./lib/clarice-paths.ts";
import { getArg, getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  buildGroupCells,
  buildSingleWave,
  cellManifestFileName,
  manifestOf,
  resolveCellStrategy,
  unknownFlags,
  SPLIT_GROUP_CELLS_FLAGS,
} from "./lib/clarice-group-cells.ts";

type Row = Record<string, string>;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // Flag desconhecida ABORTA. `hasFlag` faz match exato e não havia rejeição
  // de argumento: `--nocells` digitado errado devolvia false e o script caía
  // SILENCIOSAMENTE em 3 células — com assunto travado, 3 listas pro mesmo
  // assunto, sem nada no log distinguindo isso de um A/B/C legítimo (#4660).
  const known = new Set([...SPLIT_GROUP_CELLS_FLAGS, "force"]);
  const bad = unknownFlags(argv, known);
  if (bad.length > 0) {
    console.error(
      `❌ flag(s) desconhecida(s): ${bad.join(", ")} — typo? Flags booleanas válidas: ${[...known].map((f) => `--${f}`).join(", ")}.`,
    );
    process.exit(1);
  }

  const cycle = requireCycleArg(argv);
  const wave = getIntArg(argv, "wave");
  const date = getArg(argv, "date");
  const from = getArg(argv, "from");
  const dryRun = hasFlag(argv, "dry-run");
  const force = hasFlag(argv, "force");

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

  const srcPath = resolve(clariceCycleDir(cycle), from);
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

  const strategy = resolveCellStrategy(argv);
  const artifact = strategy === "single" ? buildSingleWave(rows, wave, date) : buildGroupCells(rows, wave, date);
  const { groupKey, cells } = artifact;
  const manifest = manifestOf(artifact);
  const fields = parsed.meta.fields ?? Object.keys(rows[0]);

  // Contagem tem que fechar com a origem — a classe do #4577/#4602, onde uma
  // linha sumiu em silêncio. Barato, e roda antes de qualquer escrita.
  const totalCells = cells.reduce((s, c) => s + c.rows.length, 0);
  if (totalCells !== rows.length) {
    console.error(`❌ contagem não bate: ${rows.length} linhas de origem, células somam ${totalCells}. Abortando antes de escrever.`);
    process.exit(1);
  }

  // O modo escolhido SEMPRE aparece — sem isso, "3 células" e "1 lista" só se
  // distinguem contando linhas do log.
  console.log(`Modo: ${strategy === "single" ? "ONDA ÚNICA (assunto travado, sem A/B/C)" : "TESTE A/B/C (3 células)"}`);
  console.log(`Onda d${wave} · ${date} · grupo '${groupKey}' · ${rows.length} contatos`);
  for (const e of manifest) console.log(`  ${e.key.padEnd(16)} ${String(e.count).padStart(6)} contatos → ${e.file}`);

  if (dryRun) {
    console.log("(dry-run — nada escrito.)");
    return;
  }

  const dir = clariceSegmentsDir(cycle);
  const manifestPath = resolve(dir, cellManifestFileName(groupKey));

  // Guarda de idempotência: um manifest já existente pode ter sido IMPORTADO
  // na Brevo, e campanha agendada é imutável. Sobrescrever em silêncio num
  // retry pós-falha-parcial perderia o registro local de quais listas estão no
  // ar — e trocar de modo (3 células → 1 lista) no mesmo groupKey deixaria os
  // CSVs antigos órfãos, sem nada ligando as listas já criadas ao novo plano.
  if (existsSync(manifestPath) && !force) {
    const prev = JSON.parse(readFileSync(manifestPath, "utf8")) as Array<{ key: string }>;
    console.error(
      `❌ manifest já existe: ${manifestPath}\n` +
        `   ${prev.length} entrada(s): ${prev.map((e) => e.key).join(", ")}\n` +
        `   Pode já ter sido importado na Brevo (campanha agendada é IMUTÁVEL). Confira as listas no painel antes.\n` +
        `   Se o redo é intencional e nada foi importado ainda, repita com --force.`,
    );
    process.exit(1);
  }

  ensureDir(dir);
  for (const { entry, rows: cellRows } of cells) {
    writeFileAtomic(resolve(dir, entry.file), Papa.unparse({ fields, data: cellRows }));
  }
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));

  const noun = manifest.length === 1 ? "lista" : "células";
  console.log(`✅ ${manifest.length} ${noun} + manifest em ${manifestPath}`);
  console.log(`Próximo passo: npx tsx scripts/clarice-import-waves.ts --cycle ${cycle} --group ${groupKey} --label "..." --execute`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
