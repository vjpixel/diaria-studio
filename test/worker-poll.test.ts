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
  normalizeNickname,
  isBlacklistedNickname,
  nicknameHasContent,
  validateNickname,
} from "../workers/poll/src/lib.ts";
import {
  computeTop1,
  computePodium,
  scoreByMonthEntriesToLeaderboard,
  listAllKeys,
  computeSnapshotEntries,
  requiredSecretsForRoute,
  missingSecretsForRoute,
  votePageHtml,
  recordVoteLog,
  buildVoteLogEntry,
  handleSetName,
  hmacSign,
  type Env,
} from "../workers/poll/src/index.ts";

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

describe("computePodium (#1160 followup — masked email fallback)", () => {
  it("retorna ranks 1-3 com nicknames quando todos têm", () => {
    const r = computePodium([
      { email: "a@x.com", nickname: "Alice", correct: 12, total: 12 },
      { email: "b@x.com", nickname: "Bob", correct: 10, total: 12 },
      { email: "c@x.com", nickname: "Carol", correct: 8, total: 12 },
      { email: "d@x.com", nickname: "Dave", correct: 6, total: 12 },
    ]);
    assert.equal(r.length, 3);
    assert.deepEqual(r.map((e) => e.nickname), ["Alice", "Bob", "Carol"]);
    assert.deepEqual(r.map((e) => e.rank), [1, 2, 3]);
  });

  it("entries sem nickname incluídas com email mascarado", () => {
    const r = computePodium([
      { email: "alice@example.com", nickname: "Alice", correct: 10, total: 10 },
      { email: "becker.anacandida@example.com", nickname: null, correct: 9, total: 10 },
      { email: "carol@example.com", nickname: "Carol", correct: 8, total: 10 },
    ]);
    assert.equal(r.length, 3);
    assert.deepEqual(r.map((e) => e.nickname), [
      "Alice",
      "becker.anacandida@***",
      "Carol",
    ]);
    assert.deepEqual(r.map((e) => e.rank), [1, 2, 3]);
  });

  it("nickname vazio/whitespace cai pra masked email", () => {
    const r = computePodium([
      { email: "a@x.com", nickname: "   ", correct: 10, total: 10 },
      { email: "b@x.com", nickname: "", correct: 10, total: 10 },
    ]);
    assert.equal(r.length, 2);
    assert.deepEqual(r.map((e) => e.nickname).sort(), ["a@***", "b@***"]);
  });

  it("filtra entries com total=0", () => {
    const r = computePodium([
      { email: "a@x.com", nickname: "Alice", correct: 0, total: 0 },
      { email: "b@x.com", nickname: "Bob", correct: 5, total: 5 },
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].nickname, "Bob");
  });

  it("array vazio → []", () => {
    assert.deepEqual(computePodium([]), []);
  });

  it("dense rank com empate em rank 1 (2 ouros, 1 prata)", () => {
    const r = computePodium([
      { email: "a@x.com", nickname: "Alice", correct: 10, total: 10 },
      { email: "b@x.com", nickname: "Bob", correct: 10, total: 10 },
      { email: "c@x.com", nickname: "Carol", correct: 9, total: 10 },
    ]);
    assert.deepEqual(r.map((e) => e.rank), [1, 1, 2]);
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

describe("computeSnapshotEntries — parallel gets (#1348)", () => {
  /**
   * Mock KV que conta calls. Verifica que gets acontecem em batches paralelos
   * (Promise.all) e não sequencialmente.
   */
  function makeMockEnvWithGets(
    keyValueMap: Map<string, string>,
  ): {
    POLL: {
      list: (opts: { prefix: string; cursor?: string }) => Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>;
      get: (key: string) => Promise<string | null>;
    };
    getCallTimes: number[];
  } {
    const keys = [...keyValueMap.keys()];
    const getCallTimes: number[] = [];
    return {
      getCallTimes,
      POLL: {
        async list(opts: { prefix: string; cursor?: string }) {
          const filtered = keys.filter((k) => k.startsWith(opts.prefix));
          return { keys: filtered.map((name) => ({ name })), list_complete: true, cursor: undefined };
        },
        async get(key: string) {
          getCallTimes.push(Date.now());
          // Simula latência KV ~5ms
          await new Promise((r) => setTimeout(r, 5));
          return keyValueMap.get(key) ?? null;
        },
      },
    };
  }

  it("retorna entries de todas as keys do prefix", async () => {
    const data = new Map([
      ["score-by-month:2026-05:alice@x.com", JSON.stringify({ nickname: "Alice", correct: 5, total: 5 })],
      ["score-by-month:2026-05:bob@x.com", JSON.stringify({ nickname: "Bob", correct: 3, total: 5 })],
    ]);
    const env = makeMockEnvWithGets(data);
    const entries = await computeSnapshotEntries(env as never, "2026-05");
    assert.equal(entries.length, 2);
    const byEmail = Object.fromEntries(entries.map((e) => [e.email, e]));
    assert.equal(byEmail["alice@x.com"].nickname, "Alice");
    assert.equal(byEmail["alice@x.com"].correct, 5);
    assert.equal(byEmail["bob@x.com"].nickname, "Bob");
  });

  it("filtra entries com raw null (key listada mas get retorna null)", async () => {
    // Mock customizado: list inclui key fantasma que get retorna null
    // (cenário real: list eventual-consistent, key foi deletada após list)
    const env = {
      POLL: {
        async list(opts: { prefix: string; cursor?: string }) {
          return {
            keys: [
              { name: "score-by-month:2026-05:alice@x.com" },
              { name: "score-by-month:2026-05:ghost@x.com" }, // get vai retornar null
            ],
            list_complete: true,
            cursor: undefined,
          };
        },
        async get(key: string) {
          if (key === "score-by-month:2026-05:alice@x.com") {
            return JSON.stringify({ nickname: "Alice", correct: 5, total: 5 });
          }
          return null; // ghost retorna null
        },
      },
    };
    const entries = await computeSnapshotEntries(env as never, "2026-05");
    assert.equal(entries.length, 1, "ghost entry filtrada — apenas Alice no resultado");
    assert.equal(entries[0].email, "alice@x.com");
  });

  it("skip entry com JSON corrupted (review fix A)", async () => {
    const env = {
      POLL: {
        async list(_opts: { prefix: string; cursor?: string }) {
          return {
            keys: [
              { name: "score-by-month:2026-05:alice@x.com" },
              { name: "score-by-month:2026-05:corrupt@x.com" },
            ],
            list_complete: true,
            cursor: undefined,
          };
        },
        async get(key: string) {
          if (key === "score-by-month:2026-05:alice@x.com") {
            return JSON.stringify({ nickname: "Alice", correct: 5, total: 5 });
          }
          return "{invalid json"; // JSON.parse throws
        },
      },
    };
    const entries = await computeSnapshotEntries(env as never, "2026-05");
    // Corrupted entry skipada, Alice preservada — compute não morre.
    assert.equal(entries.length, 1);
    assert.equal(entries[0].email, "alice@x.com");
  });

  it("defaults pra correct/total/nickname ausentes na entry", async () => {
    const data = new Map([
      ["score-by-month:2026-05:partial@x.com", JSON.stringify({ nickname: "Partial" })],
    ]);
    const env = makeMockEnvWithGets(data);
    const entries = await computeSnapshotEntries(env as never, "2026-05");
    assert.equal(entries[0].correct, 0);
    assert.equal(entries[0].total, 0);
  });

  it("batch parallel — gets concorrentes dentro do batch (review fix C: call-count em vez de timing)", async () => {
    // Substituiu assertion temporal (flaky em CI) por call-count: verificar
    // que dentro de um batch, todos os gets disparam ANTES do primeiro
    // resolver. Isso prova paralelização sem depender de wall-clock.
    let inFlight = 0;
    let maxConcurrent = 0;
    const data = new Map<string, string>();
    for (let i = 0; i < 40; i++) {
      data.set(`score-by-month:2026-05:user${i}@x.com`, JSON.stringify({ correct: 1, total: 1 }));
    }
    const env = {
      POLL: {
        async list(_opts: { prefix: string; cursor?: string }) {
          return {
            keys: [...data.keys()].map((name) => ({ name })),
            list_complete: true,
            cursor: undefined,
          };
        },
        async get(key: string) {
          inFlight++;
          if (inFlight > maxConcurrent) maxConcurrent = inFlight;
          await new Promise((r) => setTimeout(r, 1));
          inFlight--;
          return data.get(key) ?? null;
        },
      },
    };
    await computeSnapshotEntries(env as never, "2026-05");
    // Batch size = 20 — dentro de cada batch, gets concorrentes ⇒ peak >= 20.
    // Se fosse sequencial, peak seria 1.
    assert.ok(
      maxConcurrent >= 20,
      `paralelização: esperado peak >= 20 in-flight, observado ${maxConcurrent}`,
    );
  });

  it("empty prefix retorna []", async () => {
    const env = makeMockEnvWithGets(new Map());
    const entries = await computeSnapshotEntries(env as never, "2026-05");
    assert.deepEqual(entries, []);
  });
});

describe("requiredSecretsForRoute (#1420)", () => {
  it("GET /vote → POLL_SECRET", () => {
    assert.deepEqual(requiredSecretsForRoute("/vote", "GET"), ["POLL_SECRET"]);
  });

  it("GET /set-name → POLL_SECRET", () => {
    assert.deepEqual(requiredSecretsForRoute("/set-name", "GET"), ["POLL_SECRET"]);
  });

  it("POST /admin/correct → ADMIN_SECRET", () => {
    assert.deepEqual(requiredSecretsForRoute("/admin/correct", "POST"), ["ADMIN_SECRET"]);
  });

  it("método errado pra rota sensível → [] (cai no fallback 404 do router)", () => {
    // Sem isso, GET /admin/correct + ADMIN_SECRET missing daria 503 ao
    // invés do 404 esperado (regressão de mensagem em método errado).
    assert.deepEqual(requiredSecretsForRoute("/admin/correct", "GET"), []);
    assert.deepEqual(requiredSecretsForRoute("/vote", "POST"), []);
    assert.deepEqual(requiredSecretsForRoute("/set-name", "DELETE"), []);
  });

  it("rotas públicas (img/stats/leaderboard) → []", () => {
    assert.deepEqual(requiredSecretsForRoute("/img/abc.jpg", "GET"), []);
    assert.deepEqual(requiredSecretsForRoute("/stats", "GET"), []);
    assert.deepEqual(requiredSecretsForRoute("/leaderboard", "GET"), []);
    assert.deepEqual(requiredSecretsForRoute("/leaderboard/2026-05", "GET"), []);
    assert.deepEqual(requiredSecretsForRoute("/", "GET"), []);
  });
});

describe("missingSecretsForRoute (#1420)", () => {
  function makeEnv(overrides: Partial<Env> = {}): Env {
    return {
      POLL: {} as KVNamespace,
      POLL_SECRET: "pollsecret",
      ADMIN_SECRET: "adminsecret",
      ALLOWED_ORIGINS: "*",
      ...overrides,
    };
  }

  it("retorna [] quando todos os secrets necessários estão presentes", () => {
    const env = makeEnv();
    assert.deepEqual(missingSecretsForRoute(env, "/vote", "GET"), []);
    assert.deepEqual(missingSecretsForRoute(env, "/admin/correct", "POST"), []);
  });

  it("#1420: GET /vote sem POLL_SECRET → [POLL_SECRET]", () => {
    const env = makeEnv({ POLL_SECRET: undefined as unknown as string });
    assert.deepEqual(missingSecretsForRoute(env, "/vote", "GET"), ["POLL_SECRET"]);
  });

  it("#1420: POST /admin/correct sem ADMIN_SECRET → [ADMIN_SECRET]", () => {
    const env = makeEnv({ ADMIN_SECRET: undefined as unknown as string });
    assert.deepEqual(missingSecretsForRoute(env, "/admin/correct", "POST"), ["ADMIN_SECRET"]);
  });

  it("string vazia é tratada como missing (deploy seteou secret como \"\")", () => {
    const env = makeEnv({ POLL_SECRET: "" });
    assert.deepEqual(missingSecretsForRoute(env, "/vote", "GET"), ["POLL_SECRET"]);
  });

  it("método errado sempre retorna [] (preserva fallback 404)", () => {
    // ADMIN_SECRET missing mas GET /admin/correct → guard NÃO dispara.
    // Router cai no fallback 404, semanticamente mais correto que 503.
    const env = makeEnv({ ADMIN_SECRET: undefined as unknown as string });
    assert.deepEqual(missingSecretsForRoute(env, "/admin/correct", "GET"), []);
  });

  it("rotas públicas nunca falham por falta de secret (mesmo com env vazio)", () => {
    const env = makeEnv({
      POLL_SECRET: undefined as unknown as string,
      ADMIN_SECRET: undefined as unknown as string,
    });
    assert.deepEqual(missingSecretsForRoute(env, "/img/foo.jpg", "GET"), []);
    assert.deepEqual(missingSecretsForRoute(env, "/stats", "GET"), []);
    assert.deepEqual(missingSecretsForRoute(env, "/leaderboard", "GET"), []);
  });
});

describe("votePageHtml — mobile-friendly (#1675)", () => {
  it("declara viewport meta (escala pra largura do dispositivo)", () => {
    const html = votePageHtml("Acertou!", true);
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  });

  it("inclui media query mobile que reduz margem topo e ajusta layout", () => {
    // O bug #1675: 60px de margem topo + form lado-a-lado deixavam o conteúdo
    // espremido no topo no celular. A media query <=480px é o fix.
    const html = votePageHtml("Acertou!", true);
    assert.match(html, /@media \(max-width: 480px\)/);
    // body margin reduzida dentro da media query (24px no mobile)
    assert.match(html, /@media[^}]*body\s*{\s*margin:\s*24px auto/);
  });

  it("form de nickname usa classes (não inline flex) pra media query empilhar", () => {
    // Regressão: estilos inline `display:flex` no form não podiam ser
    // sobrepostos por media query. Mover pra classes .nick-form/.nick-save é o fix.
    const html = votePageHtml("Já votou", false, { email: "user@x.com", sig: "abc" });
    assert.match(html, /<form action="\/set-name" method="GET" class="nick-form">/);
    assert.match(html, /<button type="submit" class="nick-save">/);
    assert.match(html, /<input type="text" name="name"[^>]*class="nick-input">/);
    // O form NÃO deve carregar mais o inline display:flex (que bloqueava o stack).
    assert.doesNotMatch(html, /<form action="\/set-name"[^>]*style="display:flex/);
  });

  it("media query empilha o form e dá largura total ao botão (tap target)", () => {
    const html = votePageHtml("Já votou", false, { email: "user@x.com", sig: "abc" });
    assert.match(html, /@media[^@]*\.nick-form\s*{\s*flex-direction:\s*column/);
    assert.match(html, /@media[^@]*\.nick-save\s*{\s*width:\s*100%/);
  });

  it("imagens A/B empilham full-width no mobile (legíveis, não 2-up minúsculo)", () => {
    // Reclamação do editor: imagens pequenas. No mobile, flex-basis:100% empilha
    // A e B em largura total (grandes) em vez de espremer 2-up. box-sizing:border-box
    // no base evita overflow horizontal (flex-basis incluiria padding/borda).
    const html = votePageHtml("Acertou!", true);
    assert.match(html, /\.result-image\s*{\s*box-sizing:\s*border-box/);
    assert.match(html, /@media[^@]*\.result-image\s*{\s*flex-basis:\s*100%/);
  });

  it("regra base .nick-form precede o @media (cascade: override mobile vence por source order)", () => {
    // #1675 review: o stack mobile (flex-direction:column) só vence porque o
    // @media vem DEPOIS da regra base (mesma especificidade → source order).
    // Inverter a ordem quebraria silenciosamente o layout responsivo.
    const html = votePageHtml("Já votou", false, { email: "user@x.com", sig: "abc" });
    const baseIdx = html.indexOf(".nick-form { display: flex");
    const mediaIdx = html.indexOf("@media (max-width: 480px)");
    assert.ok(baseIdx >= 0, "regra base .nick-form deve existir");
    assert.ok(mediaIdx >= 0, "bloco @media deve existir");
    assert.ok(baseIdx < mediaIdx, "base .nick-form deve preceder @media pro override empilhar vencer");
  });

  it("links do rodapé usam classe footer-links (tap target no mobile)", () => {
    const html = votePageHtml("Acertou!", true);
    assert.match(html, /<p class="footer-links">/);
    assert.match(html, /\.footer-links a\s*{\s*display:\s*inline-block/);
  });

  it("não quebra render sem nickname form (formHtml vazio)", () => {
    const html = votePageHtml("Acertou!", true);
    // O <form> não é renderizado (CSS .nick-form fica no <style>, mas o elemento não).
    assert.doesNotMatch(html, /<form action="\/set-name"/);
    assert.doesNotMatch(html, /<div class="nick-box">/);
    // Mas a media query e o body responsivo continuam presentes.
    assert.match(html, /@media \(max-width: 480px\)/);
  });
});

describe("buildVoteLogEntry (#1657)", () => {
  it("monta a entrada com email_hash (campo), sem campo email cru", () => {
    const e = buildVoteLogEntry({
      ts: "2026-06-02T12:00:00.000Z",
      edition: "260602",
      monthSlug: "2026-06",
      emailHash: "deadbeef",
      choice: "A",
      correct: true,
    });
    assert.deepEqual(e, {
      ts: "2026-06-02T12:00:00.000Z",
      edition: "260602",
      month_slug: "2026-06",
      email_hash: "deadbeef",
      choice: "A",
      correct: true,
    });
    assert.ok(!("email" in e), "não deve carregar email cru");
  });
});

describe("recordVoteLog (#1657)", () => {
  function mockEnv() {
    const puts: Array<{ key: string; value: string }> = [];
    const env = {
      POLL_SECRET: "test-poll-secret",
      POLL: {
        put: async (key: string, value: string) => {
          puts.push({ key, value });
        },
      },
    };
    return { puts, env: env as unknown as Env };
  }

  it("grava 1 entrada com email HASHED (não cru) + shape + key correta", async () => {
    const { puts, env } = mockEnv();
    await recordVoteLog(env, "user@example.com", "260602", "A", true, "2026-06-02T12:00:00.000Z");
    assert.equal(puts.length, 1);
    const { key, value } = puts[0];
    // PII crua NUNCA aparece — nem na key nem no value.
    assert.doesNotMatch(key, /user@example\.com/);
    assert.doesNotMatch(value, /user@example\.com/);
    const entry = JSON.parse(value);
    assert.equal(entry.edition, "260602");
    assert.equal(entry.month_slug, "2026-06");
    assert.equal(entry.choice, "A");
    assert.equal(entry.correct, true);
    assert.equal(entry.ts, "2026-06-02T12:00:00.000Z");
    assert.ok(typeof entry.email_hash === "string" && entry.email_hash.length >= 32, "hash hex");
    assert.match(key, /^vote-log:2026-06:260602:/);
    assert.ok(key.endsWith(entry.email_hash), "key termina com o email_hash");
  });

  it("email_hash estável por email (coorte) e distinto entre emails", async () => {
    const a = mockEnv();
    await recordVoteLog(a.env, "x@y.com", "260602", "A", null, "t1");
    const b = mockEnv();
    await recordVoteLog(b.env, "x@y.com", "260603", "B", false, "t2");
    const c = mockEnv();
    await recordVoteLog(c.env, "z@y.com", "260602", "A", null, "t1");
    const ha = JSON.parse(a.puts[0].value).email_hash;
    const hb = JSON.parse(b.puts[0].value).email_hash;
    const hc = JSON.parse(c.puts[0].value).email_hash;
    assert.equal(ha, hb, "mesmo email → mesma hash (recorrência por coorte)");
    assert.notEqual(ha, hc, "emails diferentes → hashes diferentes");
  });

  it("edition malformado (monthSlug null) → não grava (não corrompe)", async () => {
    const { puts, env } = mockEnv();
    await recordVoteLog(env, "x@y.com", "naoehdata", "A", null, "t");
    assert.equal(puts.length, 0);
  });

  it("email_hash domain-separado: ≠ poll_sig do email cru, = HMAC(votelog:email) (review #1736)", async () => {
    const { puts, env } = mockEnv();
    await recordVoteLog(env, "user@example.com", "260602", "A", null, "t");
    const logHash = JSON.parse(puts[0].value).email_hash;
    const { createHmac } = await import("node:crypto");
    const bareEmailSig = createHmac("sha256", "test-poll-secret")
      .update("user@example.com")
      .digest("hex");
    const domainSep = createHmac("sha256", "test-poll-secret")
      .update("votelog:user@example.com")
      .digest("hex");
    // poll_sig (HMAC do email cru) viaja no ?sig= — o id de coorte NÃO pode ser ele.
    assert.notEqual(logHash, bareEmailSig, "não pode ser o poll_sig");
    assert.equal(logHash, domainSep, "deve ser HMAC de votelog:{email}");
  });
});


describe("validação de apelidos (#1758)", () => {
  describe("normalizeNickname", () => {
    it("lowercase + remove acentos + colapsa espaços", () => {
      assert.equal(normalizeNickname("  Anônimo  "), "anonimo");
      assert.equal(normalizeNickname("Ana   B"), "ana b");
      assert.equal(normalizeNickname("EU"), "eu");
    });
    it("dois apelidos equivalentes colidem", () => {
      assert.equal(normalizeNickname("Bruna Quevedo"), normalizeNickname("bruna  quevedo"));
    });
  });

  describe("isBlacklistedNickname", () => {
    for (const n of ["eu", "Eu", "EU", " eu ", "you", "admin", "diar.ia", "diar ia", "diaria", "teste", "Anônimo", "moderador"]) {
      it(`bloqueia "${n}"`, () => assert.equal(isBlacklistedNickname(n), true));
    }
    for (const n of ["Bruna", "Joshu", "Ana Cândida", "euler", "euzinho"]) {
      it(`permite "${n}"`, () => assert.equal(isBlacklistedNickname(n), false));
    }
  });

  describe("nicknameHasContent", () => {
    it("aceita letras/números", () => {
      assert.equal(nicknameHasContent("Ana"), true);
      assert.equal(nicknameHasContent("R2D2"), true);
    });
    it("rejeita emoji-only / pontuação-only", () => {
      assert.equal(nicknameHasContent("🎉🎉"), false);
      assert.equal(nicknameHasContent("!!!"), false);
      assert.equal(nicknameHasContent("   "), false);
    });
  });

  describe("validateNickname", () => {
    it("OK → null", () => assert.equal(validateNickname("Bruna"), null));
    it("blacklist → mensagem", () => assert.match(validateNickname("Eu") ?? "", /não é permitido/i));
    it("emoji-only → mensagem", () => assert.match(validateNickname("🎉") ?? "", /letra ou número/i));
    // #1774 review: piso de tamanho.
    it("1 caractere → muito curto", () => assert.match(validateNickname("a") ?? "", /muito curto/i));
    it("2 caracteres válidos → null", () => assert.equal(validateNickname("Jo"), null));
  });

  describe("handleSetName e2e (#1758)", () => {
    const SECRET = "test-secret";

    // KV em memória — get/put/list (paginação trivial: tudo de uma vez).
    function memEnv(seed: Record<string, string>): Env {
      const store = new Map<string, string>(Object.entries(seed));
      return {
        POLL_SECRET: SECRET,
        POLL: {
          get: async (k: string) => store.get(k) ?? null,
          put: async (k: string, v: string) => { store.set(k, v); },
          list: async ({ prefix }: { prefix: string }) => ({
            keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
            list_complete: true,
          }),
        },
      } as unknown as Env;
    }

    async function setNameUrl(email: string, name: string): Promise<URL> {
      const sig = await hmacSign(SECRET, `setname:${email}`);
      const u = new URL("https://poll.diaria.workers.dev/set-name");
      u.searchParams.set("email", email);
      u.searchParams.set("name", name);
      u.searchParams.set("sig", sig);
      return u;
    }

    it("apelido na blacklist ('Eu') → 400, não persiste", async () => {
      const env = memEnv({ "score:leo@x.com": JSON.stringify({ total: 1, nickname: null }) });
      const res = await handleSetName(await setNameUrl("leo@x.com", "Eu"), env);
      assert.equal(res.status, 400);
      const after = JSON.parse(await env.POLL.get("score:leo@x.com") as string);
      assert.equal(after.nickname, null);
    });

    it("#1774: rejeição re-renderiza o form pra re-tentativa", async () => {
      const env = memEnv({ "score:leo@x.com": JSON.stringify({ total: 1, nickname: null }) });
      const res = await handleSetName(await setNameUrl("leo@x.com", "Eu"), env);
      const body = await res.text();
      // O form de set-name volta (action + input name) — não é beco sem saída.
      assert.match(body, /action="\/set-name"/);
      assert.match(body, /name="name"/);
    });

    it("apelido já usado por outro email → 409, não persiste", async () => {
      const env = memEnv({
        "score:bruna@x.com": JSON.stringify({ total: 5, nickname: "Bruna Quevedo" }),
        "score:novo@x.com": JSON.stringify({ total: 1, nickname: null }),
      });
      const res = await handleSetName(await setNameUrl("novo@x.com", "bruna  quevedo"), env);
      assert.equal(res.status, 409);
      const after = JSON.parse(await env.POLL.get("score:novo@x.com") as string);
      assert.equal(after.nickname, null);
    });

    it("apelido único e válido → 200, persiste", async () => {
      const env = memEnv({ "score:ana@x.com": JSON.stringify({ total: 3, nickname: null }) });
      const res = await handleSetName(await setNameUrl("ana@x.com", "Ana Cândida"), env);
      assert.equal(res.status, 200);
      const after = JSON.parse(await env.POLL.get("score:ana@x.com") as string);
      assert.equal(after.nickname, "Ana Cândida");
    });

    it("re-setar o PRÓPRIO apelido (mesmo email) não colide consigo → 200", async () => {
      const env = memEnv({ "score:ana@x.com": JSON.stringify({ total: 3, nickname: "Ana" }) });
      const res = await handleSetName(await setNameUrl("ana@x.com", "Ana"), env);
      assert.equal(res.status, 200);
    });

    it("sig inválido → 403", async () => {
      const env = memEnv({ "score:ana@x.com": JSON.stringify({ total: 3, nickname: null }) });
      const u = new URL("https://poll.diaria.workers.dev/set-name");
      u.searchParams.set("email", "ana@x.com");
      u.searchParams.set("name", "Ana");
      u.searchParams.set("sig", "deadbeef");
      const res = await handleSetName(u, env);
      assert.equal(res.status, 403);
    });
  });
});
