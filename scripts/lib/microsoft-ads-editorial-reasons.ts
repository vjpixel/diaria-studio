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
 *  (`reporting.api.bingads.microsoft.com`), esta é a API de *management*,
 *  servida no subdomínio `campaign.api.bingads.microsoft.com` — **não**
 *  `api.bingads.microsoft.com` (esse host/path não existe, produz HTTP 404
 *  antes de qualquer auth ser avaliada; confirmado ao vivo #7504). */
export const CAMPAIGN_MANAGEMENT_SERVICE_URL =
  "https://campaign.api.bingads.microsoft.com/Api/Advertiser/CampaignManagement/v13/CampaignManagementService.svc";

/** Namespace SOAP do Campaign Management v13 — vai no `@xmlns` do header e
 *  do body. **Não** segue o padrão `https://api.bingads.microsoft.com/API/...`
 *  usado erroneamente antes do #7504 — o namespace real, espelhando
 *  `REPORTING_NAMESPACE` (`https://bingads.microsoft.com/Reporting/v13`) de
 *  `microsoft-ads-ingest.ts`, é `https://bingads.microsoft.com/CampaignManagement/v13`
 *  (confirmado ao vivo #7504). */
export const CAMPAIGN_MANAGEMENT_NAMESPACE =
  "https://bingads.microsoft.com/CampaignManagement/v13";

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
  /** Campaign ID dono do asset group (ex: "571543153", PMax teste 2608).
   *  Obrigatório (#10063): a operação recebe pares
   *  `EntityIdToParentIdAssociation` (asset group → campanha), não um
   *  `AssetGroupId` solto. */
  campaignId: string;
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
 *     <s:Header xmlns="https://bingads.microsoft.com/CampaignManagement/v13">
 *       <Action mustUnderstand="1">GetAssetGroupsEditorialReasons</Action>
 *       <AuthenticationToken>...</AuthenticationToken>
 *       <DeveloperToken>...</DeveloperToken>
 *       <CustomerId>...</CustomerId>
 *       <CustomerAccountId>...</CustomerAccountId>
 *       <IdentityProvider>Google</IdentityProvider>  <!-- só quando auth.googleRefreshToken -->
 *     </s:Header>
 *     <s:Body>
 *       <GetAssetGroupsEditorialReasonsRequest xmlns="https://bingads.microsoft.com/CampaignManagement/v13">
 *         <AccountId>...</AccountId>
 *         <AssetGroupIdToCampaignIdAssociations>
 *           <EntityIdToParentIdAssociation>
 *             <EntityId>{assetGroupId}</EntityId>
 *             <ParentId>{campaignId}</ParentId>
 *           </EntityIdToParentIdAssociation>
 *         </AssetGroupIdToCampaignIdAssociations>
 *       </GetAssetGroupsEditorialReasonsRequest>
 *     </s:Body>
 *   </s:Envelope>
 *
 * **#10063 — o corpo antigo (`<AssetGroupId>` solto) NUNCA funcionou:** a API
 * responde HTTP 200 com SOAP Fault `2829 CampaignServiceEntitiesArrayIsNullOrEmpty`
 * ("The list of entities cannot be null or empty"). Até o #9091 esse Fault
 * era lido como "0 motivos" (exit 0); o #9091 passou a exigir o nó de
 * resposta e a unit ficou vermelha todo dia. Shape correto conferido contra
 * a doc oficial (learn.microsoft.com → GetAssetGroupsEditorialReasons) e ao
 * vivo em 12/10/2026 (resposta real com `AssetGroupEditorialReasonCollection`).
 *
 * `<IdentityProvider>Google</IdentityProvider>` entra no SOAP Header só
 * quando `auth.googleRefreshToken` está presente — mesmo critério e mesmo
 * padrão de `buildSoapEnvelope` em `microsoft-ads-ingest.ts` (#5928,
 * espelhado aqui em #7504: este módulo emitia a Reporting API corretamente
 * mas não emitia o header aqui, na Campaign Management API). Contas Azure
 * AD normais não devem levar este header.
 *
 * @pure
 */
export function buildEditorialReasonsEnvelope(
  accessToken: string,
  auth: Pick<MicrosoftAdsAuthConfig, "developerToken" | "customerId" | "accountId" | "googleRefreshToken">,
  assetGroupId: string,
  campaignId: string,
): string {
  const identityProviderHeader = auth.googleRefreshToken ? { IdentityProvider: "Google" } : {};
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
        ...identityProviderHeader,
      },
      "s:Body": {
        GetAssetGroupsEditorialReasonsRequest: {
          "@_xmlns": CAMPAIGN_MANAGEMENT_NAMESPACE,
          AccountId: auth.accountId,
          AssetGroupIdToCampaignIdAssociations: {
            EntityIdToParentIdAssociation: {
              EntityId: assetGroupId,
              ParentId: campaignId,
            },
          },
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
    // Campaign Management API Fault detail: ApiFault → OperationErrors → OperationError → Message.
    // SOAP 1.1 usa `<detail>` MINÚSCULO (#10063: o Fault real 2829 chega assim,
    // e só `Detail` maiúsculo era lido — o código/mensagem específicos se
    // perdiam e o log mostrava só o faultstring genérico "Invalid client data").
    const detail = fault.detail ?? fault.Detail;
    const errorContainer =
      detail?.ApiFault?.OperationErrors?.OperationError ??
      detail?.AdApiFaultDetail?.Errors?.AdApiError ??
      detail?.ApiFaultDetail?.OperationErrors?.OperationError ??
      detail?.ApiFaultDetail?.BatchErrors?.BatchError;
    const errorList =
      errorContainer === undefined ? [] : Array.isArray(errorContainer) ? errorContainer : [errorContainer];
    const errorMsgs = errorList
      .filter((e) => e && typeof e === "object" && e.Message)
      .map((e) => (e.ErrorCode ? `${e.ErrorCode} (${e.Code}): ${e.Message}` : String(e.Message)))
      .join("; ");
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

/** Normaliza nó XML opcional/single/array pra array (fast-xml-parser devolve
 *  objeto único quando há 1 filho, array quando há vários, `""` quando o
 *  elemento é vazio). */
function asArray(node: unknown): any[] {
  if (node === undefined || node === null || node === "") return [];
  return Array.isArray(node) ? node : [node];
}

/**
 * Faz parse da resposta XML de `GetAssetGroupsEditorialReasonsResponse`,
 * devolvendo o array de `MicrosoftAdsEditorialReason`.
 *
 * Shape real (#10063, doc oficial + resposta ao vivo de 12/10/2026):
 *
 *   <EditorialReasons>
 *     <AssetGroupEditorialReasonCollection>       (1 por asset group)
 *       <AppealStatus>NotAppealable</AppealStatus>
 *       <AssetGroupId/> <CampaignId/>
 *       <Reasons>
 *         <AssetGroupEditorialReason>
 *           <Location/> <PublisherCountries><string>BR</string></PublisherCountries>
 *           <ReasonCode/> <Term/>
 *         </AssetGroupEditorialReason>
 *       </Reasons>
 *     </AssetGroupEditorialReasonCollection>
 *   </EditorialReasons>
 *
 * O `AppealStatus` vive na COLEÇÃO (por asset group), não em cada motivo —
 * é replicado em cada `MicrosoftAdsEditorialReason`. O shape antigo
 * (`EditorialReasonCollection > EditorialReasons`) nunca existiu na API.
 *
 * @pure — testável sem I/O.
 */
export function parseEditorialReasonsResponse(xml: string): MicrosoftAdsEditorialReason[] {
  const parsed: any = xmlParser.parse(xml);
  const response = parsed?.Envelope?.Body?.GetAssetGroupsEditorialReasonsResponse;
  const collections = asArray(response?.EditorialReasons?.AssetGroupEditorialReasonCollection);
  const out: MicrosoftAdsEditorialReason[] = [];
  for (const c of collections) {
    const appealStatus = String(c?.AppealStatus ?? "");
    for (const r of asArray(c?.Reasons?.AssetGroupEditorialReason)) {
      out.push({
        reasonCode: Number(r?.ReasonCode) || 0,
        location: String(r?.Location ?? ""),
        publisherCountries: asArray(r?.PublisherCountries?.string).map(String).join(","),
        term: String(r?.Term ?? ""),
        appealStatus,
      });
    }
  }
  return out;
}

/**
 * Mensagens de `PartialErrors` (BatchError[]) da resposta — vazio quando
 * não há erro parcial. Um asset group que a API não conseguiu resolver
 * (ID errado, par asset group→campanha inconsistente) volta aqui, não como
 * Fault — sem esta checagem sairia como "0 motivos" (#10063).
 *
 * @pure
 */
export function extractPartialErrors(xml: string): string[] {
  try {
    const parsed: any = xmlParser.parse(xml);
    const errs = asArray(
      parsed?.Envelope?.Body?.GetAssetGroupsEditorialReasonsResponse?.PartialErrors?.BatchError,
    );
    return errs
      .filter((e) => e && typeof e === "object")
      .map((e) => `${e.ErrorCode ?? "?"} (${e.Code ?? "?"}): ${e.Message ?? "sem mensagem"}`);
  } catch {
    return [];
  }
}

/**
 * `true` quando o corpo é um envelope SOAP com o nó
 * `GetAssetGroupsEditorialReasonsResponse` (#9091). `parseEditorialReasonsResponse`
 * devolve `[]` tanto pra "0 motivos" quanto pra um corpo com shape inesperado
 * (HTML de gateway com 200, envelope de outra operação) — sem esta checagem,
 * esse segundo caso saía como caso vazio legítimo (exit 0, snapshot vazio).
 */
export function hasEditorialReasonsResponseNode(xml: string): boolean {
  try {
    const body: any = xmlParser.parse(xml)?.Envelope?.Body;
    return !!body && typeof body === "object" && "GetAssetGroupsEditorialReasonsResponse" in body;
  } catch {
    return false;
  }
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
    refreshToken: auth.refreshToken,
    tokenEndpoint: auth.tokenEndpoint,
    googleClientId: auth.googleClientId,
    googleClientSecret: auth.googleClientSecret,
    googleRefreshToken: auth.googleRefreshToken,
    googleTokenEndpoint: auth.googleTokenEndpoint,
  });
  if ("error" in tokenResult) {
    return { ok: false, error: `renovação do access token falhou: ${tokenResult.error}` };
  }

  const envelope = buildEditorialReasonsEnvelope(tokenResult.accessToken, auth, opts.assetGroupId, opts.campaignId);

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

  if (!hasEditorialReasonsResponseNode(postResult.text)) {
    return {
      ok: false,
      error: `GetAssetGroupsEditorialReasons respondeu HTTP 200 sem o nó GetAssetGroupsEditorialReasonsResponse (shape inesperado): ${extractSoapFaultMessage(postResult.text) ?? postResult.text.slice(0, 400)}`,
    };
  }

  const partialErrors = extractPartialErrors(postResult.text);
  if (partialErrors.length > 0) {
    return {
      ok: false,
      error: `GetAssetGroupsEditorialReasons devolveu PartialErrors: ${partialErrors.join("; ")}`,
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
