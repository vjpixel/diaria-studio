/**
 * test/poll-score-counter-4169.test.ts (#4169, follow-up do #4125 item 1 / #4168)
 *
 * Testes de regressão para a serialização do read-modify-write de
 * `score:{email}` (global) e `score-by-month:{month}:{email}` (mensal) via
 * Durable Object `ScoreCounter`.
 *
 * BUG (#4169, pré-existente mesmo após o #4168): `updateScore`/
 * `updateScoreByMonth` (vote.ts) fazem read-modify-write NÃO-serializado em
 * KV. Dois `runVoteBookkeeping` concorrentes do MESMO email (edições
 * diferentes — o modo sequência permite votar em pares sucessivos
 * rapidamente, e o fast-path #3983 responde ao cliente ANTES de qualquer
 * escrita) podem intercalar entre o `get` e o `put`: o último a gravar
 * sobrescreve o incremento do outro. O #4168 encurtou a janela (releitura
 * fresca de `score:{email}` logo antes do `put`) mas não a eliminou — o
 * `get`+`put` em si continua não-atômico.
 *
 * FIX: `ScoreCounter` DO serializa os dois incrementos via
 * `blockConcurrencyWhile`, mesmo padrão do `StatsCounter` (#2223). Uma
 * instância por `{brand}:{email}`.
 *
 * ## Cobertura
 * 1. ScoreCounter DO isolado: update-score/update-month serializam
 *    increments concorrentes (sem perda), streak calculado corretamente.
 * 2. adjust-correct/adjust-month-correct (sync com correção de gabarito).
 * 3. Brand isolation.
 * 4. REGRESSÃO CENTRAL (#4169): dois `runVoteBookkeeping` concorrentes do
 *    MESMO email (edições diferentes) via `handleVote` fast-path real —
 *    COM o binding SCORE_COUNTER, ambos os incrementos sobrevivem (global E
 *    mensal). SEM o binding (fallback KV), documenta que a race residual
 *    permanece — o fallback é BYTE-A-BYTE a mesma lógica que o código tinha
 *    ANTES deste fix, então essa variante prova que o bug reproduz contra o
 *    código pré-#4169.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleVote } from "../workers/poll/src/vote.ts";
import {
  ScoreCounter,
  type ScoreData,
  type MonthScoreData,
  type UpdateScorePayload,
  type UpdateMonthPayload,
  type AdjustScoreCorrectPayload,
  type AdjustMonthCorrectPayload,
} from "../workers/poll/src/score-counter.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makeMockDoState } from "./_helpers/make-mock-do-state.ts";
import type { Env } from "../workers/poll/src/index.ts";

function makeScoreCounter(): ScoreCounter {
  return new ScoreCounter(makeMockDoState());
}

async function callUpdateScore(counter: ScoreCounter, payload: UpdateScorePayload): Promise<{ ok: boolean; score: ScoreData }> {
  const req = new Request("https://internal/update-score", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const resp = await counter.fetch(req);
  return await resp.json() as { ok: boolean; score: ScoreData };
}

async function callUpdateMonth(counter: ScoreCounter, payload: UpdateMonthPayload): Promise<{ ok: boolean; month: MonthScoreData }> {
  const req = new Request("https://internal/update-month", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const resp = await counter.fetch(req);
  return await resp.json() as { ok: boolean; month: MonthScoreData };
}

async function callAdjustCorrect(counter: ScoreCounter, payload: AdjustScoreCorrectPayload): Promise<{ ok: boolean; adjusted: boolean; score?: ScoreData }> {
  const req = new Request("https://internal/adjust-correct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const resp = await counter.fetch(req);
  return await resp.json() as { ok: boolean; adjusted: boolean; score?: ScoreData };
}

async function callAdjustMonthCorrect(counter: ScoreCounter, payload: AdjustMonthCorrectPayload): Promise<{ ok: boolean; adjusted: boolean; month?: MonthScoreData }> {
  const req = new Request("https://internal/adjust-month-correct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const resp = await counter.fetch(req);
  return await resp.json() as { ok: boolean; adjusted: boolean; month?: MonthScoreData };
}

// ── Mock de DurableObjectNamespace para ScoreCounter ─────────────────────────

function makeScoreCounterNs(): { ns: DurableObjectNamespace; getInstance: (name: string) => ScoreCounter | undefined } {
  const instances = new Map<string, ScoreCounter>();
  const ns: DurableObjectNamespace = {
    idFromName: (name: string): DurableObjectId => ({ name, toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId): DurableObjectStub => {
      const name = id.toString();
      if (!instances.has(name)) instances.set(name, makeScoreCounter());
      const inst = instances.get(name)!;
      return {
        fetch: (url: RequestInfo, init?: RequestInit) => inst.fetch(new Request(url as string, init)),
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return { ns, getInstance: (name) => instances.get(name) };
}

// ── 1. ScoreCounter DO isolado ────────────────────────────────────────────────

describe("ScoreCounter DO — score global serializado (#4169)", () => {
  it("zero updates → sem entry (DO nunca inicializado)", async () => {
    const counter = makeScoreCounter();
    // GET não existe como endpoint — verificamos via update com kvBaseline vazio.
    const { score } = await callUpdateScore(counter, { edition: "260601", correct: null, brand: "diaria" });
    assert.equal(score.total, 1, "1º update-score deve iniciar total em 1");
  });

  it("1 update (acerto) → total=1 correct=1 streak=1", async () => {
    const counter = makeScoreCounter();
    const { score } = await callUpdateScore(counter, { edition: "260601", correct: true, brand: "diaria" });
    assert.equal(score.total, 1);
    assert.equal(score.correct, 1);
    assert.equal(score.streak, 1);
    assert.equal(score.last_edition, "260601");
  });

  it("1 update (erro) → total=1 correct=0 streak=0", async () => {
    const counter = makeScoreCounter();
    const { score } = await callUpdateScore(counter, { edition: "260601", correct: false, brand: "diaria" });
    assert.equal(score.total, 1);
    assert.equal(score.correct, 0);
    assert.equal(score.streak, 0);
  });

  it("streak continua em dias úteis consecutivos (260601 seg → 260602 ter)", async () => {
    const counter = makeScoreCounter();
    await callUpdateScore(counter, { edition: "260601", correct: true, brand: "diaria" }); // segunda
    const { score } = await callUpdateScore(counter, { edition: "260602", correct: true, brand: "diaria" }); // terça
    assert.equal(score.streak, 2, `streak deve continuar em 2 — got ${score.streak}`);
    assert.equal(score.total, 2);
    assert.equal(score.correct, 2);
  });

  it("updates concorrentes — blockConcurrencyWhile serializa: sem perda (#4169 core)", async () => {
    const counter = makeScoreCounter();
    const N = 10;
    const updates = Array.from({ length: N }, (_, i) => ({
      edition: `26060${(i % 9) + 1}`,
      correct: (i % 3 !== 0) as boolean | null,
      brand: "diaria" as const,
    }));

    await Promise.all(updates.map((u) => callUpdateScore(counter, u)));

    const { score } = await callUpdateScore(counter, { edition: "260699", correct: null, brand: "diaria" });
    assert.equal(score.total, N + 1, `total deve ser ${N + 1} (sem perda sob burst) — got ${score.total}`);
  });

  it("kvBaseline seed: DO nunca inicializado usa o baseline do KV (#3115-like)", async () => {
    const counter = makeScoreCounter();
    const kvBaseline: ScoreData = { total: 5, correct: 3, streak: 2, last_edition: "260601" };
    const { score } = await callUpdateScore(counter, { edition: "260602", correct: true, brand: "diaria", kvBaseline });
    assert.equal(score.total, 6, "deve semear do baseline (5) e incrementar");
    assert.equal(score.streak, 3, "streak continua a partir do baseline (260601→260602 é consecutivo)");
  });

  it("kvBaseline NUNCA sobrescreve um estado real já gravado no DO", async () => {
    const counter = makeScoreCounter();
    await callUpdateScore(counter, { edition: "260601", correct: true, brand: "diaria" });
    // Um kvBaseline stale (ex: lido antes deste update) não deve resetar o DO.
    const staleBaseline: ScoreData = { total: 999, correct: 999, streak: 999, last_edition: null };
    const { score } = await callUpdateScore(counter, { edition: "260602", correct: true, brand: "diaria", kvBaseline: staleBaseline });
    assert.equal(score.total, 2, "DO já tinha estado real (total:1) — kvBaseline stale deve ser ignorado");
  });
});

describe("ScoreCounter DO — score mensal serializado (#4169)", () => {
  it("2 updates no MESMO mês (edições diferentes) → total=2 sem perda", async () => {
    const counter = makeScoreCounter();
    await callUpdateMonth(counter, { edition: "260601", monthSlug: "2026-06", correct: true });
    const { month } = await callUpdateMonth(counter, { edition: "260602", monthSlug: "2026-06", correct: false });
    assert.equal(month.total, 2);
    assert.equal(month.correct, 1);
    assert.equal(month.last_edition, "260602");
  });

  it("updates concorrentes (mesmo mês) — blockConcurrencyWhile serializa: sem perda", async () => {
    const counter = makeScoreCounter();
    const N = 8;
    const updates = Array.from({ length: N }, (_, i) => ({
      edition: `26060${(i % 9) + 1}`,
      monthSlug: "2026-06",
      correct: (i % 2 === 0) as boolean | null,
    }));
    await Promise.all(updates.map((u) => callUpdateMonth(counter, u)));
    const { month } = await callUpdateMonth(counter, { edition: "260699", monthSlug: "2026-06", correct: null });
    assert.equal(month.total, N + 1, `total mensal deve ser ${N + 1} (sem perda) — got ${month.total}`);
  });

  it("meses distintos usam storage keys distintas (sem cruzar contadores)", async () => {
    const counter = makeScoreCounter();
    await callUpdateMonth(counter, { edition: "260601", monthSlug: "2026-06", correct: true });
    const { month: julho } = await callUpdateMonth(counter, { edition: "260701", monthSlug: "2026-07", correct: true });
    assert.equal(julho.total, 1, "julho deve começar do zero, independente de junho já ter 1");
  });
});

describe("ScoreCounter DO — adjust-correct / adjust-month-correct (#4169, sincronia pós gabarito)", () => {
  it("adjust-correct: false→true incrementa; DO nunca inicializado → adjusted:false (no-op)", async () => {
    const counter = makeScoreCounter();
    const { adjusted } = await callAdjustCorrect(counter, { prevCorrect: false, newCorrect: true });
    assert.equal(adjusted, false, "DO sem estado prévio não deve criar score do zero via adjust-correct");
  });

  it("adjust-correct: false→true incrementa correct sem tocar total/streak", async () => {
    const counter = makeScoreCounter();
    await callUpdateScore(counter, { edition: "260601", correct: false, brand: "diaria" }); // total=1 correct=0
    const { score, adjusted } = await callAdjustCorrect(counter, { prevCorrect: false, newCorrect: true });
    assert.equal(adjusted, true);
    assert.equal(score!.correct, 1, "correct deve subir pra 1");
    assert.equal(score!.total, 1, "total NÃO deve ser tocado pelo adjust");
  });

  it("adjust-correct: true→false decrementa, clampado em 0", async () => {
    const counter = makeScoreCounter();
    await callUpdateScore(counter, { edition: "260601", correct: false, brand: "diaria" }); // correct=0
    const { score } = await callAdjustCorrect(counter, { prevCorrect: true, newCorrect: false });
    assert.equal(score!.correct, 0, "clamp: nunca fica negativo");
  });

  it("adjust-month-correct: mesma semântica no registro mensal", async () => {
    const counter = makeScoreCounter();
    await callUpdateMonth(counter, { edition: "260601", monthSlug: "2026-06", correct: false });
    const { month, adjusted } = await callAdjustMonthCorrect(counter, { monthSlug: "2026-06", prevCorrect: false, newCorrect: true });
    assert.equal(adjusted, true);
    assert.equal(month!.correct, 1);
    assert.equal(month!.total, 1, "total mensal NÃO deve ser tocado pelo adjust");
  });
});

// ── 3. Brand isolation ────────────────────────────────────────────────────────

describe("ScoreCounter — brand isolation: diaria×clarice não colidem (#4169)", () => {
  it("DO ids distintos para brands distintos com o mesmo email", async () => {
    const { ns, getInstance } = makeScoreCounterNs();
    const diaria = ns.get(ns.idFromName("diaria:jogador@x.com"));
    const clarice = ns.get(ns.idFromName("clarice:jogador@x.com"));

    for (let i = 0; i < 3; i++) {
      await diaria.fetch(new Request("https://internal/update-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edition: `26060${i + 1}`, correct: true, brand: "diaria" }),
      }));
    }
    await clarice.fetch(new Request("https://internal/update-score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: "2606-07", correct: false, brand: "clarice" }),
    }));

    const diariaDo = getInstance("diaria:jogador@x.com");
    const clariceDo = getInstance("clarice:jogador@x.com");
    assert.ok(diariaDo && clariceDo);
    assert.notStrictEqual(diariaDo, clariceDo);

    const diariaResp = await (await diariaDo!.fetch(new Request("https://internal/update-score", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: "260699", correct: null, brand: "diaria" }),
    }))).json() as { score: ScoreData };
    const clariceResp = await (await clariceDo!.fetch(new Request("https://internal/update-score", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: "2606-99", correct: null, brand: "clarice" }),
    }))).json() as { score: ScoreData };

    assert.equal(diariaResp.score.total, 4, "diaria: total deve ser 4 (3 + probe) — got " + String(diariaResp.score.total));
    assert.equal(clariceResp.score.total, 2, "clarice: total deve ser 2 (1 + probe) — got " + String(clariceResp.score.total));
  });
});

// ── 4. REGRESSÃO CENTRAL (#4169): dois votos concorrentes do MESMO email ─────

/**
 * KV em memória cujo GET, ao atingir a N-ésima chamada de `gateOnKey`, CAPTURA
 * o valor da store IMEDIATAMENTE (antes de qualquer delay) mas só RESOLVE a
 * promise depois que `releaseGate()` for chamado pelo teste.
 *
 * Isto modela com fidelidade uma leitura de rede real que demora a responder:
 * o valor devolvido é o que estava lá NO MOMENTO da chamada (podendo já estar
 * "stale" quando finalmente chega ao caller), enquanto outras operações
 * (puts de outro voto concorrente) podem completar livremente durante o
 * delay. É essa combinação — leitura stale + escrita concorrente completando
 * no meio — que reproduz o "lost update" que o #4169 descreve, diferente do
 * helper `makeGatedKv` usado no teste do #4125 (que atrasa o `firstVote`
 * inteiro, não a leitura pontual de uma chave já em andamento).
 */
