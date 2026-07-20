/**
 * canonical-urls.ts (#1456)
 *
 * Helper pra lookup de URL canonical a partir do `01-approved.json` da edição,
 * pra evitar que edições manuais de `02-reviewed.md` (top-level Claude,
 * orchestrator durante dedup cleanup, etc.) introduzam URLs hallucinadas.
 *
 * Caso real 260522: durante dedup cleanup eu (top-level Claude) movi
 * Hassabis Nobel pra OUTRAS NOTÍCIAS e, ao reescrever o item no MD, re-derivei
 * URL/título de cabeça em vez de copiar do JSON canonical. Resultado: 404 no
 * link da Guardian (URL real era sobre Jack Clark da Anthropic, não Hassabis).
 *
 * Uso típico no orchestrator/top-level antes de editar manualmente:
 *
 *   const map = getCanonicalUrls(approvedJson);
 *   const url = lookupByTitle(map, "Hassabis aposta...");
 *   if (!url) throw new Error("título não está no approved JSON — fonte desconhecida");
 *
 * Helpers complementares:
 * - `extractUrlsFromMd`: lista URLs presentes no MD final (incluindo body)
 * - `findMismatchedUrls`: dado um MD pós-edit e o JSON canonical, lista URLs
 *   no MD que NÃO aparecem em nenhum bucket — candidates pra verificação.
 *
 * Também hospeda (#2695) `FOOTER_DOMAINS` — a allowlist de domínios de
 * rodapé/afiliado (Beehiiv, LinkedIn, Facebook, Wikipedia/Wikimedia,
 * Workers de template) usada tanto por `findMismatchedUrls` acima quanto
 * por `newsletter-count.ts` e `check-stage2-invariants.ts` — e as
 * constantes `DIARIA_FACEBOOK_PAGE_SLUG`/`DIARIA_FACEBOOK_PAGE_URL` (#2695) e,
 * desde #2790, `DIARIA_LINKEDIN_PAGE_SLUG`/`_URL`, `DIARIA_INSTAGRAM_SLUG`/
 * `_URL` e `DIARIA_THREADS_SLUG`/`_URL` — fonte única pras URLs dos canais
 * sociais da marca, reusada por `monthly-render.ts`, `stitch-newsletter.ts`,
 * `build-link-ctr.ts` e `lint-social-md.ts`.
 */

import { normalizeTitle } from "../dedup.ts";

/**
 * Slug canônico da página da Diar.ia no Facebook (sem `https://`, sem `www.`).
 * #2695 — single source of truth pra toda referência hardcoded à URL pública
 * do Facebook (footer de templates, comments de credencial, filtros de
 * domínio). Analogous ao `DIARIA_LINKEDIN_PAGE_SLUG` em `lint-social-md.ts`
 * (#2458), que cobre o slug do LinkedIn pra fins de lint de CTA social —
 * este cobre o Facebook pra fins de URL canônica (footer/dedup/mensagens).
 */
export const DIARIA_FACEBOOK_PAGE_SLUG = "facebook.com/diar.ia.br";

/** URL completa (com protocolo + `www.`) derivada do slug canônico acima. */
export const DIARIA_FACEBOOK_PAGE_URL = `https://www.${DIARIA_FACEBOOK_PAGE_SLUG}`;

/**
 * Slug canônico da página da Diar.ia no LinkedIn (sem `https://`, sem `www.`).
 * #2790 — movida pra cá (era definida só em `lint-social-md.ts`, #2458/#2695)
 * pra virar fonte única ao lado das demais constantes canônicas de redes
 * sociais; `lint-social-md.ts` reexporta esta constante pra não quebrar os
 * imports existentes (lint de CTA social + testes). `platform.config.json`
 * espelha o mesmo valor em `publishing.social.linkedin.diaria_linkedin_page_url`
 * (drift-guard em `test/lint-social-md.test.ts`).
 */
export const DIARIA_LINKEDIN_PAGE_SLUG = "linkedin.com/company/diar.ia.br";

/** URL completa (com protocolo + `www.` + trailing slash) derivada do slug acima. */
export const DIARIA_LINKEDIN_PAGE_URL = `https://www.${DIARIA_LINKEDIN_PAGE_SLUG}/`;

