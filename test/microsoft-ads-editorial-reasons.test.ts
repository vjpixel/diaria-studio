/**
 * test/microsoft-ads-editorial-reasons.test.ts (#5878)
 *
 * Cobre `scripts/lib/microsoft-ads-editorial-reasons.ts`: envelope SOAP,
 * parsing da resposta XML (single/multiple/empty), extração de SOAP Fault,
 * e o caminho fail-soft end-to-end via fetch mockado. Nunca toca a API
 * real — inspirado na disciplina de `test/microsoft-ads-ingest-5502.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildEditorialReasonsEnvelope,
  parseEditorialReasonsResponse,
  extractSoapFaultMessage,
  extractPartialErrors,
  fetchAssetGroupEditorialReasons,
  type MicrosoftAdsEditorialReason,
  type MicrosoftAdsAuthConfig,
  type FetchLike,
  CAMPAIGN_MANAGEMENT_NAMESPACE,
  CAMPAIGN_MANAGEMENT_SERVICE_URL,
} from "../scripts/lib/microsoft-ads-editorial-reasons.ts";

const AUTH: MicrosoftAdsAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  developerToken: "dev-token",
  customerId: "255014657",
  accountId: "189335528",
};

const ASSET_GROUP_ID = "1187474912702110";
const CAMPAIGN_ID = "571543153";

// ---------------------------------------------------------------------------
// Fixtures XML — baseadas no contrato real da Campaign Management API v13
// ---------------------------------------------------------------------------

/** Coleção de um asset group no shape REAL da API (#10063 — doc oficial +
 *  resposta ao vivo de 12/10/2026). */
const collection = (appeal: string, reasons: string) => `
        <AssetGroupEditorialReasonCollection>
          <AppealStatus>${appeal}</AppealStatus>
          <AssetGroupId>${ASSET_GROUP_ID}</AssetGroupId>
          <CampaignId>${CAMPAIGN_ID}</CampaignId>
          ${reasons}
        </AssetGroupEditorialReasonCollection>`;
const wrap = (inner: string) => `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <GetAssetGroupsEditorialReasonsResponse xmlns="${CAMPAIGN_MANAGEMENT_NAMESPACE}">
      <EditorialReasons xmlns:i="http://www.w3.org/2001/XMLSchema-instance">${inner}
      </EditorialReasons>
      <PartialErrors xmlns:i="http://www.w3.org/2001/XMLSchema-instance"/>
    </GetAssetGroupsEditorialReasonsResponse>
  </s:Body>
</s:Envelope>`;

/** Resposta sucesso com 2 motivos editoriais. */
const RESPONSE_XML_2_REASONS = wrap(
  collection(
    "Appealable",
    `<Reasons>
            <AssetGroupEditorialReason>
              <Location>Headline</Location>
              <PublisherCountries xmlns:a1="http://schemas.microsoft.com/2003/10/Serialization/Arrays"><a1:string>US</a1:string></PublisherCountries>
              <ReasonCode>110</ReasonCode>
              <Term>click here now</Term>
            </AssetGroupEditorialReason>
            <AssetGroupEditorialReason>
              <Location>Description</Location>
              <PublisherCountries xmlns:a1="http://schemas.microsoft.com/2003/10/Serialization/Arrays"><a1:string>US</a1:string><a1:string>BR</a1:string><a1:string>CA</a1:string></PublisherCountries>
              <ReasonCode>123</ReasonCode>
              <Term>free gift card</Term>
            </AssetGroupEditorialReason>
          </Reasons>`,
  ),
);

/** Resposta sucesso com 1 motivo. */
const RESPONSE_XML_1_REASON = wrap(
  collection(
    "Appealable",
    `<Reasons>
            <AssetGroupEditorialReason>
              <Location>Headline</Location>
              <PublisherCountries xmlns:a1="http://schemas.microsoft.com/2003/10/Serialization/Arrays"><a1:string>BR</a1:string></PublisherCountries>
              <ReasonCode>702</ReasonCode>
              <Term>promoção relâmpago</Term>
            </AssetGroupEditorialReason>
          </Reasons>`,
  ),
);

/** Resposta sucesso sem razões — cópia da resposta REAL de 12/10/2026 pro
 *  asset group 1187474912702110 (PMax teste 2608, campanha pausada). */
