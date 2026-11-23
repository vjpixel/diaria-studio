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
 * Uso: npx tsx scripts/refresh-use-melhor-post.ts --edition-dir data/editions/AAMMDD/ [--force | --url <url>] [--json] | --done
 * `--url <url>` (sinônimo `--pick`, #13849): o editor escolhe o item do 4º post
 * (qualquer item do USE MELHOR final). URL fora do USE MELHOR → exit 2, nada gravado.
 * (--done limpa a pendência gravada em _internal/use-melhor-refresh-pending.json)
 * Exit 0 sempre (fail-soft, como o select), exceto uso errado (2).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { loadUseMelhorPostConfigState, readUseMelhorPostState } from "./lib/use-melhor-post.ts";
import { gatherUseMelhorStatusInput } from "./lib/use-melhor-status.ts";
import { buildUseMelhorRefreshPlan } from "./lib/use-melhor-refresh-plan.ts";
import { PickError, pickIgnoredWarning, runSelectionWithSteps } from "./select-use-melhor-post.ts";

const PENDING_REL = "_internal/use-melhor-refresh-pending.json";

const ROOT = resolve(import.meta.dirname, "..");

async function main(): Promise<number | void> {
  const args = parseCliArgs(process.argv.slice(2));
  const editionDir = args.values["edition-dir"];
  if (!editionDir) {
    console.error("uso: refresh-use-melhor-post.ts --edition-dir <dir> [--force | --url <url>] [--json]");
    return 2;
  }
  const pickUrl = args.values["url"] ?? args.values["pick"];
  if ((args.flags.has("url") || args.flags.has("pick") || pickUrl === "") && !pickUrl) {
    console.error("refresh-use-melhor-post: --url/--pick exige a URL do item do USE MELHOR");
    return 2;
  }
  const pendingAbs = resolve(editionDir, PENDING_REL);
  if (args.flags.has("done")) {
    rmSync(pendingAbs, { force: true });
    console.log("pendência do 4º post limpa");
    return;
  }
  const config = loadUseMelhorPostConfigState(ROOT, basename(resolve(editionDir)));
  const previous = config.enabled ? readUseMelhorPostState(editionDir) : null;
  try {
    const { state } = await runSelectionWithSteps(editionDir, config, {
      useReviewed: true,
      forceReselect: args.flags.has("force"),
      pickUrl,
    });
    const ignoredPick = pickIgnoredWarning(pickUrl, state);
    if (ignoredPick) console.error(`refresh-use-melhor-post: ${ignoredPick}`);
  } catch (e) {
    if (e instanceof PickError) {
      console.error(`refresh-use-melhor-post: --url recusado — ${e.message}. Nada gravado.`);
      return 2;
    }
    throw e;
  }
  const statusConfig = loadUseMelhorPostConfigState(ROOT, basename(resolve(editionDir)));
  const status = gatherUseMelhorStatusInput(editionDir, statusConfig);
  let pendingUrl: string | null = null;
  if (existsSync(pendingAbs)) {
    try {
      pendingUrl = JSON.parse(readFileSync(pendingAbs, "utf8")).url ?? null;
    } catch {
      pendingUrl = null;
    }
  }
  const plan = buildUseMelhorRefreshPlan({ previousUrl: previous?.item?.url ?? null, pendingUrl, status }, editionDir);
  const itemUrl = status.state?.item?.url;
  if (plan.rewrite_text && itemUrl) {
    mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
    writeFileSync(pendingAbs, JSON.stringify({ url: itemUrl }), "utf8");
  }
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
