/**
 * workers/arquivo/src/render-feed.ts (#5127)
 *
 * Constrói o feed RSS 2.0 de `GET /feed.xml` — a única superfície do projeto
 * inteiro que emite RSS/Atom (issue #5127: verificado ao vivo, 32 requisições
 * a 8 caminhos × 4 hosts, todas 404). Fecha um canal de distribuição inteiro
 * (agregadores tipo Feedly/Inoreader, ingestão por leitor de feed) — não
 * melhora ranking no Google nem resolve rastreio (mesma ressalva honesta da
 * issue: "incerto-mas-barato").
 *
 * Reusa `resolveEditions` de `render-archive.ts` — mesmo filtro (`/p/*` com
 * `lastmod`) e mesma resolução título/data via `titles-cache.json` que já
 * alimentam a listagem HTML da raiz. Escolha RSS 2.0 (não Atom) — mais
 * ubíquo entre leitores de feed (a issue cita Feedly nominalmente), formato
 * mais simples de gerar sem biblioteca externa.
 *
 * **Conteúdo por item: título, link, data, resumo — NUNCA o corpo inteiro**
 * (issue item 2, fora de escopo explícito: "evita discussão de duplicata e
 * mantém o feed leve"). `description` de cada `<item>` é o PRÓPRIO título —
 * `titles-cache.json` não carrega um resumo/subtítulo por edição hoje (só
 * `title`+`publishDate`, ver `ArquivoTitleEntry`); usar o título como
 * `description` é um resumo honesto e curto, nunca o corpo. Se
 * `generate-arquivo-titles.ts` ganhar um campo de resumo real no futuro
 * (`subtitle` já existe em `RawCachedPost`, só não é lido hoje), trocar a
 * fonte aqui é a única mudança necessária.
 *
 * **`MAX_FEED_ITEMS` — bounded, não as ~250 edições inteiras.** Convenção
 * comum de feed (mais recentes primeiro, tamanho previsível) — um leitor de
 * feed não espera nem precisa do arquivo histórico inteiro; isso já é
 * coberto pela página HTML da raiz e por `/sitemap.xml`.
 */
import type { SitemapEntry } from "../../../scripts/lib/fetch-sitemap.ts";
import { resolveEditions, esc, PAGE_URL, FEED_URL, type TitlesCacheMap } from "./render-archive.ts";

export { FEED_URL };

const FEED_TITLE = "diar.ia.br — Arquivo de edições";
const FEED_DESCRIPTION =
  "As edições mais recentes da newsletter diar.ia.br, publicada de segunda a sexta.";
/** Fallback estático só pro caso degenerado de feed sem NENHUM item (sitemap
 * vazio) — nunca `new Date()` (mesma disciplina do resto do módulo: um valor
 * dinâmico tornaria o output não-determinístico/não-testável). */
const FEED_EMPTY_LASTBUILD = "2026-08-12";
const MAX_FEED_ITEMS = 50;

/** `YYYY-MM-DD` → formato RFC 822 (`pubDate`/`lastBuildDate` do RSS 2.0).
 * Meia-noite UTC — mesma disciplina de data ESTÁTICA usada em `toHttpDate`
 * de `src/index.ts` (a data de COBERTURA/publicação, não hora real). */
function toRfc822(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toUTCString();
}

/**
 * Constrói o XML completo do feed RSS 2.0 a partir das entradas cruas do
 * sitemap. Pure — sem fetch, sem I/O. Nunca lança (sitemap vazio → canal sem
 * `<item>`, nunca erro).
 *
 * @param cacheOverride Só pra teste — mesmo mecanismo de `buildArchiveHtml`.
 */
export function buildArchiveFeedXml(
  entries: SitemapEntry[],
  cacheOverride?: TitlesCacheMap,
): string {
  const editions = resolveEditions(entries, cacheOverride);
  const sorted = [...editions].sort((a, b) => b.date.localeCompare(a.date));
  const items = sorted.slice(0, MAX_FEED_ITEMS);

  const lastBuildDate = items[0] ? toRfc822(items[0].date) : toRfc822(FEED_EMPTY_LASTBUILD);

  const itemsXml = items
    .map(
      (e) => `    <item>
      <title>${esc(e.title)}</title>
      <link>${esc(e.loc)}</link>
      <guid isPermaLink="true">${esc(e.loc)}</guid>
      <pubDate>${toRfc822(e.date)}</pubDate>
      <description>${esc(e.title)}</description>
    </item>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(FEED_TITLE)}</title>
    <link>${esc(PAGE_URL)}</link>
    <atom:link href="${esc(FEED_URL)}" rel="self" type="application/rss+xml" />
    <description>${esc(FEED_DESCRIPTION)}</description>
    <language>pt-BR</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
${itemsXml}
  </channel>
</rss>
`;
}
