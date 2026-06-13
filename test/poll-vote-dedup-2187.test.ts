/**
 * test/poll-vote-dedup-2187.test.ts (#2187)
 *
 * Testes de regressão para a serialização de dedup de voto via Durable Object.
 *
 * BUG (#2187): dois requests concorrentes do MESMO email podiam ambos passar o
 * guard `existing === null` (lê `vote:{edition}:{email}` no KV eventual-consistente)
 * ANTES do primeiro `put` propagar, gerando double-increment de stats/score e
 * voto duplicado no leaderboard "É IA?".
 *
 * FIX: VoteDedup Durable Object serializa o caminho crítico de dedup+gravação
 * por chave `${edition}:${email}`. O estado de "já votou?" vive no DO storage
 * (fortemente consistente). A decisão de duplicado vem do DO, não do KV eventual.
 *
 * ## Por que a race era possível ANTES do fix
 * - KV `get` retorna null para ambos os requests (eventual consistency — o `put`
 *   do primeiro request ainda não propagou para a réplica lida pelo segundo).
 * - Ambos passam o guard `existing === null` → ambos escrevem → double-vote.
 * - Com o DO: `blockConcurrencyWhile` serializa os dois requests; o 2º vê
 *   `voted=true` no DO storage e é rejeitado.
 *
 * ## Estrutura dos testes
 * 1. Testa a lógica de decisão do VoteDedup DO isoladamente (unitário puro).
 * 2. Testa compat: email com voto KV legacy → DO rejeita re-voto.
 * 3. Testa integração com handleVote via mock DO que demonstra serialização.
 * 4. Documenta o cenário de double-vote SEM o DO (para clareza do fix).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VoteDedup } from "../workers/poll/src/vote-dedup.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import type { Env } from "../workers/poll/src/index.ts";

// ── Mock de DurableObjectState ────────────────────────────────────────────────

/**
 * Mock mínimo de DurableObjectState para testar VoteDedup isoladamente.
 * Usa Map em memória com interface idêntica ao DO storage real.
 *
 * `blockConcurrencyWhile` usa uma fila de promises (mutex) para serializar
 * chamadas concorrentes — espelha o comportamento do runtime CF que processa
 * um request por vez dentro do mesmo DO.
 */
function makeMockDoState(): DurableObjectState {
  const storage = new Map<string, unknown>();

  // Mutex via fila de promises: cada blockConcurrencyWhile encadeia na fila,
  // garantindo que fn() só executa quando a invocação anterior terminar.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return storage.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T): Promise<void> {
        storage.set(key, value);
      },
    } as unknown as DurableObjectStorage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => {
      // Encadeia na fila: aguarda a invocação anterior antes de executar fn().
      // Isso serializa requests concorrentes ao mesmo DO, exatamente como o CF runtime.
      const next = queue.then(() => fn());
      // Atualiza a fila para o próximo blockConcurrencyWhile esperar nesta invocação.
      queue = next.then(() => undefined, () => undefined);
      return next;
    },
  } as unknown as DurableObjectState;
}

/** Cria uma instância de VoteDedup com estado isolado. */
function makeVoteDedup(): VoteDedup {
  return new VoteDedup(makeMockDoState());
}

/** Faz um POST ao DO simulando o request interno do handleVote. */
async function callVoteDedup(
  dedup: VoteDedup,
  opts: { kvVoteExists?: boolean } = {},
): Promise<{ firstVote: boolean }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.kvVoteExists) headers["X-KV-Vote-Exists"] = "1";
  const req = new Request("https://internal/vote-dedup", {
    method: "POST",
    headers,
    body: JSON.stringify({ edition: "260613", email: "test@x.com" }),
  });
  const resp = await dedup.fetch(req);
  return await resp.json() as { firstVote: boolean };
}

// ── 1. Lógica do DO isolada ───────────────────────────────────────────────────

