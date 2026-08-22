/**
 * scripts/lib/microsoft-ads-ingest.ts (#5502 Parte B)
 *
 * Adaptador Microsoft Advertising (Bing Ads) do motor genérico
 * `scripts/lib/spend-ingest.ts` — espelha `google-ads-ingest.ts` (#5237): um
 * núcleo de NORMALIZAÇÃO puro/testável contra fixture (sem depender de
 * credencial pra rodar em CI, mesma disciplina de
 * `test/google-ads-ingest-5237.test.ts`) + uma orquestração fail-soft
 * injetável (`runMicrosoftAdsIngest`) que nunca lança — o CLI
 * (`scripts/microsoft-ads-ingest-spend.ts`) é quem de fato chama a API e
 * escreve em disco.
 *
 * ## Formato consumido: `CampaignPerformanceReport` da Reporting API
 *
 * A Reporting API do Microsoft Advertising devolve relatórios como CSV/TSV
 * (não JSON como a GAQL do Google) via um fluxo assíncrono de 2 passos
 * (submeter → poll até "Success" → baixar). O que importa pra normalização
 * (`aggregateMicrosoftAdsSpendByMonth` abaixo) é só a FORMA de cada linha já
 * parseada — `TimePeriod` (a API devolve `MM/DD/YYYY` por padrão) e `Spend`
 * (decimal com PONTO, moeda da conta) — este módulo aceita as duas
 * variações de formato de data mais prováveis (`MM/DD/YYYY` e `YYYY-MM-DD`)
 * pra não quebrar se o parsing do CSV upstream mudar a serialização.
 *
 * `fetchMicrosoftAdsSpendRows` abaixo resolve o fluxo assíncrono de verdade
 * — submissão SOAP → poll até `Success`/erro → download do ZIP →
 * descompactação → parse do CSV — igual ao `fetchGoogleAdsSpendRows`
 * (esconder a mecânica HTTP atrás de uma função fail-soft, testável com um
 * `fetchImpl` mockado). **Implementado em 22/08/2026 (#5928)**, depois que a
 * credencial real saiu do zero (#5502/#5878) — antes disso o módulo
 * deliberadamente parava na fronteira "fetch fail-soft → normalização pura"
 * porque testar o poll contra fixture sem credencial só criaria confiança
 * falsa (ver `docs/microsoft-ads-api-setup.md`).
 *
 * ## Transporte: SOAP 1.1, não REST (diferença chave vs `google-ads-ingest.ts`)
 *
 * A Reporting API do Microsoft Advertising é SOAP (`ReportingService.svc`
 * v13, um único endpoint pras 2 operações `SubmitGenerateReport` e
 * `PollGenerateReport` — a operação vai no `<Action>` do SOAP Header, não na
 * URL). O envelope é montado com `fast-xml-parser` (`XMLBuilder`, já
 * dependência do repo via `fetch-sitemap.ts`) em vez de template string, pra
 * não escorregar em escaping/atributos. **`Content-Type: text/xml` +
 * header HTTP `SOAPAction`, não `application/soap+xml` (SOAP 1.2)** —
 * validado ao vivo em 22/08/2026 (#5928): a doc oficial mostra o `<Action>`
 * dentro do SOAP Header (padrão 1.2) mas o transporte real exige 1.1; usar
 * `application/soap+xml` devolve HTTP 415 puro antes de qualquer
 * processamento (ver `postSoap`). O relatório baixado (`ReportDownloadUrl`)
 * vem **compactado em ZIP** — sem lib de ZIP no repo, `unzipFirstEntry`
 * abaixo lê o Local File Header do 1º (e único) entry na mão e descompacta
 * via `node:zlib` (suporta STORED e DEFLATE, os 2 métodos que um ZIP gerado
 * por servidor usa) — ver docstring da função pro que ela deliberadamente
 * não cobre (ZIP64, streaming, múltiplos entries).
 *
 * ## Achado ao vivo 22/08/2026: esta conta Ads exige Google OAuth, não Azure AD
 *
 * `refreshMicrosoftAdsAccessToken` (Azure AD v2, `/common/oauth2/v2.0/token`)
 * FUNCIONA — devolve um `access_token` válido. Mas toda chamada à API com
 * esse token (testado com `CustomerManagementService.GetUser` via REST,
 * `POST clientcenter.api.bingads.microsoft.com/.../User/Query`) falha com
 * `Code 126 IdentityTypeMismatch`, `Detail: "GoogleAccountIsRequired"`:
 *
 *     {"Errors":[{"Code":126,"Message":"You must use a different identity
 *     type to sign in to Bing Ads with the same email.",
 *     "Detail":"GoogleAccountIsRequired","ErrorCode":"IdentityTypeMismatch"}]}
 *
 * A conta Microsoft Advertising (`CustomerId` 255014657, vjpixel@gmail.com)
 * foi criada/vinculada via **"Sign in with Google"** — a Microsoft
 * Advertising API suporta autenticação por Google OAuth 2.0 como provedor
 * ALTERNATIVO ao Azure AD (não substituto), mas exige um `access_token`
 * emitido pelo GOOGLE (não pela Microsoft) + o header SOAP
 * `<IdentityProvider>Google</IdentityProvider>` — arquitetura de auth
 * DIFERENTE, com um client OAuth do Google Cloud Console dedicado
 * (`client_id`/`client_secret` do Google, não os `MICROSOFT_ADS_CLIENT_*` já
 * no Doppler) e um novo fluxo de consentimento via
 * `accounts.google.com/o/oauth2/v2/auth` (scope `profile email`) —
 * https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth-consent#request-user-consent-with-google-oauth.
 * Isso é AÇÃO NOVA do editor (registrar/reusar um client OAuth no Google
 * Cloud Console + consentir) — o refresh via Google (endpoint/params
 * inteiramente diferentes do Azure AD) e o header `IdentityProvider` NÃO
 * estão implementados aqui de propósito: sem a credencial real pra validar,
 * escrever esse caminho agora só criaria confiança falsa (mesma disciplina
 * que já regeu o resto deste módulo antes do #5928). Ver #5928 pro estado
 * completo desta investigação e os próximos passos.
 *
 * ## Por que fail-soft é o comportamento CORRETO aqui (mesma disciplina do
 * #5237/#5502)
 *
 * Qualquer falha em qualquer uma das 4 etapas (submit/poll/download/parse)
 * vira `{ error }`, nunca lança — rede cai, quota estoura, o token pode ser
 * revogado, um poll pode nunca chegar em `Success` dentro do teto de
 * tentativas. O adaptador precisa degradar pro CSV manual sem quebrar
 * `cac-report.ts` nem lançar stack cru — nunca `process.exit` de dentro
 * deste módulo.
 */

