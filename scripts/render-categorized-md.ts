/**
 * render-categorized-md.ts
 *
 * Renderiza `01-categorized.md` de forma determinística a partir do
 * `01-categorized.json` produzido pelo scorer + research-reviewer.
 *
 * Layout:
 *   ## Destaques          — candidatos do scorer (editor mantém 3, remove o resto)
 *   ## Lançamentos        — bucket lancamento
 *   ## Pesquisas          — bucket pesquisa
 *   ## Notícias           — bucket noticias
 *   ## Aprenda hoje       — bucket tutorial (#59)
 *
 * O editor escolhe destaques movendo linhas para/de a seção Destaques.
 * A ordem física dentro de Destaques define D1/D2/D3 (de cima para baixo).
 *
 * Uso:
 *   npx tsx scripts/render-categorized-md.ts \
 *     --in  data/editions/260421/01-categorized.json \
 *     --out data/editions/260421/01-categorized.md \
 *     --edition 260421 \
 *     [--source-health data/source-health.json]
 *
 * Se `--source-health` for passado, inclui a seção "Saúde das fontes" no
 * rodapé; caso contrário, omite a seção.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

interface Article {
  url: string;
  title?: string;
  date?: string;
  /** Algumas pipelines gravam `published_at` em vez de `date`. */
  published_at?: string;
  score?: number;
  editor_submitted?: boolean;
  discovered_source?: boolean;
  date_unverified?: boolean;
  /** Marcador inline de destaque (formato legado do scorer). */
  highlight?: boolean;
  /** Rank 1..6 do scorer (formato inline). */
  rank?: number;
  [key: string]: unknown;
}

interface Highlight {
  url: string;
  [key: string]: unknown;
}

interface CategorizedJson {
  highlights?: Highlight[];
  runners_up?: unknown[];
  lancamento: Article[];
  pesquisa: Article[];
  noticias: Article[];
  tutorial?: Article[];
}

interface SourceHealth {
  sources: Record<
    string,
    {
      recent_outcomes?: Array<{ outcome: string; timestamp: string }>;
      last_outcome?: string;
      last_reason?: string;
    }
  >;
}

// ---------- CLI parsing --------------------------------------------------

function parseArgs(): {
  in: string;
  out: string;
  edition: string;
  sourceHealth?: string;
} {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = args[i + 1];
      if (val == null || val.startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = val;
        i++;
      }
    }
  }
  if (!flags.in || !flags.out || !flags.edition) {
    console.error(
      "Uso: render-categorized-md.ts --in <json> --out <md> --edition <YYMMDD> [--source-health <json>]"
    );
    process.exit(1);
  }
  return {
    in: flags.in,
    out: flags.out,
    edition: flags.edition,
    sourceHealth: flags["source-health"],
  };
}

// ---------- Rendering helpers -------------------------------------------

/** Normaliza para YYYY-MM-DD aceitando `date` ou `published_at`. */
export function getDate(a: Article): string {
  const raw = a.date || a.published_at;
  if (!raw) return "????-??-??";
  // Se já vier ISO completo, cortar no T. Senão retornar como está.
  return raw.slice(0, 10);
}

/**
 * Detecta se o TEMA do artigo é sobre o Brasil (não apenas a fonte).
 * Heurística: título ou resumo menciona Brasil/brasileiro(a), entidades
 * brasileiras conhecidas (FGV, ANPD, CVM, Petrobras, Itaú, Anatel, BNDES,
 * USP, Unicamp, Fiesp, etc.), ou cidades/estados brasileiros de destaque.
 *
 * Conteúdo publicado em `.com.br` traduzindo notícia global NÃO recebe a
 * tag — o critério é editorial (o artigo é sobre o Brasil), não o domínio.
 */
/**
 * Tier 1: sinais de alta confiança — 1 match já dispara.
 * Inclui a palavra "Brasil" em si, governo/reguladores, estatais, cidades,
 * universidades públicas, indicadores, e entidades que contêm "brasil" no nome.
 */
export const BR_TIER1_RE =
  /\b(bras(il|ileir[ao]s?|ilienses?)|braz(il|ilians?)|fgv(\s+ibre)?|anpd|cvm|petrobras|bndes|anatel|banco central do brasil|bcb|santander brasil|latam\s+brasil|mec brasil|usp|unicamp|fiesp|ibge|ipea|s[ãa]o paulo|rio de janeiro|bras[íi]lia|inovabra|tribunal (superior|de justi[çc]a)|stf|congresso nacional)\b/i;

/**
 * Tier 2: empresas BR privadas — risco de falso positivo em cobertura
 * internacional. Só dispara com 2+ matches no mesmo artigo, OU com 1 match
 * combinado com algum sinal tier 1.
 *
 * Evitamos nomes curtos/ambíguos (Vale, Stone, WEG, JBS) por risco de
 * falso positivo com palavras comuns ou siglas não-BR.
 */
