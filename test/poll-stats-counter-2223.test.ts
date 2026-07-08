/**
 * test/poll-stats-counter-2223.test.ts (#2223)
 *
 * Testes de regressão para a serialização do contador stats edition-wide
 * via Durable Object `StatsCounter`.
 *
 * BUG (#2223, pré-existente): `updateStatsCounter` fazia read-modify-write
 * NÃO-serializado em `stats:{edition}`. O DO `VoteDedup` serializa por email,
 * mas NÃO serializa o contador edition-wide. Sob burst pós-envio, todos os
 * votantes concorrentes liam o mesmo valor stale (KV eventual-consistent) e
 * cada um escrevia +1 → vários incrementos se perdiam → /stats mostraria
 * total errado.
 *
 * FIX: `StatsCounter` DO serializa o increment via `blockConcurrencyWhile`.
 * Uma instância por `{brand}:{edition}` — brand incluído para isolar
 * diaria×clarice (evita colisão quando o mesmo edition-code é usado em
 * brands distintos).
 *
 * ## Cobertura
 * 1. StatsCounter DO isolado: serializa increments concorrentes (sem perda).
 * 2. Brand isolation: `diaria:260613` ≠ `clarice:260613` — contadores distintos.
 * 3. Idempotência do #2229 intacta: guard-key `counted:*:stats` impede re-increment
 *    via DO. O DO serializa o increment; o guard decide SE incrementa.
 * 4. Integração: handleVote usa DO quando binding presente; /stats lê do DO.
 * 5. Fallback: sem binding STATS_COUNTER, comportamento anterior KV preservado.
 * 6. /stats lê do DO (fonte autoritativa) com fallback KV.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StatsCounter, mergeStatsWithKvFallback, type IncrementPayload, type StatsCounterData } from "../workers/poll/src/stats-counter.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makeMockDoState } from "./_helpers/make-mock-do-state.ts";
import type { Env } from "../workers/poll/src/index.ts";

function makeStatsCounter(): StatsCounter {
  return new StatsCounter(makeMockDoState());
}

/** Chama POST /increment no StatsCounter DO. */
async function callIncrement(
  counter: StatsCounter,
  payload: IncrementPayload,
): Promise<{ ok: boolean; stats: StatsCounterData }> {
  const req = new Request("https://internal/increment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const resp = await counter.fetch(req);
  return await resp.json() as { ok: boolean; stats: StatsCounterData };
}

/** Chama GET /stats no StatsCounter DO. */
async function callGetStats(
  counter: StatsCounter,
): Promise<{ ok: boolean; stats: StatsCounterData }> {
  const req = new Request("https://internal/stats", { method: "GET" });
  const resp = await counter.fetch(req);
  return await resp.json() as { ok: boolean; stats: StatsCounterData };
}

// ── Mock de DurableObjectNamespace para StatsCounter ─────────────────────────

function makeStatsCounterNs(): { ns: DurableObjectNamespace; getInstance: (name: string) => StatsCounter | undefined } {
  const instances = new Map<string, StatsCounter>();
  const ns: DurableObjectNamespace = {
    idFromName: (name: string): DurableObjectId => ({ name, toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId): DurableObjectStub => {
      const name = id.toString();
      if (!instances.has(name)) instances.set(name, makeStatsCounter());
      const inst = instances.get(name)!;
      return {
        fetch: (url: RequestInfo, init?: RequestInit) => inst.fetch(new Request(url as string, init)),
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return { ns, getInstance: (name) => instances.get(name) };
}

function makeVoteDedupNs(): DurableObjectNamespace {
  // Minimal stub that always authorizes (firstVote:true) — irrelevante para estes testes,
  // que focam no StatsCounter. Evita dependência circular de import do VoteDedup.
  return {
    idFromName: (name: string): DurableObjectId => ({ name, toString: () => name }) as unknown as DurableObjectId,
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

// ── 1. StatsCounter DO isolado ────────────────────────────────────────────────

describe("StatsCounter DO — incremento serializado (#2223)", () => {
  it("zero increments → GET /stats retorna zeros", async () => {
    const counter = makeStatsCounter();
    const { stats } = await callGetStats(counter);
    assert.equal(stats.total, 0);
    assert.equal(stats.voted_a, 0);
    assert.equal(stats.voted_b, 0);
    assert.equal(stats.correct_count, 0);
  });

  it("1 increment A (acerto) → total=1 voted_a=1 correct_count=1", async () => {
    const counter = makeStatsCounter();
    const { stats } = await callIncrement(counter, { choice: "A", correct: true });
    assert.equal(stats.total, 1, "total deve ser 1");
    assert.equal(stats.voted_a, 1, "voted_a deve ser 1");
    assert.equal(stats.voted_b, 0, "voted_b deve ser 0");
    assert.equal(stats.correct_count, 1, "correct_count deve ser 1");
  });

  it("1 increment B (erro) → total=1 voted_b=1 correct_count=0", async () => {
    const counter = makeStatsCounter();
    const { stats } = await callIncrement(counter, { choice: "B", correct: false });
    assert.equal(stats.total, 1, "total deve ser 1");
    assert.equal(stats.voted_a, 0, "voted_a deve ser 0");
    assert.equal(stats.voted_b, 1, "voted_b deve ser 1");
    assert.equal(stats.correct_count, 0, "correct_count deve ser 0 (errou)");
  });

  it("N increments sequenciais → total acumula corretamente", async () => {
    const counter = makeStatsCounter();
    const votes: IncrementPayload[] = [
      { choice: "A", correct: true },
      { choice: "B", correct: false },
      { choice: "A", correct: null },
      { choice: "B", correct: true },
    ];
    for (const v of votes) await callIncrement(counter, v);
    const { stats } = await callGetStats(counter);
    assert.equal(stats.total, 4, "total deve ser 4");
    assert.equal(stats.voted_a, 2, "voted_a deve ser 2");
    assert.equal(stats.voted_b, 2, "voted_b deve ser 2");
    assert.equal(stats.correct_count, 2, "correct_count deve ser 2 (2 acertos)");
  });

  it("increments concorrentes — blockConcurrencyWhile serializa: sem perda (#2223 core)", async () => {
    /**
     * REGRESSÃO CENTRAL do #2223: sob burst, reads simultâneos do KV retornavam
     * todos o mesmo valor stale → cada request escrevia +1 (perdendo os demais).
     * COM o DO + blockConcurrencyWhile: os increments são serializados — o segundo
     * espera o primeiro completar (incluindo o put) antes de ler o estado.
     * Resultado: todos os incrementos são contados.
     */
    const counter = makeStatsCounter();
    const N = 10;
    const increments = Array.from({ length: N }, (_, i) => ({
      choice: (i % 2 === 0 ? "A" : "B") as "A" | "B",
      correct: i % 3 === 0 as boolean | null,
    }));

    // Promise.all: todos os increments "simultâneos" — serializados pelo mutex do DO
    await Promise.all(increments.map((v) => callIncrement(counter, v)));

    const { stats } = await callGetStats(counter);
    assert.equal(
      stats.total,
      N,
      `total deve ser ${N} (sem perda de incrementos sob burst) — got ${stats.total}`,
    );
    const expectedA = increments.filter((v) => v.choice === "A").length;
    const expectedB = increments.filter((v) => v.choice === "B").length;
    assert.equal(stats.voted_a, expectedA, `voted_a deve ser ${expectedA} — got ${stats.voted_a}`);
    assert.equal(stats.voted_b, expectedB, `voted_b deve ser ${expectedB} — got ${stats.voted_b}`);
  });

  it("sem mutex (storage Map direto) — race expõe perda de incremento (documenta o problema)", async () => {
    /**
     * Demonstra que SEM serialização, dois reads simultâneos do mesmo estado
     * resultam em perda de incremento — análogo ao bug KV original (#2223).
     * O DO + blockConcurrencyWhile corrige exatamente esta janela.
     */
    const storage = new Map<string, StatsCounterData>();

    // Simula dois reads "simultâneos" antes de qualquer write:
    const stateA = storage.get("stats") ?? { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };
    const stateB = storage.get("stats") ?? { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };

    // Ambos veem total=0, ambos escrevem total=1 — o segundo write sobreescreve o primeiro
    stateA.total += 1; stateA.voted_a += 1;
    storage.set("stats", { ...stateA });
    stateB.total += 1; stateB.voted_b += 1;
    storage.set("stats", { ...stateB }); // sobreescreve A

    const finalState = storage.get("stats")!;
    // total é 1, não 2 — um incremento foi perdido
    assert.equal(finalState.total, 1, "SEM mutex: total é 1, não 2 — incremento perdido (documenta o bug)");
    assert.equal(finalState.voted_a, 0, "SEM mutex: voted_a perdido (sobreescrito pelo B)");
    assert.equal(finalState.voted_b, 1, "SEM mutex: apenas o último write sobrevive");
  });
});

// ── 2. Brand isolation ────────────────────────────────────────────────────────

describe("StatsCounter — brand isolation: diaria×clarice não colidem (#2223)", () => {
  it("DO ids distintos para brands distintos com mesmo edition", async () => {
    /**
     * `idFromName(`${brand}:${edition}`)` garante que diaria:260613 e clarice:260613
     * são instâncias DO distintas — contadores edition-wide independentes por brand.
     */
    const { ns, getInstance } = makeStatsCounterNs();

    const diaria = ns.get(ns.idFromName("diaria:260613"));
    const clarice = ns.get(ns.idFromName("clarice:260613"));

    // Incrementa diária 3x
    for (let i = 0; i < 3; i++) {
      await diaria.fetch(new Request("https://internal/increment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice: "A", correct: true }),
      }));
    }

    // Incrementa clarice 1x
    await clarice.fetch(new Request("https://internal/increment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice: "B", correct: false }),
    }));

    // Verificar instâncias são distintas
    const diariaDo = getInstance("diaria:260613");
    const clariceDo = getInstance("clarice:260613");
    assert.ok(diariaDo, "DO para diaria deve existir");
    assert.ok(clariceDo, "DO para clarice deve existir");
    assert.notStrictEqual(diariaDo, clariceDo, "diaria e clarice devem ser instâncias distintas");

    // Ler stats de cada brand
    const diariaStats = await (await diariaDo!.fetch(new Request("https://internal/stats"))).json() as { stats: StatsCounterData };
    const clariceStats = await (await clariceDo!.fetch(new Request("https://internal/stats"))).json() as { stats: StatsCounterData };

    assert.equal(diariaStats.stats.total, 3, "diaria: total deve ser 3 — got " + String(diariaStats.stats.total));
    assert.equal(clariceStats.stats.total, 1, "clarice: total deve ser 1 — got " + String(clariceStats.stats.total));
    assert.equal(diariaStats.stats.voted_a, 3, "diaria: voted_a deve ser 3");
    assert.equal(clariceStats.stats.voted_b, 1, "clarice: voted_b deve ser 1");
  });
});

// ── 3. Idempotência do #2229 intacta ─────────────────────────────────────────

describe("Idempotência #2229 — guard-key impede re-increment via DO (#2223 compat)", () => {
  it("guard-key counted:*:stats presente + retry → stats.total permanece 1 (DO não re-incrementa)", async () => {
    /**
     * O DO serializa o increment — mas é o guard-key no KV que decide SE incrementa.
     * Com guard presente, handleVote pula a chamada ao DO inteiramente.
     * Esta regressão garante que o guard-key continua sendo respeitado com o DO ativo.
     */
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      // Guard-key stats já presente: este votante já foi contado
      "counted:260613:guard@x.com:stats": "1",
      // Stats já com 1 (do voto anterior)
      "stats:260613": JSON.stringify({ total: 1, voted_a: 1, voted_b: 0, correct_count: 0 }),
    });

    const { ns: statsNs } = makeStatsCounterNs();
    // Pré-carrega o DO com total=1 (espelha o KV)
    const doId = statsNs.idFromName("diaria:260613");
    const doStub = statsNs.get(doId);
    await doStub.fetch(new Request("https://internal/increment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice: "A", correct: null }),
    }));

    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      VOTE_DEDUP: makeVoteDedupNs(),
      STATS_COUNTER: statsNs,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "guard@x.com");
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "A");

    await worker.fetch(new Request(url.toString(), { method: "GET" }), env, {} as ExecutionContext);

    // Stats KV não deve ter mudado (guard impediu)
    const statsRaw = await kv.get("stats:260613");
    const stats = JSON.parse(statsRaw!);
    assert.equal(
      stats.total,
      1,
      "guard-key: stats.total deve permanecer 1 — DO não re-incrementou — got: " + String(stats.total),
    );

    // DO também deve permanecer com total=1 (o guard evitou nova chamada ao DO)
    const doStats = await (await doStub.fetch(new Request("https://internal/stats"))).json() as { stats: StatsCounterData };
    assert.equal(
      doStats.stats.total,
      1,
      "DO: total deve permanecer 1 (guard evitou increment) — got: " + String(doStats.stats.total),
    );
  });
});

