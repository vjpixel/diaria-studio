/**
 * load-carry-over.ts (#655)
 *
 * Reaproveita candidatos não-selecionados da edição anterior como inputs
 * do Stage 1 da edição atual. Roda entre os researchers e o dedup —
 * carry-over passa por dedup/categorize/score normalmente, então duplicatas
 * com novas coletas são resolvidas naturalmente.
 *
 * Filtros aplicados:
 *  - Excluir URLs aprovadas na edição anterior (já viraram destaque/seção)
 *  - Excluir artigos com score < score-min (default 60)
 *  - Excluir artigos com published_at fora da janela [window-start, window-end]
 *  - Excluir artigos com URL já presente no pool atual
 *
 * Cada artigo carregado recebe `flag: "carry_over"` + `carry_over_from: AAMMDD`,
 * exibidos como marker `[carry-over de AAMMDD]` no 01-categorized.md.
 *
 * Edição N=1 (sem anterior): exit 0 silencioso, pool inalterado.
 *
 * Uso:
 *   npx tsx scripts/load-carry-over.ts \
 *     --edition-dir data/editions/{AAMMDD} \
 *     --pool data/editions/{AAMMDD}/_internal/tmp-articles-raw.json \
 *     --window-start YYYY-MM-DD \
 *     --window-end   YYYY-MM-DD \
 *     [--score-min 60] \
 *     [--editions-dir data/editions]
 *
 * Output stdout JSON: `{ prev, candidates_total, kept, skipped, total_pool_size }`.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPreviousEditionDate } from "./lib/edition-utils.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PoolArticle {
  url: string;
  flag?: string;
  carry_over_from?: string;
  [k: string]: unknown;
}

interface CategorizedArticle {
  url: string;
  title?: string;
  summary?: string;
  published_at?: string;
  date?: string;
  score?: number;
  source?: string;
  category?: string;
  flag?: string;
  [k: string]: unknown;
}

interface CategorizedJson {
  highlights?: Array<{ url?: string; article?: { url?: string } }>;
  runners_up?: Array<{ url?: string; article?: { url?: string } } | CategorizedArticle>;
  lancamento?: CategorizedArticle[];
  pesquisa?: CategorizedArticle[];
  noticias?: CategorizedArticle[];
  tutorial?: CategorizedArticle[];
  video?: CategorizedArticle[];
}

interface ApprovedJson {
  highlights?: Array<{ url?: string; article?: { url?: string } }>;
  lancamento?: Array<{ url?: string; article?: { url?: string } } | CategorizedArticle>;
  pesquisa?: Array<{ url?: string; article?: { url?: string } } | CategorizedArticle>;
  noticias?: Array<{ url?: string; article?: { url?: string } } | CategorizedArticle>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Coleta URLs aprovadas em todos os buckets da edição anterior. */
export function collectApprovedUrls(approved: ApprovedJson | null): Set<string> {
  const urls = new Set<string>();
  if (!approved) return urls;
  const buckets: Array<unknown> = [
    ...(approved.highlights ?? []),
    ...(approved.lancamento ?? []),
    ...(approved.pesquisa ?? []),
    ...(approved.noticias ?? []),
  ];
  for (const item of buckets) {
    if (!item || typeof item !== "object") continue;
    const obj = item as { url?: string; article?: { url?: string } };
    const url = obj.url ?? obj.article?.url;
    if (url) urls.add(url);
  }
  return urls;
}

/** Achata todos os artigos categorizados (não-aprovados) da edição anterior. */
export function flattenCategorized(categorized: CategorizedJson): CategorizedArticle[] {
  const all: CategorizedArticle[] = [];

  // runners_up pode ter shape { url, article } ou ser o próprio artigo
  for (const r of categorized.runners_up ?? []) {
    if (!r || typeof r !== "object") continue;
    const wrapped = r as { article?: CategorizedArticle; url?: string };
    if (wrapped.article && wrapped.article.url) {
      all.push(wrapped.article);
    } else if (wrapped.url) {
      all.push(wrapped as CategorizedArticle);
    }
  }

  for (const bucket of [
    categorized.lancamento,
    categorized.pesquisa,
    categorized.noticias,
    categorized.tutorial,
    categorized.video,
  ]) {
    for (const a of bucket ?? []) {
      if (a && a.url) all.push(a);
    }
  }
  return all;
}