import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { inflateRawSync } from "node:zlib";
import Papa from "papaparse";
import type { SpendRow } from "./aquisicao-spend.ts";
import { runSpendIngest, type SpendIngestFetchResult } from "./spend-ingest.ts";

// ---------------------------------------------------------------------------
// Parsing CampaignPerformanceReport → SpendRow (puro)
// ---------------------------------------------------------------------------

/** Uma linha já parseada do `CampaignPerformanceReport` (CSV/TSV → objeto) —
 *  `TimePeriod` em `MM/DD/YYYY` (formato default da Reporting API) ou
 *  `YYYY-MM-DD`; `Spend` decimal com ponto, string ou number (mesma cautela
 *  de `GaqlSpendApiRow.metrics.costMicros` — o parser CSV upstream pode
 *  devolver os dois). */
export interface MicrosoftAdsReportRow {
  TimePeriod?: string;
  Spend?: string | number;
}

export interface AggregateMicrosoftAdsSpendOptions {
  canal: string;
  moeda: string;
  /** Prefixo da coluna `fonte` — a função acrescenta o range de datas agregado. */
  fonteLabel: string;
}

/** `true` quando mês/dia estão em faixa válida (01-12 / 01-31) — regex sozinha
 *  aceitaria "2026-13-99", que não é uma data. @pure */
function isValidMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** `MM/DD/YYYY` (formato default da Reporting API) → `AAAA-MM-DD`. `null`
 *  se não casar o padrão ou tiver mês/dia fora de faixa — nunca adivinha.
 *  @pure */
function normalizeMicrosoftDate(raw: string): string | null {
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const [, m, d, y] = mdy;
    const month = Number(m);
    const day = Number(d);
    if (!isValidMonthDay(month, day)) return null;
    return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const [, , m, d] = ymd;
    if (!isValidMonthDay(Number(m), Number(d))) return null;
    return raw;
  }
  return null;
}

export interface AggregateMicrosoftAdsSpendResult {
  rows: SpendRow[];
  /** Nº de linhas de `rows` (o parâmetro, `CampaignPerformanceReport` bruto)
   *  descartadas por malformação durante a agregação — sem `TimePeriod`
   *  reconhecível ou sem `Spend` parseável (#5605, espelha `discardedCount`
   *  de `aggregateGaqlSpendByMonthWithDiscards` no #5598). Perda TOTAL do
   *  mês (`aggregatedRows` fica vazio com `rows.length > 0`) é assunto do
   *  caller (`runMicrosoftAdsIngest`); este campo torna visível a perda
   *  PARCIAL — um schema drift que afeta só uma fração das linhas não zera
   *  o agregado, então passava despercebido antes: `spend.csv` saía
   *  atualizado, só que SUBESTIMADO. */
  discardedCount: number;
}

