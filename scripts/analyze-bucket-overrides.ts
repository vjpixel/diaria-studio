/**
 * analyze-bucket-overrides.ts (#5995)
 *
 * Versiona a medição de correções manuais do editor ao bucket que o
 * categorizador (`categorize()`, scripts/lib/launch-heuristics.ts) atribuiu
 * a cada artigo. Diffa `_internal/01-categorized.json` (saída do
 * categorizador, Stage 1) × `_internal/01-approved.json` (estado após o
 * gate humano do Stage 1) em TODAS as edições sob `data/editions/`, e
 * reporta a matriz de direções de movimento entre os buckets
 * lancamento/radar/use_melhor.
 *
 * Escopo deliberadamente restrito a esses 3 buckets (exclui `video` e a
 * promoção pool→destaque/highlight): a fricção medida na #5995 é
 * especificamente "o categorizador errou o bucket", não "o editor promoveu
 * um item a destaque" (isso é outro fluxo, sem relação com o detector de
 * tutorial/lançamento). Um artigo que sai de `radar`/`use_melhor`/
 * `lancamento` no categorizado e vira `highlight` no aprovado não conta como
 * "movimento de bucket" aqui — ele simplesmente não aparece nos 3 buckets do
 * aprovado, e o join por URL não o encontra (silenciosamente ignorado, é o
 * comportamento correto, não um bug).
 *
 * `data/editions/` tem dois formatos coexistindo: pastas de mês `YYMM` (4
 * dígitos) contendo subpastas de edição `AAMMDD` (a maioria do corpus real) e
 * pastas de edição `AAMMDD` soltas direto na raiz (formato legado). Ambos são
 * varridos; qualquer outra entrada (ex: `replay-*`, artefato de replay/debug
 * do scorer/stage1/writer) é ignorada — nunca é tratada como edição.
 *
 * Uso:
 *   npx tsx scripts/analyze-bucket-overrides.ts [--editions-dir data/editions] [--examples 5] [--window 20] [--json]
 *
 * Sem `data/editions/` no ambiente (ex: worktree de subagente, sem a junction
 * local) o script imprime 0 edições processadas e sai limpo (exit 0) — não é
 * um erro de código, é ausência de corpus local (ver CLAUDE.md item 2b).
 *
 * `--rules` (#6647): em vez do diff categorizado×aprovado acima, agrega o
 * campo `category_rule` que `categorizeArticles()` (scripts/categorize.ts)
 * passou a gravar em cada artigo de `01-categorized.json` — qual regra/sinal
 * decidiu o bucket, ou um dos dois defaults silenciosos do motor
 * (`lancamento-default`/`noticias-default`, ver `isFallbackCategorizationRule`
 * em `scripts/lib/launch-heuristics.ts`). Mede o "resíduo sem-regra-forte"
 * de verdade (edições geradas ANTES do #6647 não têm o campo — artigos sem
 * `category_rule` são ignorados nessa contagem, não contam como fallback nem
 * como erro; não há dado, não como "0 fallback").
 *   npx tsx scripts/analyze-bucket-overrides.ts --rules [--editions-dir data/editions] [--json]
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { canonicalize } from "./lib/url-utils.ts";
import { isFallbackCategorizationRule, type Bucket } from "./lib/launch-heuristics.ts";

const ROOT = resolve(import.meta.dirname, "..");

// Os 3 buckets cobertos por esta análise — `video` fica de fora de propósito
// (não é editorial ambíguo do mesmo jeito; não aparece na medição da #5995).
const TRACKED_BUCKETS: readonly Bucket[] = ["lancamento", "radar", "use_melhor"];

// #6647: --rules cobre os 4 buckets (inclui `video`) — a pergunta ali é
// "de onde veio a decisão", não "o editor moveu o bucket" (essa é restrita
// aos 3 acima, por desenho da #5995).
const ALL_BUCKETS: readonly Bucket[] = ["lancamento", "radar", "use_melhor", "video"];

/** Janela default da taxa (#5995 item 5): últimas 20 edições. */
export const DEFAULT_WINDOW = 20;