export const BR_TIER2_RE =
  /\b(ita[úu]|bradesco|nubank|ifood|mercado\s+livre|magalu|magazine\s+luiza|pagseguro|picpay|xp\s+inc|btg\s+pactual|banco\s+inter|c6\s+bank|embraer|gerdau|ambev|braskem|suzano|natura\s*&\s*co|localiza|vtex|totvs|movile|creditas|hotmart)\b/gi;

export function isBrazilianTheme(article: { title?: string; summary?: string }): boolean {
  const hay = `${article.title ?? ""}\n${article.summary ?? ""}`;
  if (BR_TIER1_RE.test(hay)) return true;
  // Tier 2: exige 2+ matches distintos pra reduzir falso positivo.
  // Reset lastIndex porque regex global mantém estado entre chamadas.
  BR_TIER2_RE.lastIndex = 0;
  const matches = hay.match(BR_TIER2_RE);
  return matches !== null && matches.length >= 2;
}

/** Monta linha: `- [score] Título ⭐|✨ 🇧🇷 [inbox] (descoberta) ⚠️ — https://url — YYYY-MM-DD` */
export function renderLine(
  article: Article,
  isHighlight?: boolean,
  isRunnerUp?: boolean,
): string {
  const scoreStr =
    typeof article.score === "number" ? `[${article.score}]` : "[--]";
  const title = article.title?.trim() || "(sem título)";
  const url = article.url;
  const date = getDate(article);

  const markers: string[] = [];
  if (isHighlight) markers.push("⭐");
  else if (isRunnerUp) markers.push("✨");
  if (
    isBrazilianTheme({
      title: article.title,
      summary: typeof article.summary === "string" ? article.summary : undefined,
    })
  )
    markers.push("🇧🇷");
  if (article.editor_submitted) markers.push("[inbox]");
  if (article.discovered_source) markers.push("(descoberta)");
  if (article.date_unverified) markers.push("⚠️");

  const markerStr = markers.length > 0 ? " " + markers.join(" ") : "";
  return `- ${scoreStr} ${title}${markerStr} — ${url} — ${date}`;
}

/**
 * Coleta URLs dos candidatos a destaque. Suporta dois formatos:
 *   1. `data.highlights[]` top-level (formato novo).
 *   2. Artigos nos buckets com `highlight: true` inline (formato legado).
 */
export function buildHighlightUrls(data: CategorizedJson): Set<string> {
  const urls = new Set<string>();

  // Formato novo: top-level highlights[]
  for (const h of data.highlights ?? []) {
    if (h.url) urls.add(h.url);
  }

  // Formato legado: inline em cada artigo
  for (const bucket of [data.lancamento, data.pesquisa, data.noticias, data.tutorial]) {
    for (const a of bucket ?? []) {
      if (a.highlight) urls.add(a.url);
    }
  }

  return urls;
}

/**
 * Coleta URLs dos runners_up — candidatos com score alto que não entraram
 * no top do scorer. Renderizados com ✨ pra o editor ver o universo completo
 * de recomendações, não só o slice principal (ver #104).
 */
export function buildRunnerUpUrls(data: CategorizedJson): Set<string> {
  const urls = new Set<string>();
  for (const r of data.runners_up ?? []) {
    if (r && typeof r === "object" && "url" in r) {
      const url = (r as { url?: unknown }).url;
      if (typeof url === "string") urls.add(url);
    }
  }
  return urls;
}

function renderSection(
  title: string,
  articles: Article[],
  highlightUrls: Set<string>,
  runnerUpUrls: Set<string>,
): string {
  if (articles.length === 0) {
    return `## ${title}\n\n_(vazio)_\n`;
  }
  // Ordenar por score desc (null/undefined ao final)
  const sorted = [...articles].sort((a, b) => {
    const sa = typeof a.score === "number" ? a.score : -Infinity;
    const sb = typeof b.score === "number" ? b.score : -Infinity;
    return sb - sa;
  });
  const lines = sorted.map((a) =>
    renderLine(a, highlightUrls.has(a.url), runnerUpUrls.has(a.url)),
  );
  return `## ${title}\n\n${lines.join("\n")}\n`;
}

