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

// ---------------------------------------------------------------------------
// Fixtures XML — baseadas no contrato real da Campaign Management API v13
// ---------------------------------------------------------------------------

/** Resposta sucesso com 2 motivos editoriais. */
const RESPONSE_XML_2_REASONS = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <GetAssetGroupsEditorialReasonsResponse xmlns="${CAMPAIGN_MANAGEMENT_NAMESPACE}">
      <EditorialReasonCollection>
        <EditorialReasons>
          <ReasonCode>110</ReasonCode>
          <Location>AdGroup</Location>
          <PublisherCountries>US</PublisherCountries>
          <Term>click here now</Term>
          <AppealStatus>None</AppealStatus>
        </EditorialReasons>
        <EditorialReasons>
          <ReasonCode>123</ReasonCode>
          <Location>AdGroup</Location>
          <PublisherCountries>US,BR,CA</PublisherCountries>
          <Term>free gift card</Term>
          <AppealStatus>Appealable</AppealStatus>
        </EditorialReasons>
      </EditorialReasonCollection>
    </GetAssetGroupsEditorialReasonsResponse>
  </s:Body>
</s:Envelope>`;

/** Resposta sucesso com 1 motivo. */
const RESPONSE_XML_1_REASON = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <GetAssetGroupsEditorialReasonsResponse xmlns="${CAMPAIGN_MANAGEMENT_NAMESPACE}">
      <EditorialReasonCollection>
        <EditorialReasons>
          <ReasonCode>702</ReasonCode>
          <Location>AdGroup</Location>
          <PublisherCountries>BR</PublisherCountries>
          <Term>promoção relâmpago</Term>
          <AppealStatus>Appealable</AppealStatus>
        </EditorialReasons>
      </EditorialReasonCollection>
    </GetAssetGroupsEditorialReasonsResponse>
  </s:Body>
</s:Envelope>`;

/** Resposta sucesso sem razões (asset group limpo — nada rejeitado). */
const RESPONSE_XML_NO_REASONS = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <GetAssetGroupsEditorialReasonsResponse xmlns="${CAMPAIGN_MANAGEMENT_NAMESPACE}">
      <EditorialReasonCollection>
      </EditorialReasonCollection>
    </GetAssetGroupsEditorialReasonsResponse>
  </s:Body>
</s:Envelope>`;

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
    const env = buildEditorialReasonsEnvelope("fake-token", AUTH, ASSET_GROUP_ID);

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
    assert.match(env, /<AssetGroupId>1187474912702110<\/AssetGroupId>/);
  });

  it("usa accountId como CustomerAccountId, não accountId literal", () => {
    const env = buildEditorialReasonsEnvelope("tok", AUTH, "999");
    assert.match(env, /<CustomerId>255014657<\/CustomerId>/);
    assert.match(env, /<CustomerAccountId>189335528<\/CustomerAccountId>/);
    assert.match(env, /<AssetGroupId>999<\/AssetGroupId>/);
  });
});

describe("#5878 — parseEditorialReasonsResponse", () => {
  it("faz parse de múltiplas razões (array)", () => {
    const reasons = parseEditorialReasonsResponse(RESPONSE_XML_2_REASONS);
    assert.equal(reasons.length, 2);

    assert.deepEqual(reasons[0], {
      reasonCode: 110,
      location: "AdGroup",
      publisherCountries: "US",
      term: "click here now",
      appealStatus: "None",
    });
    assert.deepEqual(reasons[1], {
      reasonCode: 123,
      location: "AdGroup",
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
      location: "AdGroup",
      publisherCountries: "BR",
      term: "promoção relâmpago",
      appealStatus: "Appealable",
    });
  });

  it("devolve array vazio quando não há razões", () => {
    const reasons = parseEditorialReasonsResponse(RESPONSE_XML_NO_REASONS);
    assert.deepEqual(reasons, []);
  });

  it("devolve array vazio quando a resposta não contém EditorialReasonCollection", () => {
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
    });

    assert.equal(result.ok, false);
  });

  it("endpoint default é a Campaign Management API v13", () => {
    assert.equal(
      CAMPAIGN_MANAGEMENT_SERVICE_URL,
      "https://api.bingads.microsoft.com/Api/Advertiser/CampaignManagement/v13/ApiCampaignManagementService.svc",
    );
  });
});