// ── 4. Integração: handleVote usa DO; /stats lê do DO ────────────────────────

describe("Integração: handleVote com STATS_COUNTER binding (#2223)", () => {
  it("voto novo → stats incrementado no DO + espelhado no KV", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv();
    const { ns: statsNs, getInstance } = makeStatsCounterNs();

    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      VOTE_DEDUP: makeVoteDedupNs(),
      STATS_COUNTER: statsNs,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "integration@x.com");
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "A");

    const res = await worker.fetch(new Request(url.toString(), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(res.status, 200, "voto deve retornar 200");

    // DO deve ter o increment
    const doInst = getInstance("diaria:260613");
    assert.ok(doInst, "instância DO deve ter sido criada");
    const doStats = await (await doInst!.fetch(new Request("https://internal/stats"))).json() as { stats: StatsCounterData };
    assert.equal(doStats.stats.total, 1, "DO: total deve ser 1 após voto — got: " + String(doStats.stats.total));

    // KV deve ter o espelho
    const kvStatsRaw = await kv.get("stats:260613");
    assert.ok(kvStatsRaw, "KV: stats:260613 deve ter sido espelhado");
    const kvStats = JSON.parse(kvStatsRaw!);
    assert.equal(kvStats.total, 1, "KV espelho: total deve ser 1 — got: " + String(kvStats.total));
  });

  it("/stats lê do DO (fonte autoritativa) quando binding presente", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      // KV com valor desatualizado (stale — simula divergência sob burst)
      "stats:260613": JSON.stringify({ total: 0, voted_a: 0, voted_b: 0, correct_count: 0 }),
    });
    const { ns: statsNs, getInstance } = makeStatsCounterNs();

    // Pré-carrega o DO com total=5 (simula votos já registrados no DO)
    const doId = statsNs.idFromName("diaria:260613");
    const doStub = statsNs.get(doId);
    for (let i = 0; i < 5; i++) {
      await doStub.fetch(new Request("https://internal/increment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice: "A", correct: true }),
      }));
    }

    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      VOTE_DEDUP: makeVoteDedupNs(),
      STATS_COUNTER: statsNs,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const statsUrl = new URL("https://poll.diaria.workers.dev/stats");
    statsUrl.searchParams.set("edition", "260613");

    const res = await worker.fetch(new Request(statsUrl.toString(), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const body = await res.json() as { total: number; voted_a: number };
    assert.equal(
      body.total,
      5,
      "/stats deve retornar total do DO (5), não KV stale (0) — got: " + String(body.total),
    );
    assert.equal(body.voted_a, 5, "/stats: voted_a deve ser 5 — got: " + String(body.voted_a));
  });
});