/**
 * Núcleo de `aggregateMicrosoftAdsSpendByMonth` — agrupa linhas do
 * `CampaignPerformanceReport` por mês (`AAAA-MM`), somando `Spend`. Linha
 * sem `TimePeriod` reconhecível ou sem `Spend` parseável é IGNORADA (não
 * tem mês pra agrupar) — nunca contamina a soma como 0, mesma disciplina de
 * `aggregateGaqlSpendByMonth` (`google-ads-ingest.ts`) — e contada em
 * `discardedCount` (#5605), pra que a perda fique visível a quem chama em
 * vez de só um `spend.csv` menor sem explicação.
 *
 * @pure
 */
export function aggregateMicrosoftAdsSpendByMonthWithDiscards(
  rows: MicrosoftAdsReportRow[],
  opts: AggregateMicrosoftAdsSpendOptions,
): AggregateMicrosoftAdsSpendResult {
  const byMonth = new Map<string, { spendSum: number; dates: string[] }>();
  let discardedCount = 0;

  for (const row of rows) {
    const rawDate = row.TimePeriod;
    if (!rawDate) {
      discardedCount++;
      continue;
    }
    const date = normalizeMicrosoftDate(rawDate);
    if (!date) {
      discardedCount++;
      continue;
    }

    const spendRaw = row.Spend;
    if (spendRaw === undefined) {
      discardedCount++;
      continue;
    }
    const spend = typeof spendRaw === "string" ? Number(spendRaw) : spendRaw;
    if (!Number.isFinite(spend)) {
      discardedCount++;
      continue;
    }

    const mes = date.slice(0, 7);
    const entry = byMonth.get(mes) ?? { spendSum: 0, dates: [] };
    entry.spendSum += spend;
    entry.dates.push(date);
    byMonth.set(mes, entry);
  }

  const aggregatedRows = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, { spendSum, dates }]) => {
      const first = dates.slice().sort()[0];
      const last = dates.slice().sort().at(-1);
      const range = first === last ? first : `${first}..${last}`;
      return {
        canal: opts.canal,
        mes,
        moeda: opts.moeda,
        valor: Math.round(spendSum * 100) / 100,
        fonte: `${opts.fonteLabel} — CampaignPerformanceReport, ${dates.length} dia(s) (${range}), ingestão automática`,
      };
    });

  return { rows: aggregatedRows, discardedCount };
}

/**
 * Atalho de `aggregateMicrosoftAdsSpendByMonthWithDiscards` pra quem só
 * precisa das linhas agregadas — assinatura preservada de propósito, não
 * quebra callers/testes anteriores ao #5605. Quem precisa saber quantas
 * linhas foram descartadas (`runMicrosoftAdsIngest`, pra logar perda
 * parcial) usa a variante `WithDiscards` acima diretamente.
 *
 * @pure
 */
export function aggregateMicrosoftAdsSpendByMonth(
  rows: MicrosoftAdsReportRow[],
  opts: AggregateMicrosoftAdsSpendOptions,
): SpendRow[] {
  return aggregateMicrosoftAdsSpendByMonthWithDiscards(rows, opts).rows;
}

// ---------------------------------------------------------------------------
// Orquestração injetável (fetch + fail-soft) — sem I/O de disco
// ---------------------------------------------------------------------------

export interface MicrosoftAdsAuthConfig {
  clientId: string;
  /**
   * **NÃO é enviado na renovação do token (#5928, validado ao vivo em
   * 22/08/2026).** O app registration `diaria-studio-microsoft-ads` foi
   * registrado como *public client* (fluxo desktop/nativo, mesmo caminho da
   * App Center do Microsoft Advertising) — a Azure AD REJEITA qualquer
   * `client_secret` no corpo do refresh grant para esse tipo de app:
   * `AADSTS90023: Public clients can't send a client secret`. O campo
   * continua no tipo (e `MICROSOFT_ADS_CLIENT_SECRET` no Doppler) só de
   * referência/histórico — se o app registration algum dia migrar pra
   * confidential client, é aqui que a chamada volta a incluir o secret.
   */
  clientSecret: string;
  refreshToken: string;
  developerToken: string;
  customerId: string;
  accountId: string;
  /** Endpoint OAuth2 (Azure AD v2) — sobreponível pra teste; default é o
   *  endpoint "common" documentado em `docs/microsoft-ads-api-setup.md`. */
  tokenEndpoint?: string;
}

export type MicrosoftAdsIngestResult =
  | { kind: "updated"; rows: SpendRow[]; fetchedRows: number; discardedCount: number }
  | { kind: "fallback"; reason: string };

