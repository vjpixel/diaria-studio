/**
 * workers/arquivo/src/render-archive.ts (#4105)
 *
 * Lógica pura de construção do HTML da página de arquivo: filtra o sitemap
 * pra edições reais (`/p/*`), agrupa por ano-mês (derivado do `lastmod`) e
 * renderiza `<a href>` reais — sem JS client-side, sem paginação. Separada
 * do fetch handler (`src/index.ts`) pra ser testável sem rede, mesmo padrão
 * de `scripts/build-cursos-page.ts` (ver `test/build-cursos-page.test.ts`).
 *
 * `displayText` é derivado só do slug da URL (troca `-` por espaço,
 * capitaliza a 1ª letra) — NÃO fazemos fetch de cada uma das ~223 páginas
 * pra pegar o título real (223+1 fetches por load seria lento/caro demais).
 * O objetivo é só existir o `<a href>` crawlable; o Googlebot lê o título
 * real ao seguir o link. Títulos derivados-do-slug quebrados (acentos
 * removidos viram espaço), agrupamento por `lastmod` em vez de `publish_date`
 * e navegação por 225 itens são #4105 itens 1/2/5 — FORA de escopo aqui
 * (#4265, dependem de `data/beehiiv-cache/`, sessão local).
 *
 * Design/SEO (#4265 itens 7/8/9): DS canônico da Diar.ia via
 * `scripts/lib/shared/{design-tokens,curadoria-page,seo-meta}.ts` — mesmo
 * padrão de `cursos.diar.ia.br`/`livros.diar.ia.br` (#3698). Zero JS
 * client-side (mantém o requisito original do #4105 de página 100%
 * server-rendered, sem paginação).
 */
import type { SitemapEntry } from "../../../scripts/lib/fetch-sitemap.ts";
import { FONTS } from "../../../scripts/lib/shared/design-tokens.ts";
import {
  renderCuradoriaRootStyles,
  renderCuradoriaHeaderStyles,
  renderCuradoriaFooterStyles,
  renderCuradoriaFooter,
} from "../../../scripts/lib/shared/curadoria-page.ts";
import { renderSeoMeta } from "../../../scripts/lib/shared/seo-meta.ts";
import { ARQUIVO_FOOTER_NAV_UTM } from "../../../scripts/lib/shared/utm-registry.ts";

/** URL pública canônica desta página (Workers Custom Domain, #4105/#3698). */
export const PAGE_URL = "https://arquivo.diar.ia.br/";
const PAGE_TITLE = "Arquivo — todas as edições da Diar.ia";
const PAGE_DESCRIPTION =
  "Índice de todas as edições publicadas da newsletter Diar.ia, agrupadas por mês.";

/** CSS específico da listagem (seções por mês + lista de edições) — não
 * coberto por `curadoria-page.ts` (que atende o padrão de grid de cards de
 * cursos/livros, não uma lista simples de links). */
function renderArchiveListStyles(): string {
  return `  main { padding: 40px 0 64px; }
  .count { font-family: ${FONTS.sans}; font-size: 14px; color: var(--ink); margin: 8px 0 40px; }
  section { margin: 0 0 40px; }
  section h2 { font-family: ${FONTS.serif}; font-size: 22px; font-weight: 700;
    color: var(--ink); margin: 0 0 4px; }
  section h2::first-letter { text-transform: uppercase; }
  section ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--rule); }
  section li { border-bottom: 1px solid var(--rule); }
  section li a { display: block; padding: 13px 2px; font-family: ${FONTS.sans}; font-size: 16px;
    line-height: 1.4; color: var(--ink); text-decoration: none; }
  section li a:hover { color: var(--teal); }`;
}

const MONTH_NAMES_PT = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/** Escapa HTML básico (mesmo padrão de `esc()` em build-cursos-page.ts). */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Path (`/p/slug`) de um `loc` absoluto, ou `null` se não for uma URL válida. */
function pathOf(loc: string): string | null {
  try {
    return new URL(loc).pathname;
  } catch {
    return null;
  }
}

