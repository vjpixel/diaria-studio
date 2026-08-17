/**
 * workers/arquivo/src/render-archive.ts (#4105)
 *
 * Lógica pura de construção do HTML da página de arquivo: filtra o sitemap
 * pra edições reais (`/p/*`), agrupa por ano-mês e renderiza `<a href>`
 * reais — sem JS client-side, sem paginação. Separada do fetch handler
 * (`src/index.ts`) pra ser testável sem rede, mesmo padrão de
 * `scripts/build-cursos-page.ts` (ver `test/build-cursos-page.test.ts`).
 *
 * **Título/data reais via `titles-cache.json` (#4265 item 1).** Antes
 * (#4105) o texto do link era derivado só do slug da URL (troca `-` por
 * espaço, capitaliza a 1ª letra) — o Beehiiv remove acentos deixando o
 * caractere vazio, produzindo palavras quebradas ("Anthropic lan a o claude
 * opus 5"). `titles-cache.json` (gerado por
 * `scripts/generate-arquivo-titles.ts` a partir de
 * `data/beehiiv-cache/posts/*.json`, COMMITADO dentro deste diretório) mapeia
 * `slug → {title, publishDate}` — o Worker importa estaticamente (build-time,
 * sem KV/fetch extra). Slug ausente do cache cai no fallback
 * `displayTextFromLoc` original (nunca derruba o `<a href>` da lista).
 *
 * **Agrupamento/data por edição (#4265 itens 2/3).** `publishDate` do cache
 * é a fonte preferida pra agrupar por mês e mostrar o dia de cada edição —
 * `lastmod` do sitemap (última MODIFICAÇÃO, não publicação) é só fallback
 * pra slugs ausentes do cache.
 *
 * **Índice por mês + CTA (#4265 itens 4/5).** Bloco de âncoras no topo
 * (`#2026-07`) — sem JS, sem paginação, mantendo o requisito original do
 * #4105 de todos os `<a href>` na mesma resposta. Rodapé com nav cruzada de
 * volta pra `diar.ia.br` (já presente desde #4265 item 9).
 *
 * **CTA de assinatura: form inline, não link puro (#5167 item 1).** Até aqui
 * era um `<a href="https://diar.ia.br/subscribe">` simples — o tráfego frio
 * de SEO/GEO que clicava ali caía no formulário HOSPEDADO NA BEEHIIV, que
 * (desde que o editor ligou o double opt-in, #5167) exige confirmar um
 * e-mail antes de virar assinante `active`. `renderCuradoriaCtaSubscribeForm`/
 * `renderCuradoriaCtaSubscribeScript` (`scripts/lib/shared/curadoria-page.ts`)
 * chamam `POST /jogar/subscribe` CROSS-ORIGIN no Worker `poll`
 * (`eia.diar.ia.br`) — mesmo mecanismo que `livros.diar.ia.br` já usa desde
 * o #4051 — que cadastra `active` na hora, ISENTO do double opt-in (a
 * caixinha de opt-in marcada aqui já é o consentimento LGPD explícito, ver
 * `workers/poll/src/subscribe.ts`). Isso introduz o único `<script>` desta
 * página fora do JSON-LD estrutural (o resto continua server-rendered, sem
 * paginação, mesmo requisito original do #4105 — só o cadastro precisa de JS
 * pra não sair da página).
 *
 * Design/SEO (#4265 itens 7/8/9, já implementados): DS canônico da diar.ia.br
 * via `scripts/lib/shared/{design-tokens,curadoria-page,seo-meta}.ts` —
 * mesmo padrão de `cursos.diar.ia.br`/`livros.diar.ia.br` (#3698).
 */
