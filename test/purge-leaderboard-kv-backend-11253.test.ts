/**
 * test/purge-leaderboard-kv-backend-11253.test.ts
 *
 * BUG (#11253): `purge-leaderboard.ts` só falava com o KV do POLL pelo
 * wrangler com login OAuth. No servidor `300` não há `wrangler login` (precisa
 * de navegador), então a purga automática do Stage 6 (§6h) falhava toda vez e
 * os votos do editor ficavam no leaderboard público — o `CLOUDFLARE_API_TOKEN`
 * do `.env` (em 27/10/2026 lia e gravava no POLL, probe manual) era descartado de propósito
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
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createKvRestOps, KV_PROBE_SENTINEL_KEY, type KvFetch } from "../scripts/lib/cloudflare-kv-rest.ts";
import {
  checkPurgeAuth,
  isWranglerKvNotFound,
  parseKvBackendOverride,
  readKvBackendFlag,
  resolvePurgeKvBackend,
  type PurgeKvBackendChoice,
} from "../scripts/lib/purge-kv-backend.ts";
import { buildPurgePlan } from "../scripts/lib/purge-leaderboard-plan.ts";
import { deleteVotesAndAdjustStats } from "../scripts/lib/purge-vote-stats.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "purge-leaderboard.ts");

const ACCOUNT = "acc123";
const NS = "72784da4ae39444481eb422ebac357c6";
const TOKEN = "secret-token-abc";

interface Call { url: string; method: string; auth: string | null; body: string | null; signal: AbortSignal | null }

/** KV falso servido por "API REST": pagina `keys` em páginas de `pageSize`
 * (ignora o `limit` pedido, pra forçar várias páginas com poucas chaves). */
function fakeKvFetch(store: Map<string, string>, opts: { pageSize?: number; status?: number } = {}) {
  const calls: Call[] = [];
  const pageSize = opts.pageSize ?? 2;
  const fetchFn: KvFetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method,
      auth: headers.Authorization ?? null,
      body: (init?.body as string) ?? null,
      signal: init?.signal ?? null,
    });
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
      // A API real responde 200 `success:true` também pra chave inexistente.
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

  it("delete de chave inexistente é ok (idempotente); delete apaga a existente", async () => {
    const store = new Map([["vote:261020:a@x.com", "{}"]]);
    const { fetchFn, calls } = fakeKvFetch(store);
    const kv = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn });
    await kv.delete("vote:261020:a@x.com");
    await kv.delete("vote:261020:a@x.com"); // 2ª vez: chave já não existe, idempotente
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

  it("delete com 404 (defesa: rota/namespace) também é ok", async () => {
    const fetchFn: KvFetch = async () => new Response("not found", { status: 404 });
    const kv = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn });
    await kv.delete("k");
  });

  it("list pede limit=1000; probe pede limit=10 e grava+apaga a sentinela", async () => {
    const store = new Map<string, string>([["score:a@x.com", "{}"]]);
    const { fetchFn, calls } = fakeKvFetch(store);
    const kv = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn });
    await kv.list("score:");
    assert.equal(new URL(calls[0].url).searchParams.get("limit"), "1000");
    calls.length = 0;
    await kv.probe();
    assert.equal(new URL(calls[0].url).searchParams.get("limit"), "10");
    assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT", "DELETE"]);
    assert.ok(calls[1].url.endsWith(`/values/${KV_PROBE_SENTINEL_KEY}`));
    assert.ok(calls[2].url.endsWith(`/values/${KV_PROBE_SENTINEL_KEY}`));
    assert.equal(store.has(KV_PROBE_SENTINEL_KEY), false, "sentinela não fica no KV");
    assert.deepEqual([...store.keys()], ["score:a@x.com"], "probe não toca dado real");
  });

  it("probe: 200 com success:false lança; envelope válido resolve", async () => {
    const bad: KvFetch = async () => Response.json({ success: false, errors: [{ code: 10001, message: "x" }], result: [] });
    await assert.rejects(
      createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn: bad }).probe(),
      /envelope inválido/,
    );
    const { fetchFn } = fakeKvFetch(new Map());
    await createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn }).probe();
  });

  it("probe: leitura ok mas PUT negado (token só-leitura) lança", async () => {
    const fetchFn: KvFetch = async (_url, init) =>
      (init?.method ?? "GET") === "GET"
        ? Response.json({ success: true, result: [], result_info: { cursor: "" } })
        : new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), {
            status: 403,
          });
    const kv = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn });
    await assert.rejects(kv.probe(), /KV REST put __purge_probe__ falhou: HTTP 403/);
  });

  it("list com corpo não-JSON em 200 lança com contexto 'KV REST list'", async () => {
    const fetchFn: KvFetch = async () => new Response("<html>gateway</html>", { status: 200 });
    const kv = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn });
    await assert.rejects(kv.list("p"), /KV REST list \(prefix "p"\) .*não-JSON/);
  });

  it("get com 500 rejeita (não vira null)", async () => {
    const fetchFn: KvFetch = async () => new Response("boom", { status: 500 });
    const kv = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn });
    await assert.rejects(kv.get("k"), /HTTP 500/);
  });

  it("toda request leva AbortSignal; request pendurada estoura o timeout", async () => {
    const { fetchFn, calls } = fakeKvFetch(new Map());
    const kv = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn });
    await kv.probe();
    assert.ok(calls.every((c) => c.signal instanceof AbortSignal));
    const hang: KvFetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const slow = createKvRestOps({ accountId: ACCOUNT, token: TOKEN, namespaceId: NS, fetchFn: hang, timeoutMs: 20 });
    await assert.rejects(slow.get("k"), (e: Error) => e.name === "TimeoutError");
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
    assert.ok(r.backend === "rest" && r.fallbackWarning && /caindo pra API REST/.test(r.fallbackWarning));
  });

  it("reason nunca contém o token (nenhum caminho)", () => {
    const cases = [
      resolvePurgeKvBackend({ env: tokenEnv, checkWrangler: () => notLogged }),
      resolvePurgeKvBackend({ env: tokenEnv, checkWrangler: () => notLogged, override: "rest" }),
      resolvePurgeKvBackend({ env: tokenEnv, checkWrangler: () => ({ ok: true, stderr: "" }) }),
    ];
    for (const c of cases) {
      assert.ok(!c.reason.includes(TOKEN));
      if (c.backend === "rest" && c.fallbackWarning) assert.ok(!c.fallbackWarning.includes(TOKEN));
    }
  });

  it("--kv-backend rest forçado não emite fallbackWarning", () => {
    const r = resolvePurgeKvBackend({ env: tokenEnv, checkWrangler: () => notLogged, override: "rest" });
    assert.ok(r.backend === "rest" && r.fallbackWarning === undefined);
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

  it("readKvBackendFlag: ausente → auto; sem valor (último arg ou seguido de --flag) lança", () => {
    assert.equal(readKvBackendFlag(["--check-auth"]), "auto");
    assert.equal(readKvBackendFlag(["--kv-backend", "rest", "--check-auth"]), "rest");
    assert.throws(() => readKvBackendFlag(["--check-auth", "--kv-backend"]), /exige um valor/);
    assert.throws(() => readKvBackendFlag(["--kv-backend", "--check-auth"]), /exige um valor/);
    assert.throws(() => readKvBackendFlag(["--kv-backend", "api"]), /inválido/);
  });
});

