/**
 * find-last-edition-with-fb.ts
 *
 * Encontra o diretório da edição mais recente **antes** da atual que tenha
 * `06-social-published.json` — usado pelo orchestrator Stage 0 pra chamar
 * verify-facebook-posts sobre posts agendados pendentes (#78 gap 2).
 *
 * Uso:
 *   npx tsx scripts/find-last-edition-with-fb.ts --current AAMMDD
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

export function findLastEditionWithFb(
  editionsDir: string,
  current: string,
): string | null {
  if (!existsSync(editionsDir)) return null;
  // #2463: enumera ambos os layouts (flat legado + nested novo) — a edição
  // pode estar em qualquer um dos 2 dependendo de quando foi criada.
  const found = enumerateEditionDirs(editionsDir);
  const dirs = [...found.keys()]
    .filter((d) => d < current)
    .sort()
    .reverse();
  for (const d of dirs) {
    const editionPath = found.get(d)!;
    const publishedPath = resolve(editionPath, "06-social-published.json");
    if (existsSync(publishedPath)) {
      // Path simbólico `data/editions/{...}` — mesma convenção do
      // comportamento anterior (o prefixo `data/editions` é sempre fixo,
      // independente de onde `editionsDir` fisicamente mora no disco em
      // testes). Nested vs flat é decidido pelo nome do diretório pai
      // encontrado (`{AAMM}`), não montado à mão a partir só do AAMMDD.
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
    console.error("Uso: find-last-edition-with-fb.ts --current AAMMDD");
    process.exit(1);
  }
  const editionsDir = resolve(ROOT, editionsRoot());
  const result = findLastEditionWithFb(editionsDir, current);
  process.stdout.write(result ?? "");
}

if (isMainModule(import.meta.url)) {
  main();
}
