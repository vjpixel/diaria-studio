/**
 * test/postmaster-register-domain-4539.test.ts (#4539)
 *
 * Trava o contrato de `scripts/postmaster-register-domain.ts`. O núcleo do que
 * precisa não regredir é a CLASSIFICAÇÃO: os três 4xx que a API devolve têm
 * ações de conserto completamente diferentes (ativar API no GCP, reaprovar
 * scope, verificar posse do domínio), e confundi-los foi o que custou uma
 * sessão de debug no #4154.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCreateResponse,
  listDomains,
  registerDomain,
  DEFAULT_DOMAIN,
  POSTMASTER_V2_BASE,
} from "../scripts/postmaster-register-domain.ts";

test("v2 é a base — a v1 do postmaster-spam-sync não tem domains.create (#4539)", () => {
  assert.match(POSTMASTER_V2_BASE, /\/v2$/);
});

test("2xx → created, ok", () => {
  const r = classifyCreateResponse(200, '{"name":"domains/diar.ia.br"}');
  assert.equal(r.outcome, "created");
  assert.equal(r.ok, true);
});

test("ALREADY_EXISTS é SUCESSO, não erro — idempotência (#4539)", () => {
  // Pelo status canônico...
  const byStatus = classifyCreateResponse(409, "{}");
  assert.equal(byStatus.outcome, "already_exists");
  assert.equal(byStatus.ok, true);
  // ...e pelo código no corpo, porque a Google às vezes devolve 400 com o
  // código dentro em vez do 409.
  const byBody = classifyCreateResponse(400, '{"error":{"status":"ALREADY_EXISTS"}}');
  assert.equal(byBody.outcome, "already_exists");
  assert.equal(byBody.ok, true);
});

test("403 SERVICE_DISABLED ≠ 403 de scope — ações de conserto diferentes (#4154)", () => {
  const disabled = classifyCreateResponse(
    403,
    '{"error":{"status":"PERMISSION_DENIED","message":"SERVICE_DISABLED"}}',
  );
  assert.equal(disabled.outcome, "service_disabled");
  assert.equal(disabled.ok, false);
  assert.match(disabled.action, /console\.cloud\.google\.com/);

  const scope = classifyCreateResponse(
    403,
    '{"error":{"status":"PERMISSION_DENIED","message":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}}',
  );
  assert.equal(scope.outcome, "scope_insufficient");
  assert.equal(scope.ok, false);
  assert.match(scope.action, /oauth-setup/);

  // O operador NUNCA pode receber a ação errada — é o ponto do teste.
  assert.notEqual(disabled.action, scope.action);
});

test("403 sem código reconhecido → aponta posse não verificada, não scope", () => {
  const r = classifyCreateResponse(403, '{"error":{"message":"The caller does not have permission"}}');
  assert.equal(r.outcome, "forbidden");
  assert.equal(r.ok, false);
  assert.match(r.action, /Search Console|posse/i);
});

test("400 INVALID_ARGUMENT → aponta a grafia do --domain", () => {
  const r = classifyCreateResponse(400, '{"error":{"status":"INVALID_ARGUMENT"}}');
  assert.equal(r.outcome, "invalid_argument");
  assert.equal(r.ok, false);
});

test("status inesperado nunca é tratado como sucesso silencioso", () => {
  const r = classifyCreateResponse(500, "upstream boom");
  assert.equal(r.outcome, "error");
  assert.equal(r.ok, false);
  assert.match(r.action, /500/);
});

test("registerDomain posta domainId no endpoint v2", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit = {};
  const fake = (async (url: string, init: RequestInit = {}) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response('{"name":"domains/diar.ia.br"}', { status: 200 });
  }) as unknown as typeof fetch;

  const r = await registerDomain(DEFAULT_DOMAIN, fake as never);
  assert.equal(r.ok, true);
  assert.equal(capturedUrl, `${POSTMASTER_V2_BASE}/domains`);
  assert.equal(capturedInit.method, "POST");
  assert.deepEqual(JSON.parse(String(capturedInit.body)), { domainId: DEFAULT_DOMAIN });
});

test("listDomains descasca o prefixo domains/ e ignora entradas vazias", async () => {
  const fake = (async () =>
    new Response(JSON.stringify({ domains: [{ name: "domains/diar.ia.br" }, { name: "domains/clarice.ai" }, {}] }), {
      status: 200,
    })) as unknown as typeof fetch;

  const domains = await listDomains(fake as never);
  assert.deepEqual(domains, ["diar.ia.br", "clarice.ai"]);
});

test("listDomains falha alto com a ação de conserto, nunca devolve lista vazia em erro", async () => {
  const fake = (async () =>
    new Response('{"error":{"message":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}}', {
      status: 403,
    })) as unknown as typeof fetch;

  await assert.rejects(() => listDomains(fake as never), /oauth-setup/);
});
