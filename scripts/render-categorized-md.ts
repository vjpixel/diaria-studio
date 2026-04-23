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
function getDate(a: Article): string {
  const raw = a.date || a.published_at;
  if (!raw) return "????-??-??";
  // Se já vier ISO completo, cortar no T. Senão retornar como está.
  return raw.slice(0, 10);
}

/** Monta linha: `- [score] Título ⭐ [inbox] [⚠️] — https://url — YYYY-MM-DD` */
function renderLine(article: Article, isHighlight?: boolean): string {
  const scoreStr =
    typeof article.score === "number" ? `[${article.score}]` : "[--]";
  const title = article.title?.trim() || "(sem título)";
  const url = article.url;
  const date = getDate(article);

  const markers: string[] = [];
  if (isHighlight) markers.push("⭐");
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
function buildHighlightUrls(data: CategorizedJson): Set<string> {
  const urls = new Set<string>();

  // Formato novo: top-level highlights[]
  for (const h of data.highlights ?? []) {
    if (h.url) urls.add(h.url);
  }

  // Formato legado: inline em cada artigo
  for (const bucket of [data.lancamento, data.pesquisa, data.noticias]) {
    for (const a of bucket ?? []) {
      if (a.highlight) urls.add(a.url);
    }
  }

  return urls;
}

function renderSection(
  title: string,
  articles: Article[],
  highlightUrls: Set<string>
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
    renderLine(a, highlightUrls.has(a.url))
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

// ---------- Main ---------------------------------------------------------

function main() {
  const cli = parseArgs();
  const data: CategorizedJson = JSON.parse(readFileSync(cli.in, "utf8"));

  if (!data.lancamento || !data.pesquisa || !data.noticias) {
    console.error(
      `render-categorized-md: input JSON não tem os buckets esperados (lancamento/pesquisa/noticias)`
    );
    process.exit(1);
  }

  const highlightUrls = buildHighlightUrls(data);

  const header = `# Diar.ia — Edição ${cli.edition} — Research\n`;
  const instructions =
    `\n> Candidatos recomendados pelo scorer estão marcados com ⭐ nas seções abaixo.\n` +
    `> Mova **exatamente 3** linhas para a seção **Destaques** (a ordem define D1, D2, D3).\n` +
    `> Marcador \`⚠️\` indica que a data de publicação não pôde ser verificada automaticamente.\n`;

  const sections = [
    `## Destaques\n\n_(mova 3 artigos para cá)_\n`,
    renderSection("Lançamentos", data.lancamento, highlightUrls),
    renderSection("Pesquisas", data.pesquisa, highlightUrls),
    renderSection("Notícias", data.noticias, highlightUrls),
  ].join("\n");

  const footer = renderSourceHealth(cli.sourceHealth);

  const md = `${header}${instructions}\n${sections}${footer}`;
  writeFileSync(cli.out, md, "utf8");

  const total =
    data.lancamento.length + data.pesquisa.length + data.noticias.length;
  const highlighted = highlightUrls.size;
  const unverified = [
    ...data.lancamento,
    ...data.pesquisa,
    ...data.noticias,
  ].filter((a) => a.date_unverified).length;

  process.stdout.write(
    JSON.stringify({
      out: cli.out,
      total_articles: total,
      highlights_rendered: highlighted,
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
