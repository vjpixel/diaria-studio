/**
 * brevo-client.ts (#1844 — extraído de publish-monthly.ts)
 *
 * Camada de TRANSPORTE do publisher mensal: wrappers HTTP finos sobre a
 * Brevo API v3 (POST/GET campaign/GET list/PUT). Só `fetch` — sem estado,
 * sem deps de módulo. publish-monthly.ts importa pra criar/atualizar/testar/
 * enviar a campanha. (Os testes mockam `fetch` global.)
 *
 * #2275: todas as funções públicas agora retentam em 429, honrando o header
 * `retry-after` / `x-sib-ratelimit-reset` da Brevo com backoff capped.
 * Semântica dos headers: ver comentário em brevoRateLimitWait() abaixo.
 */

/**
 * Lê os headers de rate-limit da Brevo e retorna quantos milissegundos
 * devemos esperar antes de re-tentar. Capped em MAX_WAIT_MS (30s).
 *
 * #2324: exportado para reutilização no antigo clarice-build-waves.ts (eliminando
 * cópia duplicada com comentário "idêntico ao brevo-client.ts"; arquivo removido
 * em #2844/260702). O parâmetro opcional `fallbackMs` permite que o chamador
 * forneça um fallback baseado em attempt (ex: RETRY_MS[attempt] abaixo); se
 * omitido, usa 2000ms.
 *
 * Semantica dos headers observada empiricamente (2026-06-14):
 *  - `retry-after`: RFC 7231, delta em segundos.
 *  - `x-sib-ratelimit-reset`: pode ser delta EM SEGUNDOS (ex: 256) ou epoch
 *    Unix. Clamp defensivo: < 1e9 → delta; >= 1e9 → converter pra delta.
 *
 * Cap: 30s. Em caso de throttle SUSTENTADO (Retry-After de 2849s — visto
 * em investigação manual), não pendurar o processo — lançar BrevoError pra
 * que o chamador trate (ou re-agende externamente).
 */
const MAX_WAIT_MS = 30_000; // 30s — cap de espera por tentativa
const MAX_ATTEMPTS = 3;     // total de tentativas (1 original + 2 re-tentativas)

export function parseRetryAfterMs(headers: Headers, fallbackMs = 2000): number {
  const retryAfter = headers.get("retry-after");
  const sibReset = headers.get("x-sib-ratelimit-reset");
  let deltaS: number | null = null;
  if (retryAfter != null) {
    const v = Number(retryAfter);
    if (!isNaN(v) && v >= 0) deltaS = v; // F2 fix: v>=0 aceita retry-after:0 (RFC 7231: retry imediato)
  } else if (sibReset != null) {
    const v = Number(sibReset);
    if (!isNaN(v)) {
      // #2307: v>=0 aceita reset:0 (janela já passou → retry imediato), igual a retry-after:0
      deltaS = v >= 1e9
        ? Math.max(0, Math.ceil(v - Date.now() / 1000))
        : v >= 0 ? v : null;
    }
  }
  if (deltaS == null) return Math.min(fallbackMs, MAX_WAIT_MS);
  return Math.min(deltaS * 1000, MAX_WAIT_MS);
}

/** #2275: sleep injetável para testes. */
const _defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * #2275: wrapper genérico de retry-on-429 para scripts/lib/brevo-client.ts.
 * Diferente do `withRateLimitRetry` do worker (que usa BrevoRateLimitError),
 * este opera diretamente sobre `Response` (Node fetch), já que scripts não
 * compartilham o mesmo bundle do Worker.
 *
 * Retenta até MAX_ATTEMPTS vezes. Se após MAX_ATTEMPTS o status ainda for
 * 429, lança erro descritivo. Outros erros de HTTP são propagados imediatamente
 * (sem retry).
 *
 * `_sleep` é injetável para testes (não espera de verdade).
 */
export async function withBrevo429Retry<T>(
  fn: (attempt: number) => Promise<T>,
  _sleep = _defaultSleep,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (e instanceof Brevo429Signal) {
        if (attempt < MAX_ATTEMPTS - 1) {
          const waitMs = parseRetryAfterMs(e.response.headers);
          await _sleep(waitMs);
          continue;
        }
        // Esgotou tentativas
        throw new Error(
          `Brevo API 429 após ${MAX_ATTEMPTS} tentativas. ` +
          `Retry-After: ${e.response.headers.get("retry-after") ?? e.response.headers.get("x-sib-ratelimit-reset") ?? "n/a"}`,
        );
      }
      throw e; // erros não-429 propagam imediatamente
    }
  }
  // Nunca alcançado — loop acima sempre retorna ou lança
  throw new Error("Brevo 429: esgotado sem resposta capturada");
}

