/**
 * gen-assinar-page.ts (#7015)
 *
 * Gera `workers/site/public/assinar/index.html` a partir de
 * `scripts/lib/site-assinar-page.ts` — mesmo padrão de `gen-home-page.ts`
 * (#6375). Página inteiramente estática (sem dado de request/edição), então
 * sem flags além de `--out`.
 *
 * Uso:
 *   npx tsx scripts/gen-assinar-page.ts [--out workers/site/public/assinar/index.html]
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { buildAssinarHtml } from "./lib/site-assinar-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_PATH = resolve(ROOT, "workers", "site", "public", "assinar", "index.html");

function main() {
  const { values } = parseArgs(process.argv.slice(2));
  const outPath = values["out"] ? resolve(ROOT, values["out"]) : DEFAULT_OUT_PATH;

  const html = buildAssinarHtml();
  writeFileSync(outPath, html, "utf8");

  console.log(`gen-assinar-page: ${outPath} escrito`);
}

if (isMainModule(import.meta.url)) {
  main();
}