/**
 * Slug/URL canônicos da página da Diar.ia no Instagram (#2790). Antes desta
 * constante existir, o handle estava hardcoded em paralelo em
 * `monthly-render.ts` (`SOCIAL_LINKS`) e `build-link-ctr.ts` (`ownChannels`)
 * — nenhuma fonte única. Centralizado aqui pro mesmo padrão do
 * Facebook/LinkedIn acima.
 */
// Handle atualizado de `@diaria` → `@diar.ia.br` (o handle real do canal, alinhado
// a LinkedIn/Facebook que já usam o slug `diar.ia.br`; `@diaria` do #2790 estava
// desatualizado). Propaga pro rodapé do mensal (monthly-render SOCIAL_LINKS),
// atribuição de CTR (build-link-ctr ownChannels) e o CTA de encerramento.
export const DIARIA_INSTAGRAM_SLUG = "instagram.com/diar.ia.br";

/** URL completa (com protocolo + `www.`) derivada do slug acima. */
export const DIARIA_INSTAGRAM_URL = `https://www.${DIARIA_INSTAGRAM_SLUG}`;

/**
 * Slug/URL canônicos da página da Diar.ia no Threads (#2790). Handle
 * `@diar.ia.br` — mesmo referenciado em `.env.example`/`publish-threads.ts`
 * (conta vinculada ao App do Facebook). Só havia 1 cópia hardcoded antes
 * (`monthly-render.ts` `SOCIAL_LINKS`); centralizado aqui por consistência.
 */
export const DIARIA_THREADS_SLUG = "threads.net/@diar.ia.br";

/** URL completa (com protocolo + `www.`) derivada do slug acima. */
export const DIARIA_THREADS_URL = `https://www.${DIARIA_THREADS_SLUG}`;

/**
 * URL canônica de apoio financeiro via Apoia.se (#3219) — CTA de apoio à
 * curadoria no bloco ENCERRAMENTO/PARA ENCERRAR (diário e mensal). Ver
 * `context/snippets/encerramento-social-apoio.md`.
 */
export const DIARIA_APOIASE_URL = "https://apoia.se/diaria";

/**
 * URL canônica da página "Cursos sobre IA" (#3698) — domínio de marca
 * (Workers Custom Domain, `workers/cursos/wrangler.toml`) em vez do
 * subdomínio genérico `cursos.diaria.workers.dev` (mantido só por compat de
 * links já enviados em edições passadas — ver `FOOTER_DOMAINS` abaixo).
 * Fonte única pra referências reader-facing (rodapé/box de divulgação); o
 * build script (`build-cursos-page.ts`) mantém seu próprio `PAGE_URL` (usa
 * pra canonical/og:url da própria página, cross-checado contra
 * `CURADORIA_NAV_LINKS` por `test/build-cursos-page.test.ts`).
 */
export const DIARIA_CURSOS_URL = "https://cursos.diar.ia.br";

/**
 * URL canônica da página "Livros sobre IA" (#3698) — análogo a
 * `DIARIA_CURSOS_URL` acima.
 */
export const DIARIA_LIVROS_URL = "https://livros.diar.ia.br";

interface ArticleLike {
  url?: string;
  title?: string;
  article?: { url?: string; title?: string };
}

interface ApprovedJsonShape {
  highlights?: ArticleLike[];
  runners_up?: ArticleLike[];
  lancamento?: ArticleLike[];
  // #1629: buckets renomeados
  radar?: ArticleLike[];
  use_melhor?: ArticleLike[];
  video?: ArticleLike[];
}

/**
 * Pure: extrai (title → url) de todos os artigos no approved JSON.
 * Inclui highlights (article.url), runners_up, e todos os buckets secundários.
 *
 * Múltiplos titles podem mapear pra mesma URL (artigos duplicados entre buckets);
 * a primeira URL encontrada vence — ordem de iteração: highlights, runners_up,
 * buckets.
 */
