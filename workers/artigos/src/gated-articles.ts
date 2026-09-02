/**
 * workers/artigos/src/gated-articles.ts (#7030)
 *
 * Registro dos Artigos Especiais gateados — espelha (não importa, ver nota
 * abaixo) `ARTICLES` de `scripts/build-artigo-especial-teaser.ts`. Artigo
 * novo: rodar o build script (gera `{slug}-full.generated.ts`) E adicionar
 * uma entrada aqui — os dois passos são manuais/separados de propósito: este
 * arquivo importa só o `.generated.ts` (const de string), nunca o script de
 * build em si, que usa `node:fs`/`node:child_process` e quebraria o bundle
 * do Worker (`wrangler deploy` roda em runtime `workerd`, sem Node APIs sem
 * `nodejs_compat`).
 *
 * As PÁGINAS DE ENTIDADE (`public/entidades/*`) NÃO entram aqui — são
 * públicas por decisão do editor (#7030, ver PR body: "fechar as entidades
 * seria um tiro no pé de SEO/GEO"). Só os Artigos Especiais têm gate.
 */
import { ENGENHARIA_DE_ILUSAO_FULL_HTML } from "./engenharia-de-ilusao-full.generated.ts";
import { O_AGENTE_FULL_HTML } from "./o-agente-full.generated.ts";

export interface GatedArticle {
  slug: string;
  year: string;
  fullHtml: string;
}

export const GATED_ARTICLES: readonly GatedArticle[] = [
  { slug: "engenharia-de-ilusao", year: "2026", fullHtml: ENGENHARIA_DE_ILUSAO_FULL_HTML },
  { slug: "o-agente", year: "2026", fullHtml: O_AGENTE_FULL_HTML },
];

/** Paths que servem o MESMO asset (`public/{year}/{slug}/index.html`) e
 * portanto precisam do `run_worker_first` do `wrangler.toml` pra o gate
 * conseguir decidir teaser × full ANTES do `env.ASSETS.fetch` responder —
 * mesmo cuidado de `GATED_INDEX_PATHS` em `workers/cursos/src/index.ts`
 * (#4305). Cada artigo entra 2×: com e sem `index.html` explícito. */
export function gatedArticlePaths(): string[] {
  const paths: string[] = [];
  for (const a of GATED_ARTICLES) {
    paths.push(`/${a.year}/${a.slug}/`, `/${a.year}/${a.slug}/index.html`);
  }
  return paths;
}

/** Dado um pathname de request, resolve o artigo gateado correspondente (ou
 * `undefined` se o path não for de um artigo gateado — página de entidade,
 * home, robots.txt etc, que caem no fallback estático normal). */
export function articleForPath(pathname: string): GatedArticle | undefined {
  for (const a of GATED_ARTICLES) {
    if (pathname === `/${a.year}/${a.slug}/` || pathname === `/${a.year}/${a.slug}/index.html`) return a;
  }
  return undefined;
}

/** Path canônico (`/{year}/{slug}/`) de um artigo gateado pelo slug — usado
 * pra redirecionar `GET /gate?article={slug}` de volta pro artigo depois de
 * confirmar sessão. `"/"` (home) pra slug desconhecido — NUNCA assume um ano
 * fixo (bug real evitado: um `?article=` velho/malformado apontando pro ano
 * errado teria quebrado silenciosamente antes desta função existir). */
export function articlePathForSlug(slug: string): string {
  const article = GATED_ARTICLES.find((a) => a.slug === slug);
  return article ? `/${article.year}/${article.slug}/` : "/";
}