function renderSourceHealth(path?: string): string {
  if (!path || !existsSync(path)) return "";
  try {
    const health: SourceHealth = JSON.parse(readFileSync(path, "utf8"));
    const warnings: string[] = [];
    const streaks: string[] = [];
    for (const [name, info] of Object.entries(health.sources ?? {})) {
      const last = info.last_outcome;
      const recent = info.recent_outcomes ?? [];
      if (last && last !== "ok") {
        const reason = info.last_reason || last;
        warnings.push(`⚠️ ${name} — ${reason}`);
      }
      // streak 3+ não-ok consecutivos
      const last3 = recent.slice(-3);
      if (
        last3.length === 3 &&
        last3.every((o) => o.outcome && o.outcome !== "ok")
      ) {
        const times = last3.map((o) => o.timestamp).join(", ");
        streaks.push(
          `🔴 ${name} — 3 falhas seguidas: ${times} — considere desativar em seed/sources.csv`
        );
      }
    }
    if (warnings.length === 0 && streaks.length === 0) {
      return `\n---\n\n## Saúde das fontes\n\nTodas as fontes responderam normalmente.\n`;
    }
    const body = [...warnings, ...streaks].join("\n");
    return `\n---\n\n## Saúde das fontes\n\n${body}\n`;
  } catch (e) {
    console.error(
      `render-categorized-md: aviso — não foi possível ler source-health: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return "";
  }
}

/**
 * Auto-discovers `01-verified.json` in the same _internal/ directory as the
 * input JSON and marks articles with `verdict: "uncertain"` as
 * `date_unverified: true`. This is a hardening measure — the research-reviewer
 * normally sets this flag, but if the pipeline is re-run partially the flag
 * can be lost. The render script is the final consumer, so it cross-references
 * the verification source of truth directly.
 */
function mergeVerifiedFlags(inputPath: string, data: CategorizedJson): void {
  const dir = dirname(inputPath);
  const verifiedPath = join(dir, "01-verified.json");
  if (!existsSync(verifiedPath)) return;

  try {
    const verified: Array<{ url?: string; verdict?: string }> = JSON.parse(
      readFileSync(verifiedPath, "utf8")
    );
    const uncertainUrls = new Set(
      verified.filter((v) => v.verdict === "uncertain").map((v) => v.url)
    );
    if (uncertainUrls.size === 0) return;

    for (const bucket of [data.lancamento, data.pesquisa, data.noticias, data.tutorial]) {
      for (const a of bucket ?? []) {
        if (uncertainUrls.has(a.url)) a.date_unverified = true;
      }
    }
  } catch {
    // Non-fatal — verified.json may be malformed or unreadable
  }
}

// ---------- Main ---------------------------------------------------------

function main() {
  const cli = parseArgs();
  const data: CategorizedJson = JSON.parse(readFileSync(cli.in, "utf8"));
  mergeVerifiedFlags(cli.in, data);

  if (!data.lancamento || !data.pesquisa || !data.noticias) {
    console.error(
      `render-categorized-md: input JSON não tem os buckets esperados (lancamento/pesquisa/noticias)`
    );
    process.exit(1);
  }

  const highlightUrls = buildHighlightUrls(data);
  const runnerUpUrls = buildRunnerUpUrls(data);

  const header = `# Diar.ia — Edição ${cli.edition} — Research\n`;
  const instructions =
    `\n> Candidatos recomendados pelo scorer:\n` +
    `>   - ⭐ — top do scorer (highlights[]).\n` +
    `>   - ✨ — runners-up (próximos da lista, considerar se top não couber).\n` +
    `> Mova **exatamente 3** linhas para a seção **Destaques** (a ordem define D1, D2, D3).\n` +
    `> Marcador \`⚠️\` indica que a data de publicação não pôde ser verificada automaticamente.\n`;

  const sections = [
    `## Destaques\n\n_(mova 3 artigos para cá)_\n`,
    renderSection("Lançamentos", data.lancamento, highlightUrls, runnerUpUrls),
    renderSection("Pesquisas", data.pesquisa, highlightUrls, runnerUpUrls),
    renderSection("Notícias", data.noticias, highlightUrls, runnerUpUrls),
    ...(data.tutorial && data.tutorial.length > 0
      ? [renderSection("Aprenda hoje", data.tutorial, highlightUrls, runnerUpUrls)]
      : []),
  ].join("\n");

  const footer = renderSourceHealth(cli.sourceHealth);

  const md = `${header}${instructions}\n${sections}${footer}`;
  writeFileSync(cli.out, md, "utf8");

  const total =
    data.lancamento.length + data.pesquisa.length + data.noticias.length + (data.tutorial?.length ?? 0);
  const highlighted = highlightUrls.size;
  const unverified = [
    ...data.lancamento,
    ...data.pesquisa,
    ...data.noticias,
    ...(data.tutorial ?? []),
  ].filter((a) => a.date_unverified).length;

  process.stdout.write(
    JSON.stringify({
      out: cli.out,
      total_articles: total,
      highlights_rendered: highlighted,
      runners_up_rendered: runnerUpUrls.size,
      date_unverified: unverified,
    }) + "\n"
  );
}

const _isMain =
  process.argv[1] != null &&
  import.meta.url.endsWith(
    process.argv[1].replaceAll("\\", "/").replace(/^.*\//, "")
  );
if (_isMain) main();
