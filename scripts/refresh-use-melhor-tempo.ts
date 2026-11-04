/**
 * refresh-use-melhor-tempo.ts (#10765) — roda no Stage 4, ANTES de
 * `check-invariants --stage 4`: mede o tempo dos itens USE MELHOR sem medição
 * fresca (inseridos à mão no gate ou com "(N min)" alterado) e registra em
 * `_internal/use-melhor-tempo-source.json`. Com --write, aplica tempos medidos em 02-reviewed.md.
 * Uso: npx tsx scripts/refresh-use-melhor-tempo.ts --edition-dir <dir> [--write]
 * Fail-soft: exit 0 em falha de rede (a divergência vira warning no check).
 */
import { parseArgsWithTrueDefault, isMainModule } from "./lib/cli-args.ts";
import { refreshUseMelhorTempo } from "./lib/use-melhor-tempo-refresh.ts";
import { fetchBodyForCache } from "./stitch-newsletter.ts";

if (isMainModule(import.meta.url)) {
  const args = parseArgsWithTrueDefault(process.argv.slice(2));
  const dir = args["edition-dir"];
  if (!dir) {
    console.error("Uso: refresh-use-melhor-tempo.ts --edition-dir <dir> [--write]");
    process.exit(2);
  }
  refreshUseMelhorTempo(dir, fetchBodyForCache, { write: args.write === "true" })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => console.error(`refresh-use-melhor-tempo: ${(e as Error).message}`))
    .finally(() => process.exit(0));
}
