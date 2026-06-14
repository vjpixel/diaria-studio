/**
 * test/poll-hardening-2188-2189-2190-2191.test.ts
 *
 * Testes de regressão para o lote poll-hardening:
 *
 *   #2188 (P1, BUG): handleAdminCorrect backfill pula vote.correct===false →
 *     entradas previamente-erradas ficam permanentemente erradas ao corrigir o gabarito.
 *   #2189 (P2, BUG): voto commitado antes da leitura de nickname → 500 deixa
 *     nicknameForm=null inacessível no retry (branch "já votou" hardcodava null).
 *   #2190 (P2, perf): score:${email} lido 2-3x por request — consolidado em 1 leitura.
 *   #2191 (P3, cleanup): renderLeaderboardHtml escapava inline omitindo apóstrofe (').
 *   #2202 (P1, BUG): double-increment de total no backfill (updateScore re-incrementava);
 *     streak inflado; true→false não re-avaliado; teste fraco (correct>0 sem total===1).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  votePageHtml,
  hmacSign,
  handleSetName,
  type Env,
} from "../workers/poll/src/index.ts";
import { htmlEscape } from "../workers/poll/src/lib.ts";
import { makeTrackedKv, readKv } from "./_helpers/make-tracked-kv.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "test-admin-secret";
const POLL_SECRET = "test-poll-secret";

function makeEnv(kv: ReturnType<typeof makeTrackedKv>): Env {
  return {
    POLL: kv as unknown as KVNamespace,
    POLL_SECRET,
    ADMIN_SECRET,
    ALLOWED_ORIGINS: "*",
  };
}

/** Monta URL de admin/correct com sig válido. */
async function adminCorrectUrl(edition: string, answer: string): Promise<URL> {
  const { hmacSign: sign } = await import("../workers/poll/src/index.ts");
  const sig = await sign(ADMIN_SECRET, `${edition}:${answer}`);
  const u = new URL("https://poll.diaria.workers.dev/admin/correct");
  u.searchParams.set("edition", edition);
  u.searchParams.set("answer", answer);
  u.searchParams.set("sig", sig);
  return u;
}

/** Invoca handleAdminCorrect isolado via fetch simulado. Puro: trabalha no KV fornecido. */
async function callAdminCorrect(kv: ReturnType<typeof makeTrackedKv>, edition: string, answer: string) {
  // Importar o default handler pra simular o request completo
  const { default: worker } = await import("../workers/poll/src/index.ts");
  const url = await adminCorrectUrl(edition, answer);
  const req = new Request(url.toString(), { method: "POST" });
  return worker.fetch(req, makeEnv(kv) as Env, {} as ExecutionContext);
}

// ── #2188: backfill re-pontua vote.correct===false ───────────────────────────

