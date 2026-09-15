/**
 * gen-apoiar-page.ts (#7915)
 *
 * Gera `workers/site/public/apoiar/index.html` a partir de
 * `scripts/lib/site-apoiar-page.ts` — mesmo padrão de `gen-assinar-page.ts`
 * (#7015). Página inteiramente estática (sem dado de request/edição), então
 * sem flags além de `--out`.
 *
 * Uso:
 *   npx tsx scripts/gen-apoiar-page.ts [--out workers/site/public/apoiar/index.html]
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { buildApoiarHtml } from "./lib/site-apoiar-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_PATH = resolve(ROOT, "workers", "site", "public", "apoiar", "index.html");

function main() {
  const { values } = parseArgs(process.argv.slice(2));
  const outPath = values["out"] ? resolve(ROOT, values["out"]) : DEFAULT_OUT_PATH;

  const html = buildApoiarHtml();
  writeFileSync(outPath, html, "utf8");

  console.log(`gen-apoiar-page: ${outPath} escrito`);
}

if (isMainModule(import.meta.url)) {
  main();
}
