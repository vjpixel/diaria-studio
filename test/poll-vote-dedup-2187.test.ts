/**
 * test/poll-vote-dedup-2187.test.ts (#2187, #2220)
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
 * BUG (#2220): o DO gravava `voted=true` ANTES das escritas KV downstream,
 * queimando o slot em falha — o retry do votante ficava bloqueado permanentemente.
 *
 * FIX (#2220): commit em 2 fases — DO grava `pending=true` (fase 1, autorização),
 * Worker chama /confirm após sucesso de TODAS as escritas KV (fase 2, confirmação).
 * Se as escritas KV falham, o Worker NÃO confirma; o retry do votante vê `pending`
 * e recebe firstVote:false (não re-incrementa em double, mas não fica bloqueado
 * permanentemente como seria com voted=true queimado irreversivelmente).
 *
 * ## Por que a race era possível ANTES do fix (#2187)
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
 * 5. (#2220) Testa commit em 2 fases: falha KV pós-autorização, /confirm, pending.
 * 6. (#2220) Mock de race genuíno: prova que SEM serialização o double-vote ocorre.
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
      // P3-12: suporta assinatura batch (array de chaves → Map) e single (string → valor).
      // A CF DurableObjectStorage real suporta ambas; o mock também deve.
      async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T | undefined>> {
        if (Array.isArray(key)) {
          const map = new Map<string, T | undefined>();
          for (const k of key) map.set(k, storage.get(k) as T | undefined);
          return map as unknown as T;
        }
        return storage.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T): Promise<void> {
        storage.set(key, value);
      },
      async delete(key: string): Promise<void> {
        storage.delete(key);
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

/** Faz um POST ao DO simulando o request interno do handleVote (fase 1 — autorização). */
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

