/**
 * test/close-poll-stats-full-reconcile-4563.test.ts (#4563)
 *
 * Cobre o item que ficou pendente depois dos dois PRs já mergeados pra
 * #4563 (#4566: guard fail-loud no close-poll.ts; #4591: guard de brand em
 * `legacyMonthlyEditionForCycle`): a RECONCILIAÇÃO do agregado
 * (`total`/`voted_a`/`voted_b`), não só `correct_count`.
 *
 * ## Causa raiz do achado ao vivo (ciclo Clarice `2607-08`, ver comentários
 * da issue)
 *
 * `handleAdminCorrect` (index.ts) sempre recomputou `correct_count` do zero
 * a cada chamada, iterando `vote:{edition}:*` (a fonte de verdade). Mas
 * `total`/`voted_a`/`voted_b` NUNCA tinham esse mesmo caminho de
 * auto-correção — continuavam sendo o que o DO/KV acumulou via increments
 * normais (`handleIncrement`, vote.ts). Como `updateStatsCounter` roda ANTES
 * de `POLL.put(voteKey)` (vote.ts), uma interrupção entre as duas escritas
 * produz um voto "órfão": incrementa o agregado mas não deixa registro
 * `vote:` individual correspondente. Resultado real observado: `total`=35 e
 * `voted_b`=16 no KV/DO, mas só 34 registros `vote:2607-08:*` (19 A + 15 B).
 * `correct_count`=15 já batia com os 15 B REAIS — mas o guard do #4566
 * (`checkCorrectCountSanity`) compara `correct_count` contra `voted_b`
 * vindo de `/stats`, que reportava 16 (drifted) em vez de 15 (real) — FATAL
 * garantido na próxima `close-poll.ts --answer B`.
 *
 * ## Fix
 *
 * `handleAdminCorrect` agora tambpem tally `total`/`voted_a`/`voted_b` a
 * partir dos MESMOS registros `vote:{edition}:*` já iterados pra
 * `correct_count`, e reconcilia os 4 campos juntos: no DO StatsCounter (via
 * `/adjust-correct`, payload estendido — `AdjustCorrectPayload` ganhou 3
 * campos opcionais) e no espelho KV `stats:{edition}` (sobrescrita completa,
 * não mais um patch de só `correct_count`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  StatsCounter,
  mergeStatsWithKvFallback,
  isValidReconcileTriple,
  type StatsCounterData,
} from "../workers/poll/src/stats-counter.ts";
import worker, { hmacSign, type Env } from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makeMockDoState } from "./_helpers/make-mock-do-state.ts";

// ── isValidReconcileTriple (pure) ────────────────────────────────────────────

describe("isValidReconcileTriple (#4563)", () => {
  it("trio consistente (total = voted_a + voted_b) → válido", () => {
    assert.equal(isValidReconcileTriple(34, 19, 15), true);
  });

  it("total ≠ voted_a + voted_b (o próprio drift de produção: 35 vs 19+15=34) → inválido", () => {
    assert.equal(isValidReconcileTriple(35, 19, 15), false);
  });

  it("qualquer campo negativo → inválido", () => {
    assert.equal(isValidReconcileTriple(-1, 0, 0), false);
    assert.equal(isValidReconcileTriple(0, -1, 1), false);
  });

  it("qualquer campo não-inteiro → inválido", () => {
    assert.equal(isValidReconcileTriple(1.5, 1, 0.5), false);
  });

  it("qualquer campo undefined/não-number → inválido (payload parcial)", () => {
    assert.equal(isValidReconcileTriple(undefined, 1, 1), false);
    assert.equal(isValidReconcileTriple(2, undefined, 1), false);
    assert.equal(isValidReconcileTriple(2, 1, undefined), false);
  });

  it("zero/zero/zero → válido (edição sem votos ainda)", () => {
    assert.equal(isValidReconcileTriple(0, 0, 0), true);
  });
});

// ── mergeStatsWithKvFallback — stale agora prefere o objeto KV INTEIRO ──────

describe("mergeStatsWithKvFallback — correctCountStale usa kvStats inteiro, não blend (#4563)", () => {
  it("total empatado + correctCountStale=true + total/voted_a/voted_b DIVERGEM entre DO e KV: usa o KV inteiro (não o total STALE do DO)", () => {
    // Simula o cenário real: o DO tem total/voted_b stale (drift de produção,
    // 3/2/1) mas o KV já foi escrito com o agregado RECONCILIADO (2/1/1) pela
    // MESMA chamada de handleAdminCorrect que setou correctCountStale (o DO
    // falhou, mas o KV foi gravado com o valor reconciliado de qualquer jeito
    // — fail-soft, ver handleAdminCorrect). Blendar aqui devolveria total=3
    // (stale) com correct_count do KV — inconsistente. O fix devolve o KV
    // inteiro.
    const doStats: StatsCounterData = { total: 3, voted_a: 2, voted_b: 1, correct_count: 0 };
    const kvStats: StatsCounterData = { total: 2, voted_a: 1, voted_b: 1, correct_count: 1 };
    const result = mergeStatsWithKvFallback(doStats, kvStats, true);
    assert.deepEqual(
      result,
      kvStats,
      "REGRESSÃO #4563: quando correctCountStale, o resultado deve ser o objeto KV INTEIRO (reconciliado), não um blend com o total stale do DO",
    );
  });
});

// ── StatsCounter DO — /adjust-correct com reconciliação completa (#4563) ────

function makeStatsCounter(): StatsCounter {
  return new StatsCounter(makeMockDoState());
}

async function callAdjustCorrect(counter: StatsCounter, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const req = new Request("https://internal/adjust-correct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const resp = await counter.fetch(req);
  return { status: resp.status, json: await resp.json() };
}

async function callGetStats(counter: StatsCounter): Promise<StatsCounterData> {
  const resp = await counter.fetch(new Request("https://internal/stats", { method: "GET" }));
  const body = await resp.json() as { stats: StatsCounterData };
  return body.stats;
}

async function callIncrement(counter: StatsCounter, choice: "A" | "B", correct: boolean | null): Promise<void> {
  await counter.fetch(new Request("https://internal/increment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ choice, correct }),
  }));
}

describe("StatsCounter DO /adjust-correct — reconciliação completa (#4563)", () => {
  it("payload só com correct_count (chamador legado): total/voted_a/voted_b do DO ficam intactos — compat preservada", async () => {
    const counter = makeStatsCounter();
    await callIncrement(counter, "A", null);
    await callIncrement(counter, "B", null);
    await callIncrement(counter, "A", null);
    // DO agora tem total:3, voted_a:2, voted_b:1, correct_count:0.

    const { status, json } = await callAdjustCorrect(counter, { correct_count: 2 });
    assert.equal(status, 200);
    assert.equal(json.stats.correct_count, 2);
    assert.equal(json.stats.total, 3, "sem os campos de reconciliação, total não muda (comportamento pré-#4563 preservado)");
    assert.equal(json.stats.voted_a, 2);
    assert.equal(json.stats.voted_b, 1);
  });

  it("payload com o trio completo válido: sobrescreve total/voted_a/voted_b junto com correct_count", async () => {
    const counter = makeStatsCounter();
    await callIncrement(counter, "A", null);
    await callIncrement(counter, "B", null);
    await callIncrement(counter, "A", null);
    // DO tem total:3 (drift simulado — só 2 registros "reais" existiriam,
    // ver cenário de produção). Reconcilia pra 2/1/1/1.

    const { status, json } = await callAdjustCorrect(counter, {
      correct_count: 1,
      total: 2,
      voted_a: 1,
      voted_b: 1,
    });
    assert.equal(status, 200);
    assert.deepEqual(json.stats, { total: 2, voted_a: 1, voted_b: 1, correct_count: 1 });

    const stats = await callGetStats(counter);
    assert.deepEqual(stats, { total: 2, voted_a: 1, voted_b: 1, correct_count: 1 }, "persistiu — GET /stats reflete o reconciliado");
  });

  it("payload parcial (só total, faltando voted_a/voted_b): 400, estado do DO não muda", async () => {
    const counter = makeStatsCounter();
    await callIncrement(counter, "A", null);
    const before = await callGetStats(counter);

    const { status, json } = await callAdjustCorrect(counter, { correct_count: 1, total: 5 });
    assert.equal(status, 400);
    assert.match(json.error, /reconciliação inválida/);

    const after = await callGetStats(counter);
    assert.deepEqual(after, before, "payload parcial rejeitado não deve mutar o estado armazenado");
  });

  it("trio com invariante violado (total ≠ voted_a + voted_b): 400, estado não muda", async () => {
    const counter = makeStatsCounter();
    await callIncrement(counter, "A", null);
    const before = await callGetStats(counter);

    const { status, json } = await callAdjustCorrect(counter, {
      correct_count: 0,
      total: 5,
      voted_a: 1,
      voted_b: 1, // 1+1=2 ≠ 5
    });
    assert.equal(status, 400);
    assert.match(json.error, /invariante|reconciliação inválida/);

    const after = await callGetStats(counter);
    assert.deepEqual(after, before);
  });

  it("correct_count > total (trio válido mas correct_count absurdo): 400, estado não muda", async () => {
    const counter = makeStatsCounter();
    const { status, json } = await callAdjustCorrect(counter, {
      correct_count: 10,
      total: 2,
      voted_a: 1,
      voted_b: 1,
    });
    assert.equal(status, 400);
    assert.match(json.error, /não pode exceder total/);
  });
});

// ── Fim-a-fim: handleAdminCorrect reconcilia o "drift" real (bug 2607-08) ───

function makeStatsCounterNs(): DurableObjectNamespace {
  const instances = new Map<string, StatsCounter>();
  return {
    idFromName: (name: string) => ({ name, toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId): DurableObjectStub => {
      const name = id.toString();
      if (!instances.has(name)) instances.set(name, makeStatsCounter());
      const inst = instances.get(name)!;
      return { fetch: (url: RequestInfo, init?: RequestInit) => inst.fetch(new Request(url as string, init)) } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

function makeVoteDedupNs(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ name, toString: () => name }) as unknown as DurableObjectId,
    get: (): DurableObjectStub => ({
      fetch: async (url: RequestInfo) => {
        const u = new URL(url as string);
        if (u.pathname === "/confirm") {
          return new Response(JSON.stringify({ confirmed: true }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ firstVote: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

describe("handleAdminCorrect — reconcilia total/voted_a/voted_b a partir dos registros vote:* (#4563)", () => {
  it("REGRESSÃO EXATA (ciclo 2607-08): 19 votos A + 15 votos B reais, + 1 incremento órfão no DO (drift), gabarito B → /stats reporta total=34/voted_b=15/correct_count=15 (não 35/16/15 — o drift antes deixava o guard do #4566 FATAL pra sempre)", async () => {
    const kv = makeTrackedKv();
    const statsNs = makeStatsCounterNs();
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      VOTE_DEDUP: makeVoteDedupNs(),
      STATS_COUNTER: statsNs,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const edition = "2607-08";
    const brand = "clarice";

    // 19 votos A + 15 votos B, todos via /vote (cria vote: record + increment
    // do DO em sincronia — sem drift).
    for (let i = 0; i < 19; i++) {
      const voteUrl = new URL("https://poll.diaria.workers.dev/vote");
      voteUrl.searchParams.set("email", `voter-a-${i}@x.com`);
      voteUrl.searchParams.set("edition", edition);
      voteUrl.searchParams.set("choice", "A");
      voteUrl.searchParams.set("brand", brand);
      const res = await worker.fetch(new Request(voteUrl.toString(), { method: "GET" }), env, {} as ExecutionContext);
      assert.equal(res.status, 200);
    }
    for (let i = 0; i < 15; i++) {
      const voteUrl = new URL("https://poll.diaria.workers.dev/vote");
      voteUrl.searchParams.set("email", `voter-b-${i}@x.com`);
      voteUrl.searchParams.set("edition", edition);
      voteUrl.searchParams.set("choice", "B");
      voteUrl.searchParams.set("brand", brand);
      const res = await worker.fetch(new Request(voteUrl.toString(), { method: "GET" }), env, {} as ExecutionContext);
      assert.equal(res.status, 200);
    }

    // Simula o "voto órfão" (achado real #4563): um increment no DO SEM o
    // vote: record correspondente — a assinatura exata de uma interrupção
    // entre updateStatsCounter e POLL.put(voteKey) em vote.ts.
    const doId = statsNs.idFromName(`${brand}:${edition}`);
    const doStub = statsNs.get(doId);
    await doStub.fetch("https://internal/increment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice: "B", correct: null }),
    });

    // Sanity: antes da correção, o DO/KV têm o drift (total 35, voted_b 16).
    const preStats = await (await doStub.fetch("https://internal/stats")).json() as { stats: StatsCounterData };
    assert.equal(preStats.stats.total, 35, "sanity: 34 votos reais + 1 órfão = 35");
    assert.equal(preStats.stats.voted_b, 16, "sanity: 15 B reais + 1 B órfão = 16");

    // Fecha o gabarito B via /admin/correct — mesmo endpoint que close-poll.ts chama.
    const sig = await hmacSign("test-admin-secret", `${brand}:${edition}:B`);
    const adminUrl = new URL("https://poll.diaria.workers.dev/admin/correct");
    adminUrl.searchParams.set("edition", edition);
    adminUrl.searchParams.set("answer", "B");
    adminUrl.searchParams.set("sig", sig);
    adminUrl.searchParams.set("brand", brand);
    const adminRes = await worker.fetch(new Request(adminUrl.toString(), { method: "POST" }), env, {} as ExecutionContext);
    assert.equal(adminRes.status, 200);

    // O TESTE CENTRAL: total/voted_b reconciliados pros 34 registros REAIS —
    // o incremento órfão (sem vote: record) não sobrevive à reconciliação.
    const postStats = await (await doStub.fetch("https://internal/stats")).json() as { stats: StatsCounterData };
    assert.equal(postStats.stats.total, 34, "REGRESSÃO #4563: total deve reconciliar pros 34 registros vote: reais, não os 35 do DO drifted");
    assert.equal(postStats.stats.voted_a, 19);
    assert.equal(postStats.stats.voted_b, 15, "REGRESSÃO #4563: voted_b deve reconciliar pra 15 (registros reais), não 16 (drift)");
    assert.equal(postStats.stats.correct_count, 15, "correct_count = voted_b reconciliado — os 15 que escolheram B, gabarito B");

    // O KV espelho também reflete o reconciliado.
    const kvMirror = JSON.parse((await kv.get(`clarice:stats:${edition}`))!) as StatsCounterData;
    assert.deepEqual(kvMirror, { total: 34, voted_a: 19, voted_b: 15, correct_count: 15 });

    // O guard do #4566 (checkCorrectCountSanity) espera correct_count === voted_b
    // pro gabarito B — com o drift reconciliado, os dois batem (15 === 15),
    // então close-poll.ts NÃO sairia mais FATAL pra este ciclo.
    assert.equal(postStats.stats.correct_count, postStats.stats.voted_b);
  });
});