describe("#2188 — handleAdminCorrect re-pontua entradas correct===false", () => {
  it("voto gravado como false (gabarito errado) é re-pontuado ao corrigir", async () => {
    // Setup: admin setou gabarito A (errado), leitor votou B → correct=false.
    // Depois admin corrige para B (certo). O backfill deve re-pontuar o voto.
    const kv = makeTrackedKv({
      // Gabarito errado (será sobrescrito no POST /admin/correct)
      "correct:260613": "A",
      // Voto do leitor: choice=B, correct=false (baseado no gabarito errado A)
      "vote:260613:leitor@x.com": JSON.stringify({ choice: "B", ts: "2026-06-13T10:00:00Z", correct: false }),
      // Score inicial: total=1, correct=0 (correto=false não somou)
      "score:leitor@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260613", nickname: "Leitor" }),
      // score-by-month correspondente
      "score-by-month:2026-06:leitor@x.com": JSON.stringify({ total: 1, correct: 0, last_edition: "260613", nickname: "Leitor" }),
    });

    const res = await callAdminCorrect(kv, "260613", "B");
    assert.equal(res.status, 200, "admin/correct deve retornar 200");
    const body = await res.json() as { ok: boolean; updated_votes: number };
    assert.equal(body.ok, true);
    // #2208 (item 2): pinar o valor exato — exatamente 1 voto neste cenário.
    // assert.ok(>= 1) aceitaria qualquer positivo e passaria mesmo se houvesse double-count.
    assert.equal(body.updated_votes, 1, `deve ter atualizado exatamente 1 voto (got ${body.updated_votes})`);

    // Verifica que o voto foi regravado com correct=true
    const voteRaw = await kv.get("vote:260613:leitor@x.com");
    const vote = JSON.parse(voteRaw!);
    assert.equal(vote.correct, true, "vote.correct deve ser true após backfill com gabarito correto");

    // Verifica que o score foi atualizado (correct incrementou para exatamente 1)
    const scoreRaw = await kv.get("score:leitor@x.com");
    const score = JSON.parse(scoreRaw!);
    // #2208 (item 2): pinar valor exato — era 0, deve ser exatamente 1 (não "qualquer > 0").
    assert.equal(score.correct, 1, `score.correct deve ser exatamente 1 após false→true (got ${score.correct})`);
    // #2202 (P1): garante que total NÃO foi double-incremented pelo backfill.
    // updateScore re-incrementava total (double-count); adjustScoreCorrectOnly não toca total.
    assert.equal(score.total, 1, `score.total NÃO deve ser re-incrementado pelo backfill — deve ser 1 (got ${score.total})`);

    // #2208 (item 1): score-by-month deve espelhar o global — false→true incrementa monthly.correct.
    // Bug pré-#2206: adjustScoreByMonthCorrectOnly não decrementava no caso true→false,
    // o que tornava bidirecionalidade invisível para testes que só verificavam o global.
    const monthRaw = await kv.get("score-by-month:2026-06:leitor@x.com");
    const monthly = JSON.parse(monthRaw!);
    assert.equal(monthly.correct, 1, "score-by-month.correct deve ser 1 após false→true (espelha global)");
    assert.equal(monthly.total, 1, "score-by-month.total NÃO deve ser tocado pelo backfill");
  });

  it("voto já-correto (correct===true) NÃO é re-pontuado (idempotente)", async () => {
    // Leitor que já votou certo não deve ser re-contado no updated_votes
    const kv = makeTrackedKv({
      "correct:260613": "A",
      "vote:260613:certo@x.com": JSON.stringify({ choice: "A", ts: "2026-06-13T10:00:00Z", correct: true }),
      "score:certo@x.com": JSON.stringify({ total: 1, correct: 1, streak: 1, last_edition: "260613", nickname: "Certo" }),
      "score-by-month:2026-06:certo@x.com": JSON.stringify({ total: 1, correct: 1, last_edition: "260613", nickname: "Certo" }),
    });

    // Admin confirma o mesmo gabarito A
    const res = await callAdminCorrect(kv, "260613", "A");
    assert.equal(res.status, 200);
    const body = await res.json() as { updated_votes: number };
    // Voto correct===true não entra no loop de re-pontagem — updated_votes=0
    assert.equal(body.updated_votes, 0, "voto já-correto não deve gerar updated_votes");

    // #2208 (item 1): score-by-month deve permanecer inalterado quando voto já-correto é re-confirmado.
    // Sem esta asserção, uma re-incrementação acidental de monthly.correct passaria invisível.
    const monthRaw = await kv.get("score-by-month:2026-06:certo@x.com");
    const monthly = JSON.parse(monthRaw!);
    assert.equal(monthly.correct, 1, "score-by-month.correct deve permanecer 1 (idempotente — sem re-incremento)");
    assert.equal(monthly.total, 1, "score-by-month.total não deve ser alterado");

    // #2217 (Finding 5): global score:certo@x.com também deve ser inalterado na 2ª execução.
    // Sem esta asserção, um write espúrio que re-incrementasse score.correct passaria invisível
    // (o guard `changed` alargado poderia executar adjustScoreCorrectOnly desnecessariamente).
    const globalRaw = await readKv(kv, "score:certo@x.com");
    const global_ = JSON.parse(globalRaw);
    assert.equal(global_.correct, 1, "score:certo@x.com.correct deve permanecer 1 (idempotente — sem write espúrio)");
    assert.equal(global_.total, 1, "score:certo@x.com.total não deve ser alterado na 2ª execução");
  });

  it("cenário completo: admin corrige gabarito → null, false E true são todos re-avaliados bidirecionalmente", async () => {
    // 3 votos: 1 sem gabarito (null), 1 errado (false), 1 correto (true, pelo gabarito errado).
    // Gabarito correto é B. Admin setou A primeiro, depois corrige pra B.
    // #2202 (P2): re-avaliação bidirecional — true→false TAMBÉM deve ser corrigido.
    const kv = makeTrackedKv({
      "correct:260614": "A",
      // Leitor 1: votou B, gabarito era A → correct=false (errado)
      "vote:260614:l1@x.com": JSON.stringify({ choice: "B", ts: "t", correct: false }),
      "score:l1@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260614", nickname: "L1" }),
      "score-by-month:2026-06:l1@x.com": JSON.stringify({ total: 1, correct: 0, last_edition: "260614", nickname: "L1" }),
      // Leitor 2: votou B, gabarito ainda não estava definido → correct=null
      "vote:260614:l2@x.com": JSON.stringify({ choice: "B", ts: "t", correct: null }),
      "score:l2@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260614", nickname: "L2" }),
      "score-by-month:2026-06:l2@x.com": JSON.stringify({ total: 1, correct: 0, last_edition: "260614", nickname: "L2" }),
      // Leitor 3: votou A, gabarito era A → correct=true (certo pelo gabarito errado A)
      // Após correção para B: votou A ≠ B → deve virar false (true→false bidirecional)
      "vote:260614:l3@x.com": JSON.stringify({ choice: "A", ts: "t", correct: true }),
      "score:l3@x.com": JSON.stringify({ total: 1, correct: 1, streak: 1, last_edition: "260614", nickname: "L3" }),
      "score-by-month:2026-06:l3@x.com": JSON.stringify({ total: 1, correct: 1, last_edition: "260614", nickname: "L3" }),
    });

    // Admin corrige: gabarito é B (não A)
    const res = await callAdminCorrect(kv, "260614", "B");
    assert.equal(res.status, 200);
    const body = await res.json() as { updated_votes: number };
    // L1 (false→true), L2 (null→true) e L3 (true→false) são re-avaliados.
    // updated_votes conta todos os que MUDARAM = L1 + L2 + L3 = 3
    assert.equal(body.updated_votes, 3, "L1 (false→true), L2 (null→true) e L3 (true→false) devem ser updated");

    // L1 votou B = gabarito correto B → true
    const v1 = JSON.parse(await kv.get("vote:260614:l1@x.com") as string);
    assert.equal(v1.correct, true, "L1 (votou B = gabarito correto B) deve ser true");
    // L2 votou B = gabarito correto B → true
    const v2 = JSON.parse(await kv.get("vote:260614:l2@x.com") as string);
    assert.equal(v2.correct, true, "L2 (votou B = gabarito correto B) deve ser true");
    // L3 votou A ≠ gabarito correto B → false (bidirecional: true→false)
    const v3 = JSON.parse(await kv.get("vote:260614:l3@x.com") as string);
    assert.equal(v3.correct, false, "L3 (votou A ≠ gabarito B) deve ser false após re-avaliação bidirecional");

    // #2202 (P1): nenhum total deve ter sido re-incrementado pelo backfill
    const s3 = JSON.parse(await kv.get("score:l3@x.com") as string);
    assert.equal(s3.total, 1, "L3: total NÃO deve ser re-incrementado pelo backfill (era 1, deve ser 1)");
    // score.correct de L3 deve ter sido decrementado (era 1, deve ser 0)
    assert.equal(s3.correct, 0, "L3: correct deve ter sido decrementado para 0 (true→false)");

    // #2217 (Finding 3): global score:l1 e score:l2 — o double-increment do #2202 poderia
    // regredir para L1/L2 sem detecção se só checássemos L3. Pinar total===1 e correct===1.
    const s1 = JSON.parse(await readKv(kv, "score:l1@x.com"));
    assert.equal(s1.total, 1, "L1: total NÃO deve ser re-incrementado pelo backfill");
    assert.equal(s1.correct, 1, "L1 (false→true): score.correct deve ser 1 após backfill");
    const s2 = JSON.parse(await readKv(kv, "score:l2@x.com"));
    assert.equal(s2.total, 1, "L2: total NÃO deve ser re-incrementado pelo backfill");
    assert.equal(s2.correct, 1, "L2 (null→true): score.correct deve ser 1 após backfill");

    // #2208 (item 1): score-by-month deve espelhar as mesmas transições do global.
    // Bug pré-#2206: o decremento true→false não era aplicado ao mensal — acerto fantasma.
    const m1 = JSON.parse((await kv.get("score-by-month:2026-06:l1@x.com"))!);
    assert.equal(m1.correct, 1, "L1 (false→true): score-by-month.correct deve ser 1");
    assert.equal(m1.total, 1, "L1: score-by-month.total não deve ser alterado");

    const m2 = JSON.parse((await kv.get("score-by-month:2026-06:l2@x.com"))!);
    assert.equal(m2.correct, 1, "L2 (null→true): score-by-month.correct deve ser 1");
    assert.equal(m2.total, 1, "L2: score-by-month.total não deve ser alterado");

    const m3 = JSON.parse((await kv.get("score-by-month:2026-06:l3@x.com"))!);
    // L3 (true→false): monthly.correct era 1, deve ser decrementado para 0.
    // Sem esta asserção, o bug pré-#2206 passaria invisível neste cenário.
    assert.equal(m3.correct, 0, "L3 (true→false): score-by-month.correct deve ser 0 (acerto fantasma eliminado)");
    assert.equal(m3.total, 1, "L3: score-by-month.total não deve ser alterado");
  });

  it("#2202 (P1): backfill NÃO re-incrementa total (double-count regression)", async () => {
    // Regressão específica do double-increment: updateScore fazia score.total += 1 de novo.
    // adjustScoreCorrectOnly NÃO deve tocar total.
    const kv = makeTrackedKv({
      "correct:260615": "A",
      // Leitor: votou A, gabarito ainda null → correct=null; total=1 gravado pelo handleVote
      "vote:260615:dbl@x.com": JSON.stringify({ choice: "A", ts: "t", correct: null }),
      "score:dbl@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260615", nickname: null }),
      // #2208 (item 1): score-by-month stub necessário pra verificar que monthly.total
      // não é double-incremented e monthly.correct é ajustado corretamente.
      "score-by-month:2026-06:dbl@x.com": JSON.stringify({ total: 1, correct: 0, last_edition: "260615", nickname: null }),
    });

    // Admin define gabarito A
    const res = await callAdminCorrect(kv, "260615", "A");
    assert.equal(res.status, 200);

    // #2217 (Finding 4): sem `body.updated_votes`, o guard `changed` quebrado para
    // null→true não seria pego (ex: se `changed` fosse sempre false, updated_votes===0
    // mas as outras asserções de score passariam por conta do estado anterior).
    const body = await res.json() as { ok: boolean; updated_votes: number };
    assert.equal(body.ok, true);
    assert.equal(body.updated_votes, 1, `deve ter atualizado exatamente 1 voto (null→true) (got ${body.updated_votes})`);

    const scoreRaw = await kv.get("score:dbl@x.com");
    const score = JSON.parse(scoreRaw!);
    // total DEVE continuar 1 (não 2) — invariante do backfill
    assert.equal(score.total, 1, `total NÃO deve ser double-incremented — deve ser 1 (got ${score.total})`);
    // correct deve ter sido incrementado para 1 (null→true)
    assert.equal(score.correct, 1, `correct deve ser 1 após backfill null→true (got ${score.correct})`);
    // streak NÃO deve ser tocado pelo backfill
    assert.equal(score.streak, 0, `streak NÃO deve ser incrementado pelo backfill (got ${score.streak})`);

    // #2208 (item 1): score-by-month também não deve ter total double-incremented.
    // O bug pré-#2206/#2202 re-chamava updateScoreByMonth integralmente, re-somando total.
    const monthRaw = await kv.get("score-by-month:2026-06:dbl@x.com");
    const monthly = JSON.parse(monthRaw!);
    assert.equal(monthly.total, 1, "score-by-month.total NÃO deve ser double-incremented pelo backfill");
    assert.equal(monthly.correct, 1, "score-by-month.correct deve ser 1 após null→true (incrementado exatamente 1x)");
  });
});