import type { SitemapEntry } from "../../../scripts/lib/fetch-sitemap.ts";
import { FONTS } from "../../../scripts/lib/shared/design-tokens.ts";
import {
  renderCuradoriaRootStyles,
  renderCuradoriaHeaderStyles,
  renderCuradoriaFooterStyles,
  renderCuradoriaFooter,
  renderCuradoriaCtaSubscribeStyles,
  renderCuradoriaCtaSubscribeForm,
  renderCuradoriaCtaSubscribeScript,
} from "../../../scripts/lib/shared/curadoria-page.ts"; // #5167 item 1: form inline substitui o link puro pro /subscribe hospedado na Beehiiv
import { renderSeoMeta, renderAnalyticsHead } from "../../../scripts/lib/shared/seo-meta.ts"; // #5498: container GTM
import { COVER_IMAGE_WIDTH, COVER_IMAGE_HEIGHT } from "../../../scripts/lib/shared/cover-image.ts"; // #5131
import { ARQUIVO_FOOTER_NAV_UTM } from "../../../scripts/lib/shared/utm-registry.ts";
import {
  renderGeoByline,
  renderGeoFaqSection,
  renderGeoFaqStyles,
  renderGeoJsonLd,
  type GeoFaqItem,
} from "../../../scripts/lib/shared/geo-faq.ts"; // #4558 Parte B: estrutura GEO (FAQ + JSON-LD FAQPage/Article + autoria)
import { HUB_META } from "./hubs/meta.ts"; // #4558 Parte A: navegação "Por tema" — só slug+rótulo, nunca o HTML gerado
import type { HubMeta } from "./hubs/meta.ts";
import titlesCacheRaw from "./titles-cache.json";

/** Shape de cada entrada do cache (espelha `ArquivoTitleEntry` de
 * `scripts/generate-arquivo-titles.ts` — não importado direto pra manter
 * este arquivo livre de dependência do gerador Node, só do JSON gerado).
 * Exportado só pra tipar o `cacheOverride` de teste de `buildArchiveHtml`. */
export interface TitleCacheEntry {
  title: string;
  /** `YYYY-MM-DD`. */
  publishDate: string;
  /** URL da capa da edição (#5131) — ver `ArquivoTitleEntry.coverImageUrl`
   * em `scripts/generate-arquivo-titles.ts` pra origem/rationale. Opcional:
   * ausente até uma sessão local regenerar `titles-cache.json` com o campo
   * novo (ver docstring daquele script), e opcional pra sempre em posts sem
   * thumbnail associada. */
  coverImageUrl?: string;
}

export type TitlesCacheMap = Record<string, TitleCacheEntry>;

const titlesCache: TitlesCacheMap = titlesCacheRaw as TitlesCacheMap;

/** #4558 Parte B: `datePublished` ESTÁTICO do Article JSON-LD — data em que
 * a estrutura GEO foi aplicada a esta página, não a data da edição mais
 * recente (essa é `dateModified`, derivada dinamicamente da ENTRADA — ver
 * `buildArchiveHtml` abaixo). Diferente de livros/cursos (páginas GERADAS
 * por script, onde uma data dinâmica quebraria o teste de asset-drift),
 * `arquivo` é renderizado por request a partir de dados live — não há asset
 * committed pra "driftar" contra, então só `datePublished` precisa ser fixo
 * (é sobre a página em si, não sobre o conteúdo que ela lista). */
const GEO_LAUNCH_DATE = "2026-08-04";

/** URL pública canônica desta página (Workers Custom Domain, #4105/#3698). */
export const PAGE_URL = "https://arquivo.diar.ia.br/";
/** URL pública do feed RSS (#5127) — declarada aqui (não em `render-feed.ts`)
 * pra evitar import circular: `render-feed.ts` já importa `resolveEditions`/
 * `esc`/`PAGE_URL` DESTE módulo, e este módulo precisa de `FEED_URL` pro
 * `<link rel="alternate">` do `<head>` — se `FEED_URL` vivesse em
 * `render-feed.ts`, os dois módulos importariam um do outro. */
export const FEED_URL = `${PAGE_URL}feed.xml`;
const PAGE_TITLE = "Arquivo — todas as edições da diar.ia.br";
const PAGE_DESCRIPTION =
  "Índice de todas as edições publicadas da newsletter diar.ia.br, agrupadas por mês.";

