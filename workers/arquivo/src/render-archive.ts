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
 * real ao seguir o link.
 */
import type { SitemapEntry } from "../../../scripts/lib/fetch-sitemap.ts";

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
<title>Arquivo — todas as edições da Diar.ia</title>
<meta name="description" content="Índice de todas as edições publicadas da newsletter Diar.ia, agrupadas por mês.">
<meta name="robots" content="index, follow">
</head>
<body>
  <main>
    <h1>Arquivo — todas as edições da Diar.ia</h1>
    <p>${count} ediç${count === 1 ? "ão" : "ões"} publicada${count === 1 ? "" : "s"}.</p>
${body}
  </main>
</body>
</html>
`;
}
