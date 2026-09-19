/**
 * jev-composite-score-eval.ts (#8415 — Medição 2 do epic #8412)
 *
 * Roda a medição de MEDIÇÃO, não implementação: replay de N edições
 * concluídas (`data/editions/{AAMMDD}/_internal/01-approved.json`), pontua
 * cada candidato (destaques + pool) nos 6 eixos atômicos de
 * `scripts/lib/jev-composite-score.ts` via Jev, e compara:
 *
 *   (a) score composto (Jev) vs. score do mecanismo atual (scorer-chunk)
 *   (b) concordância no TOP-15 de cada um contra o que o editor de fato
 *       aprovou como destaque no gate (a métrica que a issue pede como
 *       principal — mais que correlação geral)
 *
 * Não escreve nada em `platform.config.json`, não altera nenhum output de
 * produção — só lê `01-approved.json` (já finalizado) e escreve um relatório
 * markdown local. Nenhuma edição em curso é tocada.
 *
 * Uso:
 *   npx tsx scripts/jev-composite-score-eval.ts --editions 20 --out data/jev-eval/composite-8415/report.md
 *   npx tsx scripts/jev-composite-score-eval.ts --editions 5 --dry-run   # sem chamar a API, só monta o dataset
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getIntArg, getStringArg, isMainModule, parseArgs } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import {
  COMPOSITE_AXES,
  axesToJevQuestions,
  collectEditionCandidates,
  compositeScore,
  pearsonCorrelation,
  top15Concordance,
  totalWeight,
  type Candidate,
} from "./lib/jev-composite-score.ts";
import { askJevBatch, type JevScoreAnswer } from "./lib/jev.ts";

const ROOT = resolve(import.meta.dirname, "..");

export function loadCandidates(editionsRoot: string, maxEditions: number): { candidates: Candidate[]; editionsUsed: string[] } {
  const dirs = enumerateEditionDirs(editionsRoot);
  const withApproved: Array<[string, string]> = [];
  for (const [ed, dir] of dirs) {
    if (/^replay-/.test(ed)) continue; // baselines de experimento, não edições reais
    const p = join(dir, "_internal", "01-approved.json");
    if (existsSync(p)) withApproved.push([ed, p]);
  }
  withApproved.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const picked = withApproved.slice(-maxEditions);

  const candidates: Candidate[] = [];
  const editionsUsed: string[] = [];
  for (const [ed, p] of picked) {
    try {
      const approved = JSON.parse(readFileSync(p, "utf8"));
      const items = collectEditionCandidates(approved, ed);
      if (items.length === 0) continue;
      candidates.push(...items);
      editionsUsed.push(ed);
    } catch (e) {
      // edição com JSON corrompido — pula, não derruba a medição inteira,
      // mas nomeia a edição/erro (#8415 review: catch silencioso escondia
      // qual edição falhou quando a contagem final vinha menor que --editions).
      console.error(`[jev-composite-score-eval] ${ed}: 01-approved.json ilegível (${e instanceof Error ? e.message : String(e)}) — pulada`);
    }
  }
  return { candidates, editionsUsed };
}

export interface ScoredCandidate extends Candidate {
  compositeScore: number | null;
  axisAnswers: Record<string, JevScoreAnswer>;
  axisErrors: string[];
}

export async function scoreCandidatesViaJev(
  candidates: Candidate[],
  opts: { apiKey: string; cacheDir?: string | null; fetchImpl?: typeof fetch },
): Promise<{ scored: ScoredCandidate[]; itemErrors: number }> {
  const questions = axesToJevQuestions(COMPOSITE_AXES);
  // #8415 review: `id`/`cacheKey` são escopados por (edição, url) — não só
  // `url` — porque a regra editorial só proíbe repetir link nas ÚLTIMAS 3
  // edições, e o corpus padrão desta medição cobre 20. A mesma URL
  // reaparecendo >3 edições depois colidiria em `askJevBatch` (2 requests
  // concorrentes na mesma cacheKey, resultado não-determinístico ganhando a
  // corrida) e faria as duas ocorrências herdarem os mesmos axisAnswers.
  const itemKey = (c: Candidate) => `${c.edition}::${c.url}`;
  const items = candidates.map((c) => ({
    id: itemKey(c),
    state: { title: c.title, summary: c.summary, source: c.source, published_at: c.published_at, url: c.url },
    questions,
    cacheKey: itemKey(c),
  }));

  const { results, errors } = await askJevBatch(items, {
    apiKey: opts.apiKey,
    cacheDir: opts.cacheDir,
    fetchImpl: opts.fetchImpl,
  });
  const byKey = new Map(results.map((r) => [r.id, r.answers]));

  const scored: ScoredCandidate[] = candidates.map((c) => {
    const answers = byKey.get(itemKey(c)) ?? [];
    const axisAnswers: Record<string, JevScoreAnswer> = {};
    for (const a of answers) if (a.type === "score") axisAnswers[a.id] = a;
    return {
      ...c,
      compositeScore: compositeScore(axisAnswers, COMPOSITE_AXES),
      axisAnswers,
      axisErrors: COMPOSITE_AXES.filter((ax) => !axisAnswers[ax.id]).map((ax) => ax.id),
    };
  });

  return { scored, itemErrors: errors.size };
}

export function renderReport(scored: ScoredCandidate[], editionsUsed: string[]): string {
  const byEdition = new Map<string, ScoredCandidate[]>();
  for (const c of scored) {
    if (!byEdition.has(c.edition)) byEdition.set(c.edition, []);
    byEdition.get(c.edition)!.push(c);
  }

  const lines: string[] = [];
  lines.push(`# Jev composite score — Medição #8415`);
  lines.push("");
  lines.push(`Editions no replay: ${editionsUsed.length} (${editionsUsed[0]}..${editionsUsed[editionsUsed.length - 1]})`);
  lines.push(`Candidatos totais: ${scored.length}`);
  lines.push("");
  lines.push(`Pesos (soma=${totalWeight()}): ` + COMPOSITE_AXES.map((a) => `${a.id}=${a.weight}`).join(", "));
  lines.push("");

  let mechDestaquesTotal = 0;
  let mechDestaquesInTop = 0;
  let compDestaquesTotal = 0;
  let compDestaquesInTop = 0;
  let editionsMechPerfect = 0;
  let editionsCompPerfect = 0;

  lines.push(`| edição | candidatos | destaques | mecanismo top-15 | composto top-15 |`);
  lines.push(`|---|---|---|---|---|`);
  for (const ed of editionsUsed) {
    const items = byEdition.get(ed) ?? [];
    if (items.length === 0) continue;
    const withComposite = items.filter((i) => i.compositeScore !== null);

    const mech = top15Concordance(items.map((i) => ({ url: i.url, isDestaque: i.isDestaque, score: i.mechanismScore })));
    const comp = top15Concordance(withComposite.map((i) => ({ url: i.url, isDestaque: i.isDestaque, score: i.compositeScore! })));

    mechDestaquesTotal += mech.totalDestaques;
    mechDestaquesInTop += mech.destaquesInTop;
    compDestaquesTotal += comp.totalDestaques;
    compDestaquesInTop += comp.destaquesInTop;
    if (mech.totalDestaques > 0 && mech.destaquesInTop === mech.totalDestaques) editionsMechPerfect++;
    if (comp.totalDestaques > 0 && comp.destaquesInTop === comp.totalDestaques) editionsCompPerfect++;

    lines.push(
      `| ${ed} | ${items.length} | ${mech.totalDestaques} | ${mech.destaquesInTop}/${mech.totalDestaques} | ${comp.destaquesInTop}/${comp.totalDestaques} |`,
    );
  }
  lines.push("");

  lines.push(`## Agregado — concordância no TOP-15 (métrica principal da issue)`);
  lines.push("");
  lines.push(`- mecanismo atual (scorer-chunk): ${mechDestaquesInTop}/${mechDestaquesTotal} destaques capturados no top-15 (${((mechDestaquesInTop / mechDestaquesTotal) * 100).toFixed(1)}%), ${editionsMechPerfect}/${editionsUsed.length} edições com 100% dos destaques no top-15`);
  lines.push(`- score composto (Jev): ${compDestaquesInTop}/${compDestaquesTotal} destaques capturados no top-15 (${((compDestaquesInTop / compDestaquesTotal) * 100).toFixed(1)}%), ${editionsCompPerfect}/${editionsUsed.length} edições com 100% dos destaques no top-15`);
  lines.push("");

  const withComposite = scored.filter((s) => s.compositeScore !== null);
  const corr = pearsonCorrelation(withComposite.map((s) => s.mechanismScore), withComposite.map((s) => s.compositeScore!));
  lines.push(`## Correlação geral (secundária)`);
  lines.push("");
  lines.push(`Pearson (mecanismo × composto), n=${withComposite.length}: ${corr === null ? "n/a" : corr.toFixed(3)}`);
  lines.push("");

  const withErrors = scored.filter((s) => s.axisErrors.length > 0);
  if (withErrors.length > 0) {
    lines.push(`## Erros de transporte por eixo (não penalizados no peso — ver \`compositeScore\`)`);
    lines.push("");
    lines.push(`${withErrors.length}/${scored.length} candidato(s) com ≥1 eixo sem resposta.`);
    lines.push("");
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const maxEditions = getIntArg(argv, "editions", { min: 1 }) ?? 20;
  const outPath = getStringArg(argv, "out") ?? resolve(ROOT, "data", "jev-eval", "composite-8415", "report.md");
  const dryRun = parsed.flags.has("dry-run");
  const editionsRoot = resolve(ROOT, "data", "editions");

  if (!existsSync(editionsRoot)) {
    console.error(`data/editions/ ausente em ${ROOT} — sem corpus montado nesta máquina.`);
    process.exit(2);
  }

  const { candidates, editionsUsed } = loadCandidates(editionsRoot, maxEditions);
  console.error(`dataset: ${candidates.length} candidatos de ${editionsUsed.length} edições`);

  // #8415 review: sem isto, um corpus vazio (clone fresco, nenhuma edição com
  // 01-approved.json) produzia um relatório com "undefined..undefined" e
  // divisões 0/0 (`NaN%`) em vez de um erro claro.
  if (candidates.length === 0 || editionsUsed.length === 0) {
    console.error("nenhum candidato encontrado — verifique se data/editions/ tem edições com _internal/01-approved.json.");
    process.exit(2);
  }

  if (dryRun) {
    console.error("(--dry-run — sem chamada à API)");
    console.log(JSON.stringify({ editionsUsed, totalCandidates: candidates.length }, null, 2));
    return;
  }

  loadProjectEnv(ROOT);
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.error("TYPESAFE_API_KEY ausente — sem key não há como consultar Jev.");
    process.exit(2);
  }

  const cacheDir = resolve(ROOT, "data", "jev-eval", "composite-8415", "cache");
  mkdirSync(resolve(outPath, ".."), { recursive: true });

  const { scored, itemErrors } = await scoreCandidatesViaJev(candidates, { apiKey, cacheDir });
  if (itemErrors > 0) console.error(`${itemErrors} item(ns) com falha TOTAL de transporte (todos os eixos) — excluídos da comparação.`);

  const report = renderReport(scored, editionsUsed);
  writeFileSync(outPath, report, "utf8");
  console.log(report);
}

if (isMainModule(import.meta.url)) {
  main();
}
