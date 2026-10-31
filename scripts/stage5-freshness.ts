/**
 * stage5-freshness.ts (#11698) — CLI. Exit 0 = fresca; exit 4 = possivelmente
 * defasada (fail-closed; stdout JSON com os problemas). Somente leitura.
 *   npx tsx scripts/stage5-freshness.ts --edition-dir DIR [--accept-newer]
 *   --accept-newer: editor confirma edição pós-gate; ignora o teste de mtime e a
 *   divergência de sha256 (ausente/vazio/conflito continuam bloqueando).
 */
import { resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { checkStage5Freshness } from "./lib/stage5-freshness.ts";

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (!values["edition-dir"]) {
    console.error("Uso: stage5-freshness.ts --edition-dir DIR");
    process.exit(2);
  }
  let r: ReturnType<typeof checkStage5Freshness>;
  try {
    r = checkStage5Freshness(resolve(values["edition-dir"]), {
      acceptNewer: flags.has("accept-newer") || values["accept-newer"] === "true",
    });
  } catch (e) {
    // Fail-closed: arquivo sumindo no meio do sync/placeholder do OneDrive vira exit 4, nunca exceção solta.
    r = { ok: false, problems: [`erro ao ler a edição: ${e instanceof Error ? e.message : String(e)}`] };
  }
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 4);
}
