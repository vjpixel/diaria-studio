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
 *     --out data/editions/{AAMMDD}/_internal/tmp-scored.json \
 *     --edition {AAMMDD}
 *
 * Output stdout: JSON { highlights, runners_up, all_scored } counts.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ScorePair } from "./merge-scored-chunks.ts";
import { parseArgsWithTrueDefault as parseArgs, isMainModule } from "./lib/cli-args.ts"; // #2834
import { ensureNegativeImpactHighlight, type FinalistLike } from "./lib/negative-impact-promotion.ts"; // #3916, #3918
import {
  demotePlaceholderTitleHighlights,
  isPlaceholderHighlightTitle,
  type PlaceholderDemotion,
} from "./lib/placeholder-title-guard.ts"; // #4102
import { reconcileClusterSources, type ClusterSourcesRestoration } from "./lib/cluster-sources-backstop.ts"; // #4838
import { annotateAudienceAffinity, loadAudienceSignals, type AudienceSignals } from "./lib/audience-affinity.ts"; // #2063
import {
  applyExplorationQuota,
  countWeekUsage,
  explorationWeekOfEdition,
  loadExplorationConfig,
  readExplorationState,
  recordExplorationDecision,
  writeExplorationState,
  EXPLORATION_STATE_RELATIVE_PATH,
  type ExplorationFinalistLike,
  type ExplorationPromotion,
} from "./lib/exploration-quota.ts"; // #8370 Peça 2

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
  // #4838: presente só quando o backstop restaurou `cluster_sources[]` de
  // ≥1 highlight a partir do finalist correspondente (scorer-select não
  // preservou o campo ao copiar o article).
  cluster_sources_restored?: ClusterSourcesRestoration[];
  // #8370 Peça 2: presente só quando a cota semanal de exploração marcou um
  // destaque `exploracao: true` nesta edição (promovendo do pool ou
  // reconhecendo um item exógeno já selecionado por mérito).
  exploracao_promoted?: ExplorationPromotion;
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

/**
 * #4838: backstop determinístico — `article.cluster_sources[]` de cada
 * highlight final tem que bater com o `cluster_sources[]` que o dedup
 * atribuiu ao mesmo artigo em `finalists`. `scorer-select` (LLM) é instruído
 * a copiar o `article` EXATAMENTE como veio no finalista, mas
 * `cluster_sources[]` nunca é mencionado no prompt do agent — campo aninhado,
 * pouco saliente, fácil de "esquecer" ao retranscrever um JSON grande. Sem
 * este backstop, o bônus de cobertura (já somado ao score rio acima, em
 * `merge-scored-chunks.ts`, antes do scorer-select rodar) pode sobreviver
 * intacto enquanto o bloco "Aprofunde:" nunca chega a ser emitido — bônus
 * ativo, entrega que não existe (#4838). Ordem: roda independente dos 2
 * backstops acima (não interage com QUAL highlight foi escolhido, só
 * completa um campo do `article` já selecionado).
 */
export function applyClusterSourcesBackstop(
  assembled: AssembledOutput,
  finalists: FinalistLike[],
): AssembledOutput {
  const result = reconcileClusterSources(assembled.highlights, finalists);
  if (result.restorations.length === 0) return assembled;
  return {
    ...assembled,
    highlights: result.highlights,
    cluster_sources_restored: result.restorations,
  };
}

export interface ExplorationBackstopDeps {
  /** Raiz do repo (default: a raiz resolvida deste script). */
  rootDir?: string;
  /** Sinais de audiência já carregados — injetáveis pra teste. */
  signals?: AudienceSignals;
  /** Path do estado da cota (default: `data/exploration-quota.json`). */
  statePath?: string;
  now?: Date;
  /** Log de diagnóstico (default: `console.error`). */
  log?: (msg: string) => void;
}

/**
 * #8370 Peça 2 — cota SEMANAL de exploração. Roda por último, depois dos 3
 * backstops acima: os outros decidem QUAIS destaques a edição tem por regra
 * editorial já estabelecida (impacto negativo, título placeholder, cluster
 * sources); este decide se um dos slots do dia vai para um item de sinal
 * EXÓGENO (afinidade abaixo do teto = nunca exibido antes, CTR indefinido) em
 * vez de para mais um item que o loop de reforço já favorece.
 *
 * Rodar por último é deliberado: a cota compara o candidato exógeno contra o
 * destaque mais fraco do dia, e esse conjunto só está estável depois que a
 * promoção de impacto negativo e a demoção de título placeholder já
 * aconteceram. Rodar antes compararia contra uma seleção que ainda ia mudar.
 *
 * Fail-soft em todas as bordas: sem `data/` (worktree, CI) os sinais de
 * audiência não carregam, `affinityOf` devolve `null` pra tudo e a cota vira
 * no-op sem registrar nada — nunca marca `exploracao` sem sinal que sustente
 * a marcação, e nunca derruba o Stage 1.
 */
