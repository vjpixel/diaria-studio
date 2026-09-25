/**
 * scripts/lib/google-data-manager-sender.ts (#8555)
 *
 * Caminho de ENVIO do lote de confirmação sobre a **Data Manager API**
 * (`POST https://datamanager.googleapis.com/v1/events:ingest`) — substitui
 * `ConversionUploadService.UploadClickConversions` (`google-ads-conversion-
 * sender.ts`) só para `scripts/upload-google-ads-confirmations.ts`.
 *
 * ## Por que migrar (achado ao vivo, 21-24/09/2026)
 *
 * A conta `2369219639` recebe `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE` em
 * `UploadClickConversions`: "New integrations for uploading click
 * conversions should use the Data Manager API." — o caminho antigo está
 * fechado para contas novas nessa API; a Data Manager API é o substituto
 * oficial (https://developers.google.com/data-manager/api/devguides/events/google-ads/offline).
 *
 * ## Verificado ao vivo em 24/09/2026, `validateOnly: true` (nada enviado)
 *
 *   - `POST https://datamanager.googleapis.com/v1/events:ingest`, headers
 *     `authorization: Bearer {access_token}` + `content-type: application/json`
 *     — **sem** `developer-token` (diferente do caminho antigo).
 *   - Access token: mesmo refresh OAuth já usado em `google-ads-ingest.ts`
 *     (`refreshGoogleAdsAccessToken`, reusado aqui, não duplicado) — o token
 *     já carrega o escopo `https://www.googleapis.com/auth/datamanager` sem
 *     nenhuma credencial nova.
 *   - `destinations[].operatingAccount` = a conta anunciante diretamente
 *     (`GOOGLE_ADS`/`accountId`). **`loginAccount` = a MCC (`6236094249`) dá
 *     403 `PERMISSION_DENIED`** — nunca setar `loginAccount` pra MCC aqui
 *     (o equivalente do retry de `login-customer-id` de
 *     `postGoogleAdsWithLoginRetry` não existe nem é preciso: a chamada
 *     direta na conta já funciona).
 *   - `eventSource` é OBRIGATÓRIO (400 `REQUIRED_FIELD_MISSING` sem ele) —
 *     apesar de alguma documentação pública o listar como opcional; a
 *     medição ao vivo contra a API real manda.
 *   - 200 com e sem `adIdentifiers.gclid` — o gclid é aditivo, nunca
 *     substitui `userData.userIdentifiers`.
 *
 * ## Limite de eventos por request (doc oficial)
 *
 * "At most 2000 Event resources can be sent in a single request"
 * (`events:ingest` reference) — `chunkDataManagerEvents` corta em lotes de
 * `DATA_MANAGER_MAX_EVENTS_PER_REQUEST` antes de enviar; o volume diário
 * real do lote de confirmação (dezenas) nunca bate o teto, isto é rede de
 * segurança, não caminho comum.
 *
 * ## Status por evento é ASSÍNCRONO — decisão de design, não gap
 *
 * `events:ingest` devolve um `requestId` no 2xx; o diagnóstico por evento
 * (aceito/rejeitado/motivo) só existe depois, via `RetrieveRequestStatus`
 * (endpoint separado, `request_status_per_destination` com
 * `SUCCESS`/`FAILURE`/`PARTIAL_SUCCESS` + `error_info`/`warning_info` — ver
 * https://developers.google.com/data-manager/api/devguides/diagnostics).
 * Não implementado aqui: pooling desse status exigiria um 2º lote agendado
 * (buscar diagnóstico de requestIds pendentes) e não muda a decisão prática
 * do dia (o lote de confirmação já tenta de novo, com backoff de tentativas,
 * quem falhar). A escolha deliberada é: **2xx síncrono do `events:ingest` =
 * "submetido" (`submitted`), nunca "confirmado aceito pelo Google"** — o
 * chamador (`google-ads-confirmation-batch.ts`) nunca marca uma linha como
 * definitivamente aceita a partir só deste retorno; grava o `requestId` no
 * índice de idempotência para uma reconciliação futura (`docs`/issue de
 * follow-up), mas trata o envio como concluído do lado do lote (não reenvia
 * um id já `submitted` — reenviar por "não confirmamos aceite" duplicaria a
 * conversão do lado do Google sem necessidade real: a API já loga
 * `fieldWarnings` no próprio 2xx pra campos opcionais malformados, e um
 * `requestId` gravado é suficiente para auditoria manual se o editor
 * suspeitar de perda).
 *
 * Nenhuma função aqui lê o ambiente sozinha nem toca disco: `env` e
 * `fetchFn` são injetados — testável sem chamada de rede real.
 *
 * Guard de publicação (`context/overnight-dispatch-rules.md` item 1): este
 * módulo É o caminho de escrita real na Google Ads API (via Data Manager).
 * Só é alcançado por `--send` explícito (ou `--validate-only`, que também
 * chama a API real mas com `validateOnly: true` — nada é persistido do lado
 * do Google); nenhum teste ou sessão de desenvolvimento o executa contra a
 * API real sem essas flags.
 */