/** Subconjunto de `fetch` usado — permite injetar um mock em teste, mesmo
 *  padrão de `FetchLike` em `google-ads-ingest.ts`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
/** Escopo padrão da Microsoft Advertising API (client credentials/refresh
 *  token flow) — https://learn.microsoft.com/advertising/guides/authentication-oauth. */
const DEFAULT_SCOPE = "https://ads.microsoft.com/msads.manage offline_access";

/**
 * Renova o access token via refresh token (Azure AD v2). Nunca lança — falha
 * de rede, credencial ausente/expirada, ou resposta não-JSON viram `null` +
 * `reason`, mesma disciplina fail-soft de `refreshGoogleAdsAccessToken`.
 *
 * **Sem `client_secret` no corpo, de propósito** — ver o comentário em
 * `MicrosoftAdsAuthConfig.clientSecret` (#5928): este app registration é
 * *public client*, e a Azure AD rejeita a requisição inteira
 * (`AADSTS90023`) se o secret vier junto, mesmo que o valor seja válido.
 */
export async function refreshMicrosoftAdsAccessToken(
  fetchImpl: FetchLike,
  auth: Pick<MicrosoftAdsAuthConfig, "clientId" | "refreshToken" | "tokenEndpoint">,
): Promise<{ accessToken: string } | { error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(auth.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: auth.clientId,
        refresh_token: auth.refreshToken,
        grant_type: "refresh_token",
        scope: DEFAULT_SCOPE,
      }).toString(),
    });
  } catch (e) {
    return { error: `falha de rede na renovação do access token: ${e instanceof Error ? e.message : e}` };
  }

  const text = await res.text();
  let payload: { access_token?: string; error_description?: string };
  try {
    payload = JSON.parse(text);
  } catch {
    return { error: `renovação do access token respondeu não-JSON (HTTP ${res.status})` };
  }
  if (!res.ok || !payload.access_token) {
    return { error: `renovação do access token falhou: ${payload.error_description ?? res.status}` };
  }
  return { accessToken: payload.access_token };
}

// ---------------------------------------------------------------------------
// Transporte SOAP real (#5928) — submit → poll → download → unzip → parse
// ---------------------------------------------------------------------------

/** Único endpoint SOAP pras 2 operações — a operação vai no `<Action>` do
 *  SOAP Header, não na URL (WCF basicHttpBinding-style, mesmo padrão dos
 *  demais serviços Bing/Microsoft Advertising v13). */
const REPORTING_SERVICE_URL = "https://reporting.api.bingads.microsoft.com/Api/Advertiser/Reporting/v13/ReportingService.svc";
const REPORTING_NAMESPACE = "https://bingads.microsoft.com/Reporting/v13";
const ARRAYS_NAMESPACE = "http://schemas.microsoft.com/2003/10/Serialization/Arrays";
/** UTC — mesma escolha de fuso "sem ambiguidade" que `toGaqlDate` faz pro
 *  Google Ads (comentário lá tem a mesma ressalva de borda de dia, que não
 *  importa pra agregação MENSAL). Confirmado o enum exato contra
 *  https://learn.microsoft.com/en-us/advertising/reporting-service/reporttimezone. */
const DEFAULT_REPORT_TIME_ZONE = "GreenwichMeanTimeDublinEdinburghLisbonLondon";
/** 15s × 20 tentativas = 5min de teto — dentro da faixa "2 a 15 min" que a
 *  documentação oficial recomenda pra polling
 *  (https://learn.microsoft.com/en-us/advertising/guides/request-download-report),
 *  bem abaixo do teto de 60min que a doc sugere antes de desistir e tentar
 *  depois. Um relatório de 90 dias/1 conta é pequeno — não deveria demorar
 *  perto disso; se demorar, o timeout é sinal real, não falso-positivo. */
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 20;

const xmlBuilder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@_" });
const xmlParser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Data-calendário (UTC) no formato `{Day, Month, Year}` que o elemento
 *  `Date` do SOAP request espera — não confundir com `TimePeriod` (string),
 *  que é o formato de SAÍDA do relatório. @pure */
function toSoapDateParts(d: Date): { Day: number; Month: number; Year: number } {
  return { Day: d.getUTCDate(), Month: d.getUTCMonth() + 1, Year: d.getUTCFullYear() };
}

function buildSoapEnvelope(
  action: "SubmitGenerateReport" | "PollGenerateReport",
  auth: MicrosoftAdsAuthConfig,
  accessToken: string,
  bodyObj: Record<string, unknown>,
): string {
  return xmlBuilder.build({
    "s:Envelope": {
      "@_xmlns:i": "http://www.w3.org/2001/XMLSchema-instance",
      "@_xmlns:s": "http://schemas.xmlsoap.org/soap/envelope/",
      "s:Header": {
        "@_xmlns": REPORTING_NAMESPACE,
        Action: { "@_mustUnderstand": "1", "#text": action },
        AuthenticationToken: accessToken,
        CustomerAccountId: auth.accountId,
        CustomerId: auth.customerId,
        DeveloperToken: auth.developerToken,
      },
      "s:Body": bodyObj,
    },
  });
}