export function getCanonicalUrls(approved: ApprovedJsonShape): Map<string, string> {
  const map = new Map<string, string>();
  const addEntry = (title: string | undefined, url: string | undefined) => {
    if (!title || !url) return;
    const key = normalizeTitle(title);
    if (!key) return;
    if (!map.has(key)) map.set(key, url);
  };

  // Helper para extrair (title, url) de qualquer shape — highlights/runners_up
  // usam `article.{title,url}` (wrapped); buckets secundários usam flat
  // `{title, url}`. Forma única evita iteração duplicada (#1456 review).
  const pickEntry = (a: ArticleLike): { title?: string; url?: string } => {
    if (a.article && (a.article.title || a.article.url)) {
      return { title: a.article.title, url: a.article.url };
    }
    return { title: a.title, url: a.url };
  };

  for (const h of approved.highlights ?? []) {
    const e = pickEntry(h);
    addEntry(e.title, e.url);
  }
  for (const r of approved.runners_up ?? []) {
    const e = pickEntry(r);
    addEntry(e.title, e.url);
  }
  for (const bucket of ["lancamento", "radar", "use_melhor", "video"] as const) {
    for (const a of approved[bucket] ?? []) {
      const e = pickEntry(a);
      addEntry(e.title, e.url);
    }
  }
  return map;
}

/**
 * Pure: dado um título arbitrário (pós-edit do MD), busca URL canonical no
 * mapa via fuzzy match (normalize → exact match). Retorna `undefined` se não
 * houver match — caller decide se fail-fast ou flagga.
 */
export function lookupCanonicalUrl(
  map: Map<string, string>,
  title: string,
): string | undefined {
  const key = normalizeTitle(title);
  return key ? map.get(key) : undefined;
}

/**
 * Pure: extrai todas as URLs `[...](url)` de um MD. Ignora URLs em
 * frontmatter YAML (se houver) e blocos de código.
 */
export function extractUrlsFromMd(md: string): string[] {
  // Strip frontmatter — tolerante a LF e CRLF (Windows OneDrive). #1456 review.
  const body = md.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, "");
  // Strip code blocks (```...```)
  const noCode = body.replace(/```[\s\S]*?```/g, "");
  const urls: string[] = [];
  const re = /\[(?:[^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noCode)) !== null) {
    urls.push(m[1]);
  }
  return urls;
}

/**
 * Pure: lista URLs no MD que NÃO aparecem como valor em nenhum bucket do
 * approved JSON. Indica edição manual que adicionou URL nova — caller deve
 * verificar acessibilidade.
 *
 * Footer/affiliate URLs (diaria.beehiiv.com, wisprflow, clarice.ai, etc.)
 * são puladas — sempre são adicionadas em runtime fora do approved.
 *
 * #2695: single source of truth — antes esta lista era duplicada em paralelo
 * (com drift real: variantes distintas de wikipedia/wikimedia, wikidata
 * presente em uns e ausente em outros) em `newsletter-count.ts` e
 * `check-stage2-invariants.ts`. Ambos agora importam esta constante em vez
 * de manter cópia própria.
 */
export const FOOTER_DOMAINS = [
  "diaria.beehiiv.com",
  "wisprflow.ai",
  "clarice.ai",
  "beehiiv.com?via",
  "linkedin.com/company",
  DIARIA_FACEBOOK_PAGE_SLUG,
  "wikipedia.org", // todas as variantes (pt/en/es/...)
  "wikimedia.org", // commons + upload
  "creativecommons.org",
  "wikidata.org",
  // #2498: Workers do template (cursos/livros/poll) são links fixos do rodapé —
  // nunca são artigos pesquisados, portanto nunca entram em nenhum cache/JSON
  // de proveniência. Allowlistar por hostname exato pra evitar match
  // permissivo de substring (ex: "workers.dev" casaria qualquer Worker).
  "cursos.diaria.workers.dev",
  "livros.diaria.workers.dev",
  "poll.diaria.workers.dev",
  // #3698/#3701: domínios de marca dos mesmos 3 Workers (Custom Domain) —
  // workers.dev acima continua allowlistado por compat de links já enviados
  // em edições passadas; os domínios de marca abaixo são o destino canônico
  // pros links novos (rodapé/CTA reader-facing).
  "cursos.diar.ia.br",
  "livros.diar.ia.br",
  "eia.diar.ia.br",
  // #3028: links de afiliado da Amazon nos boxes de divulgação — box Alexa
  // (link.amazon, gerado pelo SiteStripe) + box de livros (amzn.to shortener).
  // Bloqueiam crawler por design (anti-bot) mas são promo legítima aprovada
  // pelo editor, nunca artigos pesquisados — não devem flagar urls_accessible.
  // NÃO incluir `amazon.com.br` (substring ampla): uma página de produto Amazon
  // pode ser link oficial legítimo de um LANÇAMENTO (Kindle/Echo/Fire); allowlistá-la
  // suprimiria esse artigo da contagem e PULARIA a verificação de acessibilidade
  // dele no gate — falha silenciosa. `amzn.to`/`link.amazon` são específicos de
  // afiliado, praticamente nunca usados como link de lançamento.
  "link.amazon",
  "amzn.to",
  // #3219: CTA de apoio financeiro (Apoia.se) no bloco PARA ENCERRAR — link
  // fixo do rodapé (context/snippets/encerramento-social-apoio.md), nunca um
  // artigo pesquisado. Sem isso, urls_accessible flagaria not_in_cache (mesmo
  // bug de #2498 pro cursos/livros.diaria.workers.dev).
  "apoia.se",
  // #2695 self-review: `as const` — agora que o array é exportado e
  // compartilhado por referência entre 3 importers (era privado a este
  // arquivo antes), congela o tipo em readonly pra um `.push`/`.splice`
  // acidental num consumer virar erro de compilação em vez de vazar
  // silenciosamente pros outros 2 importers (mesma instância de módulo).
] as const;

