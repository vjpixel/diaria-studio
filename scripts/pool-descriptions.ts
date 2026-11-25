/**
 * pool-descriptions.ts (#13884) — descrição dos itens de pool escrita a partir
 * do texto lido da página. Dois modos, em volta do agent `writer-pool`
 * (Stage 2, logo depois do `stitch-newsletter.ts`):
 *
 *   --input  → grava `_internal/02-pool-descriptions-input.json` com os itens do
 *              `02-draft.md` cuja página foi baixada (`_internal/pool-sources/`),
 *              o caminho do texto e a descrição atual. Stdout JSON
 *              `{ input_path, items, skipped }`. `items: 0` = nada para o agent.
 *   --apply  → lê `_internal/02-pool-descriptions.json` (output do agent), troca
 *              a descrição de cada item no `02-draft.md`, registra as URLs em
 *              `pool-sources/descriptions-applied.json`. Stdout JSON
 *              `{ applied, rejected }`. Exit 0 mesmo com rejeições: o item
 *              rejeitado fica com a descrição do `summary` e o `source-not-read`
 *              do gate 4 o julga pela regra do resumo.
 *
 * Uso:
 *   npx tsx scripts/pool-descriptions.ts --input --edition-dir {EDITION_DIR}/
 *   npx tsx scripts/pool-descriptions.ts --apply --edition-dir {EDITION_DIR}/
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import {
  POOL_DESCRIPTIONS_INPUT,
  POOL_DESCRIPTIONS_OUTPUT,
  applyPoolDescriptions,
  buildPoolDescriptionsInput,
  readPoolDescriptionsOutput,
  recordPoolDescriptionsApplied,
  type PoolDescriptionsInput,
} from "./lib/diaria/pool-descriptions.ts";

const USAGE = "Uso: pool-descriptions.ts (--input | --apply) --edition-dir data/editions/AAMM/AAMMDD/";

export function runInput(editionDir: string): { input_path: string; items: number; skipped: PoolDescriptionsInput["skipped"] } {
  const internal = join(editionDir, "_internal");
  const draftPath = join(internal, "02-draft.md");
  if (!existsSync(draftPath)) throw new Error(`${draftPath} ausente: rodar stitch-newsletter.ts antes`);
  const input = buildPoolDescriptionsInput(internal, draftPath, readFileSync(draftPath, "utf8"));
  const inputPath = join(internal, POOL_DESCRIPTIONS_INPUT);
  writeFileSync(inputPath, JSON.stringify(input, null, 2), "utf8");
  return { input_path: inputPath, items: input.items.length, skipped: input.skipped };
}

export function runApply(editionDir: string): { applied: string[]; rejected: Array<{ url: string; reason: string }>; record_path: string | null } {
  const internal = join(editionDir, "_internal");
  const inputPath = join(internal, POOL_DESCRIPTIONS_INPUT);
  const outPath = join(internal, POOL_DESCRIPTIONS_OUTPUT);
  const draftPath = join(internal, "02-draft.md");
  for (const p of [inputPath, outPath, draftPath]) {
    if (!existsSync(p)) throw new Error(`${p} ausente`);
  }
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as PoolDescriptionsInput;
  const r = applyPoolDescriptions(readFileSync(draftPath, "utf8"), input, readPoolDescriptionsOutput(outPath));
  if (r.applied.length > 0) writeFileSync(draftPath, r.md, "utf8");
  const record = r.applied.length > 0 ? recordPoolDescriptionsApplied(internal, input, r.applied.map((a) => a.url)) : null;
  for (const x of r.rejected) console.error(`pool-descriptions: WARN — descrição rejeitada (${x.reason}): ${x.url}`);
  return { applied: r.applied.map((a) => a.url), rejected: r.rejected, record_path: record };
}

async function main(): Promise<number | void> {
  const { values: args, flags } = parseArgs(process.argv.slice(2));
  const mode = flags.has("input") ? "input" : flags.has("apply") ? "apply" : null;
  if (!args["edition-dir"] || !mode || (flags.has("input") && flags.has("apply"))) {
    console.error(USAGE);
    return 1;
  }
  const dir = resolve(process.cwd(), args["edition-dir"]);
  const out = mode === "input" ? runInput(dir) : runApply(dir);
  console.log(JSON.stringify(out, null, 2));
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error(`pool-descriptions: ${(e as Error).message}`) });
}