// ── 5. Fallback: sem binding STATS_COUNTER ────────────────────────────────────

describe("Fallback KV: sem binding STATS_COUNTER (#2223 compat)", () => {
  it("sem STATS_COUNTER: updateStatsCounter usa KV RMW (comportamento anterior)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      "stats:260613": JSON.stringify({ total: 1, voted_a: 1, voted_b: 0, correct_count: 0 }),
    });

    // Env SEM STATS_COUNTER
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      VOTE_DEDUP: makeVoteDedupNs(),
      // STATS_COUNTER ausente
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "fallback@x.com");
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "B");

    const res = await worker.fetch(new Request(url.toString(), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(res.status, 200, "fallback KV deve retornar 200");

    // KV deve ter sido atualizado via RMW fallback
    const statsRaw = await kv.get("stats:260613");
    const stats = JSON.parse(statsRaw!);
    assert.equal(stats.total, 2, "fallback KV: total deve ser 2 (1 + 1) — got: " + String(stats.total));
    assert.equal(stats.voted_b, 1, "fallback KV: voted_b deve ser 1 — got: " + String(stats.voted_b));
  });

  it("sem STATS_COUNTER: /stats lê do KV (fallback)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      "stats:260613": JSON.stringify({ total: 7, voted_a: 4, voted_b: 3, correct_count: 5 }),
    });

    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      // STATS_COUNTER e VOTE_DEDUP ausentes
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const statsUrl = new URL("https://poll.diaria.workers.dev/stats");
    statsUrl.searchParams.set("edition", "260613");

    const res = await worker.fetch(new Request(statsUrl.toString(), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const body = await res.json() as { total: number; voted_a: number; voted_b: number };
    assert.equal(body.total, 7, "fallback KV: /stats total deve ser 7 — got: " + String(body.total));
    assert.equal(body.voted_a, 4, "fallback KV: voted_a deve ser 4 — got: " + String(body.voted_a));
    assert.equal(body.voted_b, 3, "fallback KV: voted_b deve ser 3 — got: " + String(body.voted_b));
  });
});