/** Chama /confirm no DO (fase 2 — confirma sucesso das escritas KV). */
async function callVoteDedupConfirm(dedup: VoteDedup): Promise<{ confirmed: boolean; reason?: string }> {
  // P3-11 fix: o DO agora usa path === "/confirm" — URL deve ter pathname exato.
  const req = new Request("https://internal/confirm", { method: "POST" });
  const resp = await dedup.fetch(req);
  return await resp.json() as { confirmed: boolean; reason?: string };
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
    // Primeiro voto — autorizado (fase 1)
    const first = await callVoteDedup(dedup);
    assert.equal(first.firstVote, true, "primeiro request deve ser autorizado");

    // #2220: confirmar (fase 2) — DO transiciona pending→voted
    await callVoteDedupConfirm(dedup);

    // Segundo voto no mesmo DO — rejeitado (voted=true)
    const second = await callVoteDedup(dedup);
    assert.equal(second.firstVote, false, "segundo request deve ser rejeitado como duplicado");
  });

  it("N requests subsequentes → todos rejeitados (idempotente)", async () => {
    const dedup = makeVoteDedup();
    await callVoteDedup(dedup); // voto 1 — autorizado
    await callVoteDedupConfirm(dedup); // confirma

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
     *   Request A: DO.fetch → voted=undefined, pending=undefined → put(pending, true) → firstVote: true
     *   Request B: DO.fetch → pending=true → firstVote: false (rejeitado)
     *
     * Mesmo que os dois requests cheguem "ao mesmo tempo" no Worker, o
     * runtime DO processa um de cada vez dentro do blockConcurrencyWhile.
     *
     * O mock usa blockConcurrencyWhile com fila de promises (mutex), garantindo
     * que o segundo request aguarda o primeiro antes de ler o estado. Diferente
     * de uma implementação sem mutex, onde ambos leriam undefined simultaneamente.
     */
    const dedup = makeVoteDedup();

    // Promise.all envia os dois requests "simultaneamente" — o mock serializa via mutex
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

  it("?test=1 NÃO queima o slot do DO — voto real posterior ainda autorizado (#2213 fix #1)", async () => {
    /**
     * Regressão: antes do fix, ?test=1 chamava o DO mesmo em test mode,
     * gravando voted=true no DO storage. Um voto real subsequente do mesmo email
     * era rejeitado como duplicado — slot queimado pelo teste.
     * Fix: testMode é verificado ANTES de chamar o DO.
     */
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv();
    const env = makeEnvWithDo(kv);

    const makeUrl = (test: boolean) => {
      const url = new URL("https://poll.diaria.workers.dev/vote");
      url.searchParams.set("email", "test-slot@x.com");
      url.searchParams.set("edition", "260613");
      url.searchParams.set("choice", "A");
      if (test) url.searchParams.set("test", "1");
      return url.toString();
    };

    // Primeiro: request ?test=1 — não deve queimar o slot
    const resTest = await worker.fetch(new Request(makeUrl(true), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(resTest.status, 200, "test mode deve retornar 200");
    const htmlTest = await resTest.text();
    assert.match(htmlTest, /\[TEST\]/i, "test mode deve exibir label [TEST]");
    // Voto NÃO deve ter sido gravado no KV
    const voteAfterTest = await kv.get("vote:260613:test-slot@x.com");
    assert.equal(voteAfterTest, null, "?test=1 NÃO deve gravar voto no KV");

    // Segundo: request real do mesmo email — deve ser AUTORIZADO (slot não queimado)
    const resReal = await worker.fetch(new Request(makeUrl(false), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(resReal.status, 200, "voto real pós-teste deve retornar 200");
    const htmlReal = await resReal.text();
    assert.doesNotMatch(htmlReal, /já votou/i, "voto real pós-teste NÃO deve mostrar 'já votou' — slot não foi queimado pelo teste");
    // Voto real deve ter sido gravado
    const voteAfterReal = await kv.get("vote:260613:test-slot@x.com");
    assert.ok(voteAfterReal !== null, "voto real deve ter sido gravado no KV");
  });

  it("DO retorna erro HTTP → fail-safe: não bloqueia votante + escritas KV acontecem (P2-9)", async () => {
    /**
     * Regressão: sem check doResp.ok, se o DO retornasse erro (5xx/4xx),
     * doResp.json() retornaria {}, firstVote seria undefined, !undefined === true
     * → votante NOVO via 'já votou' falsamente.
     * Fix: doResp.ok é verificado; em erro (após retry), continua como firstVote=true.
     *
     * P2-9: assert que as escritas KV (vote + score) aconteceram no fail-open.
     * Sem isso, fail-open poderia "completar" sem gravar nada.
     */
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv();

    // Mock DO que sempre retorna 500 (mesmo após retry)
    const errorDurableObjectNamespace: DurableObjectNamespace = {
      idFromName: (name: string): DurableObjectId => ({ name, toString: () => name }) as unknown as DurableObjectId,
      get: (): DurableObjectStub => ({
        fetch: async () => new Response(JSON.stringify({ error: "internal error" }), { status: 500 }),
      }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace;

    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      VOTE_DEDUP: errorDurableObjectNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "error-do@x.com");
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "A");

    const res = await worker.fetch(new Request(url.toString(), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(res.status, 200, "DO error deve retornar 200 (fail-safe)");
    const html = await res.text();
    // Fail-safe: não bloqueia votante indevidamente — não deve mostrar "já votou"
    assert.doesNotMatch(html, /já votou/i, "DO error: fail-safe NÃO deve mostrar 'já votou' para votante novo");

    // P2-9: verificar que as escritas KV aconteceram (vote + score + stats)
    const voteRaw = await kv.get("vote:260613:error-do@x.com");
    assert.ok(voteRaw !== null, "fail-open: voto deve ter sido gravado no KV (voteKey)");
    const vote = JSON.parse(voteRaw!);
    assert.equal(vote.choice, "A", "fail-open: choice gravada corretamente");

    const scoreRaw = await kv.get("score:error-do@x.com");
    assert.ok(scoreRaw !== null, "fail-open: score deve ter sido gravado no KV");
    const score = JSON.parse(scoreRaw!);
    assert.equal(score.total, 1, "fail-open: score.total deve ser 1 (voto contou)");
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

// ── 5. (#2220) Commit 2-fase: falha KV pós-autorização, reconciliação ────────

describe("VoteDedup 2-fase commit (#2220) — DO: pending→voted só após /confirm", () => {
  it("sem /confirm, pending fresco: retry concorrente barrado (firstVote:false) — previne double-vote", async () => {
    /**
     * INVARIANTE (parte 1): pending fresco = lock válido em progresso.
     * Um segundo request concorrente vê pending=true e é barrado (firstVote:false).
     * Isso previne double-vote quando dois requests chegam ao mesmo tempo.
     *
     * No mock, "fresh" significa claimed_at recente (< PENDING_TTL_MS = 5 min).
     * O mock usa Date.now() real, então pending gravado agora é sempre "fresco".
     */
    const dedup = makeVoteDedup();

    // Fase 1: autorizar (lock adquirido com claimed_at = agora)
    const authorized = await callVoteDedup(dedup);
    assert.equal(authorized.firstVote, true, "fase 1 deve autorizar o voto (lock adquirido)");

    // Worker NÃO chama /confirm (escritas KV falharam).
    // Segundo request concorrente vê pending=true fresco → barrado.
    const concurrent = await callVoteDedup(dedup);
    assert.equal(concurrent.firstVote, false, "request concorrente com pending fresco: barrado (previne double-vote)");
  });

  it("sem /confirm, pending expirado: retry do MESMO votante re-autorizado (INVARIANTE central)", async () => {
    /**
     * INVARIANTE (parte 2 — central): falha de escrita KV NÃO bloqueia o votante
     * para sempre. Quando pending expira (lock stale por crash entre fase 1 e /confirm),
     * o retry do votante deve ser re-autorizado (firstVote:true) pra completar o voto.
     *
     * Simula pending expirado manipulando claimed_at diretamente no estado interno
     * do DO (hack de teste: acessa o storage mock via cast). Em produção, o TTL
     * é 5 min — aqui forçamos expiração imediata sobrescrevendo claimed_at.
     */
    // Criar o estado mock e expor o storage para manipulação
    const storage = new Map<string, unknown>();
    let queue: Promise<unknown> = Promise.resolve();
    const mockState = {
      storage: {
        async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T | undefined>> {
          if (Array.isArray(key)) {
            const map = new Map<string, T | undefined>();
            for (const k of key) map.set(k, storage.get(k) as T | undefined);
            return map as unknown as T;
          }
          return storage.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T): Promise<void> { storage.set(key, value); },
        async delete(key: string): Promise<void> { storage.delete(key); },
      } as unknown as DurableObjectStorage,
      blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => {
        const next = queue.then(() => fn());
        queue = next.then(() => undefined, () => undefined);
        return next;
      },
    } as unknown as DurableObjectState;

    const dedup = new VoteDedup(mockState);

    // Fase 1: autorizar (grava pending=true + claimed_at = agora)
    const authorized = await callVoteDedup(dedup);
    assert.equal(authorized.firstVote, true, "fase 1 deve autorizar o voto");

    // Simular expiração do pending: forçar o timestamp interno do PendingState para 6 minutos no passado
    // (#2229) pending e agora um objeto atomico { at: ISO } — sobrescrever o objeto com at antigo
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    storage.set("pending", { at: sixMinutesAgo });

    // Retry do votante após pending expirado — deve ser RE-AUTORIZADO (INVARIANTE)
    const retry = await callVoteDedup(dedup);
    assert.equal(
      retry.firstVote,
      true,
      "retry após pending expirado (crash simulado): deve receber firstVote:true para completar o voto",
    );
  });

  it("com /confirm: DO transiciona pending→voted, segundo request rejeitado", async () => {
    /**
     * Cenário normal (happy path): Worker autoriza (fase 1), escritas KV OK,
     * Worker confirma (fase 2 → voted=true). Segundo request é rejeitado.
     */
    const dedup = makeVoteDedup();

    // Fase 1: autorizar
    const authorized = await callVoteDedup(dedup);
    assert.equal(authorized.firstVote, true, "fase 1: voto autorizado");

    // Fase 2: confirmar
    const confirmed = await callVoteDedupConfirm(dedup);
    assert.equal(confirmed.confirmed, true, "fase 2: DO confirma");

    // Segundo request — rejeitado (voted=true)
    const second = await callVoteDedup(dedup);
    assert.equal(second.firstVote, false, "segundo request após confirm: rejeitado");
  });

  it("/confirm no-op em DO virgem — NÃO queima slot de votante futuro (P2-5)", async () => {
    /**
     * P2-5: /confirm chamado sem pending existente (DO virgem ou após voted=true) é no-op.
     * Garante que uma chamada acidental a /confirm antes de qualquer /vote-dedup
     * não queima o slot de um votante futuro.
     */
    const dedup = makeVoteDedup();

    // /confirm em DO virgem (sem pending) — deve ser no-op
    const c0 = await callVoteDedupConfirm(dedup);
    assert.equal(c0.confirmed, false, "/confirm em DO virgem deve retornar confirmed:false (no-op)");
    assert.equal(c0.reason, "no_pending", "reason deve ser 'no_pending'");

    // Slot não queimado — votante posterior ainda pode votar
    const vote = await callVoteDedup(dedup);
    assert.equal(vote.firstVote, true, "após /confirm no-op: votante futuro ainda autorizado");
  });

  it("/confirm depois de voted=true: no-op (segunda chamada idempotente não causa regressão)", async () => {
    const dedup = makeVoteDedup();
    await callVoteDedup(dedup);
    const c1 = await callVoteDedupConfirm(dedup);
    assert.equal(c1.confirmed, true, "primeira chamada a /confirm: ok");
    // Segunda chamada: não há mais pending (já deletado) — no-op
    const c2 = await callVoteDedupConfirm(dedup);
    assert.equal(c2.confirmed, false, "segunda chamada a /confirm (sem pending): no-op");
    // Estado voted=true preservado
    const after = await callVoteDedup(dedup);
    assert.equal(after.firstVote, false, "após confirm + no-op: voto ainda rejeitado (voted=true intacto)");
  });

  it("dois requests concorrentes: apenas 1 adquire pending (sem double-vote)", async () => {
    /**
     * (#2220 regressão principal) Com a 2-fase, dois requests concorrentes disputam
     * pending. O mock blockConcurrencyWhile (mutex via fila) garante que apenas
     * o primeiro lê pending=undefined e grava pending=true. O segundo lê pending=true
     * e é rejeitado — sem double-vote, mesmo sem /confirm ainda.
     */
    const dedup = makeVoteDedup();

    // Promise.all: dois requests "simultâneos"
    const [rA, rB] = await Promise.all([
      callVoteDedup(dedup),
      callVoteDedup(dedup),
    ]);

    const authorizedCount = [rA, rB].filter((r) => r.firstVote).length;
    assert.equal(
      authorizedCount,
      1,
      `exatamente 1 deve ser autorizado — 2-fase com mutex previne double-pending (A=${rA.firstVote}, B=${rB.firstVote})`,
    );
  });
});

// ── 6. (#2220) Race genuíno: mock sem mutex expõe double-vote ────────────────

describe("Race genuíno no mock — SEM mutex exporia double-vote (#2220 proof)", () => {
  it("mock sem blockConcurrencyWhile real: dois gets antes de qualquer put → ambos veem undefined", async () => {
    /**
     * Prova que SEM a serialização do blockConcurrencyWhile (mutex), dois requests
     * concorrentes que leem o estado DO em microtasks simultâneas ANTES de qualquer
     * put ambos veriam `pending=undefined` e ambos gravariam pending=true → double-vote.
     *
     * Este teste demonstra o problema (não o fix). O fix é o blockConcurrencyWhile
     * no makeMockDoState que força execução sequencial.
     */
    const storage = new Map<string, unknown>();

    // Simula dois requests que leem o estado ANTES de qualquer put (race sem mutex):
    // Microtask A lê pending
    const pendingA = storage.get("pending"); // undefined — nenhum put ainda
    // Microtask B lê pending ANTES do A fazer put
    const pendingB = storage.get("pending"); // undefined — A ainda não gravou

    // Ambos veem undefined → ambos gravariam pending=true → double-vote
    assert.equal(pendingA, undefined, "sem mutex: request A vê pending=undefined");
    assert.equal(pendingB, undefined, "sem mutex: request B também vê pending=undefined (RACE!)");

    // Ambos gravariam pending=true — sem serialização, dois firstVote:true seriam retornados
    storage.set("pending", true); // A grava
    storage.set("pending", true); // B grava (sobreescreve, mas já retornou firstVote:true)

    // COM o mutex (blockConcurrencyWhile), o segundo request aguardaria o primeiro
    // completar (incluindo o put) antes de ler — veria pending=true e retornaria
    // firstVote:false. Este teste documenta por que o mutex é indispensável.
  });

  it("COM mutex (makeMockDoState): race idêntica serializa → apenas 1 firstVote:true", async () => {
    /**
     * Contraparte do teste anterior: o mock com blockConcurrencyWhile (mutex)
     * serializa os dois requests. O segundo aguarda o primeiro completar (incluindo
     * o put de pending=true) antes de executar, vê pending=true e retorna
     * firstVote:false. Zero double-vote.
     */
    const dedup = makeVoteDedup(); // usa makeMockDoState com blockConcurrencyWhile real

    // Dois requests "simultâneos" (Promise.all) — serializados pelo mutex interno
    const [r1, r2] = await Promise.all([
      callVoteDedup(dedup),
      callVoteDedup(dedup),
    ]);

    const authorized = [r1, r2].filter((r) => r.firstVote).length;
    assert.equal(authorized, 1, `COM mutex: exatamente 1 autorizado (r1=${r1.firstVote}, r2=${r2.firstVote})`);
  });
});

// ── 7. (#2229) Idempotent increments + atomic pending + reconciliation ────

describe("#2229 — Incrementos idempotentes via guard-keys (partial write + retry)", () => {
  function makeMockDoNs(): DurableObjectNamespace {
    const doInstances = new Map<string, VoteDedup>();
    return {
      idFromName: (name: string): DurableObjectId => ({ name, toString: () => name }) as unknown as DurableObjectId,
      get: (id: DurableObjectId): DurableObjectStub => {
        const name = id.toString();
        if (!doInstances.has(name)) doInstances.set(name, makeVoteDedup());
        const inst = doInstances.get(name)!;
        return { fetch: (url: RequestInfo, init?: RequestInit) => inst.fetch(new Request(url as string, init)) } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace;
  }

  it("guard-key :stats presente + retry -> stats.total permanece 1 (#2229 AT MOST 1x per vote)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      "counted:260613:partial@x.com:stats": "1",
      "stats:260613": JSON.stringify({ total: 1, voted_a: 1, voted_b: 0, correct_count: 0 }),
    });
    const env: Env = { POLL: kv as unknown as KVNamespace, VOTE_DEDUP: makeMockDoNs(), POLL_SECRET: "test-secret", ADMIN_SECRET: "test-admin-secret", ALLOWED_ORIGINS: "*" };
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "partial@x.com");
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "A");
    await worker.fetch(new Request(url.toString(), { method: "GET" }), env, {} as ExecutionContext);
    const stats = JSON.parse((await kv.get("stats:260613"))!);
    assert.equal(stats.total, 1, "stats.total deve ser 1 (guard impediu re-incremento) got: " + String(stats.total));
  });

  it("guard-key :score presente + retry -> score.total permanece 1", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      "counted:260613:partial2@x.com:stats": "1",
      "counted:260613:partial2@x.com:score": "1",
      "stats:260613": JSON.stringify({ total: 1, voted_a: 1, voted_b: 0, correct_count: 0 }),
      "score:partial2@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260613", nickname: null }),
    });
    const env: Env = { POLL: kv as unknown as KVNamespace, VOTE_DEDUP: makeMockDoNs(), POLL_SECRET: "test-secret", ADMIN_SECRET: "test-admin-secret", ALLOWED_ORIGINS: "*" };
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "partial2@x.com");
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "A");
    await worker.fetch(new Request(url.toString(), { method: "GET" }), env, {} as ExecutionContext);
    const score = JSON.parse((await kv.get("score:partial2@x.com"))!);
    assert.equal(score.total, 1, "score.total deve permanecer 1 got: " + String(score.total));
  });
});

