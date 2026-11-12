/**
 * publish-schedule-table.ts (#12748)
 *
 * Imprime a tabela de horários da edição (Rede × Use Melhor/D1/D2/D3/Vertical)
 * que fecha o relato do `/diaria-publica`, com os avisos de espaçamento por
 * conta (2 h, #10819) contando o vertical e o 4º post do perfil pessoal do
 * LinkedIn (`06-linkedin-personal.json`, #9568). Só lê; não agenda nada.
 *
 * Uso:
 *   npx tsx scripts/publish-schedule-table.ts {AAMMDD} [--edition-dir DIR] [--json]
 *
 * Exit: 0 tabela sem aviso; 1 tabela com aviso de espaçamento; 2 uso/leitura.
 * Store ausente vira tabela sem aquelas células (o vertical ainda não
 * registrado sai com o horário configurado, `previsto`); store ilegível é erro.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMainModule } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { buildScheduleTable, renderScheduleTableMarkdown } from "./lib/diaria/publish-schedule-table.ts";
import { listShortsRegistryFiles, readShortsRegistry } from "./lib/diaria/shorts-published-store.ts";

const ROOT = resolve(import.meta.dirname, "..");

function readJsonIfPresent(dir: string, name: string): unknown {
  for (const p of [join(dir, "_internal", name), join(dir, name)]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  return null;
}

/**
 * #12893: os stores que a tabela lê. O registro do vertical é a visão UNIDA
 * (`readShortsRegistry`): o principal mais os registros dos timers do 300
 * (Instagram, LinkedIn e Threads pessoais) e as cópias de conflito. Ler só o
 * `06-shorts-published.json` deixava esses destinos como "previsto" depois de
 * publicados, com o aviso de 2 h calculado sobre o horário do config.
 * Sem nenhum arquivo do registro em `_internal/`, cai no legado da raiz.
 */
export function readScheduleTableStores(dir: string, aammdd: string): { social: unknown; shorts: unknown; linkedinPersonal: unknown } {
  return {
    social: readJsonIfPresent(dir, "06-social-published.json"),
    shorts: listShortsRegistryFiles(dir).length ? readShortsRegistry(dir, aammdd) : readJsonIfPresent(dir, "06-shorts-published.json"),
    linkedinPersonal: readJsonIfPresent(dir, "06-linkedin-personal.json"),
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const aammdd = argv.find((a) => /^\d{6}$/.test(a));
  if (!aammdd) {
    console.error("Uso: publish-schedule-table.ts {AAMMDD} [--edition-dir DIR] [--json]");
    process.exit(2);
  }
  const i = argv.indexOf("--edition-dir");
  const dir = i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : resolve(ROOT, editionDir(aammdd));
  try {
    const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
    const table = buildScheduleTable({ aammdd, config, ...readScheduleTableStores(dir, aammdd) });
    if (argv.includes("--json")) process.stdout.write(JSON.stringify(table, null, 2) + "\n");
    else process.stdout.write(renderScheduleTableMarkdown(table) + "\n");
    process.exit(table.warnings.length ? 1 : 0);
  } catch (e) {
    console.error(`[publish-schedule-table] ${(e as Error).message}`);
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