/** `CampaignPerformanceReportRequest` com só `TimePeriod`+`Spend` (sem
 *  `CampaignId`/`CampaignName`) — excluir as colunas de atributo faz o
 *  relatório agregar automaticamente entre campanhas (documentado em
 *  "Columns that Group the Data"), então cada linha já é o total da CONTA
 *  no dia, sem precisar somar campanha por campanha aqui. */
function buildSubmitGenerateReportEnvelope(auth: MicrosoftAdsAuthConfig, accessToken: string, range: MicrosoftAdsDateRange): string {
  return buildSoapEnvelope("SubmitGenerateReport", auth, accessToken, {
    SubmitGenerateReportRequest: {
      "@_xmlns": REPORTING_NAMESPACE,
      ReportRequest: {
        "@_xmlns:i": "http://www.w3.org/2001/XMLSchema-instance",
        "@_i:type": "CampaignPerformanceReportRequest",
        ExcludeColumnHeaders: false,
        ExcludeReportFooter: true,
        ExcludeReportHeader: true,
        Format: "Csv",
        FormatVersion: "2.0",
        ReportName: "diaria-studio spend ingest",
        ReturnOnlyCompleteData: false,
        Aggregation: "Daily",
        Columns: {
          CampaignPerformanceReportColumn: ["TimePeriod", "Spend"],
        },
        Scope: {
          AccountIds: {
            "@_xmlns:a1": ARRAYS_NAMESPACE,
            "a1:long": auth.accountId,
          },
        },
        Time: {
          CustomDateRangeStart: toSoapDateParts(range.start),
          CustomDateRangeEnd: toSoapDateParts(range.end),
          ReportTimeZone: DEFAULT_REPORT_TIME_ZONE,
        },
      },
    },
  });
}

function buildPollGenerateReportEnvelope(auth: MicrosoftAdsAuthConfig, accessToken: string, reportRequestId: string): string {
  return buildSoapEnvelope("PollGenerateReport", auth, accessToken, {
    PollGenerateReportRequest: {
      "@_xmlns": REPORTING_NAMESPACE,
      ReportRequestId: reportRequestId,
    },
  });
}

/** Extrai a mensagem de um SOAP Fault (1.2) pra log — best-effort: se o
 *  corpo não for um Fault reconhecível, devolve `null` e quem chama cai no
 *  fallback de exibir o texto bruto (mesma disciplina de nunca lançar). */
function extractSoapFaultMessage(xml: string): string | null {
  try {
    // biome-ignore lint: payload de erro upstream, forma não é tipada aqui de propósito
    const parsed: any = xmlParser.parse(xml);
    const fault = parsed?.Envelope?.Body?.Fault;
    if (!fault) return null;
    const reason = fault.Reason?.Text ?? fault.faultstring;
    const errorContainer =
      fault.Detail?.AdApiFaultDetail?.Errors?.AdApiError ?? fault.Detail?.ApiFaultDetail?.OperationErrors?.OperationError;
    const errorList = errorContainer === undefined ? [] : Array.isArray(errorContainer) ? errorContainer : [errorContainer];
    const errorMsgs = errorList.map((e) => e?.Message).filter(Boolean).join("; ");
    const combined = [reason, errorMsgs].filter(Boolean).join(" — ");
    return combined || null;
  } catch {
    return null;
  }
}

/**
 * POST do envelope SOAP — **SOAP 1.1, não 1.2** (`text/xml` + header HTTP
 * `SOAPAction`), apesar do `<Action>` também ir dentro do SOAP Header (o
 * template da documentação mistura os dois). Validado ao vivo em 22/08/2026
 * (#5928): `Content-Type: application/soap+xml` devolve HTTP 415 puro
 * (Unsupported Media Type) — só `text/xml; charset=utf-8` +
 * `SOAPAction: {action}` passa da validação de transporte.
 */
async function postSoap(
  fetchImpl: FetchLike,
  url: string,
  action: "SubmitGenerateReport" | "PollGenerateReport",
  envelope: string,
): Promise<{ text: string; status: number } | { error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: action },
      body: envelope,
    });
  } catch (e) {
    return { error: `falha de rede na chamada SOAP: ${e instanceof Error ? e.message : e}` };
  }
  const text = await res.text();
  return { text, status: res.status };
}

