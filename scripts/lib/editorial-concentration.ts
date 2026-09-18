/**
 * scripts/lib/editorial-concentration.ts (#8370, Peça 3)
 *
 * Mede a concentração editorial do acervo mês a mês: % big-tech/lab, %
 * Brasil, % de itens `exploracao` publicados, e CTR exploração vs. resto.
 * Sem isso, as Peças 1 (demanda como fonte de discovery, #8366) e 2 (cota de
 * exploração no scorer, decisão editorial do N) viram loop novo — a #8370
 * é explícita: nenhuma das duas se justifica sem um número que meça se
 * mudou algo depois de implementadas.
 *
 * ## Método — reproduz o proxy da issue, não reinventa
 *
 * A issue já mediu isto à mão (tabela-baseline set/2025–set/2026) com um
 * proxy simples: regex em `<title>` + `<meta name="description">` das
 * páginas de `workers/site/public/p/`, agrupadas por mês do `lastmod`. Esta
 * lib reproduz o MESMO proxy, com 2 ajustes deliberados sobre o texto da
 * issue:
 *
 * 1. **Data por mês vem do `sitemap.xml` local**, não de `<lastmod>` dentro
 *    de cada página. `sitemapEntriesForPosts`/`publishDateToIso`
 *    (`site-archive-pages.ts`) já resolvem a data EDITORIAL — honrando
 *    `beehiiv-publish-date-overrides.json` (#4796) — e escrevem o resultado
 *    no `sitemap.xml` publicado; reler esse arquivo dá a mesma data sem
 *    reimplementar a resolução (que depende de `data/`, ausente neste
 *    worktree — ver docstring de `resolvePublishTimestampMs`). Nunca usar
 *    `publish_date` cru: as edições importadas em bloco em 04/09/2025
 *    carregam a data da IMPORTAÇÃO, e jogariam agosto/2025 inteiro em
 *    setembro (mesmo achado que a PR #8358 confirmou pra `editorialDate()`).
 * 2. **270 páginas, não 259.** O JSON-LD `NewsArticle` (#8336/#8358) só
 *    existe em 259 das 270 páginas do acervo (medido ao vivo nesta PR — 11
 *    páginas mais antigas não o carregam). O `sitemap.xml`, por outro lado,
 *    tem `<lastmod>` pras 270 — é a fonte mais completa disponível
 *    localmente, e a mesma resolução de data das outras 259 (mesmo gerador,
 *    `sitemapEntriesForPosts`). Por isso a data vem do sitemap, e não do
 *    JSON-LD por página.
 *
 * `<title>` = sempre o D1 da edição (`derivePageTitle`); `<meta
 * name="description">` = D1 + ". " + D2|D3 (`ownEditionDescription`, ver
 * `site-archive-pages.ts`) — por construção, splitar a description no `. `
 * inicial e depois em `" | "` recupera os títulos dos até 3 destaques da
 * página. Cada página vira de 1 a 3 "itens" (destaques); a % é sobre ITENS,
 * não sobre páginas — replica o "89 destaques em 23 edições" da tabela-
 * baseline da issue, não "23 páginas".
 *
 * ## Ressalva de método (parte do produto, não rodapé — a issue é explícita
 * sobre isso: é proxy por regex, não leitura de corpo)
 *
 * - Falso positivo/negativo de keyword: um destaque que MENCIONA uma
 *   big-tech de passagem (ex: comparação) conta como "sobre" ela; um que
 *   usa sinônimo fora da lista não conta.
 * - A lista de termos Brasil é curada por esta PR, não pela issue original
 *   (que não publicou a lista usada na tabela-baseline) — os números desta
 *   lib podem divergir da tabela por causa disso, não só por causa dos
 *   ajustes 1/2 acima. Ver `RESULTADO DIVERGE DO BASELINE?` no CLI.
 * - Parte da alta de big-tech em 2026 é ciclo real de lançamentos (Fable,
 *   Opus 5, Gemini) — correlação com o loop de reforço do scorer, não prova
 *   de causa.
 *
 * ## `exploracao`/CTR — degradação graciosa (Peça 2 ainda não existe)
 *
 * O campo `exploracao` nasce só com a Peça 2 (cota de exploração no
 * scorer), que depende de decisão editorial (N slots/semana) fora de
 * escopo desta PR. Nenhuma fonte no repo hoje marca um item como
 * `exploracao` (grep confirmado nesta PR) — as páginas estáticas do acervo
 * também não carregam esse metadado. `computeExploracaoSignal` sempre
 * retorna `null` até que exista uma fonte real; o parâmetro `flags` já
 * aceita um mapa slug→boolean pronto pra quando a Peça 2 landar (ex: lendo
 * `_internal/02-scored.json` por edição, ou um campo equivalente
 * replicado pro acervo estático).
 */