const RESPONSE_XML_NO_REASONS = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Header><h:TrackingId xmlns:h="https://bingads.microsoft.com/CampaignManagement/v13">2803145c-4b4f-4eca-8e84-e368073bc70d</h:TrackingId></s:Header><s:Body><GetAssetGroupsEditorialReasonsResponse xmlns="https://bingads.microsoft.com/CampaignManagement/v13"><EditorialReasons xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><AssetGroupEditorialReasonCollection><AppealStatus>NotAppealable</AppealStatus><AssetGroupId>1187474912702110</AssetGroupId><CampaignId>571543153</CampaignId><Reasons/></AssetGroupEditorialReasonCollection></EditorialReasons><PartialErrors xmlns:i="http://www.w3.org/2001/XMLSchema-instance"/></GetAssetGroupsEditorialReasonsResponse></s:Body></s:Envelope>`;

/** Fault REAL devolvido (HTTP 200) pelo corpo antigo `<AssetGroupId>` solto
 *  — todos os dias desde que o #9091 passou a exigir o nó de resposta. */
const SOAP_FAULT_2829_XML = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Server</faultcode><faultstring xml:lang="en-US">Invalid client data. Check the SOAP fault details for more information. TrackingId: b101383c-706c-4e85-a6ee-eccca6f4c78c.</faultstring><detail><ApiFaultDetail xmlns="https://bingads.microsoft.com/CampaignManagement/v13" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><TrackingId xmlns="https://adapi.microsoft.com">b101383c-706c-4e85-a6ee-eccca6f4c78c</TrackingId><BatchErrors/><OperationErrors><OperationError><Code>2829</Code><Details i:nil="true"/><ErrorCode>CampaignServiceEntitiesArrayIsNullOrEmpty</ErrorCode><Message>The list of entities cannot be null or empty.</Message></OperationError></OperationErrors></ApiFaultDetail></detail></s:Fault></s:Body></s:Envelope>`;

/** Resposta com PartialErrors (asset group não resolvido). */
const RESPONSE_XML_PARTIAL_ERROR = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><GetAssetGroupsEditorialReasonsResponse xmlns="${CAMPAIGN_MANAGEMENT_NAMESPACE}"><EditorialReasons xmlns:i="http://www.w3.org/2001/XMLSchema-instance"/><PartialErrors xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><BatchError><Code>1201</Code><ErrorCode>CampaignServiceInvalidAssetGroupId</ErrorCode><Index>0</Index><Message>The asset group ID is invalid.</Message></BatchError></PartialErrors></GetAssetGroupsEditorialReasonsResponse></s:Body></s:Envelope>`;

/** SOAP Fault típico da Campaign Management API (token expirado). */
const SOAP_FAULT_XML = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <s:Fault>
      <faultcode>s:Client</faultcode>
      <faultstring>Invalid Credentials</faultstring>
      <detail>
        <ApiFault xmlns="${CAMPAIGN_MANAGEMENT_NAMESPACE}">
          <OperationErrors>
            <OperationError>
              <Message>Invalid Credentials</Message>
            </OperationError>
          </OperationErrors>
        </ApiFault>
      </detail>
    </s:Fault>
  </s:Body>
</s:Envelope>`;

/** SOAP Fault sem detail (faultstring puro). */
const SOAP_FAULT_SIMPLE = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <s:Fault>
      <faultcode>s:Client</faultcode>
      <faultstring>The asset group id is invalid</faultstring>
    </s:Fault>
  </s:Body>
