import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  type Dispatcher,
} from "undici";
import {
  generatePollUrl,
  ensureCustomFields,
  patchSubscriberPollUrls,
  run,
} from "../scripts/inject-poll-urls.ts";

/**
 * Tests pra inject-poll-urls.ts (#1044).
 *
 * Cobertura:
 *   - HMAC reproduz exatamente o mesmo valor que o Worker valida (workers/poll/src/index.ts hmacSign)
 *   - ensureCustomFields é idempotente (não recria se existem)
 *   - patchSubscriberPollUrls envia body com formato esperado pela API
 *   - run() agrega corretamente: page count, fail per subscriber não trava batch
 *   - dry-run não chama PATCH
 */

const PUB_ID = "pub_test";
const API_KEY = "fake_key";
const SECRET = "test_secret";
const BASE = "https://api.beehiiv.com";

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

describe("generatePollUrl HMAC", () => {
  it("normaliza email (lowercase + trim) antes de assinar", () => {
    const u1 = generatePollUrl("Foo@Bar.com", "260510", "A", SECRET);
    const u2 = generatePollUrl("foo@bar.com", "260510", "A", SECRET);
    const u3 = generatePollUrl("  foo@bar.com  ", "260510", "A", SECRET);

    const sig1 = new URL(u1).searchParams.get("sig");
    const sig2 = new URL(u2).searchParams.get("sig");
    const sig3 = new URL(u3).searchParams.get("sig");

    assert.equal(sig1, sig2, "case insensitive");
    assert.equal(sig2, sig3, "trim whitespace");
  });

  it("HMAC bate com hmacSign do Worker (Web Crypto SHA-256 hex)", async () => {
    // Replica exatamente o algoritmo do worker (workers/poll/src/index.ts:31-38)
    async function workerSign(
      secret: string,
      message: string,
    ): Promise<string> {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
      return Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }

    const email = "leitor@example.com";
    const edition = "260510";
    const choice = "A";
    const expected = await workerSign(SECRET, `${email}:${edition}`);

    const url = generatePollUrl(email, edition, choice, SECRET);
    const actual = new URL(url).searchParams.get("sig");
    assert.equal(actual, expected, "HMAC do Node bate com Web Crypto do Worker");
  });

  it("URL contém todos os params requeridos pelo Worker", () => {
    const url = generatePollUrl("test@example.com", "260510", "B", SECRET);
    const u = new URL(url);
    assert.equal(u.searchParams.get("email"), "test@example.com");
    assert.equal(u.searchParams.get("edition"), "260510");
    assert.equal(u.searchParams.get("choice"), "B");
    assert.ok(u.searchParams.get("sig"));
    assert.ok(u.pathname.endsWith("/vote"));
  });

  it("choice A e B produzem URLs com sig idêntico (sig não inclui choice)", () => {
    // Decisão arquitetural: HMAC cobre (email, edition) — choice é parâmetro
    // independente. Isso permite leitor mudar de ideia A↔B sem regenerar URL.
    const a = generatePollUrl("u@x.com", "260510", "A", SECRET);
    const b = generatePollUrl("u@x.com", "260510", "B", SECRET);
    assert.equal(
      new URL(a).searchParams.get("sig"),
      new URL(b).searchParams.get("sig"),
      "sig é o mesmo entre A e B",
    );
  });
});

