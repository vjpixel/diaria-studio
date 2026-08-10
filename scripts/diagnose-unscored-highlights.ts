#!/usr/bin/env npx tsx
/**
 * diagnose-unscored-highlights.ts (#4847)
 *
 * Caracteriza a ORIGEM de cada destaque (D1/D2/D3) que o editor escolheu mas
 * que NUNCA foi pontuado pelo scorer — o "teto de cobertura" medido pela
 * auditoria retrospectiva de 260810 (recall do universo pontuado: 95,6%; ou
 * seja, ~4,4% das escolhas do editor não estavam no pool que chegou ao
 * `scorer-chunk`). Ver issue #4847.
 *
 * Diferente do dataset ad-hoc dessa auditoria (`data/analysis/260810-cliques/
 * scored-vs-clicks.csv`, mencionado na issue mas NÃO reproduzido aqui de
 * propósito — ver docstring de `classifyOrigin` abaixo), este script
 * RECOMPUTA os fatos a cada execução, direto das fontes primárias por
 * edição:
 *   - `_internal/01-approved.json`: highlights[] = escolha FINAL do editor
 *     pós-gate (D1/D2/D3), cada um já carregando (quando setados no Stage 1)
 *     `source` / `editor_submitted` / `discovered_source` — não precisa de
 *     join externo pra saber a origem, o próprio highlight já se descreve.
 *   - `_internal/tmp-scored.json` (`all_scored[]`): TODO artigo que passou
 *     pelo scorer/scorer-chunk naquela edição, com score. Se o URL do
 *     highlight não está aqui, nunca foi pontuado.
 *   - `context/sources.md` (via `parseSourcesMd`): fontes atualmente
 *     cadastradas em `seed/sources.csv` — usado só pra rotular "fonte fora do
 *     seed" vs "fonte cadastrada"; uma fonte pode ter sido removida/adicionada
 *     entre a edição analisada e hoje, então esse rótulo reflete o cadastro
 *     ATUAL, não o da época (registrado no relatório).
 *   - `data/sources/{slug}.jsonl`: log append-only por fonte
 *     (`record-source-run.ts`/`/diaria-source-health`) — usado pra distinguir
 *     "a fonte falhou/deu timeout NAQUELE dia" de "a fonte rodou OK mas o
 *     artigo não chegou ao pool pontuado" (bug de pipeline, não de cobertura).
 *
 * Por não depender de `scored-vs-clicks.csv` nem de qualquer dado de CLIQUE
 * (CTR/unique_opens), este script é IMUNE à staleness introduzida por
 * #4834 (extractLinks descartava links em `<b>`) e #4836 (109 cliques
 * apagados em 22 posts) — ambos afetam SOMENTE contagem de clique, nunca o
 * fato "este URL apareceu em all_scored desta edição". Ainda assim, ele NÃO
 * reproduz 1:1 a metodologia da auditoria original: aqui "escolha final do
 * editor" = `01-approved.json.highlights[]` (saída do gate do Stage 1) — um
 * hand-edit feito DEPOIS do gate (ex: troca de destaque no Studio, #3729,
 * que edita `02-reviewed.md` direto sem tocar `01-approved.json`) não é
 * capturado aqui. Ver limitação documentada no corpo do PR.
 *
 * Uso:
 *   npx tsx scripts/diagnose-unscored-highlights.ts \
 *     [--editions-dir data/editions] [--sources-md context/sources.md] \
 *     [--sources-log-dir data/sources] [--json out.json] [--out report.md]
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { canonicalize } from "./lib/url-utils.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { parseSourcesMd, type Source } from "./list-active-sources.ts";
import { slugify, isHardFailure } from "./lib/source-runs.ts";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Tipos mínimos (subset do que scripts/lib/schemas/edition-state.ts já
// declara — não reimportado pra manter este script tolerante a JSON parcial/
// legado de edições antigas sem forçar validação Zod estrita numa auditoria
// histórica).
// ---------------------------------------------------------------------------

export interface DiagArticle {
  url?: string;
  title?: string;
  source?: string;
  editor_submitted?: boolean;
  discovered_source?: boolean;
  [key: string]: unknown;
}

export interface DiagHighlight {
  rank?: number;
  url?: string;
  article?: DiagArticle;
  [key: string]: unknown;
}

export interface ApprovedJsonLike {
  highlights?: DiagHighlight[];
  [key: string]: unknown;
}

export interface ScorePairLike {
  url?: string;
  score?: number;
}

export interface ScoredJsonLike {
  all_scored?: ScorePairLike[];
}

// ---------------------------------------------------------------------------
// Extração (flat vs nested highlight, #229 — mesmo padrão ad-hoc já usado em
// apply-gate-edits.ts / finalize-stage1.ts / analyze-scorer-impact.ts etc.)
// ---------------------------------------------------------------------------

/** URL de um highlight, cobrindo os dois shapes (flat/nested, #229). */
export function extractHighlightUrl(h: DiagHighlight): string | undefined {
  const url = h.article?.url ?? h.url;
  return typeof url === "string" && url.trim() ? url.trim() : undefined;
}

