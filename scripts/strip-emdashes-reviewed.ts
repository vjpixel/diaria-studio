/**
 * #9379: o humanizador/Clarice rodam DEPOIS do `removeEmdashes` do normalize e
 * reintroduzem travessão. Este passo roda a mesma rede de segurança sobre o
 * `02-reviewed.md` (pós-Clarice, pré-gate). Idempotente; exit 0 sempre que o
 * arquivo existir.
 *
 * Uso: npx tsx scripts/strip-emdashes-reviewed.ts --edition-dir data/editions/AAMMDD/
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { removeEmdashes } from "./normalize-newsletter.ts";
import { isMainModule } from "./lib/cli-args.ts";

export function stripEmdashesInFile(path: string): { changed: boolean; count: number } {
  const text = readFileSync(path, "utf8");
  const r = removeEmdashes(text);
  if (r.count > 0) writeFileSync(path, r.text, "utf8");
  return { changed: r.count > 0, count: r.count };
}

function main(): void {
  const i = process.argv.indexOf("--edition-dir");
  const dir = i >= 0 ? process.argv[i + 1] : undefined;
  if (!dir) {
    console.error("Uso: strip-emdashes-reviewed.ts --edition-dir <dir>");
    process.exit(1);
  }
  const path = resolve(dir, "02-reviewed.md");
  if (!existsSync(path)) {
    console.error(`02-reviewed.md ausente em ${dir}`);
    process.exit(3);
  }
  const r = stripEmdashesInFile(path);
  console.log(JSON.stringify({ file: path, ...r }));
}

if (isMainModule(import.meta.url)) main();
