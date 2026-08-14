/**
 * seed-spend-csv.ts (#5236 Parte 1)
 *
 * Escreve o seed inicial de `data/aquisicao/spend.csv` (as 3 linhas do
 * histórico de gasto conhecido em 260814 — ver `SPEND_SEED_ROWS` em
 * `scripts/lib/aquisicao-spend.ts` pra rationale de `mes`/`fonte`).
 *
 * **Por que este script existe em vez de o CSV já vir committed:** `data/`
 * é uma junction OneDrive local (`.gitignore` blanket — nada ali vai pro
 * repo, ver CLAUDE.md § Setup passo 2b). Rodar este script é a AÇÃO LOCAL
 * equivalente a "criar o arquivo" quando não há como versionar o arquivo em
 * si — mesma categoria dos scripts `setup-*-schedule-systemd.ts` que
 * precisam rodar na checkout compartilhada, não no worktree isolado de uma
 * sessão overnight/develop.
 *
 * Idempotente: recusa sobrescrever um `spend.csv` já existente sem
 * `--force` — o editor pode já ter editado o arquivo com gasto real
 * atualizado, e este script nunca deveria apagar isso silenciosamente.
 *
 * ## Uso
 *
 *   npx tsx scripts/seed-spend-csv.ts
 *   npx tsx scripts/seed-spend-csv.ts --force
 *   npx tsx scripts/seed-spend-csv.ts --out /caminho/alternativo/spend.csv
 *
 * Exit codes: 0 = escrito (ou já existia e não usou --force, ver stderr);
 * 1 = já existia sem --force (nada escrito).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, hasFlag, getStringArg } from "./lib/cli-args.ts";
import { SPEND_SEED_ROWS, formatSpendCsv } from "./lib/aquisicao-spend.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SPEND_CSV_PATH = resolve(ROOT, "data", "aquisicao", "spend.csv");

export function main(argv: string[] = process.argv.slice(2)): void {
  const outPath = getStringArg(argv, "out") ?? DEFAULT_SPEND_CSV_PATH;
  const force = hasFlag(argv, "force");

  if (existsSync(outPath) && !force) {
    console.error(
      `[seed-spend-csv] ${outPath} já existe — nada feito (use --force pra sobrescrever; o editor pode já ter editado este arquivo).`,
    );
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, formatSpendCsv(SPEND_SEED_ROWS), "utf8");
  console.error(`[seed-spend-csv] seed escrito em ${outPath} (${SPEND_SEED_ROWS.length} linhas).`);
}

if (isMainModule(import.meta.url)) {
  main();
}