export interface PageSignal {
  slug: string;
  /** Textos dos até 3 destaques desta página (D1 primeiro). */
  items: string[];
}

/** Uma linha do `<url>...</url>` do sitemap, já resolvida. */
export interface SitemapEntry {
  slug: string;
  lastmod: string | undefined;
}

export interface MonthlyConcentrationRow {
  /** `"YYYY-MM"`. */
  month: string;
  editions: number;
  destaques: number;
  bigTechCount: number;
  brasilCount: number;
  bigTechPct: number;
  brasilPct: number;
  /** `null` — Peça 2 (campo `exploracao`) ainda não existe em nenhuma fonte. */
  exploracaoPct: number | null;
  exploracaoCtr: number | null;
  restCtr: number | null;
}

/**
 * Termos que classificam um destaque como "sobre" big-tech/lab de fronteira.
 * Mesma lista que a issue cita no proxy original (OpenAI/ChatGPT,
 * Google/Gemini, Anthropic/Claude, Meta, Microsoft/Copilot, Nvidia, xAI,
 * Apple) — `\b` nas siglas curtas (`ia`, `x`) seria ruído, por isso usa
 * palavras completas/marcas, nunca sigla solta.
 */
const BIG_TECH_TERMS = [
  "openai",
  "chatgpt",
  "gpt-",
  "google",
  "gemini",
  "anthropic",
  "claude",
  "meta ",
  "instagram",
  "whatsapp",
  "microsoft",
  "copilot",
  "nvidia",
  "xai",
  "grok",
  "apple",
  "siri",
] as const;

/**
 * Termos que classificam um destaque como "sobre" o Brasil — instituições,
 * empresas e iniciativas nacionais mais comuns na cobertura da diária.
 * Curada por esta PR (a issue não publicou a lista usada na tabela-
 * baseline) — ver ressalva de método na docstring do módulo.
 */
const BRASIL_TERMS = [
  "brasil",
  "brasileir",
  "governo federal",
  "planalto",
  "anatel",
  "anpd",
  "stf",
  "senado",
  "câmara dos deputados",
  "camara dos deputados",
  "banco central",
  "bndes",
  "itaú",
  "itau",
  "nubank",
  "totvs",
  "petrobras",
  "embraer",
  "fiocruz",
  "usp",
  "unicamp",
  "senai",
  "sebrae",
  "fapesp",
  "tse",
  "receita federal",
  "sus",
  "rio de janeiro",
  "são paulo",
  "sao paulo",
] as const;

function containsAny(haystackLower: string, terms: readonly string[]): boolean {
  return terms.some((term) => haystackLower.includes(term));
}

export function classifyItem(text: string): { bigTech: boolean; brasil: boolean } {
  const lower = text.toLowerCase();
  return { bigTech: containsAny(lower, BIG_TECH_TERMS), brasil: containsAny(lower, BRASIL_TERMS) };
}

/**
 * Extrai `<title>` e `<meta name="description">` de uma página do acervo e
 * decompõe em 1-3 itens (destaques), reproduzindo o formato de
 * `ownEditionDescription` (`site-archive-pages.ts`): description = título
 * (D1) + `". "` + D2|D3 (`" | "`-separado, quando existem).
 *
 * `null` quando a página não tem `<title>` (nunca deveria acontecer nas 270
 * páginas do acervo, mas degrada em vez de lançar — arquivo corrompido/
 * truncado não pode derrubar o script inteiro).
 */
export function parsePageSignal(html: string, slug: string): PageSignal | null {
  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  const title = titleMatch?.[1]?.trim();
  if (!title) return null;

  const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/);
  const description = descMatch?.[1]?.trim();

  const items = [title];
  if (description) {
    // `ownEditionDescription` sempre começa com `${title}. ` quando há
    // D2/D3 — a description é HTML-escapada (`&amp;` etc.), então comparar
    // com o título cru pode não bater 1:1; nesse caso trata a description
    // inteira como "resto" em vez de descartar o sinal.
    const prefix = `${title}. `;
    const rest = description.startsWith(prefix) ? description.slice(prefix.length) : description;
    const restTrimmed = rest.trim();
    if (restTrimmed && restTrimmed !== title) {
      for (const part of restTrimmed.split(" | ")) {
        const trimmed = part.trim().replace(/…$/, "");
        if (trimmed) items.push(trimmed);
      }
    }
  }
  return { slug, items };
}

