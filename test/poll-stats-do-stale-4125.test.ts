/**
 * test/poll-stats-do-stale-4125.test.ts (#4125 item 2)
 *
 * `handleAdminCorrect` (index.ts) atualiza o DO StatsCounter via
 * `POST /adjust-correct` e, se essa chamada falhar, só loga e segue gravando
 * o espelho KV `stats:{edition}` de qualquer forma (fail-soft deliberado,
 * ver Fix #2239). O bug: `mergeStatsWithKvFallback` (stats-counter.ts) só
 * preferia o KV quando `total` divergia entre as duas fontes — mas uma
 * correção de gabarito NUNCA muda `total` (só decide quais votos já
 * registrados contam como corretos). Resultado: `total` sempre EMPATA
 * depois de uma correção, o merge sempre devolvia o DO (com `correct_count`
 * stale), e não havia NENHUM caminho de auto-correção — incrementos normais
 * de voto (`handleIncrement`) só alteram `correct_count` a partir do valor
 * já no DO, nunca resetam do KV.
 *
 * FIX: `stats-do-stale:{edition}` (KV, branded) marca "DO desatualizado
 * aqui" quando `/adjust-correct` falha, e é limpo quando uma correção
 * subsequente tem sucesso. `mergeStatsWithKvFallback` ganha um 3º parâmetro
 * `correctCountStale` — quando true, usa `correct_count` do KV mesmo com
 * `total` empatado (preservando total/voted_a/voted_b do DO, que continuam
 * corretos — só o `/adjust-correct` falhou, não os increments normais).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StatsCounter, mergeStatsWithKvFallback, type StatsCounterData } from "../workers/poll/src/stats-counter.ts";
import worker, { hmacSign, type Env } from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

// ── mergeStatsWithKvFallback (pure) — cobertura direta do novo parâmetro ────

describe("mergeStatsWithKvFallback — correctCountStale (#4125 item 2)", () => {
  it("total empatado + correctCountStale=false (default): continua preferindo o DO (comportamento pré-existente preservado)", () => {
    const doStats: StatsCounterData = { total: 3, voted_a: 2, voted_b: 1, correct_count: 0 };
    const kvStats: StatsCounterData = { total: 3, voted_a: 2, voted_b: 1, correct_count: 2 };
    const result = mergeStatsWithKvFallback(doStats, kvStats);
    assert.equal(result.correct_count, 0, "sem o sinal de staleness, o empate de total continua preferindo o DO");
  });

  it("total empatado + correctCountStale=true: usa correct_count do KV, preserva total/voted_a/voted_b do DO", () => {
    const doStats: StatsCounterData = { total: 3, voted_a: 2, voted_b: 1, correct_count: 0 };
    const kvStats: StatsCounterData = { total: 3, voted_a: 2, voted_b: 1, correct_count: 2 };
    const result = mergeStatsWithKvFallback(doStats, kvStats, true);
    assert.equal(result.correct_count, 2, "REGRESSÃO #4125 item 2: correct_count deve vir do KV quando o DO está marcado stale");
    assert.equal(result.total, 3, "total continua do DO (increments normais não são afetados pela falha do adjust-correct)");
    assert.equal(result.voted_a, 2);
    assert.equal(result.voted_b, 1);
  });

  it("correctCountStale=true mas kvStats ausente: cai de volta pro DO (nada pra preferir)", () => {
    const doStats: StatsCounterData = { total: 3, voted_a: 2, voted_b: 1, correct_count: 0 };
    const result = mergeStatsWithKvFallback(doStats, null, true);
    assert.equal(result.correct_count, 0);
  });

  it("kvStats.total > doStats.total continua tendo prioridade (regra #3115 intacta, correctCountStale não interfere)", () => {
    const doStats: StatsCounterData = { total: 1, voted_a: 1, voted_b: 0, correct_count: 1 };
    const kvStats: StatsCounterData = { total: 5, voted_a: 3, voted_b: 2, correct_count: 3 };
    const result = mergeStatsWithKvFallback(doStats, kvStats, true);
    assert.deepEqual(result, kvStats, "KV histórico maior continua vencendo, mesmo com correctCountStale=true");
  });
});

// ── Fim-a-fim: falha do /adjust-correct não mascara o correct_count no /stats ──

function makeFlakyStatsCounterNs(failAdjustCorrect: { value: boolean }) {
  const instances = new Map<string, StatsCounter>();
  const ns = {
    idFromName: (name: string) => ({ name, toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId): DurableObjectStub => {
      const name = id.toString();
      if (!instances.has(name)) instances.set(name, new StatsCounter(makeMockDoState()));
      const inst = instances.get(name)!;
      return {
        fetch: (url: RequestInfo, init?: RequestInit) => {
          const req = new Request(url as string, init);
          const path = new URL(req.url).pathname;
          if (path === "/adjust-correct" && failAdjustCorrect.value) {
            // Simula o DO indisponível/erro especificamente pro adjust-correct
            // — increments normais continuam funcionando (mesma classe de
            // falha parcial descrita na issue: "correção de gabarito com
            // falha no DO", não um DO totalmente fora do ar).
            return Promise.resolve(new Response(JSON.stringify({ error: "simulated_do_failure" }), { status: 500 }));
          }
          return inst.fetch(req);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return ns;
}

// Mesmo mock mínimo de DurableObjectState usado em poll-jogar-reveal-immediate-3983.test.ts.
function makeMockDoState(): DurableObjectState {
  const storage = new Map<string, unknown>();
  let chain: Promise<unknown> = Promise.resolve();
  return {
    storage: {
      async get(key: string) { return storage.get(key); },
      async put(key: string, value: unknown) { storage.set(key, value); },
      async delete(key: string) { storage.delete(key); },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const run = chain.then(fn, fn);
      chain = run.catch(() => {});
      return run;
    },
  } as unknown as DurableObjectState;
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

describe("handleAdminCorrect + /stats — falha no /adjust-correct não mascara correct_count pra sempre (#4125 item 2)", () => {
  it("REGRESSÃO EXATA: /adjust-correct falha, KV é atualizado, /stats ainda assim reporta correct_count correto", async () => {
    const kv = makeTrackedKv();
    const failFlag = { value: false }; // ainda não falha durante os votos
    const statsNs = makeFlakyStatsCounterNs(failFlag);

    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      VOTE_DEDUP: makeVoteDedupNs(),
      STATS_COUNTER: statsNs,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    // 3 votos SEM gabarito ainda (correct=null em todos — DO correct_count fica 0)
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
      assert.equal(res.status, 200);
    }

    // Agora arma a falha do adjust-correct ANTES da correção do admin.
    failFlag.value = true;

    const sig = await hmacSign("test-admin-secret", "diaria:260613:A");
    const adminUrl = new URL("https://poll.diaria.workers.dev/admin/correct");
    adminUrl.searchParams.set("edition", "260613");
    adminUrl.searchParams.set("answer", "A");
    adminUrl.searchParams.set("sig", sig);
    const adminRes = await worker.fetch(new Request(adminUrl.toString(), { method: "POST" }), env, {} as ExecutionContext);
    assert.equal(adminRes.status, 200, "admin/correct continua respondendo 200 mesmo com o DO falhando (fail-soft)");
    const adminBody = await adminRes.json() as { ok: boolean; updated_votes: number };
    assert.equal(adminBody.updated_votes, 3);

    // Sanity: o KV espelho `stats:{edition}` já reflete correct_count=2 —
    // é o handleAdminCorrect gravando incondicionalmente, mesmo com o DO falho.
    const kvMirror = JSON.parse((await kv.get("stats:260613"))!) as { correct_count: number };
    assert.equal(kvMirror.correct_count, 2, "sanity: espelho KV grava correct_count correto mesmo com DO falhando");

    // Sanity: a flag de staleness foi gravada.
    assert.equal(await kv.get("stats-do-stale:260613"), "1", "flag de staleness deve ter sido gravada após a falha do adjust-correct");

    // O TESTE CENTRAL: /stats deve refletir correct_count=2 (KV), NÃO 0 (DO stale).
    const statsUrl = new URL("https://poll.diaria.workers.dev/stats");
    statsUrl.searchParams.set("edition", "260613");
    const statsRes = await worker.fetch(new Request(statsUrl.toString(), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(statsRes.status, 200);
    const statsBody = await statsRes.json() as { total: number; correct_count: number; correct_pct: number | null };
    assert.equal(statsBody.total, 3, "total continua correto (increments normais não foram afetados)");
    assert.equal(
      statsBody.correct_count,
      2,
      `REGRESSÃO #4125 item 2: /stats deve reportar correct_count=2 (do KV) — recebeu ${statsBody.correct_count} (DO stale mascarando a correção)`,
    );
    assert.equal(statsBody.correct_pct, 67, "67% = round(2/3*100)");
  });

  it("self-healing: uma correção SUBSEQUENTE bem-sucedida limpa a flag de staleness", async () => {
    const kv = makeTrackedKv();
    const failFlag = { value: false };
    const statsNs = makeFlakyStatsCounterNs(failFlag);
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      VOTE_DEDUP: makeVoteDedupNs(),
      STATS_COUNTER: statsNs,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const voteUrl = new URL("https://poll.diaria.workers.dev/vote");
    voteUrl.searchParams.set("email", "voter-a@x.com");
    voteUrl.searchParams.set("edition", "260614");
    voteUrl.searchParams.set("choice", "A");
    await worker.fetch(new Request(voteUrl.toString(), { method: "GET" }), env, {} as ExecutionContext);

    // 1ª correção: DO falha, flag é gravada.
    failFlag.value = true;
    const sig1 = await hmacSign("test-admin-secret", "diaria:260614:A");
    const adminUrl1 = new URL("https://poll.diaria.workers.dev/admin/correct");
    adminUrl1.searchParams.set("edition", "260614");
    adminUrl1.searchParams.set("answer", "A");
    adminUrl1.searchParams.set("sig", sig1);
    await worker.fetch(new Request(adminUrl1.toString(), { method: "POST" }), env, {} as ExecutionContext);
    assert.equal(await kv.get("stats-do-stale:260614"), "1", "flag gravada após a 1ª correção falhar");

    // 2ª correção (ex: editor tenta de novo depois do DO se recuperar):
    // agora o DO responde normalmente — a flag deve ser limpa.
    failFlag.value = false;
    const sig2 = await hmacSign("test-admin-secret", "diaria:260614:B");
    const adminUrl2 = new URL("https://poll.diaria.workers.dev/admin/correct");
    adminUrl2.searchParams.set("edition", "260614");
    adminUrl2.searchParams.set("answer", "B");
    adminUrl2.searchParams.set("sig", sig2);
    const adminRes2 = await worker.fetch(new Request(adminUrl2.toString(), { method: "POST" }), env, {} as ExecutionContext);
    assert.equal(adminRes2.status, 200);
    assert.equal(await kv.get("stats-do-stale:260614"), null, "self-healing: flag deve ser limpa quando o DO responde com sucesso");
  });
});
