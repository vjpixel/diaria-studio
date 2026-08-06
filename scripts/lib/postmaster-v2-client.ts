/**
 * scripts/lib/postmaster-v2-client.ts (#4704)
 *
 * Cliente genérico pra `domains.domainStats.query` — a API v2 do Google
 * Postmaster Tools. Continua um módulo separado (não fundido em
 * `postmaster-spam-sync.ts`) porque é reusável por outros consumidores
 * futuros (`FEEDBACK_LOOP_SPAM_RATE` por campanha, `getComplianceStatus`) —
 * mas desde 260806 (#4704) É a fonte do breaker de spam da Rampa:
 * `postmaster-spam-sync.ts` migrou de v1 (`trafficStats.get`) pra
 * `queryDomainStatsV2` (este módulo) como caller de produção, decisão
 * registrada no #4703 depois de confirmar ao vivo que v1 e v2 divergem no
 * mesmo dia/domínio.
 *
 * Por quê a v2 existe como módulo separado em vez de virar código inline de
 * `postmaster-spam-sync.ts` (#4704, confirmado ao vivo em 260806):
 *
 *   1. **Spam POR CAMPANHA.** `FEEDBACK_LOOP_SPAM_RATE` filtrado por
 *      `feedback_loop_id` dá o que a v1 nunca teve — hoje "spam" é
 *      propriedade do domínio inteiro, sem separar a newsletter de outro
 *      tráfego do mesmo domínio, nem uma variante de assunto A/B/C da outra.
 *   2. **Query por intervalo.** A v1 faz 1 GET por dia (N chamadas) — não
 *      verifiquei ao vivo a frequência de 429 (afirmação anterior deste
 *      docstring era universal e sem citação; removida por precisão). O que
 *      é estruturalmente verdade e não precisa de medição: a v2 aceita um
 *      `DateRange` inteiro numa chamada só, então N GETs viram 1 POST — a
 *      superfície de rate limit encolhe por construção, seja qual for a
 *      taxa real de 429 hoje.
 *   3. **v1 e v2 DIVERGEM materialmente no mesmo dia.** Medido ao vivo em
 *      260806 pra `clarice.ai`, 03/08/2026: v1 (`trafficStats.get`, campo
 *      `userReportedSpamRatio`) leu **1,6%**; v2 (`domainStats.query`,
 *      métrica `SPAM_RATE`) leu **0,00%** pro MESMO domínio, MESMO dia — via
 *      chamada de API real, não comparação de screenshot de UI (#4703). Por
 *      isso a troca de qual fonte alimenta o breaker de produção é uma
 *      decisão consciente e registrada, não algo que este módulo decide
 *      sozinho — ver #4703/#4704 pro estado da decisão.
 *
 * Uso típico (todo I/O passa por `gFetch`, que já lida com refresh de token):
 *
 *   import { gFetch } from "../google-auth.ts";
 *   import { queryDomainStatsV2, extractSpamRateReadingsV2 } from "./postmaster-v2-client.ts";
 *
 *   const response = await queryDomainStatsV2(
 *     "clarice.ai",
 *     [{ name: "spam_rate", standardMetric: "SPAM_RATE" }],
 *     { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 6 } },
 *     gFetch,
 *   );
 *   const readings = extractSpamRateReadingsV2(response, "spam_rate");
 *
 * Escopo requerido: `postmaster.traffic.readonly` (ou `postmaster`, mais
 * amplo — não usado aqui, mesma disciplina de escopo mínimo do #4539) — ver
 * `scripts/oauth-setup.ts`. Token emitido antes do #4704 não tem o scope
 * novo; falha aqui com 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT` até o editor
 * rodar `oauth-setup.ts` de novo e reaprovar no browser.
 */

import { POSTMASTER_V2_BASE } from "../postmaster-register-domain.ts";

/**
 * Subconjunto de `BaseMetric.standardMetric` (discovery doc v2) que este
 * módulo sabe construir/interpretar. A API aceita mais valores (ver
 * `AUTH_SUCCESS_RATE`, `TLS_ENCRYPTION_RATE`, `DELIVERY_ERROR_RATE`,
 * `DELIVERY_ERROR_COUNT`) — fora de escopo até haver um consumidor real.
 */
export type StandardMetric = "SPAM_RATE" | "FEEDBACK_LOOP_ID" | "FEEDBACK_LOOP_SPAM_RATE";

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export interface DateRangeV2 {
  start: CalendarDate;
  end: CalendarDate;
}

