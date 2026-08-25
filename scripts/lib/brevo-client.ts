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
 *
 * #5697: toda resposta da família `/v3/emailCampaigns*` (a que tem o teto
 * apertado de 100 req/HORA por CONTA, ver docs/brevo-rate-limits.md) também
 * grava `x-sib-ratelimit-remaining`/`-limit` em `brevo-rate-state.ts` — via
 * `maybeRecordCampaignRateLimit`, chamado de `brevoRawFetch` e `brevoGet`
 * (os dois pontos de `fetch` reais deste módulo). Consumidores read-only
 * chamam `assertCampaignQuotaHeadroom()` antes de um sweep em lote pra não
 * esgotar a cota que o caminho de ESCRITA (`clarice-build-segment.ts`/
 * `clarice-plan-wave.ts`) precisa — esses dois NUNCA chamam esse assert, são
 * o beneficiário da reserva, não quem a respeita.
 *
 * #6137: os mesmos dois pontos de `fetch` reais (`brevoRawFetch`/`brevoGet`)
 * também detectam 401 com corpo "unrecognised IP" (bloqueio de allowlist de
 * IP por CONTA — incidente #6124/#6132) e emitem achado estruturado via
 * `brevo-unrecognised-ip-alarm.ts` (mesmo padrão do #5339). A companion
 * module faz o I/O (estado + `gh`); este arquivo só chama
 * `maybeReportUnrecognisedIp` com `res.clone()` (nunca consome o body que o
 * caller ainda vai ler no branch `!res.ok`) — mantém-se "sem estado".
 */

import { recordCampaignQuotaRemaining } from "./brevo-rate-state.ts";
import {
  maybeReportUnrecognisedIp,
  maybeReconcileResolvedFindings,
  resolveBrevoAccountLabel,
  provesIpAllowlisted,
} from "./brevo-unrecognised-ip-alarm.ts";

// #5697: re-exportado pra quem já importa tudo de brevo-client.ts — a
// implementação/estado vivem em brevo-rate-state.ts (módulo dedicado,
// testável sem mockar `fetch`), mas o entrypoint de consumo fica visível
// aqui também, junto do resto da API pública deste client.
export {
  assertCampaignQuotaHeadroom,
  BrevoCampaignQuotaLowError,
  readCampaignQuotaState,
  type BrevoCampaignQuotaState,
} from "./brevo-rate-state.ts";

/**
 * #5697: se `url` for da família `/emailCampaigns*`, registra
 * `x-sib-ratelimit-remaining`/`-limit` (quando presentes) no arquivo de
 * estado de cota. Fail-soft por natureza (delega a `recordCampaignQuotaRemaining`,
 * que nunca lança) — nunca deve interferir na resposta real sendo processada.
 */
function maybeRecordCampaignRateLimit(url: string, headers: Headers | undefined | null): void {
  if (!url.includes("/emailCampaigns")) return;
  // Defensivo: alguns mocks de teste (ex: test/brevo-send-now-4347.test.ts)
  // devolvem Response sem `headers` — rastrear cota nunca deve quebrar a
  // chamada real (mesma disciplina fail-soft do resto deste módulo).
  if (headers == null || typeof headers.get !== "function") return;
  const remainingRaw = headers.get("x-sib-ratelimit-remaining");
  if (remainingRaw == null) return;
  const remaining = Number(remainingRaw);
  if (Number.isNaN(remaining)) return;
  const limitRaw = headers.get("x-sib-ratelimit-limit");
  const limit = limitRaw != null && !Number.isNaN(Number(limitRaw)) ? Number(limitRaw) : undefined;
  recordCampaignQuotaRemaining(remaining, limit);
}

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

/** #6137: extrai o valor do header `api-key` de um `RequestInit.headers` —
 * todos os call sites deste módulo passam um objeto plano com a chave
 * lowercase (`{"api-key": ...}`; confirmado via grep — nenhum call site usa
 * `"Api-Key"` capitalizado), mas aceita uma instância `Headers` também por
 * defensividade (nunca lança; `""` se ausente/shape inesperado, e
 * `resolveBrevoAccountLabel` já trata `""` como "desconhecida" sem quebrar).
 * #6156 P3: o fallback pro header capitalizado `"Api-Key"` foi removido —
 * era código morto (nenhum call site real o produz). */
function extractApiKeyFromInit(init: RequestInit): string {
  const headers = init.headers as unknown;
  if (headers && typeof (headers as Headers).get === "function") {
    return (headers as Headers).get("api-key") ?? "";
  }
  const plain = headers as Record<string, string> | undefined;
  return plain?.["api-key"] ?? "";
}

/**
 * #6156 (fleet review do #6137) P1 — só teste: `brevoRawFetch`/`brevoGet`
 * NUNCA `await`am `maybeReportUnrecognisedIp` (fire-and-forget) nem chamam
 * `maybeReconcileResolvedFindings` inline (via `setImmediate`) — ver
 * comentário nos dois call sites abaixo pro porquê. Testes que precisam de
 * determinismo (assert sobre chamadas `gh` simuladas) esperam este helper
 * ANTES de checar side-effects. NUNCA usado em produção.
 */
let pendingUnrecognisedIpWork: Promise<void> = Promise.resolve();

export async function __waitForPendingUnrecognisedIpWork(): Promise<void> {
  await pendingUnrecognisedIpWork;
}

/** Faz um `fetch` para a Brevo e lança `Brevo429Signal` em 429. */
async function brevoRawFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const res = await fetch(url, init);
  maybeRecordCampaignRateLimit(url, res.headers); // #5697
  if (res.status === 401 && typeof res.clone === "function") {
    // #6137: `res.clone()` — o caller (brevoPost/brevoPut/etc.) ainda lê
    // `await res.text()` no branch `!res.ok` logo abaixo na pilha; ler o
    // body aqui sem clonar consumiria o stream e quebraria essa leitura.
    // Guard `typeof res.clone === "function"`: vários testes deste repo
    // mockam `fetch` com objetos planos sem `.clone()` (ex:
    // brevo-list-all-lists.test.ts) — pular a detecção nesse caso é
    // fail-soft, nunca deve quebrar um mock de teste nem uma resposta real
    // (`fetch`/undici sempre implementam `.clone()`).
    //
    // #6156 P1 — NUNCA `await` aqui: `maybeReportUnrecognisedIp` pode
    // spawnar `gh` (bloqueante, até alguns segundos) via
    // `reportUnrecognisedIpFinding`. `brevo-client.ts` roda dentro do
    // `Diaria-Studio-Server` (processo de vida longa) — um `await` aqui
    // atrasaria tanto a propagação do erro pro caller original quanto
    // qualquer outra rota HTTP concorrente do Studio (ver docstring de
    // `BREVO_ALARM_GH_TIMEOUT_MS` em brevo-unrecognised-ip-alarm.ts pro
    // trade-off completo). Fail-soft: a função já nunca lança (try/catch
    // interno) — `.catch()` aqui é só defensivo contra unhandled rejection.
    pendingUnrecognisedIpWork = maybeReportUnrecognisedIp(url, extractApiKeyFromInit(init), res.clone()).catch(
      (e) => console.error("[brevo-client] maybeReportUnrecognisedIp falhou (fire-and-forget):", e),
    );
  } else if (provesIpAllowlisted(res.status)) {
    // #6137 (auto-close): uma resposta que genuinamente prova que a conta+IP
    // atual passaram a allowlist (nunca 401/429/5xx — #6156 P2, ver
    // `provesIpAllowlisted`) reconcilia achados já rastreados dessa conta
    // (fast path sem I/O extra se não há nenhum aberto).
    //
    // #6156 P1 — `setImmediate`, nunca inline: mesmo motivo do
    // fire-and-forget acima (função síncrona que pode spawnar `gh`).
    const account = resolveBrevoAccountLabel(extractApiKeyFromInit(init));
    pendingUnrecognisedIpWork = new Promise((resolveWork) => {
      setImmediate(() => {
        try {
          maybeReconcileResolvedFindings(account);
        } finally {
          resolveWork();
        }
      });
    });
  }
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
 *
 * `scheduledAt` (#4668): opcional/nullable — presente quando a campanha tem
 * data agendada. A Brevo devolve esse campo com OFFSET (ex:
 * "...-03:00"), não necessariamente "Z" — quem compara contra um alvo local
 * deve usar `Date.parse`/instante, nunca igualdade de string (ver
 * `isSameInstant` em `clarice-schedule-group.ts`).
 */
export async function brevoGetCampaign(
  apiKey: string,
  campaignId: number,
  _sleep = _defaultSleep,
): Promise<{ id: number; name: string; subject?: string; status: string; scheduledAt?: string | null }> {
  return withBrevo429Retry(async () => {
    const res = await brevoRawFetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}`, {
      method: "GET",
      headers: { "api-key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Brevo API GET /emailCampaigns/${campaignId} falhou (${res.status}): ${text}`);
    }
    // `subject` (#4704 fleet review): a API sempre devolve o campo — já tipado
    // em `CampaignDetail` (scripts/clarice-cta-ab-setup.ts), só faltava aqui.
    // Aditivo: callers existentes ignoram o campo extra, nenhum contrato quebra.
    const data = await res.json() as { id: number; name: string; subject?: string; status: string; scheduledAt?: string | null };
    return data;
  }, _sleep);
}