describe("VoteDedup DO — lógica de dedup isolada (#2187)", () => {
  it("primeiro request → firstVote: true (voto autorizado)", async () => {
    const dedup = makeVoteDedup();
    const result = await callVoteDedup(dedup);
    assert.equal(result.firstVote, true, "primeiro request deve ser autorizado");
  });

  it("segundo request com mesmo DO (mesmo email) → firstVote: false (duplicado)", async () => {
    const dedup = makeVoteDedup();
    // Primeiro voto — autorizado
    const first = await callVoteDedup(dedup);
    assert.equal(first.firstVote, true, "primeiro request deve ser autorizado");

    // Segundo voto no mesmo DO — rejeitado
    const second = await callVoteDedup(dedup);
    assert.equal(second.firstVote, false, "segundo request deve ser rejeitado como duplicado");
  });

  it("N requests subsequentes → todos rejeitados (idempotente)", async () => {
    const dedup = makeVoteDedup();
    await callVoteDedup(dedup); // voto 1 — autorizado

    for (let i = 2; i <= 5; i++) {
      const result = await callVoteDedup(dedup);
      assert.equal(result.firstVote, false, `request #${i} deve ser rejeitado como duplicado`);
    }
  });

  it("dois DOs distintos (emails distintos) → ambos retornam firstVote: true", async () => {
    // DOs distintos = instâncias independentes de VoteDedup (cada email tem o seu)
    const dedupA = makeVoteDedup();
    const dedupB = makeVoteDedup();

    const rA = await callVoteDedup(dedupA);
    const rB = await callVoteDedup(dedupB);

    assert.equal(rA.firstVote, true, "email A: primeiro voto deve ser autorizado");
    assert.equal(rB.firstVote, true, "email B: primeiro voto deve ser autorizado (instância independente)");
  });
});

// ── 2. Compat: voto KV legacy → DO rejeita re-voto ───────────────────────────

describe("VoteDedup DO — compat com votos KV legacy (#2187 migration path)", () => {
  it("X-KV-Vote-Exists: 1 → DO rejeita o voto como duplicado (migration path)", async () => {
    const dedup = makeVoteDedup();

    // Simula: email já votou ANTES do deploy do DO (voto existe no KV legacy).
    // Caller detectou o voto no KV e passa X-KV-Vote-Exists: "1".
    const result = await callVoteDedup(dedup, { kvVoteExists: true });
    assert.equal(result.firstVote, false, "voto legado no KV deve ser rejeitado como duplicado");
  });

  it("X-KV-Vote-Exists: 1 → estado DO fica 'voted' para requests subsequentes", async () => {
    const dedup = makeVoteDedup();

    // Primeiro request: KV legacy existe → rejeita e marca como voted no DO
    const first = await callVoteDedup(dedup, { kvVoteExists: true });
    assert.equal(first.firstVote, false, "voto legado deve ser rejeitado");

    // Segundo request: sem KV legacy (DO já tem estado) → também rejeita
    const second = await callVoteDedup(dedup, { kvVoteExists: false });
    assert.equal(second.firstVote, false, "request subsequente deve ser rejeitado pelo estado DO");
  });

  it("sem KV legacy → primeiro request é autorizado (novos votos pós-deploy funcionam)", async () => {
    const dedup = makeVoteDedup();

    // Email novo (sem voto no KV legacy)
    const result = await callVoteDedup(dedup, { kvVoteExists: false });
    assert.equal(result.firstVote, true, "email sem voto legado deve ter o primeiro voto autorizado");
  });
});

// ── 3. Documentação do cenário de double-vote SEM o DO ───────────────────────

