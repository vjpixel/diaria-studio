/**
 * workers/livros — Cloudflare Worker (#4558 Parte C).
 *
 * Até aqui, `livros` era um Worker de STATIC ASSETS PURO (sem `main` — ver
 * histórico do wrangler.toml em #4084): o binding `[assets]` servia
 * `public/index.html` direto, sem passar por script nenhum. Isso significa
 * que nada rodava em cada request — inclusive não dava pra ler o header
 * `Referer`, que é justamente o sinal barato que o #4558 Parte C precisa
 * capturar (log estruturado quando um assistente de IA aponta Referer pra
 * cá, complemento ao monitor de citação via API — `scripts/geo-citation-monitor.ts`).
 *
 * Este `main` é DELIBERADAMENTE mínimo — não introduz gate, cookie, KV nem
 * qualquer lógica de conteúdo (diferente de `workers/cursos`, que precisou
 * de tudo isso pro gate de assinante, #4052). O único trabalho daqui é: (1)
 * logar o Referer se for de um assistente de IA conhecido, (2) delegar pro
 * mesmo binding `env.ASSETS` que sempre serviu o conteúdo — o comportamento
 * público da página **não muda em nada**, só ganha 1 linha de log opcional.
 *
 * `run_worker_first = true` no `wrangler.toml` (mudança irmã desta) garante
 * que o script rode ANTES do asset ganhar a request — mesmo invariante já
 * documentado em `workers/cursos/wrangler.toml`/`test/cursos-worker-first.test.ts`,
 * mas aqui cobrindo TODOS os paths (não só `/`), já que não há path
 * "gateado" específico — é só instrumentação, sem gate de conteúdo.
 *
 * #5703: ganhou também a rota `GET /{INDEXNOW_KEY}.txt` — mesmo padrão de
 * `workers/arquivo/src/index.ts` (#4909 item 2) e `workers/cursos/src/index.ts`
 * (irmã desta mudança). `run_worker_first = true` já garantia que o script
 * roda pra TODO path, então esta rota só precisava do `if` — nenhuma mudança
 * de config adicional.
 */
import { matchAiReferrerHost, logAiReferrerHit } from "../../../scripts/lib/shared/ai-referrer-log.ts";
import { resolveWorkersDevRedirect } from "../../../scripts/lib/shared/workers-dev-redirect.ts"; // #5097 item D
import { DIARIA_LIVROS_URL } from "../../../scripts/lib/canonical-urls.ts"; // #5097 item D
import { matchIndexNowKeyPath } from "../../../scripts/lib/shared/indexnow-key-route.ts"; // #5703

export interface Env {
  ASSETS: Fetcher;
  /** Chave IndexNow (#5703) — mesma docstring de `workers/cursos/src/index.ts`
   * `Env.INDEXNOW_KEY` (ver lá pro racional completo). */
  INDEXNOW_KEY?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // #5097 item D: fecha o host genérico `livros.diaria.workers.dev` —
    // confirmado ao vivo (#5097) servindo 200 com o conteúdo INTEIRO em
    // paralelo ao host canônico. Redirect ANTES de qualquer outra lógica (log
    // de Referer, delegação pro ASSETS). #5104: método explícito (este
    // Worker só serve `GET`, mas o helper decide 301/308 corretamente pra
    // qualquer método futuro).
    const redirect = resolveWorkersDevRedirect(request.url, new URL(DIARIA_LIVROS_URL).host, request.method);
    if (redirect.shouldRedirect) {
      return Response.redirect(redirect.location, redirect.status);
    }

    const url = new URL(request.url);

    try {
      const aiHost = matchAiReferrerHost(request.headers.get("Referer"));
      if (aiHost) logAiReferrerHit("livros", aiHost, url.pathname);
    } catch {
      // logging nunca derruba a página — fail-soft, mesma disciplina de
      // workers/cursos e workers/arquivo.
    }

    // #5703: arquivo de chave do IndexNow — só casa quando `env.INDEXNOW_KEY`
    // está configurada; ausente, cai no fallback normal (`env.ASSETS.fetch`),
    // idêntico ao comportamento anterior a esta rota existir.
    const indexNowKey = matchIndexNowKeyPath(url.pathname, env.INDEXNOW_KEY);
    if (indexNowKey && request.method === "GET") {
      return new Response(indexNowKey, {
        status: 200,
        headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "public, max-age=3600" },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