</s:Envelope>`;

// ---------------------------------------------------------------------------

describe("#5878 — buildEditorialReasonsEnvelope", () => {
  it("produz envelope SOAP 1.1 com namespace Campaign Management e action correto", () => {
    const env = buildEditorialReasonsEnvelope("fake-token", AUTH, ASSET_GROUP_ID, CAMPAIGN_ID);

    // SOAP 1.1 envelope + header
    assert.match(env, /<s:Envelope/);
    assert.match(env, /xmlns:s="http:\/\/schemas\.xmlsoap\.org\/soap\/envelope\/"/);
    assert.match(env, /xmlns:i="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance"/);

    // Header no namespace correto
    assert.ok(env.includes(`<s:Header xmlns="${CAMPAIGN_MANAGEMENT_NAMESPACE}">`));

    // Action + mustUnderstand
    assert.match(env, /<Action mustUnderstand="1">GetAssetGroupsEditorialReasons<\/Action>/);

    // Auth elements
    assert.match(env, /<AuthenticationToken>fake-token<\/AuthenticationToken>/);
    assert.match(env, /<DeveloperToken>dev-token<\/DeveloperToken>/);
    assert.match(env, /<CustomerId>255014657<\/CustomerId>/);
    assert.match(env, /<CustomerAccountId>189335528<\/CustomerAccountId>/);

    // Body com request
    assert.ok(env.includes(`<GetAssetGroupsEditorialReasonsRequest xmlns="${CAMPAIGN_MANAGEMENT_NAMESPACE}">`));
    assert.match(env, /<AccountId>189335528<\/AccountId>/);
    assert.match(
      env,
      /<AssetGroupIdToCampaignIdAssociations>\s*<EntityIdToParentIdAssociation>\s*<EntityId>1187474912702110<\/EntityId>\s*<ParentId>571543153<\/ParentId>/,
    );
  });

  it("usa accountId como CustomerAccountId, não accountId literal", () => {
    const env = buildEditorialReasonsEnvelope("tok", AUTH, "999", "888");
    assert.match(env, /<CustomerId>255014657<\/CustomerId>/);
    assert.match(env, /<CustomerAccountId>189335528<\/CustomerAccountId>/);
    assert.match(env, /<EntityId>999<\/EntityId>/);
    assert.match(env, /<ParentId>888<\/ParentId>/);
  });
});

describe("#5878 — parseEditorialReasonsResponse", () => {
  it("faz parse de múltiplas razões (array)", () => {
    const reasons = parseEditorialReasonsResponse(RESPONSE_XML_2_REASONS);
    assert.equal(reasons.length, 2);

    assert.deepEqual(reasons[0], {
      reasonCode: 110,
      location: "Headline",
      publisherCountries: "US",
      term: "click here now",
      appealStatus: "Appealable",
    });
    assert.deepEqual(reasons[1], {
      reasonCode: 123,
      location: "Description",
      publisherCountries: "US,BR,CA",
      term: "free gift card",
      appealStatus: "Appealable",
    });
  });

  it("faz parse de razão única (não-array no XML)", () => {
    const reasons = parseEditorialReasonsResponse(RESPONSE_XML_1_REASON);
    assert.equal(reasons.length, 1);
    assert.deepEqual(reasons[0], {
      reasonCode: 702,
      location: "Headline",
      publisherCountries: "BR",
      term: "promoção relâmpago",
      appealStatus: "Appealable",
    });
  });

  it("devolve array vazio quando não há razões", () => {
    const reasons = parseEditorialReasonsResponse(RESPONSE_XML_NO_REASONS);
    assert.deepEqual(reasons, []);
  });

  it("devolve array vazio quando a resposta não contém EditorialReasons", () => {
    const reasons = parseEditorialReasonsResponse("<Envelope><Body></Body></Envelope>");
    assert.deepEqual(reasons, []);
  });

  it("não lança em XML malformado", () => {
    // XMLParser do fast-xml-parser é tolerante — não lança, devolve objeto vazio
    const reasons = parseEditorialReasonsResponse("not xml at all <<<>>>");
    assert.deepEqual(reasons, []);
  });
});

describe("#5878 — extractSoapFaultMessage", () => {
  it("extrai faultstring + detalhe da ApiFault (SOAP 1.1)", () => {
    const msg = extractSoapFaultMessage(SOAP_FAULT_XML);
    assert.ok(msg);
    assert.match(msg, /Invalid Credentials/);
  });

  it("extrai faultstring puro quando não há detail", () => {
    const msg = extractSoapFaultMessage(SOAP_FAULT_SIMPLE);
    assert.equal(msg, "The asset group id is invalid");
  });

  it("devolve null quando não é um Fault", () => {
    const msg = extractSoapFaultMessage(RESPONSE_XML_1_REASON);
    assert.equal(msg, null);
  });

  it("devolve null para texto não-XML", () => {
    const msg = extractSoapFaultMessage("plain text");
    assert.equal(msg, null);
  });
});

describe("#5878 — fetchAssetGroupEditorialReasons (fail-soft)", () => {
  it("caminho feliz: token + SOAP 200 → razões parseadas", async () => {
    const fetchImpl: FetchLike = async (url: string) => {
      if (url.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "tok-123" }), { status: 200 });
      }
      return new Response(RESPONSE_XML_2_REASONS, { status: 200 });
    };

    const result = await fetchAssetGroupEditorialReasons(fetchImpl, AUTH, {
      assetGroupId: ASSET_GROUP_ID,
      campaignId: CAMPAIGN_ID,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.count, 2);
      assert.equal(result.reasons[0].reasonCode, 110);
      assert.equal(result.reasons[1].reasonCode, 123);
      assert.equal(result.source, "live");
    }
  });

  it("caminho feliz: resposta sem razões devolve ok=true com count=0", async () => {
    const fetchImpl: FetchLike = async (url: string) => {
      if (url.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      return new Response(RESPONSE_XML_NO_REASONS, { status: 200 });
    };

    const result = await fetchAssetGroupEditorialReasons(fetchImpl, AUTH, {
      assetGroupId: ASSET_GROUP_ID,
      campaignId: CAMPAIGN_ID,
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.count, 0);
  });

  it("falha de token → { ok: false, error } com mensagem de rede", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await fetchAssetGroupEditorialReasons(fetchImpl, AUTH, {
      assetGroupId: ASSET_GROUP_ID,
      campaignId: CAMPAIGN_ID,
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /ECONNREFUSED/);
  });

  it("token OK mas HTTP 401 (SOAP Fault) → { ok: false, error }", async () => {
    const fetchImpl: FetchLike = async (url: string) => {
      if (url.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      // Retorna o fault XML como body de um 500 (padrão SOAP error)
      return new Response(SOAP_FAULT_XML, { status: 500 });
    };

    const result = await fetchAssetGroupEditorialReasons(fetchImpl, AUTH, {
      assetGroupId: ASSET_GROUP_ID,
      campaignId: CAMPAIGN_ID,
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /HTTP 500/);
  });

  it("usa campaignManagementUrl customizado (override de teste)", async () => {
    let calledUrl: string | undefined;
    const fetchImpl: FetchLike = async (url: string) => {
      if (url.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      calledUrl = url;
      return new Response(RESPONSE_XML_1_REASON, { status: 200 });
    };

    await fetchAssetGroupEditorialReasons(fetchImpl, AUTH, {
      assetGroupId: ASSET_GROUP_ID,
      campaignId: CAMPAIGN_ID,
      campaignManagementUrl: "https://test.example.svc",
    });

    assert.equal(calledUrl, "https://test.example.svc");
  });

  it("nunca lança mesmo com XML inesperado no corpo", async () => {
    const fetchImpl: FetchLike = async (url: string) => {
      if (url.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      return new Response("<html>500 Internal Server Error</html>", { status: 500 });
    };

    const result = await fetchAssetGroupEditorialReasons(fetchImpl, AUTH, {
      assetGroupId: ASSET_GROUP_ID,
      campaignId: CAMPAIGN_ID,
    });

    assert.equal(result.ok, false);
  });

  it("endpoint default é a Campaign Management API v13, no subdomínio campaign.api (#7504 — api.bingads.microsoft.com não existe, produz HTTP 404)", () => {
    assert.equal(
      CAMPAIGN_MANAGEMENT_SERVICE_URL,
      "https://campaign.api.bingads.microsoft.com/Api/Advertiser/CampaignManagement/v13/CampaignManagementService.svc",
    );
  });
});

describe("#7504 — namespace SOAP correto (bug real: api.bingads.microsoft.com/API/... nunca funcionou)", () => {
  it("CAMPAIGN_MANAGEMENT_NAMESPACE é https://bingads.microsoft.com/CampaignManagement/v13, não api.bingads.microsoft.com/API/...", () => {
    assert.equal(CAMPAIGN_MANAGEMENT_NAMESPACE, "https://bingads.microsoft.com/CampaignManagement/v13");
  });

  it("envelope usa o namespace corrigido no Header e no Body", () => {
    const env = buildEditorialReasonsEnvelope("tok", AUTH, ASSET_GROUP_ID, CAMPAIGN_ID);
    assert.ok(env.includes(`<s:Header xmlns="${CAMPAIGN_MANAGEMENT_NAMESPACE}">`));
    assert.ok(env.includes(`<GetAssetGroupsEditorialReasonsRequest xmlns="${CAMPAIGN_MANAGEMENT_NAMESPACE}">`));
    assert.ok(!env.includes("api.bingads.microsoft.com/API/CampaignManagement"));
  });
});

describe("#7504 — <IdentityProvider>Google</IdentityProvider> no SOAP Header, espelhando microsoft-ads-ingest.ts (#5928)", () => {
  const AUTH_GOOGLE: MicrosoftAdsAuthConfig = {
    ...AUTH,
    googleClientId: "google-client-id",
    googleClientSecret: "google-client-secret",
    googleRefreshToken: "google-refresh-token",
  };

  it("auth com googleRefreshToken → envelope leva o header IdentityProvider=Google", () => {
    const env = buildEditorialReasonsEnvelope("tok", AUTH_GOOGLE, ASSET_GROUP_ID, CAMPAIGN_ID);
    assert.match(env, /<IdentityProvider>Google<\/IdentityProvider>/);
  });

  it("auth SEM googleRefreshToken (Azure AD) → envelope NUNCA leva IdentityProvider", () => {
    const env = buildEditorialReasonsEnvelope("tok", AUTH, ASSET_GROUP_ID, CAMPAIGN_ID);
    assert.doesNotMatch(env, /IdentityProvider/);
  });

  it("fetchAssetGroupEditorialReasons com auth Google propaga o header até o POST real", async () => {
    let postedBody = "";
    const fetchImpl: FetchLike = async (url: string, init?: RequestInit) => {
      if (url.includes("login.microsoftonline.com") || url.includes("oauth2")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      postedBody = String(init?.body ?? "");
      return new Response(RESPONSE_XML_1_REASON, { status: 200 });
    };

    // AUTH_GOOGLE não tem clientId/refreshToken "azure" — mas fetchAssetGroupEditorialReasons
    // roteia por refreshMicrosoftAdsAccessToken, que decide pelo googleRefreshToken.
    const authGoogleFull: MicrosoftAdsAuthConfig = {
      ...AUTH_GOOGLE,
      googleTokenEndpoint: "https://oauth2.googleapis.com/token",
    };

    const result = await fetchAssetGroupEditorialReasons(fetchImpl, authGoogleFull, {
      assetGroupId: ASSET_GROUP_ID,
      campaignId: CAMPAIGN_ID,
    });

    assert.equal(result.ok, true);
    assert.match(postedBody, /<IdentityProvider>Google<\/IdentityProvider>/);
  });
});

describe("#10063 — request no shape oficial (AssetGroupIdToCampaignIdAssociations) e respostas reais", () => {
  const tokenThen = (body: string, status = 200, sink?: (b: string) => void): FetchLike =>
    async (url: string, init?: RequestInit) => {
      if (url.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      sink?.(String(init?.body ?? ""));
      return new Response(body, { status });
    };

  it("envelope NUNCA manda <AssetGroupId> solto no Body (o shape que gerava o Fault 2829)", () => {
    const env = buildEditorialReasonsEnvelope("tok", AUTH, ASSET_GROUP_ID, CAMPAIGN_ID);
    const body = env.slice(env.indexOf("<s:Body>"));
    assert.doesNotMatch(body, /<AssetGroupId>/);
    assert.match(body, /<EntityIdToParentIdAssociation>/);
  });

  it("resposta REAL sem motivos (12/10/2026) → ok, count 0 (não é shape inesperado)", async () => {
    const result = await fetchAssetGroupEditorialReasons(tokenThen(RESPONSE_XML_NO_REASONS), AUTH, {
      assetGroupId: ASSET_GROUP_ID,
      campaignId: CAMPAIGN_ID,
    });
    assert.deepEqual(result, { ok: true, reasons: [], count: 0, source: "live" });
  });

  it("Fault 2829 REAL em HTTP 200 → erro com ErrorCode/mensagem do <detail> minúsculo, não só o faultstring genérico", async () => {
    const result = await fetchAssetGroupEditorialReasons(tokenThen(SOAP_FAULT_2829_XML), AUTH, {
      assetGroupId: ASSET_GROUP_ID,
      campaignId: CAMPAIGN_ID,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /CampaignServiceEntitiesArrayIsNullOrEmpty \(2829\)/);
      assert.match(result.error, /The list of entities cannot be null or empty/);
    }
  });

  it("extractSoapFaultMessage lê <detail> minúsculo (SOAP 1.1 real)", () => {
    const msg = extractSoapFaultMessage(SOAP_FAULT_2829_XML);
    assert.ok(msg);
    assert.match(msg, /Invalid client data/);
    assert.match(msg, /CampaignServiceEntitiesArrayIsNullOrEmpty/);
  });

  it("PartialErrors não vazio → { ok: false } (nunca vira '0 motivos')", async () => {
    assert.deepEqual(extractPartialErrors(RESPONSE_XML_PARTIAL_ERROR), [
      "CampaignServiceInvalidAssetGroupId (1201): The asset group ID is invalid.",
    ]);
    assert.deepEqual(extractPartialErrors(RESPONSE_XML_NO_REASONS), []);
    const result = await fetchAssetGroupEditorialReasons(tokenThen(RESPONSE_XML_PARTIAL_ERROR), AUTH, {
      assetGroupId: ASSET_GROUP_ID,
      campaignId: CAMPAIGN_ID,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /PartialErrors: CampaignServiceInvalidAssetGroupId/);
  });

  it("o POST real leva o par asset group → campanha", async () => {
    let posted = "";
    await fetchAssetGroupEditorialReasons(tokenThen(RESPONSE_XML_NO_REASONS, 200, (b) => (posted = b)), AUTH, {
      assetGroupId: "111",
      campaignId: "222",
    });
    assert.match(posted, /<EntityId>111<\/EntityId>\s*<ParentId>222<\/ParentId>/);
  });
});