/** Sinal interno para indicar resposta 429 ao retry wrapper. */
export class Brevo429Signal extends Error {
  constructor(public readonly response: Response) {
    super("Brevo 429");
    this.name = "Brevo429Signal";
  }
}

/** Faz um `fetch` para a Brevo e lança `Brevo429Signal` em 429. */
async function brevoRawFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 429) {
    throw new Brevo429Signal(res);
  }
  return res;
}

/**
 * #2275: helper para scripts que fazem raw fetch — converte um Response 429
 * em Brevo429Signal de forma que `withBrevo429Retry` intercepte e retente.
 * Uso: `if (res.status === 429) throwBrevo429(res)` no corpo do fn passado.
 */
export function throwBrevo429(res: Response): never {
  throw new Brevo429Signal(res);
}

export async function brevoPost(
  apiKey: string,
  path: string,
  body: unknown,
  _sleep = _defaultSleep,
): Promise<unknown> {
  return withBrevo429Retry(async () => {
    const res = await brevoRawFetch(`https://api.brevo.com/v3${path}`, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Brevo API POST ${path} falhou (${res.status}): ${text}`);
    }

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const text = await res.text();
      return text.length > 0 ? JSON.parse(text) : {};
    }
    return {};
  }, _sleep);
}

/**
 * GET de uma campanha Brevo. Usado pra validar status antes de PUT em
 * `--update-existing` (#1015) — Brevo rejeita update em campanha já enviada,
 * mas o erro é pouco amigável. Vale checar antes pra dar mensagem clara.
 */
export async function brevoGetCampaign(
  apiKey: string,
  campaignId: number,
  _sleep = _defaultSleep,
): Promise<{ id: number; name: string; status: string }> {
  return withBrevo429Retry(async () => {
    const res = await brevoRawFetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}`, {
      method: "GET",
      headers: { "api-key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Brevo API GET /emailCampaigns/${campaignId} falhou (${res.status}): ${text}`);
    }
    const data = await res.json() as { id: number; name: string; status: string };
    return data;
  }, _sleep);
}

export async function brevoGetList(
  apiKey: string,
  listId: number,
  _sleep = _defaultSleep,
): Promise<{ id: number; name: string; totalSubscribers: number }> {
  return withBrevo429Retry(async () => {
    const res = await brevoRawFetch(`https://api.brevo.com/v3/contacts/lists/${listId}`, {
      method: "GET",
      headers: { "api-key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Brevo API GET /contacts/lists/${listId} falhou (${res.status}): ${text}`);
    }
    const data = await res.json() as { id: number; name: string; totalSubscribers: number };
    return data;
  }, _sleep);
}

/**
 * PUT genérico pra Brevo. Usado em #1015 pra:
 *   - --schedule-at:    PUT /emailCampaigns/{id} body { scheduledAt }
 *   - --update-existing: PUT /emailCampaigns/{id} body { subject, htmlContent, ... }
 *
 * Nota (#1025): Brevo API usa PUT (não PATCH) pra updates de emailCampaigns;
 * PATCH retorna 404. Verificado empiricamente em 2026-05-08.
 */
export async function brevoPut(
  apiKey: string,
  path: string,
  body: unknown,
  _sleep = _defaultSleep,
): Promise<unknown> {
  return withBrevo429Retry(async () => {
    const res = await brevoRawFetch(`https://api.brevo.com/v3${path}`, {
      method: "PUT",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Brevo API PUT ${path} falhou (${res.status}): ${text}`);
    }

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const text = await res.text();
      return text.length > 0 ? JSON.parse(text) : {};
    }
    return {};
  }, _sleep);
}

/**
 * #2018: lista TODAS as listas Brevo (paginado, limit=50) — só id + nome.
 * Extraído de clarice-import-waves.ts / clarice-import-sends.ts /
 * clarice-split-cells.ts onde estava triplicado com corpo idêntico.
 * Usado pelo check de duplicata antes de criar listas novas.
 *
 * #2275: cada página pagina agora com retry-on-429 via withBrevo429Retry.
 */
export async function brevoListAllLists(
  apiKey: string,
  _sleep = _defaultSleep,
): Promise<{ id: number; name: string }[]> {
  const out: { id: number; name: string }[] = [];
  let offset = 0;
  for (;;) {
    const page = await withBrevo429Retry(async () => {
      const res = await brevoRawFetch(`https://api.brevo.com/v3/contacts/lists?limit=50&offset=${offset}`, {
        headers: { "api-key": apiKey, Accept: "application/json" },
      });
      if (!res.ok) {
        // #2061: truncar body pra evitar inundar o log com página HTML de erro
        // (ex: 401 com página HTML de 5KB). 500 chars é suficiente pra diagnóstico.
        const rawText = await res.text();
        const text = rawText.length > 500 ? rawText.slice(0, 500) + "… [truncado]" : rawText;
        throw new Error(`Brevo API GET /contacts/lists falhou (${res.status}): ${text}`);
      }
      return (await res.json()) as { lists?: { id: number; name: string }[] };
    }, _sleep);
    const lists = page.lists ?? [];
    out.push(...lists.map((l) => ({ id: l.id, name: l.name })));
    if (lists.length < 50) break;
    offset += 50;
  }
  return out;
}

// ---------------------------------------------------------------------------
// brevoGet — GET v3 genérico por path que FALHA ALTO (#2651: consolidado aqui,
// antes vivia no antigo clarice-build-waves.ts, removido em #2844/260702).
// ---------------------------------------------------------------------------

const RETRY_MS = [1000, 3000, 9000];

/**
 * GET na Brevo v3 que FALHA ALTO em vez de silenciar.
 *
 * Crítico: a versão anterior engolia qualquer status e devolvia body={}, então
 * um 429/5xx (a) truncava a paginação de contatos (unsub vazava pro T2) e
 * (b) marcava um opener real como `opened:false` (ia pro W2). Aqui:
 *   - 429/5xx → retry com backoff header-aware, depois throw (aborta, não corrompe);
 *   - 404 → {status:404, body:{}} (contato sumiu entre listar e buscar — não-fatal);
 *   - outro 4xx (401/403) → throw (auth/config — re-tentar não ajuda);
 *   - corpo não-JSON → throw.
 */
export async function brevoGet(
  apiKey: string,
  path: string,
  _sleep: (ms: number) => Promise<void> = _defaultSleep, // injetável p/ teste (igual ao resto da lib)
): Promise<{ status: number; body: any }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_MS.length; attempt++) {
    const r = await fetch(`https://api.brevo.com/v3${path}`, {
      headers: { "api-key": apiKey, Accept: "application/json" },
    });
    if (r.status === 429 || r.status >= 500) {
      // #2307: honrar Retry-After / x-sib-ratelimit-reset (header-aware backoff).
      // Fallback: RETRY_MS[attempt] quando headers ausentes — mantém comportamento anterior.
      const waitMs = attempt < RETRY_MS.length
        ? parseRetryAfterMs(r.headers, RETRY_MS[attempt])
        : 0;
      await r.body?.cancel().catch(() => {});
      lastErr = new Error(`Brevo GET ${path} HTTP ${r.status}`);
      if (attempt < RETRY_MS.length) await _sleep(waitMs);
      continue;
    }
    if (r.status === 404) return { status: 404, body: {} };
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`Brevo GET ${path} falhou (${r.status}): ${t.slice(0, 200)}`);
    }
    const t = await r.text();
    try {
      return { status: r.status, body: t.length ? JSON.parse(t) : {} };
    } catch {
      throw new Error(`Brevo GET ${path}: resposta não-JSON`);
    }
  }
  throw new Error(`Brevo GET ${path} falhou após ${RETRY_MS.length + 1} tentativas: ${String(lastErr)}`);
}