async function submitGenerateReport(
  fetchImpl: FetchLike,
  auth: MicrosoftAdsAuthConfig,
  accessToken: string,
  serviceUrl: string,
  range: MicrosoftAdsDateRange,
): Promise<{ reportRequestId: string } | { error: string }> {
  const envelope = buildSubmitGenerateReportEnvelope(auth, accessToken, range);
  const res = await postSoap(fetchImpl, serviceUrl, "SubmitGenerateReport", envelope);
  if ("error" in res) return res;
  if (res.status !== 200) {
    return { error: `SubmitGenerateReport respondeu HTTP ${res.status}: ${extractSoapFaultMessage(res.text) ?? res.text.slice(0, 400)}` };
  }
  // biome-ignore lint: resposta SOAP, forma não é tipada aqui de propósito
  let parsed: any;
  try {
    parsed = xmlParser.parse(res.text);
  } catch {
    return { error: `SubmitGenerateReport respondeu corpo não-XML (HTTP ${res.status})` };
  }
  const reportRequestId = parsed?.Envelope?.Body?.SubmitGenerateReportResponse?.ReportRequestId;
  if (!reportRequestId) {
    return { error: extractSoapFaultMessage(res.text) ?? `SubmitGenerateReport não devolveu ReportRequestId (HTTP ${res.status})` };
  }
  return { reportRequestId: String(reportRequestId) };
}

async function pollGenerateReport(
  fetchImpl: FetchLike,
  auth: MicrosoftAdsAuthConfig,
  accessToken: string,
  serviceUrl: string,
  reportRequestId: string,
): Promise<{ status: string; downloadUrl?: string } | { error: string }> {
  const envelope = buildPollGenerateReportEnvelope(auth, accessToken, reportRequestId);
  const res = await postSoap(fetchImpl, serviceUrl, "PollGenerateReport", envelope);
  if ("error" in res) return res;
  if (res.status !== 200) {
    return { error: `PollGenerateReport respondeu HTTP ${res.status}: ${extractSoapFaultMessage(res.text) ?? res.text.slice(0, 400)}` };
  }
  // biome-ignore lint: resposta SOAP, forma não é tipada aqui de propósito
  let parsed: any;
  try {
    parsed = xmlParser.parse(res.text);
  } catch {
    return { error: `PollGenerateReport respondeu corpo não-XML (HTTP ${res.status})` };
  }
  const status = parsed?.Envelope?.Body?.PollGenerateReportResponse?.ReportRequestStatus;
  if (!status?.Status) {
    return { error: extractSoapFaultMessage(res.text) ?? `PollGenerateReport respondeu sem Status (HTTP ${res.status})` };
  }
  return { status: String(status.Status), downloadUrl: status.ReportDownloadUrl ? String(status.ReportDownloadUrl) : undefined };
}

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

/**
 * Extrai o 1º (e único, no caso dos relatórios da Reporting API — 1
 * relatório = 1 CSV = 1 entry) arquivo de um ZIP, sem depender de nenhuma
 * lib externa — o repo não tinha (nem precisava até agora de) um parser de
 * ZIP completo. Lê só o Local File Header do entry no offset 0 e
 * descompacta via `node:zlib` (STORED ou DEFLATE, os únicos 2 métodos que
 * um ZIP gerado por servidor usa na prática — validado contra um ZIP real
 * gerado por `Compress-Archive` durante a implementação, #5928).
 *
 * **Deliberadamente não cobre:** ZIP64 (arquivo >4GB — um relatório de
 * custo diário nunca chega perto), múltiplos entries (não é o que a
 * Reporting API devolve), nem streaming (bit 3 do general purpose flag,
 * tamanho no data descriptor PÓS-dados em vez de no header). Se algum
 * desses casos aparecer, falha com erro explícito — nunca com dado
 * truncado silencioso.
 *
 * @pure
 */
function unzipFirstEntry(buf: Buffer): Buffer {
  if (buf.length < 30 || buf.readUInt32LE(0) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error("payload não começa com um Local File Header ZIP válido");
  }
  const generalPurposeFlag = buf.readUInt16LE(6);
  const compressionMethod = buf.readUInt16LE(8);
  const compressedSize = buf.readUInt32LE(18);
  const fileNameLength = buf.readUInt16LE(26);
  const extraFieldLength = buf.readUInt16LE(28);
  if ((generalPurposeFlag & 0x0008) !== 0 && compressedSize === 0) {
    throw new Error("ZIP usa data descriptor (streaming, sem tamanho no header) — não suportado");
  }
  const dataStart = 30 + fileNameLength + extraFieldLength;
  const compressedData = buf.subarray(dataStart, dataStart + compressedSize);
  if (compressionMethod === 0) return Buffer.from(compressedData);
  if (compressionMethod === 8) return inflateRawSync(compressedData);
  throw new Error(`método de compressão ZIP não suportado: ${compressionMethod}`);
}

