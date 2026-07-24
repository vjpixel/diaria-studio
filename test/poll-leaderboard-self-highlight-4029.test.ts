/**
 * test/poll-leaderboard-self-highlight-4029.test.ts (#4029)
 *
 * "eia-web/leaderboard: mostrar TODOS os jogadores + destacar a linha do
 * próprio jogador" — pedido do editor (sessão 260724). Cobre:
 *
 *   1. Corte de exibição sobe de 50 pra LEADERBOARD_DISPLAY_CAP (500) —
 *      decisão do editor: cap alto como salvaguarda de escala, cauda 0/N
 *      (#4008 item 2) continua agregada/escondida (não reabre aquela
 *      decisão).
 *   2. Self-highlight: cada linha ganha um `data-uid` opaco
 *      (`hashEmailForMatch`, lib.ts) — o browser casa a PRÓPRIA identidade
 *      local (brand `web`, `localStorage["eia_web_identified_email"]`)
 *      contra esse atributo sem o servidor nunca expor e-mail de ninguém em
 *      claro. Só brand `web` ganha o script (único brand com identidade
 *      client-side) — diaria/clarice não.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashEmailForMatch } from "../workers/poll/src/lib.ts";
import { handleLeaderboardByMonth, LEADERBOARD_DISPLAY_CAP } from "../workers/poll/src/leaderboard-routes.ts";
import type { Env } from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

function makeEnv(seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
  return {
    POLL: makeTrackedKv(seed),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  } as Env & { POLL: ReturnType<typeof makeTrackedKv> };
}

describe("hashEmailForMatch (lib.ts, pure) — hash opaco pro self-highlight", () => {
  it("determinístico — mesmo e-mail sempre produz o mesmo hash", () => {
    assert.equal(hashEmailForMatch("ana@x.com"), hashEmailForMatch("ana@x.com"));
  });

  it("case/whitespace-insensitive — normaliza antes de hashear (mesma identidade, capitalização/espaço diferente)", () => {
    assert.equal(hashEmailForMatch("Ana@X.com"), hashEmailForMatch("ana@x.com"));
    assert.equal(hashEmailForMatch("  ana@x.com  "), hashEmailForMatch("ana@x.com"));
  });

  it("e-mails diferentes produzem hashes diferentes (sem colisão nos casos triviais)", () => {
    assert.notEqual(hashEmailForMatch("ana@x.com"), hashEmailForMatch("bob@x.com"));
  });

  it("nunca contém o e-mail em claro no output (hex puro)", () => {
    const hash = hashEmailForMatch("ana@x.com");
    assert.match(hash, /^[0-9a-f]{8}$/);
  });
});

describe("LEADERBOARD_DISPLAY_CAP (#4029 item 1) — corte subiu de 50 pra 500", () => {
  it("constante é 500 (sanity — se mudar, os testes abaixo devem ser revistos)", () => {
    assert.equal(LEADERBOARD_DISPLAY_CAP, 500);
  });

  it("renderiza mais de 50 jogadores quando há mais de 50 elegíveis (corte antigo não se aplica mais)", async () => {
    const seed: Record<string, string> = {};
    for (let i = 0; i < 80; i++) {
      seed[`score-by-month:2020-01:player${i}@x.com`] = JSON.stringify({ total: 5, correct: 3, nickname: `Player${i}` });
    }
    const env = makeEnv(seed);
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria");
    const html = await res.text();
    for (let i = 0; i < 80; i++) {
      assert.match(html, new RegExp(`Player${i}\\b`), `Player${i} deve aparecer — corte antigo de 50 escondia jogadores 51-80`);
    }
  });
});

describe("self-highlight (#4029 item 2) — data-uid por linha + script client-side (só brand web)", () => {
  it("brand web: cada linha ganha data-uid (hashEmailForMatch do e-mail da entry)", async () => {
    const env = makeEnv({
      "score-by-month:2020-01:ana@example.com": JSON.stringify({ total: 5, correct: 4, nickname: "Ana" }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "web");
    const html = await res.text();
    const expectedUid = hashEmailForMatch("ana@example.com");
    assert.match(html, new RegExp(`data-uid="${expectedUid}"`));
  });

  it("brand web: script de self-highlight presente, lê localStorage e casa contra data-uid", async () => {
    const env = makeEnv({
      "score-by-month:2020-01:ana@example.com": JSON.stringify({ total: 5, correct: 4, nickname: "Ana" }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "web");
    const html = await res.text();
    assert.match(html, /eia_web_identified_email/, "script deve ler a mesma chave de identidade que jogar.ts/identify.ts escrevem");
    assert.match(html, /function hashEmailForMatch\(email\)/, "gêmeo JS do hash — mesmo algoritmo do server (FNV-1a)");
    assert.match(html, /tr\[data-uid="/, "script deve buscar a <tr> pelo data-uid calculado");
  });

  it("gêmeo JS embutido produz EXATAMENTE o mesmo hash que hashEmailForMatch (lib.ts) — extrai a função do script e roda de verdade, não só compara texto", async () => {
    const env = makeEnv({
      "score-by-month:2020-01:ana@example.com": JSON.stringify({ total: 5, correct: 4, nickname: "Ana" }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "web");
    const html = await res.text();
    const match = html.match(/function hashEmailForMatch\(email\) \{[\s\S]*?\n  \}/);
    assert.ok(match, "função hashEmailForMatch deve estar presente no <script>");
    // eslint-disable-next-line no-new-func -- extrai o gêmeo JS de verdade do
    // HTML servido (não uma cópia mantida à mão no teste) e roda com
    // Math.imul real do runtime — garante que o server e o client nunca
    // divergem silenciosamente (mesma disciplina que o resto do worker já
    // documenta pra formatSeqFinalScore/computeSeqSkipAndCredit em jogar.ts).
    const clientHashEmailForMatch = new Function(`${match[0]}; return hashEmailForMatch;`)();
    for (const email of ["ana@example.com", "Ana@Example.com", "  bob@x.com  ", "não-ascii@exemplo.com.br"]) {
      assert.equal(clientHashEmailForMatch(email), hashEmailForMatch(email), `hash diverge pra "${email}"`);
    }
  });

  it("brand web: CTA 'jogue e apareça' presente (hidden por padrão) pra quando a identidade não é encontrada na tabela", async () => {
    const env = makeEnv({
      "score-by-month:2020-01:ana@example.com": JSON.stringify({ total: 5, correct: 4, nickname: "Ana" }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "web");
    const html = await res.text();
    assert.match(html, /<p id="self-cta" class="self-cta" hidden>/);
    assert.match(html, /href="\/jogar"/);
  });

  it("brand diaria: NÃO ganha o script de self-highlight (sem identidade client-side nesse brand)", async () => {
    const env = makeEnv({
      "score-by-month:2020-01:ana@x.com": JSON.stringify({ total: 5, correct: 4, nickname: "Ana" }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria");
    const html = await res.text();
    assert.doesNotMatch(html, /eia_web_identified_email/);
    assert.doesNotMatch(html, /id="self-cta"/);
  });

  it("brand diaria: linhas continuam com data-uid (custo desprezível, mantém 1 único caminho de render) mesmo sem script consumidor", async () => {
    const env = makeEnv({
      "score-by-month:2020-01:ana@x.com": JSON.stringify({ total: 5, correct: 4, nickname: "Ana" }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria");
    const html = await res.text();
    assert.match(html, /data-uid="/);
  });

  it("anti-vazamento: e-mail em claro nunca aparece no HTML (só o hash opaco + nickname/masked)", async () => {
    const env = makeEnv({
      "score-by-month:2020-01:secreto@example.com": JSON.stringify({ total: 5, correct: 4, nickname: null }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "web");
    const html = await res.text();
    assert.doesNotMatch(html, /secreto@example\.com/);
  });
});
