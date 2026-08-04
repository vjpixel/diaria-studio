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
 * `handleAdminCorrect` agora também tallya `total`/`voted_a`/`voted_b` a
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

    // Sanity: antes da correção, o DO (que recebeu o increment órfão direto)
    // tem o drift (total 35, voted_b 16). O simulacro acima chama
    // "/increment" do DO diretamente — não passa por updateStatsCounter
    // (vote.ts), que é quem também escreveria o espelho KV — então o
    // espelho KV NÃO herda esse drift específico: ele já ficou em total:34
    // (correto) depois dos 34 votos reais feitos via /vote acima, e só o DO
    // diverge. Isso é o oposto do que produção mostrou (lá o `vote:` record
    // é quem falta, não o incremento do DO) — mas serve igualmente bem como
    // reprodução do MECANISMO (DO com 1 voto a mais que o KV/registros
    // reais concordam ter) sem precisar simular a interrupção real
    // dentro de vote.ts.
    const preStats = await (await doStub.fetch("https://internal/stats")).json() as { stats: StatsCounterData };
    assert.equal(preStats.stats.total, 35, "sanity: 34 votos reais + 1 órfão = 35");
    assert.equal(preStats.stats.voted_b, 16, "sanity: 15 B reais + 1 B órfão = 16");
    const preKvMirror = JSON.parse((await kv.get(`clarice:stats:${edition}`))!) as StatsCounterData;
    assert.equal(preKvMirror.total, 34, "sanity: o espelho KV não foi tocado pelo increment direto no DO — só os 34 votos reais via /vote passaram por updateStatsCounter");

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

  // #4614 (achado 4 do review fleet, pr-test-analyzer): o teste acima simula
  // o drift chamando `/increment` da DO diretamente, o que deixa só a DO
  // desincronizada (35/16) enquanto o espelho KV já está correto (34) — ver
  // comentário nas linhas 290-300 acima, que documenta essa limitação
  // honestamente. Isso é o OPOSTO do incidente real de produção, onde
  // `updateStatsCounter` escreve DO E KV juntos antes do `vote:` record
  // comitar — então os dois ficam desincronizados JUNTOS, não só a DO. Sem
  // um fixture assim, o log `admin_correct_stats_reconciled_total_shrank`
  // (index.ts) nunca é exercitado por nenhum teste. Este caso pré-semeia o
  // espelho KV com o MESMO drift (35/16) que a DO tem, reproduzindo o
  // mecanismo real e provando que o warning de auditoria dispara.
  it("KV mirror TAMBÉM drifted (não só a DO) — reconciliação reduz total e emite admin_correct_stats_reconciled_total_shrank", async () => {
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

    for (let i = 0; i < 19; i++) {
      const voteUrl = new URL("https://poll.diaria.workers.dev/vote");
      voteUrl.searchParams.set("email", `voter-a2-${i}@x.com`);
      voteUrl.searchParams.set("edition", edition);
      voteUrl.searchParams.set("choice", "A");
      voteUrl.searchParams.set("brand", brand);
      const res = await worker.fetch(new Request(voteUrl.toString(), { method: "GET" }), env, {} as ExecutionContext);
      assert.equal(res.status, 200);
    }
    for (let i = 0; i < 15; i++) {
      const voteUrl = new URL("https://poll.diaria.workers.dev/vote");
      voteUrl.searchParams.set("email", `voter-b2-${i}@x.com`);
      voteUrl.searchParams.set("edition", edition);
      voteUrl.searchParams.set("choice", "B");
      voteUrl.searchParams.set("brand", brand);
      const res = await worker.fetch(new Request(voteUrl.toString(), { method: "GET" }), env, {} as ExecutionContext);
      assert.equal(res.status, 200);
    }

    // Simula o incremento órfão NAS DUAS superfícies — DO (via /increment
    // direto, mesmo mecanismo do teste acima) E o espelho KV (write manual),
    // reproduzindo a assinatura exata do incidente real (updateStatsCounter
    // escreve as duas ANTES do vote: record comitar).
    const doId = statsNs.idFromName(`${brand}:${edition}`);
    const doStub = statsNs.get(doId);
    await doStub.fetch("https://internal/increment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice: "B", correct: null }),
    });
    await kv.put(`clarice:stats:${edition}`, JSON.stringify({ total: 35, voted_a: 19, voted_b: 16, correct_count: 15 }));

    // Sanity: as duas superfícies concordam no drift antes da correção.
    const preStats = await (await doStub.fetch("https://internal/stats")).json() as { stats: StatsCounterData };
    assert.equal(preStats.stats.total, 35);
    const preKvMirror = JSON.parse((await kv.get(`clarice:stats:${edition}`))!) as StatsCounterData;
    assert.equal(preKvMirror.total, 35, "sanity: diferente do teste acima, o espelho KV também está drifted aqui");

    const warnCalls: unknown[][] = [];
    const prevWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    try {
      const sig = await hmacSign("test-admin-secret", `${brand}:${edition}:B`);
      const adminUrl = new URL("https://poll.diaria.workers.dev/admin/correct");
      adminUrl.searchParams.set("edition", edition);
      adminUrl.searchParams.set("answer", "B");
      adminUrl.searchParams.set("sig", sig);
      adminUrl.searchParams.set("brand", brand);
      const adminRes = await worker.fetch(new Request(adminUrl.toString(), { method: "POST" }), env, {} as ExecutionContext);
      assert.equal(adminRes.status, 200);
    } finally {
      console.warn = prevWarn;
    }

    // O warning de auditoria disparou, com os valores prev/new corretos.
    const shrinkWarn = warnCalls.find((args) => typeof args[0] === "string" && args[0].includes("admin_correct_stats_reconciled_total_shrank"));
    assert.ok(shrinkWarn, "esperava console.warn com admin_correct_stats_reconciled_total_shrank");
    const payload = JSON.parse(shrinkWarn![0] as string);
    assert.equal(payload.edition, edition);
    assert.equal(payload.prev_total, 35);
    assert.equal(payload.new_total, 34);

    // E a reconciliação em si continua correta nas duas superfícies.
    const postStats = await (await doStub.fetch("https://internal/stats")).json() as { stats: StatsCounterData };
    assert.equal(postStats.stats.total, 34);
    assert.equal(postStats.stats.voted_b, 15);
    const kvMirror = JSON.parse((await kv.get(`clarice:stats:${edition}`))!) as StatsCounterData;
    assert.deepEqual(kvMirror, { total: 34, voted_a: 19, voted_b: 15, correct_count: 15 });
  });
});