describe("Cenário de double-vote SEM DO (documenta por que o fix é necessário) (#2187)", () => {
  it("demonstra que KV eventual permite double-vote: dois gets simultâneos retornam null", async () => {
    /**
     * SEM o DO, o handleVote fazia:
     *   const existing = await env.POLL.get(voteKey);
     *   if (existing) { return "já votou"; }
     *   await env.POLL.put(voteKey, ...); // grava o voto
     *
     * Com KV eventual-consistent, dois requests simultâneos podiam ambos
     * completar o `get` antes de qualquer `put` propagar:
     *
     *   Request A: get(voteKey) → null (voto ainda não existe)
     *   Request B: get(voteKey) → null (propagação pendente — ainda null)
     *   Request A: put(voteKey, {choice: "A"}) — grava
     *   Request B: put(voteKey, {choice: "A"}) — grava de novo = double-vote!
     *
     * Este teste demonstra que com um KV em-memória síncrono (sem a eventual
     * consistency real), dois "requests" sequenciais sem sincronização resultam
     * em dois votos gravados.
     */
    // Simula o estado KV no momento de dois requests "simultâneos" que ambos
    // leram null (antes de qualquer put):
    const kvState = new Map<string, string>();
    const voteKey = "vote:260613:double@x.com";

    // Ambos os "requests" leram null (janela de race)
    const existingA = kvState.get(voteKey) ?? null; // → null
    const existingB = kvState.get(voteKey) ?? null; // → null (mesmo estado)

    // Ambos passam o guard
    assert.equal(existingA, null, "request A: guard passa (null)");
    assert.equal(existingB, null, "request B: guard passa (null) — RACE CONDITION");

    // Ambos gravam → double-vote
    kvState.set(voteKey, JSON.stringify({ choice: "A", ts: "t", correct: null }));
    kvState.set(voteKey, JSON.stringify({ choice: "A", ts: "t", correct: null }));

    // Resultado: chave existe (sobreescrita, mas cada put teria incrementado stats)
    assert.ok(kvState.has(voteKey), "ambos gravaram — double-increment teria ocorrido em stats/score");
  });

  it("COM o DO, dois requests do mesmo email resultam em exatamente 1 voto autorizado", async () => {
    /**
     * COM o DO, os dois requests são serializados no mesmo DO:
     *
     *   Request A: DO.fetch → voted=undefined → put(voted, true) → firstVote: true
     *   Request B: DO.fetch → voted=true → firstVote: false (rejeitado)
     *
     * Mesmo que os dois requests cheguem "ao mesmo tempo" no Worker, o
     * runtime DO processa um de cada vez dentro do blockConcurrencyWhile.
     */
    const dedup = makeVoteDedup();

    // Simula dois requests "concorrentes" (executados em sequência no mock,
    // mas com estado compartilhado — idêntico ao comportamento real do DO)
    const [resultA, resultB] = await Promise.all([
      callVoteDedup(dedup),
      callVoteDedup(dedup),
    ]);

    // Exatamente um deve ser autorizado
    const authorizedCount = [resultA, resultB].filter((r) => r.firstVote).length;
    assert.equal(
      authorizedCount,
      1,
      `exatamente 1 dos 2 requests deve ser autorizado (got: A=${resultA.firstVote}, B=${resultB.firstVote})`,
    );
  });
});

// ── 4. Integração: handleVote com mock DO ────────────────────────────────────