// ── #2206: score-by-month bidirecional em handleAdminCorrect ─────────────────

describe("#2206 — score-by-month decrementa em true→false e não acumula no flip-flop", () => {
  it("true→false: score-by-month.correct é decrementado (acerto fantasma corrigido)", async () => {
    // Cenário: admin define gabarito A, leitor vota A → monthly.correct=1.
    // Admin corrige para B: leitor votou A ≠ B → deve virar false.
    // monthly.correct deve ser decrementado de 1 para 0.
    const kv = makeTrackedKv({
      "correct:260616": "A",
      // Leitor votou A (correto com gabarito A) → correct=true
      "vote:260616:mbm@x.com": JSON.stringify({ choice: "A", ts: "t", correct: true }),
      "score:mbm@x.com": JSON.stringify({ total: 1, correct: 1, streak: 1, last_edition: "260616", nickname: "MBM" }),
      // monthly.correct=1 (reflete o acerto inicial)
      "score-by-month:2026-06:mbm@x.com": JSON.stringify({ total: 1, correct: 1, last_edition: "260616", nickname: "MBM" }),
    });

    // Admin corrige: gabarito é B (não A)
    const res = await callAdminCorrect(kv, "260616", "B");
    assert.equal(res.status, 200);
    const body = await res.json() as { updated_votes: number };
    assert.equal(body.updated_votes, 1, "o voto que mudou de true→false deve ser contado");

    // score global deve ter decrementado correct
    const scoreRaw = await readKv(kv, "score:mbm@x.com");
    const score = JSON.parse(scoreRaw);
    assert.equal(score.correct, 0, "score.correct global deve ser 0 (true→false)");
    assert.equal(score.total, 1, "score.total NÃO deve ser tocado pelo backfill");
    // #2224 (#420): streak NÃO deve ser tocado pelo backfill (total e streak são invariantes)
    assert.equal(score.streak, 1, "score.streak NÃO deve ser alterado pelo backfill true→false (era 1, deve permanecer 1)");

    // score-by-month DEVE ter decrementado correct (bug pré-#2206: ficava em 1)
    const monthRaw = await readKv(kv, "score-by-month:2026-06:mbm@x.com");
    const monthly = JSON.parse(monthRaw);
    assert.equal(monthly.correct, 0, "score-by-month.correct deve ser 0 após true→false (acerto fantasma eliminado)");
    assert.equal(monthly.total, 1, "score-by-month.total NÃO deve ser tocado");
  });

  it("flip-flop A→B→A: monthly.correct não acumula (permanece em {0,1})", async () => {
    // Cenário de flip-flop: admin seta A, corrige pra B, corrige pra A de volta.
    // monthly.correct deve espelhar o estado real: 0 após A→B, 1 após B→A.
    // Bug pré-#2206: cada re-marcação como correto chamava +1 sem decrementar → acúmulo.
    const kv = makeTrackedKv({
      "correct:260617": "A",
      // Leitor votou A → correct=true (gabarito A estava certo)
      "vote:260617:flip@x.com": JSON.stringify({ choice: "A", ts: "t", correct: true }),
      "score:flip@x.com": JSON.stringify({ total: 1, correct: 1, streak: 1, last_edition: "260617", nickname: "Flip" }),
      "score-by-month:2026-06:flip@x.com": JSON.stringify({ total: 1, correct: 1, last_edition: "260617", nickname: "Flip" }),
    });

    // Flip 1: admin corrige para B → voto A ≠ B → true→false
    await callAdminCorrect(kv, "260617", "B");
    const afterFlip1Monthly = JSON.parse((await kv.get("score-by-month:2026-06:flip@x.com"))!);
    assert.equal(afterFlip1Monthly.correct, 0, "após A→B: monthly.correct deve ser 0");

    // Flip 2: admin corrige de volta para A → voto A = A → false→true
    await callAdminCorrect(kv, "260617", "A");
    const afterFlip2Monthly = JSON.parse((await kv.get("score-by-month:2026-06:flip@x.com"))!);
    assert.equal(afterFlip2Monthly.correct, 1, "após B→A: monthly.correct deve ser 1 (não 2 — sem acúmulo)");
    assert.equal(afterFlip2Monthly.total, 1, "monthly.total NÃO deve ser tocado em nenhum flip");
    // Global score bidirecional: false→true deve ter incrementado score.correct de 0 para 1.
    const afterFlip2Global = JSON.parse((await kv.get("score:flip@x.com"))!);
    assert.equal(afterFlip2Global.correct, 1, "score global: após B→A (false→true), correct deve ser 1");
    assert.equal(afterFlip2Global.total, 1, "score global: total NÃO deve ser tocado em nenhum flip");

    // Flip 3: admin corrige para B novamente → true→false
    await callAdminCorrect(kv, "260617", "B");
    const afterFlip3Monthly = JSON.parse((await kv.get("score-by-month:2026-06:flip@x.com"))!);
    assert.equal(afterFlip3Monthly.correct, 0, "após A→B (2º): monthly.correct deve voltar a 0 (não negativo, não acumulado)");
    // Global score: true→false deve ter decrementado score.correct de 1 para 0.
    const afterFlip3Global = JSON.parse((await kv.get("score:flip@x.com"))!);
    assert.equal(afterFlip3Global.correct, 0, "score global: após A→B (true→false), correct deve ser 0 (não negativo)");
  });

  it("false→true: monthly.correct é incrementado (caminho original, não regrediu)", async () => {
    // Garante que o fix não quebrou o caminho false→true (incremento).
    const kv = makeTrackedKv({
      "correct:260618": "A",
      "vote:260618:inc@x.com": JSON.stringify({ choice: "B", ts: "t", correct: false }),
      "score:inc@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260618", nickname: "Inc" }),
      "score-by-month:2026-06:inc@x.com": JSON.stringify({ total: 1, correct: 0, last_edition: "260618", nickname: "Inc" }),
    });

    // Admin corrige para B (leitor votou B = correto)
    await callAdminCorrect(kv, "260618", "B");

    const monthRaw = await kv.get("score-by-month:2026-06:inc@x.com");
    const monthly = JSON.parse(monthRaw!);
    assert.equal(monthly.correct, 1, "false→true: monthly.correct deve ser incrementado para 1");
    assert.equal(monthly.total, 1, "monthly.total NÃO deve ser tocado");

    // Global score: false→true deve ter incrementado score.correct de 0 para 1.
    const scoreRaw = await kv.get("score:inc@x.com");
    const score = JSON.parse(scoreRaw!);
    assert.equal(score.correct, 1, "false→true: score.correct global deve ser 1 após backfill");
    assert.equal(score.total, 1, "false→true: score.total global NÃO deve ser tocado pelo backfill");
  });

  it("null→false: adjustScoreByMonthCorrectOnly NÃO toca score-by-month (early-return)", async () => {
    // #2217 (Finding 2): o branch `else { return }` de adjustScoreByMonthCorrectOnly
    // (linha ~535-537 em index.ts) cobre o caso null→false — quando voto tinha correct=null
    // e o gabarito setado não corresponde ao choice do leitor. O total NÃO deve mudar
    // e o correct NÃO deve ser decrementado (null não é "acerto anterior").
    // Sem este teste, uma regressão que decramentasse monthly.correct no caso null→false
    // passaria invisível — seria um falso decremento (leitor nunca tinha acertado).
    const kv = makeTrackedKv({
      "correct:260620": "A",
      // Leitor votou B, gabarito ainda null → correct=null; admin seta A → newCorrect=false
      // Transição: null → false (mudança em vote.correct) — adjustScoreByMonthCorrectOnly
      // deve cair no branch `else { return }` e NÃO escrever no KV mensal.
      "vote:260620:nf@x.com": JSON.stringify({ choice: "B", ts: "t", correct: null }),
      "score:nf@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260620", nickname: "NF" }),
      "score-by-month:2026-06:nf@x.com": JSON.stringify({ total: 1, correct: 0, last_edition: "260620", nickname: "NF" }),
    });

    // Admin seta gabarito A; leitor votou B → newCorrect=false; prev=null → changed=true
    // Transição é null→false: vote é re-gravado (changed), score global ajustado (null→false
    // não toca global correct — ajustScoreCorrectOnly também tem o branch correto),
    // mas score-by-month NÃO deve ser tocado (adjustScoreByMonthCorrectOnly retorna cedo).
    await callAdminCorrect(kv, "260620", "A");

    // score-by-month deve estar INALTERADO (null→false não toca mensal)
    const monthRaw = await readKv(kv, "score-by-month:2026-06:nf@x.com");
    const monthly = JSON.parse(monthRaw);
    assert.equal(monthly.correct, 0, "null→false: monthly.correct deve permanecer 0 (early-return — não decrementa)");
    assert.equal(monthly.total, 1, "null→false: monthly.total não deve ser alterado");

    // score global também deve permanecer inalterado (null→false: nenhum acerto anterior a corrigir)
    const globalRaw = await readKv(kv, "score:nf@x.com");
    const global_ = JSON.parse(globalRaw);
    assert.equal(global_.correct, 0, "null→false: score.correct global deve permanecer 0 (não decrementa abaixo de zero)");
    assert.equal(global_.total, 1, "null→false: score.total não deve ser alterado");
  });

  it("clamp: monthly.correct não vai abaixo de 0 (clamp em Math.max(0, ...))", async () => {
    // Edge case defensivo: se por algum motivo correct já estava em 0 e vem true→false.
    const kv = makeTrackedKv({
      "correct:260619": "A",
      "vote:260619:clamp@x.com": JSON.stringify({ choice: "A", ts: "t", correct: true }),
      "score:clamp@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260619", nickname: "Clamp" }),
      // monthly.correct já estava em 0 (inconsistência defensiva — não deve ir negativo)
      "score-by-month:2026-06:clamp@x.com": JSON.stringify({ total: 1, correct: 0, last_edition: "260619", nickname: "Clamp" }),
    });

    // Admin corrige para B → true→false
    await callAdminCorrect(kv, "260619", "B");

    const monthRaw = await kv.get("score-by-month:2026-06:clamp@x.com");
    const monthly = JSON.parse(monthRaw!);
    assert.ok(monthly.correct >= 0, `monthly.correct não deve ser negativo (got ${monthly.correct})`);
    assert.equal(monthly.correct, 0, "clamp: monthly.correct fica em 0, não −1");

    // #2217 (Finding 1): clamp de adjustScoreCorrectOnly (global) também deve ser testado.
    // Sem esta asserção, remover o Math.max(0,...) do global NÃO seria pego — o teste
    // só verificava o mensal. score:clamp@x.com tinha correct=0 e vem true→false → clamp.
    const globalRaw = await readKv(kv, "score:clamp@x.com");
    const global_ = JSON.parse(globalRaw);
    assert.ok(global_.correct >= 0, `score:clamp@x.com.correct não deve ser negativo (got ${global_.correct})`);
    assert.equal(global_.correct, 0, "clamp global: score.correct fica em 0, não −1 (Math.max(0,...) em adjustScoreCorrectOnly)");
  });

  it("decremento normal: correct=1 → true→false decrementa para 0 (caso coerente)", async () => {
    // Caso COERENTE: leitor votou corretamente (vote.correct=true), score reflete isso
    // (correct=1). Admin muda o gabarito → true→false → decremento normal para 0.
    // Distingue o comportamento normal do decremento da proteção do clamp acima
    // (que testava o edge defensivo com fixture incoerente correct=0+vote.correct=true).
    const kv = makeTrackedKv({
      "correct:260621": "A",
      "vote:260621:dec@x.com": JSON.stringify({ choice: "A", ts: "t", correct: true }),
      "score:dec@x.com": JSON.stringify({ total: 1, correct: 1, streak: 1, last_edition: "260621", nickname: "Dec" }),
      "score-by-month:2026-06:dec@x.com": JSON.stringify({ total: 1, correct: 1, last_edition: "260621", nickname: "Dec" }),
    });

    // Admin muda gabarito para B → true→false: acerto anterior deve ser decrementado
    await callAdminCorrect(kv, "260621", "B");

    const monthRaw = await kv.get("score-by-month:2026-06:dec@x.com");
    const monthly = JSON.parse(monthRaw!);
    assert.equal(monthly.correct, 0, "decremento normal: correct=1 → 0 após true→false");
    assert.equal(monthly.total, 1, "total não muda no decremento");

    const globalRaw = await readKv(kv, "score:dec@x.com");
    const global_ = JSON.parse(globalRaw);
    assert.equal(global_.correct, 0, "decremento normal global: correct=1 → 0 após true→false");
    assert.equal(global_.total, 1, "total global não muda no decremento");
  });
});