export async function brevoGetList(
  apiKey: string,
  listId: number,
  _sleep = _defaultSleep,
  // #4764: `totalBlacklisted` já vem na mesma resposta — só faltava tipar.
  // Distingue "contato blacklistado globalmente na conta" (nunca receberia
  // o e-mail de qualquer forma) de perda real por drop silencioso da Brevo
  // (#4577/#4720). Opcional na leitura por segurança (aditivo, nunca deveria
  // faltar na resposta real da API, mas um shape inesperado não deve quebrar
  // callers existentes que só liam `totalSubscribers`).
): Promise<{ id: number; name: string; totalSubscribers: number; totalBlacklisted?: number }> {
  return withBrevo429Retry(async () => {
    const res = await brevoRawFetch(`https://api.brevo.com/v3/contacts/lists/${listId}`, {
      method: "GET",
      headers: { "api-key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Brevo API GET /contacts/lists/${listId} falhou (${res.status}): ${text}`);
    }
    const data = await res.json() as { id: number; name: string; totalSubscribers: number; totalBlacklisted?: number };
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
    maybeRecordCampaignRateLimit(path, r.headers); // #5697
    if (r.status === 401 && typeof r.clone === "function") {
      // #6137: `r.clone()` — o branch `!r.ok` abaixo ainda lê `await r.text()`
      // pro corpo do erro; ler aqui sem clonar consumiria o stream. Guard
      // `typeof r.clone === "function"`: ver mesma nota em `brevoRawFetch`
      // acima — alguns testes deste repo mockam `fetch` sem `.clone()`.
      //
      // #6156 P1 — fire-and-forget, NUNCA `await` (mesma nota de
      // `brevoRawFetch` acima): aqui é AINDA mais crítico, este `fetch` roda
      // dentro do loop de retry (`for attempt <= RETRY_MS.length`), então um
      // `await` bloquearia cada tentativa.
      pendingUnrecognisedIpWork = maybeReportUnrecognisedIp(`https://api.brevo.com/v3${path}`, apiKey, r.clone()).catch(
        (e) => console.error("[brevo-client] maybeReportUnrecognisedIp falhou (fire-and-forget):", e),
      );
    } else if (provesIpAllowlisted(r.status)) {
      // #6137 (auto-close) + #6156 P1/P2 — ver mesma nota em `brevoRawFetch`
      // acima. `provesIpAllowlisted` exclui 429/5xx (que este loop também
      // retenta) — sem isso, um `brevoGet` que apanhasse 429/500 repetido
      // chamaria a reconciliação uma vez por tentativa de retry, inflando o
      // streak de "achado resolvido" sem nenhuma prova real de que a conta
      // passou a allowlist.
      const account = resolveBrevoAccountLabel(apiKey);
      pendingUnrecognisedIpWork = new Promise((resolveWork) => {
        setImmediate(() => {
          try {
            maybeReconcileResolvedFindings(account);
          } finally {
            resolveWork();
          }
        });
      });
    }
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
// (task diária 08:30) ainda não propagou o incremento" (lag observado: até
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

// ---------------------------------------------------------------------------
// #5064 — campanhas DRAFT (rascunho: `--create` rodou, `--schedule` ainda
// não). `/api/campaigns?includeScheduled=1` do dashboard (usado por
// clarice-plan-wave.ts pra montar `state.waves`) só devolve `sent`+`queued`
// (ver `buildCampaignsResponse` no Worker) — uma onda PARCIALMENTE MONTADA
// fica invisível pro guard `detectExistingWaveForSendDate` em
// clarice-envio-run.ts. Igual a fetchQueuedCampaignListIds/
// fetchSentCampaignListIds, mas devolvendo os OBJETOS completos (não só
// list ids): o consumidor precisa de `name`+`recipients` pra que
// summarizeCycleSends (clarice-wave-plan.ts) consiga atribuir a campanha a
// uma onda/ciclo, exatamente como já faz pra sent/queued.
// ---------------------------------------------------------------------------

export interface BrevoDraftCampaignRaw {
  id?: number;
  name?: string;
  subject?: string;
  status?: string;
  sentDate?: string | null;
  scheduledAt?: string | null;
  createdAt?: string;
  recipients?: { lists?: number[] };
}
interface BrevoDraftCampaignsResponse {
  campaigns?: BrevoDraftCampaignRaw[];
}

/** Status aceitos por `GET /v3/emailCampaigns?status=`. */
export type BrevoCampaignStatus = "draft" | "queued" | "sent";

/**
 * `GET /v3/emailCampaigns?status={status}`, paginado (`limit=50`) — devolve
 * os objetos COMPLETOS de campanha (id/name/subject/status/sentDate/
 * scheduledAt/recipients), não só list ids como
 * `fetchCampaignListIdsByStatus` acima. Custo de cota CONSTANTE
 * independente do número de campanhas do status pedido: ~1 chamada a cada
 * 50 campanhas, nunca 1 por campanha (#5697 — extraído do que antes era só
 * `fetchDraftCampaigns`, generalizado pra qualquer status; usado também por
 * `scripts/clarice-audit-overlap.ts` pra auditoria de sobreposição de
 * destinatários com custo fixo, ~2 chamadas totais).
 */
export async function fetchCampaignsByStatus(
  apiKey: string,
  status: BrevoCampaignStatus,
): Promise<BrevoDraftCampaignRaw[]> {
  const out: BrevoDraftCampaignRaw[] = [];
  let offset = 0;
  const limit = 50;
  for (;;) {
    const { body } = await brevoGet(apiKey, `/emailCampaigns?status=${status}&limit=${limit}&offset=${offset}`);
    const campaigns = (body as BrevoDraftCampaignsResponse)?.campaigns ?? [];
    out.push(...campaigns);
    if (campaigns.length < limit) break;
    offset += limit;
  }
  return out;
}

/**
 * `GET /v3/emailCampaigns?status=draft`, paginado — todas as campanhas
 * Brevo em rascunho. Chamada direta à Brevo (mesmo padrão de
 * `fetchCampaignListIdsByStatus` acima): a key já está disponível
 * localmente (`BREVO_CLARICE_API_KEY`), então não precisa de nenhum
 * endpoint novo no Worker `brevo-dashboard` pra fechar este guard.
 *
 * #5697: agora um alias fino sobre `fetchCampaignsByStatus(apiKey, "draft")`
 * — mesmo comportamento/URLs, sem duplicar a paginação.
 */
export async function fetchDraftCampaigns(apiKey: string): Promise<BrevoDraftCampaignRaw[]> {
  return fetchCampaignsByStatus(apiKey, "draft");
}

// ---------------------------------------------------------------------------
// brevoSendNow (#4347 G7/D7) — dispara uma campanha IMEDIATAMENTE, sem
// agendamento. `clarice-schedule-group.ts` (`--send-now`) usa isto no lugar
// do `--schedule` (PUT scheduledAt) quando a janela é "agora" — laço
// cadastro-novo→envio-imediato da skill `/diaria-clarice-novos`.
// ---------------------------------------------------------------------------

/**
 * `POST /v3/emailCampaigns/{id}/sendNow` — dispara a campanha AGORA. Mesma
 * disciplina de retry/rate-limit de `brevoPost` (via `withBrevo429Retry`).
 * O corpo de resposta é irrelevante (a Brevo retorna 204 sem corpo) — quem
 * chama deve confirmar o disparo via GET pós-POST
 * (`brevoGetCampaign`/`isTerminalSendStatus` abaixo), nunca confiar só no 2xx
 * do POST (#4347 — o mesmo racional de `applyVerifyResults` pro `--schedule`).
 */
export async function brevoSendNow(
  apiKey: string,
  campaignId: number,
  _sleep = _defaultSleep,
): Promise<void> {
  await withBrevo429Retry(async () => {
    const res = await brevoRawFetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}/sendNow`, {
      method: "POST",
      headers: { "api-key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Brevo API POST /emailCampaigns/${campaignId}/sendNow falhou (${res.status}): ${text}`);
    }
    await res.body?.cancel().catch(() => {});
  }, _sleep);
}

/**
 * Status TERMINAL de um disparo imediato — `sent` (já processado) OU
 * `inProcess`/`in_process` (a Brevo aceitou e está enviando; "terminal" aqui
 * significa "confirmadamente em curso", não necessariamente concluído —
 * distinto de `draft`/`queued`, que indicariam que o `sendNow` NÃO pegou).
 * Usado pelo GET-verify pós-`sendNow` — nunca confiar só no 2xx do POST (#4347).
 *
 * #5050 — achado ao vivo (260811): a Brevo devolveu `"in_process"`
 * (snake_case) pra uma campanha CONFIRMADAMENTE enviada (campanha #132,
 * editor recebeu cópia) — só `"inProcess"` (camelCase) era reconhecido, então
 * todo `sendNow` bem-sucedido por este caminho caía no branch de "disparo
 * incerto", e pior: `checkSendNowGuard` (clarice-schedule-group.ts) usa esta
 * mesma função pro guard anti-reenvio — com `"in_process"` não reconhecido
 * como terminal, o guard não barrava um 2º POST `sendNow` na mesma campanha.
 * Aceita as duas grafias (defensivo — sem garantia de que a Brevo é
 * consistente entre endpoints/versões da API).
 */
export function isTerminalSendStatus(status: string): boolean {
  return status === "sent" || status === "inProcess" || status === "in_process";
}

/**
 * #4364: mensagem específica pro GET-verify pós-`sendNow` quando o status NÃO
 * é terminal (`isTerminalSendStatus` acima já cobre a checagem de sucesso).
 * `"in_review"` é um status conhecido e documentado da própria Brevo (revisão
 * automática de compliance/anti-abuso da plataforma — possivelmente disparada
 * por sinal de reputação, não confirmado, a API não expõe o motivo em nenhum
 * campo de `GET /emailCampaigns/{id}`) — reproduzido ao vivo em 260731
 * (campanha #101, `queued` → `in_review`, nunca chegou a `sent`/`inProcess`).
 * Antes desta função, `in_review` caía no mesmo branch genérico de "status
 * incerto, reconsulte manualmente" que qualquer outro valor desconhecido —
 * o exit code 2 (seguro) já era o comportamento correto, isto só melhora a
 * mensagem pra nomear o estado real em vez de mascará-lo como "incerto".
 *
 * `"queued"` ganhou mensagem própria em #4718 (item 3 da issue): antes caía
 * no genérico "reconsulte a Brevo manualmente", que soa como "tente de novo"
 * — e a orientação anterior no chamador ERA literalmente "re-tente
 * --send-now", o que levou a um 2º POST `sendNow` na mesma campanha já
 * disparada (incidente ao vivo 260806, campanha #121: o GET imediato leu
 * "queued" — lag assíncrono normal da Brevo, não falha — e o 1º disparo
 * tinha funcionado desde o início). A mensagem agora deixa explícito que
 * "queued" é progresso, não incerteza, e que reenviar é o comportamento
 * errado (o guard `checkSendNowGuard` em `clarice-schedule-group.ts` fecha o
 * buraco de fato; isto só corrige o texto que empurrava o operador pra lá).
 * Qualquer outro status não-terminal (`draft`, etc.) cai no genérico.
 */
export function describeUncertainSendStatus(status: string): string {
  if (status === "in_review") {
    return (
      `status="in_review" — campanha em revisão da própria Brevo (compliance/anti-abuso), ` +
      `checar app.brevo.com; geralmente exige ação humana no painel, não é um erro do nosso lado.`
    );
  }
  if (status === "queued") {
    return (
      `status="queued" — a Brevo ACEITOU o disparo e está processando a fila (lag assíncrono ` +
      `normal, costuma resolver em segundos); NÃO é indício de falha. Reconsulte em instantes — ` +
      `NÃO re-dispare (#4718: um novo --send-now não repete o POST enquanto a Brevo confirmar ` +
      `"queued"/"inProcess"/"sent" ao vivo, mas repetir a invocação sem necessidade continua ` +
      `sendo trabalho evitável).`
    );
  }
  return `status="${status}" não confirma disparo — reconsulte a Brevo manualmente.`;
}

/**
 * #4718 (item 1 da issue) — GET-verify pós-`sendNow` com retry curto e
 * backoff fixo (default: 3 tentativas, 5s entre elas) antes de declarar o
 * disparo incerto. `"queued"` costuma resolver pra `"sent"`/`"inProcess"` em
 * segundos — um único GET imediatamente após o POST (comportamento anterior
 * a este fix) capturava a campanha nesse limbo assíncrono e produzia um
 * falso "disparo não confirmado" mesmo quando o disparo funcionou desde o
 * início (confirmado ao vivo: campanha #121 — GET imediato leu "queued",
 * consulta minutos depois já mostrava "sent", 88 entregues, 0 bounce).
 *
 * Só insiste enquanto o status for especificamente `"queued"` — outros
 * status não-terminais (`"draft"`, `"in_review"`, etc.) não têm motivo pra
 * virar terminal sozinhos com a passagem do tempo, então retorna já na 1ª
 * leitura sem gastar retries à toa. `getCampaignFn`/`sleepFn` injetáveis pra
 * testabilidade sem rede/tempo real (mesmo padrão de `_sleep` no resto deste
 * arquivo).
 */
export async function pollTerminalSendStatus(
  apiKey: string,
  campaignId: number,
  opts: {
    attempts?: number;
    delayMs?: number;
    getCampaignFn?: (apiKey: string, campaignId: number) => Promise<{ status: string; scheduledAt?: string | null }>;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ status: string; scheduledAt?: string | null }> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 5000;
  const getCampaignFn = opts.getCampaignFn ?? brevoGetCampaign;
  const sleepFn = opts.sleepFn ?? _defaultSleep;

  let last: { status: string; scheduledAt?: string | null } = { status: "unknown" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await getCampaignFn(apiKey, campaignId);
    if (isTerminalSendStatus(last.status)) return last;
    if (last.status !== "queued") return last;
    if (attempt < attempts) await sleepFn(delayMs);
  }
  return last;
}

// ---------------------------------------------------------------------------
// Folders (#4347 Etapa 4) — "Clarice novos" dedicada, resolvida por nome ou
// criada se ausente. `clarice-import-waves.ts --folder-id N` já aceita um id
// arbitrário; isto resolve QUAL id passar sem o editor copiar manualmente.
// ---------------------------------------------------------------------------

/** Paginado, mesmo padrão de `brevoListAllLists`. */
export async function brevoListAllFolders(
  apiKey: string,
  _sleep = _defaultSleep,
): Promise<{ id: number; name: string }[]> {
  const out: { id: number; name: string }[] = [];
  let offset = 0;
  for (;;) {
    const page = await withBrevo429Retry(async () => {
      const res = await brevoRawFetch(`https://api.brevo.com/v3/contacts/folders?limit=50&offset=${offset}`, {
        headers: { "api-key": apiKey, Accept: "application/json" },
      });
      if (!res.ok) {
        const rawText = await res.text();
        const text = rawText.length > 500 ? rawText.slice(0, 500) + "… [truncado]" : rawText;
        throw new Error(`Brevo API GET /contacts/folders falhou (${res.status}): ${text}`);
      }
      return (await res.json()) as { folders?: { id: number; name: string }[] };
    }, _sleep);
    const folders = page.folders ?? [];
    out.push(...folders.map((f) => ({ id: f.id, name: f.name })));
    if (folders.length < 50) break;
    offset += 50;
  }
  return out;
}

/**
 * Resolve o id da folder Brevo com `name` — reusa se já existe, cria (POST
 * /contacts/folders) se não. Lança em qualquer falha (o caller decide o
 * fallback pra folder 1, ver `clarice-resolve-folder.ts`).
 */
export async function resolveOrCreateBrevoFolder(
  apiKey: string,
  name: string,
  _sleep = _defaultSleep,
): Promise<number> {
  const existing = await brevoListAllFolders(apiKey, _sleep);
  const found = existing.find((f) => f.name === name);
  if (found) return found.id;
  const created = (await brevoPost(apiKey, "/contacts/folders", { name }, _sleep)) as { id?: number };
  if (typeof created.id !== "number") {
    throw new Error(`/contacts/folders POST shape inesperado: ${JSON.stringify(created)}`);
  }
  return created.id;
}

// ---------------------------------------------------------------------------
// Contact attributes (#4634 finding do type-design-analyzer) — mesmo padrão
// duplicado até aqui em `inject-poll-token-brevo.ts::ensureContactAttribute`
// (POLL_TOKEN) e `sync-apoio-nivel-brevo.ts::ensureContactAttribute`
// (APOIO_NIVEL). Extraído aqui como a versão compartilhada; migrar
// `inject-poll-token-brevo.ts` pra usá-la é follow-up separado, fora do
// escopo desta unidade (não expandir — decisão explícita do briefing #4634).
// ---------------------------------------------------------------------------

interface BrevoContactAttributeMinimal {
  name: string;
}

/**
 * Lista os nomes de atributos de contato existentes na conta. `GET
 * /contacts/attributes` FALHA ALTO em qualquer status != 200 em vez de
 * reusar a tolerância a 404 de `brevoGet` (que devolve `{status:404,
 * body:{}}` como resultado benigno) — essa tolerância foi desenhada pra
 * lookup de UMA entidade (ex: contato que sumiu entre listar e buscar), não
 * pra esta listagem em massa (a única lista de atributos da conta inteira).
 * Um 404/erro aqui não significa "conta sem atributos" — significa que algo
 * está quebrado (key errada, endpoint indisponível) — mesmo racional já
 * corrigido em `inject-poll-token-brevo.ts::iterateListContacts` (#4532: "404
 * numa listagem em massa não significa vazio, significa que algo está
 * errado"). Tratar como vazio faria `ensureBrevoContactAttribute` tentar
 * recriar um atributo que já existe, ou mascarar um erro real como "sucesso,
 * atributo ausente".
 */
async function fetchBrevoContactAttributeNames(apiKey: string): Promise<Set<string>> {
  const { status, body } = await brevoGet(apiKey, "/contacts/attributes");
  if (status !== 200) {
    throw new Error(
      `Brevo API ${status} em /contacts/attributes — leitura de atributos falhou (não seguro assumir ` +
        "lista vazia; #4634, mesma disciplina de #4532 pra listagem em massa).",
    );
  }
  return new Set<string>(
    ((body as { attributes?: BrevoContactAttributeMinimal[] })?.attributes ?? []).map((a) => a.name),
  );
}

/**
 * Garante que um atributo de contato "normal" existe na conta Brevo,
 * criando-o (`POST /contacts/attributes/normal/{attrName}`) se ausente e
 * confirmando a criação por RELEITURA (#4634, achado silent-failure-hunter —
 * mesma disciplina de `applyBrevoApoioAddEntry`/`applyBrevoApoioRemoveEntry`
 * em `sync-apoio-nivel-brevo.ts`, lição #4273: nunca confiar só no 2xx do
 * POST). Idempotente — retorna `false` sem nenhuma escrita se o atributo já
 * existir. Retorna `true` se criou agora (o caller decide se loga).
 */
export async function ensureBrevoContactAttribute(
  apiKey: string,
  attrName: string,
  attrType = "text",
): Promise<boolean> {
  const existing = await fetchBrevoContactAttributeNames(apiKey);
  if (existing.has(attrName)) return false;

  await brevoPost(apiKey, `/contacts/attributes/normal/${attrName}`, { type: attrType });

  const confirmed = await fetchBrevoContactAttributeNames(apiKey);
  if (!confirmed.has(attrName)) {
    throw new Error(
      `releitura pós-criação NÃO confere: atributo "${attrName}" ainda não aparece em ` +
        "/contacts/attributes — mutação não confirmada.",
    );
  }
  return true;
}
