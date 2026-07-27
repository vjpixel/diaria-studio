/**
 * test/poll-vote-fastpath-score-race-4125.test.ts (#4125 item 1)
 *
 * `handleVoteFastPath` lê `score:{email}` UMA VEZ (o snapshot congelado) e
 * repassa esse valor pro `runVoteBookkeeping` agendado via `ctx.waitUntil` —
 * a contabilidade completa (dedup DO, guard-keys, updateScore) roda em
 * BACKGROUND, bem depois da resposta já ter sido enviada ao jogador. Antes
 * do fix, `updateScore` usava esse valor pré-lido e NUNCA relia — dois votos
 * do MESMO leitor em edições DIFERENTES (o modo sequência permite votar
 * rápido, par após par) com bookkeepings sobrepostos faziam o `updateScore`
 * que termina por ÚLTIMO sobrescrever `score:{email}` inteiro com base no
 * snapshot já obsoleto, perdendo o incremento do voto que terminou primeiro.
 *
 * FIX (mitigação, não eliminação — ver rationale completo no header de
 * `runVoteBookkeeping`, vote.ts): a IIFE de score dentro de
 * `runVoteBookkeeping` relê `score:{email}` FRESCO logo antes de chamar
 * `updateScore`, em vez de usar o parâmetro `scoreRaw` congelado desde
 * `handleVoteFastPath`. Isso encurta a janela de "vida inteira do request"
 * pra "logo antes da escrita" — mesma classe de exposição residual que
 * `updateScoreByMonth`/`updateStatsCounter` (pré-DO) já aceitam, mas fecha o
 * caso mais grave (janela cobrindo TODA a contabilidade de OUTRO voto).
 *
 * Fechar de vez exigiria serialização real (Durable Object dedicado, mesmo
 * padrão de VOTE_DEDUP/STATS_COUNTER) — fora do escopo deste lote (P2 num
 * conjunto de itens P3), reportado como follow-up.
 *
 * DETERMINISMO: sem I/O real, uma promise "agendada em background" via
 * ctx.waitUntil() na verdade drena até o fim assim que QUALQUER outro await
 * subsequente cede o controle pro event loop — ao contrário de produção
 * (round-trips de rede reais), não há uma "janela" observável por pura
 * ordem de chamadas. Por isso este teste usa um KV com um "portão" manual:
 * a leitura do guard-key de stats do voto A fica pendurada até o teste
 * liberar explicitamente, permitindo forçar com certeza total que o
 * bookkeeping do voto B (edição diferente) complete list ANTES do voto A
 * prosseguir pro seu updateScore — exatamente a janela que a issue descreve.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleVote } from "../workers/poll/src/vote.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import type { Env } from "../workers/poll/src/index.ts";

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

/**
 * KV em memória com um "portão" manual: a PRIMEIRA leitura de `gateOnKey`
 * fica pendurada (não resolve) até `releaseGate()` ser chamado pelo teste.
 * Todas as outras chaves/leituras funcionam normalmente, sem atraso.
 */
function makeGatedKv(seed: Record<string, string>, gateOnKey: string) {
  const store = new Map<string, string>(Object.entries(seed));
  let releaseFn: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { releaseFn = resolve; });
  let gateArmed = true;
  return {
    async get(key: string) {
      if (key === gateOnKey && gateArmed) {
        gateArmed = false; // só a 1ª leitura pendura — retries não travariam de novo
        await gate;
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

const voteUrl = (email: string, edition: string, choice: string): URL => {
  const u = new URL("https://poll.test/vote");
  u.searchParams.set("email", email);
  u.searchParams.set("edition", edition);
  u.searchParams.set("choice", choice);
  return u;
};

describe("runVoteBookkeeping — score:{email} relê fresco no write, não usa o snapshot congelado (#4125 item 1)", () => {
  it("voto A (bookkeeping pendurado no portão) não perde o incremento do voto B (edição diferente, completa primeiro)", async () => {
    const email = "sequencia@x.com";
    const editionA = "260602";
    const editionB = "260601";
    // Portão no guard-key de STATS do voto A — é o 1º await dentro de
    // runVoteBookkeeping (depois do bloco VOTE_DEDUP, que fica no-op sem
    // env.VOTE_DEDUP) — pendurar aqui pausa o bookkeeping INTEIRO do voto A
    // antes de ele sequer chegar na IIFE de score.
    const gatedKv = makeGatedKv(
      { [`correct:${editionA}`]: "A", [`correct:${editionB}`]: "A" },
      `counted:${editionA}:${email}:stats`,
    );
    const env = {
      POLL: gatedKv,
      POLL_SECRET: "poll-secret",
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
    } as unknown as Env & { POLL: ReturnType<typeof makeGatedKv> };

    // Voto A: handleVoteFastPath lê score:{email} (ainda null — nada foi
    // escrito) e CONGELA esse snapshot. O bookkeeping é despachado mas fica
    // pendurado no portão de stats logo no início.
    const reqA = makeRealCtx();
    const resA = await handleVote(voteUrl(email, editionA, "A"), env, "diaria", env, reqA.ctx);
    assert.match(await resA.text(), /✅ Acertou!/);

    // Voto B (MESMO leitor, outra edição da sequência) despacha e COMPLETA
    // seu bookkeeping inteiro — sem nenhum portão nas chaves dele (o
    // "counted:260601:...:stats" não é a chave gateada).
    const reqB = makeRealCtx();
    const resB = await handleVote(voteUrl(email, editionB, "A"), env, "diaria", env, reqB.ctx);
    assert.match(await resB.text(), /✅ Acertou!/);
    await flush(reqB.scheduled);

    const afterB = JSON.parse((await env.POLL.get(`score:${email}`))!);
    assert.equal(afterB.total, 1, "sanity: voto B sozinho grava total:1 — bookkeeping do voto A continua pendurado no portão");

    // Libera o portão — o bookkeeping do voto A prossegue AGORA, bem depois
    // do voto B já ter escrito. Com o fix, a IIFE de score relê
    // score:{email} FRESCO neste ponto (vê total:1) em vez de usar o
    // snapshot null congelado capturado lá em cima.
    gatedKv.releaseGate();
    await flush(reqA.scheduled);

    const final = JSON.parse((await env.POLL.get(`score:${email}`))!);
    assert.equal(
      final.total,
      2,
      `REGRESSÃO #4125 item 1: os dois votos devem somar total:2 — recebeu total:${final.total} (o voto B foi perdido = bug do snapshot congelado voltou)`,
    );
    assert.equal(final.correct, 2, "ambos os votos foram corretos (gabarito A em ambas as edições)");
  });

  it("voto isolado (sem concorrência) continua funcionando normalmente — comportamento pré-existente preservado", async () => {
    const email = "solo@x.com";
    const env = {
      POLL: makeTrackedKv({ "correct:260601": "A" }),
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
  });
});
