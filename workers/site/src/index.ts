/**
 * workers/site — fallback pra Kit quando a página estática do acervo não existe (#6429).
 *
 * Até aqui este Worker era de STATIC ASSETS PURO (sem `main`) — `[assets]`
 * servia `public/p/{slug}/index.html`/`public/index.html` direto, sem
 * script nenhum na frente. O acervo é gerado por `scripts/gen-archive-pages.ts`
 * a partir de `data/beehiiv-cache/posts/*.json` (gated por
 * `publishing.newsletter.read_backend`, hoje ainda `"beehiiv"`) — uma edição
 * publicada só pelo Kit (desde o switchover de ENVIO do #6114, 26/08/2026)
 * nunca entra nesse cache, então a página estática nunca é gerada e
 * `/p/{slug}` responde 404 no nosso domínio pra toda edição nova.
 *
 * Achado ao vivo (#6429): o botão de compartilhar do WhatsApp embutido no
 * e-mail aponta pro nosso permalink (`https://diar.ia.br/p/{slug}`), então
 * todo leitor que compartilhou a edição do dia mandou um link morto — sem
 * ver erro nenhum (quem recebe o clique é o CONTATO dele, não ele).
 *
 * Fix de curto prazo, este `main`: quando `env.ASSETS.fetch` devolve 404
 * pra um path `/p/{slug}`, redireciona (302) pro permalink hospedado no Kit
 * (`https://{EXPECTED_SUBSCRIBE_REDIRECT_HOST}/posts/{slug}`) — confirmado
 * ao vivo na issue que o Kit já serve a página pública (`public: true`) pra
 * broadcast publicado só lá. Mantém o e-mail já enviado (com o link antigo)
 * funcional retroativamente e cobre toda edição nova até o fix definitivo
 * (gen-archive-pages.ts ler do Kit — escopo do #463/#6184) — o fallback
 * some sozinho quando a página própria passar a existir, porque o `if`
 * abaixo só dispara em 404.
 *
 * `run_worker_first = true` no `wrangler.toml` (mudança irmã desta) garante
 * que este script rode ANTES do asset ganhar a request — mesmo invariante
 * já documentado em `workers/livros/wrangler.toml`/`workers/cursos/wrangler.toml`.
 *
 * Qualquer outro path (`/`, `/subscribe`, acervo que EXISTE) segue
 * exatamente como antes — `env.ASSETS.fetch(request)` é sempre a 1ª coisa
 * chamada, e só um 404 especificamente em `/p/{slug}` muda de rumo.
 */
import { EXPECTED_SUBSCRIBE_REDIRECT_HOST } from "../../../scripts/lib/apex-cutover.ts";

export interface Env {
  ASSETS: Fetcher;
}

/** Casa `/p/{slug}` (com ou sem barra final — `html_handling` já resolve a
 * canonicalização pro asset, mas o fallback precisa aceitar as duas formas
 * ANTES de o asset lookup decidir isso). Pura, exportada pra teste. */
export function matchArchiveSlug(pathname: string): string | null {
  const match = pathname.match(/^\/p\/([^/]+)\/?$/);
  return match ? match[1] : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;

    const url = new URL(request.url);
    const slug = matchArchiveSlug(url.pathname);
    if (!slug) return response;

    // #6429 achado do fleet review: preservar a query string (UTM do link de
    // compartilhamento) e re-encodar o slug antes de montar a URL de destino
    // — `matchArchiveSlug` só valida "sem barra", nunca sanitiza pra uso em
    // path de URL.
    const target = new URL(`https://${EXPECTED_SUBSCRIBE_REDIRECT_HOST}/posts/${encodeURIComponent(slug)}`);
    target.search = url.search;
    return Response.redirect(target.toString(), 302);
  },
};
