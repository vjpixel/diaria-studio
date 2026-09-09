/**
 * scripts/lib/meta-capi-staleness.ts (#7776, follow-up do #5504)
 *
 * Lógica PURA + I/O de rede injetável do alarme periódico que compara
 * `server_last_fired_time` do dataset (pixel) da Meta contra `now` —
 * fecha o gap descrito na issue: `META_CAPI_ACCESS_TOKEN` nunca foi setado
 * em nenhum dos 3 workers que chamam `sendCompleteRegistrationEvent`
 * (`scripts/lib/shared/meta-capi.ts`), e nada no projeto observava isso —
 * o fail-soft funcionou exatamente como escrito, mas sem detecção.
 *
 * ## Duas checagens independentes, mesma unidade
 *
 * 1. **Leitura do dataset** (`fetchDatasetServerLastFiredTime`) — GET
 *    `{dataset_id}?fields=server_last_fired_time` no Graph API, mesmo
 *    campo que `ads_get_dataset_details` (MCP) expôs ao vivo na issue
 *    (`"1969-12-31T16:00:00-0800"` = epoch 0 = nunca disparou). Usa o
 *    MESMO `META_CAPI_ACCESS_TOKEN` do `.env` local que
 *    `scripts/meta-capi-batch-send.ts` já lê via `process.env` — um
 *    system user com acesso ao dataset tipicamente também pode LER as
 *    stats dele (não é uma 2ª credencial nova).
 * 2. **Staleness pura** (`computeCapiStaleness`) — decide se o timestamp
 *    lido conta como "parado" — sem tocar rede, testável com qualquer
 *    string/epoch injetado.
 *
 * ## Fail-soft do PRÓPRIO alarme (obrigatório, mesmo padrão dos demais
 * alarmes do repo — `context/overnight-dispatch-rules.md`)
 *
 * Sem `META_CAPI_ACCESS_TOKEN` no `.env` local, sem rede, ou resposta HTTP
 * não-2xx da Meta: o alarme conclui "não dá pra verificar agora" e SAI
 * LIMPO — nunca produz um alarme falso a partir de uma leitura que ele não
 * conseguiu fazer. Isso é DIFERENTE do achado que este alarme detecta (CAPI
 * configurada mas sem disparar) — a distinção fica em
 * `MetaCapiStalenessVerdict` (`"cannot-verify"` vs. `"stale"`/`"ok"`).
 *
 * @module
 */

/** Dias sem `server_last_fired_time` avançar antes de considerar "parado".
 * O uso normal (dezenas de cadastros/dia, confirmado ao vivo na issue via
 * `last_fired_time` do pixel client-side) faz este threshold generoso —
 * mesmo um dia fraco de cadastros não deveria cruzar 2 dias parado. */
export const DEFAULT_CAPI_STALENESS_THRESHOLD_DAYS = 2;

// ---------------------------------------------------------------------------
// Staleness pura
// ---------------------------------------------------------------------------

export interface CapiStalenessCheck {
  isStale: boolean;
  /** `true` quando o dataset nunca disparou um evento server-side —
   * `serverLastFiredTime` ausente, ou epoch 0 (o valor "nunca disparou" que
   * a Meta devolve — `"1969-12-31T16:00:00-0800"` na issue, `getTime() ===
   * 0` em qualquer timezone). */
  neverFired: boolean;
  /** `null` quando `neverFired` — não há "dias desde" um disparo que nunca
   * aconteceu. */
  daysSinceLastFired: number | null;
}

/**
 * Avalia se `serverLastFiredTime` (valor cru devolvido pelo Graph API, ou
 * `null` se a leitura falhou/o campo veio ausente) está STALE em relação a
 * `now`, com o threshold em dias.
 *
 * @pure
 */