interface FilterOpts {
  approvedUrls: Set<string>;
  poolUrls: Set<string>;
  windowStart: string; // YYYY-MM-DD
  windowEnd: string;   // YYYY-MM-DD
  scoreMin: number;
  /**
   * #1278: bypassa scoreMin para artigos com flag `editor_submitted`. Caso
   * de uso: vídeo curta_animacao na 260514 entrou no pool mas foi filtrado
   * por score baixo (bucket video sem seção); editor pediu pra recuperar
   * em 260515. Default false (back-compat).
   */
  includeEditorSubmitted?: boolean;
}

/**
 * Anota artigos kept como carry-over (#658 review B + N3):
 *  - Preserva qualquer `flag` já setado pelo pipeline (defensivo — futuras flags
 *    como `primary_source` (#487) ou novas não precisam ser mantidas
 *    explicitamente em uma allowlist)
 *  - Default `flag: "carry_over"` quando o artigo não tinha flag prévio
 *  - Sempre seta `carry_over_from: prevAammdd` (renderer usa esse campo, não
 *    o flag, para o marker `[carry-over de AAMMDD]`)
 */
export function annotateCarryOver(
  articles: CategorizedArticle[],
  prevAammdd: string,
): PoolArticle[] {
  return articles.map((a) => ({
    ...a,
    flag: a.flag ?? "carry_over",
    carry_over_from: prevAammdd,
  }));
}

/** Aplica filtros editoriais. Exporta pra testar. */
export function filterCarryOver(
  articles: CategorizedArticle[],
  opts: FilterOpts,
): { kept: CategorizedArticle[]; skipped: { url: string; reason: string }[] } {
  const kept: CategorizedArticle[] = [];
  const skipped: { url: string; reason: string }[] = [];
  for (const a of articles) {
    if (opts.approvedUrls.has(a.url)) {
      skipped.push({ url: a.url, reason: "approved_in_prev" });
      continue;
    }
    if (opts.poolUrls.has(a.url)) {
      skipped.push({ url: a.url, reason: "already_in_pool" });
      continue;
    }
    const score = typeof a.score === "number" ? a.score : -Infinity;
    // #1278: editor_submitted bypassa scoreMin quando flag opt-in ativo.
    // Mantém todas validações (already_in_pool, window) — só pula score.
    const isEditorSubmitted =
      opts.includeEditorSubmitted &&
      (a.flag === "editor_submitted" ||
        a.source === "inbox" ||
        a.flag === "newsletter_extracted");
    if (!isEditorSubmitted && score < opts.scoreMin) {
      skipped.push({ url: a.url, reason: `score<${opts.scoreMin}` });
      continue;
    }
    const rawDate = (a.published_at ?? a.date ?? "").slice(0, 10);
    if (!rawDate) {
      skipped.push({ url: a.url, reason: "missing_date" });
      continue;
    }
    if (rawDate < opts.windowStart || rawDate > opts.windowEnd) {
      skipped.push({ url: a.url, reason: "outside_window" });
      continue;
    }
    kept.push(a);
  }
  return { kept, skipped };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      args[cur.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

/**
 * Lê arquivo JSON com fallback gracioso (#867):
 *   - File missing → null (sem warn — caso esperado)
 *   - JSON inválido → null + warn no stderr
 *
 * Exportada pra teste unitário; também usada internamente por `main()`
 * pra carregar pool/categorized/approved sem crashar em writes interrompidas.
 */
export function readJsonOrNull<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    console.error(`load-carry-over: falha ao ler ${path}: ${(e as Error).message}`);
    return null;
  }
}