export interface BucketArticleLike {
  url?: string;
  title?: string;
  [key: string]: unknown;
}

export interface CategorizedBucketsInput {
  lancamento?: BucketArticleLike[];
  radar?: BucketArticleLike[];
  use_melhor?: BucketArticleLike[];
  video?: BucketArticleLike[];
  [key: string]: unknown;
}

export interface ApprovedBucketsInput {
  highlights?: unknown[];
  runners_up?: unknown[];
  lancamento?: BucketArticleLike[];
  radar?: BucketArticleLike[];
  use_melhor?: BucketArticleLike[];
  video?: BucketArticleLike[];
  [key: string]: unknown;
}

export interface BucketMove {
  url: string;
  title: string;
  from: Bucket;
  to: Bucket;
  direction: string; // "from->to"
}

/**
 * Constrói url canonicalizada -> {bucket, title} a partir de um objeto de
 * buckets (categorizado OU aprovado), restrito a TRACKED_BUCKETS.
 * Último artigo com a mesma URL vence (não deveria haver duplicata dentro
 * de uma mesma edição, mas não é este script que valida isso).
 */
function indexByUrl(buckets: CategorizedBucketsInput | ApprovedBucketsInput): Map<string, { bucket: Bucket; title: string }> {
  const map = new Map<string, { bucket: Bucket; title: string }>();
  for (const bucket of TRACKED_BUCKETS) {
    const articles = buckets[bucket];
    if (!Array.isArray(articles)) continue;
    for (const article of articles) {
      if (!article || typeof article.url !== "string" || !article.url) continue;
      const key = canonicalize(article.url);
      map.set(key, { bucket, title: (article.title as string | undefined) ?? "" });
    }
  }
  return map;
}

/**
 * Diffa um par categorizado × aprovado de UMA edição e retorna os movimentos
 * de bucket detectados (join por URL canonicalizada; artigos que só aparecem
 * de um lado — dropados, promovidos a destaque, adicionados manualmente pelo
 * editor — são ignorados, não contam como "movimento").
 */
export function diffBucketOverrides(
  categorized: CategorizedBucketsInput,
  approved: ApprovedBucketsInput,
): BucketMove[] {
  const catIndex = indexByUrl(categorized);
  const apprIndex = indexByUrl(approved);
  const moves: BucketMove[] = [];

  for (const [url, catEntry] of catIndex) {
    const apprEntry = apprIndex.get(url);
    if (!apprEntry) continue; // saiu dos 3 buckets (drop, promoção a destaque, etc.) — fora de escopo
    if (catEntry.bucket === apprEntry.bucket) continue; // sem movimento
    moves.push({
      url,
      title: apprEntry.title || catEntry.title,
      from: catEntry.bucket,
      to: apprEntry.bucket,
      direction: `${catEntry.bucket}->${apprEntry.bucket}`,
    });
  }

  return moves;
}

export interface EditionMoves {
  edition: string;
  moves: BucketMove[];
}

const MONTH_DIR_RE = /^\d{4}$/;
const EDITION_DIR_RE = /^\d{6}$/;

/**
 * Descobre o path de cada edição sob `editionsDir`, suportando os dois
 * formatos coexistentes no corpus real:
 *  - pastas de mês `YYMM` (4 dígitos) contendo subpastas de edição `AAMMDD`
 *    (6 dígitos) — onde está a maioria do corpus;
 *  - pastas de edição `AAMMDD` soltas direto na raiz — formato legado.
 * Qualquer outra entrada (`replay-*`, `_arquivo`, etc.) é ignorada — não é
 * uma edição real. Uma mesma edição encontrada nos dois formatos (raiz E
 * dentro de um mês) não é contada 2x — a 1ª ocorrência encontrada vence.
 */
