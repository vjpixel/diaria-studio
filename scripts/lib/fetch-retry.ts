/**
 * scripts/lib/fetch-retry.ts (#5973)
 *
 * Retry genérico com backoff pra requisições `fetch` transitórias. Extraído
 * de `scripts/seo-index-check.ts` — o fetch single-shot do sitemap, sem
 * retry nem timeout explícito, foi a causa raiz confirmada do #5943: um
 * blip de rede de UMA requisição no passo `index-arquivo` derrubou a
 * `diaria-seo-weekly.service` inteira e abriu um alarme P1 (a unit ficou
 * `failed` até alguém rodar `reset-failed`) por uma falha que uma rodada
 * manual ~2h40 depois não reproduziu. Reusado por `scripts/seo-pull.ts`
 * (`pullGsc`) — mesmo padrão
 * de single-shot fetch, mesma unit semanal, mesmo modo de falha.
 *
 * Erro de rede (exception, ex: `fetch failed`/timeout) e 5xx são
 * retriáveis (`isRetriableStatus` default: `status >= 500`); 4xx **não**
 * é — sitemap removido/renomeado, request malformado ou 403 de permissão
 * é um achado real, não um blip, e não deve gastar tentativas de retry
 * (a issue original é explícita: "404 deve falhar na primeira tentativa,
 * sem gastar retry").
 */

export interface FetchRetryOptions {
  /** Tentativas totais (incluindo a 1ª). Default 3. */
  attempts?: number;
  /** Espera entre tentativas, ms — indexado por `tentativa - 1`, satura no
   * último valor se `attempts` exceder o tamanho do array. Default
   * [1000, 3000, 9000] (mesma progressão de `RETRY_MS` em brevo-client.ts). */
  backoffMs?: number[];
  /** Timeout por tentativa via `AbortController`, ms. Default 15000 —
   * mesmo espírito do #4196 (fetch in-page do Beehiiv com timeout explícito). */
  timeoutMs?: number;
  /** Injetável pra teste — nunca espera de verdade fora de produção. */
  sleep?: (ms: number) => Promise<void>;
  /** Decide se um status HTTP não-ok vale retry. Default: `status >= 500`. */
  isRetriableStatus?: (status: number) => boolean;
}

const DEFAULT_BACKOFF_MS = [1000, 3000, 9000];
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultIsRetriableStatus(status: number): boolean {
  return status >= 500;
}

/**
 * Roda `doFetch` (recebe o `AbortSignal` da tentativa atual — o chamador
 * repassa esse signal pro `fetch`/`gFetch` de dentro) com retry+backoff.
 *
 * Retorna a `Response` assim que ela vier `ok`, OU quando o status não for
 * retriável (mesmo em falha — igual um `fetch` normal, quem chama decide o
 * que fazer com `!res.ok`; não é papel deste helper interpretar o corpo).
 * Só RELANÇA a exceção de rede/timeout se TODAS as tentativas se esgotarem
 * sem uma resposta HTTP; um 5xx que persiste até a última tentativa também
 * retorna normalmente (não lança) — o chamador já checa `res.ok`.
 */
export async function fetchWithRetry(
  doFetch: (signal: AbortSignal) => Promise<Response>,
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  if (attempts < 1) throw new Error(`fetchWithRetry: attempts precisa ser >= 1, recebeu ${attempts}`);
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const isRetriableStatus = opts.isRetriableStatus ?? defaultIsRetriableStatus;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(controller.signal);
      if (res.ok || !isRetriableStatus(res.status) || attempt === attempts) return res;
      // Resposta retriável descartada antes de tentar de novo — drenar/cancelar
      // o corpo pra não segurar a conexão subjacente aberta (achado do fleet
      // review pré-merge, silent-failure-hunter: undici mantém o socket vivo
      // até o corpo ser consumido ou cancelado; mesmo padrão já usado em
      // brevo-client.ts pra descarte de resposta retriável).
      await res.body?.cancel().catch(() => {});
    } catch (e) {
      if (attempt === attempts) {
        throw new Error(
          `fetchWithRetry: falhou após ${attempts} tentativa(s) (timeoutMs=${timeoutMs}): ${(e as Error).message}`,
          { cause: e },
        );
      }
    } finally {
      clearTimeout(timer);
    }
    await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
  }
  // Inalcançável dado attempts >= 1 (validado acima) — o loop sempre retorna
  // ou lança na última tentativa.
  throw new Error("fetchWithRetry: loop encerrado sem resultado (bug)");
}
