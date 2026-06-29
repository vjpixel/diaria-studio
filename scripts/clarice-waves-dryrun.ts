#!/usr/bin/env node
/**
 * clarice-waves-dryrun.ts — CLI do dry-run comparativo do cutover de waves
 * (#2656). READ-ONLY: lê o store único (#2647), compara o método atual de
 * targeting (exclui só blacklisted) com o modelo store-driven (send_eligible +
 * segmentFromStore) e imprime um relatório. NÃO dispara, NÃO faz fetch ao vivo,
 * NÃO escreve no Brevo/KV.
 *
 * Uso:
 *   npx tsx scripts/clarice-waves-dryrun.ts [--db <path>] [--out <file.md>] [--json]
 *   --out: grava o relatório markdown num arquivo (default: só stdout).
 *   --json: imprime o relatório como JSON em vez de markdown.
 */

import { writeFileSync } from "node:fs";
import {
  computeWavesDryrun,
  renderDryrunMarkdown,
  type DryrunRow,
} from "./lib/clarice-waves-dryrun.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { getArg, hasFlag } from "./lib/cli-args.ts";

export function main(argv: string[] = process.argv.slice(2)): void {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const out = getArg(argv, "out");
  const asJson = hasFlag(argv, "json");

  const db = openClariceDb(dbPath);
  const rows = db
    .prepare(
      `SELECT email, tier, priority_points, send_eligible, ineligible_reason,
              sends_count, opens_count, email_blacklisted,
              CASE WHEN brevo_list_ids IS NOT NULL THEN 1 ELSE 0 END AS in_brevo
         FROM clarice_users`,
    )
    .all() as unknown as DryrunRow[];
  db.close();

  // Guard: store vazio/ausente NÃO pode passar por "sem divergências = seguro".
  // openClariceDb cria o schema se o path for novo → 0 linhas seria silencioso.
  if (rows.length === 0) {
    console.error(
      `❌ store vazio (0 contatos) em ${dbPath} — rode clarice-build-db.ts + ` +
        `clarice-sync-brevo.ts antes. Validar o cutover com store vazio é inútil.`,
    );
    process.exit(1);
  }

  const report = computeWavesDryrun(rows);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const md = renderDryrunMarkdown(report);
  if (out) {
    writeFileSync(out, md, "utf8");
    console.error(
      `[clarice-waves-dryrun] relatório gravado em ${out}\n` +
        `⚠️  CONTÉM EMAILS (PII) na amostra de spot-check — NÃO commitar/subir. ` +
        `Grave em data/ (gitignored) ou apague após revisar.`,
    );
  }
  console.log(md);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main();
}