/** Article "efetivo" de um highlight — objeto aninhado, ou o próprio highlight
 *  (shape flat: os campos de Article estão diretos nele). */
export function extractHighlightArticle(h: DiagHighlight): DiagArticle {
  return h.article ?? (h as DiagArticle);
}

/** Set de URLs canonicalizadas presentes em `all_scored`. */
export function buildScoredUrlSet(scored: ScoredJsonLike | null): Set<string> | null {
  if (!scored || !Array.isArray(scored.all_scored)) return null;
  const set = new Set<string>();
  for (const p of scored.all_scored) {
    if (typeof p.url === "string" && p.url.trim()) set.add(canonicalize(p.url));
  }
  return set;
}

// ---------------------------------------------------------------------------
// Classificação
// ---------------------------------------------------------------------------

export type UnscoredOrigin =
  | "inbox" // editor_submitted:true
  | "discovery_open_query" // discovered_source:true — query aberta, fora do seed
  | "source_outside_seed" // article.source setado, mas fora de seed/sources.csv (hoje)
  | "registered_source_failed_that_day" // source no seed + fail/timeout logado NAQUELE dia
  | "registered_source_pool_gap" // source no seed, sem falha logada — gap de pipeline
  | "unknown_origin"; // sem source/editor_submitted/discovered_source — provável hand-edit

export interface OriginContext {
  /** Nomes de fontes ATUALMENTE cadastradas em seed/sources.csv (via context/sources.md). */
  activeSourceNames: Set<string>;
  /** true se `sourceName` teve outcome fail|timeout logado NA edição `edition`. */
  sourceFailedThisEdition: (sourceName: string, edition: string) => boolean;
}

/**
 * Classifica a origem de um destaque nunca pontuado. Pura — recebe o article
 * já resolvido (ver `extractHighlightArticle`) e o contexto de fontes.
 */
export function classifyOrigin(
  article: DiagArticle,
  edition: string,
  ctx: OriginContext,
): UnscoredOrigin {
  if (article.editor_submitted === true) return "inbox";
  if (article.discovered_source === true) return "discovery_open_query";

  const source = typeof article.source === "string" ? article.source.trim() : "";
  if (source) {
    if (!ctx.activeSourceNames.has(source)) return "source_outside_seed";
    return ctx.sourceFailedThisEdition(source, edition)
      ? "registered_source_failed_that_day"
      : "registered_source_pool_gap";
  }

  return "unknown_origin";
}

// ---------------------------------------------------------------------------
// Diagnóstico por edição
// ---------------------------------------------------------------------------

export interface UnscoredCase {
  edition: string;
  rank?: number;
  url: string;
  title?: string;
  source?: string;
  origin: UnscoredOrigin;
}

export type EditionSkipReason =
  | "approved_json_missing_or_invalid"
  | "scored_json_missing_or_invalid";