describe("isWranglerKvNotFound (#11253 review A1)", () => {
  const key = "vote:260404:vjpixel@gmail.com";
  const url = `https://api.cloudflare.com/client/v4/accounts/a/storage/kv/namespaces/n/values/${encodeURIComponent(key)}`;

  it("REGRESSÃO: chave com '404' + erro de auth NÃO vira 'não encontrada'", () => {
    const e = Object.assign(new Error(`Command failed: node wrangler.js kv key get --remote ${key}`), {
      stderr: `✘ [ERROR] Failed to fetch ${url} - 401: Unauthorized`,
      stdout: "",
    });
    assert.equal(isWranglerKvNotFound(e), false);
  });

  it("REGRESSÃO: err.message com '404 not found' não entra no teste (erro de rede)", () => {
    const e = Object.assign(new Error(`Command failed: ... ${key} 404 not found`), { stderr: "fetch failed: ECONNRESET" });
    assert.equal(isWranglerKvNotFound(e), false);
  });

  it("chave inexistente real (stderr '- 404: Not Found') é not-found", () => {
    const e = Object.assign(new Error(`Command failed: ... ${key}`), {
      stderr: `✘ [ERROR] Failed to fetch ${url} - 404: Not Found`,
    });
    assert.equal(isWranglerKvNotFound(e), true);
    assert.equal(isWranglerKvNotFound({ stderr: Buffer.from("key not found [code: 10009]") }), true);
  });
});