function makeStaleReadGatedKv(seed: Record<string, string>, gateOnKey: string, gateOnNthCall: number) {
  const store = new Map<string, string>(Object.entries(seed));
  let releaseFn: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { releaseFn = resolve; });
  let callCount = 0;
  let armed = true;
  return {
    async get(key: string) {
      if (key === gateOnKey) {
        callCount++;
        if (armed && callCount === gateOnNthCall) {
          armed = false;
          const snapshot = store.get(key) ?? null; // capturado AGORA — antes do delay
          await gate;
          return snapshot;
        }
      }
      return store.get(key) ?? null;
    },
    async getWithMetadata(key: string) {
      return { value: store.get(key) ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    releaseGate() {
      releaseFn!();
    },
  };
}

function makeRealCtx(): { ctx: ExecutionContext; scheduled: Promise<unknown>[] } {
  const scheduled: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      scheduled.push(p);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { ctx, scheduled };
}

async function flush(scheduled: Promise<unknown>[]): Promise<void> {
  await Promise.all(scheduled);
}

const voteUrl = (email: string, edition: string, choice: string): URL => {
  const u = new URL("https://poll.test/vote");
  u.searchParams.set("email", email);
  u.searchParams.set("edition", edition);
  u.searchParams.set("choice", choice);
  return u;
};

describe("#4169 — race de score:{email} entre dois runVoteBookkeeping concorrentes do MESMO email", () => {
  it("SEM SCORE_COUNTER (fallback KV, mesma lógica de ANTES do #4169): a race REPRODUZ — total fica em 1, não 2", async () => {
    /**
     * Esta variante roda a MESMA lógica que o código tinha antes do #4169
     * (o caminho fallback é byte-a-byte idêntico ao updateScore original) —
     * serve pra provar que, sem o DO, o bug descrito na issue reproduz.
     * Documenta o problema (análogo ao teste "sem mutex" de
     * poll-stats-counter-2223.test.ts) — NÃO é regressão que travamos como
     * "deve ser corrigida" (o fallback é intencionalmente aceito só quando o
     * binding SCORE_COUNTER está ausente, nunca em produção).
     */
    const email = "sequencia-fallback@x.com";
    const editionA = "260602";
    const editionB = "260601";
    // 2ª chamada a score:{email} é a releitura fresca dentro de runVoteBookkeeping
    // (1ª é o pre-read do fast-path, handleVoteFastPath).
    const gatedKv = makeStaleReadGatedKv(
      { [`correct:${editionA}`]: "A", [`correct:${editionB}`]: "A" },
      `score:${email}`,
      2,
    );
    const env = {
      POLL: gatedKv,
      POLL_SECRET: "poll-secret",
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
    } as unknown as Env & { POLL: ReturnType<typeof makeStaleReadGatedKv> };

    const reqA = makeRealCtx();
    const resA = await handleVote(voteUrl(email, editionA, "A"), env, "diaria", env, reqA.ctx);
    assert.match(await resA.text(), /✅ Acertou!/);

    const reqB = makeRealCtx();
    const resB = await handleVote(voteUrl(email, editionB, "A"), env, "diaria", env, reqB.ctx);
    assert.match(await resB.text(), /✅ Acertou!/);
    await flush(reqB.scheduled);

    const afterB = JSON.parse((await env.POLL.get(`score:${email}`))!);
    assert.equal(afterB.total, 1, "sanity: voto B sozinho grava total:1 — voto A continua pendurado no portão");

    gatedKv.releaseGate();
    await flush(reqA.scheduled);

    const final = JSON.parse((await env.POLL.get(`score:${email}`))!);
    assert.equal(
      final.total,
      1,
      `DOCUMENTA #4169: sem SCORE_COUNTER, o voto B se perde — total fica em 1 (deveria ser 2) — got ${final.total}`,
    );
  });

  it("COM SCORE_COUNTER (fix #4169): ambos os votos sobrevivem — total global = 2", async () => {
    const email = "sequencia@x.com";
    const editionA = "260602";
    const editionB = "260601";
    const gatedKv = makeStaleReadGatedKv(
      { [`correct:${editionA}`]: "A", [`correct:${editionB}`]: "A" },
      `score:${email}`,
      2,
    );
    const { ns: scoreNs } = makeScoreCounterNs();
    const env = {
      POLL: gatedKv,
      SCORE_COUNTER: scoreNs,
      POLL_SECRET: "poll-secret",
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
    } as unknown as Env & { POLL: ReturnType<typeof makeStaleReadGatedKv> };

    const reqA = makeRealCtx();
    const resA = await handleVote(voteUrl(email, editionA, "A"), env, "diaria", env, reqA.ctx);
    assert.match(await resA.text(), /✅ Acertou!/);

    const reqB = makeRealCtx();
    const resB = await handleVote(voteUrl(email, editionB, "A"), env, "diaria", env, reqB.ctx);
    assert.match(await resB.text(), /✅ Acertou!/);
    await flush(reqB.scheduled);

    gatedKv.releaseGate();
    await flush(reqA.scheduled);

    const final = JSON.parse((await env.POLL.get(`score:${email}`))!);
    assert.equal(
      final.total,
      2,
      `REGRESSÃO #4169: os dois votos devem somar total:2 (DO serializa o incremento) — recebeu total:${final.total}`,
    );
    assert.equal(final.correct, 2, "ambos os votos foram corretos (gabarito A em ambas as edições)");
  });

  it("COM SCORE_COUNTER (fix #4169): ambos os votos sobrevivem — total MENSAL = 2 (mesmo mês, edições diferentes)", async () => {
    /**
     * editionA=260602 e editionB=260601 caem no MESMO monthSlug (2026-06) —
     * ambos incrementam a MESMA chave score-by-month:2026-06:{email}. Gate na
     * 1ª chamada dessa chave (dentro de updateScoreByMonth, não há pre-read
     * anterior como o global tem via handleVoteFastPath).
     */
    const email = "sequencia-mensal@x.com";
    const editionA = "260602";
    const editionB = "260601";
    const monthKey = "score-by-month:2026-06:sequencia-mensal@x.com";
    const gatedKv = makeStaleReadGatedKv(
      { [`correct:${editionA}`]: "A", [`correct:${editionB}`]: "A" },
      monthKey,
      1,
    );
    const { ns: scoreNs } = makeScoreCounterNs();
    const env = {
      POLL: gatedKv,
      SCORE_COUNTER: scoreNs,
      POLL_SECRET: "poll-secret",
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
    } as unknown as Env & { POLL: ReturnType<typeof makeStaleReadGatedKv> };

    const reqA = makeRealCtx();
    const resA = await handleVote(voteUrl(email, editionA, "A"), env, "diaria", env, reqA.ctx);
    assert.match(await resA.text(), /✅ Acertou!/);

    const reqB = makeRealCtx();
    const resB = await handleVote(voteUrl(email, editionB, "A"), env, "diaria", env, reqB.ctx);
    assert.match(await resB.text(), /✅ Acertou!/);
    await flush(reqB.scheduled);

    gatedKv.releaseGate();
    await flush(reqA.scheduled);

    const final = JSON.parse((await env.POLL.get(monthKey))!);
    assert.equal(
      final.total,
      2,
      `REGRESSÃO #4169 (mensal): os dois votos devem somar total:2 — recebeu total:${final.total}`,
    );
    assert.equal(final.correct, 2, "ambos os votos foram corretos no mês");
  });

  it("SEM SCORE_COUNTER (fallback, mensal): a race REPRODUZ — total mensal fica em 1, não 2", async () => {
    const email = "sequencia-mensal-fallback@x.com";
    const editionA = "260602";
    const editionB = "260601";
    const monthKey = `score-by-month:2026-06:${email}`;
    const gatedKv = makeStaleReadGatedKv(
      { [`correct:${editionA}`]: "A", [`correct:${editionB}`]: "A" },
      monthKey,
      1,
    );
    const env = {
      POLL: gatedKv,
      POLL_SECRET: "poll-secret",
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
    } as unknown as Env & { POLL: ReturnType<typeof makeStaleReadGatedKv> };

    const reqA = makeRealCtx();
    await handleVote(voteUrl(email, editionA, "A"), env, "diaria", env, reqA.ctx);
    const reqB = makeRealCtx();
    await handleVote(voteUrl(email, editionB, "A"), env, "diaria", env, reqB.ctx);
    await flush(reqB.scheduled);

    gatedKv.releaseGate();
    await flush(reqA.scheduled);

    const final = JSON.parse((await env.POLL.get(monthKey))!);
    assert.equal(
      final.total,
      1,
      `DOCUMENTA #4169 (mensal): sem SCORE_COUNTER, o voto B se perde — total fica em 1 (deveria ser 2) — got ${final.total}`,
    );
  });

  it("voto isolado (sem concorrência) continua funcionando normalmente — comportamento pré-existente preservado", async () => {
    const email = "solo-4169@x.com";
    const { ns: scoreNs } = makeScoreCounterNs();
    const env = {
      POLL: makeTrackedKv({ "correct:260601": "A" }),
      SCORE_COUNTER: scoreNs,
      POLL_SECRET: "poll-secret",
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
    } as Env & { POLL: ReturnType<typeof makeTrackedKv> };
    const req = makeRealCtx();
    await handleVote(voteUrl(email, "260601", "A"), env, "diaria", env, req.ctx);
    await flush(req.scheduled);
    const score = JSON.parse((await env.POLL.get(`score:${email}`))!);
    assert.equal(score.total, 1);
    assert.equal(score.correct, 1);
    const month = JSON.parse((await env.POLL.get("score-by-month:2026-06:" + email))!);
    assert.equal(month.total, 1);
    assert.equal(month.correct, 1);
  });
});

// ── 5. Integração: STATS_COUNTER-like guard-key idempotência intacta ────────

describe("Idempotência #2229 (guard-key) — DO ScoreCounter não re-incrementa (#4169 compat)", () => {
  it("guard-key counted:*:score presente + retry → score.total permanece 1 (DO não re-incrementa)", async () => {
    const kv = makeTrackedKv({
      "correct:260613": "A",
      "counted:260613:guard4169@x.com:score": "1",
      "counted:260613:guard4169@x.com:month": "1",
      "counted:260613:guard4169@x.com:stats": "1",
      "score:guard4169@x.com": JSON.stringify({ total: 1, correct: 1, streak: 1, last_edition: "260613", nickname: null }),
    });
    const { ns: scoreNs, getInstance } = makeScoreCounterNs();
    // Pré-carrega o DO com total=1 (espelha o KV)
    const doId = scoreNs.idFromName("diaria:guard4169@x.com");
    const doStub = scoreNs.get(doId);
    await doStub.fetch(new Request("https://internal/update-score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: "260613", correct: true, brand: "diaria" }),
    }));

    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      SCORE_COUNTER: scoreNs,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const req = makeRealCtx();
    await handleVote(voteUrl("guard4169@x.com", "260613", "A"), env, "diaria", env, req.ctx);
    await flush(req.scheduled);

    const scoreRaw = await kv.get("score:guard4169@x.com");
    const score = JSON.parse(scoreRaw!);
    assert.equal(score.total, 1, "guard-key: score.total deve permanecer 1 — DO não re-incrementou — got: " + String(score.total));

    const doInst = getInstance("diaria:guard4169@x.com");
    assert.ok(doInst, "instância DO deve existir (pré-carregada)");
  });
});