export interface EditionResult {
  edition: string;
  highlights_total: number;
  unscored: UnscoredCase[];
  skipped?: EditionSkipReason; // presente quando a edição é EXCLUÍDA da amostra
}

function safeReadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Diagnostica uma única edição. Retorna `skipped` (edição EXCLUÍDA da
 * amostra, não conta como "0 casos") quando approved.json ou tmp-scored.json
 * estiverem ausentes/inválidos — mesmo princípio de `editions_unresolved` em
 * `analyze-scorer-impact.ts` (#1567 review): silenciar essas edições como "0"
 * enviesaria a taxa pra baixo.
 */
export function diagnoseEdition(
  edition: string,
  approved: ApprovedJsonLike | null,
  scored: ScoredJsonLike | null,
  ctx: OriginContext,
): EditionResult {
  if (!approved || !Array.isArray(approved.highlights) || approved.highlights.length === 0) {
    return { edition, highlights_total: 0, unscored: [], skipped: "approved_json_missing_or_invalid" };
  }
  const scoredUrls = buildScoredUrlSet(scored);
  if (scoredUrls === null) {
    return {
      edition,
      highlights_total: approved.highlights.length,
      unscored: [],
      skipped: "scored_json_missing_or_invalid",
    };
  }

  const unscored: UnscoredCase[] = [];
  for (const h of approved.highlights) {
    const url = extractHighlightUrl(h);
    if (!url) continue;
    if (scoredUrls.has(canonicalize(url))) continue; // pontuado — não é caso
    const article = extractHighlightArticle(h);
    unscored.push({
      edition,
      rank: h.rank,
      url,
      title: article.title,
      source: article.source,
      origin: classifyOrigin(article, edition, ctx),
    });
  }

  return { edition, highlights_total: approved.highlights.length, unscored };
}

// ---------------------------------------------------------------------------
// Lookup de falha de fonte por edição (data/sources/{slug}.jsonl)
// ---------------------------------------------------------------------------

/** Constrói `sourceFailedThisEdition` lendo os JSONL sob demanda (cache por slug). */
export function makeSourceFailureLookup(sourcesLogDir: string): OriginContext["sourceFailedThisEdition"] {
  const cache = new Map<string, Set<string>>(); // slug -> Set<edition com fail|timeout>

  function editionsWithFailure(slug: string): Set<string> {
    const cached = cache.get(slug);
    if (cached) return cached;
    const failedEditions = new Set<string>();
    const logPath = join(sourcesLogDir, `${slug}.jsonl`);
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (
            typeof entry.edition === "string" &&
            entry.edition &&
            isHardFailure(String(entry.outcome))
          ) {
            failedEditions.add(entry.edition);
          }
        } catch {
          /* linha corrompida — ignora, não aborta o log inteiro */
        }
      }
    }
    cache.set(slug, failedEditions);
    return failedEditions;
  }

  return (sourceName: string, edition: string): boolean =>
    editionsWithFailure(slugify(sourceName)).has(edition);
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

const ORIGIN_LABEL: Record<UnscoredOrigin, string> = {
  inbox: "Inbox editorial (editor_submitted)",
  discovery_open_query: "Discovery — query aberta, fora do seed",
  source_outside_seed: "Fonte registrada no artigo, mas fora de seed/sources.csv hoje",
  registered_source_failed_that_day: "Fonte cadastrada — researcher falhou/deu timeout naquele dia",
  registered_source_pool_gap: "Fonte cadastrada, sem falha logada — gap de pipeline (split/scoring)",
  unknown_origin: "Origem desconhecida (provável hand-edit pós-Stage 1, sem metadata)",
};