// ── handleAdminCorrect — registro com choice corrompido não entra na reconciliação ──

describe("handleAdminCorrect — vote: record com choice corrompido é excluído do total/voted_a/voted_b (#4563)", () => {
  it("choice fora de A/B (JSON válido, campo corrompido) não infla total sem inflar voted_a+voted_b", async () => {
    const kv = makeTrackedKv({
      // 2 votos legítimos.
      "vote:260801:alice@x.com": JSON.stringify({ choice: "A", ts: "t1", correct: null }),
      "vote:260801:bob@x.com": JSON.stringify({ choice: "B", ts: "t2", correct: null }),
      // Registro corrompido: JSON válido, mas `choice` não é "A" nem "B" —
      // exatamente o caso que o guard `vote.choice === "A" || vote.choice === "B"`
      // (index.ts) existe pra excluir da reconciliação, senão total contaria
      // este voto sem que voted_a+voted_b o contassem também, violando o
      // invariante que isValidReconcileTriple/o DO passam a exigir.
      "vote:260801:corrupt-choice@x.com": JSON.stringify({ choice: "C", ts: "t3", correct: null }),
      // Registro corrompido de outra forma: `choice` ausente.
      "vote:260801:missing-choice@x.com": JSON.stringify({ ts: "t4", correct: null }),
    });
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const sig = await hmacSign("test-admin-secret", "diaria:260801:A");
    const adminUrl = new URL("https://poll.diaria.workers.dev/admin/correct");
    adminUrl.searchParams.set("edition", "260801");
    adminUrl.searchParams.set("answer", "A");
    adminUrl.searchParams.set("sig", sig);
    const adminRes = await worker.fetch(new Request(adminUrl.toString(), { method: "POST" }), env, {} as ExecutionContext);
    assert.equal(adminRes.status, 200);

    // O espelho KV reflete SÓ os 2 votos com choice reconhecido — os 2
    // corrompidos (choice="C" e choice ausente) não contam pra total nem
    // pra voted_a/voted_b, embora tenham sido iterados (e seu campo
    // `correct` re-escrito, ver próxima asserção).
    const kvMirror = JSON.parse((await kv.get("stats:260801"))!) as StatsCounterData;
    assert.deepEqual(
      kvMirror,
      { total: 2, voted_a: 1, voted_b: 1, correct_count: 1 },
      "registros com choice corrompido/ausente não devem inflar total sem inflar voted_a+voted_b",
    );

    // Os registros corrompidos continuam sendo re-avaliados pelo backfill de
    // `correct` (comportamento pré-existente, #2202) — só ficam de fora da
    // reconciliação do AGREGADO, que é o que #4563 mudou.
    const corruptChoice = JSON.parse((await kv.get("vote:260801:corrupt-choice@x.com"))!) as { choice: string; correct: boolean };
    assert.equal(corruptChoice.correct, false, "choice='C' !== answer='A' → correct=false, mas não conta em nenhum dos 4 campos reconciliados");
  });

  // #4614 (achado 2 do review fleet, MEDIUM): registros excluídos por choice
  // inválido eram pulados sem log dedicado, diferente do branch de
  // parse-error acima que já loga `admin_correct_backfill_parse_error`.
  it("registros com choice inválido/ausente disparam admin_correct_backfill_invalid_choice com a contagem correta", async () => {
    const kv = makeTrackedKv({
      "vote:260805:alice@x.com": JSON.stringify({ choice: "A", ts: "t1", correct: null }),
      "vote:260805:bob@x.com": JSON.stringify({ choice: "B", ts: "t2", correct: null }),
      "vote:260805:corrupt-choice@x.com": JSON.stringify({ choice: "C", ts: "t3", correct: null }),
      "vote:260805:missing-choice@x.com": JSON.stringify({ ts: "t4", correct: null }),
    });
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const errorCalls: unknown[][] = [];
    const prevError = console.error;
    console.error = (...args: unknown[]) => { errorCalls.push(args); };
    try {
      const sig = await hmacSign("test-admin-secret", "diaria:260805:A");
      const adminUrl = new URL("https://poll.diaria.workers.dev/admin/correct");
      adminUrl.searchParams.set("edition", "260805");
      adminUrl.searchParams.set("answer", "A");
      adminUrl.searchParams.set("sig", sig);
      const adminRes = await worker.fetch(new Request(adminUrl.toString(), { method: "POST" }), env, {} as ExecutionContext);
      assert.equal(adminRes.status, 200);
    } finally {
      console.error = prevError;
    }

    const invalidChoiceLog = errorCalls.find((args) => typeof args[0] === "string" && args[0].includes("admin_correct_backfill_invalid_choice"));
    assert.ok(invalidChoiceLog, "esperava console.error com admin_correct_backfill_invalid_choice");
    const payload = JSON.parse(invalidChoiceLog![0] as string);
    assert.equal(payload.edition, "260805");
    assert.equal(payload.skipped, 2, "2 registros excluídos: choice='C' e choice ausente");
  });

  it("nenhum registro com choice inválido → admin_correct_backfill_invalid_choice NÃO é logado", async () => {
    const kv = makeTrackedKv({
      "vote:260806:alice@x.com": JSON.stringify({ choice: "A", ts: "t1", correct: null }),
      "vote:260806:bob@x.com": JSON.stringify({ choice: "B", ts: "t2", correct: null }),
    });
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const errorCalls: unknown[][] = [];
    const prevError = console.error;
    console.error = (...args: unknown[]) => { errorCalls.push(args); };
    try {
      const sig = await hmacSign("test-admin-secret", "diaria:260806:A");
      const adminUrl = new URL("https://poll.diaria.workers.dev/admin/correct");
      adminUrl.searchParams.set("edition", "260806");
      adminUrl.searchParams.set("answer", "A");
      adminUrl.searchParams.set("sig", sig);
      const adminRes = await worker.fetch(new Request(adminUrl.toString(), { method: "POST" }), env, {} as ExecutionContext);
      assert.equal(adminRes.status, 200);
    } finally {
      console.error = prevError;
    }

    const invalidChoiceLog = errorCalls.find((args) => typeof args[0] === "string" && args[0].includes("admin_correct_backfill_invalid_choice"));
    assert.equal(invalidChoiceLog, undefined, "sem registros corrompidos, o log não deve disparar");
  });
});