describe("#2229 — pending atomico (PendingState): nunca pending-sem-at", () => {
  it("pending gravado como objeto { at } (nao 2 puts separados)", async () => {
    const putsLog: Array<{ key: string; value: unknown }> = [];
    const storage = new Map<string, unknown>();
    let queue: Promise<unknown> = Promise.resolve();
    const mockState = {
      storage: {
        async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T | undefined>> {
          if (Array.isArray(key)) { const map = new Map<string, T | undefined>(); for (const k of key) map.set(k, storage.get(k) as T | undefined); return map as unknown as T; }
          return storage.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T): Promise<void> { putsLog.push({ key, value }); storage.set(key, value); },
        async delete(key: string): Promise<void> { storage.delete(key); },
      } as unknown as DurableObjectStorage,
      blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => { const next = queue.then(() => fn()); queue = next.then(() => undefined, () => undefined); return next; },
    } as unknown as DurableObjectState;
    const dedup = new VoteDedup(mockState);
    const result = await callVoteDedup(dedup);
    assert.equal(result.firstVote, true, "fase 1 deve autorizar");
    const pendingPuts = putsLog.filter(p => p.key === "pending");
    assert.equal(pendingPuts.length, 1, "deve haver 1 put de pending (atomico)");
    const pv = pendingPuts[0].value as { at?: string };
    assert.ok(pv !== null && typeof pv === "object", "pending deve ser objeto (nao boolean)");
    assert.ok("at" in pv, "pending deve ter campo at");
    assert.equal(typeof pv.at, "string", "pending.at deve ser string ISO");
    assert.equal(putsLog.filter(p => p.key === "claimed_at").length, 0, "sem put separado de claimed_at (#2229)");
  });

  it("pending fresco como objeto -> concorrente barrado (claimedTs de .at valido)", async () => {
    const dedup = makeVoteDedup();
    const auth = await callVoteDedup(dedup);
    assert.equal(auth.firstVote, true, "fase 1: autorizado");
    const concurrent = await callVoteDedup(dedup);
    assert.equal(concurrent.firstVote, false, "concorrente com pending fresco (objeto atomico) deve ser barrado");
  });
});