export function renderReport(results: EditionResult[]): string {
  const L: string[] = [];
  L.push("# Diagnóstico — destaques nunca pontuados (#4847)", "");

  const resolved = results.filter((r) => !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const allUnscored = resolved.flatMap((r) => r.unscored);
  const totalHighlights = resolved.reduce((s, r) => s + r.highlights_total, 0);

  L.push(
    `${resolved.length} edição(ões) com dado completo (${skipped.length} excluída(s) — ver seção final), ` +
      `${totalHighlights} destaque(s) avaliado(s), **${allUnscored.length} nunca pontuado(s)** ` +
      `(${totalHighlights > 0 ? ((allUnscored.length / totalHighlights) * 100).toFixed(1) : "—"}%).`,
    "",
  );

  L.push("## Por origem", "");
  L.push("| Origem | Casos |", "|---|---|");
  const order: UnscoredOrigin[] = [
    "inbox",
    "discovery_open_query",
    "source_outside_seed",
    "registered_source_failed_that_day",
    "registered_source_pool_gap",
    "unknown_origin",
  ];
  for (const origin of order) {
    const n = allUnscored.filter((c) => c.origin === origin).length;
    L.push(`| ${ORIGIN_LABEL[origin]} | ${n} |`);
  }
  L.push("");

  if (allUnscored.length > 0) {
    L.push("## Detalhe por caso", "");
    L.push("| Edição | Rank | Fonte | Origem | URL |", "|---|---|---|---|---|");
    for (const c of allUnscored) {
      L.push(
        `| ${c.edition} | ${c.rank ?? "—"} | ${c.source ?? "—"} | ${ORIGIN_LABEL[c.origin]} | ${c.url} |`,
      );
    }
    L.push("");
  }

  if (skipped.length > 0) {
    L.push("## Edições excluídas da amostra", "");
    L.push(
      "Sem `01-approved.json`/`tmp-scored.json` válido — não dá pra saber se os " +
        "destaques dessa edição foram pontuados ou não. Contá-las como \"0 casos\" " +
        "enviesaria a taxa pra baixo, então ficam de fora do denominador.",
      "",
    );
    L.push("| Edição | Motivo |", "|---|---|");
    for (const r of skipped) {
      L.push(`| ${r.edition} | ${r.skipped} |`);
    }
    L.push("");
  }

  return L.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function runDiagnosis(opts: {
  editionsDir: string;
  sourcesMdPath: string;
  sourcesLogDir: string;
}): EditionResult[] {
  const editionDirs = enumerateEditionDirs(opts.editionsDir);
  let activeSourceNames = new Set<string>();
  if (existsSync(opts.sourcesMdPath)) {
    const md = readFileSync(opts.sourcesMdPath, "utf8");
    const sources: Source[] = parseSourcesMd(md);
    activeSourceNames = new Set(sources.map((s) => s.name));
  }
  const sourceFailedThisEdition = makeSourceFailureLookup(opts.sourcesLogDir);
  const ctx: OriginContext = { activeSourceNames, sourceFailedThisEdition };

  const results: EditionResult[] = [];
  for (const [edition, dir] of [...editionDirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const approved = safeReadJson<ApprovedJsonLike>(join(dir, "_internal", "01-approved.json"));
    const scored = safeReadJson<ScoredJsonLike>(join(dir, "_internal", "tmp-scored.json"));
    results.push(diagnoseEdition(edition, approved, scored, ctx));
  }
  return results;
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const editionsDir = resolve(ROOT, args["editions-dir"] ?? "data/editions");
  const sourcesMdPath = resolve(ROOT, args["sources-md"] ?? "context/sources.md");
  const sourcesLogDir = resolve(ROOT, args["sources-log-dir"] ?? "data/sources");

  const results = runDiagnosis({ editionsDir, sourcesMdPath, sourcesLogDir });
  const report = renderReport(results);

  if (args.json) {
    writeFileSync(resolve(ROOT, args.json), JSON.stringify(results, null, 2) + "\n", "utf8");
    process.stderr.write(`[diagnose-unscored-highlights] JSON em ${args.json}\n`);
  }
  if (args.out) {
    writeFileSync(resolve(ROOT, args.out), report, "utf8");
    process.stderr.write(`[diagnose-unscored-highlights] relatório em ${args.out}\n`);
  } else {
    process.stdout.write(report + "\n");
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