export function applyExplorationQuotaBackstop(
  assembled: AssembledOutput,
  finalists: FinalistLike[],
  edition: string,
  deps: ExplorationBackstopDeps = {},
): AssembledOutput {
  const rootDir = deps.rootDir ?? ROOT;
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const week = explorationWeekOfEdition(edition);
  if (!week) {
    log(`[assemble-scored] cota de exploração pulada: edição "${edition}" não é um AAMMDD válido (#8370)`);
    return assembled;
  }

  const config = loadExplorationConfig(rootDir);
  if (!config.enabled) return assembled;

  const signals = deps.signals ?? loadAudienceSignals(rootDir);
  const affinityCache = new Map<string, number | null>();
  const affinityOf = (item: { url?: string; article?: { url?: string } | undefined }): number | null => {
    const article = (item.article ?? {}) as { url?: string; title?: string; summary?: string; category?: string };
    const key = item.url ?? article.url ?? "";
    if (affinityCache.has(key)) return affinityCache.get(key) ?? null;
    const affinity = annotateAudienceAffinity(article, signals)?.affinity ?? null;
    affinityCache.set(key, affinity);
    return affinity;
  };

  const statePath = deps.statePath ?? resolve(rootDir, EXPLORATION_STATE_RELATIVE_PATH);
  const state = readExplorationState(statePath);
  // A própria edição sai da conta: re-rodar o Stage 1 dela (resume) tem que
  // reproduzir a mesma decisão, não ler a si mesma como consumo alheio.
  const weekUsageBefore = countWeekUsage(state, week, edition);

  const result = applyExplorationQuota(assembled.highlights, finalists as ExplorationFinalistLike[], {
    config,
    week,
    weekUsageBefore,
    affinityOf,
    // Título placeholder nunca vira destaque (#4102) — a cota não é brecha.
    isEligibleCandidate: (f) => !isPlaceholderHighlightTitle(f.article?.title as string | undefined),
  });

  if (!signals.loaded) {
    log(
      "[assemble-scored] cota de exploração pulada: sinais de audiência indisponíveis " +
        "(sem data/link-ctr-table.csv) — nenhuma edição marcada (#8370)",
    );
    return assembled;
  }

  const decidedAt = (deps.now ?? new Date()).toISOString();
  const nextState = recordExplorationDecision(state, edition, {
    week,
    exploracao: Boolean(result.promotion),
    ...(result.promotion ? { url: result.promotion.promoted_url, origin: result.promotion.origin } : {}),
    decided_at: decidedAt,
  });
  if (!writeExplorationState(statePath, nextState)) {
    log(
      `[assemble-scored] cota de exploração: estado NÃO persistido (${statePath} — data/ ausente neste ` +
        "checkout); a decisão desta edição vale, mas não conta pra semana (#8370)",
    );
  }

  if (!result.promotion) {
    log(`[assemble-scored] cota de exploração sem promoção nesta edição: ${result.skipped ?? "sem motivo registrado"} (#8370)`);
    return assembled;
  }

  log(
    `[assemble-scored] cota de exploração marcou ${result.promotion.promoted_url} como exploracao:true ` +
      `(${result.promotion.origin}, slot ${weekUsageBefore + 1}/${config.slotsPerWeek} de ${week})` +
      (result.promotion.demoted_url ? ` — demoveu ${result.promotion.demoted_url}` : "") +
      " (#8370 Peça 2)",
  );

  return { ...assembled, highlights: result.highlights, exploracao_promoted: result.promotion };
}

/**
 * Deriva o `AAMMDD` do path de saída (`data/editions/260919/_internal/...`).
 * `null` quando o path não segue a convenção — o caller então pula a cota em
 * vez de inventar uma edição.
 */
export function editionFromPath(path: string): string | null {
  const m = /editions[/\\](\d{6})[/\\]/.exec(path);
  return m ? m[1] : null;
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const selectionPath = args.selection;
  const allscoredPath = args.allscored;
  const outPath = args.out;
  const finalistsPath = args.finalists; // #3916/#3918: opcional

  if (!selectionPath || !allscoredPath || !outPath) {
    console.error(
      "Uso: assemble-scored.ts --selection <tmp-selection.json> --allscored <tmp-allscored.json> --out <tmp-scored.json> [--finalists <tmp-finalists.json>] [--edition AAMMDD]",
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

    // #4838: independente da ordem dos 2 backstops acima — só completa o
    // campo `cluster_sources` do `article` já escolhido, nunca troca QUAL
    // highlight foi selecionado.
    assembled = applyClusterSourcesBackstop(assembled, finalists);
    if (assembled.cluster_sources_restored) {
      for (const r of assembled.cluster_sources_restored) {
        console.error(
          `[assemble-scored] backstop determinístico restaurou cluster_sources[] (${r.restored_count} fonte(s)) ` +
            `em ${r.url} — ${r.reason}`,
        );
      }
    }

    // #8370 Peça 2: por último — ver doc de applyExplorationQuotaBackstop.
    const edition = (args.edition as string | undefined) ?? editionFromPath(outPath);
    if (edition) {
      assembled = applyExplorationQuotaBackstop(assembled, finalists, edition);
    } else {
      console.error(
        "[assemble-scored] cota de exploração pulada: edição não informada (--edition) nem derivável do " +
          `--out ("${outPath}") (#8370)`,
      );
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
      ...(assembled.cluster_sources_restored ? { cluster_sources_restored: assembled.cluster_sources_restored.length } : {}),
      ...(assembled.exploracao_promoted ? { exploracao_promoted: true } : {}),
    }) + "\n",
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
