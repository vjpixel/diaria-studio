/**
 * find-last-edition-with-kit.ts
 *
 * Encontra o diretório da edição mais recente **antes** da atual que tenha
 * `_internal/kit-diaria-published.json` (broadcast do canal Kit paralelo
 * despachado) — mesmo padrão de `find-last-edition-with-fb.ts`, usado pelo
 * passo 0m do Stage 0 (#7021, rampa Gmail) pra localizar a edição cujo
 * broadcast Kit já maturou o suficiente pra medir entrega por provedor
 * (`kit-provider-split.ts --edition`).
 *
 * Uso:
 *   npx tsx scripts/find-last-edition-with-kit.ts --current AAMMDD
 *
 * Output (stdout): caminho relativo do diretório (ex: `data/editions/260423`)
 * ou string vazia se nada encontrado.
 *
 * Exit code: 0 sempre (não bloqueia pipeline). Escrever path em stdout.
 */

import { existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { editionsRoot } from "./lib/edition-paths.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { kitDiariaPublishedPath } from "./kit-provider-split.ts";

export function findLastEditionWithKit(
  editionsDir: string,
  current: string,
): string | null {
  if (!existsSync(editionsDir)) return null;
  const found = enumerateEditionDirs(editionsDir);
  const dirs = [...found.keys()]
    .filter((d) => d < current)
    .sort()
    .reverse();
  for (const d of dirs) {
    const editionPath = found.get(d)!;
    if (existsSync(kitDiariaPublishedPath(editionPath))) {
      const parentName = basename(dirname(editionPath));
      const isNested = parentName === d.slice(0, 4);
      return isNested ? `data/editions/${parentName}/${d}` : `data/editions/${d}`;
    }
  }
  return null;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const current = args.current;
  if (!current || !/^\d{6}$/.test(current)) {
    console.error("Uso: find-last-edition-with-kit.ts --current AAMMDD");
    process.exit(1);
  }
  const editionsDir = resolve(ROOT, editionsRoot());
  const result = findLastEditionWithKit(editionsDir, current);
  process.stdout.write(result ?? "");
}

if (isMainModule(import.meta.url)) {
  main();
}