// ── 6. Test Gap: DO 5xx → KV fallback no /stats ──────────────────────────────

describe("Fix #5 — /stats: DO 5xx → fallback KV (não retorna erro ao leitor)", () => {
  it("/stats cai no KV quando DO retorna 5xx", async () => {
    /**
     * Regressão: se o DO retornar 5xx em /stats, o handler deve cair no KV
     * fallback em vez de propagar o erro. O leitor não deve receber 5xx.
     */
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      "stats:260613": JSON.stringify({ total: 42, voted_a: 20, voted_b: 22, correct_count: 15 }),
    });

    // DO que sempre retorna 5xx
    const failingStatsNs: DurableObjectNamespace = {
      idFromName: (name: string): DurableObjectId => ({ name, toString: () => name }) as unknown as DurableObjectId,
      get: (): DurableObjectStub => ({
        fetch: async () => new Response(JSON.stringify({ error: "internal" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace;

    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      STATS_COUNTER: failingStatsNs,
      // VOTE_DEDUP ausente — /stats não precisa dele
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const statsUrl = new URL("https://poll.diaria.workers.dev/stats");
    statsUrl.searchParams.set("edition", "260613");

    const res = await worker.fetch(new Request(statsUrl.toString(), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(res.status, 200, "/stats deve retornar 200 mesmo com DO 5xx — got: " + String(res.status));
    const body = await res.json() as { total: number; voted_a: number; voted_b: number; correct_count: number };
    // Deve ter caído no KV fallback
    assert.equal(body.total, 42, "/stats fallback KV: total deve ser 42 — got: " + String(body.total));
    assert.equal(body.voted_a, 20, "/stats fallback KV: voted_a deve ser 20 — got: " + String(body.voted_a));
    assert.equal(body.correct_count, 15, "/stats fallback KV: correct_count deve ser 15 — got: " + String(body.correct_count));
  });
});

// ── 7. Test Gap: admin-correct atualiza DO → /stats retorna correct_pct correto ──

describe("Fix #6 — admin-correct atualiza DO StatsCounter; /stats reflete correct_pct (#2239)", () => {
  it("após POST /admin/correct, /stats correct_pct calculado sobre correct_count do DO", async () => {
    /**
     * Regressão central: handleAdminCorrect atualizava correct_count só no KV.
     * O /stats lê do DO (fonte autoritativa). Resultado: correct_pct stale no /stats
     * após admin definir gabarito — fix #2 garante que o DO é atualizado também.
     *
     * Fluxo do teste:
     *   1. 3 votos (A, B, A) — sem gabarito ainda (correct=null).
     *   2. Admin define gabarito = "A" via POST /admin/correct.
     *   3. /stats deve retornar correct_count=2 (os que votaram A) e correct_pct=67.
     */
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const { hmacSign } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv();
    const { ns: statsNs } = makeStatsCounterNs();

    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      VOTE_DEDUP: makeVoteDedupNs(),
      STATS_COUNTER: statsNs,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    // 3 votos: emailA (A), emailB (B), emailC (A) — sem gabarito
    const voters = [
      { email: "voter-a@x.com", choice: "A" },
      { email: "voter-b@x.com", choice: "B" },
      { email: "voter-c@x.com", choice: "A" },
    ];
    for (const v of voters) {
      const voteUrl = new URL("https://poll.diaria.workers.dev/vote");
      voteUrl.searchParams.set("email", v.email);
      voteUrl.searchParams.set("edition", "260613");
      voteUrl.searchParams.set("choice", v.choice);
      const res = await worker.fetch(new Request(voteUrl.toString(), { method: "GET" }), env, {} as ExecutionContext);
      assert.equal(res.status, 200, `voto de ${v.email} deve retornar 200`);
    }

    // Admin define gabarito = "A"
    const sig = await hmacSign("test-admin-secret", "260613:A");
    const adminUrl = new URL("https://poll.diaria.workers.dev/admin/correct");
    adminUrl.searchParams.set("edition", "260613");
    adminUrl.searchParams.set("answer", "A");
    adminUrl.searchParams.set("sig", sig);

    const adminRes = await worker.fetch(new Request(adminUrl.toString(), { method: "POST" }), env, {} as ExecutionContext);
    assert.equal(adminRes.status, 200, "admin/correct deve retornar 200 — got: " + String(adminRes.status));
    const adminBody = await adminRes.json() as { ok: boolean; updated_votes: number };
    assert.ok(adminBody.ok, "admin/correct deve retornar ok:true");
    assert.equal(adminBody.updated_votes, 3, "admin/correct: 3 votos atualizados — got: " + String(adminBody.updated_votes));

    // /stats deve refletir correct_count=2 (A, A) e correct_pct=67
    const statsUrl = new URL("https://poll.diaria.workers.dev/stats");
    statsUrl.searchParams.set("edition", "260613");

    const statsRes = await worker.fetch(new Request(statsUrl.toString(), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(statsRes.status, 200, "/stats deve retornar 200");
    const statsBody = await statsRes.json() as {
      total: number;
      correct_count: number;
      correct_pct: number | null;
      correct_answer: string | null;
    };

    assert.equal(statsBody.total, 3, "/stats: total deve ser 3 — got: " + String(statsBody.total));
    assert.equal(statsBody.correct_answer, "A", "/stats: correct_answer deve ser A — got: " + String(statsBody.correct_answer));
    assert.equal(
      statsBody.correct_count,
      2,
      "/stats: correct_count deve ser 2 (DO atualizado pelo admin-correct) — got: " + String(statsBody.correct_count),
    );
    assert.equal(
      statsBody.correct_pct,
      67,
      "/stats: correct_pct deve ser 67 (2/3) — got: " + String(statsBody.correct_pct),
    );
  });
});

// ── 8. Fix #2293 (rewrite de #2245): DO 400 → warn+skip, voto completa (200) ──

describe("Fix #2293 — DO /increment 400 → warn+skip (não throw, não RMW); voto completa com 200", () => {
  it("DO retorna 400 (choice inválido) → StatsCounter retorna 400 e NÃO modifica estado interno", async () => {
    /**
     * Teste isolado do StatsCounter DO:
     * Um payload com choice inválido ("C") deve retornar 400 e não tocar o estado.
     */
    const counter = makeStatsCounter();

    // Incremento com choice válido antes — para ter baseline
    await callIncrement(counter, { choice: "A", correct: true });

    // Tentar incrementar com choice inválido → DO deve retornar 400
    const badReq = new Request("https://internal/increment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice: "C", correct: null }),
    });
    const resp = await counter.fetch(badReq);

    assert.equal(resp.status, 400, "DO deve retornar 400 para choice inválido — got: " + String(resp.status));

    // Estado do DO não deve ter mudado (total ainda 1 do incremento anterior)
    const { stats } = await callGetStats(counter);
    assert.equal(stats.total, 1, "DO: total não deve mudar após 400 — got: " + String(stats.total));
    assert.equal(stats.voted_a, 1, "DO: voted_a não deve mudar — got: " + String(stats.voted_a));
  });

  it("DO retorna 400 → handleVote retorna 200 (voto NÃO perdido), voteKey gravado, KV RMW NÃO ativado", async () => {
    /**
     * REGRESSÃO #2293 self-review HIGH:
     * O fix anterior (#2245) substituiu o KV RMW fallback por throw — correto pra evitar
     * a race, mas incorreto porque o throw propagava não-capturado pelo handleVote:
     *   - votante recebia 500 (não 200)
     *   - voteKey nunca gravado (voto perdido)
     *   - /confirm nunca chamado (DO pendente órfão)
     *
     * Fix #2293: DO 400 → console.warn + return (skip stats) → handleVote continua
     * normalmente: 200 ao votante + voteKey gravado + /confirm chamado.
     *
     * Invariantes verificados:
     *   1. handleVote retorna 200 (voto não é perdido)
     *   2. voteKey `vote:{edition}:{email}` é gravado no KV (commit definitivo)
     *   3. KV stats NÃO é modificado via RMW fallback (race do #2223 não reintroduzida)
     */
    const initialStats = { total: 5, voted_a: 3, voted_b: 2, correct_count: 1 };
    const kv = makeTrackedKv({
      "stats:260613": JSON.stringify(initialStats),
    });

    // Stub STATS_COUNTER que sempre retorna 400 (simula choice inválido chegando ao DO)
    const badChoiceStatsNs: DurableObjectNamespace = {
      idFromName: (name: string): DurableObjectId => ({ name, toString: () => name }) as unknown as DurableObjectId,
      get: (): DurableObjectStub => ({
        fetch: async () => new Response(JSON.stringify({ error: "invalid choice — must be A or B" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace;

    const { default: worker } = await import("../workers/poll/src/index.ts");

    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      VOTE_DEDUP: makeVoteDedupNs(), // autoriza firstVote:true
      STATS_COUNTER: badChoiceStatsNs,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "bad400@x.com");
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "A"); // choice válido no Worker — o DO stub que retorna 400

    let res: Response;
    try {
      res = await worker.fetch(new Request(url.toString(), { method: "GET" }), env, {} as ExecutionContext);
    } catch (e) {
      assert.fail(`handleVote NÃO deve lançar quando DO retorna 400 — mas lançou: ${String(e)}`);
      return;
    }

    // Invariante 1: handleVote deve retornar 200 (voto não perdido)
    assert.equal(
      res!.status,
      200,
      "handleVote deve retornar 200 quando DO retorna 400 (warn+skip stats, vote continua) — got: " + String(res!.status),
    );

    // Invariante 2: voteKey deve ter sido gravado (voto commitado)
    // voteKey = "vote:{edition}:{email}" — exato (sem sufixo de timestamp)
    const voteKeyRaw = await kv.get("vote:260613:bad400@x.com");
    assert.ok(
      voteKeyRaw !== null,
      "voteKey deve ter sido gravado no KV (voto commitado) — vote não foi perdido (#2293)",
    );

    // Invariante 3: KV stats NÃO deve ter sido modificado via RMW fallback
    const statsRaw = await kv.get("stats:260613");
    const stats = statsRaw ? JSON.parse(statsRaw) as typeof initialStats : null;
    assert.ok(stats !== null, "KV stats:260613 deve ainda existir");
    assert.equal(
      stats!.total,
      initialStats.total,
      `KV stats NÃO deve ser modificado via RMW fallback quando DO retorna 400 — got total=${String(stats?.total)} (esperado ${initialStats.total})`,
    );
  });
});

// ── 9. #3115 — DO nunca-seedado retorna zeros mesmo com KV histórico ────────

describe("Fix #3115 — mergeStatsWithKvFallback: DO all-zero ambíguo vs KV histórico", () => {
  it("REGRESSÃO EXATA do bug: DO vazio (never seeded) + KV com total real → retorna o valor do KV", () => {
    /**
     * Cenário reportado ao vivo (260707): /stats?edition=260601 e /stats?edition=260520
     * retornavam total:0 com leaderboard mostrando 32/36 votos. O DO nunca foi
     * seedado a partir do KV pré-existente (edições anteriores ao deploy do
     * StatsCounter DO, #2223) — `stored ?? {total:0,...}` tornava um DO nunca
     * inicializado indistinguível de um DO com zero votos reais.
     *
     * Este é exatamente o teste que faltava (citado na issue #3115): a suíte
     * anterior só cobria DO-vazio+KV-vazio e DO-5xx→KV — nunca DO-ok-mas-zerado
     * com KV populado.
     */
    const doStats: StatsCounterData = { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };
    const kvStats: StatsCounterData = { total: 8, voted_a: 5, voted_b: 3, correct_count: 4 };
    const result = mergeStatsWithKvFallback(doStats, kvStats);
    assert.equal(result.total, 8, "deve retornar o total do KV (8), não o zero ambíguo do DO — got: " + String(result.total));
    assert.deepEqual(result, kvStats, "deve retornar o objeto KV inteiro (campos correlacionados, não mistura per-field)");
  });

  it("caso 'zero real': DO=0 E KV=0 (ou ausente) → permanece 0, NUNCA vira falso-positivo de fallback", () => {
    const doStats: StatsCounterData = { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };

    // KV também zero
    const kvZero: StatsCounterData = { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };
    const resultZero = mergeStatsWithKvFallback(doStats, kvZero);
    assert.equal(resultZero.total, 0, "DO=0 e KV=0: deve permanecer 0 — got: " + String(resultZero.total));

    // KV ausente (edição nova, nunca teve espelho gravado)
    const resultNull = mergeStatsWithKvFallback(doStats, null);
    assert.equal(resultNull.total, 0, "DO=0 e KV ausente: deve permanecer 0 — got: " + String(resultNull.total));
  });

  it("DO com votos reais > KV (KV stale/desatualizado) → mantém o DO (fonte autoritativa pós-deploy)", () => {
    const doStats: StatsCounterData = { total: 10, voted_a: 6, voted_b: 4, correct_count: 7 };
    const kvStatsStale: StatsCounterData = { total: 3, voted_a: 2, voted_b: 1, correct_count: 1 };
    const result = mergeStatsWithKvFallback(doStats, kvStatsStale);
    assert.equal(result.total, 10, "DO à frente do KV: deve manter o DO (autoritativo) — got: " + String(result.total));
    assert.deepEqual(result, doStats);
  });

  it("DO indisponível (null) → usa KV puro; sem KV → zero", () => {
    const kvStats: StatsCounterData = { total: 5, voted_a: 3, voted_b: 2, correct_count: 1 };
    const resultWithKv = mergeStatsWithKvFallback(null, kvStats);
    assert.deepEqual(resultWithKv, kvStats, "DO null: deve retornar KV puro");

    const resultNoKv = mergeStatsWithKvFallback(null, null);
    assert.deepEqual(resultNoKv, { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 }, "DO null e KV ausente: zero");
  });
});

describe("Fix #3115 — /stats (handleStats): DO nunca-seedado + KV histórico → retorna KV (integração)", () => {
  it("edição pré-#2223 (DO nunca incrementado) com KV histórico populado → /stats retorna o valor do KV, não zero", async () => {
    /**
     * Reproduz o bug end-to-end: uma edição publicada ANTES do deploy do
     * StatsCounter DO (#2223) tem votos históricos só no KV `stats:{edition}`.
     * Como ninguém votou de novo nesta edição desde o deploy, o DO para
     * `diaria:260601` nunca foi tocado — GET /stats nele responde zeros
     * (storage nunca inicializado). Antes do fix, handleStats confiava cegamente
     * nesse zero (só caía no KV em erro/5xx do DO). Depois do fix, o merge
     * detecta que o KV tem mais votos e usa o KV.
     */
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      "stats:260601": JSON.stringify({ total: 32, voted_a: 18, voted_b: 14, correct_count: 20 }),
    });
    const { ns: statsNs } = makeStatsCounterNs();
    // Nota: NENHUM /increment é chamado no DO — simula "DO nunca seedado".

    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      STATS_COUNTER: statsNs,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const statsUrl = new URL("https://poll.diaria.workers.dev/stats");
    statsUrl.searchParams.set("edition", "260601");

    const res = await worker.fetch(new Request(statsUrl.toString(), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const body = await res.json() as { total: number; voted_a: number; voted_b: number; correct_count: number };
    assert.equal(body.total, 32, "/stats deve retornar 32 (KV histórico), não 0 (DO nunca seedado) — got: " + String(body.total));
    assert.equal(body.voted_a, 18, "/stats: voted_a deve vir do KV — got: " + String(body.voted_a));
    assert.equal(body.correct_count, 20, "/stats: correct_count deve vir do KV — got: " + String(body.correct_count));
  });

  it("edição realmente sem votos (DO=0 E KV ausente) → /stats retorna 0 (não é falso-positivo)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv(); // sem stats:{edition} — edição nunca teve voto algum
    const { ns: statsNs } = makeStatsCounterNs();

    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      STATS_COUNTER: statsNs,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const statsUrl = new URL("https://poll.diaria.workers.dev/stats");
    statsUrl.searchParams.set("edition", "260707");

    const res = await worker.fetch(new Request(statsUrl.toString(), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const body = await res.json() as { total: number };
    assert.equal(body.total, 0, "edição genuinamente sem votos: /stats deve retornar 0 — got: " + String(body.total));
  });
});

describe("Fix #3115 — updateStatsCounter: seed do DO a partir do KV (voto retroativo não corrompe histórico)", () => {
  it("StatsCounter.handleIncrement: DO nunca inicializado + kvBaseline → seeda do baseline antes de incrementar", async () => {
    const counter = makeStatsCounter();
    const kvBaseline: StatsCounterData = { total: 8, voted_a: 5, voted_b: 3, correct_count: 4 };

    const { stats } = await callIncrement(counter, { choice: "A", correct: true, kvBaseline });
    assert.equal(stats.total, 9, "deve seedar do baseline (8) + 1 = 9 — got: " + String(stats.total));
    assert.equal(stats.voted_a, 6, "voted_a deve ser 6 (5 + 1) — got: " + String(stats.voted_a));
    assert.equal(stats.voted_b, 3, "voted_b deve permanecer 3 (baseline) — got: " + String(stats.voted_b));
    assert.equal(stats.correct_count, 5, "correct_count deve ser 5 (4 + 1) — got: " + String(stats.correct_count));
  });

  it("DO já com estado real (mesmo zerado) → kvBaseline é IGNORADO (nunca sobrescreve estado real do DO)", async () => {
    const counter = makeStatsCounter();
    // Primeiro increment sem baseline — DO passa a ter estado real {total:1,...}.
    await callIncrement(counter, { choice: "B", correct: false });

    // Segundo increment chega com um kvBaseline diferente — deve ser ignorado,
    // pois o DO já tem `stored !== undefined`.
    const { stats } = await callIncrement(counter, {
      choice: "A",
      correct: true,
      kvBaseline: { total: 999, voted_a: 999, voted_b: 999, correct_count: 999 },
    });
    assert.equal(stats.total, 2, "kvBaseline deve ser ignorado quando DO já tem estado real — got: " + String(stats.total));
    assert.equal(stats.voted_b, 1, "voted_b do 1º increment preservado — got: " + String(stats.voted_b));
    assert.equal(stats.voted_a, 1, "voted_a do 2º increment — got: " + String(stats.voted_a));
  });

  it("kvBaseline malformado (shape inválido) → ignora e usa zero (não corrompe estado)", async () => {
    const counter = makeStatsCounter();
    const badBaseline = { total: "oito", voted_a: 5 } as unknown as StatsCounterData;

    const { stats } = await callIncrement(counter, { choice: "A", correct: true, kvBaseline: badBaseline });
    assert.equal(stats.total, 1, "baseline inválido: deve cair em zero + 1 = 1 — got: " + String(stats.total));
  });

  it("INTEGRAÇÃO — voto retroativo (#2867) em edição pré-#2223: DO seeda do KV, espelho não é corrompido", async () => {
    /**
     * Reproduz o "agravante" da issue #3115: o arquivo retroativo (#2867) torna
     * edições antigas votáveis de novo. Um voto em 260601 hoje (DO nunca
     * inicializado, KV com total=32 histórico) NÃO deve fazer o DO "nascer" do
     * zero (0→1) e sobrescrever o KV `stats:260601` com {total:1,...} — isso
     * destruiria o registro histórico correto.
     *
     * Com o fix: updateStatsCounter lê o KV (32) e passa como kvBaseline; o DO
     * seeda a partir dele → total final = 33 (32 + 1 novo voto), espelhado
     * corretamente no KV.
     */
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      // Gabarito definido (close-poll já rodou) — torna a edição votável mesmo
      // fora da janela recente (ver comentário #2867 em handleVote).
      "correct:260601": "A",
      "stats:260601": JSON.stringify({ total: 32, voted_a: 18, voted_b: 14, correct_count: 20 }),
    });
    const { ns: statsNs, getInstance } = makeStatsCounterNs();
    // DO nunca tocado para esta edição — simula "nunca seedado" (pré-#2223).

    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      VOTE_DEDUP: makeVoteDedupNs(), // autoriza firstVote:true
      STATS_COUNTER: statsNs,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "retroativo@x.com");
    url.searchParams.set("edition", "260601");
    url.searchParams.set("choice", "A");

    const res = await worker.fetch(new Request(url.toString(), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(res.status, 200, "voto retroativo deve retornar 200 — got: " + String(res.status));

    // DO deve ter sido seedado do KV (32) + 1 = 33 — não 1.
    const doInst = getInstance("diaria:260601");
    assert.ok(doInst, "instância DO deve ter sido criada");
    const doStats = await (await doInst!.fetch(new Request("https://internal/stats"))).json() as { stats: StatsCounterData };
    assert.equal(doStats.stats.total, 33, "DO deve seedar do KV (32) e incrementar para 33 — got: " + String(doStats.stats.total));

    // KV espelho NÃO deve ter sido corrompido para {total:1,...} — deve refletir 33.
    const kvStatsRaw = await kv.get("stats:260601");
    const kvStatsAfter = JSON.parse(kvStatsRaw!) as StatsCounterData;
    assert.equal(
      kvStatsAfter.total,
      33,
      "KV espelho NÃO deve ser corrompido para 1 — deve refletir o seed (32) + voto novo = 33 — got: " + String(kvStatsAfter.total),
    );

    // /stats também deve refletir 33 (via DO, já corretamente seedado agora).
    const statsUrl = new URL("https://poll.diaria.workers.dev/stats");
    statsUrl.searchParams.set("edition", "260601");
    const statsRes = await worker.fetch(new Request(statsUrl.toString(), { method: "GET" }), env, {} as ExecutionContext);
    const statsBody = await statsRes.json() as { total: number };
    assert.equal(statsBody.total, 33, "/stats pós-voto retroativo deve retornar 33 — got: " + String(statsBody.total));
  });
});