export function computeCapiStaleness(
  serverLastFiredTime: string | null,
  now: Date,
  thresholdDays: number = DEFAULT_CAPI_STALENESS_THRESHOLD_DAYS,
): CapiStalenessCheck {
  if (!serverLastFiredTime) {
    return { isStale: true, neverFired: true, daysSinceLastFired: null };
  }
  const fired = new Date(serverLastFiredTime);
  if (isNaN(fired.getTime()) || fired.getTime() === 0) {
    return { isStale: true, neverFired: true, daysSinceLastFired: null };
  }
  const daysSinceLastFired = Math.floor((now.getTime() - fired.getTime()) / 86_400_000);
  return { isStale: daysSinceLastFired > thresholdDays, neverFired: false, daysSinceLastFired };
}

// ---------------------------------------------------------------------------
// Leitura do dataset — rede injetável, nunca lança
// ---------------------------------------------------------------------------

export type MetaCapiDatasetReadResult =
  | { ok: true; serverLastFiredTime: string | null }
  | { ok: false; reason: "not_configured" | "meta_error" | "network_error"; status?: number };

export interface FetchDatasetStalenessOptions {
  /** `META_CAPI_ACCESS_TOKEN` — `undefined`/`""` é "não configurado", nunca
   * erro (mesmo contrato de `SendMetaCapiEventOptions` em meta-capi.ts). */
  accessToken: string | undefined;
  datasetId?: string;
  apiVersion?: string;
  /** Override do host base — só pra teste (evita mock de `fetchImpl` só
   * pra trocar o domínio). Default: `https://graph.facebook.com/{apiVersion}`. */
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Mesmo dataset padrão de `META_CAPI_DEFAULT_DATASET_ID`
 * (`scripts/lib/shared/meta-capi.ts`) — duplicado aqui de propósito
 * (import cruzado `scripts/lib/` ↔ `scripts/lib/shared/` violaria a
 * fronteira do #2747, ver `test/lib-boundary.test.ts`; este módulo é
 * `scripts/lib/` puro, não `shared/`, porque só roda em Node — usa
 * `process.env` via o script CLI, nunca no runtime Workers). Não é secret
 * (é público em qualquer página que carregue o pixel via `fbq('init', ...)`)
 * — mesmo racional documentado em `meta-capi.ts`. */
export const META_CAPI_STALENESS_DEFAULT_DATASET_ID = "1285191740325112";

const DEFAULT_API_VERSION = "v21.0";
const DEFAULT_FETCH_TIMEOUT_MS = 8000;

/**
 * GET `{dataset_id}?fields=server_last_fired_time` — lê o timestamp mais
 * recente de evento SERVER-SIDE do dataset (distinto de `last_fired_time`,
 * que inclui o pixel client-side — ver achado da issue #7776). Nunca lança:
 * qualquer falha de rede/parse volta como `MetaCapiDatasetReadResult` com
 * `ok: false`, mesmo padrão fail-soft de `sendMetaCapiEvent`
 * (`scripts/lib/shared/meta-capi.ts`).
 */
export async function fetchDatasetServerLastFiredTime(
  options: FetchDatasetStalenessOptions,
): Promise<MetaCapiDatasetReadResult> {
  if (!options.accessToken) return { ok: false, reason: "not_configured" };

  const datasetId = options.datasetId ?? META_CAPI_STALENESS_DEFAULT_DATASET_ID;
  const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
  const base = options.apiBaseUrl ?? `https://graph.facebook.com/${apiVersion}`;
  const fetchImpl = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(
      `${base}/${datasetId}?fields=server_last_fired_time&access_token=${encodeURIComponent(options.accessToken)}`,
      { signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS) },
    );
  } catch {
    return { ok: false, reason: "network_error" };
  }
  if (!res.ok) return { ok: false, reason: "meta_error", status: res.status };
  try {
    const json = (await res.json()) as { server_last_fired_time?: unknown };
    const serverLastFiredTime = typeof json.server_last_fired_time === "string" ? json.server_last_fired_time : null;
    return { ok: true, serverLastFiredTime };
  } catch {
    return { ok: false, reason: "meta_error", status: res.status };
  }
}

// ---------------------------------------------------------------------------
// Veredito consolidado — junta leitura + staleness numa única classificação
// ---------------------------------------------------------------------------

export type MetaCapiStalenessVerdict = "ok" | "stale" | "cannot-verify";

