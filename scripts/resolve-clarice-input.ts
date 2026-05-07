/**
 * resolve-clarice-input.ts (#871)
 *
 * Determina qual arquivo o passo de Clarice em Stage 2 deve usar como
 * input, aplicando a fallback chain (humanizado → normalizado → draft),
 * e persiste o nome relativo em `_internal/02-clarice-input.txt`.
 *
 * Bug que motivou (#871): a path do CLARICE_INPUT era determinada UMA
 * VEZ no prompt do orchestrator (em memória do Claude), depois re-derivada
 * independentemente pelo passo de diff. Drift entre as duas determinações
 * resultava em file-not-found no diff e gate travando silenciosamente.
 *
 * Persistir em arquivo garante uma fonte de verdade única — ambos passos
 * (Clarice apply + diff) leem do mesmo lugar.
 *
 * Uso:
 *   npx tsx scripts/resolve-clarice-input.ts --edition-dir data/editions/260507/
 *
 * Output: stdout imprime o filename relativo escolhido (ex: "02-humanized.md").
 *         Grava o mesmo valor em `_internal/02-clarice-input.txt`.
 *
 * Exit codes:
 *   0 — input resolvido com sucesso
 *   1 — nenhum dos 3 arquivos da fallback chain existe (FATAL)
 */

import { existsSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FALLBACK_CHAIN = [
  "02-humanized.md",
  "02-normalized.md",
  "02-draft.md",
] as const;

function parseArgs(argv: string[]): { editionDir?: string } {
  const args: { editionDir?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--edition-dir" && i + 1 < argv.length) {
      args.editionDir = argv[i + 1];
      i++;
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.editionDir) {
    console.error("Erro: --edition-dir obrigatório.");
    process.exit(1);
  }

  const editionDir = resolve(ROOT, args.editionDir);
  const internalDir = resolve(editionDir, "_internal");

  let resolved: string | null = null;
  const checked: string[] = [];

  for (const candidate of FALLBACK_CHAIN) {
    const fullPath = resolve(internalDir, candidate);
    checked.push(candidate);
    if (!existsSync(fullPath)) continue;
    if (statSync(fullPath).size === 0) {
      console.error(`resolve-clarice-input: ${candidate} existe mas está vazio — pulando.`);
      continue;
    }
    resolved = candidate;
    break;
  }

  if (!resolved) {
    console.error(
      `resolve-clarice-input: FATAL — nenhum dos arquivos da fallback chain existe ou tem conteúdo:\n` +
        checked.map((c) => `  - ${c}`).join("\n") +
        `\n\nWriter falhou e/ou normalize falhou. Re-rodar /diaria-2-escrita {AAMMDD} newsletter.`,
    );
    process.exit(1);
  }

  // Persistir pra próxima leitura (Clarice + diff)
  const persistPath = resolve(internalDir, "02-clarice-input.txt");
  writeFileSync(persistPath, resolved + "\n", "utf8");

  console.log(resolved);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
