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

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ScorePair } from "./merge-scored-chunks.ts";
import { parseArgsWithTrueDefault as parseArgs, isMainModule } from "./lib/cli-args.ts"; // #2834
import { ensureNegativeImpactHighlight, type FinalistLike } from "./lib/negative-impact-promotion.ts"; // #3916, #3918
import { demotePlaceholderTitleHighlights, type PlaceholderDemotion } from "./lib/placeholder-title-guard.ts"; // #4102

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

export interface NegativeImpactPromotion {
  promoted_url?: string;
  demoted_url?: string;
  reason?: string;
}

export interface Selection {
  highlights?: Highlight[];
  runners_up?: Highlight[];
  warning_pool_too_small?: boolean;
  // #3916/#3918: presente só quando scorer-select promoveu um candidato
  // negative_impact:true do pool de finalistas pra dentro dos 6 highlights.
  negative_impact_promoted?: NegativeImpactPromotion;
}

export interface AllScoredFile {
  all_scored?: ScorePair[];
}

export interface AssembledOutput {
  highlights: Highlight[];
  runners_up: Highlight[];
  all_scored: ScorePair[];
  warning_pool_too_small?: boolean;
  negative_impact_promoted?: NegativeImpactPromotion;
  // #4102: presente só quando o backstop demoveu ≥1 highlight com título
  // placeholder (ex: "(newsletter:...)", "(inbox)").
  placeholder_title_demoted?: PlaceholderDemotion[];
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
  if (selection.negative_impact_promoted) out.negative_impact_promoted = selection.negative_impact_promoted;
  return out;
}

/**
 * #3916/#3918: backstop determinístico — se `scorer-select` (LLM) não
 * garantiu ≥1 highlight `negative_impact:true` nem documentou uma promoção
 * própria, tenta promover deterministicamente o melhor candidato tagueado do
 * pool de `finalists`. No-op (retorna `assembled` inalterado) quando os
 * highlights já satisfazem a regra OU quando nenhum finalista tem a tag
 * (pool sem candidato digno — caso legítimo, o gate avisa).
 */
export function applyNegativeImpactBackstop(
  assembled: AssembledOutput,
  finalists: FinalistLike[],
): AssembledOutput {
  const result = ensureNegativeImpactHighlight(assembled.highlights, finalists);
  if (!result.promotion) return assembled;
  return {
    ...assembled,
    highlights: result.highlights,
    negative_impact_promoted: result.promotion,
  };
}

/**
 * #4102: backstop determinístico — nenhum highlight final pode ter título
 * placeholder (ex: "(newsletter:...)", "(inbox)"). Roda DEPOIS do backstop de
 * negative-impact (acima), como última palavra: se o candidato placeholder
 * tiver score alto O SUFICIENTE para também ser o melhor candidato
 * `negative_impact:true` do pool, `ensureNegativeImpactHighlight` poderia
 * reintroduzi-lo (ela não sabe filtrar por título) depois de este guard já
 * ter demovido — rodando por último, este guard sempre tem a palavra final.
 * Trade-off aceito: na coincidência rara de o único candidato
 * `negative_impact:true` disponível ser também o ofensor de título, a regra
 * de negative-impact (#3916/#3918, warning-only, "pool sem candidato digno" é
 * caso legítimo) cede — nunca o inverso, pois título placeholder sobrevivendo
 * a highlight é o bug visível e grave que #4102 existe para prevenir.
 */
export function applyPlaceholderTitleBackstop(
  assembled: AssembledOutput,
  finalists: FinalistLike[],
): AssembledOutput {
  const result = demotePlaceholderTitleHighlights(assembled.highlights, finalists);
  if (result.demotions.length === 0) return assembled;
  return {
    ...assembled,
    highlights: result.highlights,
    placeholder_title_demoted: result.demotions,
  };
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const selectionPath = args.selection;
  const allscoredPath = args.allscored;
  const outPath = args.out;
  const finalistsPath = args.finalists; // #3916/#3918: opcional

  if (!selectionPath || !allscoredPath || !outPath) {
    console.error(
      "Uso: assemble-scored.ts --selection <tmp-selection.json> --allscored <tmp-allscored.json> --out <tmp-scored.json> [--finalists <tmp-finalists.json>]",
    );
    process.exit(1);
  }

  const selection: Selection = JSON.parse(readFileSync(resolve(ROOT, selectionPath), "utf8"));
  const allScored: AllScoredFile = JSON.parse(readFileSync(resolve(ROOT, allscoredPath), "utf8"));

  let assembled = assemble(selection, allScored);

  // #3916/#3918: backstop determinístico — só roda quando --finalists foi
  // passado (o caminho single-call/1q-fallback não gera tmp-finalists.json;
  // nesse caso a regra depende só do prompt do scorer + do gate warning).
  if (finalistsPath && existsSync(resolve(ROOT, finalistsPath))) {
    const finalistsRaw = JSON.parse(readFileSync(resolve(ROOT, finalistsPath), "utf8"));
    const finalists: FinalistLike[] = Array.isArray(finalistsRaw)
      ? finalistsRaw
      : (finalistsRaw.finalists ?? []);

    const before = assembled.negative_impact_promoted;
    assembled = applyNegativeImpactBackstop(assembled, finalists);
    if (!before && assembled.negative_impact_promoted) {
      console.error(
        `[assemble-scored] backstop determinístico promoveu ${assembled.negative_impact_promoted.promoted_url} ` +
          `(demoveu ${assembled.negative_impact_promoted.demoted_url}) — scorer-select não garantiu negative_impact (#3916/#3918)`,
      );
    }

    // #4102: roda POR ÚLTIMO — ver doc de applyPlaceholderTitleBackstop pra
    // motivo da ordem (última palavra sobre título placeholder, mesmo que o
    // backstop de negative-impact acima tenha reintroduzido o ofensor).
    assembled = applyPlaceholderTitleBackstop(assembled, finalists);
    if (assembled.placeholder_title_demoted) {
      for (const d of assembled.placeholder_title_demoted) {
        console.error(
          `[assemble-scored] backstop determinístico demoveu highlight com título placeholder: ` +
            `${d.demoted_url} (${d.demoted_title ?? "(sem título)"})` +
            (d.promoted_url ? ` — substituído por ${d.promoted_url}` : " — removido, sem substituto disponível") +
            " (#4102)",
        );
      }
    }
  }

  writeFileSync(resolve(ROOT, outPath), JSON.stringify(assembled, null, 2), "utf8");

  process.stdout.write(
    JSON.stringify({
      highlights: assembled.highlights.length,
      runners_up: assembled.runners_up.length,
      all_scored: assembled.all_scored.length,
      ...(assembled.negative_impact_promoted ? { negative_impact_promoted: true } : {}),
      ...(assembled.placeholder_title_demoted ? { placeholder_title_demoted: assembled.placeholder_title_demoted.length } : {}),
    }) + "\n",
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
