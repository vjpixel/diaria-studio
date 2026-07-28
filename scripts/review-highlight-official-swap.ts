#!/usr/bin/env npx tsx
/**
 * review-highlight-official-swap.ts (#4135 item 3)
 *
 * Guard determinístico: cross-check contra o POOL da MESMA edição. Se um
 * destaque tem cobertura de IMPRENSA (URL não é domínio oficial) e existe no
 * pool da mesma edição (lancamento/radar/use_melhor/video) um artigo de
 * DOMÍNIO OFICIAL sobre o MESMO TEMA, sugere a troca ao editor no gate.
 *
 * Follow-up do #4080 — o #4134 (rodada anterior) cobriu só o item 1 (voz
 * passiva em `detectLaunchCandidate`). Este é o item 3 do follow-up #4135:
 * "barato e determinístico" porque NÃO depende de heurística de linguagem
 * (diferente do item 2, mismatch de domínio por voz — fora de escopo aqui,
 * decisão de calibragem do editor, permanece aberta no #4135). Só sugere
 * quando o artigo oficial JÁ EXISTE no pool — nunca infere nem busca
 * ativamente (isso seria fase 2 do #1699, não este mecanismo).
 *
 * Reusa a MESMA lógica de similaridade de tema já testada em
 * dedup-intra-edition.ts (`isIntraEditionDuplicate` — Jaccard/entidade/
 * cross-vehicle/product-code) em vez de reinventar "mesmo tema" do zero. A
 * classificação oficial-vs-imprensa vem de `isOfficialLancamentoUrl`
 * (categorize.ts → launch-heuristics.ts), a mesma fonte usada por
 * review-highlight-source.ts (#1699) e pela regra editorial #160.
 *
 * Checa DUAS fontes de candidato oficial (defensivo contra ordem de
 * pipeline):
 *   1. Os buckets secundários (lancamento/radar/use_melhor/video) do
 *      `01-categorized.json` — cobre o caso em que este guard roda ANTES do
 *      dedup intra-edição (#2367/#4185) ter dobrado o item no destaque.
 *   2. `highlight.article.cluster_sources[]` — cobre o caso em que este
 *      guard roda DEPOIS do dedup intra-edição já ter fundido o artigo
 *      oficial como cluster_source do próprio destaque (mesmo matcher,
 *      `isIntraEditionDuplicate`, então o fold só acontece quando o dedup já
 *      confirmou "mesmo evento" — sinal forte, sem necessidade de
 *      re-verificar similaridade).
 *
 * NÃO confundir com dedup-intra-edition.ts (#4185) / check-promoted-dedup.ts
 * (#4200): aqueles DEDUPLICAM — removem/fundem itens same-story dos buckets
 * secundários, preservando o destaque como está. Este script NUNCA remove
 * nada — só SUGERE ao editor trocar a URL do destaque pela oficial que já
 * está no pool. Mecanismo distinto, mesmo gate (Etapa 1, pré-aprovação).
 *
 * Incidente real que motivou (edição 260727): D2 apontava para o Tecnoblog
 * (cobertura de imprensa) enquanto o anúncio oficial
 * (anthropic.com/news/claude-opus-5, score 72) estava no pool RADAR, a um
 * bucket de distância. Corrigido à mão pelo editor no gate.
 *
 * WARN-ONLY: nunca bloqueia (exit 0 sempre). O orchestrator surfa
 * `suggestions[]` no gate para o editor decidir.
 *
 * Uso:
 *   npx tsx scripts/review-highlight-official-swap.ts \
 *     --categorized data/editions/AAMMDD/_internal/01-categorized.json \
 *     [--destaque-count 3]
 *
 * Output JSON: { total, suggestions: [{ highlight_url, highlight_title,
 *   official_url, official_title, match_type, score }] }
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import {
  isIntraEditionDuplicate,
  highlightUrl as extractHighlightUrl,
  highlightTitle as extractHighlightTitle,
  DEFAULT_INTRA_DESTAQUE_COUNT,
} from "./dedup-intra-edition.ts";
import { SECONDARY_BUCKETS } from "./check-secondary-themes.ts";
import { isOfficialLancamentoUrl } from "./categorize.ts";

export interface PoolArticle {
  url: string;
  title?: string;
  summary?: string;
  cluster_sources?: Array<{ url: string; title?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface HighlightLike {
  rank?: number;
  url?: string;
  title?: string;
  summary?: string;
  article?: PoolArticle;
  [k: string]: unknown;
}

export interface CategorizedPool {
  highlights?: HighlightLike[];
  lancamento?: PoolArticle[];
  radar?: PoolArticle[];
  use_melhor?: PoolArticle[];
  video?: PoolArticle[];
  [k: string]: unknown;
}

export interface OfficialSwapSuggestion {
  highlight_url: string;
  highlight_title?: string;
  official_url: string;
  official_title?: string;
  match_type: string;
  score: number;
  /** De onde veio o candidato oficial — pool secundário ou já dobrado como cluster_source. */
  source: "pool" | "cluster_source";
}

export interface OfficialSwapResult {
  total: number;
  suggestions: OfficialSwapSuggestion[];
}

/** Extrai o `article` aninhado de um HighlightLike, tolerando shape flat. */
function highlightArticle(h: HighlightLike): PoolArticle | undefined {
  return h.article;
}

