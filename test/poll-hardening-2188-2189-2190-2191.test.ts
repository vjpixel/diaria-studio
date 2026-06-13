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
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

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
    // O voto correct===false DEVE ser re-pontuado (updated_votes >= 1)
    assert.ok(body.updated_votes >= 1, `deve ter atualizado ao menos 1 voto (got ${body.updated_votes})`);

    // Verifica que o voto foi regravado com correct=true
    const voteRaw = await kv.get("vote:260613:leitor@x.com");
    const vote = JSON.parse(voteRaw!);
    assert.equal(vote.correct, true, "vote.correct deve ser true após backfill com gabarito correto");

    // Verifica que o score foi atualizado (correct incrementou)
    const scoreRaw = await kv.get("score:leitor@x.com");
    const score = JSON.parse(scoreRaw!);
    assert.ok(score.correct > 0, `score.correct deve ter incrementado (got ${score.correct})`);
    // #2202 (P1): garante que total NÃO foi double-incremented pelo backfill.
    // updateScore re-incrementava total (double-count); adjustScoreCorrectOnly não toca total.
    assert.equal(score.total, 1, `score.total NÃO deve ser re-incrementado pelo backfill — deve ser 1 (got ${score.total})`);
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
  });

  it("#2202 (P1): backfill NÃO re-incrementa total (double-count regression)", async () => {
    // Regressão específica do double-increment: updateScore fazia score.total += 1 de novo.
    // adjustScoreCorrectOnly NÃO deve tocar total.
    const kv = makeTrackedKv({
      "correct:260615": "A",
      // Leitor: votou A, gabarito ainda null → correct=null; total=1 gravado pelo handleVote
      "vote:260615:dbl@x.com": JSON.stringify({ choice: "A", ts: "t", correct: null }),
      "score:dbl@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260615", nickname: null }),
    });

    // Admin define gabarito A
    const res = await callAdminCorrect(kv, "260615", "A");
    assert.equal(res.status, 200);

    const scoreRaw = await kv.get("score:dbl@x.com");
    const score = JSON.parse(scoreRaw!);
    // total DEVE continuar 1 (não 2) — invariante do backfill
    assert.equal(score.total, 1, `total NÃO deve ser double-incremented — deve ser 1 (got ${score.total})`);
    // correct deve ter sido incrementado para 1 (null→true)
    assert.equal(score.correct, 1, `correct deve ser 1 após backfill null→true (got ${score.correct})`);
    // streak NÃO deve ser tocado pelo backfill
    assert.equal(score.streak, 0, `streak NÃO deve ser incrementado pelo backfill (got ${score.streak})`);
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
    assert.ok(
      scoreGetCount <= 1,
      `score:count@x.com deve ser lido no máximo 1x (got ${scoreGetCount}) — #2190`,
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
