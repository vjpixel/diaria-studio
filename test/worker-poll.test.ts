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
  editionToMonthSlug,
  parseMonthSlug,
  currentMonthSlugBrt,
  monthSlugCompare,
} from "../workers/poll/src/lib.ts";
import { computeTop1, scoreByMonthEntriesToLeaderboard, listAllKeys } from "../workers/poll/src/index.ts";

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

describe("editionToMonthSlug (#1345)", () => {
  it("AAMMDD → YYYY-MM", () => {
    assert.equal(editionToMonthSlug("260518"), "2026-05");
    assert.equal(editionToMonthSlug("260101"), "2026-01");
    assert.equal(editionToMonthSlug("251231"), "2025-12");
  });

  it("formato inválido → null", () => {
    assert.equal(editionToMonthSlug("12345"), null);
    assert.equal(editionToMonthSlug("1234567"), null);
    assert.equal(editionToMonthSlug("invalid"), null);
    assert.equal(editionToMonthSlug(""), null);
  });

  it("mês fora de range → null", () => {
    assert.equal(editionToMonthSlug("261301"), null);
    assert.equal(editionToMonthSlug("260001"), null);
  });
});

describe("parseMonthSlug (#1345)", () => {
  it("YYYY-MM válido", () => {
    assert.deepEqual(parseMonthSlug("2026-05"), { year: 2026, month: 5 });
    assert.deepEqual(parseMonthSlug("2025-12"), { year: 2025, month: 12 });
  });

  it("formato inválido → null", () => {
    assert.equal(parseMonthSlug("2026-5"), null); // mês não zero-padded
    assert.equal(parseMonthSlug("26-05"), null); // ano abreviado
    assert.equal(parseMonthSlug("2026/05"), null);
    assert.equal(parseMonthSlug("maio-2026"), null);
  });

  it("range inválido → null", () => {
    assert.equal(parseMonthSlug("2026-13"), null);
    assert.equal(parseMonthSlug("2026-00"), null);
    assert.equal(parseMonthSlug("1999-05"), null); // antes 2000
    assert.equal(parseMonthSlug("2100-05"), null); // depois 2099
  });
});

describe("currentMonthSlugBrt (#1345)", () => {
  it("12:00 UTC do meio do mês → slug correto", () => {
    assert.equal(currentMonthSlugBrt(new Date("2026-05-15T12:00:00Z")), "2026-05");
  });

  it("BRT compensation — 02:00 UTC do dia 1 ainda é mês anterior", () => {
    // 02:00 UTC dia 1 jun = 23:00 BRT dia 31 mai → slug = 2026-05
    assert.equal(currentMonthSlugBrt(new Date("2026-06-01T02:00:00Z")), "2026-05");
  });

  it("após 03:00 UTC do dia 1 = mês novo em BRT", () => {
    assert.equal(currentMonthSlugBrt(new Date("2026-06-01T04:00:00Z")), "2026-06");
  });
});

describe("monthSlugCompare (#1345)", () => {
  it("string compare funciona pra slugs zero-padded", () => {
    assert.equal(monthSlugCompare("2026-05", "2026-06"), -1);
    assert.equal(monthSlugCompare("2026-06", "2026-05"), 1);
    assert.equal(monthSlugCompare("2026-05", "2026-05"), 0);
    assert.equal(monthSlugCompare("2025-12", "2026-01"), -1);
  });
});

describe("scoreByMonthEntriesToLeaderboard (#1345)", () => {
  it("computa pct + preserva nickname", () => {
    const r = scoreByMonthEntriesToLeaderboard([
      { email: "a@x.com", nickname: "Alice", correct: 8, total: 10 },
      { email: "b@x.com", nickname: null, correct: 5, total: 5 },
    ]);
    assert.equal(r.length, 2);
    assert.equal(r[0].pct, 80);
    assert.equal(r[1].pct, 100);
    assert.equal(r[0].nickname, "Alice");
    assert.equal(r[1].nickname, null);
  });

  it("total=0 → pct=0 (não NaN)", () => {
    const r = scoreByMonthEntriesToLeaderboard([
      { email: "a@x.com", nickname: "Alice", correct: 0, total: 0 },
    ]);
    assert.equal(r[0].pct, 0);
  });

  it("array vazio → []", () => {
    assert.deepEqual(scoreByMonthEntriesToLeaderboard([]), []);
  });

  it("streak sempre 0 (out of scope no índice mensal)", () => {
    const r = scoreByMonthEntriesToLeaderboard([
      { email: "a@x.com", nickname: "Alice", correct: 5, total: 5 },
    ]);
    assert.equal(r[0].streak, 0);
  });
});