/** Deriva um texto legível a partir do último segmento do path do `loc`
 * (o slug da edição) — troca `-` por espaço e capitaliza a 1ª letra. Slugs
 * do Beehiiv às vezes têm artefatos de acentuação removida (cosmético,
 * pré-existente, fora de escopo aqui — ver #4105). */
export function displayTextFromLoc(loc: string): string {
  const path = pathOf(loc);
  const parts = (path ?? loc).split("/").filter(Boolean);
  const slug = parts[parts.length - 1] ?? "";
  const text = slug.replace(/-/g, " ").trim();
  if (!text) return loc;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Chave de agrupamento `YYYY-MM` a partir de um `lastmod` (aceita tanto
 * `YYYY-MM-DD` quanto datetime ISO completo) — `null` se não parseável. */
function yearMonthKey(lastmod: string): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(lastmod.trim());
  return m ? `${m[1]}-${m[2]}` : null;
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  const idx = Number(month) - 1;
  const name = MONTH_NAMES_PT[idx] ?? month;
  return `${name} de ${year}`;
}

interface GroupedEntry {
  loc: string;
  lastmod: string;
}

/**
 * Constrói o HTML completo da página de arquivo a partir das entradas cruas
 * do sitemap. Filtra pra `/p/*` (edições reais — exclui home/archive/tags/
 * subscribe/authors/etc), descarta entradas sem `lastmod` (não dá pra
 * agrupar), agrupa por ano-mês, ordena os meses do mais recente pro mais
 * antigo e, dentro de cada mês, as edições também do mais recente pra mais
 * antigo. Pura — sem fetch, sem I/O. Nunca lança (lista vazia → mensagem,
 * nunca erro).
 */
export function buildArchiveHtml(entries: SitemapEntry[]): string {
  const editions: GroupedEntry[] = entries.filter(
    (e): e is GroupedEntry => {
      if (!e.lastmod) return false;
      const path = pathOf(e.loc);
      return path != null && path.startsWith("/p/");
    },
  );

  const groups = new Map<string, GroupedEntry[]>();
  for (const e of editions) {
    const key = yearMonthKey(e.lastmod);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }

  const sortedKeys = [...groups.keys()].sort().reverse();

  const sections = sortedKeys.map((key) => {
    const list = [...(groups.get(key) ?? [])].sort((a, b) =>
      b.lastmod.localeCompare(a.lastmod),
    );
    const items = list
      .map(
        (e) =>
          `      <li><a href="${esc(e.loc)}">${esc(displayTextFromLoc(e.loc))}</a></li>`,
      )
      .join("\n");
    return `    <section>\n      <h2>${esc(monthLabel(key))}</h2>\n      <ul>\n${items}\n      </ul>\n    </section>`;
  });

  const count = editions.length;
  const body =
    sections.length > 0
      ? sections.join("\n")
      : "    <p>Nenhuma edição encontrada.</p>";

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(PAGE_TITLE)}</title>
${renderSeoMeta({ title: PAGE_TITLE, description: PAGE_DESCRIPTION, url: PAGE_URL })}
<meta name="robots" content="index, follow">
<style>
${renderCuradoriaRootStyles()}

${renderCuradoriaHeaderStyles()}

${renderArchiveListStyles()}

${renderCuradoriaFooterStyles()}
</style>
</head>
<body>
  <header>
    <div class="wrap">
      <p class="eyebrow">Diar.ia · Arquivo</p>
      <hr class="rule">
      <h1>Arquivo<span class="dot" aria-hidden="true">.</span></h1>
      <p class="tagline">5 minutos diários pra se manter atualizado e usar melhor as IAs</p>
      <p class="lede">Todas as edições já publicadas da newsletter Diar.ia, agrupadas por mês.</p>
    </div>
  </header>
  <main>
    <div class="wrap">
      <p class="count">${count} ediç${count === 1 ? "ão" : "ões"} publicada${count === 1 ? "" : "s"}.</p>
${body}
    </div>
  </main>
  ${renderCuradoriaFooter(
    "diar.ia.br — arquivo de edições",
    `utm_source=${ARQUIVO_FOOTER_NAV_UTM.source}&utm_medium=${ARQUIVO_FOOTER_NAV_UTM.medium}`,
  )}
</body>
</html>
`;
}
