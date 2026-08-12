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
 * #5099 corrigir (ver `scripts/lib/beehiiv-home-meta-check.ts`).
 *
 * Cada Worker público sem passivo de link-legado (`arquivo`/`cursos`/
 * `livros` — ver `workers/{arquivo,cursos,livros}/src/index.ts`) chama
 * `resolveWorkersDevRedirect(request.url, canonicalHost)` logo no início do
 * handler `fetch`, ANTES de qualquer outra lógica (roteamento, KV, ASSETS):
 * se `shouldRedirect`, o Worker devolve `Response.redirect(decision.location,
 * 301)` direto — a construção do `Response` (I/O) fica no Worker, a DECISÃO
 * fica aqui.
 *
 * NUNCA aplicar a `poll` (`eia.diar.ia.br`): `poll.diaria.workers.dev`
 * continua ativo por decisão explícita de compat de links de VOTO já
 * embutidos em ~233 edições publicadas (#3904, `workers_dev = true` em
 * `workers/poll/wrangler.toml`) — fechar esse host quebraria voto de edição
 * antiga. Só os 3 hosts SEM esse passivo histórico (arquivo/cursos/livros)
 * fecham (ver "Fora de escopo" de #5099 e item D de #5097).
 */

export interface WorkersDevRedirectDecision {
  readonly shouldRedirect: boolean;
  /** URL completa de destino (com protocolo, path e query preservados) —
   * `null` quando `shouldRedirect` é `false`. */
  readonly location: string | null;
}

/**
 * Pura — `true` (com `location`) quando `requestUrl` chegou por QUALQUER
 * host terminado em `.workers.dev` (checagem por sufixo de hostname, não
 * por nome de conta hardcoded — cobre `arquivo.diaria.workers.dev` hoje e
 * qualquer variante futura do mesmo padrão). `false` quando o host já é o
 * canônico (ou qualquer outro host, ex: preview local) — nunca redireciona
 * o próprio host de marca. Preserva path + query string no destino; nunca
 * lança — `requestUrl` malformada vira `shouldRedirect: false` (fail-soft,
 * mesma disciplina dos outros guards de Worker deste repo, ex:
 * `matchAiReferrerHost` em `ai-referrer-log.ts`).
 */
export function resolveWorkersDevRedirect(requestUrl: string, canonicalHost: string): WorkersDevRedirectDecision {
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
  return { shouldRedirect: true, location: target.toString() };
}