/**
 * Parseia `sitemap.xml` em pares `{slug, lastmod}` — um por `<url>`. Não
 * assume `<loc>`/`<lastmod>` numa ordem fixa em relação a outras entradas;
 * split por bloco `<url>...</url>` isola cada entrada antes de extrair.
 * `lastmod: undefined` quando a entrada não tem a tag (mesmo fail-soft do
 * `<lastmod>` opcional documentado em `sitemapEntryFromPost`).
 */
export function parseSitemapEntries(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const body = block[1];
    const locMatch = body.match(/<loc>([^<]*)<\/loc>/);
    const loc = locMatch?.[1];
    if (!loc) continue;
    const slugMatch = loc.match(/\/p\/([^/]+)\/?$/);
    if (!slugMatch) continue; // páginas fora de /p/ (ex: home) não entram no acervo.
    const lastmodMatch = body.match(/<lastmod>\s*(\d{4}-\d{2}-\d{2})/);
    entries.push({ slug: slugMatch[1], lastmod: lastmodMatch?.[1] });
  }
  return entries;
}

export function monthKey(isoDate: string): string | undefined {
  const match = isoDate.match(/^(\d{4}-\d{2})-\d{2}$/);
  return match?.[1];
}

/**
 * Agrega sinais por página + data em linhas mensais. `exploracaoFlags`
 * (slug→boolean) e `ctrBySlug` (slug→CTR real) são opcionais — quando
 * ausentes ou vazios, `exploracaoPct`/`exploracaoCtr`/`restCtr` saem `null`
 * (degradação graciosa da Peça 2, ver docstring do módulo).
 */
export function aggregateByMonth(
  pages: PageSignal[],
  lastmodBySlug: Map<string, string | undefined>,
  exploracaoFlags?: Map<string, boolean>,
  ctrBySlug?: Map<string, number>,
): MonthlyConcentrationRow[] {
  interface Acc {
    editions: Set<string>;
    destaques: number;
    bigTech: number;
    brasil: number;
    exploracaoTotal: number;
    exploracaoKnown: number;
    exploracaoCtrs: number[];
    restCtrs: number[];
  }
  const byMonth = new Map<string, Acc>();

  for (const page of pages) {
    const lastmod = lastmodBySlug.get(page.slug);
    if (!lastmod) continue; // sem data resolvida, não dá pra agrupar por mês.
    const key = monthKey(lastmod);
    if (!key) continue;

    let acc = byMonth.get(key);
    if (!acc) {
      acc = {
        editions: new Set(),
        destaques: 0,
        bigTech: 0,
        brasil: 0,
        exploracaoTotal: 0,
        exploracaoKnown: 0,
        exploracaoCtrs: [],
        restCtrs: [],
      };
      byMonth.set(key, acc);
    }
    acc.editions.add(page.slug);

    const isExploracao = exploracaoFlags?.get(page.slug);
    const ctr = ctrBySlug?.get(page.slug);
    for (const item of page.items) {
      acc.destaques += 1;
      const { bigTech, brasil } = classifyItem(item);
      if (bigTech) acc.bigTech += 1;
      if (brasil) acc.brasil += 1;
    }
    if (isExploracao !== undefined) {
      acc.exploracaoKnown += 1;
      if (isExploracao) {
        acc.exploracaoTotal += 1;
        if (ctr !== undefined) acc.exploracaoCtrs.push(ctr);
      } else if (ctr !== undefined) {
        acc.restCtrs.push(ctr);
      }
    }
  }

  const rows: MonthlyConcentrationRow[] = [];
  for (const [month, acc] of [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const avg = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);
    rows.push({
      month,
      editions: acc.editions.size,
      destaques: acc.destaques,
      bigTechCount: acc.bigTech,
      brasilCount: acc.brasil,
      bigTechPct: acc.destaques === 0 ? 0 : acc.bigTech / acc.destaques,
      brasilPct: acc.destaques === 0 ? 0 : acc.brasil / acc.destaques,
      exploracaoPct: acc.exploracaoKnown === 0 ? null : acc.exploracaoTotal / acc.exploracaoKnown,
      exploracaoCtr: avg(acc.exploracaoCtrs),
      restCtr: avg(acc.restCtrs),
    });
  }
  return rows;
}