describe("checkPurgeAuth (#11253 review A3/A4)", () => {
  const rest: PurgeKvBackendChoice = { backend: "rest", reason: "forçado por --kv-backend rest", accountId: ACCOUNT, token: TOKEN };
  const okOps = () => ({ probe: async () => {} });

  it("sem backend → falha com o motivo", async () => {
    const r = await checkPurgeAuth({
      choice: { backend: "none", reason: "falta CLOUDFLARE_API_TOKEN" },
      opsFor: okOps,
      adminSecretPresent: true,
    });
    assert.equal(r.ok, false);
    assert.match(r.err.join("\n"), /CLOUDFLARE_API_TOKEN/);
  });

  it("wrangler forçado também roda o probe (não passa sem testar)", async () => {
    let probed = false;
    const r = await checkPurgeAuth({
      choice: { backend: "wrangler", reason: "forçado por --kv-backend wrangler" },
      opsFor: () => ({ probe: async () => { probed = true; } }),
      adminSecretPresent: true,
    });
    assert.equal(probed, true);
    assert.equal(r.ok, true);
    assert.match(r.out[0], /^\[purge\] kv backend: wrangler — /);
  });

  it("probe falhou → falha citando o choice.reason", async () => {
    const r = await checkPurgeAuth({
      choice: { ...rest, reason: "wrangler sem login OAuth (x); usando API REST" },
      opsFor: () => ({ probe: async () => { throw new Error("KV REST put __purge_probe__ falhou: HTTP 403"); } }),
      adminSecretPresent: true,
    });
    assert.equal(r.ok, false);
    assert.match(r.err.join("\n"), /wrangler sem login OAuth/);
    assert.match(r.err.join("\n"), /HTTP 403/);
  });

  it("fallback do auto pro REST emite [warn]", async () => {
    const r = await checkPurgeAuth({ choice: { ...rest, fallbackWarning: "wrangler whoami falhou (x)" }, opsFor: okOps, adminSecretPresent: true });
    assert.equal(r.ok, true);
    assert.ok(r.err.some((l) => l.startsWith("[warn] wrangler whoami falhou")));
  });

  it("REGRESSÃO (300): com fallback, a 1ª linha do stderr é a CAUSA da falha, não o [warn]", async () => {
    const fallback = { ...rest, fallbackWarning: "wrangler whoami falhou (x) — caindo pra API REST do KV" };
    const noSecret = await checkPurgeAuth({ choice: fallback, opsFor: okOps, adminSecretPresent: false });
    assert.equal(noSecret.ok, false);
    assert.match(noSecret.err[0], /^\[purge\] ADMIN_SECRET .*ausente/);
    assert.match(noSecret.err.at(-1)!, /^\[warn\] /);

    const probeFail = await checkPurgeAuth({
      choice: fallback,
      opsFor: () => ({ probe: async () => { throw new Error("HTTP 403"); } }),
      adminSecretPresent: true,
    });
    assert.match(probeFail.err[0], /^\[purge\] backend rest escolhido .*HTTP 403/);
    assert.match(probeFail.err.at(-1)!, /^\[warn\] /);
  });

  it("KV ok mas sem ADMIN_SECRET → falha (o --execute não rodaria)", async () => {
    const r = await checkPurgeAuth({ choice: rest, opsFor: okOps, adminSecretPresent: false });
    assert.equal(r.ok, false);
    assert.match(r.err.join("\n"), /ADMIN_SECRET/);
  });

  it("tudo ok → ok, e a saída não contém o token", async () => {
    const r = await checkPurgeAuth({ choice: rest, opsFor: okOps, adminSecretPresent: true });
    assert.equal(r.ok, true);
    assert.ok(![...r.out, ...r.err].some((l) => l.includes(TOKEN)));
  });
});