/**
 * CSV → `MicrosoftAdsReportRow[]`. Como `ExcludeReportHeader`/
 * `ExcludeReportFooter` vão `true` na submissão, o CSV baixado é só a linha
 * de cabeçalho (`ExcludeColumnHeaders: false`) + linhas de dado, sem
 * metadado — `papaparse` (já dependência do repo, `aquisicao-spend.ts`)
 * cuida do quoting. Cabeçalho ausente/sem as 2 colunas pedidas é tratado
 * como ERRO (não `rows: []`) — a request FIXOU `Columns` explicitamente,
 * então a ausência é sinal de transporte quebrado, não "sem gasto no
 * período" (mesmo raciocínio do #5598/#5605: nunca mascarar perda de dado
 * como zero silencioso).
 */
function parseReportCsv(csvText: string): MicrosoftAdsReportRow[] {
  const parsed = Papa.parse<string[]>(csvText.trim(), { skipEmptyLines: true });
  const [header, ...dataRows] = parsed.data;
  if (!header) return [];
  const timePeriodIdx = header.indexOf("TimePeriod");
  const spendIdx = header.indexOf("Spend");
  if (timePeriodIdx === -1 || spendIdx === -1) {
    throw new Error(`CSV do relatório sem as colunas esperadas (header: ${JSON.stringify(header)})`);
  }
  return dataRows.map((row) => ({ TimePeriod: row[timePeriodIdx], Spend: row[spendIdx] }));
}

async function downloadAndParseReport(fetchImpl: FetchLike, downloadUrl: string): Promise<{ rows: MicrosoftAdsReportRow[] } | { error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(downloadUrl);
  } catch (e) {
    return { error: `falha de rede no download do relatório: ${e instanceof Error ? e.message : e}` };
  }
  if (!res.ok) return { error: `download do relatório respondeu HTTP ${res.status}` };

  let buf: Buffer;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { error: `falha lendo corpo do download: ${e instanceof Error ? e.message : e}` };
  }

  try {
    const csvText = unzipFirstEntry(buf).toString("utf8");
    return { rows: parseReportCsv(csvText) };
  } catch (e) {
    return { error: `falha ao descompactar/parsear o relatório baixado: ${e instanceof Error ? e.message : e}` };
  }
}

export interface MicrosoftAdsDateRange {
  /** Data-calendário de início, inclusive (só Y/M/D são usados, em UTC). */
  start: Date;
  /** Data-calendário de fim, inclusive. */
  end: Date;
}

export interface FetchMicrosoftAdsSpendRowsOptions {
  /** Default `REPORTING_SERVICE_URL` — sobreponível pra teste. */
  reportingServiceUrl?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  /** Injetável — testes passam um no-op pra não esperar de verdade. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Resolve o fluxo assíncrono completo da Reporting API — `SubmitGenerateReport`
 * → `PollGenerateReport` (repetido até `Success`/erro/teto de tentativas) →
 * download do ZIP → parse do CSV — devolvendo as linhas já parseadas. Nunca
 * lança: qualquer etapa que falhar devolve `{ error }`, mesma disciplina
 * fail-soft de `fetchGoogleAdsSpendRows`.
 */
export async function fetchMicrosoftAdsSpendRows(
  fetchImpl: FetchLike,
  auth: MicrosoftAdsAuthConfig,
  accessToken: string,
  dateRange: MicrosoftAdsDateRange,
  opts: FetchMicrosoftAdsSpendRowsOptions = {},
): Promise<{ rows: MicrosoftAdsReportRow[] } | { error: string }> {
  const serviceUrl = opts.reportingServiceUrl ?? REPORTING_SERVICE_URL;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPollAttempts = opts.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
  const sleepImpl = opts.sleepImpl ?? defaultSleep;

  const submitResult = await submitGenerateReport(fetchImpl, auth, accessToken, serviceUrl, dateRange);
  if ("error" in submitResult) return submitResult;

  let downloadUrl: string | undefined;
  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    if (attempt > 0) await sleepImpl(pollIntervalMs);
    const pollResult = await pollGenerateReport(fetchImpl, auth, accessToken, serviceUrl, submitResult.reportRequestId);
    if ("error" in pollResult) return pollResult;
    if (pollResult.status === "Success") {
      if (!pollResult.downloadUrl) return { error: "PollGenerateReport respondeu Success sem ReportDownloadUrl" };
      downloadUrl = pollResult.downloadUrl;
      break;
    }
    if (pollResult.status !== "Pending") {
      return { error: `PollGenerateReport respondeu status inesperado: ${pollResult.status}` };
    }
  }
  if (!downloadUrl) {
    return {
      error: `PollGenerateReport não completou após ${maxPollAttempts} tentativa(s) (ReportRequestId ${submitResult.reportRequestId})`,
    };
  }

