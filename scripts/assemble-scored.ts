/**
 * assemble-scored.ts (#1611)
 *
 * Etapa 5 (final) do scorer chunked-parallel. Combina:
 *   - a seleção do agent `scorer-select` (`highlights[]` + `runners_up[]` sobre
 *     os finalistas), e
 *   - o `all_scored[]` completo do merge-scored-chunks,
 * no arquivo `tmp-scored.json` — o MESMO contrato que o scorer single-call
 * produzia e que `finalize-stage1.ts` (passo 1s) consome.
 *
 * Por que separar: a seleção é a única parte que precisa de julgamento holístico
 * (top-6 + ordem + diversidade), feita por 1 agent pequeno sobre ~15 finalistas.
 * O all_scored é determinístico (vem do merge). Assemblar em TS evita pedir pro
 * agent copiar o array grande de all_scored verbatim (risco de corrupção #720).
 *
 * Uso:
 *   npx tsx scripts/assemble-scored.ts \
 *     --selection data/editions/{AAMMDD}/_internal/tmp-selection.json \
 *     --allscored data/editions/{AAMMDD}/_internal/tmp-allscored.json \
 *     --out data/editions/{AAMMDD}/_internal/tmp-scored.json
 *
 * Output stdout: JSON { highlights, runners_up, all_scored } counts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ScorePair } from "./merge-scored-chunks.ts";
import { parseArgsWithTrueDefault as parseArgs } from "./lib/cli-args.ts"; // #2834

const ROOT = resolve(import.meta.dirname, "..");

export interface Highlight {
  rank?: number;
  score?: number;
  bucket?: string;
  reason?: string;
  article?: Record<string, unknown>;
  url?: string;
  [key: string]: unknown;
}

export interface Selection {
  highlights?: Highlight[];
  runners_up?: Highlight[];
  warning_pool_too_small?: boolean;
}

export interface AllScoredFile {
  all_scored?: ScorePair[];
}

export interface AssembledOutput {
  highlights: Highlight[];
  runners_up: Highlight[];
  all_scored: ScorePair[];
  warning_pool_too_small?: boolean;
}

/**
 * Re-numera ranks de highlights 1..N (a seleção pode vir desordenada/sem rank).
 * Preserva a ORDEM do array (= ordem editorial decidida pelo agent).
 */
export function assemble(selection: Selection, allScored: AllScoredFile): AssembledOutput {
  const highlights = (selection.highlights ?? []).map((h, i) => ({ ...h, rank: i + 1 }));
  const out: AssembledOutput = {
    highlights,
    runners_up: selection.runners_up ?? [],
    all_scored: allScored.all_scored ?? [],
  };
  if (selection.warning_pool_too_small) out.warning_pool_too_small = true;
  return out;
}


export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const selectionPath = args.selection;
  const allscoredPath = args.allscored;
  const outPath = args.out;

  if (!selectionPath || !allscoredPath || !outPath) {
    console.error(
      "Uso: assemble-scored.ts --selection <tmp-selection.json> --allscored <tmp-allscored.json> --out <tmp-scored.json>",
    );
    process.exit(1);
  }

  const selection: Selection = JSON.parse(readFileSync(resolve(ROOT, selectionPath), "utf8"));
  const allScored: AllScoredFile = JSON.parse(readFileSync(resolve(ROOT, allscoredPath), "utf8"));

  const assembled = assemble(selection, allScored);
  writeFileSync(resolve(ROOT, outPath), JSON.stringify(assembled, null, 2), "utf8");

  process.stdout.write(
    JSON.stringify({
      highlights: assembled.highlights.length,
      runners_up: assembled.runners_up.length,
      all_scored: assembled.all_scored.length,
    }) + "\n",
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
const _importMeta = import.meta.url;
if (
  _importMeta === `file://${_argv1}` ||
  _importMeta === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
