/**
 * scripts/lib/microsoft-ads-editorial-reasons.ts (#5878)
 *
 * Captura motivos de rejeição editorial de assets via Campaign Management API
 * v13 (SOAP) do Microsoft Advertising. Complementa
 * `scripts/lib/microsoft-ads-ingest.ts` (#5502/#5928) — onde o Reporting API
 * entrega gasto, este módulo entrega **motivo textual** de rejeição de asset,
 * que a UI apenas mostra por ~14h antes que o estado `Disapproved` desapareça
 * (precedentes: #5702, #5878).
 *
 * ## Por que SOAP 1.1, não 1.2
 *
 * A Campaign Management API v13 usa SOAP 1.1 (`text/xml; charset=utf-8` +
 * header HTTP `SOAPAction: GetAssetGroupsEditorialReasons`) — **não**
 * `application/soap+xml` (HTTP 415, validado ao vivo em #5928). `GetAssetGroupsEditorialReasons`
 * é síncrona (não segue o submit→poll→download assíncrono da Reporting API) —
 * um único POST devolve o resultado imediatamente.
 *
 * ## Fail-soft — mesma disciplina de `microsoft-ads-ingest.ts`
 *
 * Nunca lança. Credencial ausente, rede caindo, ou SOAP Fault vira `{ error }`.
 * O CLI injetável (`fetchImpl`) permite teste 100% contra fixture — nenhum teste
 * toca a API real.
 */

import { XMLBuilder, XMLParser } from "fast-xml-parser";

import {
  type MicrosoftAdsAuthConfig,
  type FetchLike,
  refreshMicrosoftAdsAccessToken,
} from "./microsoft-ads-ingest.ts";

// Re-export para testes e consumidores externos.
export type { MicrosoftAdsAuthConfig, FetchLike };
export { refreshMicrosoftAdsAccessToken };

// ---------------------------------------------------------------------------
// Constants — Campaign Management API v13
// ---------------------------------------------------------------------------

/** Endpoint SOAP da Campaign Management API v13 — operações de gestão de
 *  campanha (assets, editorial reasons, etc.). Diferente da Reporting API
 *  (`reporting.api.bingads.microsoft.com`), esta é a API de *management*. */
export const CAMPAIGN_MANAGEMENT_SERVICE_URL =
  "https://api.bingads.microsoft.com/Api/Advertiser/CampaignManagement/v13/ApiCampaignManagementService.svc";

/** Namespace SOAP do Campaign Management v13 — vai no `@xmlns` do header e
 *  do body, igual ao `REPORTING_NAMESPACE` de PR #5934. */
export const CAMPAIGN_MANAGEMENT_NAMESPACE =
  "https://api.bingads.microsoft.com/API/CampaignManagement/v13";

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  indentBy: "  ",
});
const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
});

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Um motivo editorial retornado por `GetAssetGroupsEditorialReasons`. */
export interface MicrosoftAdsEditorialReason {
  /** Código numérico do motivo de rejeição (ex: 110, 123). Mapeia pra tabela
   *  de códigos da Microsoft Advertising Policy. */
  reasonCode: number;
  /** Local onde o motivo foi aplicado — ex: "AdGroup", "Keyword". */
  location: string;
  /** Países afetados pela restrição, formatados como `"US"` ou `"US,BR,CA"`. */
  publisherCountries: string;
  /** Termo específico que foi rejeitado (texto do creative/keyword). */
  term: string;
  /** Status de apelação — ex: "None", "Appealable", "Appealed", "NotAppealable". */
  appealStatus: string;
}

/** Resultado da chamada, sempre fail-soft: sucesso com o array de razões ou
 *  erro com motivo legível. Inspira-se no contrato de
 *  `fetchMicrosoftAdsSpendRows`. */
export type AssetGroupEditorialReasonsResult =
  | { ok: true; reasons: MicrosoftAdsEditorialReason[]; count: number; source: "live" | "stale" }
  | { ok: false; error: string };

export interface FetchAssetGroupEditorialReasonsOptions {
  /** Endpoint SOAP — sobreponível pra teste. Default:
   *  `CAMPAIGN_MANAGEMENT_SERVICE_URL`. */
  campaignManagementUrl?: string;
  /** Asset group ID do Microsoft Advertising (ex: "1187474912702110"). */
  assetGroupId: string;
}