import { refreshGoogleAdsAccessToken } from "./google-ads-ingest.ts";
import type { ValidatedConversion } from "./google-ads-enhanced-conversions.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Env = Record<string, string | undefined>;

export const DATA_MANAGER_INGEST_URL = "https://datamanager.googleapis.com/v1/events:ingest";
/** "At most 2000 Event resources can be sent in a single request" (doc oficial). */
export const DATA_MANAGER_MAX_EVENTS_PER_REQUEST = 2000;

export const REQUIRED_SEND_ENV_VARS = ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN"] as const;

export interface DataManagerAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Monta a config de auth a partir do `env` injetado; devolve as variáveis
 *  ausentes quando incompleto. Diferente do caminho antigo
 *  (`google-ads-conversion-sender.ts`): NÃO exige `GOOGLE_ADS_DEVELOPER_TOKEN`
 *  nem `GOOGLE_ADS_LOGIN_CUSTOMER_ID` — a Data Manager API não usa nenhum dos
 *  dois (verificado ao vivo, ver docstring do módulo). @pure */
export function authConfigFromEnv(env: Env): { auth: DataManagerAuthConfig } | { missing: string[] } {
  const missing = REQUIRED_SEND_ENV_VARS.filter((name) => !env[name]);
  if (missing.length > 0) return { missing };
  return {
    auth: {
      clientId: env.GOOGLE_ADS_CLIENT_ID!,
      clientSecret: env.GOOGLE_ADS_CLIENT_SECRET!,
      refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN!,
    },
  };
}

// ---------------------------------------------------------------------------
// Evento + payload (puros)
// ---------------------------------------------------------------------------

export interface DataManagerEvent {
  transactionId: string;
  /** RFC 3339 (`YYYY-MM-DDTHH:MM:SS±HH:MM`). */
  eventTimestamp: string;
  eventSource: "WEB";
  userData: { userIdentifiers: Array<{ emailAddress: string }> };
  /** Só `gclid` — o único click id verificado ao vivo contra a API (24/09/2026).
   *  `wbraid`/`gbraid` do lote antigo (`ClickConversionPayload`) não têm
   *  equivalente testado aqui; uma conversão que só carregasse um desses dois
   *  cairia sem click id (só hash de e-mail) até alguém verificar o campo
   *  certo do schema — perda documentada, não silenciosa. */
  adIdentifiers?: { gclid: string };
}

const CONVERSION_DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})$/;

/**
 * `"YYYY-MM-DD HH:MM:SS±HH:MM"` (formato que `ValidatedConversion.
 * conversionDateTime` carrega, herdado do caminho antigo) → RFC 3339
 * (`"YYYY-MM-DDTHH:MM:SS±HH:MM"`, o que `events:ingest` exige em
 * `eventTimestamp`). `null` em qualquer formato que não bata — nunca lança.
 * @pure
 */
export function conversionDateTimeToRfc3339(spaceFormat: string): string | null {
  const m = CONVERSION_DATE_TIME_RE.exec(spaceFormat.trim());
  if (!m) return null;
  return `${m[1]}T${m[2]}${m[3]}`;
}

export type BuildDataManagerEventResult = { ok: true; event: DataManagerEvent } | { ok: false; error: string };

/**
 * Monta 1 evento a partir de uma `ValidatedConversion` já validada pelo
 * pipeline existente (`validateSignupRecords`, reusado sem mudança — hash de
 * e-mail, filtro de teste e corte de segurança continuam ali). `orderId` vira
 * `transactionId` — OBRIGATÓRIO aqui (a Data Manager API não tem um
 * equivalente de "sem id de transação"; diferente do caminho antigo, onde
 * `orderId` era só uma 2ª rede de dedup opcional). @pure
 */
export function buildDataManagerEvent(conv: ValidatedConversion): BuildDataManagerEventResult {
  const eventTimestamp = conversionDateTimeToRfc3339(conv.conversionDateTime);
  if (!eventTimestamp) {
    return { ok: false, error: `conversionDateTime em formato inesperado para Data Manager: "${conv.conversionDateTime}"` };
  }
  if (!conv.orderId) {
    return { ok: false, error: "conversão sem orderId — Data Manager exige transactionId estável (nunca vazio)." };
  }
  const event: DataManagerEvent = {
    transactionId: conv.orderId,
    eventTimestamp,
    eventSource: "WEB",
    userData: { userIdentifiers: [{ emailAddress: conv.hashedEmail }] },
  };
  if (conv.gclid) event.adIdentifiers = { gclid: conv.gclid };
  return { ok: true, event };
}

export interface DataManagerIngestPayload {
  destinations: Array<{
    operatingAccount: { accountType: "GOOGLE_ADS"; accountId: string };
    productDestinationId: string;
  }>;
  encoding: "HEX";
  validateOnly: boolean;
  events: DataManagerEvent[];
}