// ── #2189: nickname form acessível no retry após "já votou" ──────────────────

describe("#2189 — branch 'já votou' serve nicknameForm quando subscriber não tem nickname", () => {
  it("subscriber sem nickname que retenta o link recebe o form de nickname", async () => {
    // Simula: voto já gravado (de um request anterior que commitou mas falhou depois),
    // e o subscriber não tem nickname. Branch "já votou" deve servir o form.
    const { default: worker } = await import("../workers/poll/src/index.ts");

    const kv = makeTrackedKv({
      // Voto já commitado
      "vote:260613:retry@x.com": JSON.stringify({ choice: "A", ts: "2026-06-13T10:00:00Z", correct: null }),
      // Score sem nickname (subscriber votou, mas form de nickname não foi exibido por causa do 500)
      "score:retry@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260613", nickname: null }),
    });
    const env = makeEnv(kv);

    // Gera sig de voto válido (merge-tag mode: sem sig param, usa null)
    const voteUrl = new URL("https://poll.diaria.workers.dev/vote");
    voteUrl.searchParams.set("email", "retry@x.com");
    voteUrl.searchParams.set("edition", "260613");
    voteUrl.searchParams.set("choice", "A");
    // sem sig → merge-tag mode (aceito)

    const req = new Request(voteUrl.toString(), { method: "GET" });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    assert.equal(res.status, 200, "retry deve retornar 200 (já votou)");

    const html = await res.text();
    // O form de nickname DEVE estar presente (não null hard-coded)
    assert.match(html, /action="\/set-name"/, "form de set-name deve estar presente no retry");
    assert.match(html, /name="name"/, "input name deve estar presente");
    // Deve conter a mensagem "já votou"
    assert.match(html, /já votou/i, "mensagem 'já votou' deve estar presente");
  });

  it("subscriber com nickname que retenta o link NÃO recebe o form (já definiu)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");

    const kv = makeTrackedKv({
      "vote:260613:nick@x.com": JSON.stringify({ choice: "B", ts: "2026-06-13T10:00:00Z", correct: null }),
      "score:nick@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260613", nickname: "TemNick" }),
    });
    const env = makeEnv(kv);

    const voteUrl = new URL("https://poll.diaria.workers.dev/vote");
    voteUrl.searchParams.set("email", "nick@x.com");
    voteUrl.searchParams.set("edition", "260613");
    voteUrl.searchParams.set("choice", "B");

    const req = new Request(voteUrl.toString(), { method: "GET" });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const html = await res.text();
    // Sem nickname pendente → form NÃO deve aparecer
    assert.doesNotMatch(html, /action="\/set-name"/, "form NÃO deve aparecer quando nickname já está definido");
  });
});

