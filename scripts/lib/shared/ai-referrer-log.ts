/**
 * ai-referrer-log.ts (#4558 Parte C)
 *
 * Detecta e loga (estruturado, via `console.log` — Cloudflare Workers Logs)
 * requests cujo header `Referer` aponta pra um dos 4 assistentes de IA que
 * podem citar as páginas de curadoria da diar.ia.br — complemento barato e
 * mais confiável que GA4 pro monitor de citação (#4558 Parte C, ver
 * `scripts/geo-citation-monitor.ts`): entre 35% e 70% do tráfego vindo de um
 * assistente chega SEM `Referer` e cai como "direct" (corpo da issue), então
 * captar os que TÊM `Referer` é o sinal mais barato que existe pra mitigar
 * (não resolve) esse buraco de atribuição — os Workers são nossos, então
 * logar isso é grátis.
 *
 * Prioridade desta implementação (decisão de escopo da sessão): logging de
 * Referer é MAIS SIMPLES e MAIS VALIOSO IMEDIATAMENTE do que o monitor de
 * citação via API (que depende de credencial ainda não configurada) — ver
 * `scripts/geo-citation-monitor.ts` pro estado desse segundo mecanismo.
 *
 * `matchAiReferrerHost`/`formatAiReferrerLogLine` são puros e testáveis sem
 * runtime Workers; `logAiReferrerHit` é o único ponto que chama
 * `console.log` de verdade (logger injetável em teste).
 */

/** Os 4 hosts de assistente citados na issue #4558. Perplexity fica de fora
 * de propósito — a issue pede log de Referer só destes 4; Perplexity não é
 * mencionado na lista de origem a logar (é mencionado só na seção de
 * "expectativa a calibrar", não como fonte de Referer a capturar). */
export const AI_REFERRER_HOSTS = ["chatgpt.com", "perplexity.ai", "claude.ai", "gemini.google.com"] as const;
export type AiReferrerHost = (typeof AI_REFERRER_HOSTS)[number];

/**
 * Extrai o hostname do header `Referer` e casa contra `AI_REFERRER_HOSTS` —
 * aceita o host exato ou um subdomínio direto dele (ex: "www.claude.ai"
 * casa com "claude.ai"; "chat.openai.com" NÃO casa com "chatgpt.com" — são
 * hosts diferentes de propósito, a issue pede especificamente `chatgpt.com`).
 * Retorna `null` se o header estiver ausente, malformado, ou não bater com
 * nenhum dos 4. Nunca lança.
 */
export function matchAiReferrerHost(referer: string | null | undefined): AiReferrerHost | null {
  if (!referer) return null;
  let hostname: string;
  try {
    hostname = new URL(referer).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const host of AI_REFERRER_HOSTS) {
    if (hostname === host || hostname.endsWith(`.${host}`)) return host;
  }
  return null;
}

export interface AiReferrerHit {
  /** Nome do Worker que capturou o hit (ex: "cursos", "livros", "arquivo"). */
  worker: string;
  host: AiReferrerHost;
  /** Path da request (`url.pathname`) — nunca a URL inteira (sem query string
   * com possível PII, ex: `?email=` do gate). */
  path: string;
  /** ISO 8601, timestamp do hit. */
  at: string;
}

/** Formata a linha de log estruturado (JSON, 1 objeto por linha — grep-ável
 * em Workers Logs / `wrangler tail`). Pure. */
export function formatAiReferrerLogLine(hit: AiReferrerHit): string {
  return JSON.stringify({ event: "ai_referrer_hit", ...hit });
}

/**
 * Loga um hit de Referer de assistente de IA. `logger`/`now` são injetáveis
 * em teste (default: `console.log` de verdade / relógio real) — mesmo
 * padrão de DI usado em `scripts/gsc-submit-sitemaps.ts` (`fetchImpl`).
 */
export function logAiReferrerHit(
  worker: string,
  host: AiReferrerHost,
  path: string,
  logger: (line: string) => void = console.log,
  now: () => Date = () => new Date(),
): void {
  logger(formatAiReferrerLogLine({ worker, host, path, at: now().toISOString() }));
}