/**
 * Compara os top-`destaqueCount` destaques (por rank) contra candidatos
 * oficiais — tanto no pool de artigos secundários quanto em
 * `cluster_sources[]` já dobrados. Sugere troca quando o destaque NÃO é de
 * domínio oficial e existe um candidato oficial sobre o MESMO tema (via
 * `isIntraEditionDuplicate` para os candidatos do pool — mesma lógica
 * testada de dedup-intra-edition.ts; cluster_sources já foram confirmados
 * same-event pelo próprio dedup, então entram direto).
 *
 * Pure function — não muta `categorized`.
 */
export function findOfficialSwapSuggestions(
  categorized: CategorizedPool,
  options: { destaqueCount?: number } = {},
): OfficialSwapResult {
  const n = options.destaqueCount ?? DEFAULT_INTRA_DESTAQUE_COUNT;
  const allHighlights = categorized.highlights ?? [];
  const topHighlights = [...allHighlights]
    .sort((a, b) => {
      const ra = typeof a.rank === "number" ? a.rank : 999;
      const rb = typeof b.rank === "number" ? b.rank : 999;
      return ra - rb;
    })
    .slice(0, n);

  const pool: PoolArticle[] = SECONDARY_BUCKETS.flatMap(
    (bucket) => categorized[bucket] ?? [],
  );

  const suggestions: OfficialSwapSuggestion[] = [];

  for (const h of topHighlights) {
    const hUrl = extractHighlightUrl(h);
    const hTitle = extractHighlightTitle(h);
    if (!hUrl || !hTitle) continue;
    // Já é oficial — nada a sugerir.
    if (isOfficialLancamentoUrl(hUrl)) continue;

    let best: { article: PoolArticle; matchType: string; score: number; source: "pool" | "cluster_source" } | null = null;

    // Fonte 1: buckets secundários (pré-dedup-intra-edição, ou dedup não fundiu).
    for (const article of pool) {
      if (!article?.url || article.url === hUrl) continue;
      if (!article.title) continue;
      if (!isOfficialLancamentoUrl(article.url)) continue;

      const match = isIntraEditionDuplicate(article, [h]);
      if (match && (!best || match.score > best.score)) {
        best = { article, matchType: match.match_type, score: match.score, source: "pool" };
      }
    }

    // Fonte 2: cluster_sources[] já dobrados pelo dedup intra-edição (#4185).
    // O fold só acontece quando isIntraEditionDuplicate já confirmou mesmo
    // evento — não precisa re-checar similaridade, só a classificação oficial.
    const clusterSources = highlightArticle(h)?.cluster_sources ?? [];
    for (const cs of clusterSources) {
      if (!cs?.url || cs.url === hUrl) continue;
      if (!isOfficialLancamentoUrl(cs.url)) continue;
      // Score 1.0: o dedup já confirmou same-event ao dobrar — confiança máxima.
      if (!best || 1.0 > best.score) {
        best = { article: { url: cs.url, title: cs.title }, matchType: "cluster_source", score: 1.0, source: "cluster_source" };
      }
    }

    if (best) {
      suggestions.push({
        highlight_url: hUrl,
        highlight_title: hTitle,
        official_url: best.article.url,
        official_title: best.article.title,
        match_type: best.matchType,
        score: best.score,
        source: best.source,
      });
    }
  }

  return { total: topHighlights.length, suggestions };
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseCliArgs(process.argv.slice(2));
  const categorizedArg = values["categorized"];
  if (!categorizedArg) {
    console.error("Uso: review-highlight-official-swap.ts --categorized <01-categorized.json> [--destaque-count 3]");
    process.exit(2);
  }
  const categorizedPath = resolve(ROOT, categorizedArg);
  if (!existsSync(categorizedPath)) {
    console.error(`Arquivo não existe: ${categorizedPath}`);
    process.exit(2);
  }
  let categorized: CategorizedPool;
  try {
    categorized = JSON.parse(readFileSync(categorizedPath, "utf8")) as CategorizedPool;
  } catch (err) {
    console.error(`Falha ao parsear ${categorizedPath}: ${(err as Error).message}`);
    process.exit(2);
  }

  const destaqueCountArg = values["destaque-count"];
  const destaqueCount = destaqueCountArg ? parseInt(destaqueCountArg, 10) : DEFAULT_INTRA_DESTAQUE_COUNT;

  const result = findOfficialSwapSuggestions(categorized, { destaqueCount });
  console.log(JSON.stringify(result, null, 2));

  if (result.suggestions.length > 0) {
    console.error(
      `\n⚠️ ${result.suggestions.length} destaque(s) tem(êm) cobertura de imprensa quando um artigo OFICIAL sobre o mesmo tema já está no pool desta edição (#4135):`,
    );
    for (const s of result.suggestions) {
      const titleHint = s.highlight_title ? ` ("${s.highlight_title.slice(0, 60)}")` : "";
      console.error(`  ${s.highlight_url}${titleHint} → trocar por: ${s.official_url}`);
    }
    console.error(
      "Revise no gate: destaque de lançamento deve linkar a fonte oficial já disponível no pool desta edição (#4135, extensão do #1699/#160).",
    );
  }
  // Warn-only: nunca bloqueia (exit 0).
}

if (isMainModule(import.meta.url)) {
  main();
}