function writePoolAtomic(poolPath: string, pool: PoolArticle[]): void {
  const tmpPath = poolPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(pool, null, 2) + "\n", "utf8");
  renameSync(tmpPath, poolPath);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const editionDir = args["edition-dir"];
  const poolPath = args["pool"];
  const windowStart = args["window-start"];
  const windowEnd = args["window-end"];
  const scoreMin = args["score-min"] ? Number(args["score-min"]) : 60;
  // #1278: --include-editor-submitted bypassa scoreMin pra editor_submitted /
  // newsletter_extracted / source:inbox. Permite recuperar submissões do
  // editor que foram filtradas por score baixo na edição anterior.
  const includeEditorSubmitted = process.argv.includes(
    "--include-editor-submitted",
  );
  const editionsDir = args["editions-dir"]
    ? resolve(ROOT, args["editions-dir"])
    : resolve(ROOT, "data", "editions");

  if (!editionDir || !poolPath || !windowStart || !windowEnd) {
    console.error(
      "Uso: load-carry-over.ts --edition-dir <dir> --pool <path> --window-start YYYY-MM-DD --window-end YYYY-MM-DD [--score-min 60] [--include-editor-submitted] [--editions-dir <dir>]",
    );
    process.exit(1);
  }

  const editionDirAbs = resolve(ROOT, editionDir);
  const poolPathAbs = resolve(ROOT, poolPath);
  const currentAammdd = basename(editionDirAbs);

  const prev = getPreviousEditionDate(currentAammdd, editionsDir);
  if (!prev) {
    // #867: pool pode estar corrompido (write parcial em interrupção mid-stage).
    // Usar readJsonOrNull p/ não crashar — pool ilegível = tratar como vazio.
    const noPrevPool = readJsonOrNull<PoolArticle[]>(poolPathAbs) ?? [];
    console.log(
      JSON.stringify({
        prev: null,
        candidates_total: 0,
        kept: 0,
        skipped: 0,
        total_pool_size: noPrevPool.length,
        reason: "no_previous_edition",
      }),
    );
    process.exit(0);
  }

  const prevDir = resolve(editionsDir, prev);
  const categorizedPath = resolve(prevDir, "_internal", "01-categorized.json");
  const approvedPath = resolve(prevDir, "_internal", "01-approved.json");

  const categorized = readJsonOrNull<CategorizedJson>(categorizedPath);
  if (!categorized) {
    console.log(
      JSON.stringify({
        prev,
        candidates_total: 0,
        kept: 0,
        skipped: 0,
        total_pool_size: 0,
        reason: "prev_categorized_missing",
      }),
    );
    process.exit(0);
  }

  const approved = readJsonOrNull<ApprovedJson>(approvedPath);
  const approvedUrls = collectApprovedUrls(approved);
  const candidates = flattenCategorized(categorized);

  // Pool atual — usa readJsonOrNull pra evitar crash em pool corrompido
  // (ex: write interrompida mid-Stage 1, partial JSON). Pool ilegível =
  // tratar como vazio + warn no stderr (#867).
  const pool: PoolArticle[] = readJsonOrNull<PoolArticle[]>(poolPathAbs) ?? [];
  if (existsSync(poolPathAbs) && pool.length === 0) {
    // Existência + vazio = pool legível mas sem entries OU pool ilegível.
    // readJsonOrNull já loga o erro de parse no stderr quando aplica.
    // Aqui só sinalizamos que o caminho existia.
    const stat = readFileSync(poolPathAbs, "utf8").trim();
    if (stat.length > 0 && stat !== "[]") {
      console.error(
        `[load-carry-over] pool em ${poolPathAbs} ilegível ou shape inesperado — prosseguindo sem carry-over`,
      );
    }
  }
  const poolUrls = new Set(pool.map((a) => a.url));

  const { kept, skipped } = filterCarryOver(candidates, {
    approvedUrls,
    poolUrls,
    windowStart,
    windowEnd,
    scoreMin,
    includeEditorSubmitted,
  });

  const carryArticles: PoolArticle[] = annotateCarryOver(kept, prev);

  const merged: PoolArticle[] = [...pool, ...carryArticles];
  writePoolAtomic(poolPathAbs, merged);

  console.log(
    JSON.stringify({
      prev,
      candidates_total: candidates.length,
      kept: carryArticles.length,
      skipped: skipped.length,
      total_pool_size: merged.length,
    }),
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
const _isMain =
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`;
if (_isMain) {
  try {
    main();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
