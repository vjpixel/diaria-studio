/**
 * test/brevo-error-classify.test.ts (#6035, #5942, #5653)
 *
 * Unit direto de `scripts/lib/brevo-error-classify.ts` — pura, sem rede/gh.
 * O corpo do 401 "unrecognised IP" usado abaixo é o texto REAL copiado do
 * log (`data/clarice-subscribers/.brevo-sync-daily.log`, achado 24-25/08/2026
 * #6124/#6132), não um fake genérico.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBrevoError,
  describeBrevoErrorAction,
  formatBrevoApiError,
  AUTHORISED_IPS_URL,
} from "../scripts/lib/brevo-error-classify.ts";

// Corpo real (truncado a 200 chars, como `brevoGet` faz) do log
// `.brevo-sync-daily.log` linha 13633.
const REAL_UNRECOGNISED_IP_BODY_TRUNCATED =
  '{"message":"We have detected you are using an unrecognised IP address ' +
  "2804:1b3:a941:cb3a:9a28:a6ff:fe0c:1af7. If you performed this action make sure to add the new IP " +
  'address in this link: https://app';

// Corpo COMPLETO (não truncado), do log `.envio-guard.log` linha 186.
const REAL_UNRECOGNISED_IP_BODY_FULL =
  '{"message":"We have detected you are using an unrecognised IP address ' +
  "2804:1b3:a941:cb3a:9a28:a6ff:fe0c:1af7. If you performed this action make sure to add the new IP " +
  'address in this link: https://app.brevo.com/security/authorised_ips","code":"unauthorized"}';

describe("classifyBrevoError (#6035)", () => {
  it("401 com corpo REAL 'unrecognised IP' (truncado a 200 chars) => ip-nao-autorizado, IP extraído", () => {
    const r = classifyBrevoError(401, REAL_UNRECOGNISED_IP_BODY_TRUNCATED);
    assert.equal(r.errorClass, "ip-nao-autorizado");
    assert.equal(r.ip, "2804:1b3:a941:cb3a:9a28:a6ff:fe0c:1af7");
  });

  it("401 com corpo REAL completo => mesmo IP extraído", () => {
    const r = classifyBrevoError(401, REAL_UNRECOGNISED_IP_BODY_FULL);
    assert.equal(r.errorClass, "ip-nao-autorizado");
    assert.equal(r.ip, "2804:1b3:a941:cb3a:9a28:a6ff:fe0c:1af7");
  });

  it("401 com corpo de credencial inválida (sem menção a IP) => auth-invalida, sem IP", () => {
    const r = classifyBrevoError(401, '{"message":"Key not found","code":"unauthorized"}');
    assert.equal(r.errorClass, "auth-invalida");
    assert.equal(r.ip, null);
  });

  it("401 sem corpo (null/undefined) => auth-invalida", () => {
    assert.equal(classifyBrevoError(401, null).errorClass, "auth-invalida");
    assert.equal(classifyBrevoError(401, undefined).errorClass, "auth-invalida");
  });

  it("429 => rate-limit", () => {
    assert.equal(classifyBrevoError(429, "").errorClass, "rate-limit");
  });

  it("500/502/503 => transitorio", () => {
    assert.equal(classifyBrevoError(500, "").errorClass, "transitorio");
    assert.equal(classifyBrevoError(503, "").errorClass, "transitorio");
  });

  it("404/400 => desconhecido", () => {
    assert.equal(classifyBrevoError(404, "").errorClass, "desconhecido");
    assert.equal(classifyBrevoError(400, "").errorClass, "desconhecido");
  });
});

describe("describeBrevoErrorAction (#6035)", () => {
  it("ip-nao-autorizado cita o IP e a URL exata da allowlist", () => {
    const action = describeBrevoErrorAction({ errorClass: "ip-nao-autorizado", ip: "1.2.3.4" });
    assert.match(action ?? "", /1\.2\.3\.4/);
    assert.ok((action ?? "").includes(AUTHORISED_IPS_URL));
  });

  it("desconhecido não tem ação (null)", () => {
    assert.equal(describeBrevoErrorAction({ errorClass: "desconhecido", ip: null }), null);
  });
});

describe("formatBrevoApiError (#6035) — mensagem final acionável", () => {
  it("preserva o corpo cru E anexa a ação exata pro caso de IP bloqueado", () => {
    const msg = formatBrevoApiError("PUT", "/emailCampaigns/178/status", 401, REAL_UNRECOGNISED_IP_BODY_FULL);
    assert.match(msg, /Brevo API PUT \/emailCampaigns\/178\/status falhou \(401\)/);
    assert.ok(msg.includes(REAL_UNRECOGNISED_IP_BODY_FULL), "corpo cru precisa continuar presente pra debug");
    assert.match(msg, /AÇÃO: adicione o IP 2804:1b3:a941:cb3a:9a28:a6ff:fe0c:1af7/);
    assert.ok(msg.includes(AUTHORISED_IPS_URL));
  });

  it("classe 'desconhecido' não anexa nada além do raw", () => {
    const msg = formatBrevoApiError("GET", "/x", 404, "not found");
    assert.equal(msg, "Brevo API GET /x falhou (404): not found");
  });
});
