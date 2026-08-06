/**
 * test/postmaster-register-domain-4539.test.ts (#4539)
 *
 * Trava o contrato de `scripts/postmaster-register-domain.ts`. O núcleo do que
 * não pode regredir é a CLASSIFICAÇÃO: vários 4xx diferentes chegam aqui e cada
 * um tem uma ação de conserto distinta. O #4154 é a prova do custo de errar
 * isso — aquela issue foi fechada culpando posse do domínio e reaberta ao
 * descobrir que a conta era OWNER o tempo todo e o culpado era a API
 * desabilitada no GCP.
 *
 * Inclui também a invariante de scope do `oauth-setup.ts`, verificada por
 * LEITURA DE TEXTO — importar aquele módulo dispararia o fluxo OAuth (ele chama
 * `main()` incondicionalmente no fim do arquivo).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyCreateResponse,
  listDomains,
  registerDomain,
  getVerificationToken,
  verifyDomain,
  DEFAULT_DOMAIN,
  POSTMASTER_V2_BASE,
} from "../scripts/postmaster-register-domain.ts";

const ok200 = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

test("v2 é a base — a v1 do postmaster-spam-sync é read-only (#4539)", () => {
  assert.match(POSTMASTER_V2_BASE, /\/v2$/);
});

test("2xx → created, ok", () => {
  const r = classifyCreateResponse(200, '{"name":"domains/diar.ia.br"}');
  assert.equal(r.outcome, "created");
  assert.equal(r.ok, true);
  assert.equal(r.action, "", "sucesso nunca carrega ação de conserto");
});

test("ALREADY_EXISTS é SUCESSO — idempotência (#4539)", () => {
  for (const [status, body] of [
    [409, '{"error":{"status":"ALREADY_EXISTS"}}'],
    [400, '{"error":{"status":"ALREADY_EXISTS"}}'],
    [409, "{}"], // 409 sem código: único 409 documentado deste endpoint
  ] as const) {
    const r = classifyCreateResponse(status, body);
    assert.equal(r.outcome, "already_exists", `status=${status} body=${body}`);
    assert.equal(r.ok, true);
  }
});

test("409 ABORTED NÃO é sucesso — o domínio não foi registrado (#4585)", () => {
  // Regressão da única falha silenciosa possível deste arquivo: 409 mapeia
  // ALREADY_EXISTS *e* ABORTED no modelo de erro da Google. Tratar 409 cru
  // como sucesso reportaria "já estava registrado", exit 0, sem registro.
  const r = classifyCreateResponse(409, '{"error":{"status":"ABORTED","message":"conflict"}}');
  assert.equal(r.outcome, "conflict_aborted");
  assert.equal(r.ok, false, "ABORTED jamais pode sair como ok:true");
  assert.match(r.action, /NÃO foi registrado/);
});

test("SERVICE_DISABLED ≠ posse não verificada ≠ scope — 3 ações distintas", () => {
  const disabled = classifyCreateResponse(403, '{"error":{"message":"SERVICE_DISABLED"}}');
  const scope = classifyCreateResponse(403, '{"error":{"message":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}}');
  const forbidden = classifyCreateResponse(403, '{"error":{"message":"The caller does not have permission"}}');

  assert.equal(disabled.outcome, "service_disabled");
  assert.match(disabled.action, /console\.cloud\.google\.com/);
  assert.equal(scope.outcome, "scope_insufficient");
  assert.match(scope.action, /oauth-setup/);
  assert.equal(forbidden.outcome, "forbidden");
  assert.match(forbidden.action, /posse/i);

  // O ponto do teste: o operador nunca pode receber a ação de outro ramo.
  const actions = new Set([disabled.action, scope.action, forbidden.action]);
  assert.equal(actions.size, 3, "as 3 ações de conserto têm que ser distintas entre si");
  for (const c of [disabled, scope, forbidden]) assert.equal(c.ok, false);
});

test("as detecções alternativas de SERVICE_DISABLED e de scope também pegam", () => {
  // Os dois ramos casam por 2 substrings cada — a 2ª nunca era exercida, então
  // uma "simplificação" futura podia removê-la sem quebrar teste nenhum.
  assert.equal(
    classifyCreateResponse(403, '{"error":{"message":"Postmaster API has not been used in project 123 before"}}').outcome,
    "service_disabled",
  );
  assert.equal(
    classifyCreateResponse(403, '{"error":{"message":"Request had insufficient authentication scopes."}}').outcome,
    "scope_insufficient",
  );
});

test("401 pós-retry aponta o conserto em vez de cair no genérico (#4585)", () => {
  // gFetch já retenta 401 uma vez; chegar aqui significa refresh token morto.
  const r = classifyCreateResponse(401, '{"error":{"status":"UNAUTHENTICATED"}}');
  assert.equal(r.outcome, "unauthenticated");
  assert.equal(r.ok, false);
  assert.match(r.action, /oauth-setup/);
});

test("400 INVALID_ARGUMENT → aponta a grafia do --domain", () => {
  const r = classifyCreateResponse(400, '{"error":{"status":"INVALID_ARGUMENT"}}');
  assert.equal(r.outcome, "invalid_argument");
  assert.equal(r.ok, false);
});

test("status inesperado nunca vira sucesso silencioso", () => {
  const r = classifyCreateResponse(418, "chá");
  assert.equal(r.outcome, "error");
  assert.equal(r.ok, false);
  assert.match(r.action, /418/);
});

test("5xx orienta a retentar em vez de mandar caçar configuração (#4585)", () => {
  // Observado ao vivo: `:verify` num domínio já VERIFICADO devolveu 500
  // INTERNAL, e a chamada seguinte passou. Transitório do lado da Google.
  const r = classifyCreateResponse(500, '{"error":{"status":"INTERNAL"}}');
  assert.equal(r.outcome, "error");
  assert.equal(r.ok, false, "5xx nunca é sucesso");
  assert.match(r.action, /transitório/i);
  assert.match(r.action, /de novo/i);
});

test("action é sempre vazio no sucesso e sempre preenchido na falha", () => {
  const cases: Array<[number, string]> = [
    [200, "{}"],
    [409, '{"error":{"status":"ALREADY_EXISTS"}}'],
    [409, '{"error":{"status":"ABORTED"}}'],
    [401, "{}"],
    [403, '{"error":{"message":"SERVICE_DISABLED"}}'],
    [403, '{"error":{"message":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}}'],
    [403, "{}"],
    [400, "{}"],
    [500, "{}"],
  ];
  for (const [status, body] of cases) {
    const r = classifyCreateResponse(status, body);
    if (r.ok) assert.equal(r.action, "", `ok:true com ação preenchida (status=${status})`);
    else assert.notEqual(r.action, "", `ok:false sem ação de conserto (status=${status})`);
  }
});

test("registerDomain posta domainId no endpoint v2", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit = {};
  const fake = (async (url: string, init: RequestInit = {}) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response('{"name":"domains/diar.ia.br"}', { status: 200 });
  }) as unknown as typeof fetch;

  const r = await registerDomain(DEFAULT_DOMAIN, fake);
  assert.equal(r.ok, true);
  assert.equal(capturedUrl, `${POSTMASTER_V2_BASE}/domains`);
  assert.equal(capturedInit.method, "POST");
  assert.deepEqual(JSON.parse(String(capturedInit.body)), { domainId: DEFAULT_DOMAIN });
});

test("listDomains devolve estado de verificação, não só o nome (#4539)", async () => {
  // Registrado-mas-UNVERIFIED entrega ZERO dado — foi o caso do
  // diaria.beehiiv.com, registrado em 260116 e nunca verificado.
  const fake = ok200(
    JSON.stringify({
      domains: [
        { name: "domains/diar.ia.br", verificationState: "VERIFIED", permission: "OWNER" },
        { name: "domains/diaria.beehiiv.com", verificationState: "UNVERIFIED", permission: "NONE" },
        {},
      ],
    }),
  );
  assert.deepEqual(await listDomains(fake), [
    { domain: "diar.ia.br", verified: true, permission: "OWNER" },
    { domain: "diaria.beehiiv.com", verified: false, permission: "NONE" },
  ]);
});

test("listDomains falha alto e NUNCA devolve lista vazia em erro", async () => {
  const fake = (async () =>
    new Response('{"error":{"message":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}}', { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(() => listDomains(fake), /oauth-setup/);
});

test("erro de LEITURA nunca imprime vocabulário de create (#4585)", async () => {
  // classifyCreateResponse mapeia 409 → already_exists (ok:true). Threading
  // isso numa mensagem de falha produziria "falha ao listar (already_exists)".
  const fake = (async () => new Response('{"error":{"status":"ALREADY_EXISTS"}}', { status: 409 })) as unknown as typeof fetch;
  await assert.rejects(
    () => listDomains(fake),
    (e: Error) => {
      assert.match(e.message, /falha ao listar \(HTTP 409\)/);
      assert.doesNotMatch(e.message, /already_exists/);
      return true;
    },
  );
});

test("listDomains erra com contexto quando o 2xx não é JSON (#4585)", async () => {
  const fake = ok200("<html>proxy interceptou</html>");
  await assert.rejects(() => listDomains(fake), /não é JSON válido.*proxy interceptou/s);
});

test("getVerificationToken pede TXT e devolve o token", async () => {
  let capturedUrl = "";
  const fake = (async (url: string) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ token: "google-site-verification=abc123" }), { status: 200 });
  }) as unknown as typeof fetch;

  assert.equal(await getVerificationToken("diar.ia.br", fake), "google-site-verification=abc123");
  assert.match(capturedUrl, /\/domains\/diar\.ia\.br\/verificationToken\?verificationMethod=TXT$/);
});

test("getVerificationToken rejeita 2xx sem campo token", async () => {
  await assert.rejects(() => getVerificationToken("diar.ia.br", ok200('{"name":"x"}')), /sem campo "token"/);
});

test("verifyDomain chama :verify com verificationMethod TXT", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit = {};
  const fake = (async (url: string, init: RequestInit = {}) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const r = await verifyDomain("diar.ia.br", fake);
  assert.equal(r.ok, true);
  assert.match(capturedUrl, /\/domains\/diar\.ia\.br:verify$/);
  assert.equal(capturedInit.method, "POST");
  assert.deepEqual(JSON.parse(String(capturedInit.body)), { verificationMethod: "TXT" });
});

test("verifyDomain classifica falha com a ação certa", async () => {
  const fake = (async () =>
    new Response('{"error":{"message":"The caller does not have permission"}}', { status: 403 })) as unknown as typeof fetch;
  const r = await verifyDomain("diar.ia.br", fake);
  assert.equal(r.outcome, "forbidden");
  assert.equal(r.ok, false);
});

test("oauth-setup mantém postmaster.domain SOMADO ao postmaster.readonly (#4539)", () => {
  // Leitura de TEXTO de propósito: importar oauth-setup.ts executaria main()
  // (chamado incondicionalmente no fim do módulo) e abriria o fluxo OAuth.
  const src = readFileSync(resolve(import.meta.dirname, "..", "scripts", "oauth-setup.ts"), "utf8");
  assert.ok(
    src.includes('"https://www.googleapis.com/auth/postmaster.readonly"'),
    "postmaster.readonly sumiu — o sync diário de spamRate (breaker da Rampa) depende dele",
  );
  assert.ok(
    src.includes('"https://www.googleapis.com/auth/postmaster.domain"'),
    "postmaster.domain sumiu — create/verify da v2 param de funcionar",
  );
});

test("oauth-setup soma postmaster.traffic.readonly — 3º eixo, não substitui os outros dois (#4704)", () => {
  // Mesma disciplina de leitura de TEXTO do teste acima (importar dispara main()).
  const src = readFileSync(resolve(import.meta.dirname, "..", "scripts", "oauth-setup.ts"), "utf8");
  assert.ok(
    src.includes('"https://www.googleapis.com/auth/postmaster.traffic.readonly"'),
    "postmaster.traffic.readonly sumiu — domainStats.query da v2 (spam por campanha) dá 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT sem ele",
  );
  // As 3 permissões precisam coexistir — nenhuma é superset das outras
  // (verificado ao vivo em 260806, ver comentário em oauth-setup.ts).
  assert.ok(src.includes('"https://www.googleapis.com/auth/postmaster.readonly"'));
  assert.ok(src.includes('"https://www.googleapis.com/auth/postmaster.domain"'));
});