describe("ensureCustomFields", () => {
  it("não cria se ambos campos já existem", async () => {
    const pool = mockAgent.get(BASE);
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/custom_fields?limit=100`,
        method: "GET",
      })
      .reply(
        200,
        {
          data: [
            { id: "1", kind: "string", display: "poll_a_url" },
            { id: "2", kind: "string", display: "poll_b_url" },
            { id: "3", kind: "string", display: "outra_coisa" },
          ],
        },
        { headers: { "content-type": "application/json" } },
      );

    await ensureCustomFields({ publicationId: PUB_ID, apiKey: API_KEY });
    // Se POST tivesse sido chamado, mockAgent.assertNoPendingInterceptors
    // dispararia (não há intercept pra POST). Como não setamos, qualquer
    // POST quebra com NetConnectNotAllowed.
  });

  it("pagina via cursor pra cobrir publications com >100 custom fields", async () => {
    const pool = mockAgent.get(BASE);
    // Page 1: poll_a_url presente, poll_b_url ainda não — has_more=true
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/custom_fields?limit=100`,
        method: "GET",
      })
      .reply(
        200,
        {
          data: [
            { id: "1", kind: "string", display: "outra_coisa" },
            { id: "2", kind: "string", display: "poll_a_url" },
          ],
          has_more: true,
          next_cursor: "page2_token",
        },
        { headers: { "content-type": "application/json" } },
      );
    // Page 2: poll_b_url presente
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/custom_fields?limit=100&cursor=page2_token`,
        method: "GET",
      })
      .reply(
        200,
        {
          data: [{ id: "3", kind: "string", display: "poll_b_url" }],
          has_more: false,
        },
        { headers: { "content-type": "application/json" } },
      );

    // Não deve criar nenhum field (ambos existem em páginas distintas).
    // Se POST disparar, MockAgent rejeita com NetConnectNotAllowed.
    await ensureCustomFields({ publicationId: PUB_ID, apiKey: API_KEY });
  });

  it("cria os 2 campos se nenhum existe", async () => {
    const pool = mockAgent.get(BASE);
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/custom_fields?limit=100`,
        method: "GET",
      })
      .reply(
        200,
        { data: [] },
        { headers: { "content-type": "application/json" } },
      );

    let createdA = false;
    let createdB = false;
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/custom_fields`,
        method: "POST",
      })
      .reply(
        200,
        (opts) => {
          const body = JSON.parse(opts.body as string);
          if (body.display === "poll_a_url") createdA = true;
          if (body.display === "poll_b_url") createdB = true;
          return { id: "new", kind: "string", display: body.display };
        },
        { headers: { "content-type": "application/json" } },
      )
      .times(2);

    await ensureCustomFields({ publicationId: PUB_ID, apiKey: API_KEY });
    assert.equal(createdA, true, "criou poll_a_url");
    assert.equal(createdB, true, "criou poll_b_url");
  });
});

describe("patchSubscriberPollUrls", () => {
  it("envia PATCH com 2 custom_fields contendo URLs HMAC", async () => {
    const pool = mockAgent.get(BASE);
    let receivedBody: { custom_fields?: Array<{ name: string; value: string }> } =
      {};
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/subscriptions/sub_xyz`,
        method: "PATCH",
      })
      .reply(
        200,
        (opts) => {
          receivedBody = JSON.parse(opts.body as string);
          return { data: { id: "sub_xyz" } };
        },
        { headers: { "content-type": "application/json" } },
      );

    await patchSubscriberPollUrls(
      "sub_xyz",
      "leitor@example.com",
      "260510",
      SECRET,
      { publicationId: PUB_ID, apiKey: API_KEY },
    );

    assert.equal(receivedBody.custom_fields?.length, 2);
    assert.equal(receivedBody.custom_fields?.[0].name, "poll_a_url");
    assert.equal(receivedBody.custom_fields?.[1].name, "poll_b_url");
    assert.match(receivedBody.custom_fields![0].value, /choice=A/);
    assert.match(receivedBody.custom_fields![1].value, /choice=B/);
    assert.match(receivedBody.custom_fields![0].value, /sig=[a-f0-9]{64}/);
  });
});

describe("run() — batch end-to-end", () => {
  it("processa todas páginas e contabiliza ok+failed sem travar", async () => {
    const pool = mockAgent.get(BASE);

    // ensure custom fields: ambos existem
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/custom_fields?limit=100`,
        method: "GET",
      })
      .reply(
        200,
        {
          data: [
            { id: "1", kind: "string", display: "poll_a_url" },
            { id: "2", kind: "string", display: "poll_b_url" },
          ],
        },
        { headers: { "content-type": "application/json" } },
      );

    // 2 páginas de subscribers
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/subscriptions?status=active&limit=100`,
        method: "GET",
      })
      .reply(
        200,
        {
          data: [
            { id: "sub_1", email: "a@x.com", status: "active" },
            { id: "sub_2", email: "b@x.com", status: "active" },
            { id: "sub_3", email: "", status: "active" }, // skipped no email
          ],
          has_more: true,
          next_cursor: "page2",
        },
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/subscriptions?status=active&limit=100&cursor=page2`,
        method: "GET",
      })
      .reply(
        200,
        {
          data: [{ id: "sub_4", email: "c@x.com", status: "active" }],
          has_more: false,
        },
        { headers: { "content-type": "application/json" } },
      );

    // PATCH calls: sub_1 ok, sub_2 ok, sub_4 fails
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/subscriptions/sub_1`,
        method: "PATCH",
      })
      .reply(
        200,
        { data: { id: "sub_1" } },
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/subscriptions/sub_2`,
        method: "PATCH",
      })
      .reply(
        200,
        { data: { id: "sub_2" } },
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/subscriptions/sub_4`,
        method: "PATCH",
      })
      .reply(
        429,
        { error: "rate limited" },
        { headers: { "content-type": "application/json" } },
      );

    const result = await run({
      edition: "260510",
      dryRun: false,
      apiOpts: { publicationId: PUB_ID, apiKey: API_KEY },
      secret: SECRET,
    });

    assert.equal(result.total_subscribers, 4);
    assert.equal(result.patched, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped_no_email, 1);
    assert.equal(result.dry_run, false);
  });

  it("dry-run não chama PATCH nem ensureCustomFields", async () => {
    const pool = mockAgent.get(BASE);

    // SOMENTE GET subscriptions intercept — se PATCH ou GET custom_fields rolar, MockAgent disconnect
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/subscriptions?status=active&limit=100`,
        method: "GET",
      })
      .reply(
        200,
        {
          data: [{ id: "sub_x", email: "x@x.com", status: "active" }],
          has_more: false,
        },
        { headers: { "content-type": "application/json" } },
      );

    const result = await run({
      edition: "260510",
      dryRun: true,
      apiOpts: { publicationId: PUB_ID, apiKey: API_KEY },
      secret: SECRET,
    });

    assert.equal(result.dry_run, true);
    assert.equal(result.total_subscribers, 1);
    assert.equal(result.patched, 0); // dry-run não patcheia
  });
});
