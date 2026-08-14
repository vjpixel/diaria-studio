/**
 * test/google-ads-associate-5262.test.ts (#5262)
 *
 * Cobre `scripts/lib/google-ads-associate.ts`.
 *
 * O caso que justifica o arquivo: com o developer token no nível "Conta de
 * teste", a chamada de associação responde `DEVELOPER_TOKEN_NOT_APPROVED` —
 * e isso é SUCESSO, porque a doc oficial diz que a chamada pode falhar e o
 * nível do token não importa. Tratar esse erro como falha faria alguém achar
 * que o pré-requisito não foi cumprido e esperar semanas por uma fila que
 * nunca ia andar. É esse engano que os testes travam.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyAssociationResponse,
  buildAssociationRequest,
  extractErrorCodes,
  normalizeCustomerId,
} from "../scripts/lib/google-ads-associate.ts";

describe("#5262 — classifyAssociationResponse", () => {
  it("DEVELOPER_TOKEN_NOT_APPROVED conta como ASSOCIADO (o caso esperado com token de teste)", () => {
    const body = JSON.stringify({
      error: { details: [{ errors: [{ errorCode: { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" } }] }] },
    });
    const out = classifyAssociationResponse(403, body);
    assert.equal(out.kind, "associated");
    assert.match(out.reason, /DEVELOPER_TOKEN_NOT_APPROVED/);
  });

  it("2xx conta como associado", () => {
    assert.equal(classifyAssociationResponse(200, "[]").kind, "associated");
  });

  it("permissão negada / conta inexistente também associam (a requisição foi processada)", () => {
    for (const code of ["USER_PERMISSION_DENIED", "CUSTOMER_NOT_FOUND", "NOT_ADS_USER"]) {
      assert.equal(classifyAssociationResponse(403, `{"e":"${code}"}`).kind, "associated", code);
    }
  });

  it("token inválido/ausente NÃO associa — insistir é o certo", () => {
    for (const code of [
      "INVALID_DEVELOPER_TOKEN",
      "DEVELOPER_TOKEN_PROHIBITED",
      "DEVELOPER_TOKEN_PARAMETER_MISSING",
      "OAUTH_TOKEN_INVALID",
      "SERVICE_DISABLED",
    ]) {
      const out = classifyAssociationResponse(403, `{"e":"${code}"}`);
      assert.equal(out.kind, "inconclusive", code);
      assert.match(out.reason, new RegExp(code));
    }
  });

  it("401/403 sem código conhecido é inconclusivo, nunca sucesso otimista", () => {
    assert.equal(classifyAssociationResponse(401, "nope").kind, "inconclusive");
    assert.equal(classifyAssociationResponse(403, "nope").kind, "inconclusive");
  });

  it("5xx e corpo vazio são inconclusivos", () => {
    assert.equal(classifyAssociationResponse(500, "").kind, "inconclusive");
    assert.equal(classifyAssociationResponse(503, "upstream").kind, "inconclusive");
  });

  it("classificação é case-insensitive (o corpo real vem aninhado e com capitalização variável)", () => {
    assert.equal(classifyAssociationResponse(403, "developer_token_not_approved").kind, "associated");
  });

  it("com os DOIS tipos de código no mesmo corpo, o BLOQUEANTE vence — fail-closed", () => {
    // Cenário real: token OAuth revogado E developer token de nível teste. Se
    // o associante vencesse, declararíamos sucesso com a requisição nunca
    // tendo sido atribuída — o falso sucesso que este módulo existe pra evitar.
    const body = JSON.stringify({
      error: {
        details: [
          {
            errors: [
              { errorCode: { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" } },
              { errorCode: { authenticationError: "OAUTH_TOKEN_REVOKED" } },
            ],
          },
        ],
      },
    });
    const out = classifyAssociationResponse(403, body);
    assert.equal(out.kind, "inconclusive");
    assert.equal(out.matchedCode, "OAUTH_TOKEN_REVOKED");
  });

  it("código citado dentro de uma `message` em prosa NÃO conta como o código do erro", () => {
    // O corpo tem errorCode estruturado NOT_APPROVED e menciona
    // INVALID_DEVELOPER_TOKEN só no texto explicativo. O parse estruturado
    // ignora a prosa; um includes() cru no corpo inteiro inverteria isto.
    const body = JSON.stringify({
      error: {
        message: "see INVALID_DEVELOPER_TOKEN in the troubleshooting guide",
        details: [{ errors: [{ errorCode: { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" } }] }],
      },
    });
    const out = classifyAssociationResponse(403, body);
    assert.equal(out.kind, "associated");
    assert.equal(out.matchedCode, "DEVELOPER_TOKEN_NOT_APPROVED");
  });

  it("expõe matchedCode para o chamador ramificar sem fazer regex na prosa", () => {
    assert.equal(
      classifyAssociationResponse(403, '{"e":"USER_PERMISSION_DENIED"}').matchedCode,
      "USER_PERMISSION_DENIED",
    );
    assert.equal(classifyAssociationResponse(200, "[]").matchedCode, undefined);
    assert.equal(classifyAssociationResponse(500, "boom").matchedCode, undefined);
  });
});

describe("#5262 — extractErrorCodes", () => {
  it("colhe códigos de errorCode aninhado, ignorando o resto do corpo", () => {
    const body = JSON.stringify({
      error: { details: [{ errors: [{ errorCode: { queryError: "BAD_RESOURCE" } }] }] },
    });
    assert.deepEqual(extractErrorCodes(body), ["BAD_RESOURCE"]);
  });

  it("cai no varredor textual quando o corpo não é JSON", () => {
    assert.deepEqual(extractErrorCodes("<html>SERVICE_DISABLED</html>"), ["SERVICE_DISABLED"]);
  });

  it("JSON válido sem errorCode estruturado ainda varre o texto", () => {
    assert.deepEqual(extractErrorCodes('{"msg":"CUSTOMER_NOT_FOUND"}'), ["CUSTOMER_NOT_FOUND"]);
  });

  it("corpo vazio devolve lista vazia, sem lançar", () => {
    assert.deepEqual(extractErrorCodes(""), []);
  });
});

describe("#5262 — buildAssociationRequest / normalizeCustomerId", () => {
  it("monta a URL com a versão e o customer id informados", () => {
    const { url, body } = buildAssociationRequest({
      apiVersion: "v21",
      customerId: "2369219639",
      loginCustomerId: "6236094249",
    });
    assert.equal(url, "https://googleads.googleapis.com/v21/customers/2369219639/googleAds:searchStream");
    assert.match(body, /SELECT customer\.id FROM customer/);
  });

  it("normaliza CID com hífens — o console mostra 623-609-4249, a API quer 6236094249", () => {
    assert.equal(normalizeCustomerId("623-609-4249"), "6236094249");
    assert.equal(normalizeCustomerId("236-921-9639"), "2369219639");
    assert.equal(normalizeCustomerId(" 236 921 9639 "), "2369219639");
    assert.equal(normalizeCustomerId("2369219639"), "2369219639");
    assert.equal(normalizeCustomerId(""), "");
  });
});
