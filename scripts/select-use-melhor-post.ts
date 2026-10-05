/**
 * select-use-melhor-post.ts (#9568)
 *
 * Seleciona o item do 4º post social diário (o de maior `score` do USE MELHOR)
 * e reporta o estado dele pro gate. Miolo puro em `scripts/lib/use-melhor-post.ts`.
 *
 * Feature INERTE enquanto `publishing.social.use_melhor_time` não estiver
 * definido em `platform.config.json`: nesse caso o modo seleção não grava nada
 * (só imprime `{"enabled": false, ...}`) e o modo status imprime
 * "4º post desligado (use_melhor_time não definido)".
 *
 * Uso:
 *   # Stage 2 (antes do dispatch dos social agents): seleciona contra o
 *   # 01-approved-capped.json e grava _internal/use-melhor-post.json.
 *   npx tsx scripts/select-use-melhor-post.ts --edition-dir data/editions/AAMMDD/
 *
 *   # Re-seleção contra o 02-reviewed.md final (editor mexeu no USE MELHOR no gate).
 *   npx tsx scripts/select-use-melhor-post.ts --edition-dir ... --reviewed
 *
 *   # Stage 4: linha(s) do 4º post pro resumo do gate ({use_melhor_post_block}).
 *   npx tsx scripts/select-use-melhor-post.ts --edition-dir ... --status [--json]
 *
 * Exit 0 sempre (fail-soft — o 4º post nunca bloqueia a edição), exceto uso
 * errado da CLI (exit 2).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import {
  computeStage2UseMelhorPostState,
  enrichUseMelhorItem,
  describeUseMelhorPostStatus,
  loadUseMelhorPostConfigState,
  readApprovedForUseMelhor,
  renderedUseMelhorUrls,
  selectUseMelhorItem,
  useMelhorCandidatesFromApproved,
  writeUseMelhorPostState,
  type UseMelhorPostConfigState,
  type UseMelhorPostState,
} from "./lib/use-melhor-post.ts";
import { fetchSourceText } from "./fetch-source-text.ts";
import { gatherUseMelhorStatusInput } from "./lib/use-melhor-status.ts";

const ROOT = resolve(import.meta.dirname, "..");

function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

// Self-review #9572 (finding 5): o helper de I/O mudou pra `scripts/lib/use-melhor-status.ts`
// (dois consumidores além deste CLI). Re-export mantém o import antigo funcionando.
export { gatherUseMelhorStatusInput };

/**
 * Seleção. `useReviewed` = re-seleção contra o `02-reviewed.md` final.
 * Desligado → devolve o estado SEM gravar nada.
 */
export function runSelection(
  editionDir: string,
  config: UseMelhorPostConfigState,
  opts: { useReviewed?: boolean; now?: Date } = {},
): { state: UseMelhorPostState; written: string | null } {
  let state = computeStage2UseMelhorPostState(editionDir, config, opts.now);
  if (!state.enabled) return { state, written: null };
  if (opts.useReviewed) {
    const reviewed = readIfExists(resolve(editionDir, "02-reviewed.md"));
    const approved = readApprovedForUseMelhor(editionDir);
    if (reviewed !== null && approved !== null) {
      const sel = selectUseMelhorItem(useMelhorCandidatesFromApproved(approved), renderedUseMelhorUrls(reviewed));
      state = { ...state, ...sel, reason: sel.reason };
      if (sel.item) delete state.reason;
    }
  }
  return { state, written: writeUseMelhorPostState(editionDir, state) };
}

/**
 * #9585: seleção + corpo/passos da fonte no item gravado. Fail-soft — fetch
 * falho mantém o item sem `steps`/`body` (post no formato atual).
 */
export async function runSelectionWithSteps(
  editionDir: string,
  config: UseMelhorPostConfigState,
  opts: { useReviewed?: boolean; now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<{ state: UseMelhorPostState; written: string | null }> {
  const res = runSelection(editionDir, config, opts);
  if (!res.state.enabled || !res.state.item) return res;
  try {
    const r = await fetchSourceText(res.state.item.url, opts.fetchImpl ?? fetch);
    if (!r.ok) {
      console.error(`select-use-melhor-post: fonte sem corpo (${r.message}) — item sem passos`);
      return res;
    }
    const state = { ...res.state, item: enrichUseMelhorItem(res.state.item, r.text) };
    return { state, written: writeUseMelhorPostState(editionDir, state) };
  } catch (e) {
    console.error(`select-use-melhor-post: erro ao buscar a fonte (${(e as Error).message}) — item sem passos`);
    return res;
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const editionDir = args.values["edition-dir"];
  if (!editionDir) {
    console.error("uso: select-use-melhor-post.ts --edition-dir <dir> [--reviewed] [--status [--json]]");
    process.exit(2);
  }
  const config = loadUseMelhorPostConfigState(ROOT);

  if (args.flags.has("status")) {
    const status = describeUseMelhorPostStatus(gatherUseMelhorStatusInput(editionDir, config));
    if (args.flags.has("json")) console.log(JSON.stringify(status, null, 2));
    else console.log(status.lines.join("\n"));
    return;
  }

  const { state, written } = await runSelectionWithSteps(editionDir, config, { useReviewed: args.flags.has("reviewed") });
  console.log(JSON.stringify({ ...state, path: written }, null, 2));
}

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (e) {
    // Fail-soft (#9568): o 4º post nunca derruba o stage. O erro aparece no
    // stderr e o orchestrator segue sem o 4º post.
    console.error(`select-use-melhor-post: erro — ${(e as Error).message} (4º post pulado)`);
    console.log(JSON.stringify({ enabled: false, item: null, reason: `erro: ${(e as Error).message}` }));
  }
}
