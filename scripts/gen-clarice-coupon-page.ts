/**
 * gen-clarice-coupon-page.ts (#8338)
 *
 * Gera `workers/site/public/clarice/index.html` a partir de
 * `scripts/lib/site-clarice-coupon-page.ts` — mesmo padrão de
 * `gen-apoiar-page.ts` (#7915). Página inteiramente estática (sem dado de
 * request/edição), então sem flags além de `--out`.
 *
 * Uso:
 *   npx tsx scripts/gen-clarice-coupon-page.ts [--out workers/site/public/clarice/index.html]
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { buildClariceCouponHtml } from "./lib/site-clarice-coupon-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_PATH = resolve(ROOT, "workers", "site", "public", "clarice", "index.html");

function main() {
  const { values } = parseArgs(process.argv.slice(2));
  const outPath = values["out"] ? resolve(ROOT, values["out"]) : DEFAULT_OUT_PATH;

  const html = buildClariceCouponHtml();
  writeFileSync(outPath, html, "utf8");

  console.log(`gen-clarice-coupon-page: ${outPath} escrito`);
}

if (isMainModule(import.meta.url)) {
  main();
}
