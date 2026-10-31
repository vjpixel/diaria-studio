/**
 * stage5-freshness.ts (#11698) — CLI. Exit 0 = fresca; exit 4 = possivelmente
 * defasada (fail-closed; stdout JSON com os problemas). Somente leitura.
 *   npx tsx scripts/stage5-freshness.ts --edition-dir DIR [--accept-newer]
 *   --accept-newer: editor confirma edição pós-gate; ignora só o teste de mtime
 *   (ausente/vazio/conflito continuam bloqueando).
 */
import { resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { checkStage5Freshness } from "./lib/stage5-freshness.ts";

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  if (!values["edition-dir"]) {
    console.error("Uso: stage5-freshness.ts --edition-dir DIR");
    process.exit(2);
  }
  const r = checkStage5Freshness(resolve(values["edition-dir"]), {
    acceptNewer: values["accept-newer"] === true || values["accept-newer"] === "true",
  });
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 4);
}