export interface MetaCapiStalenessEvaluation {
  verdict: MetaCapiStalenessVerdict;
  /** `null` quando `verdict === "cannot-verify"` (leitura falhou antes de
   * chegar a computar staleness). */
  check: CapiStalenessCheck | null;
  serverLastFiredTime: string | null;
  /** Motivo de `cannot-verify` — `null` nos outros vereditos. Fail-soft
   * honesto: distingue "não configurado" (esperado até o editor setar o
   * secret) de "configurado mas a leitura falhou" (defeito ativo, mesma
   * distinção que #7776 pede pro caminho de ENVIO). */
  cannotVerifyReason: "not_configured" | "meta_error" | "network_error" | null;
}

/**
 * Combina `fetchDatasetServerLastFiredTime` + `computeCapiStaleness` num
 * único veredito. Nunca lança — herda o fail-soft da leitura.
 */
export async function evaluateMetaCapiStaleness(
  options: FetchDatasetStalenessOptions,
  now: Date,
  thresholdDays: number = DEFAULT_CAPI_STALENESS_THRESHOLD_DAYS,
): Promise<MetaCapiStalenessEvaluation> {
  const read = await fetchDatasetServerLastFiredTime(options);
  if (!read.ok) {
    return { verdict: "cannot-verify", check: null, serverLastFiredTime: null, cannotVerifyReason: read.reason };
  }
  const check = computeCapiStaleness(read.serverLastFiredTime, now, thresholdDays);
  return {
    verdict: check.isStale ? "stale" : "ok",
    check,
    serverLastFiredTime: read.serverLastFiredTime,
    cannotVerifyReason: null,
  };
}

// ---------------------------------------------------------------------------
// Idempotência do e-mail — 1 alarme por dia-calendário UTC (mesmo padrão de
// `ads-spend-ingest-alarm.ts`/`lib/ads-spend-ingest-alarm.ts`)
// ---------------------------------------------------------------------------

export interface MetaCapiStalenessAlarmState {
  lastAlarmedDay: string | null;
}

export function emptyMetaCapiStalenessAlarmState(): MetaCapiStalenessAlarmState {
  return { lastAlarmedDay: null };
}

export function shouldSendMetaCapiStalenessAlarm(
  evaluation: MetaCapiStalenessEvaluation,
  state: MetaCapiStalenessAlarmState,
  now: Date,
): boolean {
  if (evaluation.verdict !== "stale") return false;
  const today = now.toISOString().slice(0, 10);
  return state.lastAlarmedDay !== today;
}

export function markMetaCapiStalenessAlarmed(now: Date): MetaCapiStalenessAlarmState {
  return { lastAlarmedDay: now.toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

export function buildMetaCapiStalenessAlarmEmail(
  evaluation: MetaCapiStalenessEvaluation,
  issueLines: string,
): { subject: string; body: string } {
  const check = evaluation.check;
  const detail = check?.neverFired
    ? "o dataset NUNCA registrou um evento server-side (server_last_fired_time em epoch 0)."
    : `o último evento server-side foi há ${check?.daysSinceLastFired} dia(s) (server_last_fired_time: ${evaluation.serverLastFiredTime}).`;
  return {
    subject: "⚠️ Diaria-Meta-Capi-Staleness-Alarm: CompleteRegistration server-side parado",
    body:
      `A Meta Conversions API (#5504) não está entregando eventos — ${detail}\n\n` +
      `Causa mais provável (confirmada na origem, #7776): META_CAPI_ACCESS_TOKEN não está setado em um ` +
      `ou mais dos 3 workers (poll, cursos, reativar). Verifique com:\n\n` +
      `  cd workers/poll && npx wrangler secret list\n` +
      `  cd workers/cursos && npx wrangler secret list\n` +
      `  cd workers/reativar && npx wrangler secret list\n\n` +
      `Setar o secret é ação de credencial do editor (wrangler secret put META_CAPI_ACCESS_TOKEN em cada ` +
      `worker) — este alarme só detecta, não corrige. Verificar depois de setar: server_last_fired_time ` +
      `deve sair de epoch 0/parar de envelhecer em alguns cadastros reais.` +
      issueLines,
  };
}