// ---------------------------------------------------------------------------
// #2994 (P0): campanhas AGENDADAS (queued) — fonte de verdade pra excluir da
// seleção de audiência contatos comprometidos com um envio ainda não disparado
// (`sends_count=0` sozinho não distingue "nunca agendado" de "agendado, ainda
// não enviado" — ver clarice-segment.ts `excludeCommittedToQueuedCampaigns`).
//
// #3682 (P1): `status=queued` sozinho não basta — `sends_count` local também
// não distingue "nunca recebeu" de "recebeu, mas o sync incremental do store
// (task diária 03:40) ainda não propagou o incremento" (lag observado: até
// ~1 dia no incidente real, envios 07-12/07-14 só apareceram como
// `sends_count=1` no snapshot de 07-17). Um build de audiência rodado NESSA
// janela de lag re-seleciona contatos que JÁ receberam um envio `sent` do
// ciclo. `fetchSentCampaignListIds`/`fetchCommittedCampaignListIds` fecham
// esse furo consultando a Brevo AO VIVO (imune ao lag do store) — mesma
// mecânica de paginação, só trocando o `status`.
// ---------------------------------------------------------------------------

interface BrevoCampaignListRef {
  id?: number;
  // #2994: campo real da Brevo API é `recipients.lists` (array de list_id),
  // NÃO `recipients.listIds` — mesmo shape já consumido em
  // scripts/clarice-engagement-cohorts.ts (`c?.recipients?.lists`). Confirmado
  // no código existente antes de assumir o nome do campo.
  recipients?: { lists?: number[] };
}
interface BrevoCampaignsResponse {
  campaigns?: BrevoCampaignListRef[];
  count?: number;
}

