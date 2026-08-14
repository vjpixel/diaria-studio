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
  });
});
