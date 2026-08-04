/**
 * gsc-submit-sitemaps.ts (#4546 passo 3)
 *
 * Submete os 3 sitemaps próprios dos Workers de curadoria (cursos, livros,
 * arquivo — #4546 passos 1/2) no Google Search Console via
 * `PUT /sites/{site}/sitemaps/{feedpath}`. Reusa a autenticação OAuth
 * compartilhada (`google-auth.ts`, `gFetch`) — mesmo credential file de
 * `seo-pull.ts`/`seo-index-check.ts`.
 *
 * Pré-requisito (decisão do editor, #4546 comentário 03/ago): o scope
 * `webmasters` (leitura+escrita, sem sufixo `.readonly`) precisa estar no
 * `refresh_token` salvo em `data/.credentials.json` — já adicionado a
 * `SCOPES` em `oauth-setup.ts` (#4565), mas **o token existente foi emitido
 * com o scope antigo e não ganha escrita sozinho**. Rodar
 * `npx tsx scripts/oauth-setup.ts` e reaprovar no browser é ação do editor,
 * não automatizável — enquanto isso não acontecer, este script falha com
 * 403 e a mensagem de remediação abaixo (não trava silenciosamente).
 *
 * Idempotente: resubmeter um sitemap já conhecido não duplica nem falha —
 * a API do Search Console trata o PUT como upsert. Seguro rodar quantas
 * vezes quiser, inclusive antes do 1º sucesso (falha só documenta o motivo).
 *
 * Uso:
 *   npx tsx scripts/gsc-submit-sitemaps.ts [--site sc-domain:diar.ia.br]
 *
 * Exit: 0 se todos os sitemaps foram aceitos; 1 se algum falhou (401/403/5xx
 * etc — a causa vai pro stderr, por sitemap).
 */

import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { GSC_DEFAULT_SITE } from "./lib/gsc.ts";
import { gFetch } from "./google-auth.ts";

/**
 * Sitemaps próprios dos 3 Workers de curadoria (#4546 passo 1 — já servidos
 * em produção: `workers/cursos/public/sitemap.xml`,
 * `workers/livros/public/sitemap.xml`, rota dinâmica de
 * `workers/arquivo/src/index.ts`). Deliberadamente NÃO inclui
 * `artigo.diar.ia.br/sitemap.xml` (vazio por design — todo conteúdo é gated
 * de apoiador, ver #4546 achado lateral em `workers/artigo-mensal/src/index.ts`)
 * nem `diar.ia.br/sitemap.xml` (gerado pela Beehiiv, já auto-descoberto —
 * fora do escopo desta issue).
 */
export const CURADORIA_SITEMAPS = [
  "https://cursos.diar.ia.br/sitemap.xml",
  "https://livros.diar.ia.br/sitemap.xml",
  "https://arquivo.diar.ia.br/sitemap.xml",
] as const;

export interface SitemapSubmitResult {
  sitemapUrl: string;
  ok: boolean;
  status: number;
  error?: string;
}

type FetchLike = (url: string, options?: RequestInit) => Promise<Response>;

/** Submete 1 sitemap. `fetchImpl` é injetável em teste (default: `gFetch` autenticado de verdade). */
export async function submitSitemap(
  site: string,
  sitemapUrl: string,
  fetchImpl: FetchLike = gFetch,
): Promise<SitemapSubmitResult> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;
  try {
    const res = await fetchImpl(url, { method: "PUT" });
    if (res.ok) return { sitemapUrl, ok: true, status: res.status };

    const body = await res.text();
    if (res.status === 403) {
      return {
        sitemapUrl,
        ok: false,
        status: 403,
        error: `403 — escopo de escrita ausente no token OAuth atual ou site não verificado. Rode 'npx tsx scripts/oauth-setup.ts' (scope 'webmasters', #4546) e reaprove no browser. Body: ${body.slice(0, 200)}`,
      };
    }
    return { sitemapUrl, ok: false, status: res.status, error: body.slice(0, 200) };
  } catch (e) {
    return {
      sitemapUrl,
      ok: false,
      status: 0,
      error: `Falha de auth/rede: ${(e as Error).message}. Se for refresh_token expirado/revogado, rode 'npx tsx scripts/oauth-setup.ts'.`,
    };
  }
}

/** Submete todos os sitemaps em sequência (volume baixo — 3 chamadas — não precisa de paralelismo). */
export async function submitAll(
  site: string,
  sitemapUrls: readonly string[],
  fetchImpl: FetchLike = gFetch,
): Promise<SitemapSubmitResult[]> {
  const out: SitemapSubmitResult[] = [];
  for (const sitemapUrl of sitemapUrls) {
    out.push(await submitSitemap(site, sitemapUrl, fetchImpl));
  }
  return out;
}

async function main(): Promise<number> {
  const { values } = parseCliArgs(process.argv.slice(2));
  const site = String(values["site"] ?? GSC_DEFAULT_SITE);
  const results = await submitAll(site, CURADORIA_SITEMAPS);
  for (const r of results) {
    if (r.ok) console.log(`[gsc-submit-sitemaps] OK ${r.sitemapUrl} (HTTP ${r.status})`);
    else console.error(`[gsc-submit-sitemaps] FALHOU ${r.sitemapUrl} (HTTP ${r.status}): ${r.error}`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export { main };
