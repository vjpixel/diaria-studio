/**
 * test/purge-leaderboard-kv-backend-11253.test.ts
 *
 * BUG (#11253): `purge-leaderboard.ts` só falava com o KV do POLL pelo
 * wrangler com login OAuth. No servidor `300` não há `wrangler login` (precisa
 * de navegador), então a purga automática do Stage 6 (§6h) falhava toda vez e
 * os votos do editor ficavam no leaderboard público — o `CLOUDFLARE_API_TOKEN`
 * do `.env`, que hoje lê e grava no namespace, era descartado de propósito
 * (#2265).
 *
 * Cobre:
 *   - `createKvRestOps` (API REST do KV) com fetch injetado: list paginado por
 *     cursor, get 404 → null, delete 404 → ok, erros que não vazam o token;
 *   - `resolvePurgeKvBackend`: wrangler logado continua wrangler (Neo), sem
 *     login + token vira REST (300), sem nenhum dos dois falha com motivo;
 *   - regressão do cenário do 300 ponta a ponta: sem login OAuth e com token,
 *     o backend escolhido monta o plano de purga sem lançar.
 * Nenhum teste fala com a Cloudflare real nem roda o wrangler.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createKvRestOps, type KvFetch } from "../scripts/lib/cloudflare-kv-rest.ts";
import { parseKvBackendOverride, resolvePurgeKvBackend } from "../scripts/lib/purge-kv-backend.ts";
import { buildPurgePlan } from "../scripts/lib/purge-leaderboard-plan.ts";

const ACCOUNT = "acc123";
const NS = "72784da4ae39444481eb422ebac357c6";
const TOKEN = "secret-token-abc";

interface Call { url: string; method: string; auth: string | null; body: string | null }

/** KV falso servido por "API REST": pagina `keys` em páginas de `pageSize`
 * (ignora o `limit` pedido, pra forçar várias páginas com poucas chaves). */
function fakeKvFetch(store: Map<string, string>, opts: { pageSize?: number; status?: number } = {}) {
  const calls: Call[] = [];
  const pageSize = opts.pageSize ?? 2;
  const fetchFn: KvFetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, auth: headers.Authorization ?? null, body: (init?.body as string) ?? null });
    if (opts.status) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), {
        status: opts.status,
      });
    }
    const u = new URL(url);
    const base = `/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NS}`;
    assert.ok(u.pathname.startsWith(base), `path inesperado: ${u.pathname}`);
    const rest = u.pathname.slice(base.length);
    if (rest === "/keys") {
      const prefix = u.searchParams.get("prefix") ?? "";
      const start = Number(u.searchParams.get("cursor") ?? "0");
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const page = all.slice(start, start + pageSize);
      const next = start + pageSize < all.length ? String(start + pageSize) : "";
      return Response.json({ success: true, result: page.map((name) => ({ name })), result_info: { cursor: next, count: page.length } });
    }
    const key = decodeURIComponent(rest.replace(/^\/values\//, ""));
    if (method === "GET") {
      return store.has(key) ? new Response(store.get(key)!) : new Response("not found", { status: 404 });
    }
    if (method === "PUT") {
      store.set(key, String(init?.body ?? ""));
      return Response.json({ success: true });
    }
    if (method === "DELETE") {
      if (!store.has(key)) return new Response(JSON.stringify({ success: false }), { status: 404 });
      store.delete(key);
      return Response.json({ success: true });
    }
    throw new Error(`método inesperado ${method}`);
  };
  return { fetchFn, calls };
}