  return downloadAndParseReport(fetchImpl, downloadUrl);
}

// ---------------------------------------------------------------------------
// Orquestração injetável (fetch + fail-soft) — sem I/O de disco
// ---------------------------------------------------------------------------

export interface RunMicrosoftAdsIngestOptions {
  auth: MicrosoftAdsAuthConfig;
  existingRows: SpendRow[];
  canal?: string;
  moeda?: string;
  fonteLabel?: string;
  reportingServiceUrl?: string;
  /** Relógio injetável — o range de datas padrão (90 dias) é derivado
   *  daqui, mesmo padrão de `RunGoogleAdsIngestOptions.now`
   *  (google-ads-ingest.ts). Default `new Date()`; testes passam uma data
   *  fixa. */
  now?: Date;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Janela padrão da ingestão, em dias (inclusive do dia corrente) — mesmo
 *  valor de `DEFAULT_LOOKBACK_DAYS` do Google Ads (#5237), pela mesma razão:
 *  a agregação é MENSAL, então uma janela generosa cobre qualquer atraso de
 *  rodada sem custo (o merge é idempotente por (`canal`, `mes`)). */
export const DEFAULT_LOOKBACK_DAYS = 90;

/** @pure */
function defaultDateRange(now: Date, lookbackDays = DEFAULT_LOOKBACK_DAYS): MicrosoftAdsDateRange {
  const end = new Date(now.getTime());
  const start = new Date(now.getTime() - (lookbackDays - 1) * 24 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * Orquestra token → Reporting API (submit→poll→download→parse) → agregação
 * → merge, sempre fail-soft — mesmo contrato de `runGoogleAdsIngest`,
 * implementado como adaptador de `runSpendIngest` (#5502 Parte B). `canal`
 * default é o nome CANÔNICO reservado em `scripts/lib/cac.ts`
 * (`RESERVED_CHANNEL_NAMES`) — usar exatamente essa string, nunca
 * "Microsoft Ads"/"Bing Ads", senão a linha cai no caminho "canal
 * desconhecido" de `buildCacReport` mesmo com o gasto corretamente
 * importado.
 *
 * **Perda PARCIAL de linhas é logada mesmo no caminho de sucesso (#5605,
 * espelha o #5598 do Google Ads).** `discardedCount` vai no retorno (pra
 * quem quiser inspecionar programaticamente) e sai como `console.warn`
 * sempre que `> 0` — sem virar exit não-zero: o dado parcial ainda é útil,
 * só precisa ser visível.
 */
export async function runMicrosoftAdsIngest(
  fetchImpl: FetchLike,
  opts: RunMicrosoftAdsIngestOptions,
): Promise<MicrosoftAdsIngestResult> {
  const canal = opts.canal ?? "Microsoft Advertising";
  const moeda = opts.moeda ?? "BRL";
  const fonteLabel = opts.fonteLabel ?? "Microsoft Advertising Reporting API";
  const range = defaultDateRange(opts.now ?? new Date());

  let discardedCount = 0;

  const fetcher = async (): Promise<SpendIngestFetchResult> => {
    const tokenResult = await refreshMicrosoftAdsAccessToken(fetchImpl, opts.auth);
    if ("error" in tokenResult) return { kind: "error", reason: tokenResult.error };

    const spendResult = await fetchMicrosoftAdsSpendRows(fetchImpl, opts.auth, tokenResult.accessToken, range, {
      reportingServiceUrl: opts.reportingServiceUrl,
      pollIntervalMs: opts.pollIntervalMs,
      maxPollAttempts: opts.maxPollAttempts,
      sleepImpl: opts.sleepImpl,
    });
    if ("error" in spendResult) return { kind: "error", reason: spendResult.error };

    const aggregated = aggregateMicrosoftAdsSpendByMonthWithDiscards(spendResult.rows, { canal, moeda, fonteLabel });
    discardedCount = aggregated.discardedCount;
    return { kind: "ok", rows: aggregated.rows, fetchedCount: spendResult.rows.length };
  };

  const result = await runSpendIngest({ fetcher, existingRows: opts.existingRows });
  if (result.kind === "fallback") return result;

  if (discardedCount > 0) {
    console.warn(
      `[microsoft-ads-ingest] ${discardedCount} linha(s) do CampaignPerformanceReport descartada(s) por malformação durante a agregação (#5605) — spend.csv pode sair SUBESTIMADO pro(s) mês(es) afetado(s). Investigar schema drift na API (campo renomeado?) antes de confiar no valor.`,
    );
  }

  return { kind: "updated", rows: result.rows, fetchedRows: result.fetchedCount, discardedCount };
}
