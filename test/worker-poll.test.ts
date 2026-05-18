/**
 * test/worker-poll.test.ts (#1083 / #1086)
 *
 * Cobre helpers puros do Worker `poll`:
 *   - formatEditionDate (AAMMDD → "10 de maio de 2026")
 *   - htmlEscape (XSS prevention no votePageHtml)
 *   - parseValidEditions (KV value → string[] | null)
 *   - isValidEdition (gate de aceitação de votos)
 *
 * Não testa handleVote/handleSetName end-to-end — pra isso precisaria do
 * `unstable_dev` do Wrangler (scope creep). Smoke manual via curl cobre
 * os fluxos integrados (#1083 PR body).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatEditionDate,
  htmlEscape,
  parseValidEditions,
  isValidEdition,
  redirectTargetForTrailingSlash,
  currentPeriodLabelBrt,
  previousPeriodLabelBrt,
  archiveKeyForReset,
} from "../workers/poll/src/lib.ts";
import { computeTop1 } from "../workers/poll/src/index.ts";

describe("formatEditionDate (#1080)", () => {
  it("converte AAMMDD pro formato pt-BR humano", () => {
    assert.equal(formatEditionDate("260511"), "11 de maio de 2026");
    assert.equal(formatEditionDate("260101"), "1 de janeiro de 2026");
    assert.equal(formatEditionDate("251231"), "31 de dezembro de 2025");
  });

  it("retorna input cru quando formato inválido (no-op safe)", () => {
    // Não deve crashar — comunicação com leitor pode receber valor estranho
    assert.equal(formatEditionDate("invalid"), "invalid");
    assert.equal(formatEditionDate(""), "");
    assert.equal(formatEditionDate("12345"), "12345"); // 5 dígitos
    assert.equal(formatEditionDate("1234567"), "1234567"); // 7 dígitos
  });

  it("retorna input cru quando MM ou DD fora de range (defesa contra typos)", () => {
    assert.equal(formatEditionDate("261301"), "261301"); // mês 13
    assert.equal(formatEditionDate("260132"), "260132"); // dia 32
    assert.equal(formatEditionDate("260000"), "260000"); // mês 0
  });

  it("ano 2000-2099 com prefixo 20YY", () => {
    assert.equal(formatEditionDate("000101"), "1 de janeiro de 2000");
    assert.equal(formatEditionDate("991231"), "31 de dezembro de 2099");
  });
});

describe("htmlEscape (#1083)", () => {
  it("escapa caracteres especiais HTML", () => {
    assert.equal(htmlEscape("<script>"), "&lt;script&gt;");
    assert.equal(htmlEscape('"'), "&quot;");
    assert.equal(htmlEscape("'"), "&#39;");
    assert.equal(htmlEscape("&"), "&amp;");
  });

  it("ordem correta — & primeiro pra não escapar dobrado", () => {
    // Se & fosse processado depois de < ou >, "&lt;" viraria "&amp;lt;"
    assert.equal(htmlEscape("a < b & c > d"), "a &lt; b &amp; c &gt; d");
  });

  it("XSS payload típico via attribute break", () => {
    // Email malicioso (improvável mas defensivo) que tentaria escapar
    // do <input value="..."> pra injetar tag
    const payload = `evil"><script>alert(1)</script>`;
    const escaped = htmlEscape(payload);
    assert.match(escaped, /&quot;/);
    assert.match(escaped, /&lt;script&gt;/);
    assert.doesNotMatch(escaped, /<script>/);
  });

  it("strings normais passam intactas", () => {
    assert.equal(htmlEscape("usuario@example.com"), "usuario@example.com");
    assert.equal(htmlEscape("11 de maio de 2026"), "11 de maio de 2026");
    assert.equal(htmlEscape(""), "");
  });

  it("emojis e UTF-8 não-ASCII passam intactos", () => {
    assert.equal(htmlEscape("✅ Acertou!"), "✅ Acertou!");
    assert.equal(htmlEscape("ç ã é í"), "ç ã é í");
  });
});

describe("parseValidEditions (#1086)", () => {
  it("retorna null pra raw=null (KV key ausente → fail-open)", () => {
    assert.equal(parseValidEditions(null), null);
  });

  it("retorna null pra string vazia", () => {
    assert.equal(parseValidEditions(""), null);
  });

  it("parseia array JSON válido", () => {
    assert.deepEqual(parseValidEditions(`["260511"]`), ["260511"]);
    assert.deepEqual(
      parseValidEditions(`["260511","260512","260513"]`),
      ["260511", "260512", "260513"],
    );
  });

  it("retorna null pra JSON corrupted (fail-open)", () => {
    assert.equal(parseValidEditions(`{invalid json`), null);
    assert.equal(parseValidEditions(`["unterminated`), null);
  });

  it("retorna null quando JSON válido mas não-array (fail-open)", () => {
    assert.equal(parseValidEditions(`"260511"`), null);
    assert.equal(parseValidEditions(`{"editions":["260511"]}`), null);
    assert.equal(parseValidEditions(`42`), null);
  });

  it("filtra entries não-string do array", () => {
    assert.deepEqual(
      parseValidEditions(`["260511", 260512, null, "260513"]`),
      ["260511", "260513"],
    );
  });

  it("retorna array vazio quando JSON é []", () => {
    assert.deepEqual(parseValidEditions(`[]`), []);
  });
});

describe("isValidEdition (#1086)", () => {
  it("aceita qualquer edição quando set é null (fail-open)", () => {
    assert.equal(isValidEdition(null, "260511"), true);
    assert.equal(isValidEdition(null, "999999"), true);
  });

  it("aceita qualquer edição quando set é vazio (compat antes do gate)", () => {
    assert.equal(isValidEdition([], "260511"), true);
  });

  it("aceita edição presente no set", () => {
    assert.equal(isValidEdition(["260511", "260512"], "260511"), true);
    assert.equal(isValidEdition(["260511", "260512"], "260512"), true);
  });

  it("rejeita edição ausente do set", () => {
    assert.equal(isValidEdition(["260511"], "260510"), false);
    assert.equal(isValidEdition(["260511"], "260512"), false);
    assert.equal(isValidEdition(["260511"], "999999"), false);
  });

  it("case-sensitive (AAMMDD é numérico, não tem case mas defensive)", () => {
    // edition vem sempre de URL param trim+upper-no-op pra AAMMDD numérico
    assert.equal(isValidEdition(["260511"], "260511"), true);
  });
});

describe("redirectTargetForTrailingSlash (#1319)", () => {
  it("/leaderboard/ → /leaderboard (regressão do bug original)", () => {
    assert.equal(redirectTargetForTrailingSlash("/leaderboard/"), "/leaderboard");
  });
  it("/vote/ → /vote", () => {
    assert.equal(redirectTargetForTrailingSlash("/vote/"), "/vote");
  });
  it("/stats/ → /stats", () => {
    assert.equal(redirectTargetForTrailingSlash("/stats/"), "/stats");
  });
  it("/admin/correct/ → /admin/correct", () => {
    assert.equal(redirectTargetForTrailingSlash("/admin/correct/"), "/admin/correct");
  });

  it("retorna null pra paths sem trailing slash (canonical já)", () => {
    assert.equal(redirectTargetForTrailingSlash("/leaderboard"), null);
    assert.equal(redirectTargetForTrailingSlash("/vote"), null);
    assert.equal(redirectTargetForTrailingSlash("/stats"), null);
  });

  it("preserva raiz '/' (não é trailing slash redundante)", () => {
    assert.equal(redirectTargetForTrailingSlash("/"), null);
  });

  it("preserva /img/{key} mesmo com trailing slash (key pode terminar em /)", () => {
    assert.equal(redirectTargetForTrailingSlash("/img/key/"), null);
    assert.equal(redirectTargetForTrailingSlash("/img/foo.jpg/"), null);
  });
});

describe("currentPeriodLabelBrt (#1083)", () => {
  it("retorna nome do mês em pt-BR capitalizado pra UTC bem dentro do mês", () => {
    // Meio do mês de Maio em UTC — BRT também é Maio
    assert.equal(currentPeriodLabelBrt(new Date("2026-05-15T12:00:00Z")), "Maio");
  });

  it("BRT compensation — 02:00 UTC do dia 1 = 23:00 BRT do mês anterior", () => {
    // 2026-06-01T02:00:00Z = 2026-05-31T23:00:00 BRT
    assert.equal(currentPeriodLabelBrt(new Date("2026-06-01T02:00:00Z")), "Maio");
  });

  it("após 03:00 UTC do dia 1, BRT também já é dia 1 do novo mês", () => {
    // 2026-06-01T04:00:00Z = 2026-06-01T01:00:00 BRT
    assert.equal(currentPeriodLabelBrt(new Date("2026-06-01T04:00:00Z")), "Junho");
  });

  it("cobre todos os 12 meses do ano", () => {
    const months = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
    for (let m = 0; m < 12; m++) {
      const date = new Date(Date.UTC(2026, m, 15, 12, 0, 0));
      assert.equal(currentPeriodLabelBrt(date), months[m]);
    }
  });
});

describe("previousPeriodLabelBrt (#1077)", () => {
  it("dia 1 às 03:01 UTC (cron trigger) → mês anterior", () => {
    // Cron roda dia 1 às 03:01 UTC. BRT: 00:01 do dia 1.
    // setUTCDate(0) → último dia do mês anterior = 2026-05-31
    assert.equal(previousPeriodLabelBrt(new Date("2026-06-01T03:01:00Z")), "Maio");
  });

  it("dia 15 às 12:00 UTC (no meio do mês) → mês anterior pra reset retroativo", () => {
    // Cenário: reset rodado manualmente fora do horário do cron. BRT = dia 15.
    // setUTCDate(0) volta pro último dia do mês anterior em relação ao mês de BRT.
    assert.equal(previousPeriodLabelBrt(new Date("2026-06-15T12:00:00Z")), "Maio");
  });

  it("janeiro → dezembro do ano anterior", () => {
    assert.equal(previousPeriodLabelBrt(new Date("2027-01-01T03:01:00Z")), "Dezembro");
  });
});

describe("archiveKeyForReset (#1077)", () => {
  it("formato score-archive:YYYY-MM:email com mês anterior", () => {
    const k = archiveKeyForReset("user@x.com", new Date("2026-06-01T03:01:00Z"));
    assert.equal(k, "score-archive:2026-05:user@x.com");
  });

  it("janeiro arquiva como dezembro do ano anterior", () => {
    const k = archiveKeyForReset("user@x.com", new Date("2027-01-01T03:01:00Z"));
    assert.equal(k, "score-archive:2026-12:user@x.com");
  });

  it("email com + preserva como é (Beehiiv merge tag)", () => {
    const k = archiveKeyForReset("subscriber+tag@example.com", new Date("2026-06-01T03:01:00Z"));
    assert.equal(k, "score-archive:2026-05:subscriber+tag@example.com");
  });
});

describe("computeTop1 (#1160)", () => {
  it("retorna apenas o(s) líder(es) por pct + correct", () => {
    const r = computeTop1([
      { email: "a@x.com", nickname: "Alice", correct: 12, total: 12 },
      { email: "b@x.com", nickname: "Bob", correct: 10, total: 12 },
      { email: "c@x.com", nickname: "Carol", correct: 11, total: 11 },
    ]);
    // Alice + Carol têm 100%. Tiebreaker correct: Alice 12 > Carol 11 → só Alice.
    assert.equal(r.length, 1);
    assert.equal(r[0].nickname, "Alice");
    assert.equal(r[0].pct, 100);
    assert.equal(r[0].correct, 12);
  });

  it("empate completo (mesmo pct + correct) → múltiplos no top1", () => {
    const r = computeTop1([
      { email: "a@x.com", nickname: "Alice", correct: 10, total: 10 },
      { email: "b@x.com", nickname: "Bob", correct: 10, total: 10 },
      { email: "c@x.com", nickname: "Carol", correct: 5, total: 10 },
    ]);
    assert.equal(r.length, 2);
    assert.deepEqual(r.map((s) => s.nickname).sort(), ["Alice", "Bob"]);
  });

  it("scores sem nickname são excluídos (privacy)", () => {
    const r = computeTop1([
      { email: "a@x.com", nickname: null, correct: 12, total: 12 },
      { email: "b@x.com", nickname: "Bob", correct: 10, total: 10 },
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].nickname, "Bob");
  });

  it("scores com total=0 excluídos", () => {
    const r = computeTop1([
      { email: "a@x.com", nickname: "Alice", correct: 0, total: 0 },
      { email: "b@x.com", nickname: "Bob", correct: 5, total: 5 },
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].nickname, "Bob");
  });

  it("array vazio retorna []", () => {
    assert.deepEqual(computeTop1([]), []);
  });

  it("ordenação determinística — nickname ASC quando completamente empatado", () => {
    const r = computeTop1([
      { email: "z@x.com", nickname: "Zoe", correct: 10, total: 10 },
      { email: "a@x.com", nickname: "Alice", correct: 10, total: 10 },
      { email: "b@x.com", nickname: "Bob", correct: 10, total: 10 },
    ]);
    assert.deepEqual(r.map((s) => s.nickname), ["Alice", "Bob", "Zoe"]);
  });
});