// ── #2190: score:${email} lido no máximo 1x para o caminho feliz ─────────────

describe("#2190 — score:${email} lido no máximo 1x no handleVote (caminho novo)", () => {
  it("voto novo: KV get de score:{email} ocorre 1x (não 2-3x)", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");

    let scoreGetCount = 0;
    // KV que conta gets da chave específica score:{email}
    const store = new Map<string, string>([
      // sem voto prévio
      ["score:count@x.com", JSON.stringify({ total: 0, correct: 0, streak: 0, last_edition: null, nickname: null })],
    ]);
    const puts: Array<{ key: string; value: string }> = [];

    const kv = {
      puts,
      async get(key: string) {
        if (key === "score:count@x.com") scoreGetCount++;
        return store.get(key) ?? null;
      },
      async put(key: string, value: string, opts?: unknown) {
        puts.push({ key, value });
        store.set(key, value);
      },
      async delete(key: string) { store.delete(key); },
      async list({ prefix = "" }: { prefix?: string }) {
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
        return { keys, list_complete: true, cursor: undefined };
      },
    } as unknown as KVNamespace;

    const env: Env = {
      POLL: kv,
      POLL_SECRET,
      ADMIN_SECRET,
      ALLOWED_ORIGINS: "*",
    };

    const voteUrl = new URL("https://poll.diaria.workers.dev/vote");
    voteUrl.searchParams.set("email", "count@x.com");
    voteUrl.searchParams.set("edition", "260613");
    voteUrl.searchParams.set("choice", "A");

    const req = new Request(voteUrl.toString(), { method: "GET" });
    await worker.fetch(req, env, {} as ExecutionContext);

    // Antes do fix: 2-3 gets (checagem nickname + updateScore + updateScoreByMonth).
    // Após o fix: 1 get (lido antes do commit, repassado).
    // #2208 (item 3): `<= 1` aceitava 0 (score nunca lido) — o teste passaria mesmo se o
    // handleVote ignorasse completamente o score do subscriber. Pinar em === 1.
    assert.equal(
      scoreGetCount,
      1,
      `score:count@x.com deve ser lido exatamente 1x (got ${scoreGetCount}) — #2190/#2208`,
    );
  });
});

