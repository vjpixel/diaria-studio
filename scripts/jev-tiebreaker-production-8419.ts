/**
 * jev-tiebreaker-production-8419.ts (#8419 — Medição 6 do epic #8412)
 *
 * Mede a acurácia de PRODUÇÃO do tie-breaker semântico do #8211 sobre as
 * edições reais: compara cada `category_rule: semantic-tiebreaker-*` de
 * `_internal/01-categorized.json` com a seção em que o item saiu publicado em
 * `02-reviewed.md` (gabarito = decisão final do editor), contra o default
 * silencioso que o determinístico teria usado (McNemar). Também tabula o
 * acerto de TODAS as regras do categorizador contra o publicado (insumo pra
 * lista de regras fracas do item 2).
 *
 * `--extended` (item 2 da issue): pergunta à Jev a Choice estendida
 * `TIEBREAKER_EXTENDED_8419` sobre os mesmos itens gabaritáveis, `--runs N`
 * vezes (a API não é determinística — docs/jev.md), e compara com o
 * tie-breaker de produção. Exige `TYPESAFE_API_KEY`. Só roda se o item 3
 * passar (produção não pior que o offline) — senão a medição para ali, como
 * a issue manda.
 *
 * Nada aqui muda produção: só lê `data/editions/` e, com `--extended`, chama
 * a API de classificação (custo desprezível, ~US$ 0,04/edição — #8412).
 *
 * Uso:
 *   npx tsx scripts/jev-tiebreaker-production-8419.ts [--editions-dir data/editions] [--since 260917] [--extended [--runs 3] [--env-root <dir com .env>]] [--json]
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getIntArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { askJevBatch } from "./lib/jev.ts";
import { TIEBREAKER_EXTENDED_8419 } from "./lib/jev-questions.ts";
import { canonicalize } from "./lib/url-utils.ts";
import type { Bucket } from "./lib/launch-heuristics.ts";
import { discoverEditionPaths } from "./analyze-bucket-overrides.ts";
import {
  collectTiebreakerDecisions,
  compareExtended,
  extendedChoiceToBucket,
  gradable,
  gradeDecisions,
  parsePublishedPlacements,
  renderExtendedReport,
  renderProductionReport,
  renderRuleTable,
  summarizeProduction,
  tallyRuleAccuracy,
  type CategorizedFile,
  type ExtendedComparison,
  type GradedDecision,
  type RuleTally,
} from "./lib/tiebreaker-production-eval.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** O #8211 entrou em produção em 17/09/2026. */
export const DEFAULT_SINCE = "260917";

export interface CorpusResult {
  graded: GradedDecision[];
  ruleTally: Record<string, RuleTally>;
  skipped: string[];
}

/**
 * Lê o corpus: só edições ≥ `since` que tenham `01-categorized.json` E
 * `02-reviewed.md`. Edição sem decisão de tie-breaker conta como pulada
 * (flag off/fail-soft naquele dia) — não entra no denominador.
 */
export function loadCorpus(editionsDir: string, since = DEFAULT_SINCE): CorpusResult {
  const graded: GradedDecision[] = [];
  const ruleTally: Record<string, RuleTally> = {};
  const skipped: string[] = [];
  if (!existsSync(editionsDir)) return { graded, ruleTally, skipped };
  const paths = discoverEditionPaths(editionsDir);
  for (const edition of [...paths.keys()].sort()) {
    if (edition < since) continue;
    const dir = paths.get(edition)!;
    const catPath = join(dir, "_internal", "01-categorized.json");
    const mdPath = join(dir, "02-reviewed.md");
    if (!existsSync(catPath) || !existsSync(mdPath)) {
      skipped.push(`${edition} (sem 01-categorized.json ou 02-reviewed.md)`);
      continue;
    }
    let cat: CategorizedFile;
    try {
      cat = JSON.parse(readFileSync(catPath, "utf8"));
    } catch (err) {
      skipped.push(`${edition} (JSON inválido: ${(err as Error).message})`);
      continue;
    }
    const decisions = collectTiebreakerDecisions(edition, cat);
    if (decisions.length === 0) {
      skipped.push(`${edition} (nenhuma decisão do tie-breaker)`);
      continue;
    }
    const placements = parsePublishedPlacements(readFileSync(mdPath, "utf8"));
    graded.push(...gradeDecisions(decisions, placements));
    tallyRuleAccuracy(cat, placements, ruleTally);
  }
  return { graded, ruleTally, skipped };
}

export async function runExtended(
  graded: GradedDecision[],
  opts: { apiKey: string; runs: number; fetchImpl?: typeof fetch },
): Promise<ExtendedComparison[]> {
  const items = gradable(graded);
  const out: ExtendedComparison[] = [];
  for (let run = 1; run <= opts.runs; run++) {
    // Sem cache de propósito: cada rodada é uma amostra nova da API não determinística.
    const { results, errors } = await askJevBatch(
      items.map((x) => ({
        id: canonicalize(x.url),
        state: { title: x.title, url: x.url, summary: x.summary },
        questions: [TIEBREAKER_EXTENDED_8419.question],
      })),
      { apiKey: opts.apiKey, fetchImpl: opts.fetchImpl },
    );
    const urlById = new Map(items.map((x) => [canonicalize(x.url), x.url]));
    const answers = new Map<string, Bucket>();
    for (const r of results) {
      const a = r.answers[0];
      if (!a || a.type !== "choice") continue;
      const b = extendedChoiceToBucket(a.choice, urlById.get(r.id) ?? r.id);
      if (b) answers.set(r.id, b);
    }
    out.push(compareExtended(items, { answers, errors: errors.size }, run));
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const editionsDir = resolve(getStringArg(argv, "editions-dir") ?? join(ROOT, "data", "editions"));
  const since = getStringArg(argv, "since") ?? DEFAULT_SINCE;
  const extended = hasFlag(argv, "extended");
  const runs = getIntArg(argv, "runs") ?? 3;
  const json = hasFlag(argv, "json");

  const { graded, ruleTally, skipped } = loadCorpus(editionsDir, since);
  if (graded.length === 0) {
    console.error(`[8419] nenhuma decisão do tie-breaker em ${editionsDir} (desde ${since}).`);
    process.exitCode = 1;
    return;
  }
  const summary = summarizeProduction(graded);

  let ext: ExtendedComparison[] | null = null;
  if (extended) {
    if (summary.worseThanOffline) {
      console.error(`[8419] item 3: produção pior que o offline — não rodando --extended (a issue manda parar).`);
    } else {
      // Worktree de subagente não tem `.env`: `--env-root` aponta pro checkout que tem.
      loadProjectEnv(getStringArg(argv, "env-root") ?? ROOT);
      const apiKey = process.env.TYPESAFE_API_KEY;
      if (!apiKey) {
        console.error(`[8419] TYPESAFE_API_KEY ausente — --extended não roda.`);
        process.exitCode = 1;
      } else {
        ext = await runExtended(graded, { apiKey, runs });
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ summary, ruleTally, extended: ext, skipped }, null, 2));
    return;
  }
  const parts = [renderProductionReport(summary), "", renderRuleTable(ruleTally)];
  if (ext) parts.push("", renderExtendedReport(ext));
  if (skipped.length) parts.push("", `Puladas: ${skipped.join("; ")}`);
  console.log(parts.join("\n"));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
