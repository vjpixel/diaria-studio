/**
 * test/d1-locks-12842.test.ts — locks entre máquinas no D1 (#12842).
 * Cliente D1 injetado (SQLite em memória, mesmo SQL da produção); nenhum
 * teste fala com a Cloudflare.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  D1HttpError,
  createD1RestClient,
  d1AcquireLock,
  d1FallbackWarning,
  isPermanentD1Error,
  d1ReadLock,
  d1ReleaseLock,
  d1RenewLock,
  editionLockD1Name,
  mergeGrantConsumedD1Name,
  mergeLockD1Name,
  resolveD1LocksSettings,
  type D1Client,
} from "../scripts/lib/d1-locks.ts";
import { createFakeD1, failingD1 } from "./_helpers/fake-d1.ts";

const T0 = 1_800_000_000_000;
const TTL = 2 * 60 * 1000;

describe("d1AcquireLock — exclusão", () => {
  it("aquisição concorrente: só um ganha", async () => {
    const d1 = createFakeD1();
    const [a, b] = await Promise.all([
      d1AcquireLock(d1, "merge-lock:x/y", "sessao-A", TTL, { now: T0 }),
      d1AcquireLock(d1, "merge-lock:x/y", "sessao-B", TTL, { now: T0 }),
    ]);
    assert.ok(a.ok && b.ok);
    const winners = [a, b].filter((r) => r.ok && r.value.acquired);
    assert.equal(winners.length, 1);
    const loser = [a, b].find((r) => r.ok && !r.value.acquired);
    assert.ok(loser?.ok);
    assert.equal(loser.value.current?.holder, "sessao-A");
  });

  it("20 concorrentes no mesmo nome: exatamente um vence", async () => {
    const d1 = createFakeD1();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => d1AcquireLock(d1, "n", `s${i}`, TTL, { now: T0 })),
    );
    assert.equal(results.filter((r) => r.ok && r.value.acquired).length, 1);
  });

  it("merge lock não é reentrante (#6334): 2ª aquisição da mesma sessão recusa", async () => {
    const d1 = createFakeD1();
    assert.ok((await d1AcquireLock(d1, "n", "A", TTL, { now: T0 })).ok);
    const again = await d1AcquireLock(d1, "n", "A", TTL, { now: T0 + 1000 });
    assert.ok(again.ok);
    assert.equal(again.value.acquired, false);
    assert.equal(again.value.current?.holder, "A");
  });

  it("reentrant (edition-lock): mesma sessão renova e preserva acquired_at", async () => {
    const d1 = createFakeD1();
    await d1AcquireLock(d1, "e", "A", TTL, { now: T0, reentrant: true });
    const r = await d1AcquireLock(d1, "e", "A", TTL, { now: T0 + 5000, reentrant: true });
    assert.ok(r.ok);
    assert.equal(r.value.acquired, true);
    assert.equal(r.value.refreshed, true);
    assert.equal(r.value.current?.acquiredAt, T0);
    assert.equal(r.value.current?.expiresAt, T0 + 5000 + TTL);
  });

  it("TTL expirado: outro holder assume", async () => {
    const d1 = createFakeD1();
    await d1AcquireLock(d1, "n", "A", TTL, { now: T0 });
    const inside = await d1AcquireLock(d1, "n", "B", TTL, { now: T0 + TTL - 1 });
    assert.ok(inside.ok && !inside.value.acquired);
    const after = await d1AcquireLock(d1, "n", "B", TTL, { now: T0 + TTL });
    assert.ok(after.ok && after.value.acquired);
    const read = await d1ReadLock(d1, "n", { now: T0 + TTL + 1 });
    assert.ok(read.ok);
    assert.equal(read.value?.holder, "B");
  });

  it("force assume lock vivo de outro", async () => {
    const d1 = createFakeD1();
    await d1AcquireLock(d1, "e", "A", TTL, { now: T0 });
    const r = await d1AcquireLock(d1, "e", "B", TTL, { now: T0 + 1, force: true });
    assert.ok(r.ok && r.value.acquired);
  });

  it("relógio do servidor quando `now` é omitido (SQL de tempo válido)", async () => {
    const d1 = createFakeD1();
    const r = await d1AcquireLock(d1, "n", "A", TTL);
    assert.ok(r.ok && r.value.acquired);
    const delta = Math.abs(r.value.current!.acquiredAt - Date.now());
    assert.ok(delta < 5000, `acquired_at fora do relógio: delta ${delta}`);
    const read = await d1ReadLock(d1, "n");
    assert.ok(read.ok);
    assert.equal(read.value?.holder, "A");
  });
});

describe("d1ReleaseLock / d1RenewLock", () => {
  it("release por não-dono é recusado e não apaga", async () => {
    const d1 = createFakeD1();
    await d1AcquireLock(d1, "n", "A", TTL, { now: T0 });
    const r = await d1ReleaseLock(d1, "n", "B", { now: T0 + 1 });
    assert.ok(r.ok);
    assert.equal(r.value, "held_by_other");
    const read = await d1ReadLock(d1, "n", { now: T0 + 2 });
    assert.ok(read.ok);
    assert.equal(read.value?.holder, "A");
  });

  it("release pelo dono libera; sem lock = not_held", async () => {
    const d1 = createFakeD1();
    await d1AcquireLock(d1, "n", "A", TTL, { now: T0 });
    const r = await d1ReleaseLock(d1, "n", "A", { now: T0 + 1 });
    assert.ok(r.ok);
    assert.equal(r.value, "released");
    const again = await d1ReleaseLock(d1, "n", "A", { now: T0 + 2 });
    assert.ok(again.ok);
    assert.equal(again.value, "not_held");
  });

  it("release por não-dono de lock vencido = not_held, sem apagar a linha", async () => {
    const d1 = createFakeD1();
    await d1AcquireLock(d1, "n", "A", TTL, { now: T0 });
    const r = await d1ReleaseLock(d1, "n", "B", { now: T0 + TTL + 1 });
    assert.ok(r.ok);
    assert.equal(r.value, "not_held");
    const rows = d1.db.prepare("SELECT holder FROM locks WHERE name = 'n'").all();
    assert.equal(rows.length, 1);
  });

  it("renew só estende lock do próprio holder", async () => {
    const d1 = createFakeD1();
    await d1AcquireLock(d1, "n", "A", TTL, { now: T0 });
    const other = await d1RenewLock(d1, "n", "B", TTL, { now: T0 + 1 });
    assert.ok(other.ok && other.value === false);
    const mine = await d1RenewLock(d1, "n", "A", TTL, { now: T0 + 100_000 });
    assert.ok(mine.ok && mine.value === true);
    const b = await d1AcquireLock(d1, "n", "B", TTL, { now: T0 + TTL + 1 });
    assert.ok(b.ok && !b.value.acquired, "renovado: B não pode tomar no TTL original");
  });
});

describe("D1 indisponível", () => {
  it("toda operação devolve ok:false (nunca lança)", async () => {
    const d1 = failingD1();
    for (const r of [
      await d1AcquireLock(d1, "n", "A", TTL),
      await d1ReadLock(d1, "n"),
      await d1ReleaseLock(d1, "n", "A"),
      await d1RenewLock(d1, "n", "A", TTL),
    ]) {
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /fetch failed/);
    }
  });

  it("resposta de réplica (served_by_primary=false) vira erro, não resultado", async () => {
    const replica: D1Client = { query: async () => ({ results: [{ holder: "A", acquired_at: 1, expires_at: 9e15 }], servedByPrimary: false }) };
    const r = await d1AcquireLock(replica, "n", "A", TTL);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.permanent, true, "réplica é erro permanente, não queda passageira");
  });

  it("P1-a: INSERT respondido sem linha + leitura do holder falhando = derrota (ok:true, acquired:false), nunca fallback", async () => {
    const real = createFakeD1();
    await d1AcquireLock(real, "n", "outra-maquina", TTL, { now: T0 });
    // Mesmo banco, mas toda leitura (SELECT) falha depois do INSERT.
    const flaky: D1Client = {
      async query(sql, params) {
        if (sql.startsWith("SELECT")) throw new Error("fetch failed (timeout na leitura)");
        return real.query(sql, params);
      },
    };
    const r = await d1AcquireLock(flaky, "n", "eu", TTL, { now: T0 + 1 });
    assert.equal(r.ok, true, "derrota no D1 não pode virar ok:false (o chamador cairia no lock local e ganharia)");
    assert.ok(r.ok);
    assert.equal(r.value.acquired, false);
    assert.equal(r.value.current, null);
  });

  it("P1-a: só o INSERT sem resposta devolve ok:false", async () => {
    const r = await d1AcquireLock(failingD1(), "n", "eu", TTL);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.permanent, false);
  });
});

describe("classificação de erro do D1", () => {
  it("rede/timeout/5xx/429 = transitório; 4xx, tabela ausente, envelope = permanente", () => {
    assert.equal(isPermanentD1Error(new Error("fetch failed")), false);
    assert.equal(isPermanentD1Error(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })), false);
    assert.equal(isPermanentD1Error(new D1HttpError("HTTP 500", 500)), false);
    assert.equal(isPermanentD1Error(new D1HttpError("HTTP 429", 429)), false);
    assert.equal(isPermanentD1Error(new D1HttpError("HTTP 401", 401)), true);
    assert.equal(isPermanentD1Error(new D1HttpError("HTTP 403", 403)), true);
    assert.equal(isPermanentD1Error(new Error("D1 query: HTTP 400 — 7500: no such table: locks")), true);
    assert.equal(isPermanentD1Error(new Error("D1 query: envelope inválido: {}")), true);
  });

  it("cliente REST: HTTP 403 vira D1HttpError permanente; 503 transitório", async () => {
    const mk = (status: number) =>
      createD1RestClient({
        accountId: "a",
        token: "t",
        databaseId: "d",
        fetchFn: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "x" }] }), { status }),
      });
    const forbidden = await d1ReadLock(mk(403), "n");
    assert.ok(!forbidden.ok && forbidden.permanent);
    const unavailable = await d1ReadLock(mk(503), "n");
    assert.ok(!unavailable.ok && !unavailable.permanent);
  });

  it("aviso: permanente diz ERRO PERMANENTE; transitório diz indisponível", () => {
    assert.match(d1FallbackWarning("x", "e", true), /ERRO PERMANENTE/);
    assert.match(d1FallbackWarning("x", "e"), /D1 indisponível em x/);
  });
});

describe("timeout do cliente REST", () => {
  it("fetch pendurado que honra o signal: falha transitória dentro do timeout", async () => {
    const client = createD1RestClient({
      accountId: "a",
      token: "t",
      databaseId: "d",
      timeoutMs: 50,
      fetchFn: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    });
    const t0 = Date.now();
    const r = await d1ReadLock(client, "n");
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(!r.ok && !r.permanent);
  });
});

describe("cliente REST", () => {
  it("monta URL/corpo e lê results; token não aparece no erro", async () => {
    const seen: Array<{ url: string; body: string; auth: string }> = [];
    const ok = createD1RestClient({
      accountId: "acc",
      token: "SEGREDO",
      databaseId: "db1",
      fetchFn: async (url, init) => {
        seen.push({ url, body: String(init?.body), auth: String((init?.headers as Record<string, string>).Authorization) });
        return new Response(JSON.stringify({ success: true, result: [{ success: true, results: [{ x: 1 }], meta: { served_by_primary: true } }] }));
      },
    });
    const r = await ok.query("SELECT 1", ["a"]);
    assert.deepEqual(r.results, [{ x: 1 }]);
    assert.equal(seen[0]!.url, "https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db1/query");
    assert.deepEqual(JSON.parse(seen[0]!.body), { sql: "SELECT 1", params: ["a"] });
    assert.equal(seen[0]!.auth, "Bearer SEGREDO");

    const bad = createD1RestClient({
      accountId: "acc",
      token: "SEGREDO",
      databaseId: "db1",
      fetchFn: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 }),
    });
    await assert.rejects(bad.query("SELECT 1", []), (e: Error) => /403/.test(e.message) && !e.message.includes("SEGREDO"));
  });
});

describe("configuração e nomes", () => {
  it("sem database_id = unconfigured (silencioso); com banco e sem token = missing-credentials", () => {
    assert.equal(resolveD1LocksSettings({}, {}).kind, "unconfigured");
    assert.equal(resolveD1LocksSettings({ d1_locks: { database_id: null } }, {}).kind, "unconfigured");
    assert.equal(resolveD1LocksSettings({ d1_locks: { database_id: "x" } }, {}).kind, "missing-credentials");
    const r = resolveD1LocksSettings(
      { d1_locks: { database_id: "x" } },
      { CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t1", CLOUDFLARE_D1_TOKEN: "t2" },
    );
    assert.equal(r.kind, "ready");
    if (r.kind === "ready") assert.equal(r.settings.token, "t2", "token dedicado vence");
    assert.equal(
      resolveD1LocksSettings({ d1_locks: { database_id: "x" } }, { DIARIA_D1_LOCKS: "off", CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" }).kind,
      "unconfigured",
    );
  });

  it("nomes estáveis entre máquinas", () => {
    assert.equal(mergeLockD1Name("vjpixel/Diaria-Studio"), "merge-lock:vjpixel/diaria-studio");
    assert.equal(editionLockD1Name("261111"), "edition:261111");
    assert.equal(
      mergeGrantConsumedD1Name({ grantedBy: "c", grantedTo: "b", grantedAt: "2026-11-11T00:00:00.000Z" }),
      "merge-grant-consumed:c|b|2026-11-11T00:00:00.000Z",
    );
  });
});

describe("d1-locks-setup — teste mínimo", () => {
  it("passa no D1 falso e não deixa a linha de teste", async () => {
    const { runSmokeTest } = await import("../scripts/d1-locks-setup.ts");
    const d1 = createFakeD1();
    assert.deepEqual(await runSmokeTest(d1, "smoke:x"), []);
    assert.equal(d1.db.prepare("SELECT COUNT(*) AS n FROM locks").get()?.n, 0);
  });
});