/**
 * Busca (paginado, `GET /v3/emailCampaigns?status={status}`) todas as listas
 * Brevo que alimentam alguma campanha do status dado, e devolve o Set de
 * `list_id` (como string, mesma forma serializada de `brevo_list_ids` no
 * store — ver `parseBrevoListIds`). Compartilhada por
 * `fetchQueuedCampaignListIds`/`fetchSentCampaignListIds` — mesma paginação,
 * só o filtro de status muda.
 */
async function fetchCampaignListIdsByStatus(apiKey: string, status: "queued" | "sent"): Promise<Set<string>> {
  const out = new Set<string>();
  let offset = 0;
  const limit = 50;
  for (;;) {
    const { body } = await brevoGet(
      apiKey,
      `/emailCampaigns?status=${status}&limit=${limit}&offset=${offset}`,
    );
    const campaigns = (body as BrevoCampaignsResponse)?.campaigns ?? [];
    for (const c of campaigns) {
      for (const listId of c.recipients?.lists ?? []) {
        out.add(String(listId));
      }
    }
    if (campaigns.length < limit) break;
    offset += limit;
  }
  return out;
}

/**
 * `status=queued` é o status Brevo pra "agendado, na fila, ainda não
 * disparado" (distinto de `sent`) — mesma distinção que motivou o guard #573
 * (`resolveBeehiivState` etc) pra Beehiiv; aqui o equivalente pra Brevo.
 *
 * Usa `brevoGet` (retry-on-429/5xx embutido, fail-alto em outros erros) —
 * nunca engole falha silenciosamente: se a Brevo estiver inacessível, quem
 * chama deve tratar a exceção como bloqueio de `--write` (fail-safe: na
 * dúvida, não escrever audiência sem essa checagem).
 */
export async function fetchQueuedCampaignListIds(apiKey: string): Promise<Set<string>> {
  return fetchCampaignListIdsByStatus(apiKey, "queued");
}

/**
 * #3682: `status=sent` — mesma mecânica de `fetchQueuedCampaignListIds`, mas
 * pra campanhas JÁ DISPARADAS. Fonte de verdade ao vivo, imune ao lag de
 * propagação de `sends_count` no store local (ver comentário do bloco acima).
 */
export async function fetchSentCampaignListIds(apiKey: string): Promise<Set<string>> {
  return fetchCampaignListIdsByStatus(apiKey, "sent");
}

/**
 * #3682: entrypoint recomendado pros consumidores de exclusão de audiência
 * (`weekly-send-plan-audience.ts`, `clarice-schedule-ramp.ts`,
 * `cohort-order-dryrun.ts`) — união de `queued` + `sent`, buscados em
 * paralelo. Um contato comprometido com QUALQUER campanha do ciclo (agendada
 * OU já disparada) deve ser excluído da próxima seleção; `sends_count=0`
 * local não é confiável sozinho pra nenhum dos dois casos.
 */
export async function fetchCommittedCampaignListIds(apiKey: string): Promise<Set<string>> {
  const [queued, sent] = await Promise.all([
    fetchQueuedCampaignListIds(apiKey),
    fetchSentCampaignListIds(apiKey),
  ]);
  return new Set([...queued, ...sent]);
}