// ── #2191: renderLeaderboardHtml usa htmlEscape (cobre apóstrofe) ────────────

describe("#2191 — htmlEscape cobre apóstrofe em renderLeaderboardHtml", () => {
  // Testa o helper htmlEscape diretamente (renderLeaderboardHtml não é exportado
  // puro, mas a correção está em usar htmlEscape em vez do replace inline).
  it("htmlEscape escapa apóstrofe como &#39;", () => {
    // Regressão do bug: o replace inline omitia "'" → nickname com apóstrofe
    // era renderizado cru no HTML da tabela.
    assert.equal(htmlEscape("D'Artagnan"), "D&#39;Artagnan");
    assert.equal(htmlEscape("O'Brien"), "O&#39;Brien");
  });

  it("htmlEscape escapa todos os 5 caracteres especiais HTML", () => {
    // Garante cobertura completa (não só apóstrofe).
    assert.equal(htmlEscape("<>&\"'"), "&lt;&gt;&amp;&quot;&#39;");
  });

  it("nickname com apóstrofe em votePageHtml é escapado corretamente", () => {
    // votePageHtml usa htmlEscape para o nickname indiretamente (via nicknameForm).
    // Testa que o email com apóstrofe (edge case) é escapado no form.
    const html = votePageHtml(
      "Acertou!",
      true,
      { email: "o'brien@x.com", sig: "abc123" },
    );
    // O email com apóstrofe deve aparecer escapado como &#39; no HTML
    assert.match(html, /o&#39;brien@x\.com/, "apóstrofe no email deve ser escapada como &#39;");
    // E não deve aparecer cru (XSS prevention)
    assert.doesNotMatch(html, /o'brien@x\.com/, "apóstrofe cru não deve aparecer no HTML");
  });
});
