/**
 * test/poll-batch-3118.test.ts
 *
 * Regressão para o lote de cleanup/P3 do worker `poll` (issue #3118 — revisão
 * de código Fable, 260707). Cobre os itens implementados no Batch A (tudo que
 * toca `workers/poll/src/*.ts`):
 *
 *   Correção:
 *     1. `mergeYearEntries` tiebreaker usava o `last_vote_ts` mais ANTIGO —
 *        invertia o critério #1383 ("voto mais recente vence empate") na
 *        visão anual.
 *     2. Cache `immutable` de mês/ano fechado ficou falso após o voto
 *        retroativo (#2867) — baixado pra `max-age=3600`.
 *     3. `/vote` não validava formato/tamanho de `email`/`edition`.
 *     4. `handleAdminCorrect`'s `JSON.parse` sem guard por registro (+ o
 *        ramo duplicado de `buildAlreadyVotedResponse` em vote.ts).
 *
 *   Segurança:
 *     8. HMAC de `/admin/correct` sem brand — replayable cross-brand.
 *     9. `renderResultImagesHtml` não escapava `edition`.
 *
 *   Reuso/simplificação:
 *     10. `buildAlreadyVotedResponse` — extrai o bloco duplicado DO/fallback.
 *     11. `maskEmail` — consolida as 3 implementações de mascaramento.
 *     12. `withBrandQuery`/`brandHiddenInput` — consolida os 5 pontos de
 *         brand-default hardcoded; `parseBrandParam` deriva de `BRAND_INFO`.
 *
 *   Eficiência:
 *     13. `/vote` paraleliza os 3 gets independentes (correct/valid_editions/voteKey).
 *
 *   Manutenibilidade/teste (item 15):
 *     15b. `handleAdminCorrect` end-to-end: registro corrompido no meio do
 *          backfill, contagem de `updated_votes`, invalidação única de snapshot.
 *          (15a — /stats DO vazio+KV populado — e 15d — CORS sem vírgula — já
 *          tinham cobertura completa em poll-stats-counter-2223.test.ts e
 *          poll-cors-origin-3116.test.ts respectivamente; não duplicados aqui.)
 *
 * Item 5 (segurança — point-farming no arquivo retroativo) e item 14
 * (extração de `authorizeVote`) ficaram fora deste batch — ver comentário na
 * issue #3118 sobre escopo coberto vs. remanescente.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isValidVoteEmailFormat,
  isValidVoteEditionFormat,
  maskEmail,
  closedPeriodCacheControl,
  withBrandQuery,
  brandHiddenInput,
  parseBrandParam,
  BRAND_INFO,
} from "../workers/poll/src/lib.ts";
import { mergeYearEntries } from "../workers/poll/src/leaderboard-routes.ts";
import { buildAlreadyVotedResponse } from "../workers/poll/src/vote.ts";
import { hmacSign, renderResultImagesHtml, type Env } from "../workers/poll/src/index.ts";
import workerDefault from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

// ── Item 1: mergeYearEntries — tiebreak por last_vote_ts mais recente ──────

describe("mergeYearEntries — last_vote_ts reflete o voto mais RECENTE entre meses (#3118 item 1)", () => {
  it("mês mais recente (2º no array) sobrescreve last_vote_ts do mês mais antigo (1º)", () => {
    const jan = [{ email: "a@x.com", nickname: "A", correct: 1, total: 1, last_vote_ts: "2026-01-15T10:00:00.000Z" }];
    const feb = [{ email: "a@x.com", nickname: "A", correct: 1, total: 1, last_vote_ts: "2026-02-20T10:00:00.000Z" }];
    const merged = mergeYearEntries([jan, feb]);
    assert.equal(merged.length, 1);
    assert.equal(
      merged[0].last_vote_ts,
      "2026-02-20T10:00:00.000Z",
      "deve refletir o voto de fevereiro (mais recente), não o de janeiro (1ª ocorrência)",
    );
  });

  it("regressão exata do bug: SEM o fix, a 1ª ocorrência nunca era sobrescrita — aqui deve ser", () => {
    const older = [{ email: "b@x.com", nickname: "B", correct: 2, total: 3, last_vote_ts: "2026-03-01T00:00:00.000Z" }];
    const newer = [{ email: "b@x.com", nickname: "B", correct: 1, total: 1, last_vote_ts: "2026-06-30T23:59:59.000Z" }];
    const merged = mergeYearEntries([older, newer]);
    assert.notEqual(merged[0].last_vote_ts, "2026-03-01T00:00:00.000Z", "não deve ficar preso no valor do 1º mês");
    assert.equal(merged[0].last_vote_ts, "2026-06-30T23:59:59.000Z");
  });

  it("ordem de chegada não importa — sempre vence o timestamp cronologicamente mais recente", () => {
    const feb = [{ email: "c@x.com", nickname: "C", correct: 1, total: 1, last_vote_ts: "2026-02-20T10:00:00.000Z" }];
    const jan = [{ email: "c@x.com", nickname: "C", correct: 1, total: 1, last_vote_ts: "2026-01-15T10:00:00.000Z" }];
    // perMonth fora de ordem cronológica (fev antes de jan) — resultado deve ser o mesmo
    const merged = mergeYearEntries([feb, jan]);
    assert.equal(merged[0].last_vote_ts, "2026-02-20T10:00:00.000Z");
  });

  it("last_vote_ts ausente num mês não apaga o já setado noutro", () => {
    const jan = [{ email: "d@x.com", nickname: "D", correct: 1, total: 1, last_vote_ts: "2026-01-15T10:00:00.000Z" }];
    const mar = [{ email: "d@x.com", nickname: "D", correct: 1, total: 1 }]; // sem last_vote_ts
    const merged = mergeYearEntries([jan, mar]);
    assert.equal(merged[0].last_vote_ts, "2026-01-15T10:00:00.000Z");
  });

  it("correct/total continuam somando normalmente (comportamento pré-existente inalterado)", () => {
    const jan = [{ email: "e@x.com", nickname: "E", correct: 1, total: 1, last_vote_ts: "2026-01-01T00:00:00.000Z" }];
    const feb = [{ email: "e@x.com", nickname: "E", correct: 0, total: 1, last_vote_ts: "2026-02-01T00:00:00.000Z" }];
    const merged = mergeYearEntries([jan, feb]);
    assert.equal(merged[0].correct, 1);
    assert.equal(merged[0].total, 2);
  });

  it("emails distintos não se misturam", () => {
    const jan = [{ email: "f@x.com", nickname: "F", correct: 1, total: 1, last_vote_ts: "2026-01-01T00:00:00.000Z" }];
    const feb = [{ email: "g@x.com", nickname: "G", correct: 1, total: 1, last_vote_ts: "2026-02-01T00:00:00.000Z" }];
    const merged = mergeYearEntries([jan, feb]);
    assert.equal(merged.length, 2);
  });
});

// ── Item 2: cache-control de período fechado ────────────────────────────────

describe("closedPeriodCacheControl — #3118 item 2", () => {
  it("retorna max-age=3600 SEM immutable (não mais 30d immutable)", () => {
    const cc = closedPeriodCacheControl();
    assert.equal(cc, "public, max-age=3600");
    assert.doesNotMatch(cc, /immutable/);
  });
});

describe("integração — período fechado usa Cache-Control de 1h, não mais 30d immutable (#3118 item 2)", () => {
  it("mês passado /leaderboard/2020-01 → 1h, sem immutable", async () => {
    const env = makePollEnv(makeTrackedKv());
    const res = await workerDefault.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2020-01"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const cc = res.headers.get("Cache-Control") ?? "";
    assert.equal(cc, "public, max-age=3600");
    assert.doesNotMatch(cc, /immutable/);
  });

  it("mês passado /leaderboard/2020-01.json → idem", async () => {
    const env = makePollEnv(makeTrackedKv());
    const res = await workerDefault.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2020-01.json"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const cc = res.headers.get("Cache-Control") ?? "";
    assert.equal(cc, "public, max-age=3600");
    assert.doesNotMatch(cc, /immutable/);
  });

  it("ano passado /leaderboard/2020 → idem", async () => {
    const env = makePollEnv(makeTrackedKv());
    const res = await workerDefault.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2020"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const cc = res.headers.get("Cache-Control") ?? "";
    assert.equal(cc, "public, max-age=3600");
    assert.doesNotMatch(cc, /immutable/);
  });

  it("mês CORRENTE continua com cache curto de 60s (comportamento inalterado)", async () => {
    const env = makePollEnv(makeTrackedKv());
    const now = new Date();
    const slug = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const res = await workerDefault.fetch(
      new Request(`https://poll.diaria.workers.dev/leaderboard/${slug}`),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=60");
  });
});

// ── Item 3: validação de formato/tamanho de email e edition ────────────────

describe("isValidVoteEmailFormat — #3118 item 3", () => {
  it("aceita email comum", () => assert.equal(isValidVoteEmailFormat("user@example.com"), true));
  it("rejeita string vazia", () => assert.equal(isValidVoteEmailFormat(""), false));
  it("rejeita email sem @", () => assert.equal(isValidVoteEmailFormat("useratexample.com"), false));
  it("rejeita email sem domínio com ponto (sem TLD)", () => assert.equal(isValidVoteEmailFormat("user@localhost"), false));
  it("rejeita email com espaço", () => assert.equal(isValidVoteEmailFormat("user name@x.com"), false));
  it("rejeita email >254 chars", () => {
    const longLocal = "a".repeat(250);
    assert.equal(isValidVoteEmailFormat(`${longLocal}@x.com`), false);
  });
  it("aceita email EXATAMENTE 254 chars (limite)", () => {
    const domain = "@x.com"; // 6 chars
    const local = "a".repeat(254 - domain.length);
    const email = local + domain;
    assert.equal(email.length, 254);
    assert.equal(isValidVoteEmailFormat(email), true);
  });
  it("rejeita email com 255 chars (1 acima do limite)", () => {
    const domain = "@x.com";
    const local = "a".repeat(255 - domain.length);
    const email = local + domain;
    assert.equal(email.length, 255);
    assert.equal(isValidVoteEmailFormat(email), false);
  });
  it("aceita email com + (Beehiiv merge tag pattern)", () => assert.equal(isValidVoteEmailFormat("subscriber+tag@example.com"), true));
  it("rejeita email com ':' no local-part (#3279 charset hardening)", () => assert.equal(isValidVoteEmailFormat("evil:tag@example.com"), false));
  it("rejeita email com ':' no domínio (#3279 charset hardening)", () => assert.equal(isValidVoteEmailFormat("user@evil:x.com"), false));
});

describe("isValidVoteEditionFormat — #3118 item 3", () => {
  it("aceita edition AAMMDD normal", () => assert.equal(isValidVoteEditionFormat("260613"), true));
  it("aceita ciclo Clarice YYMM-MM", () => assert.equal(isValidVoteEditionFormat("2605-06"), true));
  it("rejeita edition vazio", () => assert.equal(isValidVoteEditionFormat(""), false));
  it("rejeita edition >32 chars (não bate charset de nenhum dos 2 formatos)", () => assert.equal(isValidVoteEditionFormat("a".repeat(33)), false));
});

// ── #3279: charset hardening — ':' não pode forjar chave KV vote:{edition}:{email} ──
//
// Achado de segurança (code-review consolidado 260710, verificado linha a linha):
// isValidVoteEditionFormat checava só COMPRIMENTO (`length > 0 && <= 32`), não
// charset. Um edition como "2607-08:evil" (13 chars) passava livremente e produzia
// a chave KV `vote:2607-08:evil:{email}` — que ainda bate no prefixo escaneado por
// handleAdminCorrect (`vote:2607-08:`), poluindo correções administrativas de score
// sem autenticação nenhuma (modo merge-tag não exige HMAC). Fix: charset explícito —
// só `^\d{6}$` (AAMMDD legado) ou `^\d{4}-\d{2}$` (ciclo Clarice) passam agora.
describe("isValidVoteEditionFormat — #3279 charset hardening (rejeita ':' e outros chars fora do esperado)", () => {
  it("rejeita edition com ':' — exploit exato da issue #3279 (edition=2607-08:evil)", () => {
    assert.equal(isValidVoteEditionFormat("2607-08:evil"), false);
  });
  it("rejeita edition AAMMDD com ':' anexado (edition=260613:evil)", () => {
    assert.equal(isValidVoteEditionFormat("260613:evil"), false);
  });
  it("rejeita edition só com ':' ", () => {
    assert.equal(isValidVoteEditionFormat(":"), false);
  });
  it("rejeita edition com letras (não é AAMMDD nem ciclo)", () => {
    assert.equal(isValidVoteEditionFormat("abcdef"), false);
  });
  it("rejeita edition ciclo com dígitos a mais (YYMM-MMM)", () => {
    assert.equal(isValidVoteEditionFormat("2605-069"), false);
  });
  it("rejeita edition AAMMDD com 1 dígito a menos/mais (5 ou 7 chars)", () => {
    assert.equal(isValidVoteEditionFormat("26061"), false);
    assert.equal(isValidVoteEditionFormat("2606133"), false);
  });
  it("continua aceitando os 2 formatos legítimos após o hardening (não regride #3118)", () => {
    assert.equal(isValidVoteEditionFormat("260613"), true, "AAMMDD legado");
    assert.equal(isValidVoteEditionFormat("2605-06"), true, "ciclo Clarice YYMM-MM");
  });
});

describe("integração — /vote rejeita edition com ':' ANTES de tocar o KV, para os 2 formatos legítimos (#3279)", () => {
  it("edition=2607-08:evil (brand=clarice, sem sig — modo merge-tag) → 400, nenhuma chave 'vote:2607-08:*' gravada", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "attacker@x.com");
    url.searchParams.set("edition", "2607-08:evil");
    url.searchParams.set("choice", "A");
    url.searchParams.set("brand", "clarice");
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 400, "chave forjada com ':' deve ser rejeitada antes de qualquer escrita KV");
    assert.equal(await kv.get("vote:2607-08:evil:attacker@x.com"), null, "chave forjada nunca deve existir no KV");
    assert.equal(await kv.get("vote:2607-08:attacker@x.com"), null, "edição real também não deve ter sido tocada");
  });

  it("edition=260613:evil (formato AAMMDD com ':' anexado) → 400, nada gravado", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "attacker@x.com");
    url.searchParams.set("edition", "260613:evil");
    url.searchParams.set("choice", "A");
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 400);
    assert.equal(await kv.get("vote:260613:evil:attacker@x.com"), null);
  });

  it("regressão: edition no formato ciclo Clarice legítimo (YYMM-MM) continua votando normalmente (200)", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "leitor@x.com");
    url.searchParams.set("edition", "2605-06");
    url.searchParams.set("choice", "A");
    url.searchParams.set("brand", "clarice");
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 200, "voto legítimo em formato ciclo não deve ser bloqueado pelo hardening de charset");
  });

  it("regressão: edition no formato AAMMDD legado continua votando normalmente (200)", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "leitor2@x.com");
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "B");
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 200, "voto legítimo em formato AAMMDD não deve ser bloqueado pelo hardening de charset");
  });
});

describe("integração — /vote rejeita email/edition malformados antes de tocar o KV (#3118 item 3)", () => {
  it("email sem @ → 400, nada gravado", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "not-an-email");
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "A");
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 400);
    assert.equal(await kv.get("vote:260613:not-an-email"), null);
  });

  it("email >254 chars → 400", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const longEmail = `${"a".repeat(250)}@x.com`;
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", longEmail);
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "A");
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 400);
  });

  it("edition absurdamente longo → 400 (defesa contra key KV >512 bytes)", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "user@x.com");
    url.searchParams.set("edition", "a".repeat(100));
    url.searchParams.set("choice", "A");
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 400);
  });

  it("email/edition válidos → passa normalmente (regressão: gate não bloqueia voto real)", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "user@x.com");
    url.searchParams.set("edition", "260613");
    url.searchParams.set("choice", "A");
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 200);
  });
});

// ── Item 4 (parte index.ts): handleAdminCorrect — guard por registro ───────

describe("handleAdminCorrect — registro corrompido não aborta o backfill inteiro (#3118 item 4 + 15b)", () => {
  it("1 registro corrompido no meio do backfill é pulado (logado); demais votos são re-pontuados", async () => {
    const kv = makeTrackedKv({
      "correct:260701": "A", // gabarito anterior — será sobrescrito por B
      "vote:260701:alice@x.com": JSON.stringify({ choice: "B", ts: "t1", correct: false }),
      "vote:260701:corrupt@x.com": "{not valid json", // registro corrompido
      "vote:260701:bob@x.com": JSON.stringify({ choice: "B", ts: "t2", correct: false }),
      "score:alice@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260701", nickname: "Alice" }),
      "score:bob@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260701", nickname: "Bob" }),
      "score-by-month:2026-07:alice@x.com": JSON.stringify({ total: 1, correct: 0, last_edition: "260701", nickname: "Alice" }),
      "score-by-month:2026-07:bob@x.com": JSON.stringify({ total: 1, correct: 0, last_edition: "260701", nickname: "Bob" }),
    });
    const env = makePollEnv(kv, { adminSecret: "test-admin" });
    const sig = await hmacSign("test-admin", "diaria:260701:B");
    const url = new URL("https://poll.diaria.workers.dev/admin/correct");
    url.searchParams.set("edition", "260701");
    url.searchParams.set("answer", "B");
    url.searchParams.set("sig", sig);

    let res: Response;
    try {
      res = await workerDefault.fetch(new Request(url.toString(), { method: "POST" }), env, {} as ExecutionContext);
    } catch (e) {
      assert.fail(`registro corrompido não deve lançar exceção não-capturada: ${String(e)}`);
      return;
    }
    assert.equal(res.status, 200, "corrupted record NÃO deve abortar o backfill com 500");
    const body = await res.json() as { ok: boolean; updated_votes: number };
    assert.equal(body.ok, true);
    assert.equal(body.updated_votes, 2, `deve processar os 2 votos válidos, ignorando o corrompido (got ${body.updated_votes})`);

    const aliceScore = JSON.parse((await kv.get("score:alice@x.com"))!);
    assert.equal(aliceScore.correct, 1, "alice deve ter sido re-pontuada (false→true)");
    const bobScore = JSON.parse((await kv.get("score:bob@x.com"))!);
    assert.equal(bobScore.correct, 1, "bob deve ter sido re-pontuado (false→true)");

    // registro corrompido permanece intacto (não foi tocado/sobrescrito pelo loop)
    assert.equal(await kv.get("vote:260701:corrupt@x.com"), "{not valid json");

    // gabarito foi de fato gravado apesar do registro corrompido no meio do loop
    assert.equal(await kv.get("correct:260701"), "B");
  });

  it("invalida o snapshot do mês EXATAMENTE 1 vez após o loop, não 1x por voto (#3118 item 15b)", async () => {
    const store = new Map<string, string>(Object.entries({
      "correct:260701": "A",
      "vote:260701:alice@x.com": JSON.stringify({ choice: "B", ts: "t1", correct: false }),
      "vote:260701:bob@x.com": JSON.stringify({ choice: "B", ts: "t2", correct: false }),
      "vote:260701:carol@x.com": JSON.stringify({ choice: "B", ts: "t3", correct: false }),
      "score:alice@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260701", nickname: "Alice" }),
      "score:bob@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260701", nickname: "Bob" }),
      "score:carol@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260701", nickname: "Carol" }),
      "score-by-month:2026-07:alice@x.com": JSON.stringify({ total: 1, correct: 0, last_edition: "260701", nickname: "Alice" }),
      "score-by-month:2026-07:bob@x.com": JSON.stringify({ total: 1, correct: 0, last_edition: "260701", nickname: "Bob" }),
      "score-by-month:2026-07:carol@x.com": JSON.stringify({ total: 1, correct: 0, last_edition: "260701", nickname: "Carol" }),
      "leaderboard-snapshot:2026-07": JSON.stringify({ entries: [], computed_at: "t0" }),
    }));
    let deleteCallsForSnapshot = 0;
    const kv = {
      async get(key: string) { return store.get(key) ?? null; },
      async getWithMetadata(key: string) { return { value: store.get(key) ?? null, metadata: null }; },
      async put(key: string, value: string) { store.set(key, value); },
      async delete(key: string) {
        if (key === "leaderboard-snapshot:2026-07") deleteCallsForSnapshot++;
        store.delete(key);
      },
      async list({ prefix = "" }: { prefix?: string } = {}) {
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
        return { keys, list_complete: true, cursor: undefined };
      },
    };
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin",
      ALLOWED_ORIGINS: "*",
    };
    const sig = await hmacSign("test-admin", "diaria:260701:B");
    const url = new URL("https://poll.diaria.workers.dev/admin/correct");
    url.searchParams.set("edition", "260701");
    url.searchParams.set("answer", "B");
    url.searchParams.set("sig", sig);

    const res = await workerDefault.fetch(new Request(url.toString(), { method: "POST" }), env, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const body = await res.json() as { updated_votes: number };
    assert.equal(body.updated_votes, 3, "3 votos re-pontuados (alice, bob, carol)");
    assert.equal(
      deleteCallsForSnapshot,
      1,
      `invalidateSnapshot deve ser chamado EXATAMENTE 1x após o loop, não 1x por voto (got ${deleteCallsForSnapshot})`,
    );
  });
});

// ── Item 8: HMAC de /admin/correct inclui o brand ───────────────────────────

describe("handleAdminCorrect — HMAC inclui o brand (#3118 item 8)", () => {
  it("sig assinado pra brand=diaria NÃO valida contra brand=clarice", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv, { adminSecret: "shared-secret" });
    const sigDiaria = await hmacSign("shared-secret", "diaria:260701:A");

    const url = new URL("https://poll.diaria.workers.dev/admin/correct");
    url.searchParams.set("edition", "260701");
    url.searchParams.set("answer", "A");
    url.searchParams.set("sig", sigDiaria);
    url.searchParams.set("brand", "clarice");
    const res = await workerDefault.fetch(new Request(url.toString(), { method: "POST" }), env, {} as ExecutionContext);
    assert.equal(res.status, 403, "sig assinado pra diaria não deve validar contra clarice (replay cross-brand bloqueado)");
  });

  it("sig assinado com o brand correto valida normalmente", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv, { adminSecret: "shared-secret" });
    const sig = await hmacSign("shared-secret", "clarice:260701:A");
    const url = new URL("https://poll.diaria.workers.dev/admin/correct");
    url.searchParams.set("edition", "260701");
    url.searchParams.set("answer", "A");
    url.searchParams.set("sig", sig);
    url.searchParams.set("brand", "clarice");
    const res = await workerDefault.fetch(new Request(url.toString(), { method: "POST" }), env, {} as ExecutionContext);
    assert.equal(res.status, 200);
  });

  it("sig no formato ANTIGO (sem brand — só edition:answer) não valida mais", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv, { adminSecret: "shared-secret" });
    const oldFormatSig = await hmacSign("shared-secret", "260701:A"); // formato pré-#3118
    const url = new URL("https://poll.diaria.workers.dev/admin/correct");
    url.searchParams.set("edition", "260701");
    url.searchParams.set("answer", "A");
    url.searchParams.set("sig", oldFormatSig);
    const res = await workerDefault.fetch(new Request(url.toString(), { method: "POST" }), env, {} as ExecutionContext);
    assert.equal(res.status, 403, "sig no formato antigo (sem brand) deve ser rejeitado");
  });
});

// ── Item 9: renderResultImagesHtml escapa edition ───────────────────────────

describe("renderResultImagesHtml — escapa edition (#3118 item 9)", () => {
  it("edition com caracteres HTML especiais é escapado no src/alt da imagem", () => {
    const html = renderResultImagesHtml({
      edition: `260701"><script>alert(1)</script>`,
      aiSide: "A",
      clickedSide: "A",
    });
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, "não deve conter o script cru");
    assert.match(html, /&lt;script&gt;/, "deve estar escapado");
  });

  it("edition normal (AAMMDD) renderiza a URL da imagem sem alteração visível", () => {
    const html = renderResultImagesHtml({ edition: "260701", aiSide: "A", clickedSide: "B" });
    assert.match(html, /\/img\/img-260701-01-eia-A\.jpg/);
    assert.match(html, /\/img\/img-260701-01-eia-B\.jpg/);
  });
});

// ── Items 4 (vote.ts) + 10: buildAlreadyVotedResponse ───────────────────────

describe("buildAlreadyVotedResponse — extração + guard de JSON corrompido (#3118 items 4 e 10)", () => {
  function scoreOnlyEnv(scoreRaw: string | null = null): Env {
    return {
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin",
      ALLOWED_ORIGINS: "*",
      POLL: { get: async () => scoreRaw } as unknown as KVNamespace,
    } as unknown as Env;
  }

  it("existingFromKv corrompido não lança — cai no fallback choice:'?' (200, não 500)", async () => {
    let res: Response;
    try {
      res = await buildAlreadyVotedResponse(scoreOnlyEnv(), "diaria", "260701", "user@x.com", "{corrupted json");
    } catch (e) {
      assert.fail(`não deve lançar em JSON corrompido: ${String(e)}`);
      return;
    }
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /escolha: \?/, "deve exibir '?' como fallback quando o registro está corrompido");
  });

  it("existingFromKv válido → exibe a choice correta", async () => {
    const res = await buildAlreadyVotedResponse(scoreOnlyEnv(), "diaria", "260701", "user@x.com", JSON.stringify({ choice: "A" }));
    const html = await res.text();
    assert.match(html, /escolha: A/);
  });

  it("existingFromKv null (race — DO rejeitou mas KV ainda não propagou) → '?'", async () => {
    const res = await buildAlreadyVotedResponse(scoreOnlyEnv(), "diaria", "260701", "user@x.com", null);
    const html = await res.text();
    assert.match(html, /escolha: \?/);
  });

  it("nicknameForm aparece quando score não tem nickname (paridade entre os 2 ramos que usavam este bloco)", async () => {
    const env = scoreOnlyEnv(JSON.stringify({ total: 1, nickname: null }));
    const res = await buildAlreadyVotedResponse(env, "diaria", "260701", "user@x.com", JSON.stringify({ choice: "A" }));
    const html = await res.text();
    assert.match(html, /action="\/set-name"/);
  });

  it("nicknameForm NÃO aparece quando score já tem nickname", async () => {
    const env = scoreOnlyEnv(JSON.stringify({ total: 1, nickname: "Já Tenho" }));
    const res = await buildAlreadyVotedResponse(env, "diaria", "260701", "user@x.com", JSON.stringify({ choice: "A" }));
    const html = await res.text();
    assert.doesNotMatch(html, /action="\/set-name"/);
  });
});

describe("integração — voto duplicado com registro corrompido no KV não derruba o request (#3118 item 4)", () => {
  it("existingFromKv corrompido no fallback KV (sem VOTE_DEDUP) → 200 'já votou' com '?', não 500", async () => {
    const kv = makeTrackedKv({
      "vote:260701:corrupt2@x.com": "{not valid json at all",
    });
    const env = makePollEnv(kv); // sem VOTE_DEDUP → fallback KV
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "corrupt2@x.com");
    url.searchParams.set("edition", "260701");
    url.searchParams.set("choice", "A");
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 200, "registro corrompido não deve derrubar o request com 500");
    const html = await res.text();
    assert.match(html, /já votou/i);
    assert.match(html, /escolha: \?/);
  });
});

// ── Item 11: maskEmail consolidado ──────────────────────────────────────────

describe("maskEmail — consolidação das 3 implementações (#3118 item 11)", () => {
  it("email normal → local@***", () => {
    assert.equal(maskEmail("usuario@example.com"), "usuario@***");
  });
  it("email sem @ (defensivo — dado histórico pré-#3118 item 3) → 4 primeiros chars + ***", () => {
    assert.equal(maskEmail("semarroba"), "sema***");
  });
  it("email com múltiplos @ usa o PRIMEIRO como separador", () => {
    assert.equal(maskEmail("a@b@c.com"), "a@***");
  });
  it("string vazia → '***'", () => {
    assert.equal(maskEmail(""), "***");
  });
});

// ── Item 12: brand default consolidado ──────────────────────────────────────

describe("withBrandQuery / brandHiddenInput — consolidação de brand-default (#3118 item 12)", () => {
  it("withBrandQuery: diaria (default) → base sem alteração", () => {
    assert.equal(withBrandQuery("/leaderboard", "diaria"), "/leaderboard");
  });
  it("withBrandQuery: clarice (não-default) → anexa ?brand=clarice", () => {
    assert.equal(withBrandQuery("/leaderboard", "clarice"), "/leaderboard?brand=clarice");
  });
  it("brandHiddenInput: diaria → string vazia", () => {
    assert.equal(brandHiddenInput("diaria"), "");
  });
  it("brandHiddenInput: clarice → input hidden com o brand", () => {
    assert.equal(brandHiddenInput("clarice"), `<input type="hidden" name="brand" value="clarice">`);
  });
});

describe("parseBrandParam — derivado de Object.keys(BRAND_INFO) (#3118 item 12)", () => {
  it("aceita qualquer key presente em BRAND_INFO", () => {
    for (const key of Object.keys(BRAND_INFO)) {
      assert.equal(parseBrandParam(key), key);
    }
  });
  it("valores fora de BRAND_INFO caem em diaria (comportamento preservado)", () => {
    assert.equal(parseBrandParam("xyz"), "diaria");
    assert.equal(parseBrandParam(null), "diaria");
    assert.equal(parseBrandParam(""), "diaria");
  });
});

// ── Item 13: /vote paraleliza as 3 leituras KV independentes ───────────────

describe("/vote — correct/valid_editions/voteKey são lidos concorrentemente (#3118 item 13)", () => {
  it("os 3 gets independentes disparam ANTES do primeiro resolver (peak concurrency >= 3)", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const store = new Map<string, string>();
    const kv = {
      async get(key: string) {
        inFlight++;
        if (inFlight > maxConcurrent) maxConcurrent = inFlight;
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) { store.set(key, value); },
      async delete(key: string) { store.delete(key); },
      async list() { return { keys: [], list_complete: true, cursor: undefined }; },
    };
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin",
      ALLOWED_ORIGINS: "*",
    };
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "concurrency@x.com");
    url.searchParams.set("edition", "260701");
    url.searchParams.set("choice", "A");
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 200, "voto deve completar normalmente");
    assert.ok(
      maxConcurrent >= 3,
      `esperado >= 3 gets concorrentes (correct:{edition}/valid_editions/voteKey) — observado peak ${maxConcurrent}. ` +
        `Sequencial (sem o fix) daria peak 1 nesse trecho (o único Promise.all pré-existente, guard-keys score/month, dá peak 2).`,
    );
  });
});
