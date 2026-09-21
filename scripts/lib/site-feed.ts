/**
 * site-feed.ts (#8333)
 *
 * Miolo puro do feed RSS 2.0 das edições no apex — `https://diar.ia.br/feed.xml`.
 *
 * Por que existe: o apex (Worker `workers/site`) respondia 404 em `/feed`, e
 * diretórios de newsletters (Lerama/Manual do Usuário, Feedspot) exigem uma URL
 * de feed pra aceitar o cadastro. `arquivo.diar.ia.br/feed.xml` cobre outro host
 * e outro escopo (hubs); este é o feed das EDIÇÕES, no domínio que recebe o
 * backlink.
 *
 * Mesma fonte e mesma ordem da home e do índice `/archive`
 * (`buildArchiveIndexFeed`: sitemap + `public/p/{slug}/index.html`, data
 * editorial desc, sem edição de data futura). Servido como static asset
 * (`workers/site/public/feed.xml`), gerado por `scripts/gen-feed.ts` — sem
 * handler novo no Worker. Nada aqui lê o relógio: `lastBuildDate` = data da
 * edição mais recente, pra o arquivo só mudar quando o conteúdo muda.
 */

import type { HomeFeedEntry } from "./site-home-page.ts";

export const SITE_FEED_URL = "https://diar.ia.br/feed.xml";
export const SITE_FEED_TITLE = "diar.ia.br — notícias de IA todo dia, em português";
export const SITE_FEED_DESCRIPTION =
  "5 minutos diários pra se manter atualizado e usar melhor as IAs — resumo diário de IA, grátis, por e-mail.";
/** Itens no feed. Leitores de feed só usam os recentes; o acervo completo é `/archive`. */
export const SITE_FEED_LIMIT = 50;
/** Hora de envio da edição (06:00 BRT = 09:00 UTC) — a data editorial não carrega hora. */
const SEND_HOUR_UTC = "09:00:00";

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** `YYYY-MM-DD` (ou ISO completo) → RFC 822 em UTC; `null` se não parsear. */
export function toRfc822(iso: string | null): string | null {
  if (!iso) return null;
  const day = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T${SEND_HOUR_UTC}Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toUTCString();
}

export function buildSiteFeedXml(entries: HomeFeedEntry[], limit = SITE_FEED_LIMIT): string {
  const items = entries.slice(0, limit);
  const lastBuild = items.map((e) => toRfc822(e.date)).find((d): d is string => d !== null) ?? null;
  const itemXml = items.map((e) => {
    const pub = toRfc822(e.date);
    return [
      "    <item>",
      `      <title>${escXml(e.title)}</title>`,
      `      <link>${escXml(e.url)}</link>`,
      `      <guid isPermaLink="true">${escXml(e.url)}</guid>`,
      ...(pub ? [`      <pubDate>${pub}</pubDate>`] : []),
      `      <description>${escXml(e.description || e.title)}</description>`,
      "    </item>",
    ].join("\n");
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escXml(SITE_FEED_TITLE)}</title>
    <link>https://diar.ia.br/</link>
    <description>${escXml(SITE_FEED_DESCRIPTION)}</description>
    <language>pt-BR</language>
    <atom:link href="${SITE_FEED_URL}" rel="self" type="application/rss+xml"/>${lastBuild ? `\n    <lastBuildDate>${lastBuild}</lastBuildDate>` : ""}
${itemXml.join("\n")}
  </channel>
</rss>
`;
}