describe("deleteVotesAndAdjustStats (#11253 review A2)", () => {
  const email = "vjpixel@gmail.com";
  const vote = (choice: "A" | "B", correct: boolean) => JSON.stringify({ choice, ts: "x", correct });
  const stats = () => JSON.stringify({ total: 10, voted_a: 6, voted_b: 4, correct_count: 5 });
  const keys = [`vote:261026:${email}`, `vote:261027:${email}`];
  const seed = () =>
    new Map<string, string>([
      [keys[0], vote("A", true)],
      [keys[1], vote("B", false)],
      ["stats:261026", stats()],
      ["stats:261027", stats()],
    ]);
  const opsOn = (store: Map<string, string>, failDeleteOf?: string) => ({
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, val: string) => { store.set(k, val); },
    delete: async (k: string) => {
      if (k === failDeleteOf) throw new Error(`delete ${k}: HTTP 500`);
      store.delete(k);
    },
  });
  const total = (store: Map<string, string>, k: string) => (JSON.parse(store.get(k)!) as { total: number }).total;

  it("apaga os votos e desconta cada um do stats da sua edição", async () => {
    const store = seed();
    const r = await deleteVotesAndAdjustStats(opsOn(store), keys, "");
    assert.deepEqual(r.deleted, keys);
    assert.deepEqual(JSON.parse(store.get("stats:261026")!), { total: 9, voted_a: 5, voted_b: 4, correct_count: 4 });
    assert.deepEqual(JSON.parse(store.get("stats:261027")!), { total: 9, voted_a: 6, voted_b: 3, correct_count: 5 });
  });

  it("REGRESSÃO: DELETE falha no meio + re-run não desconta stats duas vezes", async () => {
    const store = seed();
    await assert.rejects(deleteVotesAndAdjustStats(opsOn(store, keys[1]), keys, ""), /HTTP 500/);
    // 1º voto saiu e foi descontado; o 2º ficou e o stats dele está intacto.
    assert.equal(store.has(keys[0]), false);
    assert.equal(total(store, "stats:261026"), 9);
    assert.equal(total(store, "stats:261027"), 10);

    // Re-run sem falha: só o voto que ficou entra no ajuste.
    await deleteVotesAndAdjustStats(opsOn(store), keys, "");
    assert.equal(total(store, "stats:261026"), 9, "não desconta de novo");
    assert.equal(total(store, "stats:261027"), 9);
  });

  it("REGRESSÃO: PUT/leitura de stats falhando não interrompe as demais edições; erro único lista todas", async () => {
    const store = seed();
    store.set(`vote:261028:${email}`, vote("A", false));
    store.set("stats:261028", stats());
    const allKeys = [...keys, `vote:261028:${email}`];
    const ops = {
      get: async (k: string) => {
        if (k === "stats:261027") throw new Error("HTTP 502");
        return store.get(k) ?? null;
      },
      put: async (k: string, val: string) => {
        if (k === "stats:261026") throw new Error("HTTP 500");
        store.set(k, val);
      },
      delete: async (k: string) => { store.delete(k); },
    };
    await assert.rejects(deleteVotesAndAdjustStats(ops, allKeys, ""), (e: Error) => {
      assert.match(e.message, /ajuste de 2 stats/);
      assert.match(e.message, /stats:261026: gravação falhou \(HTTP 500\) — gravar à mão total=9 a=5 b=4 correct=4/);
      assert.match(e.message, /stats:261027: leitura falhou \(HTTP 502\) — descontar à mão total-1 a-0 b-1 correct-0/);
      return true;
    });
    // Todos os votos saíram, e a edição seguinte às falhas foi ajustada mesmo assim.
    assert.ok(allKeys.every((k) => !store.has(k)));
    assert.equal(total(store, "stats:261028"), 9);
  });

  it("prefixo de marca: só o stats da mesma marca é tocado", async () => {
    const store = new Map<string, string>([
      [`clarice:vote:261026:${email}`, vote("A", true)],
      ["clarice:stats:261026", stats()],
      ["stats:261026", stats()],
    ]);
    await deleteVotesAndAdjustStats(opsOn(store), [`clarice:vote:261026:${email}`], "clarice:");
    assert.equal(total(store, "clarice:stats:261026"), 9);
    assert.equal(total(store, "stats:261026"), 10);
  });
});

describe("CLI purge-leaderboard.ts (spawn, sem rede)", () => {
  function run(args: string[]) {
    // dotenv lê .env do cwd: diretório vazio, nada do repo vaza pro teste.
    const cwd = mkdtempSync(join(tmpdir(), "purge-cli-"));
    try {
      // tsx resolvido pelo repo (o cwd temporário não tem node_modules).
      return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), SCRIPT, ...args], {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          // dotenv não sobrescreve chave existente — string vazia = ausente.
          CLOUDFLARE_API_TOKEN: "",
          CLOUDFLARE_ACCOUNT_ID: "",
          ADMIN_SECRET: "",
          POLL_ADMIN_SECRET: "",
        },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it("--check-auth --kv-backend rest sem token → exit 1 nomeando a var, sem 'Uso:'", () => {
    const r = run(["--check-auth", "--kv-backend", "rest"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /CLOUDFLARE_API_TOKEN/);
    assert.doesNotMatch(r.stderr + r.stdout, /Uso:/);
  });

  it("--kv-backend api → exit 2", () => {
    const r = run(["--check-auth", "--kv-backend", "api"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--kv-backend inválido/);
  });

  it("--kv-backend como último arg, sem valor → exit 2 (não vira auto)", () => {
    const r = run(["--check-auth", "--kv-backend"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /exige um valor/);
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