// ── handleAdminCorrect — espelho KV corrompido/ausente é sobrescrito pelo reconciliado ──

describe("handleAdminCorrect — stats:{edition} corrompido ou ausente é sobrescrito pelo agregado reconciliado (#4563)", () => {
  it("espelho KV corrompido (JSON inválido) antes da correção: sobrescrito por inteiro com o agregado reconciliado, não pulado (comportamento pré-#4563 pulava a escrita, ver #3298)", async () => {
    const kv = makeTrackedKv({
      "vote:260802:alice@x.com": JSON.stringify({ choice: "A", ts: "t1", correct: null }),
      "stats:260802": "{ isto não é JSON válido",
    });
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const sig = await hmacSign("test-admin-secret", "diaria:260802:A");
    const adminUrl = new URL("https://poll.diaria.workers.dev/admin/correct");
    adminUrl.searchParams.set("edition", "260802");
    adminUrl.searchParams.set("answer", "A");
    adminUrl.searchParams.set("sig", sig);
    const adminRes = await worker.fetch(new Request(adminUrl.toString(), { method: "POST" }), env, {} as ExecutionContext);
    assert.equal(adminRes.status, 200, "JSON corrompido no espelho não deve derrubar a rota com 500 (#3298 preservado)");

    const kvMirror = JSON.parse((await kv.get("stats:260802"))!) as StatsCounterData;
    assert.deepEqual(
      kvMirror,
      { total: 1, voted_a: 1, voted_b: 0, correct_count: 1 },
      "REGRESSÃO #4563: o espelho corrompido deve ser SOBRESCRITO com o agregado reconciliado — antes do #4563 a escrita era pulada quando o parse falhava, deixando o JSON corrompido intacto",
    );
  });

  it("espelho KV ausente (edição sem NENHUM /vote anterior, admin corrige antes de qualquer voto): cria o espelho do zero", async () => {
    const kv = makeTrackedKv();
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const sig = await hmacSign("test-admin-secret", "diaria:260803:A");
    const adminUrl = new URL("https://poll.diaria.workers.dev/admin/correct");
    adminUrl.searchParams.set("edition", "260803");
    adminUrl.searchParams.set("answer", "A");
    adminUrl.searchParams.set("sig", sig);
    const adminRes = await worker.fetch(new Request(adminUrl.toString(), { method: "POST" }), env, {} as ExecutionContext);
    assert.equal(adminRes.status, 200);

    const kvMirror = JSON.parse((await kv.get("stats:260803"))!) as StatsCounterData;
    assert.deepEqual(kvMirror, { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 }, "espelho criado do zero, sem votos ainda");
  });
});

