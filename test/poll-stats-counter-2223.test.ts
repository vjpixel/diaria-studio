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
import { StatsCounter, type IncrementPayload, type StatsCounterData } from "../workers/poll/src/stats-counter.ts";
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