export interface MetricDefinitionV2 {
  /** Nome escolhido pelo chamador — ecoado em `DomainStatV2.metric` na resposta, correlaciona pedido↔resultado. */
  name: string;
  standardMetric: StandardMetric;
  /**
   * `FEEDBACK_LOOP_SPAM_RATE` exige `feedback_loop_id` no filter (formato
   * `feedback_loop_id = "<id>"`, opcionalmente `AND aggregation_key_type = "<tipo>"`).
   * `SPAM_RATE`/`FEEDBACK_LOOP_ID` não usam filter.
   */
  filter?: string;
}

/**
 * `StatisticValue` (discovery doc v2) — o valor vem SEMPRE aninhado sob
 * `DomainStatV2.value`, nunca no nível raiz do `DomainStatV2` (confirmado ao
 * vivo em 260806, probe real contra `domains/clarice.ai/domainStats:query`
 * — fixture exata em `test/postmaster-v2-client.test.ts`, teste
 * "200: retorna domainStats parseado").
 *
 * Só `floatValue` foi confirmado ao vivo (métrica `SPAM_RATE`) —
 * `doubleValue`/`intValue`/`stringValue`/`stringList` são inferidos do
 * discovery doc pra outras métricas (`AUTH_SUCCESS_RATE`, contadores,
 * `FEEDBACK_LOOP_ID`), nunca exercitados contra a API real. Ver
 * `extractSpamRateReadingsV2` pro fallback defensivo `floatValue ?? doubleValue`.
 */
export interface StatisticValueV2 {
  floatValue?: number;
  doubleValue?: number;
  intValue?: string;
  stringValue?: string;
  stringList?: string[];
}

export interface DomainStatV2 {
  metric: string;
  date?: CalendarDate;
  /** `undefined` quando a API não devolveu `value` pro dia/métrica (dia sem dado ainda) — ver `extractSpamRateReadingsV2`. */
  value?: StatisticValueV2;
}

export interface QueryDomainStatsResponseV2 {
  domainStats: DomainStatV2[];
  nextPageToken?: string;
}

/**
 * Pura/testável: monta o corpo de `domains.domainStats.query` pra 1+ métricas
 * sobre um único DateRange, granularidade DAILY (um `DomainStatV2` por dia —
 * mesmo grão que a v1 sondava dia a dia, mas numa chamada só).
 */
export function buildDomainStatsQueryBody(
  domain: string,
  metricDefinitions: MetricDefinitionV2[],
  range: DateRangeV2,
): Record<string, unknown> {
  if (metricDefinitions.length === 0) {
    throw new Error("[postmaster-v2-client] metricDefinitions vazio — pelo menos 1 métrica é obrigatória.");
  }
  const missingFilter = metricDefinitions.find((m) => m.standardMetric === "FEEDBACK_LOOP_SPAM_RATE" && !m.filter);
  if (missingFilter) {
    throw new Error(
      `[postmaster-v2-client] métrica "${missingFilter.name}" é FEEDBACK_LOOP_SPAM_RATE sem filter — exige feedback_loop_id (ver MetricDefinitionV2.filter).`,
    );
  }
  return {
    parent: `domains/${domain}`,
    aggregationGranularity: "DAILY",
    timeQuery: { dateRanges: { dateRanges: [{ start: range.start, end: range.end }] } },
    metricDefinitions: metricDefinitions.map((m) => ({
      name: m.name,
      baseMetric: { standardMetric: m.standardMetric },
      ...(m.filter ? { filter: m.filter } : {}),
    })),
  };
}

/** Mensagem de erro consistente com o resto do arquivo do #4539 (`postmaster-register-domain.ts`) — mesmo vocabulário de conserto pra scope insuficiente/API desabilitada/401. */
function describeQueryFailure(status: number, body: string): string {
  const b = body ?? "";
  if (b.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || b.includes("insufficient authentication scopes")) {
    return "token sem o scope postmaster.traffic.readonly — rode `npx tsx scripts/oauth-setup.ts` e reaprove no browser (#4704).";
  }
  if (b.includes("SERVICE_DISABLED") || b.includes("has not been used in project")) {
    return "Gmail Postmaster Tools API não habilitada no projeto GCP deste OAuth client (console.cloud.google.com → APIs → Gmail Postmaster Tools API → Ativar).";
  }
  if (status === 401) {
    return "401 mesmo após retry — refresh token revogado/expirado. Rode `npx tsx scripts/oauth-setup.ts`.";
  }
  if (status === 403) {
    return "403 sem código de scope/API reconhecido — confira permissão do domínio em postmaster.google.com/managedomains.";
  }
  return `HTTP ${status} inesperado. Corpo: ${b.slice(0, 300)}`;
}

