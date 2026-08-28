/**
 * scripts/lib/shared/workers-dev-redirect.ts (#5097 item D)
 *
 * Função PURA (sem I/O, sem `fetch`/`Response` — testável em Node puro) que
 * decide se uma request chegou pelo host genérico `*.workers.dev` de um
 * Worker público e, se sim, pra onde ela deveria ser redirecionada (301) —
 * o host de marca canônico em `diar.ia.br`.
 *
 * Motivo (#5097, achado 3 do diagnóstico): confirmado ao vivo em 12/08/2026
 * que `arquivo`, `cursos` e `livros` respondem 200 com o conteúdo COMPLETO
 * em `*.diaria.workers.dev` — uma cópia inteira e rastreável do mesmo
 * conteúdo do host canônico, sem 301 nem bloqueio nenhum. O `rel=canonical`
 * cross-host já aponta certo (mitiga duplicata no índice), mas não evita o
 * CRAWL nem impede que alguém copie/compartilhe o link errado — é justamente
 * pra esse host que a home da publicação estava mandando o leitor até o
 * #5099 corrigir (ver `scripts/lib/home-meta-check.ts`).
 *
 * Cada Worker público sem passivo de link-legado (`arquivo`/`cursos`/
 * `livros`/`artigo-mensal` — ver `workers/{arquivo,cursos,livros,artigo-mensal}/src/index.ts`)
 * chama `resolveWorkersDevRedirect(request.url, canonicalHost, request.method)`
 * logo no início do handler `fetch`, ANTES de qualquer outra lógica
 * (roteamento, KV, ASSETS): se `shouldRedirect`, o Worker devolve
 * `Response.redirect(decision.location, decision.status)` direto — a
 * construção do `Response` (I/O) fica no Worker, a DECISÃO fica aqui.
 *
 * NUNCA aplicar a `poll` (`eia.diar.ia.br`): `poll.diaria.workers.dev`
 * continua ativo por decisão explícita de compat de links de VOTO já
 * embutidos em ~233 edições publicadas (#3904, `workers_dev = true` em
 * `workers/poll/wrangler.toml`) — fechar esse host quebraria voto de edição
 * antiga. Só os hosts SEM esse passivo histórico (arquivo/cursos/livros/
 * artigo-mensal) fecham (ver "Fora de escopo" de #5099 e item D de #5097).
 * `workers/artigos` tem o MESMO padrão (`workers_dev` + `custom_domain`) mas
 * fica de fora — é um Worker de static assets puro, sem `main`/script, então
 * não há `fetch` handler pra chamar esta função (ver `docs/seo-notes.md`
 * Fato 5 pro porquê disso é exclusão arquitetural, não descuido).
 *
 * ─── Método HTTP (#5104 fleet review, achado 1) ────────────────────────────
 *
 * Um 301 numa request não-`GET`/`HEAD` é REESCRITO pelo cliente HTTP pra
 * `GET` sem corpo no retry (RFC 9110 §15.4.2 — comportamento histórico de
 * browser/fetch, não um bug de implementação específica). `cursos` tem
 * endpoints `POST` com estado (`/gate/verify`, `/gate/subscribe`,
 * `/gate/logout`) — uma aba aberta antes do deploy, ou qualquer chamador com
 * o host `.workers.dev` hardcoded, perderia o corpo da mutação em silêncio
 * se o redirect fosse sempre 301. `308` preserva método E corpo (ainda
 * "permanente", mesma semântica de cache que 301) — é o código certo pra
 * qualquer método que não seja seguro/idempotente por convenção HTTP
 * (`GET`/`HEAD`). O `method` é opcional (default `"GET"`) só pra não quebrar
 * os call sites de teste puro que não simulam o método da request.
 */

export type WorkersDevRedirectDecision =
  | {
      readonly shouldRedirect: true;
      /** URL completa de destino (com protocolo, path e query preservados). */
      readonly location: string;
      /** `301` pra `GET`/`HEAD`; `308` pra qualquer outro método (preserva
       * corpo no retry do cliente — ver docstring do módulo). */
      readonly status: 301 | 308;
    }
  | { readonly shouldRedirect: false; readonly location: null };

/** Métodos considerados seguros/idempotentes o bastante pra um cliente HTTP
 * reescrever pra `GET` no retry de um 301 sem perda de dado. */
const SAFE_REDIRECT_METHODS = new Set(["GET", "HEAD"]);

/**
 * Pura — `true` (com `location`+`status`) quando `requestUrl` chegou por
 * QUALQUER host terminado em `.workers.dev` (checagem por sufixo de
 * hostname, não por nome de conta hardcoded — casa `arquivo.diaria.workers.dev`
 * hoje e qualquer variante futura do mesmo padrão). Deliberadamente mais
 * amplo que "nossos hosts legados": um `*.workers.dev` de conta DE TERCEIRO
 * também casaria (ver teste "qualquer subdomínio de conta .workers.dev
 * casa") — inofensivo aqui porque a função só roda dentro do `fetch` handler
 * dos nossos próprios Workers, nunca recebe URL de terceiro pra decidir.
 * `false` quando o host já é o canônico (ou qualquer outro host, ex: preview
 * local) — nunca redireciona o próprio host de marca. Preserva
 * path + query string no destino; nunca lança — `requestUrl` malformada
 * vira `shouldRedirect: false` (fail-soft, mesma disciplina dos outros
 * guards de Worker deste repo, ex: `matchAiReferrerHost` em
 * `ai-referrer-log.ts`). `status` é `301` pra `GET`/`HEAD`, `308` pra
 * qualquer outro método — ver docstring do módulo.
 */
export function resolveWorkersDevRedirect(
  requestUrl: string,
  canonicalHost: string,
  method: string = "GET",
): WorkersDevRedirectDecision {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { shouldRedirect: false, location: null };
  }
  if (!url.hostname.endsWith(".workers.dev")) {
    return { shouldRedirect: false, location: null };
  }
  const target = new URL(url.pathname + url.search, `https://${canonicalHost}`);
  const status: 301 | 308 = SAFE_REDIRECT_METHODS.has(method.toUpperCase()) ? 301 : 308;
  return { shouldRedirect: true, location: target.toString(), status };
}