function discoverEditionPaths(editionsDir: string): Map<string, string> {
  const paths = new Map<string, string>();

  for (const entry of readdirSync(editionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    if (EDITION_DIR_RE.test(entry.name)) {
      if (!paths.has(entry.name)) paths.set(entry.name, join(editionsDir, entry.name));
      continue;
    }

    if (MONTH_DIR_RE.test(entry.name)) {
      const monthDir = join(editionsDir, entry.name);
      for (const sub of readdirSync(monthDir, { withFileTypes: true })) {
        if (sub.isDirectory() && EDITION_DIR_RE.test(sub.name)) {
          if (!paths.has(sub.name)) paths.set(sub.name, join(monthDir, sub.name));
        }
      }
      continue;
    }

    // Não bate em nenhum dos dois padrões (ex: `replay-*`, `_arquivo`) — nunca é edição.
  }

  return paths;
}

/**
 * Varre `editionsDir` (default: data/editions) e diffa cada edição que tem
 * AMBOS `_internal/01-categorized.json` e `_internal/01-approved.json`.
 * Edições sem um dos dois arquivos são puladas silenciosamente (comum —
 * edição em progresso, ou anterior ao formato atual).
 */
export function analyzeEditionsUnderRoot(editionsDir: string): EditionMoves[] {
  if (!existsSync(editionsDir)) return [];

  const editionPaths = discoverEditionPaths(editionsDir);
  const editions = [...editionPaths.keys()].sort();

  const results: EditionMoves[] = [];

  for (const edition of editions) {
    const editionDir = editionPaths.get(edition)!;
    const catPath = join(editionDir, "_internal", "01-categorized.json");
    const apprPath = join(editionDir, "_internal", "01-approved.json");
    if (!existsSync(catPath) || !existsSync(apprPath)) continue;

    let categorized: CategorizedBucketsInput;
    let approved: ApprovedBucketsInput;
    try {
      categorized = JSON.parse(readFileSync(catPath, "utf8"));
      approved = JSON.parse(readFileSync(apprPath, "utf8"));
    } catch (err) {
      console.error(`[analyze-bucket-overrides] ${edition}: falha ao parsear JSON — pulando (${(err as Error).message})`);
      continue;
    }

    const moves = diffBucketOverrides(categorized, approved);
    results.push({ edition, moves });
  }

  return results;
}

// ---------------------------------------------------------------------------
// --rules (#6647): agregação de category_rule — resíduo real por regra/fallback
// ---------------------------------------------------------------------------

export interface RuleUsageArticle {
  edition: string;
  bucket: Bucket;
  rule: string;
  fallback: boolean;
}

/**
 * Varre `editionsDir` (só `01-categorized.json`, `01-approved.json` não é
 * necessário aqui — a pergunta é "o que o categorizador decidiu", não "o que
 * o editor corrigiu") e coleta `{edition, bucket, rule, fallback}` para todo
 * artigo que carrega `category_rule` (#6647). Artigos sem o campo — toda
 * edição gerada antes desta mudança — são pulados silenciosamente: ausência
 * de dado, não zero-fallback.
 */
export function collectRuleUsage(editionsDir: string): RuleUsageArticle[] {
  if (!existsSync(editionsDir)) return [];

  const editionPaths = discoverEditionPaths(editionsDir);
  const editions = [...editionPaths.keys()].sort();
  const out: RuleUsageArticle[] = [];

  for (const edition of editions) {
    const editionDir = editionPaths.get(edition)!;
    const catPath = join(editionDir, "_internal", "01-categorized.json");
    if (!existsSync(catPath)) continue;

    let categorized: CategorizedBucketsInput;
    try {
      categorized = JSON.parse(readFileSync(catPath, "utf8"));
    } catch (err) {
      console.error(`[analyze-bucket-overrides] ${edition}: falha ao parsear 01-categorized.json — pulando (${(err as Error).message})`);
      continue;
    }

    for (const bucket of ALL_BUCKETS) {
      const articles = categorized[bucket];
      if (!Array.isArray(articles)) continue;
      for (const article of articles) {
        const rule = article && typeof article.category_rule === "string" ? article.category_rule : undefined;
        if (!rule) continue; // #6647: edição pré-instrumentação — sem dado, não fallback
        out.push({ edition, bucket, rule, fallback: isFallbackCategorizationRule(rule) });
      }
    }
  }

  return out;
}

export interface RuleUsageCount {
  rule: string;
  count: number;
  fallback: boolean;
}

export interface BucketRuleUsage {
  bucket: Bucket;
  total: number;
  fallback: number;
  fallbackPct: number;
}

export interface RuleUsageSummary {
  /** Edições distintas com ≥1 artigo com `category_rule` presente. */
  editionsWithRuleData: number;
  /** Total de artigos com `category_rule` presente (across os 4 buckets). */
  articlesWithRule: number;
  /** Subconjunto de `articlesWithRule` cuja regra é um dos 2 defaults do motor. */
  fallbackArticles: number;
  /** `fallbackArticles / articlesWithRule` × 100 (0 quando não há dado). */
  fallbackPct: number;
  /** Contagem por regra, ordenado desc por `count`. */
  byRule: RuleUsageCount[];
  /** Contagem + taxa de fallback por bucket, ordenado desc por `total`. */
  byBucket: BucketRuleUsage[];
}

/** Puro e determinístico sobre a lista que `collectRuleUsage` devolve. */
export function summarizeRuleUsage(entries: RuleUsageArticle[]): RuleUsageSummary {
  const editionsWithRuleData = new Set(entries.map((e) => e.edition)).size;
  const articlesWithRule = entries.length;
  const fallbackArticles = entries.filter((e) => e.fallback).length;

  const ruleCounts = new Map<string, RuleUsageCount>();
  for (const e of entries) {
    const cur = ruleCounts.get(e.rule) ?? { rule: e.rule, count: 0, fallback: e.fallback };
    cur.count += 1;
    ruleCounts.set(e.rule, cur);
  }
  const byRule = [...ruleCounts.values()].sort((a, b) => b.count - a.count);

  const bucketCounts = new Map<Bucket, { total: number; fallback: number }>();
  for (const e of entries) {
    const cur = bucketCounts.get(e.bucket) ?? { total: 0, fallback: 0 };
    cur.total += 1;
    if (e.fallback) cur.fallback += 1;
    bucketCounts.set(e.bucket, cur);
  }
  const byBucket: BucketRuleUsage[] = [...bucketCounts.entries()]
    .map(([bucket, v]) => ({
      bucket,
      total: v.total,
      fallback: v.fallback,
      fallbackPct: v.total > 0 ? (v.fallback / v.total) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    editionsWithRuleData,
    articlesWithRule,
    fallbackArticles,
    fallbackPct: articlesWithRule > 0 ? (fallbackArticles / articlesWithRule) * 100 : 0,
    byRule,
    byBucket,
  };
}

function renderRuleUsageReport(summary: RuleUsageSummary): string {
  const lines: string[] = [];
  if (summary.articlesWithRule === 0) {
    lines.push(
      "[analyze-bucket-overrides --rules] 0 artigos com category_rule no corpus — nenhuma edição sob " +
        "data/editions/ foi gerada com o categorizador instrumentado (#6647) ainda.",
    );
    return lines.join("\n");
  }

  lines.push(`edições com dado (≥1 artigo com category_rule): ${summary.editionsWithRuleData}`);
  lines.push(`artigos com category_rule: ${summary.articlesWithRule}`);
  lines.push(
    `resíduo (fallback lancamento-default/noticias-default): ${summary.fallbackArticles} de ` +
      `${summary.articlesWithRule} (${summary.fallbackPct.toFixed(1)}%)`,
  );
  lines.push("");

  lines.push("POR BUCKET:");
  for (const b of summary.byBucket) {
    lines.push(
      `  ${b.bucket.padEnd(12)} total ${String(b.total).padStart(4)}  fallback ${String(b.fallback).padStart(4)} ` +
        `(${b.fallbackPct.toFixed(1)}%)`,
    );
  }
  lines.push("");

  lines.push("POR REGRA (desc por contagem):");
  for (const r of summary.byRule) {
    lines.push(`  ${r.fallback ? "[fallback] " : "           "}${r.rule.padEnd(40)} ${String(r.count).padStart(4)}`);
  }

  return lines.join("\n");
}

export interface DirectionSummary {
  direction: string;
  from: Bucket;
  to: Bucket;
  count: number;
  examples: BucketMove[];
}

export interface AnalysisSummary {
  editionsScanned: number;
  editionsWithMoves: number;
  totalMoves: number;
  directions: DirectionSummary[];
  /** Taxa em janela (#5995 item 5). Null só quando não há edições no corpus. */
  windowed: WindowedRate | null;
}

export interface WindowedRate {
  /** Tamanho da janela pedido via --window (default 20). */
  requested: number;
  /** Edições efetivamente dentro da janela (min(requested, corpus)). */
  editionsInWindow: number;
  /** true quando o corpus era menor que a janela e a janela foi ajustada pra baixo. */
  clamped: boolean;
  /** Edições na janela com ≥1 movimentação. */
  editionsWithMoves: number;
  /** Total de movimentações dentro da janela — NÃO cumulativo. */
  totalMoves: number;
  /** movimentos / edição na janela (0 quando janela vazia). */
  movesPerEdition: number;
  /** % de edições na janela com ≥1 movimentação (0–100; 0 quando vazia). */
  pctEditionsWithMoves: number;
}

/**
 * Critério de fechamento do #5995 em forma de TAXA EM JANELA (item 5,
 * comentário de 25/08/2026): o alvo "TOTAL ≤35" é inalcançável porque TOTAL
 * é cumulativo sobre um corpus que só cresce. O que mede "quão errado o
 * categorizador está HOJE" é a taxa sobre as últimas N edições.
 *
 * Puro e determinístico sobre a lista ordenada ascendente por AAMMDD que
 * `analyzeEditionsUnderRoot` devolve: pega as últimas `window` edições e
 * computa movimentos/edição e % de edições com ≥1 movimento nessa janela —
 * nunca no acumulado histórico.
 */
export function computeWindowedRate(editionMoves: EditionMoves[], window: number): WindowedRate {
  const requested = Math.max(1, Math.floor(window));
  const slice = editionMoves.slice(-requested);
  const totalMoves = slice.reduce((acc, e) => acc + e.moves.length, 0);
  const editionsWithMoves = slice.filter((e) => e.moves.length > 0).length;
  return {
    requested,
    editionsInWindow: slice.length,
    clamped: slice.length < requested,
    editionsWithMoves,
    totalMoves,
    movesPerEdition: slice.length > 0 ? totalMoves / slice.length : 0,
    pctEditionsWithMoves: slice.length > 0 ? (editionsWithMoves / slice.length) * 100 : 0,
  };
}

/**
 * Todas as 6 direções ordenadas possíveis entre os 3 buckets rastreados —
 * impressas mesmo com contagem 0, pra a matriz ficar completa (a #5995
 * documentou 5 direções observadas + 1 implicitamente ausente,
 * radar->lancamento).
 */
function allDirectionPairs(): Array<[Bucket, Bucket]> {
  const pairs: Array<[Bucket, Bucket]> = [];
  for (const from of TRACKED_BUCKETS) {
    for (const to of TRACKED_BUCKETS) {
      if (from === to) continue;
      pairs.push([from, to]);
    }
  }
  return pairs;
}

export function summarize(
  editionMoves: EditionMoves[],
  examplesPerDirection: number,
  window = DEFAULT_WINDOW,
): AnalysisSummary {
  const allMoves = editionMoves.flatMap((e) => e.moves);
  const editionsWithMoves = editionMoves.filter((e) => e.moves.length > 0).length;

  const directions: DirectionSummary[] = allDirectionPairs().map(([from, to]) => {
    const direction = `${from}->${to}`;
    const matching = allMoves.filter((m) => m.direction === direction);
    return {
      direction,
      from,
      to,
      count: matching.length,
      examples: matching.slice(0, examplesPerDirection),
    };
  });

  directions.sort((a, b) => b.count - a.count);

  return {
    editionsScanned: editionMoves.length,
    editionsWithMoves,
    totalMoves: allMoves.length,
    directions,
    windowed: editionMoves.length > 0 ? computeWindowedRate(editionMoves, window) : null,
  };
}

function renderReport(summary: AnalysisSummary): string {
  const lines: string[] = [];
  lines.push(`edições processadas (ambos 01-categorized.json + 01-approved.json presentes): ${summary.editionsScanned}`);
  lines.push(
    `edições com ≥1 movimentação de bucket: ${summary.editionsWithMoves} de ${summary.editionsScanned}` +
      (summary.editionsScanned > 0 ? ` (${Math.round((summary.editionsWithMoves / summary.editionsScanned) * 100)}%)` : ""),
  );
  lines.push("");
  lines.push("MOVIMENTAÇÕES (categorizador → editor):");
  for (const d of summary.directions) {
    const pct = summary.totalMoves > 0 ? ` (${Math.round((d.count / summary.totalMoves) * 100)}%)` : "";
    lines.push(`  ${d.from.padEnd(12)} → ${d.to.padEnd(12)} ${String(d.count).padStart(4)}${pct}`);
  }
  lines.push(`  ${"TOTAL".padEnd(27)} ${String(summary.totalMoves).padStart(4)}`);
  lines.push("");

  if (summary.windowed) {
    const w = summary.windowed;
    lines.push(
      `TAXA EM JANELA (#5995 item 5 — critério de fechamento, últimas ${w.editionsInWindow} edições` +
        (w.clamped ? `, janela pedida de ${w.requested} ajustada ao tamanho do corpus` : "") + `):`,
    );
    lines.push(`  movimentos/edição:            ${w.movesPerEdition.toFixed(2)} (${w.totalMoves} em ${w.editionsInWindow})`);
    lines.push(
      `  edições com ≥1 movimentação:  ${w.editionsWithMoves} de ${w.editionsInWindow} (${Math.round(w.pctEditionsWithMoves)}%)`,
    );
    lines.push("  — a taxa em janela substitui o TOTAL cumulativo como critério: o acumulado histórico só cresce e nunca fecha.");
    lines.push("");
  }
  for (const d of summary.directions) {
    if (d.examples.length === 0) continue;
    lines.push(`Exemplos ${d.from} → ${d.to}:`);
    for (const ex of d.examples) {
      lines.push(`  - ${ex.title || "(sem título)"} — ${ex.url}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const editionsDirArg = args["editions-dir"] ?? "data/editions";
  const editionsDir = editionsDirArg.startsWith("/") ? editionsDirArg : resolve(ROOT, editionsDirArg);
  const asJson = "json" in args || process.argv.includes("--json");
  const rulesMode = "rules" in args || process.argv.includes("--rules"); // #6647

  if (rulesMode) {
    const entries = collectRuleUsage(editionsDir);
    const ruleSummary = summarizeRuleUsage(entries);
    if (asJson) {
      console.log(JSON.stringify(ruleSummary, null, 2));
      return;
    }
    console.log(renderRuleUsageReport(ruleSummary));
    return;
  }

  const examplesPerDirection = args["examples"] ? Number.parseInt(args["examples"], 10) : 5;
  const windowArg = args["window"] ? Number.parseInt(args["window"], 10) : DEFAULT_WINDOW;
  const window = Number.isFinite(windowArg) && windowArg > 0 ? windowArg : DEFAULT_WINDOW;

  const editionMoves = analyzeEditionsUnderRoot(editionsDir);
  const summary = summarize(editionMoves, Number.isFinite(examplesPerDirection) ? examplesPerDirection : 5, window);

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (summary.editionsScanned === 0) {
    console.log(
      `[analyze-bucket-overrides] 0 edições encontradas em ${editionsDir} — sem corpus local para analisar ` +
        `(esperado em worktree de subagente sem a junction data/; ver CLAUDE.md item 2b).`,
    );
    return;
  }

  console.log(renderReport(summary));
}

if (isMainModule(import.meta.url)) {
  main();
}
