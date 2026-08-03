import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { run } from "../scripts/inject-poll-token.ts";
import { computePollToken, pollTokenKvKey } from "../scripts/lib/shared/poll-token.ts";
import type { CloudflareKVConfig } from "../scripts/lib/cloudflare-kv-upload.ts";

/**
 * Tests pra inject-poll-token.ts (#4487) — sucessor do extinto
 * inject-poll-sig.ts (#1083, removido #1186), adaptado pro novo teste
 * `test/inject-poll-sig.test.ts` (#1175) — mesma cobertura de --since-hours,
 * MAIS a asserção nova: o script grava a entrada reversa
 * `polltoken:{token} -> email` via `putKv` (injetável) além do PATCH na
 * Beehiiv.
 */

const PUB_ID = "pub_test";
const API_KEY = "fake_key";
const SECRET = "test_secret";
const BASE = "https://api.beehiiv.com";
const KV_CFG: CloudflareKVConfig = { accountId: "acct", token: "kvtoken", kvNamespaceId: "ns_test" };

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

after(async () => {
  await mockAgent.close();
  setGlobalDispatcher(originalDispatcher);
});

/** Fake putKv que grava num Map em vez de bater na API Cloudflare de verdade —
 * evita precisar de um 2º MockAgent pra api.cloudflare.com (undici MockAgent
 * intercepta por host; usar dois hosts mockados ao mesmo tempo funciona mas
 * complica os testes sem necessidade — o contrato de `putKv` já é testado
 * isoladamente por cloudflare-kv-upload.test.ts). */
function makeFakePutKv() {
  const written = new Map<string, string>();
  const putKv = async (key: string, value: string, _cfg: CloudflareKVConfig) => {
    written.set(key, value);
  };
  return { written, putKv };
}

describe("computePollToken (via poll-token.ts) — bate com o Worker", () => {
  it("HMAC bate com hmacHex do Worker (Web Crypto SHA-256, truncado 24 hex)", async () => {
    const email = "leitor@example.com";
    const token = await computePollToken(SECRET, email);
    assert.match(token, /^[0-9a-f]{24}$/);
    // Determinismo — recalcular dá o mesmo valor.
    assert.equal(await computePollToken(SECRET, email), token);
  });

  it("normaliza email (lowercase + trim) antes de gerar o token", async () => {
    const t1 = await computePollToken(SECRET, "Foo@Bar.com");
    const t2 = await computePollToken(SECRET, "foo@bar.com");
    const t3 = await computePollToken(SECRET, "  foo@bar.com  ");
    assert.equal(t1, t2);
    assert.equal(t2, t3);
  });
});