describe("listAllKeys — KV pagination (#1347)", () => {
  /**
   * Mock KV: simula resposta paginada via cursor. Cloudflare KV retorna max
   * 1000 keys/call e indica continuação via `cursor` + `list_complete: false`.
   * Mock fake aceita prefix e devolve páginas de tamanho fixo.
   */
  function makeMockEnv(allKeys: string[], pageSize = 3): { POLL: { list: (opts: { prefix: string; cursor?: string }) => Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }> } } {
    return {
      POLL: {
        async list(opts: { prefix: string; cursor?: string }) {
          const filtered = allKeys.filter((k) => k.startsWith(opts.prefix));
          // cursor é o index do próximo item — number stringified pra realismo
          const startIdx = opts.cursor ? parseInt(opts.cursor, 10) : 0;
          const pageKeys = filtered.slice(startIdx, startIdx + pageSize);
          const nextIdx = startIdx + pageKeys.length;
          const isComplete = nextIdx >= filtered.length;
          return {
            keys: pageKeys.map((name) => ({ name })),
            list_complete: isComplete,
            cursor: isComplete ? undefined : String(nextIdx),
          };
        },
      },
    };
  }

  async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
    const out: string[] = [];
    for await (const k of gen) out.push(k);
    return out;
  }

  it("itera todas as keys quando só 1 página", async () => {
    const env = makeMockEnv(["a:1", "a:2", "b:1"], 3);
    const r = await collect(listAllKeys(env as never, "a:"));
    assert.deepEqual(r, ["a:1", "a:2"]);
  });

  it("itera através de múltiplas páginas via cursor", async () => {
    // 7 keys, pageSize 3 → 3 páginas (3, 3, 1)
    const allKeys = ["k:1", "k:2", "k:3", "k:4", "k:5", "k:6", "k:7"];
    const env = makeMockEnv(allKeys, 3);
    const r = await collect(listAllKeys(env as never, "k:"));
    assert.deepEqual(r, allKeys);
  });

  it("para no list_complete sem cursor extra", async () => {
    let calls = 0;
    const env = {
      POLL: {
        async list(_opts: { prefix: string; cursor?: string }) {
          calls++;
          return {
            keys: [{ name: "only:1" }],
            list_complete: true,
            cursor: undefined,
          };
        },
      },
    };
    const r = await collect(listAllKeys(env as never, "only:"));
    assert.deepEqual(r, ["only:1"]);
    assert.equal(calls, 1, "deve fazer apenas 1 list call quando complete=true");
  });

  it("filtra por prefix mesmo em multi-page", async () => {
    const allKeys = ["a:1", "b:1", "a:2", "b:2", "a:3", "b:3"];
    const env = makeMockEnv(allKeys, 2);
    const r = await collect(listAllKeys(env as never, "a:"));
    assert.deepEqual(r, ["a:1", "a:2", "a:3"]);
  });

  it("retorna [] quando nenhuma key bate prefix", async () => {
    const env = makeMockEnv(["a:1", "b:1"], 10);
    const r = await collect(listAllKeys(env as never, "z:"));
    assert.deepEqual(r, []);
  });

  it("cobre 1500 keys (> 1 página real de 1000 — regression test do bug #1347)", async () => {
    // Simula o cenário que motivou o PR: >1000 keys silenciosamente truncadas
    // pelo list call único. Com listAllKeys, todas viram.
    const allKeys = Array.from({ length: 1500 }, (_, i) => `vote:260518:user${i}@x.com`);
    const env = makeMockEnv(allKeys, 1000); // simula limit real do KV
    const r = await collect(listAllKeys(env as never, "vote:260518:"));
    assert.equal(r.length, 1500, "todas as 1500 keys devem ser yielded — sem cursor, perdíamos 500");
  });
});
