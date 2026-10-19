/**
 * refresh-use-melhor-post.ts (#10469)
 *
 * Comando único pro editor mexer no USE MELHOR no gate 4: re-seleciona o item
 * do 4º post contra o `02-reviewed.md` (preserva o escolhido se ele segue
 * renderizado, #9610), compara com o que estava gravado e imprime o plano do
 * que falta refazer (texto `## um`, carrossel de N slides, preview) com os
 * comandos exatos. Idempotente: rodar de novo sem mudança → plano vazio.
 *
 * Só a re-seleção grava (`_internal/use-melhor-post.json`); social-writer /
 * social-curto / humanizador são agents/skills — ficam como passos do plano.
 *
 * Uso: npx tsx scripts/refresh-use-melhor-post.ts --edition-dir data/editions/AAMMDD/ [--force] [--json]
 * Exit 0 sempre (fail-soft, como o select), exceto uso errado (2).
 */

import { basename, resolve } from "node:path";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { loadUseMelhorPostConfigState, readUseMelhorPostState } from "./lib/use-melhor-post.ts";
import { gatherUseMelhorStatusInput } from "./lib/use-melhor-status.ts";
import { buildUseMelhorRefreshPlan } from "./lib/use-melhor-refresh-plan.ts";
import { runSelectionWithSteps } from "./select-use-melhor-post.ts";

const ROOT = resolve(import.meta.dirname, "..");

async function main(): Promise<number | void> {
  const args = parseCliArgs(process.argv.slice(2));
  const editionDir = args.values["edition-dir"];
  if (!editionDir) {
    console.error("uso: refresh-use-melhor-post.ts --edition-dir <dir> [--force] [--json]");
    return 2;
  }
  const config = loadUseMelhorPostConfigState(ROOT);
  const previous = config.enabled ? readUseMelhorPostState(editionDir) : null;
  await runSelectionWithSteps(editionDir, config, {
    useReviewed: true,
    forceReselect: args.flags.has("force"),
  });
  const statusConfig = loadUseMelhorPostConfigState(ROOT, basename(resolve(editionDir)));
  const status = gatherUseMelhorStatusInput(editionDir, statusConfig);
  const plan = buildUseMelhorRefreshPlan({ previousUrl: previous?.item?.url ?? null, status }, editionDir);
  if (args.flags.has("json")) console.log(JSON.stringify(plan, null, 2));
  else console.log([...plan.reasons.map((r) => `- ${r}`), ...plan.steps].join("\n"));
}

if (isMainModule(import.meta.url)) {
  try {
    const code = await main();
    if (typeof code === "number") process.exitCode = code;
  } catch (e) {
    console.error(`refresh-use-melhor-post: erro — ${(e as Error).message}`);
  }
}