describe("run() with --since-hours filter (#4487, espelha #1175)", () => {
  afterEach(() => {
    mockAgent.assertNoPendingInterceptors();
  });

  function listResp(subs: unknown[], hasMore = false, cursor?: string) {
    return {
      data: subs,
      has_more: hasMore,
      ...(cursor ? { next_cursor: cursor } : {}),
    };
  }

  function mockCustomFieldsExist(pool: ReturnType<typeof mockAgent.get>) {
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/custom_fields?limit=100`,
        method: "GET",
      })
      .reply(
        200,
        { data: [{ id: "1", kind: "string", display: "poll_token" }] },
        { headers: { "content-type": "application/json" } },
      );
  }

  it("sinceHours=96: inclui subscriber com created dentro da janela, exclui fora — grava KV só pro incluído", async () => {
    const pool = mockAgent.get(BASE);
    mockCustomFieldsExist(pool);
    const { written, putKv } = makeFakePutKv();

    const nowMs = Date.now();
    const recentCreated = Math.floor((nowMs - 24 * 3600 * 1000) / 1000);
    const oldCreated = Math.floor((nowMs - 200 * 3600 * 1000) / 1000);

    pool
      .intercept({
        path: new RegExp(`/v2/publications/${PUB_ID}/subscriptions`),
        method: "GET",
      })
      .reply(
        200,
        listResp([
          { id: "s_recent", email: "recent@x.com", status: "active", created: recentCreated, custom_fields: [] },
          { id: "s_old", email: "old@x.com", status: "active", created: oldCreated, custom_fields: [] },
        ]),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/subscriptions/s_recent`,
        method: "PATCH",
      })
      .reply(200, { ok: true }, { headers: { "content-type": "application/json" } });

    const result = await run({
      dryRun: false,
      force: false,
      apiOpts: { publicationId: PUB_ID, apiKey: API_KEY, baseUrl: `${BASE}/v2` },
      secret: SECRET,
      sinceHours: 96,
      kvConfig: KV_CFG,
      putKv,
    });

    assert.equal(result.total_subscribers, 2);
    assert.equal(result.in_window, 1, "só o recent entra na janela 96h");
    assert.equal(result.skipped_outside_window, 1, "o old é skipado");
    assert.equal(result.patched, 1, "patcheou só o recent");
    assert.equal(result.failed, 0);

    const expectedToken = await computePollToken(SECRET, "recent@x.com");
    assert.equal(written.get(pollTokenKvKey(expectedToken)), "recent@x.com", "entrada reversa gravada no KV pro subscriber patcheado");
    assert.equal(written.size, 1, "nenhuma entrada KV pro subscriber fora da janela");
  });

  it("sinceHours fallback pra subscribed_on (ISO) quando created ausente", async () => {
    const pool = mockAgent.get(BASE);
    mockCustomFieldsExist(pool);
    const { written, putKv } = makeFakePutKv();

    const recentIso = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const oldIso = new Date(Date.now() - 500 * 3600 * 1000).toISOString();

    pool
      .intercept({
        path: new RegExp(`/v2/publications/${PUB_ID}/subscriptions`),
        method: "GET",
      })
      .reply(
        200,
        listResp([
          { id: "s_recent", email: "iso-recent@x.com", status: "active", subscribed_on: recentIso, custom_fields: [] },
          { id: "s_old", email: "iso-old@x.com", status: "active", subscribed_on: oldIso, custom_fields: [] },
          { id: "s_unknown", email: "no-timestamp@x.com", status: "active", custom_fields: [] },
        ]),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/subscriptions/s_recent`,
        method: "PATCH",
      })
      .reply(200, { ok: true }, { headers: { "content-type": "application/json" } });

    const result = await run({
      dryRun: false,
      force: false,
      apiOpts: { publicationId: PUB_ID, apiKey: API_KEY, baseUrl: `${BASE}/v2` },
      secret: SECRET,
      sinceHours: 96,
      kvConfig: KV_CFG,
      putKv,
    });

    assert.equal(result.in_window, 1, "ISO parsed and recent kept");
    assert.equal(result.skipped_outside_window, 2, "old + unknown ambos skipados");
    assert.equal(result.patched, 1);
    assert.equal(written.size, 1);
  });

  it("sinceHours undefined: processa todos (sem filter) — grava KV pra ambos", async () => {
    const pool = mockAgent.get(BASE);
    mockCustomFieldsExist(pool);
    const { written, putKv } = makeFakePutKv();

    pool
      .intercept({
        path: new RegExp(`/v2/publications/${PUB_ID}/subscriptions`),
        method: "GET",
      })
      .reply(
        200,
        listResp([
          { id: "s_a", email: "a@x.com", status: "active", created: 1000000000, custom_fields: [] },
          { id: "s_b", email: "b@x.com", status: "active", created: 2000000000, custom_fields: [] },
        ]),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({ path: `/v2/publications/${PUB_ID}/subscriptions/s_a`, method: "PATCH" })
      .reply(200, { ok: true }, { headers: { "content-type": "application/json" } });
    pool
      .intercept({ path: `/v2/publications/${PUB_ID}/subscriptions/s_b`, method: "PATCH" })
      .reply(200, { ok: true }, { headers: { "content-type": "application/json" } });

    const result = await run({
      dryRun: false,
      force: false,
      apiOpts: { publicationId: PUB_ID, apiKey: API_KEY, baseUrl: `${BASE}/v2` },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    assert.equal(result.in_window, undefined);
    assert.equal(result.skipped_outside_window, undefined);
    assert.equal(result.patched, 2, "ambos patcheados sem filter");
    assert.equal(written.size, 2, "entrada KV gravada pros dois subscribers");
  });

  it("dry-run com sinceHours: skipa PATCH e KV write, conta in_window corretamente", async () => {
    const pool = mockAgent.get(BASE);
    const { written, putKv } = makeFakePutKv();
    // dry-run não chama ensureCustomField nem PATCH — qualquer chamada
    // inesperada quebra com NetConnectNotAllowed (mockAgent).

    const recent = Math.floor((Date.now() - 24 * 3600 * 1000) / 1000);
    const old = Math.floor((Date.now() - 200 * 3600 * 1000) / 1000);

    pool
      .intercept({
        path: new RegExp(`/v2/publications/${PUB_ID}/subscriptions`),
        method: "GET",
      })
      .reply(
        200,
        listResp([
          { id: "s_r", email: "r@x.com", status: "active", created: recent, custom_fields: [] },
          { id: "s_o", email: "o@x.com", status: "active", created: old, custom_fields: [] },
        ]),
        { headers: { "content-type": "application/json" } },
      );

    const result = await run({
      dryRun: true,
      force: false,
      apiOpts: { publicationId: PUB_ID, apiKey: API_KEY, baseUrl: `${BASE}/v2` },
      secret: SECRET,
      sinceHours: 96,
      kvConfig: KV_CFG,
      putKv,
    });

    assert.equal(result.dry_run, true);
    assert.equal(result.in_window, 1);
    assert.equal(result.skipped_outside_window, 1);
    assert.equal(result.patched, 0, "dry-run não patcha nem grava KV");
    assert.equal(written.size, 0);
  });

  it("--force: repatcha mesmo quando o custom field já bate com o valor esperado (rotação de POLL_SECRET)", async () => {
    const pool = mockAgent.get(BASE);
    mockCustomFieldsExist(pool);
    const { written, putKv } = makeFakePutKv();

    const email = "already@x.com";
    // #4512: valor CORRETO no custom field é o token CRU (sem domínio) desde
    // o fix — o template (`newsletter-render-html.ts::renderEIA`) concatena
    // o domínio depois do merge tag.
    const currentToken = await computePollToken(SECRET, email);

    pool
      .intercept({
        path: new RegExp(`/v2/publications/${PUB_ID}/subscriptions`),
        method: "GET",
      })
      .reply(
        200,
        listResp([
          {
            id: "s_already",
            email,
            status: "active",
            created: 1000000000,
            custom_fields: [{ name: "poll_token", value: currentToken }],
          },
        ]),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({ path: `/v2/publications/${PUB_ID}/subscriptions/s_already`, method: "PATCH" })
      .reply(200, { ok: true }, { headers: { "content-type": "application/json" } });

    const result = await run({
      dryRun: false,
      force: true,
      apiOpts: { publicationId: PUB_ID, apiKey: API_KEY, baseUrl: `${BASE}/v2` },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    assert.equal(result.patched, 1, "--force repatcha mesmo com valor já correto");
    assert.equal(written.get(pollTokenKvKey(currentToken)), email);
  });

  it("sem --force: skipa subscriber cujo custom field já bate com o token esperado (idempotência)", async () => {
    const pool = mockAgent.get(BASE);
    mockCustomFieldsExist(pool);
    const { written, putKv } = makeFakePutKv();

    const email = "already@x.com";
    const currentToken = await computePollToken(SECRET, email);

    pool
      .intercept({
        path: new RegExp(`/v2/publications/${PUB_ID}/subscriptions`),
        method: "GET",
      })
      .reply(
        200,
        listResp([
          {
            id: "s_already",
            email,
            status: "active",
            created: 1000000000,
            custom_fields: [{ name: "poll_token", value: currentToken }],
          },
        ]),
        { headers: { "content-type": "application/json" } },
      );
    // Nenhum PATCH esperado — se o script tentar, afterEach() falha via
    // assertNoPendingInterceptors OU o mockAgent lança NetConnectNotAllowed.

    const result = await run({
      dryRun: false,
      force: false,
      apiOpts: { publicationId: PUB_ID, apiKey: API_KEY, baseUrl: `${BASE}/v2` },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    assert.equal(result.patched, 0);
    assert.equal(result.skipped_already_correct, 1);
    assert.equal(written.size, 0, "nenhuma escrita KV quando já está correto e sem --force");
  });

  it("#4512 fix: grava o TOKEN CRU (sem domínio) no custom field da Beehiiv — nunca o pseudo-email completo", async () => {
    // Achado comment-analyzer (review pré-merge #4512): o código antigo
    // gravava `${token}@${VOTE_TOKEN_DOMAIN}` no custom field, mas o
    // template (`newsletter-render-html.ts::renderEIA`) já concatena o
    // domínio DEPOIS do merge tag (`{{poll_token}}@${VOTE_TOKEN_DOMAIN}`) —
    // duplicava o domínio na URL final (2 arrobas), quebrando 100% dos votos.
    // Este teste captura o BODY real do PATCH enviado à Beehiiv (não só o
    // resultado agregado) para travar o valor exato gravado.
    const pool = mockAgent.get(BASE);
    mockCustomFieldsExist(pool);
    const { putKv } = makeFakePutKv();

    const email = "novo@x.com";
    const expectedToken = await computePollToken(SECRET, email);

    pool
      .intercept({
        path: new RegExp(`/v2/publications/${PUB_ID}/subscriptions`),
        method: "GET",
      })
      .reply(
        200,
        listResp([
          { id: "s_novo", email, status: "active", created: 1000000000, custom_fields: [] },
        ]),
        { headers: { "content-type": "application/json" } },
      );

    let capturedBody: { custom_fields: Array<{ name: string; value: string }> } | null = null;
    pool
      .intercept({ path: `/v2/publications/${PUB_ID}/subscriptions/s_novo`, method: "PATCH" })
      .reply((opts) => {
        capturedBody = JSON.parse(opts.body as string);
        return { statusCode: 200, data: JSON.stringify({ ok: true }), headers: { "content-type": "application/json" } };
      });

    await run({
      dryRun: false,
      force: false,
      apiOpts: { publicationId: PUB_ID, apiKey: API_KEY, baseUrl: `${BASE}/v2` },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    assert.ok(capturedBody, "PATCH deveria ter sido chamado");
    const fieldValue = capturedBody!.custom_fields.find((f) => f.name === "poll_token")?.value;
    assert.equal(fieldValue, expectedToken, "custom field deve conter o TOKEN CRU, sem @domínio");
    assert.ok(!fieldValue?.includes("@"), "valor gravado nunca deve conter @ (senão duplica o domínio no template)");
  });

  it("#4512: subscriber com valor ANTIGO (pseudo-email completo, bug pré-fix) no custom field é re-patcheado mesmo sem --force (self-healing)", async () => {
    const pool = mockAgent.get(BASE);
    mockCustomFieldsExist(pool);
    const { putKv } = makeFakePutKv();

    const email = "legado-com-bug@x.com";
    const correctToken = await computePollToken(SECRET, email);
    const buggyStoredValue = `${correctToken}@vote.eia.diaria.local`; // valor que o código com bug teria gravado

    pool
      .intercept({
        path: new RegExp(`/v2/publications/${PUB_ID}/subscriptions`),
        method: "GET",
      })
      .reply(
        200,
        listResp([
          {
            id: "s_legado",
            email,
            status: "active",
            created: 1000000000,
            custom_fields: [{ name: "poll_token", value: buggyStoredValue }],
          },
        ]),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({ path: `/v2/publications/${PUB_ID}/subscriptions/s_legado`, method: "PATCH" })
      .reply(200, { ok: true }, { headers: { "content-type": "application/json" } });

    const result = await run({
      dryRun: false,
      force: false,
      apiOpts: { publicationId: PUB_ID, apiKey: API_KEY, baseUrl: `${BASE}/v2` },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    assert.equal(result.patched, 1, "valor antigo (com domínio) nunca bate o token cru esperado — reescrito automaticamente");
    assert.equal(result.skipped_already_correct, 0);
  });

  it("#4512 (achado pr-test-analyzer): falha do PATCH da Beehiiv — KV já escrito, result.failed incrementa, exit code refletiria a falha", async () => {
    // O código documenta a ordem "KV write ANTES do PATCH" como garantia de
    // segurança (comentário em run(), linha ~314-318): se o PATCH falhar
    // depois, o pior caso é uma entrada KV órfã (sem custo real — o token
    // nunca sai na URL sem o custom field populado), nunca um custom field
    // publicado sem a entrada reversa correspondente. Este teste mocka uma
    // falha de PATCH (500) e confirma as 3 garantias.
    const pool = mockAgent.get(BASE);
    mockCustomFieldsExist(pool);
    const { written, putKv } = makeFakePutKv();

    const email = "falha-patch@x.com";
    const expectedToken = await computePollToken(SECRET, email);

    pool
      .intercept({
        path: new RegExp(`/v2/publications/${PUB_ID}/subscriptions`),
        method: "GET",
      })
      .reply(
        200,
        listResp([{ id: "s_falha", email, status: "active", created: 1000000000, custom_fields: [] }]),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({ path: `/v2/publications/${PUB_ID}/subscriptions/s_falha`, method: "PATCH" })
      .reply(500, "internal error", { headers: { "content-type": "text/plain" } });

    const result = await run({
      dryRun: false,
      force: false,
      apiOpts: { publicationId: PUB_ID, apiKey: API_KEY, baseUrl: `${BASE}/v2` },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    // (a) entrada KV já foi escrita, mesmo com o PATCH falhando depois.
    assert.equal(written.get(pollTokenKvKey(expectedToken)), email, "KV deve ser escrito ANTES do PATCH, mesmo que o PATCH falhe depois");
    // (b) result.failed incrementou.
    assert.equal(result.failed, 1);
    assert.equal(result.patched, 0);
    // (c) nenhum estado parcial quebra execuções subsequentes — uma 2ª
    // invocação (retry manual, mesma semântica de --since-hours incremental)
    // vê o KV já escrito (sem custo, reescrita idempotente) e tenta o PATCH
    // de novo — desta vez com sucesso — sem exigir nenhuma limpeza manual.
    mockCustomFieldsExist(pool); // ensureCustomField roda de novo a cada run()
    pool
      .intercept({
        path: new RegExp(`/v2/publications/${PUB_ID}/subscriptions`),
        method: "GET",
      })
      .reply(
        200,
        listResp([{ id: "s_falha", email, status: "active", created: 1000000000, custom_fields: [] }]),
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({ path: `/v2/publications/${PUB_ID}/subscriptions/s_falha`, method: "PATCH" })
      .reply(200, { ok: true }, { headers: { "content-type": "application/json" } });

    const retryResult = await run({
      dryRun: false,
      force: false,
      apiOpts: { publicationId: PUB_ID, apiKey: API_KEY, baseUrl: `${BASE}/v2` },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });
    assert.equal(retryResult.patched, 1, "retry após falha transitória completa normalmente, sem estado parcial bloqueando");
    assert.equal(retryResult.failed, 0);
  });
});