export function findMismatchedUrls(
  md: string,
  approved: ApprovedJsonShape,
): string[] {
  const mdUrls = new Set(extractUrlsFromMd(md));
  const approvedUrls = new Set<string>();
  const addUrl = (u: string | undefined) => {
    if (u) approvedUrls.add(u);
  };
  for (const h of approved.highlights ?? []) {
    addUrl(h.article?.url);
    addUrl(h.url);
  }
  for (const r of approved.runners_up ?? []) {
    addUrl(r.article?.url);
    addUrl(r.url);
  }
  for (const bucket of ["lancamento", "radar", "use_melhor", "video"] as const) {
    for (const a of approved[bucket] ?? []) {
      addUrl(a.url);
    }
  }
  const mismatched: string[] = [];
  for (const url of mdUrls) {
    if (FOOTER_DOMAINS.some((d) => url.includes(d))) continue;
    if (!approvedUrls.has(url)) mismatched.push(url);
  }
  return mismatched;
}

// ── Auditoria de links de afiliado da Clarice (#1910) ───────────────────────

/**
 * Pure: true se `url` é um link da Clarice voltado ao leitor que está SEM o
 * tracking de afiliado `via=diaria` (Rewardful → revenue share da parceria).
 *
 * Considera afiliado qualquer host `clarice.ai` (incluindo `www.` e `app.`),
 * EXENTANDO:
 *   - `cortex.clarice.ai` — endpoint da API de correção, não é link de afiliado.
 *   - protocolos não-http (mailto: `ti@clarice.ai`, etc.).
 *
 * Detecta `via` em qualquer posição da query (`?via=diaria`, `?x=1&via=diaria`).
 */
export function clariceLinkMissingVia(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!/(^|\.)clarice\.ai$/.test(host)) return false;
  if (host === "cortex.clarice.ai") return false; // API, não afiliado
  // case-insensitive + tolera múltiplos `via` (ex: `?via=x&via=diaria`).
  return !u.searchParams.getAll("via").some((v) => v.toLowerCase() === "diaria");
}

/**
 * Pure: varre um texto (markdown ou código) e retorna os links da Clarice
 * voltados ao leitor que estão sem `via=diaria`. Usado pelo guard de #1910.
 */
export function findClariceLinksMissingVia(text: string): string[] {
  const out: string[] = [];
  // URLs em qualquer forma (markdown `](url)`, `[ref][url]`, autolink ou plano).
  // Char class exclui delimitadores de wrapping (`) ] } " ' < >`); o strip
  // remove pontuação de fim de frase. Sem isso, `...via=diaria]` ou `...;`
  // entrava no value e dava falso-positivo (#1911 review).
  const re = /https?:\/\/[^\s)\]}"'<>]+/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(text)) !== null) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    if (clariceLinkMissingVia(url)) out.push(url);
  }
  return out;
}

