import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { generatePollSig, run } from "../scripts/inject-poll-sig.ts";

/**
 * Tests pra inject-poll-sig.ts (#1083) — foca no filtro --since-hours (#1175).
 *
 * Cobertura:
 *   - HMAC reproduz exatamente o que o Worker valida (sig = HMAC(secret, email))
 *   - --since-hours filtra client-side por `created` (Unix segundos) ou
 *     `subscribed_on` (ISO 8601), descartando subscribers antigos
 *   - Sem --since-hours, processa todos os subscribers
 *   - in_window / skipped_outside_window vêm corretos no result
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

describe("generatePollSig HMAC", () => {
  it("HMAC bate com hmacSign do Worker (Web Crypto SHA-256 hex)", async () => {
    async function workerSign(secret: string, message: string): Promise<string> {
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
    const expected = await workerSign(SECRET, email);
    const actual = generatePollSig(email, SECRET);
    assert.equal(actual, expected, "Node HMAC bate com Worker Web Crypto");
  });

  it("normaliza email (lowercase + trim) antes de assinar", () => {
    const s1 = generatePollSig("Foo@Bar.com", SECRET);
    const s2 = generatePollSig("foo@bar.com", SECRET);
    const s3 = generatePollSig("  foo@bar.com  ", SECRET);
    assert.equal(s1, s2);
    assert.equal(s2, s3);
  });
});

describe("run() with --since-hours filter (#1175)", () => {
  /** Helper pra montar response de lista de subscribers. */
  function listResp(subs: unknown[], hasMore = false, cursor?: string) {
    return {
      data: subs,
      has_more: hasMore,
      ...(cursor ? { next_cursor: cursor } : {}),
    };
  }

  /** Mock custom_fields lookup pra ensureCustomField (skipa criação se já existe). */
  function mockCustomFieldsExist(pool: ReturnType<typeof mockAgent.get>) {
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/custom_fields?limit=100`,
        method: "GET",
      })
      .reply(
        200,
        { data: [{ id: "1", kind: "string", display: "poll_sig" }] },
        { headers: { "content-type": "application/json" } },
      );
  }

  it("sinceHours=96: inclui subscriber com created dentro da janela, exclui fora", async () => {
    const pool = mockAgent.get(BASE);
    mockCustomFieldsExist(pool);

    const nowMs = Date.now();
    const recentCreated = Math.floor((nowMs - 24 * 3600 * 1000) / 1000); // 1d atrás
    const oldCreated = Math.floor((nowMs - 200 * 3600 * 1000) / 1000); // 8d atrás

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

    // PATCH só pro recent (old é skipado por window).
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
    });

    assert.equal(result.total_subscribers, 2);
    assert.equal(result.in_window, 1, "só o recent entra na janela 96h");
    assert.equal(result.skipped_outside_window, 1, "o old é skipado");
    assert.equal(result.patched, 1, "patcheou só o recent");
    assert.equal(result.failed, 0);
  });

  it("sinceHours fallback pra subscribed_on (ISO) quando created ausente", async () => {
    const pool = mockAgent.get(BASE);
    mockCustomFieldsExist(pool);

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
    });

    assert.equal(result.in_window, 1, "ISO parsed and recent kept");
    assert.equal(result.skipped_outside_window, 2, "old + unknown ambos skipados");
    assert.equal(result.patched, 1);
  });

  it("sinceHours undefined: processa todos (sem filter)", async () => {
    const pool = mockAgent.get(BASE);
    mockCustomFieldsExist(pool);

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
      .intercept({
        path: `/v2/publications/${PUB_ID}/subscriptions/s_a`,
        method: "PATCH",
      })
      .reply(200, { ok: true }, { headers: { "content-type": "application/json" } });
    pool
      .intercept({
        path: `/v2/publications/${PUB_ID}/subscriptions/s_b`,
        method: "PATCH",
      })
      .reply(200, { ok: true }, { headers: { "content-type": "application/json" } });

    const result = await run({
      dryRun: false,
      force: false,
      apiOpts: { publicationId: PUB_ID, apiKey: API_KEY, baseUrl: `${BASE}/v2` },
      secret: SECRET,
    });

    assert.equal(result.in_window, undefined, "in_window só preenchido quando sinceHours definido");
    assert.equal(result.skipped_outside_window, undefined);
    assert.equal(result.patched, 2, "ambos patcheados sem filter");
  });

  it("dry-run com sinceHours: skipa PATCH, conta in_window corretamente", async () => {
    const pool = mockAgent.get(BASE);
    // dry-run não chama ensureCustomField, mas como nem assim configuramos PATCH,
    // qualquer PATCH inesperado quebra com NetConnectNotAllowed.

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
    });

    assert.equal(result.dry_run, true);
    assert.equal(result.in_window, 1);
    assert.equal(result.skipped_outside_window, 1);
    assert.equal(result.patched, 0, "dry-run não patcha");
  });
});