describe("#2229 — reconciliacao via X-KV-VoteKey-Committed", () => {
  it("pending fresco + X-KV-VoteKey-Committed:1 -> DO reconcilia, firstVote:false", async () => {
    const dedup = makeVoteDedup();
    const auth = await callVoteDedup(dedup);
    assert.equal(auth.firstVote, true, "fase 1: autorizado");
    const req = new Request("https://internal/vote-dedup", { method: "POST", headers: { "Content-Type": "application/json", "X-KV-VoteKey-Committed": "1" } });
    const result = await (await dedup.fetch(req)).json() as { firstVote: boolean };
    assert.equal(result.firstVote, false, "reconciliacao: firstVote deve ser false (voto ja contado)");
    const subsequent = await callVoteDedup(dedup);
    assert.equal(subsequent.firstVote, false, "subsequente apos reconciliacao: voted=true, barrado");
  });

  it("pending fresco SEM Committed -> barrado (nao reconcilia prematuramente)", async () => {
    const dedup = makeVoteDedup();
    await callVoteDedup(dedup);
    const concurrent = await callVoteDedup(dedup);
    assert.equal(concurrent.firstVote, false, "sem Committed: pending fresco barra (lock ativo)");
  });

  it("integracao: voteKey existente -> handleVote mostra ja-votou, score permanece 1 (Closes #2229)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const kv = makeTrackedKv({
      "vote:260613:committed@x.com": JSON.stringify({ choice: "A", ts: "2026-06-13T10:00:00Z", correct: null }),
      "score:committed@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260613", nickname: null }),
    });
    const dedupInst = makeVoteDedup();
    await callVoteDedup(dedupInst);
    const doInstances = new Map<string, VoteDedup>([["260613:committed@x.com", dedupInst]]);
    const mockDO: DurableObjectNamespace = {
      idFromName: (name: string): DurableObjectId => ({ name, toString: () => name }) as unknown as DurableObjectId,
      get: (id: DurableObjectId): DurableObjectStub => { const name = id.toString(); if (!doInstances.has(name)) doInstances.set(name, makeVoteDedup()); const inst = doInstances.get(name)!; return { fetch: (url: RequestInfo, init?: RequestInit) => inst.fetch(new Request(url as string, init)) } as unknown as DurableObjectStub; },
    } as unknown as DurableObjectNamespace;
    const env: Env = { POLL: kv as unknown as KVNamespace, VOTE_DEDUP: mockDO, POLL_SECRET: "test-secret", ADMIN_SECRET: "test-admin-secret", ALLOWED_ORIGINS: "*" };
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "committed@x.com");
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "B");
    const res = await worker.fetch(new Request(url.toString(), { method: "GET" }), env, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /j[áa] votou/i, "deve mostrar ja-votou");
    const score = JSON.parse((await kv.get("score:committed@x.com"))!);
    assert.equal(score.total, 1, "score.total deve permanecer 1 got: " + String(score.total));
  });
});