/**
 * Assinatura mínima exigida de `fetchImpl` — deliberadamente MAIS ESTREITA
 * que `typeof fetch` (que aceita `URL | RequestInfo`) porque `gFetch`
 * (`scripts/google-auth.ts`) só aceita `string` no 1º argumento. `fetch`
 * global e os fakes de teste (tipados `typeof fetch`) continuam compatíveis
 * aqui por variância normal de parâmetro de função — só quem NÃO era
 * compatível (`gFetch`) passa a ser aceito. Achado ao integrar este módulo
 * no primeiro consumidor real (#4704, 260806): `typeof fetch` barrava
 * `gFetch` na chamada de `postmaster-spam-sync.ts`, um erro de tipo latente
 * desde a criação do módulo (#4704 anterior) que só apareceu quando um
 * caller de produção de fato tentou passar `gFetch`.
 */
type PostmasterV2FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * I/O: chama `domains.domainStats.query`. `fetchImpl` é injetável (mesmo
 * padrão de `postmaster-register-domain.ts`) — produção passa `gFetch`, os
 * testes passam um fake pra não bater rede/token real.
 */
export async function queryDomainStatsV2(
  domain: string,
  metricDefinitions: MetricDefinitionV2[],
  range: DateRangeV2,
  fetchImpl: PostmasterV2FetchImpl,
): Promise<QueryDomainStatsResponseV2> {
  const res = await fetchImpl(`${POSTMASTER_V2_BASE}/domains/${encodeURIComponent(domain)}/domainStats:query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildDomainStatsQueryBody(domain, metricDefinitions, range)),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`[postmaster-v2-client] falha em domainStats.query: ${describeQueryFailure(res.status, bodyText)}`);
  }
  let parsed: QueryDomainStatsResponseV2;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`[postmaster-v2-client] resposta 2xx não é JSON válido: ${bodyText.slice(0, 300)}`);
  }
  return { domainStats: parsed.domainStats ?? [], nextPageToken: parsed.nextPageToken };
}

/** `CalendarDate` → `YYYY-MM-DD`, mesmo formato de `PostmasterSpamEntry.date` em postmaster-spam-sync.ts. */
export function calendarDateToEntryDate(d: CalendarDate): string {
  const m = String(d.month).padStart(2, "0");
  const day = String(d.day).padStart(2, "0");
  return `${d.year}-${m}-${day}`;
}

export interface DayReadingV2 {
  date: string;
  ratio: number;
}

/**
 * Pura/testável: converte a resposta bruta de `domainStats.query` (métrica
 * `SPAM_RATE`, filtrada por `metricName`) em leituras por dia.
 *
 * Um dia AUSENTE da lista `domainStats` significa "sem dado ainda" — análogo
 * ao 404 da v1 (nunca vira 0%, ver docstring de `postmaster-spam-sync.ts`).
 * Um dia PRESENTE com `value.floatValue: 0` é 0% real (confirmado ao vivo em
 * 260806: 01/08 e 03/08 vieram exatamente assim). O que este endpoint NÃO
 * distingue é "0% confirmado" de "volume baixo demais pra medir"
 * (`MESSAGE_VOLUME_LOW`) — essa distinção fica em `getComplianceStatus`,
 * outro endpoint, fora de escopo deste módulo (ver checklist da #4704).
 *
 * Lê `floatValue ?? doubleValue` — só `floatValue` foi confirmado ao vivo
 * pra `SPAM_RATE` (ver `StatisticValueV2`), mas o fallback evita que uma
 * métrica futura (`FEEDBACK_LOOP_SPAM_RATE`) que serialize como `doubleValue`
 * seja descartada em silêncio, indistinguível de "sem dado ainda".
 */
export function extractSpamRateReadingsV2(
  response: QueryDomainStatsResponseV2,
  metricName: string,
): DayReadingV2[] {
  return response.domainStats
    .filter((s) => {
      const v = s.value?.floatValue ?? s.value?.doubleValue;
      return s.metric === metricName && s.date && typeof v === "number";
    })
    .map((s) => ({
      date: calendarDateToEntryDate(s.date as CalendarDate),
      ratio: (s.value!.floatValue ?? s.value!.doubleValue) as number,
    }));
}