describe("createKvRestOps (#11253)", () => {
  it("list pagina por cursor até esgotar, com Bearer token e prefix", async () => {
    const store = new Map<string, string>([
      ["vote:261020:a@x.com", "{}"],
      ["vote:261021:a@x.com", "{}"],
      ["vote:261022:a@x.com", "{}"],
      ["vote:261023:a@x.com", "{}"],
      ["vote:261024:a@x.com", "{}"],
      ["score:a@x.com", "{}"],
    ]);
    const { fetchFn, calls } = fakeKvFetch(store, { pageSize: 2 });
    const kv = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn });
    const names = await kv.list("vote:");
    assert.equal(names.length, 5);
    assert.ok(names.every((n) => n.startsWith("vote:")));
    assert.equal(calls.length, 3, "5 chaves em páginas de 2 = 3 requests");
    assert.ok(calls.every((c) => c.auth === `Bearer ${TOKEN}`));
    assert.ok(calls.every((c) => new URL(c.url).searchParams.get("prefix") === "vote:"));
    assert.equal(new URL(calls[1].url).searchParams.get("cursor"), "2");
  });

  it("list aborta em cursor repetido em vez de entrar em loop", async () => {
    const fetchFn: KvFetch = async () =>
      Response.json({ success: true, result: [{ name: "k" }], result_info: { cursor: "same" } });
    const kv = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn });
    await assert.rejects(kv.list(""), /cursor repetido/);
  });

  it("get devolve o valor; 404 vira null", async () => {
    const store = new Map([["score:a@x.com", '{"n":1}']]);
    const { fetchFn } = fakeKvFetch(store);
    const kv = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn });
    assert.equal(await kv.get("score:a@x.com"), '{"n":1}');
    assert.equal(await kv.get("score:nao-existe@x.com"), null);
  });

  it("get codifica a chave na URL (chaves com ':' e '@')", async () => {
    const { fetchFn, calls } = fakeKvFetch(new Map());
    const kv = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn });
    await kv.get("clarice:vote:261020:a+b@x.com");
    assert.ok(calls[0].url.endsWith(`/values/${encodeURIComponent("clarice:vote:261020:a+b@x.com")}`));
  });

  it("delete de chave inexistente (404) é ok; delete apaga a existente", async () => {
    const store = new Map([["vote:261020:a@x.com", "{}"]]);
    const { fetchFn, calls } = fakeKvFetch(store);
    const kv = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn });
    await kv.delete("vote:261020:a@x.com");
    await kv.delete("vote:261020:a@x.com"); // 2ª vez: 404, idempotente
    assert.equal(store.size, 0);
    assert.deepEqual(calls.map((c) => c.method), ["DELETE", "DELETE"]);
  });

  it("put grava o corpo com PUT", async () => {
    const store = new Map<string, string>();
    const { fetchFn, calls } = fakeKvFetch(store);
    const kv = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn });
    await kv.put("stats:261020", '{"total":3}');
    assert.equal(store.get("stats:261020"), '{"total":3}');
    assert.equal(calls[0].method, "PUT");
  });

  it("401 lança com status e mensagem da Cloudflare, sem vazar o token", async () => {
    const { fetchFn } = fakeKvFetch(new Map(), { status: 401 });
    const kv = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn });
    for (const op of [() => kv.get("k"), () => kv.delete("k"), () => kv.put("k", "v"), () => kv.list("p"), () => kv.probe()]) {
      await assert.rejects(op(), (e: Error) => {
        assert.match(e.message, /HTTP 401/);
        assert.match(e.message, /Authentication error/);
        assert.ok(!e.message.includes(TOKEN), "mensagem de erro não pode conter o token");
        return true;
      });
    }
  });

  it("exige accountId, token e namespaceId", () => {
    assert.throws(() => createKvRestOps({ accountId: "", token: TOKEN, namespaceId: NS }), /obrigatórios/);
    assert.throws(() => createKvRestOps({ accountId: ACCOUNT, token: "", namespaceId: NS }), /obrigatórios/);
  });
});