/** Monta o corpo de `POST /v1/events:ingest`. `customerId`/`productDestinationId`
 *  aceitam qualquer formatação (hífens etc. em `customerId` são removidos).
 *  `loginAccount` nunca é incluído — ver docstring do módulo. @pure */
export function buildDataManagerIngestPayload(
  events: DataManagerEvent[],
  opts: { customerId: string; productDestinationId: string; validateOnly: boolean },
): DataManagerIngestPayload {
  return {
    destinations: [
      {
        operatingAccount: { accountType: "GOOGLE_ADS", accountId: opts.customerId.replace(/[^0-9]/g, "") },
        productDestinationId: opts.productDestinationId,
      },
    ],
    encoding: "HEX",
    validateOnly: opts.validateOnly,
    events,
  };
}

/** Corta `events` em lotes de no máximo `size` (default
 *  `DATA_MANAGER_MAX_EVENTS_PER_REQUEST`). Lança se `size <= 0`. @pure */
export function chunkDataManagerEvents(
  events: readonly DataManagerEvent[],
  size: number = DATA_MANAGER_MAX_EVENTS_PER_REQUEST,
): DataManagerEvent[][] {
  if (size <= 0) throw new Error(`chunkDataManagerEvents: size deve ser > 0 (recebido ${size})`);
  const out: DataManagerEvent[][] = [];
  for (let i = 0; i < events.length; i += size) out.push(events.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Envio (injetável — nunca lança, todo estado vira retorno)
// ---------------------------------------------------------------------------

export type DataManagerIngestResult =
  | { ok: true; requestId: string; response: unknown }
  | {
      ok: false;
      stage: "env" | "token" | "ingest";
      error: string;
      missing?: string[];
      /**
       * `true` só quando a Data Manager API de fato RESPONDEU com um HTTP
       * não-2xx (uma resposta real do Google — provável defeito no payload
       * ou na conta, digno de contar como tentativa/consumir o teto de
       * retries de quem chama). `false` para credencial ausente (`env`),
       * falha de renovação de token (`token`), exceção de rede (fetch
       * lançou), corpo 2xx não-JSON, ou 2xx sem `requestId` — nesses casos
       * não sabemos se o Google chegou a processar o payload, então não
       * conta como recusa "real" (quem chama deve reprocessar sem consumir
       * o teto de tentativas). Ver #8555 (fleet review).
       */
      countsAsAttempt: boolean;
    };

/**
 * Renova o token e faz o POST de 1 payload (já dentro do limite de 2000
 * eventos — quem chama corta com `chunkDataManagerEvents` antes). Nunca
 * lança; toda falha vira `{ ok: false, stage, error, countsAsAttempt }`.
 * `stage` diz onde parou (nada foi enviado em `env`/`token`).
 */
export async function sendDataManagerIngest(opts: {
  fetchFn: FetchLike;
  env: Env;
  payload: DataManagerIngestPayload;
}): Promise<DataManagerIngestResult> {
  const configResult = authConfigFromEnv(opts.env);
  if ("missing" in configResult) {
    return {
      ok: false,
      stage: "env",
      error: `envio (Data Manager) exige as variáveis de ambiente ausentes: ${configResult.missing.join(", ")}.`,
      missing: configResult.missing,
      countsAsAttempt: false,
    };
  }
  const tokenResult = await refreshGoogleAdsAccessToken(opts.fetchFn, configResult.auth);
  if ("error" in tokenResult) {
    return { ok: false, stage: "token", error: `falha ao renovar access token: ${tokenResult.error}`, countsAsAttempt: false };
  }

  let res: Response;
  let text: string;
  try {
    res = await opts.fetchFn(DATA_MANAGER_INGEST_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenResult.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(opts.payload),
    });
    text = await res.text();
  } catch (e) {
    return {
      ok: false,
      stage: "ingest",
      error: `falha de rede em events:ingest: ${e instanceof Error ? e.message : e}`,
      countsAsAttempt: false, // nunca chegou a ser uma resposta do Google
    };
  }

  if (!res.ok) {
    // Resposta REAL do Google, HTTP não-2xx — conta como tentativa.
    return {
      ok: false,
      stage: "ingest",
      error: `events:ingest respondeu HTTP ${res.status}: ${text.slice(0, 800)}`,
      countsAsAttempt: true,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      stage: "ingest",
      error: `events:ingest respondeu corpo não-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
      countsAsAttempt: false, // 2xx mas corpo anômalo — não é uma recusa do Google
    };
  }

  const requestId = (parsed as { requestId?: unknown } | null)?.requestId;
  if (typeof requestId !== "string" || !requestId) {
    return {
      ok: false,
      stage: "ingest",
      error: "events:ingest respondeu 2xx sem requestId — não dá pra rastrear diagnóstico depois, tratando como falha.",
      countsAsAttempt: false, // idem — 2xx sem requestId é anômalo, não recusa
    };
  }
  return { ok: true, requestId, response: parsed };
}
