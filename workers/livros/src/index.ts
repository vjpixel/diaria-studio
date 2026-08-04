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
 */
import { matchAiReferrerHost, logAiReferrerHit } from "../../../scripts/lib/shared/ai-referrer-log.ts";

export interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const aiHost = matchAiReferrerHost(request.headers.get("Referer"));
      if (aiHost) logAiReferrerHit("livros", aiHost, url.pathname);
    } catch {
      // logging nunca derruba a página — fail-soft, mesma disciplina de
      // workers/cursos e workers/arquivo.
    }
    return env.ASSETS.fetch(request);
  },
};
