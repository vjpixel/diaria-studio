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

import { existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function findLastEditionWithFb(
  editionsDir: string,
  current: string,
): string | null {
  if (!existsSync(editionsDir)) return null;
  let dirs: string[];
  try {
    dirs = readdirSync(editionsDir)
      .filter((d) => /^\d{6}$/.test(d) && d < current)
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const d of dirs) {
    const publishedPath = resolve(editionsDir, d, "06-social-published.json");
    if (existsSync(publishedPath)) {
      return `data/editions/${d}`;
    }
  }
  return null;
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
  const current = args.current;
  if (!current || !/^\d{6}$/.test(current)) {
    console.error("Uso: find-last-edition-with-fb.ts --current AAMMDD");
    process.exit(1);
  }
  const editionsDir = resolve(ROOT, "data/editions");
  const result = findLastEditionWithFb(editionsDir, current);
  process.stdout.write(result ?? "");
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