describe("resolvePurgeKvBackend (#11253)", () => {
  const tokenEnv = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } as NodeJS.ProcessEnv;
  const notLogged = { ok: false, stderr: "wrangler whoami saiu com exit 0 mas stdout indica que nao esta autenticado" };

  it("wrangler logado via OAuth (Neo) → wrangler, mesmo com token no env", () => {
    const r = resolvePurgeKvBackend({ env: tokenEnv, checkWrangler: () => ({ ok: true, stderr: "" }) });
    assert.equal(r.backend, "wrangler");
    assert.match(r.reason, /OAuth/);
  });

  it("REGRESSÃO #11253 (300): sem login OAuth + token e account no env → rest, não falha", () => {
    const r = resolvePurgeKvBackend({ env: tokenEnv, checkWrangler: () => notLogged });
    assert.equal(r.backend, "rest");
    assert.ok(r.backend === "rest" && r.token === TOKEN && r.accountId === ACCOUNT);
    assert.match(r.reason, /API REST/);
    assert.match(r.reason, /nao esta autenticado/, "o motivo do wrangler entra no log");
  });

  it("sem login e sem token → none, nomeando a var que falta", () => {
    const r = resolvePurgeKvBackend({ env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, checkWrangler: () => notLogged });
    assert.equal(r.backend, "none");
    assert.match(r.reason, /CLOUDFLARE_API_TOKEN/);
    assert.doesNotMatch(r.reason, /CLOUDFLARE_ACCOUNT_ID/);
  });

  it("token em branco conta como ausente", () => {
    const r = resolvePurgeKvBackend({
      env: { CLOUDFLARE_API_TOKEN: "  ", CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      checkWrangler: () => notLogged,
    });
    assert.equal(r.backend, "none");
  });

  it("--kv-backend wrangler não roda o whoami", () => {
    let called = false;
    const r = resolvePurgeKvBackend({
      env: {},
      checkWrangler: () => { called = true; return notLogged; },
      override: "wrangler",
    });
    assert.equal(r.backend, "wrangler");
    assert.equal(called, false);
  });

  it("--kv-backend rest usa o token sem rodar o whoami; sem credencial vira none", () => {
    let called = false;
    const check = () => { called = true; return { ok: true, stderr: "" }; };
    assert.equal(resolvePurgeKvBackend({ env: tokenEnv, checkWrangler: check, override: "rest" }).backend, "rest");
    const none = resolvePurgeKvBackend({ env: {}, checkWrangler: check, override: "rest" });
    assert.equal(none.backend, "none");
    assert.match(none.reason, /CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID/);
    assert.equal(called, false);
  });

  it("parseKvBackendOverride: default auto, valores válidos, inválido lança", () => {
    assert.equal(parseKvBackendOverride(null), "auto");
    assert.equal(parseKvBackendOverride("rest"), "rest");
    assert.equal(parseKvBackendOverride("wrangler"), "wrangler");
    assert.throws(() => parseKvBackendOverride("api"), /--kv-backend inválido/);
  });
});

describe("REGRESSÃO #11253: purga no 300 sem wrangler login", () => {
  it("backend escolhido (rest) monta o plano de purga do email pelo KV via API", async () => {
    const choice = resolvePurgeKvBackend({
      env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      checkWrangler: () => ({ ok: false, stderr: "You are not authenticated. Please run `wrangler login`" }),
    });
    assert.equal(choice.backend, "rest");
    if (choice.backend !== "rest") return;

    const email = "vjpixel@gmail.com";
    const store = new Map<string, string>([
      [`score:${email}`, JSON.stringify({ total: 2, correct: 1, nickname: null })],
      [`score-by-month:2026-10:${email}`, JSON.stringify({ total: 2, correct: 1 })],
      [`vote:261026:${email}`, JSON.stringify({ choice: "A", ts: "x", correct: true })],
      [`vote:261027:${email}`, JSON.stringify({ choice: "B", ts: "x", correct: false })],
      ["vote:261027:outro@x.com", JSON.stringify({ choice: "A", ts: "x", correct: true })],
    ]);
    const { fetchFn, calls } = fakeKvFetch(store, { pageSize: 1 });
    const kv = createKvRestOps({ accountId: choice.accountId, token: choice.token, namespaceId: NS, fetchFn });

    const plan = await buildPurgePlan(kv, "", email, null);
    assert.deepEqual(plan.matchedEmails, [email]);
    const entry = plan.plans.find((p) => p.email === email)!;
    assert.equal(entry.scoreExists, true);
    assert.deepEqual(entry.voteKeys.sort(), [`vote:261026:${email}`, `vote:261027:${email}`]);
    assert.deepEqual(entry.sbmKeys, [`score-by-month:2026-10:${email}`]);
    assert.ok(calls.every((c) => c.method === "GET"), "montar o plano não escreve nada");
  });
});
