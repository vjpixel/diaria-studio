/**
 * test/purge-leaderboard-do-4474.test.ts (#4474)
 *
 * BUG: `purge-leaderboard.ts` apaga o KV inteiro de uma identidade (score,
 * score-by-month, vote, counted, seq) mas nunca tocava o storage interno do
 * Durable Object `ScoreCounter` (`workers/poll/src/score-counter.ts`), que é
 * resolvido via `env.SCORE_COUNTER.idFromName(`${brand}:${email}`)` e
 * persiste indefinidamente fora do namespace KV que o purge varre.
 *
 * Cenário de falha concreto: uma identidade purgada vota de novo numa edição
 * do MESMO mês civil já purgado → `handleUpdateMonth` (score-counter.ts) lê
 * o storage interno `seq:{monthSlug}` do DO (nunca purgado, ainda tem
 * entries de votos supostamente apagados) → mescla com o voto novo → o
 * caller (`updateScoreByMonth`, vote.ts) regrava esse mapa mesclado de volta
 * em `seq:{month}:{identity}` no KV — ressuscitando exatamente o dado que o
 * purge deveria ter apagado. Mesma classe de gap pré-existente pra
 * `month:{slug}` (score mensal) e `score` (score global) dentro do DO.
 *
 * FIX:
 * 1. `POST /purge` no DO ScoreCounter — `deleteAll()` sob o mesmo mutex dos
 *    demais endpoints.
 * 2. `POST /admin/purge-score-do` (index.ts) — rota admin HMAC-assinada que
 *    resolve a instância certa (`idFromName(`${brand}:${email}`)`) e chama
 *    `/purge`.
 * 3. `purgeScoreCounterDo` (scripts/lib/purge-score-counter-do.ts) — lógica
 *    pura de assinatura+fetch, extraída pra ser testável com fetch mockado,
 *    consumida por `scripts/purge-leaderboard.ts`.
 *
 * ## Cobertura
 * 1. DO isolado: após popular `score`/`month:*`/`seq:*` via update-score e
 *    update-month, `/purge` limpa TUDO — uma leitura subsequente (mesma
 *    edição/mês) volta a se comportar como DO nunca inicializado.
 * 2. Integração: `/admin/purge-score-do` via worker fetch real — sig válida
 *    chama o DO certo e retorna 200; sig inválida → 403; sem binding
 *    SCORE_COUNTER → fail-soft 503 (nunca lança).
 * 3. `purgeScoreCounterDo` (lib pura) testável com fetch mockado — sem
 *    wrangler, sem rede real.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ScoreCounter, type UpdateScorePayload, type UpdateMonthPayload, type ScoreData, type MonthScoreData } from "../workers/poll/src/score-counter.ts";
import { makeMockDoState } from "./_helpers/make-mock-do-state.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import worker, { hmacSign } from "../workers/poll/src/index.ts";
import type { Env } from "../workers/poll/src/index.ts";
import {
  purgeScoreCounterDo,
  purgeScoreCounterDoSig,
  type PurgeScoreCounterFetchFn,
} from "../scripts/lib/purge-score-counter-do.ts";

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

async function callUpdateMonth(counter: ScoreCounter, payload: UpdateMonthPayload): Promise<{ ok: boolean; month: MonthScoreData; seq: Record<string, boolean | null> }> {
  const req = new Request("https://internal/update-month", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const resp = await counter.fetch(req);
  return await resp.json() as { ok: boolean; month: MonthScoreData; seq: Record<string, boolean | null> };
}

async function callPurge(counter: ScoreCounter): Promise<{ ok: boolean; purged: boolean }> {
  const req = new Request("https://internal/purge", { method: "POST" });
  const resp = await counter.fetch(req);
  return await resp.json() as { ok: boolean; purged: boolean };
}

// ── 1. ScoreCounter DO isolado — /purge limpa TUDO (#4474) ──────────────────

describe("ScoreCounter DO — POST /purge (#4474)", () => {
  it("/purge retorna { ok: true, purged: true }", async () => {
    const counter = makeScoreCounter();
    const { ok, purged } = await callPurge(counter);
    assert.equal(ok, true);
    assert.equal(purged, true);
  });

  it("após update-score, /purge limpa 'score' — próximo update-score se comporta como DO nunca inicializado", async () => {
    const counter = makeScoreCounter();
    await callUpdateScore(counter, { edition: "260601", correct: true, brand: "diaria" });
    await callUpdateScore(counter, { edition: "260602", correct: true, brand: "diaria" });
    // sanity: acumulou 2 antes do purge
    const before = await callUpdateScore(counter, { edition: "260603", correct: true, brand: "diaria" });
    assert.equal(before.score.total, 3);

    await callPurge(counter);

    // Pós-purge: um update-score SEM kvBaseline deve iniciar do zero (total:1),
    // não continuar de 3 — prova que "score" foi de fato apagado do storage.
    const after = await callUpdateScore(counter, { edition: "260701", correct: true, brand: "diaria" });
    assert.equal(after.score.total, 1, "DO deve se comportar como nunca inicializado pós-purge — got total:" + after.score.total);
    assert.equal(after.score.streak, 1, "streak também deve resetar (não continuar de um streak pré-purge)");
  });

  it("após update-month, /purge limpa 'month:{slug}' E o agregado 'seq:{slug}' — REGRESSÃO CENTRAL #4474", async () => {
    const counter = makeScoreCounter();
    await callUpdateMonth(counter, { edition: "260601", monthSlug: "2026-06", correct: true });
    const beforePurge = await callUpdateMonth(counter, { edition: "260602", monthSlug: "2026-06", correct: false });
    assert.equal(beforePurge.month.total, 2);
    assert.equal(Object.keys(beforePurge.seq).length, 2, "sanity: seq deve ter 2 entries antes do purge");
    assert.equal(beforePurge.seq["260601"], true);
    assert.equal(beforePurge.seq["260602"], false);

    await callPurge(counter);

    // Pós-purge: update-month no MESMO monthSlug deve iniciar do zero — total:1
    // (não 3) — e o `seq` deve conter APENAS a edição deste update pós-purge,
    // não mais as 2 anteriores. Esta é a regressão central da issue: antes do
    // fix, `seq:{monthSlug}` sobrevivia ao purge e uma identidade purgada que
    // votasse de novo no mesmo mês ressuscitava as respostas antigas via
    // merge (handleUpdateMonth lê o storage e mescla com o voto novo).
    const after = await callUpdateMonth(counter, { edition: "260603", monthSlug: "2026-06", correct: true });
    assert.equal(after.month.total, 1, "month.total deve reiniciar em 1 pós-purge — got " + after.month.total);
    assert.deepEqual(
      after.seq,
      { "260603": true },
      "seq pós-purge deve conter SÓ a edição do update atual — nenhuma entry das edições purgadas deve ressuscitar",
    );
  });

  it("/purge é serializado sob o MESMO mutex — não corre com um update-month concorrente", async () => {
    const counter = makeScoreCounter();
    await callUpdateMonth(counter, { edition: "260601", monthSlug: "2026-06", correct: true });

    // Dispara purge e um update concorrente "ao mesmo tempo" — blockConcurrencyWhile
    // do mock (fila de promises) garante que um roda só depois do outro
    // terminar, então o resultado final é determinístico (nunca um estado
    // parcialmente misturado).
    const [, afterUpdate] = await Promise.all([
      callPurge(counter),
      callUpdateMonth(counter, { edition: "260602", monthSlug: "2026-06", correct: true }),
    ]);

    // Independente da ORDEM em que o mutex serializou as duas chamadas, o
    // resultado tem que ser consistente: ou o update rodou ANTES do purge
    // (e foi apagado, restando 0 no storage) ou DEPOIS (restando exatamente
    // esse 1 update). Nunca um valor "vazado"/corrompido (ex: >2).
    assert.ok(afterUpdate.month.total >= 1 && afterUpdate.month.total <= 2, `total inesperado sob concorrência: ${afterUpdate.month.total}`);
  });
});

// ── 2. Integração: POST /admin/purge-score-do (index.ts) ────────────────────

function makeScoreCounterNs(): { ns: DurableObjectNamespace; getInstance: (name: string) => ScoreCounter | undefined; calledIds: string[] } {
  const instances = new Map<string, ScoreCounter>();
  const calledIds: string[] = [];
  const ns: DurableObjectNamespace = {
    idFromName: (name: string): DurableObjectId => ({ name, toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId): DurableObjectStub => {
      const name = id.toString();
      calledIds.push(name);
      if (!instances.has(name)) instances.set(name, makeScoreCounter());
      const inst = instances.get(name)!;
      return {
        fetch: (url: RequestInfo, init?: RequestInit) => inst.fetch(new Request(url as string, init)),
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return { ns, getInstance: (name) => instances.get(name), calledIds };
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    POLL: makeTrackedKv() as unknown as Env["POLL"],
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "test-admin-secret",
    ALLOWED_ORIGINS: "*",
    ...overrides,
  };
}

async function callAdminPurge(env: Env, body: unknown): Promise<Response> {
  const req = new Request("https://poll.diaria.workers.dev/admin/purge-score-do", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return worker.fetch(req, env, {} as ExecutionContext);
}

describe("POST /admin/purge-score-do (#4474)", () => {
  it("sig válida → 200, chama o DO ScoreCounter certo (idFromName com {brand}:{email} esperado)", async () => {
    const { ns, calledIds } = makeScoreCounterNs();
    const env = baseEnv({ SCORE_COUNTER: ns });
    const email = "purge-integ@x.com";
    const sig = await hmacSign("test-admin-secret", `purge-score-do:diaria:${email}`);

    const res = await callAdminPurge(env, { email, brand: "diaria", sig });
    assert.equal(res.status, 200);
    const data = await res.json() as { ok: boolean; purged: boolean };
    assert.equal(data.ok, true);
    assert.equal(data.purged, true);
    assert.ok(calledIds.includes(`diaria:${email}`), `deveria resolver a instância diaria:${email} — chamou: ${calledIds.join(", ")}`);
  });

  it("brand ausente no body → default 'diaria' (mesmo default de parseBrandParam)", async () => {
    const { ns, calledIds } = makeScoreCounterNs();
    const env = baseEnv({ SCORE_COUNTER: ns });
    const email = "purge-default-brand@x.com";
    const sig = await hmacSign("test-admin-secret", `purge-score-do:diaria:${email}`);

    const res = await callAdminPurge(env, { email, sig });
    assert.equal(res.status, 200);
    assert.ok(calledIds.includes(`diaria:${email}`));
  });

  it("brand='clarice' resolve a instância clarice:{email}, NÃO diaria:{email}", async () => {
    const { ns, calledIds } = makeScoreCounterNs();
    const env = baseEnv({ SCORE_COUNTER: ns });
    const email = "purge-clarice@x.com";
    const sig = await hmacSign("test-admin-secret", `purge-score-do:clarice:${email}`);

    const res = await callAdminPurge(env, { email, brand: "clarice", sig });
    assert.equal(res.status, 200);
    assert.ok(calledIds.includes(`clarice:${email}`));
    assert.ok(!calledIds.includes(`diaria:${email}`), "NUNCA deve tocar a instância diaria:{email} quando brand=clarice foi pedido");
  });

  it("brand='web' resolve a instância web:{email}, NÃO diaria:{email} (#4477 achado 4 — mesma classe de identidade anônima do #4433, {uuid}@web.eia.diaria.local)", async () => {
    const { ns, calledIds } = makeScoreCounterNs();
    const env = baseEnv({ SCORE_COUNTER: ns });
    const email = "a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c@web.eia.diaria.local";
    const sig = await hmacSign("test-admin-secret", `purge-score-do:web:${email}`);

    const res = await callAdminPurge(env, { email, brand: "web", sig });
    assert.equal(res.status, 200);
    const data = await res.json() as { ok: boolean; purged: boolean };
    assert.equal(data.ok, true);
    assert.equal(data.purged, true);
    assert.ok(calledIds.includes(`web:${email}`), `deveria resolver a instância web:${email} — chamou: ${calledIds.join(", ")}`);
    assert.ok(!calledIds.includes(`diaria:${email}`), "NUNCA deve tocar a instância diaria:{email} quando brand=web foi pedido");
  });

  it("sig inválida → 403, DO nunca é chamado", async () => {
    const { ns, calledIds } = makeScoreCounterNs();
    const env = baseEnv({ SCORE_COUNTER: ns });
    const email = "purge-bad-sig@x.com";

    const res = await callAdminPurge(env, { email, brand: "diaria", sig: "sig-forjada-errada" });
    assert.equal(res.status, 403);
    assert.equal(calledIds.length, 0, "sig inválida não deve nem tentar resolver o DO");
  });

  it("email ausente → 400, sem tentar validar sig", async () => {
    const env = baseEnv({ SCORE_COUNTER: makeScoreCounterNs().ns });
    const sig = await hmacSign("test-admin-secret", "purge-score-do:diaria:");
    const res = await callAdminPurge(env, { brand: "diaria", sig });
    assert.equal(res.status, 400);
  });

  it("sig ausente → 400", async () => {
    const env = baseEnv({ SCORE_COUNTER: makeScoreCounterNs().ns });
    const res = await callAdminPurge(env, { email: "no-sig@x.com", brand: "diaria" });
    assert.equal(res.status, 400);
  });

  it("body não-JSON (parse falha) → 400 { error: 'invalid json body' } (#4477 achado 5)", async () => {
    const env = baseEnv({ SCORE_COUNTER: makeScoreCounterNs().ns });
    const req = new Request("https://poll.diaria.workers.dev/admin/purge-score-do", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "isto não é json",
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    assert.equal(res.status, 400);
    const data = await res.json() as { error?: string };
    assert.equal(data.error, "invalid json body");
  });

  it("SCORE_COUNTER binding ausente → 503 fail-soft, NUNCA lança", async () => {
    const env = baseEnv(); // sem SCORE_COUNTER
    const email = "purge-no-binding@x.com";
    const sig = await hmacSign("test-admin-secret", `purge-score-do:diaria:${email}`);

    const res = await callAdminPurge(env, { email, brand: "diaria", sig });
    assert.equal(res.status, 503, "binding ausente deve responder 503, não lançar/crashar");
    const data = await res.json() as { ok: boolean; error?: string };
    assert.equal(data.ok, false);
    assert.ok(data.error, "deve incluir uma mensagem de erro explicando o binding ausente");
  });

  it("doStub.fetch() lança (timeout/DO indisponível) → 502 fail-soft { ok: false, error: 'score_counter_do_unreachable' }, nunca propaga (self-review #4474)", async () => {
    const throwingNs: DurableObjectNamespace = {
      idFromName: (name: string): DurableObjectId => ({ name, toString: () => name }) as unknown as DurableObjectId,
      get: (): DurableObjectStub => ({
        fetch: async () => {
          throw new Error("DO unreachable (simulated network timeout)");
        },
      }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace;
    const env = baseEnv({ SCORE_COUNTER: throwingNs });
    const email = "purge-do-throws@x.com";
    const sig = await hmacSign("test-admin-secret", `purge-score-do:diaria:${email}`);

    const res = await callAdminPurge(env, { email, brand: "diaria", sig });
    assert.equal(res.status, 502, "doStub.fetch() lançando deve virar 502, não propagar sem captura");
    const data = await res.json() as { ok: boolean; error?: string };
    assert.equal(data.ok, false);
    assert.equal(data.error, "score_counter_do_unreachable");
  });

  it("requiredSecretsForRoute/missingSecretsForRoute exigem ADMIN_SECRET pra esta rota (#1420)", async () => {
    const email = "purge-missing-secret@x.com";
    const env = baseEnv({ SCORE_COUNTER: makeScoreCounterNs().ns, ADMIN_SECRET: "" });
    // sig arbitrária — o guard de secrets (#1420) deve responder 503 ANTES
    // do handler sequer verificar a sig (secret vazio nem chega a assinar).
    const res = await callAdminPurge(env, { email, brand: "diaria", sig: "qualquer-coisa" });
    assert.equal(res.status, 503, "ADMIN_SECRET vazio deve disparar o guard de secrets (#1420), não seguir pro handler");
  });

  it("endpoint aparece listado no 404 handler (contrato de descoberta)", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request("https://poll.diaria.workers.dev/rota-inexistente"), env, {} as ExecutionContext);
    assert.equal(res.status, 404);
    const data = await res.json() as { endpoints: string[] };
    assert.ok(data.endpoints.includes("/admin/purge-score-do"), "endpoint deve estar listado no 404 handler");
  });
});

// ── 3. purgeScoreCounterDo (lib pura, scripts/lib/purge-score-counter-do.ts) ─

describe("purgeScoreCounterDo (#4474) — testável com fetch mockado, sem wrangler/rede real", () => {
  it("assina purge-score-do:{brand}:{email} e chama POST {workerUrl}/admin/purge-score-do com o body correto", async () => {
    const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } }> = [];
    const fetchFn: PurgeScoreCounterFetchFn = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({ ok: true, purged: true }),
        json: async () => ({ ok: true, purged: true }),
      };
    };

    const result = await purgeScoreCounterDo("teste@x.com", "diaria", "segredo", "https://eia.diar.ia.br", fetchFn);

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://eia.diar.ia.br/admin/purge-score-do");
    assert.equal(calls[0].init?.method, "POST");
    const body = JSON.parse(calls[0].init?.body as string) as { email: string; brand: string; sig: string };
    assert.equal(body.email, "teste@x.com");
    assert.equal(body.brand, "diaria");
    assert.equal(body.sig, purgeScoreCounterDoSig("segredo", "diaria", "teste@x.com"));
  });

  it("resposta ok:false do Worker → result.ok=false com error do corpo", async () => {
    const fetchFn: PurgeScoreCounterFetchFn = async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => JSON.stringify({ ok: false, error: "algo deu errado" }),
      json: async () => ({ ok: false, error: "algo deu errado" }),
    });

    const result = await purgeScoreCounterDo("x@y.com", "diaria", "segredo", "https://eia.diar.ia.br", fetchFn);
    assert.equal(result.ok, false);
    assert.equal(result.error, "algo deu errado");
  });

  it("HTTP não-2xx → result.ok=false, error com o status", async () => {
    const fetchFn: PurgeScoreCounterFetchFn = async () => ({
      ok: false,
      status: 403,
      headers: new Map(),
      text: async () => JSON.stringify({ error: "invalid signature" }),
      json: async () => ({ error: "invalid signature" }),
    });

    const result = await purgeScoreCounterDo("x@y.com", "diaria", "segredo-errado", "https://eia.diar.ia.br", fetchFn);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.error, "invalid signature");
  });

  it("corpo não-JSON → não lança, result.ok=false", async () => {
    const fetchFn: PurgeScoreCounterFetchFn = async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => "isto não é json",
      json: async () => { throw new Error("invalid json"); },
    });

    const result = await purgeScoreCounterDo("x@y.com", "diaria", "segredo", "https://eia.diar.ia.br", fetchFn);
    assert.equal(result.ok, false, "corpo corrompido nunca deve ser tratado como sucesso");
  });

  it("fetch lança (rede indisponível) → não propaga, result.ok=false com a mensagem do erro", async () => {
    const fetchFn: PurgeScoreCounterFetchFn = async () => {
      throw new Error("network unreachable");
    };
    const result = await purgeScoreCounterDo("x@y.com", "diaria", "segredo", "https://eia.diar.ia.br", fetchFn);
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.error, "network unreachable");
  });

  it("sig muda por brand — mesmo email, brands diferentes produzem sigs diferentes (proteção replay cross-brand)", () => {
    const sigDiaria = purgeScoreCounterDoSig("segredo", "diaria", "x@y.com");
    const sigClarice = purgeScoreCounterDoSig("segredo", "clarice", "x@y.com");
    assert.notEqual(sigDiaria, sigClarice);
  });
});