// ── handleAdminCorrect — write final do espelho KV é fail-soft ──────────────

describe("handleAdminCorrect — write final de stats:{edition} é fail-soft (#4614 achado 1)", () => {
  it("POLL.put do espelho final falha (outage/quota) → rota ainda responde 200 e loga admin_correct_stats_mirror_write_error, em vez de propagar exceção não tratada", async () => {
    const kv = makeTrackedKv({
      "vote:260807:alice@x.com": JSON.stringify({ choice: "A", ts: "t1", correct: null }),
    });
    // #4614: antes do #4563 este write era CONDICIONAL — agora roda sempre e
    // é a ÚLTIMA operação de handleAdminCorrect. Sem try/catch, uma falha
    // transitória de KV propagava sem tratamento (500 cru, sem o log
    // estruturado que o resto do arquivo usa) mesmo já tendo gravado
    // `correct:{edition}` e reconciliado a DO com sucesso. Simula essa falha
    // sobrescrevendo só o `.put` da chave final `stats:{edition}` — as
    // outras chaves (`correct:{edition}`, `vote:*`) continuam funcionando
    // normalmente via o KV tracked por baixo.
    const flakyKv = {
      ...kv,
      async put(key: string, value: string, opts?: { expirationTtl?: number }) {
        if (key === "stats:260807") {
          throw new Error("simulated KV outage");
        }
        return kv.put(key, value, opts);
      },
    };
    const env: Env = {
      POLL: flakyKv as unknown as KVNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const errorCalls: unknown[][] = [];
    const prevError = console.error;
    console.error = (...args: unknown[]) => { errorCalls.push(args); };
    let adminRes: Response;
    try {
      const sig = await hmacSign("test-admin-secret", "diaria:260807:A");
      const adminUrl = new URL("https://poll.diaria.workers.dev/admin/correct");
      adminUrl.searchParams.set("edition", "260807");
      adminUrl.searchParams.set("answer", "A");
      adminUrl.searchParams.set("sig", sig);
      adminRes = await worker.fetch(new Request(adminUrl.toString(), { method: "POST" }), env, {} as ExecutionContext);
    } finally {
      console.error = prevError;
    }

    assert.equal(adminRes!.status, 200, "falha de KV no write final não deve propagar como exceção/500 — fail-soft, mesma filosofia do resto da função");
    const body = await adminRes!.json() as { ok: boolean; edition: string };
    assert.equal(body.ok, true);

    const mirrorWriteErrorLog = errorCalls.find((args) => typeof args[0] === "string" && args[0].includes("admin_correct_stats_mirror_write_error"));
    assert.ok(mirrorWriteErrorLog, "esperava console.error com admin_correct_stats_mirror_write_error");
    const payload = JSON.parse(mirrorWriteErrorLog![0] as string);
    assert.equal(payload.edition, "260807");
    assert.match(payload.error, /simulated KV outage/);

    // correct:{edition} foi gravado antes do write que falhou — a correção
    // de gabarito em si teve efeito, só o espelho final que não persistiu.
    assert.equal(await kv.get("correct:260807"), "A");
  });
});