/** CSS específico da listagem (seções por mês + lista de edições) — não
 * coberto por `curadoria-page.ts` (que atende o padrão de grid de cards de
 * cursos/livros, não uma lista simples de links). */
function renderArchiveListStyles(): string {
  return `  main { padding: 40px 0 64px; }
  .count { font-family: ${FONTS.sans}; font-size: 14px; color: var(--ink); margin: 8px 0 24px; }
  .tema-index { font-family: ${FONTS.sans}; font-size: 13px; line-height: 2; color: var(--ink);
    margin: 0 0 16px; }
  .tema-index .tema-index-label { font-weight: 700; margin-right: 6px; }
  .tema-index a { color: var(--teal); text-decoration: none; }
  .tema-index a:hover { text-decoration: underline; }
  .month-index { font-family: ${FONTS.sans}; font-size: 13px; line-height: 2; color: var(--ink);
    margin: 0 0 40px; padding: 16px 0; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
  .month-index a { color: var(--teal); text-decoration: none; }
  .month-index a:hover { text-decoration: underline; }
  section { margin: 0 0 40px; }
  section h2 { font-family: ${FONTS.serif}; font-size: 22px; font-weight: 700;
    color: var(--ink); margin: 0 0 4px; }
  section h2::first-letter { text-transform: uppercase; }
  section ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--rule); }
  section li { border-bottom: 1px solid var(--rule); }
  section li a { display: block; padding: 13px 2px; font-family: ${FONTS.sans}; font-size: 16px;
    line-height: 1.4; color: var(--ink); text-decoration: none; }
  section li a:hover { color: var(--teal); }
  section li .li-date { color: var(--teal); font-weight: 700; margin-right: 8px; }`;
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

/** Último segmento não-vazio do path do `loc` (o slug da edição), ou string
 * vazia se não houver nenhum — usado tanto pelo fallback de título abaixo
 * quanto pro lookup em `titles-cache.json` (match por SLUG, nunca por URL
 * completa — ver nota do módulo). */
function slugOf(loc: string): string {
  const path = pathOf(loc);
  const parts = (path ?? loc).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Deriva um texto legível a partir do slug do `loc` — troca `-` por espaço
 * e capitaliza a 1ª letra. FALLBACK — só usado quando o slug está ausente de
 * `titles-cache.json` (#4265 item 1); Slugs do Beehiiv às vezes têm
 * artefatos de acentuação removida ("lan a o" em vez de "lança o"), daí a
 * preferência pelo título real do cache sempre que disponível. */
export function displayTextFromLoc(loc: string): string {
  const slug = slugOf(loc);
  const text = slug.replace(/-/g, " ").trim();
  if (!text) return loc;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Resolve o título de exibição de uma entrada: título real do cache
 * (`titles-cache.json`, casado por slug) se disponível, senão o fallback
 * derivado do slug (#4265 item 1). */
function resolveTitle(loc: string, slug: string, cache: TitlesCacheMap): string {
  return cache[slug]?.title ?? displayTextFromLoc(loc);
}

/** Primeiros 10 caracteres (`YYYY-MM-DD`) de uma data/datetime ISO, ou o
 * texto original (trimado) se não bater o formato — normaliza `lastmod`
 * (que pode vir como `YYYY-MM-DD` ou datetime completo) pra comparação
 * consistente com `publishDate` do cache (sempre `YYYY-MM-DD`). */
function dateOnly(dateOrDatetime: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(dateOrDatetime.trim());
  return m ? m[1] : dateOrDatetime.trim();
}

/** Resolve a "data efetiva" de uma entrada pra agrupamento/ordenação/exibição
 * (#4265 itens 2/3): `publishDate` do cache (data de PUBLICAÇÃO real) quando
 * o slug está no cache, senão `lastmod` do sitemap (última MODIFICAÇÃO —
 * fallback, pode divergir da publicação real). */
function effectiveDate(slug: string, lastmod: string, cache: TitlesCacheMap): string {
  return cache[slug]?.publishDate ?? dateOnly(lastmod);
}

/** `DD/MM` a partir de uma data efetiva `YYYY-MM-DD`, ou `null` se não
 * parseável (exibição sem prefixo de data — nunca quebra o item). */
function dayMonthLabel(dateLabel: string): string | null {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(dateLabel);
  return m ? `${m[2]}/${m[1]}` : null;
}

/** Chave de agrupamento `YYYY-MM` a partir de uma data efetiva (aceita tanto
 * `YYYY-MM-DD` quanto datetime ISO completo) — `null` se não parseável. */
function yearMonthKey(dateLabel: string): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(dateLabel.trim());
  return m ? `${m[1]}-${m[2]}` : null;
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  const idx = Number(month) - 1;
  const name = MONTH_NAMES_PT[idx] ?? month;
  return `${name} de ${year}`;
}

export interface GroupedEntry {
  loc: string;
  lastmod: string;
  /** Slug extraído do path (pra lookup no cache e chave de dedupe visual). */
  slug: string;
  /** Título real do cache, ou fallback derivado do slug (#4265 item 1). */
  title: string;
  /** Data efetiva `YYYY-MM-DD` — `publishDate` do cache ou `lastmod`
   * normalizado (#4265 item 2). Fonte única de agrupamento/ordenação/exibição. */
  date: string;
}

/**
 * Filtra as entradas cruas do sitemap pra edições reais (`/p/*`, com
 * `lastmod`) e resolve título/data efetiva de cada uma via o cache de
 * títulos (#4265 item 1) — o mesmo passo que `buildArchiveHtml` fazia
 * inline até o #5127, extraído pra ser reusado por `render-feed.ts`
 * (o builder do `/feed.xml`, #5127) sem duplicar a lógica de
 * filtro/resolução. Pure, sem agrupamento por mês (isso continua só em
 * `buildArchiveHtml`, que é quem precisa da visão agrupada).
 */
export function resolveEditions(
  entries: SitemapEntry[],
  cacheOverride?: TitlesCacheMap,
): GroupedEntry[] {
  const cache = cacheOverride ?? titlesCache;
  return entries
    .filter((e) => {
      if (!e.lastmod) return false;
      const path = pathOf(e.loc);
      return path != null && path.startsWith("/p/");
    })
    .map((e) => {
      const slug = slugOf(e.loc);
      return {
        loc: e.loc,
        lastmod: e.lastmod as string,
        slug,
        title: resolveTitle(e.loc, slug, cache),
        date: effectiveDate(slug, e.lastmod as string, cache),
      };
    });
}

/**
 * Monta as perguntas/respostas do FAQ a partir dos dados REAIS já agrupados
 * (#4558 item 6 — nunca números inventados). Pure. `newestLabel`/`oldestLabel`
 * já vêm formatados ("julho de 2026") pelo caller.
 */
export function buildArquivoFaq(
  count: number,
  monthCount: number,
  oldestLabel: string | null,
  newestLabel: string | null,
): GeoFaqItem[] {
  const rangeAnswer =
    oldestLabel && newestLabel
      ? oldestLabel === newestLabel
        ? `Todas as ${count} edições listadas aqui são de ${newestLabel}.`
        : `As edições vão de ${oldestLabel} até ${newestLabel}, cobrindo ${monthCount} mes${monthCount === 1 ? "" : "es"} de publicação.`
      : "O arquivo ainda não tem edições publicadas o suficiente pra mostrar um intervalo de datas.";

  return [
    {
      question: "Quais são todas as edições já publicadas da diar.ia.br?",
      answer: `Esta página lista as ${count} edições já publicadas da newsletter diar.ia.br, com link direto pra cada uma, agrupadas por mês da mais recente pra mais antiga.`,
    },
    {
      question: "Desde quando a diar.ia.br publica edições?",
      answer: rangeAnswer,
    },
    {
      question: "Como encontro uma edição antiga da diar.ia.br?",
      answer:
        "Use o índice de meses no topo da lista pra pular direto pra um mês, ou role a página — as edições ficam agrupadas por mês, da mais recente pra mais antiga, cada uma com título e data.",
    },
    {
      question: "A diar.ia.br publica todo dia?",
      answer:
        "A newsletter é publicada de segunda a sexta, sem edição nos fins de semana — por isso o número de edições por mês varia entre ~20 e ~23, conforme os dias úteis do mês.",
    },
    {
      question: "Como faço pra assinar a diar.ia.br?",
      answer:
        "Basta se inscrever pelo link de assinatura no topo desta página — o cadastro é gratuito e a newsletter chega direto no e-mail, de segunda a sexta.",
    },
    {
      question: "Essa lista de edições é atualizada automaticamente?",
      answer:
        "Sim — a página é gerada em tempo real a partir do sitemap oficial da diar.ia.br a cada acesso, então toda edição nova publicada aparece aqui sem intervenção manual.",
    },
  ];
}

/** Parágrafo introdutório (issue #4558 item 1: responde a pergunta principal
 * por inteiro nos primeiros ~200 palavras, sem enrolação) + H2 em formato de
 * pergunta literal (item 2). Fica no header, antes do índice de meses.
 *
 * Deliberadamente NÃO cita mês/ano específicos aqui (ex: "maio de 2026") —
 * `test/arquivo-render.test.ts` afirma que a PRIMEIRA ocorrência de cada
 * "{mês} de {ano}" no HTML segue a ordem cronológica das seções; citar um
 * mês no header (que renderiza ANTES das seções) quebraria essa ordem sem
 * mudar nada de real no conteúdo. O intervalo de datas específico vive só
 * no FAQ (`buildArquivoFaq`), que fica DEPOIS das seções no documento. */
function renderGeoIntro(count: number): string {
  return `    <div class="geo-intro-wrap">
      <h2 class="geo-h2">Quais são todas as edições já publicadas da diar.ia.br?</h2>
      <p class="geo-intro">Esta página lista as ${count} edições já publicadas da newsletter diar.ia.br, agrupadas por mês da mais recente pra mais antiga, cada uma com link direto pro texto completo. A diar.ia.br publica de segunda a sexta, resumindo em 5 minutos de leitura as principais notícias e tutoriais de inteligência artificial do dia. Use o índice de meses logo abaixo pra pular direto pra um período, ou role até o fim pras perguntas frequentes sobre o arquivo.</p>
${renderGeoByline(undefined, "atualizado em tempo real")}
    </div>`;
}

/**
 * Navegação "Por tema" (#4558 Parte A) — a lista de hubs temáticos linkada no
 * topo do arquivo.
 *
 * **Recebe os hubs por parâmetro em vez de ler `HUB_META` direto** por causa
 * de uma lacuna de teste real: o `HUB_META` de produção tem 1 entrada só, então
 * um teste que importasse o array real nunca exercitaria o `.join(" · ")` — um
 * separador quebrado (links colados, espaço faltando) só apareceria no ar
 * quando o 2º tema fosse publicado, e o teste de "existe um `<a href>` por hub"
 * continuaria passando, porque checa presença de substring, não a formatação
 * entre itens. Achado do fleet review da PR #4749.
 *
 * Lista vazia → string vazia (nunca um `<nav>` órfão sem links).
 */
export function buildTemaNav(hubs: readonly HubMeta[]): string {
  if (hubs.length === 0) return "";
  const links = hubs
    .map((h) => `<a href="/temas/${esc(h.slug)}">${esc(h.label)}</a>`)
    .join(" · ");
  return `    <nav class="tema-index" aria-label="Navegação por tema">\n      <span class="tema-index-label">Por tema</span>${links}\n    </nav>`;
}

/**
 * Constrói o HTML completo da página de arquivo a partir das entradas cruas
 * do sitemap. Filtra pra `/p/*` (edições reais — exclui home/archive/tags/
 * subscribe/authors/etc), descarta entradas sem `lastmod` (não dá pra
 * resolver nenhuma data), agrupa por ano-mês (data efetiva — #4265 item 2),
 * ordena os meses do mais recente pro mais antigo e, dentro de cada mês, as
 * edições também da mais recente pra mais antiga. Pura — sem fetch, sem I/O.
 * Nunca lança (lista vazia → mensagem, nunca erro).
 *
 * @param cacheOverride Só pra teste — substitui o `titles-cache.json`
 * commitado (que em builds normais é o real, importado estaticamente).
 * Omitido em produção; o Worker (`src/index.ts`) nunca passa este argumento.
 */
export function buildArchiveHtml(
  entries: SitemapEntry[],
  cacheOverride?: TitlesCacheMap,
): string {
  const cache = cacheOverride ?? titlesCache;
  const editions: GroupedEntry[] = resolveEditions(entries, cacheOverride);

  const groups = new Map<string, GroupedEntry[]>();
  for (const e of editions) {
    const key = yearMonthKey(e.date);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }

  const sortedKeys = [...groups.keys()].sort().reverse();

  // Navegação "Por tema" (#4558 Parte A) — os hubs temáticos só existiam no
  // sitemap e na rota `GET /temas/{slug}`: nenhuma página do site linkava pra
  // eles, então nasciam órfãos de link interno, que é o oposto do que a issue
  // pretendia. Renderizado fora do `body` abaixo de propósito — os hubs
  // existem independentemente de haver edição no sitemap.
  const temaIndex = buildTemaNav(HUB_META);

  // Índice de âncoras por mês (#4265 item 5) — sem JS, sem paginação; todos
  // os `<a href>` das edições continuam na mesma resposta.
  const monthIndex =
    sortedKeys.length > 0
      ? `    <nav class="month-index" aria-label="Navegação por mês">\n      ${sortedKeys
          .map((key) => `<a href="#${esc(key)}">${esc(monthLabel(key))}</a>`)
          .join(" · ")}\n    </nav>`
      : "";

  const sections = sortedKeys.map((key) => {
    const list = [...(groups.get(key) ?? [])].sort((a, b) =>
      b.date.localeCompare(a.date),
    );
    const items = list
      .map((e) => {
        const dm = dayMonthLabel(e.date);
        const datePrefix = dm ? `<span class="li-date">${esc(dm)}</span>` : "";
        return `      <li><a href="${esc(e.loc)}">${datePrefix}${esc(e.title)}</a></li>`;
      })
      .join("\n");
    return `    <section id="${esc(key)}">\n      <h2>${esc(monthLabel(key))}</h2>\n      <ul>\n${items}\n      </ul>\n    </section>`;
  });

  const count = editions.length;
  const body =
    sections.length > 0
      ? `${monthIndex}\n${sections.join("\n")}`
      : "    <p>Nenhuma edição encontrada.</p>";

  // #4558 Parte B: intervalo de datas + FAQ — derivados dos MESMOS `editions`
  // já agrupados acima, nunca números inventados. `sortedKeys` já está
  // ordenado do mês mais recente pro mais antigo.
  const newestKey = sortedKeys[0] ?? null;
  const oldestKey = sortedKeys[sortedKeys.length - 1] ?? null;
  const newestLabel = newestKey ? monthLabel(newestKey) : null;
  const oldestLabel = oldestKey ? monthLabel(oldestKey) : null;
  const geoFaq = buildArquivoFaq(count, sortedKeys.length, oldestLabel, newestLabel);
  // `dateModified` dinâmico (deterministicamente derivado da ENTRADA, não de
  // `Date.now()`) — a data efetiva da edição mais recente, ou `GEO_LAUNCH_DATE`
  // se não houver nenhuma edição ainda.
  const newestEditionDate = editions.reduce<string | null>(
    (max, e) => (max === null || e.date > max ? e.date : max),
    null,
  );

  // #5131: og:image da raiz é a capa da EDIÇÃO MAIS RECENTE (mais viva,
  // reusa asset que já existe — decisão da issue) — não uma capa fixa.
  // Reduz sobre `editions` (não `groups`/`sortedKeys`) pra achar a entrada
  // com a MAIOR data efetiva, e só então consulta `coverImageUrl` no cache.
  // Ausente (post sem thumbnail, ou `titles-cache.json` ainda sem o campo —
  // ver docstring do gerador) → `coverImage` fica `undefined` e
  // `renderSeoMeta` omite og:image, comportamento idêntico a antes do #5131.
  const newestEdition = editions.reduce<GroupedEntry | null>(
    (best, e) => (best === null || e.date > best.date ? e : best),
    null,
  );
  const newestCoverUrl = newestEdition ? cache[newestEdition.slug]?.coverImageUrl : undefined;
  const coverImage = newestCoverUrl
    ? { url: newestCoverUrl, width: COVER_IMAGE_WIDTH, height: COVER_IMAGE_HEIGHT }
    : undefined;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(PAGE_TITLE)}</title>
${renderSeoMeta({ title: PAGE_TITLE, description: PAGE_DESCRIPTION, url: PAGE_URL, feed: { url: FEED_URL }, image: coverImage })}
${renderAnalyticsHead()}
<meta name="robots" content="index, follow">
<style>
${renderCuradoriaRootStyles()}

${renderCuradoriaHeaderStyles()}

${renderArchiveListStyles()}

${renderGeoFaqStyles()}

${renderCuradoriaCtaSubscribeStyles()}

${renderCuradoriaFooterStyles()}
</style>
</head>
<body>
  <header>
    <div class="wrap">
      <p class="eyebrow">diar.ia.br · Arquivo</p>
      <hr class="rule">
      <h1>Arquivo<span class="dot" aria-hidden="true">.</span></h1>
      <p class="tagline">5 minutos diários pra se manter atualizado e usar melhor as IAs</p>
${renderGeoIntro(count)}
${renderCuradoriaCtaSubscribeForm(
  { id: "arquivo-cta-subscribe", source: "arquivo", heading: "Gostou da curadoria? Assine a diar.ia.br e receba tutoriais e notícias de IA todo dia, sem enrolação." },
  "hero",
)}
    </div>
  </header>
  <main>
    <div class="wrap">
      <p class="count">${count} ediç${count === 1 ? "ão" : "ões"} publicada${count === 1 ? "" : "s"}.</p>
${temaIndex}
${body}
${renderGeoFaqSection(geoFaq, { sectionId: "faq-arquivo" })}
    </div>
  </main>
  ${renderCuradoriaFooter(
    "diar.ia.br — arquivo de edições",
    `utm_source=${ARQUIVO_FOOTER_NAV_UTM.source}&utm_medium=${ARQUIVO_FOOTER_NAV_UTM.medium}`,
  )}
  <!-- JSON-LD vai no FIM do body de propósito (diferente de livros/cursos,
       que o colocam no head): as respostas do FAQ citam "mês de ano"
       (ex: "julho de 2026") e o teste de render afirma que a PRIMEIRA
       ocorrência de cada label de mês no HTML segue a ordem cronológica
       das secoes — um JSON-LD no head citaria esses labels ANTES das
       secoes e quebraria essa ordem sem mudar nada real no conteúdo.
       Google aceita JSON-LD em qualquer lugar do documento. -->
${renderGeoJsonLd({
  pageUrl: PAGE_URL,
  headline: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  datePublished: GEO_LAUNCH_DATE,
  dateModified: newestEditionDate ?? GEO_LAUNCH_DATE,
  faq: geoFaq,
})}
${renderCuradoriaCtaSubscribeScript()}
</body>
</html>
`;
}