describe("handleVote integração com VOTE_DEDUP binding (#2187)", () => {
  /** Cria env com mock VOTE_DEDUP que usa VoteDedup real (lógica de decisão correta). */
  function makeEnvWithDo(kv: ReturnType<typeof makeTrackedKv>): Env {
    // Map de instâncias DO por nome (simula idFromName + get)
    const doInstances = new Map<string, VoteDedup>();
    const mockDurableObjectNamespace: DurableObjectNamespace = {
      idFromName: (name: string): DurableObjectId => ({ name, toString: () => name }) as unknown as DurableObjectId,
      get: (id: DurableObjectId): DurableObjectStub => {
        const name = id.toString();
        if (!doInstances.has(name)) {
          doInstances.set(name, makeVoteDedup());
        }
        const instance = doInstances.get(name)!;
        return {
          fetch: (url: RequestInfo, init?: RequestInit) =>
            instance.fetch(new Request(url as string, init)),
        } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace;

    return {
      POLL: kv as unknown as KVNamespace,
      VOTE_DEDUP: mockDurableObjectNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };
  }

  it("voto novo: handleVote com DO grava o voto normalmente", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv();
    const env = makeEnvWithDo(kv);

    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "novo@x.com");
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "A");

    const req = new Request(url.toString(), { method: "GET" });
    const res = await worker.fetch(req, env, {} as ExecutionContext);

    assert.equal(res.status, 200, "voto novo deve retornar 200");
    const html = await res.text();
    // Deve mostrar mensagem de voto registrado (não "já votou")
    assert.doesNotMatch(html, /já votou/i, "não deve mostrar 'já votou' para voto novo");

    // O voto deve ter sido gravado no KV
    const voteRaw = await kv.get("vote:260613:novo@x.com");
    assert.ok(voteRaw !== null, "voto deve ter sido gravado no KV");
    const vote = JSON.parse(voteRaw!);
    assert.equal(vote.choice, "A", "voto gravado deve ter choice A");
  });

  it("segundo request do mesmo email → rejeitado como duplicado (1 voto contado)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv();
    const env = makeEnvWithDo(kv);

    const makeVoteUrl = (choice: string) => {
      const url = new URL("https://poll.diaria.workers.dev/vote");
      url.searchParams.set("email", "dup@x.com");
      url.searchParams.set("edition", "260613");
      url.searchParams.set("choice", choice);
      return url.toString();
    };

    // Primeiro voto
    const res1 = await worker.fetch(new Request(makeVoteUrl("A"), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(res1.status, 200, "primeiro voto deve retornar 200");

    // Segundo request do mesmo email — deve ser rejeitado pelo DO
    const res2 = await worker.fetch(new Request(makeVoteUrl("B"), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(res2.status, 200, "segundo request retorna 200 (página 'já votou')");
    const html2 = await res2.text();
    assert.match(html2, /já votou/i, "segundo request deve mostrar 'já votou'");

    // Verificar que apenas 1 voto foi gravado no score (não 2)
    const scoreRaw = await kv.get("score:dup@x.com");
    assert.ok(scoreRaw !== null, "score deve ter sido gravado");
    const score = JSON.parse(scoreRaw!);
    assert.equal(score.total, 1, `score.total deve ser 1 (não 2) — DO serializou o dedup (got ${score.total})`);
  });

  it("email com voto KV legacy → DO rejeita re-voto (migration path)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");

    // KV já tem o voto (gravado ANTES do deploy do DO)
    const kv = makeTrackedKv({
      "vote:260613:legacy@x.com": JSON.stringify({ choice: "A", ts: "2026-06-10T10:00:00Z", correct: null }),
      "score:legacy@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260613", nickname: null }),
    });
    const env = makeEnvWithDo(kv);

    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "legacy@x.com");
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "B"); // tenta votar novamente (diferente)

    const req = new Request(url.toString(), { method: "GET" });
    const res = await worker.fetch(req, env, {} as ExecutionContext);

    assert.equal(res.status, 200, "re-voto de legacy deve retornar 200");
    const html = await res.text();
    assert.match(html, /já votou/i, "re-voto de legacy deve mostrar 'já votou'");

    // O score NÃO deve ter sido re-incrementado (total permanece 1)
    const scoreRaw = await kv.get("score:legacy@x.com");
    const score = JSON.parse(scoreRaw!);
    assert.equal(score.total, 1, `score.total deve permanecer 1 (got ${score.total}) — re-voto legado rejeitado`);
  });

  it("sem VOTE_DEDUP binding (fallback KV): comportamento anterior preservado", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      // Voto existente no KV
      "vote:260613:kv@x.com": JSON.stringify({ choice: "A", ts: "t", correct: null }),
      "score:kv@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260613", nickname: null }),
    });

    // Env SEM VOTE_DEDUP — fallback para comportamento KV-only
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      // VOTE_DEDUP ausente = fallback KV
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "kv@x.com");
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "B");

    const req = new Request(url.toString(), { method: "GET" });
    const res = await worker.fetch(req, env, {} as ExecutionContext);

    assert.equal(res.status, 200, "fallback KV deve retornar 200");
    const html = await res.text();
    // Fallback KV ainda detecta voto existente (KV lento mas eventual)
    assert.match(html, /já votou/i, "fallback KV deve mostrar 'já votou' quando voto existe");
  });
});