// ---------------------------------------------------------------------------
// Envelope SOAP
// ---------------------------------------------------------------------------

/**
 * Monta o envelope SOAP 1.1 para `GetAssetGroupsEditorialReasons`.
 *
 * Estrutura (espelha PR #5934, mas namespace/body do Campaign Management):
 *
 *   <s:Envelope xmlns:i=... xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
 *     <s:Header xmlns="https://api.bingads.microsoft.com/API/CampaignManagement/v13">
 *       <Action mustUnderstand="1">GetAssetGroupsEditorialReasons</Action>
 *       <AuthenticationToken>...</AuthenticationToken>
 *       <DeveloperToken>...</DeveloperToken>
 *       <CustomerId>...</CustomerId>
 *       <CustomerAccountId>...</CustomerAccountId>
 *     </s:Header>
 *     <s:Body>
 *       <GetAssetGroupsEditorialReasonsRequest xmlns="https://api.bingads.microsoft.com/API/CampaignManagement/v13">
 *         <AccountId>...</AccountId>
 *         <AssetGroupId>...</AssetGroupId>
 *       </GetAssetGroupsEditorialReasonsRequest>
 *     </s:Body>
 *   </s:Envelope>
 *
 * @pure
 */
export function buildEditorialReasonsEnvelope(
  accessToken: string,
  auth: Pick<MicrosoftAdsAuthConfig, "developerToken" | "customerId" | "accountId">,
  assetGroupId: string,
): string {
  return xmlBuilder.build({
    "s:Envelope": {
      "@_xmlns:i": "http://www.w3.org/2001/XMLSchema-instance",
      "@_xmlns:s": "http://schemas.xmlsoap.org/soap/envelope/",
      "s:Header": {
        "@_xmlns": CAMPAIGN_MANAGEMENT_NAMESPACE,
        Action: {
          "@_mustUnderstand": "1",
          "#text": "GetAssetGroupsEditorialReasons",
        },
        AuthenticationToken: accessToken,
        DeveloperToken: auth.developerToken,
        CustomerId: auth.customerId,
        CustomerAccountId: auth.accountId,
      },
      "s:Body": {
        GetAssetGroupsEditorialReasonsRequest: {
          "@_xmlns": CAMPAIGN_MANAGEMENT_NAMESPACE,
          AccountId: auth.accountId,
          AssetGroupId: assetGroupId,
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// SOAP Fault extraction
// ---------------------------------------------------------------------------

/**
 * Extrai a mensagem de um SOAP Fault (1.1) da resposta XML da Campaign
 * Management API — best-effort: se não for um Fault reconhecível, devolve
 * `null` e o chamador cai no fallback de exibir o texto bruto.
 *
 * @pure
 */
export function extractSoapFaultMessage(xml: string): string | null {
  try {
    // biome-ignore lint: payload de erro upstream, forma não é tipada aqui de propósito
    const parsed: any = xmlParser.parse(xml);
    const fault = parsed?.Envelope?.Body?.Fault;
    if (!fault) return null;
    // SOAP 1.1 Fault: <faultcode>, <faultstring>, <detail>
    // SOAP 1.2 Fault: <Code><Value>...</Value></Code>, <Reason><Text>...</Text></Reason>
    const faultString = fault.faultstring;
    const reasonText = fault.Reason?.Text;
    // Campaign Management API Fault detail: ApiFault → OperationErrors → OperationError → Message
    const errorContainer =
      fault.Detail?.ApiFault?.OperationErrors?.OperationError ??
      fault.Detail?.AdApiFaultDetail?.Errors?.AdApiError ??
      fault.Detail?.ApiFaultDetail?.OperationErrors?.OperationError;
    const errorList =
      errorContainer === undefined ? [] : Array.isArray(errorContainer) ? errorContainer : [errorContainer];
    const errorMsgs = errorList.map((e) => e?.Message).filter(Boolean).join("; ");
    const combined = [faultString, reasonText, errorMsgs].filter(Boolean).join(" — ");
    return combined || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST SOAP
// ---------------------------------------------------------------------------

/**
 * POST do envelope SOAP — SOAP 1.1 (`text/xml; charset=utf-8` + header HTTP
 * `SOAPAction`). Validado ao vivo em #5928: `application/soap+xml` devolve
 * HTTP 415. Nunca lança — falha de rede vira `{ error }`.
 */
export async function postSoapGeneric(
  fetchImpl: FetchLike,
  url: string,
  action: string,
  envelope: string,
): Promise<{ text: string; status: number } | { error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: action,
      },
      body: envelope,
    });
  } catch (e) {
    return { error: `falha de rede na chamada SOAP: ${e instanceof Error ? e.message : e}` };
  }
  const text = await res.text();
  return { text, status: res.status };
}

// ---------------------------------------------------------------------------
// Response parsing (pure)
// ---------------------------------------------------------------------------

/**
 * Faz parse da resposta XML de `GetAssetGroupsEditorialReasonsResponse`,
 * devolvendo o array de `MicrosoftAdsEditorialReason`.
 *
 * @pure — testável sem I/O.
 */
export function parseEditorialReasonsResponse(xml: string): MicrosoftAdsEditorialReason[] {
  const parsed: any = xmlParser.parse(xml);
  const collection =
    parsed?.Envelope?.Body?.GetAssetGroupsEditorialReasonsResponse?.EditorialReasonCollection;
  if (!collection) return [];
  const reasonsRaw = collection.EditorialReasons;
  if (!reasonsRaw) return [];
  const reasonsArray = Array.isArray(reasonsRaw) ? reasonsRaw : [reasonsRaw];
  return reasonsArray.map((r: any): MicrosoftAdsEditorialReason => ({
    reasonCode: Number(r.ReasonCode) || 0,
    location: String(r.Location ?? ""),
    publisherCountries: String(r.PublisherCountries ?? ""),
    term: String(r.Term ?? ""),
    appealStatus: String(r.AppealStatus ?? ""),
  }));
}

// ---------------------------------------------------------------------------
// Fetch (fail-soft, injetável)
// ---------------------------------------------------------------------------

/**
 * Resolve o call SOAP sincrono de `GetAssetGroupsEditorialReasons` —
 * refresh token → envelope → POST → parse da resposta — sem nunca lançar.
 * Qualquer falha vira `{ ok: false, error }`.
 *
 * Plugs na mesma credencial que `microsoft-ads-ingest.ts` usa (Campaign
 * Management e Reporting compartilham o escopo `msads.manage`), mas é um
 * serviço SOAP distinto (management, não reporting).
 */
export async function fetchAssetGroupEditorialReasons(
  fetchImpl: FetchLike,
  auth: MicrosoftAdsAuthConfig,
  opts: FetchAssetGroupEditorialReasonsOptions,
): Promise<AssetGroupEditorialReasonsResult> {
  const serviceUrl = opts.campaignManagementUrl ?? CAMPAIGN_MANAGEMENT_SERVICE_URL;

  const tokenResult = await refreshMicrosoftAdsAccessToken(fetchImpl, {
    clientId: auth.clientId,
    clientSecret: auth.clientSecret,
    refreshToken: auth.refreshToken,
    tokenEndpoint: auth.tokenEndpoint,
  });
  if ("error" in tokenResult) {
    return { ok: false, error: `renovação do access token falhou: ${tokenResult.error}` };
  }

  const envelope = buildEditorialReasonsEnvelope(tokenResult.accessToken, auth, opts.assetGroupId);

  const postResult = await postSoapGeneric(
    fetchImpl,
    serviceUrl,
    "GetAssetGroupsEditorialReasons",
    envelope,
  );
  if ("error" in postResult) {
    return { ok: false, error: postResult.error };
  }
  if (postResult.status !== 200) {
    return {
      ok: false,
      error: `GetAssetGroupsEditorialReasons respondeu HTTP ${postResult.status}: ${extractSoapFaultMessage(postResult.text) ?? postResult.text.slice(0, 400)}`,
    };
  }

  let reasons: MicrosoftAdsEditorialReason[];
  try {
    reasons = parseEditorialReasonsResponse(postResult.text);
  } catch (e) {
    return {
      ok: false,
      error: `falha parseando resposta SOAP: ${e instanceof Error ? e.message : e}`,
    };
  }

  return { ok: true, reasons, count: reasons.length, source: "live" };
}
