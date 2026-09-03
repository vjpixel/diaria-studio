/**
 * scripts/prune-audience-history.ts (#7129)
 *
 * Aplica a política de retenção de `scripts/lib/audience-history-retention.ts`
 * a `docs/audience-history/`: snapshots mais antigos que `RETENTION_DAYS`
 * (90 dias) são anexados a `docs/audience-history/_consolidated.md` (append-
 * only, nunca perde conteúdo) e o arquivo individual `YYYY-MM-DD.md` é
 * removido. Snapshots dentro da janela permanecem intocados.
 *
 * Standalone e não-automático de propósito (não é chamado por
 * `scripts/update-audience.ts`, que roda a cada edição e é business-crítico
 * — mesmo trade-off de `scripts/verify-emails-mv.ts`): o editor/cron roda
 * isto periodicamente (ex: mensal), sem acoplar o caminho de escrita diário
 * a uma lógica de retenção.
 *
 * Idempotente: um snapshot cujo marcador (`consolidatedMarkerFor`) já
 * existe em `_consolidated.md` nunca é reprocessado — rodar 2x seguidas no
 * mesmo estado é no-op na 2ª vez.
 *
 * Uso: `npx tsx scripts/prune-audience-history.ts [--dry-run]`
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import {
  RETENTION_DAYS,
  CONSOLIDATED_FILENAME,
  partitionHistoryFilesForRetention,
  buildConsolidatedEntry,
  consolidatedMarkerFor,
} from "./lib/audience-history-retention.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_DIR = resolve(ROOT, "docs/audience-history");
const CONSOLIDATED_PATH = resolve(HISTORY_DIR, CONSOLIDATED_FILENAME);

export function run(dryRun: boolean): void {
  if (!existsSync(HISTORY_DIR)) {
    console.log(`[prune-audience-history] ${HISTORY_DIR} não existe — nada a fazer.`);
    return;
  }

  const files = readdirSync(HISTORY_DIR);
  const { consolidate } = partitionHistoryFilesForRetention(files, new Date(), RETENTION_DAYS);

  if (consolidate.length === 0) {
    console.log(`[prune-audience-history] nenhum snapshot mais antigo que ${RETENTION_DAYS} dias — nada a consolidar.`);
    return;
  }

  const consolidatedContent = existsSync(CONSOLIDATED_PATH) ? readFileSync(CONSOLIDATED_PATH, "utf8") : "";

  let consolidated = 0;
  let skippedAlreadyDone = 0;

  for (const file of consolidate) {
    const marker = consolidatedMarkerFor(file);
    if (consolidatedContent.includes(marker)) {
      // Já consolidado numa rodada anterior — só apaga o individual se ainda existir (rerun parcial).
      skippedAlreadyDone++;
      if (!dryRun) {
        const filePath = resolve(HISTORY_DIR, file);
        if (existsSync(filePath)) rmSync(filePath);
      }
      continue;
    }

    const filePath = resolve(HISTORY_DIR, file);
    const content = readFileSync(filePath, "utf8");
    const entry = buildConsolidatedEntry(file, content);

    if (dryRun) {
      console.log(`[prune-audience-history] (dry-run) consolidaria ${file} → ${CONSOLIDATED_FILENAME} e removeria o individual`);
    } else {
      mkdirSync(HISTORY_DIR, { recursive: true });
      appendFileSync(CONSOLIDATED_PATH, entry, "utf8");
      rmSync(filePath);
    }
    consolidated++;
  }

  console.log(
    `[prune-audience-history] ${consolidated} snapshot(s) consolidado(s)${skippedAlreadyDone > 0 ? `, ${skippedAlreadyDone} já consolidado(s) anteriormente (individual removido)` : ""}${dryRun ? " [dry-run — nada gravado]" : ` → ${CONSOLIDATED_PATH}`}`,
  );
}

if (isMainModule(import.meta.url)) {
  const dryRun = process.argv.includes("--dry-run");
  run(dryRun);
}
