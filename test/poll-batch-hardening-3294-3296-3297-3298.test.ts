/**
 * test/poll-batch-hardening-3294-3296-3297-3298.test.ts
 *
 * Regressão para o lote de hardening do worker `poll` (overnight 260711,
 * 4 issues fechadas num único PR):
 *
 *   #3298 (P2) — 9 `JSON.parse(KV)` desguardados na mesma classe de bug já
 *     corrigida em `buildAlreadyVotedResponse` (#3118 item 4 / #3278). Fix:
 *     helper único `safeParseKv` (lib.ts), migrado nas 9 ocorrências + 1
 *     achado adicional durante o self-review (handleAdminCorrect's mirror
 *     `stats:{edition}` — mesma classe, fora da lista original da issue).
 *     Item mais severo: `handleVote`'s `scoreObj` — corrompido derrubava o
 *     VOTO NOVO com 500 ANTES de qualquer escrita KV (retry permanente).
 *
 *   #3294 (P2) — charset validation de #3279 não aplicada em outros pontos
 *     que compõem a MESMA forma de chave KV:
 *       item 1 (obrigatório, DoS não-autenticado): `handleStats` (`/stats`,
 *         endpoint público sem auth) nunca validava `edition`.
 *       item 2: `handleAdminCorrect` nunca validava `edition` antes do
 *         prefix-scan `vote:{edition}:`.
 *       item 3: `handleSetName` nunca validava `email`.
 *
 *   #3296 (P2) — isValidVoteEmailFormat: 2 gaps residuais.
 *       gap 2 (explorável): teto de 254 media `.length` (UTF-16), não bytes
 *         UTF-8 — email multibyte podia estourar a chave KV de 512 bytes.
 *         Fix: `new TextEncoder().encode(email).length`.
 *       gap 1 (defesa em profundidade): confusáveis Unicode/invisíveis não
 *         bloqueados. Fix: denylist `\p{Cf}\p{Cc}` + "：" fullwidth.
 *
 *   #3297 (P3) — regex de formato de edition duplicado 7x+, com 1 cópia
 *     DIVERGENTE em `scripts/rebuild-stats.ts` (só AAMMDD, rejeitava ciclos
 *     Clarice válidos). Fix: `AAMMDD_RE`/`CYCLE_EDITION_RE` exportadas de
 *     lib.ts, reusadas nos call sites (incluindo rebuild-stats.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  safeParseKv,
  isValidVoteEmailFormat,
  isValidVoteEditionFormat,
  AAMMDD_RE,
  CYCLE_EDITION_RE,
} from "../workers/poll/src/lib.ts";
import { handleStats } from "../workers/poll/src/vote.ts";
import { hmacSign, type Env } from "../workers/poll/src/index.ts";
import workerDefault from "../workers/poll/src/index.ts";
import { isValidRebuildStatsEdition } from "../scripts/rebuild-stats.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

// ── safeParseKv — helper puro (#3298) ───────────────────────────────────────

describe("safeParseKv — parse seguro de JSON vindo do KV (#3298)", () => {
  it("raw null → null, sem lançar (chave ausente, caso normal)", () => {
    assert.equal(safeParseKv(null, "test_event", "ctx"), null);
  });
  it("raw corrompido → null, sem lançar", () => {
    let result: unknown;
    assert.doesNotThrow(() => {
      result = safeParseKv("{not valid json at all", "test_event", "ctx");
    });
    assert.equal(result, null);
  });
  it("raw válido → objeto parseado", () => {
    assert.deepEqual(safeParseKv<{ a: number }>(JSON.stringify({ a: 1 }), "test_event", "ctx"), { a: 1 });
  });
  it("raw = 'null' (JSON válido, não-objeto) → null sem lançar", () => {
    assert.equal(safeParseKv("null", "test_event", "ctx"), null);
  });
});

// ── #3298 — handleVote: score:{email} corrompido no VOTO NOVO (mais severo) ─

describe("handleVote — score:{email}/stats:{edition}/score-by-month corrompidos não derrubam o VOTO NOVO (#3298)", () => {
  it("todos os 3 KVs tocados por um voto novo corrompidos → 200 (não 500), estado final consistente", async () => {
    const kv = makeTrackedKv({
      "score:corrupt-all@x.com": "{not valid json for score",
      "stats:260701": "{not valid json for stats",
      "score-by-month:2026-07:corrupt-all@x.com": "{not valid json for month entry",
    });
    const env = makePollEnv(kv); // sem VOTE_DEDUP/STATS_COUNTER → todos os fallbacks in-process
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "corrupt-all@x.com");
    url.searchParams.set("edition", "260701");
    url.searchParams.set("choice", "A");

    let res: Response;
    try {
      res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    } catch (e) {
      assert.fail(`voto novo com KVs corrompidos não deve lançar exceção não-capturada: ${String(e)}`);
      return;
    }
    assert.equal(res.status, 200, "score:{email} corrompido não deve derrubar o voto novo com 500");

    // voto foi de fato commitado (retry não fica preso pra sempre)
    const voteRaw = await kv.get("vote:260701:corrupt-all@x.com");
    assert.ok(voteRaw, "voteKey deve ter sido gravado apesar dos KVs corrompidos");
    assert.equal(JSON.parse(voteRaw!).choice, "A");

    // score:{email} foi reconstruído a partir do default (não ficou stale/corrompido)
    const score = JSON.parse((await kv.get("score:corrupt-all@x.com"))!);
    assert.equal(score.total, 1);

    // stats:{edition} (fallback KV RMW, sem STATS_COUNTER) foi reconstruído
    const stats = JSON.parse((await kv.get("stats:260701"))!);
    assert.equal(stats.total, 1);
    assert.equal(stats.voted_a, 1);

    // score-by-month também foi reconstruído a partir do default
    const month = JSON.parse((await kv.get("score-by-month:2026-07:corrupt-all@x.com"))!);
    assert.equal(month.total, 1);
  });

  it("nickname form é reoferecido quando score:{email} corrompido (tratado como 'sem nickname')", async () => {
    const kv = makeTrackedKv({ "score:corrupt-nick@x.com": "{corrupted" });
    const env = makePollEnv(kv);
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "corrupt-nick@x.com");
    url.searchParams.set("edition", "260701");
    url.searchParams.set("choice", "B");
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /action="\/set-name"/);
  });
});

// ── #3298 — handleAdminCorrect: score/score-by-month/stats-mirror corrompidos ─

describe("handleAdminCorrect — score/score-by-month/stats-mirror corrompidos não abortam o backfill (#3298)", () => {
  it("3 KVs auxiliares corrompidos (score, score-by-month, stats mirror) → 200, updated_votes correto, sem lançar", async () => {
    const kv = makeTrackedKv({
      "correct:260701": "A",
      "vote:260701:alice@x.com": JSON.stringify({ choice: "B", ts: "t1", correct: false }),
      "score:alice@x.com": "{corrupted score — site 4 (adjustScoreCorrectOnly)",
      "score-by-month:2026-07:alice@x.com": "{corrupted month entry — site 3 (adjustScoreByMonthCorrectOnly)",
      "stats:260701": "{corrupted stats mirror — bonus site (handleAdminCorrect statsRaw)",
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
      assert.fail(`KVs auxiliares corrompidos não devem abortar o backfill com exceção: ${String(e)}`);
      return;
    }
    assert.equal(res.status, 200, "não deve retornar 500 por causa dos KVs auxiliares corrompidos");
    const body = await res.json() as { ok: boolean; updated_votes: number };
    assert.equal(body.ok, true);
    assert.equal(body.updated_votes, 1, "voto de alice ainda deve ser re-pontuado (false→true)");

    // vote record foi de fato atualizado apesar dos KVs auxiliares corrompidos
    const vote = JSON.parse((await kv.get("vote:260701:alice@x.com"))!);
    assert.equal(vote.correct, true);

    // gabarito foi gravado normalmente
    assert.equal(await kv.get("correct:260701"), "B");
  });
});

// ── #3298 — handleSetName: score:{email} corrompido (site 8) ───────────────

describe("handleSetName — score:{email} corrompido falha graciosamente, não com 500 (#3298)", () => {
  it("score:{email} corrompido → 400 amigável (não 500)", async () => {
    const kv = makeTrackedKv({ "score:setname-corrupt@x.com": "{corrupted score for setname" });
    const env = makePollEnv(kv);
    const sig = await hmacSign("test-secret", "setname:setname-corrupt@x.com");
    const url = new URL("https://poll.diaria.workers.dev/set-name");
    url.searchParams.set("email", "setname-corrupt@x.com");
    url.searchParams.set("name", "Nome Teste");
    url.searchParams.set("sig", sig);

    let res: Response;
    try {
      res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    } catch (e) {
      assert.fail(`score:{email} corrompido não deve lançar exceção não-capturada: ${String(e)}`);
      return;
    }
    assert.equal(res.status, 400, "corrompido deve virar 400 amigável, não 500");
  });
});

// ── #3298 — propagateNicknameByMonth: entry mensal corrompida (site 9) ─────

describe("handleSetName → propagateNicknameByMonth — entry mensal corrompida não aborta a propagação (#3298)", () => {
  it("score:{email} válido + score-by-month:{slug}:{email} corrompido → nickname salvo (200), entry corrompida pulada sem lançar", async () => {
    const kv = makeTrackedKv({
      "score:setname-ok@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260701", nickname: null }),
      "score-by-month:2026-07:setname-ok@x.com": "{corrupted month entry for propagate",
    });
    const env = makePollEnv(kv);
    const sig = await hmacSign("test-secret", "setname:setname-ok@x.com");
    const url = new URL("https://poll.diaria.workers.dev/set-name");
    url.searchParams.set("email", "setname-ok@x.com");
    url.searchParams.set("name", "Novo Nome");
    url.searchParams.set("sig", sig);

    let res: Response;
    try {
      res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    } catch (e) {
      assert.fail(`entry mensal corrompida não deve abortar handleSetName com exceção: ${String(e)}`);
      return;
    }
    assert.equal(res.status, 200);

    const scoreAfter = JSON.parse((await kv.get("score:setname-ok@x.com"))!);
    assert.equal(scoreAfter.nickname, "Novo Nome", "nickname global deve ter sido salvo normalmente");

    // entry corrompida permanece intacta (pulada, não sobrescrita às cegas)
    assert.equal(
      await kv.get("score-by-month:2026-07:setname-ok@x.com"),
      "{corrupted month entry for propagate",
    );
  });
});

// ── #3294 item 1 — handleStats (DoS não-autenticado) ────────────────────────

describe("handleStats — valida formato de edition ANTES de tocar KV/DO (#3294 item 1)", () => {
  it("edition oversized (2000 chars) é rejeitado 400, não 500 (chave KV estouraria 512 bytes)", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const url = new URL("https://poll.diaria.workers.dev/stats");
    url.searchParams.set("edition", "x".repeat(2000));
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /invalid edition format/);
  });

  it("edition com ':' (mesmo padrão de exploit do #3279) é rejeitado 400 em /stats", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const url = new URL("https://poll.diaria.workers.dev/stats");
    url.searchParams.set("edition", "260701:evil");
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 400);
  });

  it("edition válido (AAMMDD) continua funcionando normalmente (não regride #3261)", async () => {
    const kv = makeTrackedKv({
      "stats:260701": JSON.stringify({ total: 3, voted_a: 1, voted_b: 2, correct_count: 1 }),
    });
    const env = makePollEnv(kv);
    const res = await handleStats(new URL("https://poll.diaria.workers.dev/stats?edition=260701"), env, "diaria");
    assert.equal(res.status, 200);
    const body = await res.json() as { total: number };
    assert.equal(body.total, 3);
  });

  it("edition válido (ciclo Clarice) continua funcionando normalmente", async () => {
    const kv = makeTrackedKv({
      "stats:2605-06": JSON.stringify({ total: 5, voted_a: 2, voted_b: 3, correct_count: 2 }),
    });
    const env = makePollEnv(kv);
    const res = await handleStats(new URL("https://poll.diaria.workers.dev/stats?edition=2605-06"), env, "clarice");
    assert.equal(res.status, 200);
    const body = await res.json() as { total: number };
    assert.equal(body.total, 5);
  });
});

// ── #3294 item 2 — handleAdminCorrect ───────────────────────────────────────

describe("handleAdminCorrect — valida formato de edition ANTES do prefix-scan (#3294 item 2)", () => {
  it("edition com ':' rejeitado 400 MESMO com sig válido pra essa string malformada exata", async () => {
    const kv = makeTrackedKv({
      "vote:260701:alice@x.com": JSON.stringify({ choice: "B", ts: "t1", correct: false }),
    });
    const env = makePollEnv(kv, { adminSecret: "test-admin" });
    const maliciousEdition = "260701:evil";
    // sig VÁLIDO pra essa string exata — provando que a rejeição vem do gate de
    // formato, não de falha de HMAC.
    const sig = await hmacSign("test-admin", `diaria:${maliciousEdition}:B`);
    const url = new URL("https://poll.diaria.workers.dev/admin/correct");
    url.searchParams.set("edition", maliciousEdition);
    url.searchParams.set("answer", "B");
    url.searchParams.set("sig", sig);
    const res = await workerDefault.fetch(new Request(url.toString(), { method: "POST" }), env, {} as ExecutionContext);
    assert.equal(res.status, 400, "deve ser rejeitado por formato, mesmo com sig HMAC válido");
    assert.equal(
      await kv.get("vote:260701:alice@x.com"),
      JSON.stringify({ choice: "B", ts: "t1", correct: false }),
      "edição real não deve ter sido tocada",
    );
  });
});

// ── #3294 item 3 — handleSetName ────────────────────────────────────────────

describe("handleSetName — valida formato de email ANTES da verificação de sig (#3294 item 3)", () => {
  it("email com ':' rejeitado 400 MESMO com sig válido pra esse email malformado exato", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const maliciousEmail = "evil:tag@x.com";
    const sig = await hmacSign("test-secret", `setname:${maliciousEmail}`);
    const url = new URL("https://poll.diaria.workers.dev/set-name");
    url.searchParams.set("email", maliciousEmail);
    url.searchParams.set("name", "Nome");
    url.searchParams.set("sig", sig);
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 400, "deve ser rejeitado por formato, mesmo com sig HMAC válido");
  });
});

// ── #3296 gap 2 — bytes UTF-8, não unidades UTF-16 ──────────────────────────

describe("isValidVoteEmailFormat — #3296 gap 2 (byte length UTF-8, explorável)", () => {
  it("rejeita email multibyte que passa no teto de .length (206) mas estoura 254 bytes UTF-8 (606 bytes)", () => {
    const email = "あ".repeat(200) + "@x.com";
    assert.equal(email.length, 206, "sanity: .length (UTF-16) fica abaixo do teto antigo");
    assert.equal(new TextEncoder().encode(email).length, 606, "sanity: bytes UTF-8 reais estouram 254");
    assert.equal(isValidVoteEmailFormat(email), false);
  });

  it("aceita email multibyte PEQUENO dentro do teto de bytes (PT-BR com acento — não deve regredir)", () => {
    assert.equal(isValidVoteEmailFormat("joão@x.com.br"), true);
  });

  it("continua aceitando ASCII EXATAMENTE 254 bytes (== 254 chars pra ASCII puro)", () => {
    const domain = "@x.com";
    const local = "a".repeat(254 - domain.length);
    const email = local + domain;
    assert.equal(isValidVoteEmailFormat(email), true);
  });

  it("continua rejeitando ASCII 255 chars/bytes (1 acima do limite)", () => {
    const domain = "@x.com";
    const local = "a".repeat(255 - domain.length);
    const email = local + domain;
    assert.equal(isValidVoteEmailFormat(email), false);
  });
});

// ── #3296 gap 1 — confusáveis Unicode / invisíveis (defesa em profundidade) ─

describe("isValidVoteEmailFormat — #3296 gap 1 (confusáveis/invisíveis Unicode)", () => {
  // Caracteres construídos via \u escape (não literais no source) — evita
  // ambiguidade de codificação/exibição no arquivo de teste em si.
  it("rejeita zero-width space (U+200B) no local-part", () => {
    const email = `evil${"​"}part@x.com`;
    assert.equal(isValidVoteEmailFormat(email), false);
  });
  it("rejeita ':' fullwidth (U+FF1A) — mesmo racional do #3279 na forma ASCII", () => {
    const email = `evil${"："}tag@x.com`;
    assert.equal(isValidVoteEmailFormat(email), false);
  });
  it("rejeita BOM (U+FEFF)", () => {
    const email = `${"﻿"}user@x.com`;
    assert.equal(isValidVoteEmailFormat(email), false);
  });
  it("rejeita zero-width joiner (U+200D)", () => {
    const email = `us${"‍"}er@x.com`;
    assert.equal(isValidVoteEmailFormat(email), false);
  });
});

// ── #3297 — regex de edition içado pra constantes compartilhadas ───────────

describe("AAMMDD_RE / CYCLE_EDITION_RE — constantes compartilhadas (#3297)", () => {
  it("AAMMDD_RE bate AAMMDD legado e rejeita ciclo", () => {
    assert.equal(AAMMDD_RE.test("260701"), true);
    assert.equal(AAMMDD_RE.test("2605-06"), false);
  });
  it("CYCLE_EDITION_RE bate ciclo Clarice e rejeita AAMMDD", () => {
    assert.equal(CYCLE_EDITION_RE.test("2605-06"), true);
    assert.equal(CYCLE_EDITION_RE.test("260701"), false);
  });
  it("isValidVoteEditionFormat continua consistente com as 2 constantes (não regride #3118/#3279)", () => {
    assert.equal(isValidVoteEditionFormat("260701"), true);
    assert.equal(isValidVoteEditionFormat("2605-06"), true);
    assert.equal(isValidVoteEditionFormat("260701:evil"), false);
  });
});

describe("rebuild-stats.ts — isValidRebuildStatsEdition corrige a regex divergente (#3297)", () => {
  it("aceita ciclo Clarice YYMM-MM (antes rejeitado silenciosamente pela regex divergente só-AAMMDD)", () => {
    assert.equal(isValidRebuildStatsEdition("2605-06"), true);
  });
  it("continua aceitando AAMMDD legado (comportamento pré-existente preservado)", () => {
    assert.equal(isValidRebuildStatsEdition("260701"), true);
  });
  it("rejeita null", () => {
    assert.equal(isValidRebuildStatsEdition(null), false);
  });
  it("rejeita formato inválido", () => {
    assert.equal(isValidRebuildStatsEdition("not-an-edition"), false);
  });
});
