/**
 * test/poll-clarice-archive-year-consistency-3473.test.ts (#3473)
 *
 * Achado do review consolidado sobre o diff do #3472 (fix #3464): o #3464
 * corrigiu o arquivo do "É IA?" da Clarice (`brand=clarice`,
 * `leaderboardPeriod === "year"`) pra exibir o mês de ENVIO em vez do de
 * CONTEÚDO — mas, pra edições de conteúdo=DEZEMBRO (envio em janeiro do ano
 * SEGUINTE), dois caminhos de render mostravam o mês deslocado sem
 * reconciliar o ANO contra o ano-de-conteúdo em que a página é enquadrada:
 *
 *   1. `groupEditionsByMonth` (via `renderArchiveListHtml`): o heading do
 *      grupo mostrava só "Janeiro" (mês nu, sem ano) na página "Arquivo de
 *      2026" — lê-se como janeiro/2026 — enquanto o link do item abaixo
 *      (via `formatEditionDateForBrand`) dizia corretamente "Janeiro de
 *      2027". Heading e link se contradiziam.
 *
 *   2. `renderArchiveVoteHtml`: misturava o mês/ano de ENVIO ("janeiro de
 *      2027") com o ano-de-conteúdo do parâmetro de URL (2026), produzindo a
 *      frase literalmente auto-contraditória "Edição de janeiro de 2027 —
 *      vale ponto no leaderboard anual de 2026".
 *
 * Fix (só EXIBIÇÃO — hrefs/gabarito/dedup/KV continuam indexados pelo mês de
 * CONTEÚDO, invariante do #3464 preservada; só brand=clarice, brand=diaria
 * inalterado):
 *
 *   1. `groupEditionsByMonth` ganha um 3º parâmetro opcional `pageYear` (o
 *      ano de CONTEÚDO da página) — quando o ano de EXIBIÇÃO (envio) do
 *      grupo diverge de `pageYear`, o heading passa a carregar o ano
 *      ("Janeiro de 2027"). `renderArchiveListHtml` passa `year` adiante.
 *      Chamadas sem `pageYear` (testes unitários pré-#3473) preservam o
 *      comportamento antigo (mês nu) — back-compat.
 *
 *   2. `renderArchiveVoteHtml` anota explicitamente o mês de CONTEÚDO
 *      ("conteúdo de dezembro de 2026") quando o ano de envio diverge do
 *      ano da página — a subcopy e a meta description deixam de afirmar os
 *      dois anos como se fossem o mesmo.
 *
 *   3. `buildAlreadyVotedResponse` ("já votou", vote.ts): investigação
 *      confirmou que a mensagem NUNCA cita um ano de leaderboard (só
 *      `formatEditionDateForBrand`, sem número de leaderboard na mesma
 *      frase) — não havia contradição a corrigir ali. Este teste TRAVA essa
 *      invariante (mensagem cita só o ano de envio, nunca um ano de
 *      leaderboard contraditório na mesma frase) pra qualquer regressão
 *      futura que tente adicionar esse texto sem reconciliar.
 *
 * Estrutura:
 *   1. `groupEditionsByMonth` com `pageYear` — heading carrega o ano no wrap.
 *   2. `renderArchiveListHtml` — heading E link consistentes (via render completo).
 *   3. `renderArchiveVoteHtml` — subcopy + meta description sem contradição.
 *   4. `buildAlreadyVotedResponse` (vote.ts) — sem contradição ano-envio vs ano-leaderboard.
 *   5. Guardas de não-quebra: casos não-dezembro inalterados; brand diaria inalterado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../workers/poll/src/index.ts";
import { buildAlreadyVotedResponse } from "../workers/poll/src/vote.ts";
import {
  groupEditionsByMonth,
  renderArchiveListHtml,
  renderArchiveVoteHtml,
} from "../workers/poll/src/leaderboard-routes.ts";

// ── 1. groupEditionsByMonth com pageYear ────────────────────────────────────

describe("groupEditionsByMonth (#3473) — heading carrega o ano quando diverge de pageYear", () => {
  it("wrap dezembro (261231) + pageYear='2026' → heading 'Janeiro de 2027' (não 'Janeiro' nu)", () => {
    const groups = groupEditionsByMonth(["261231"], "clarice", "2026");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].monthLabel, "Janeiro de 2027");
    assert.deepEqual(groups[0].editions, ["261231"], "AAMMDD cru do href continua intacto");
  });

  it("mês comum (260531, conteúdo=maio→envio=junho) + pageYear='2026' → heading 'Junho' SEM ano (mesmo ano da página)", () => {
    const groups = groupEditionsByMonth(["260531"], "clarice", "2026");
    assert.equal(groups[0].monthLabel, "Junho", "ano de envio == ano da página, não precisa anotar");
  });

  it("pageYear OMITIDO (back-compat com chamadas pré-#3473) → comportamento antigo, mês nu mesmo no wrap", () => {
    const groups = groupEditionsByMonth(["261231"], "clarice");
    assert.equal(groups[0].monthLabel, "Janeiro", "sem pageYear não há como reconciliar — preserva comportamento pré-#3473");
  });

  it("brand diaria (leaderboardPeriod 'month') + pageYear → inalterado, nunca anota ano", () => {
    const groups = groupEditionsByMonth(["261231"], "diaria", "2026");
    assert.equal(groups[0].monthLabel, "Dezembro", "brand diaria não usa mês de envio — sem shift, sem anotação de ano");
  });
});

// ── 2. renderArchiveListHtml — heading E link consistentes (render completo) ─

describe("renderArchiveListHtml (#3473) — heading e link consistentes no wrap dezembro→janeiro", () => {
  it("edição de conteúdo-dezembro-2026 na página 'Arquivo de 2026' → heading E link citam janeiro de 2027, sem contradição", async () => {
    const res = renderArchiveListHtml(["261231"], "2026", "clarice");
    const html = await res.text();
    // Heading agora carrega o ano — não fica ambíguo/lido como janeiro/2026.
    assert.match(html, /<h2 class="month-heading">Janeiro de 2027<\/h2>/);
    // O link do item já dizia "Janeiro de 2027" desde #3464 — continua igual.
    assert.match(html, />janeiro de 2027</);
    // Nunca deve aparecer um heading "Janeiro" NU (sem ano) nesta página —
    // seria a contradição original (lido como janeiro/2026 vs link 2027).
    assert.doesNotMatch(html, /<h2 class="month-heading">Janeiro<\/h2>/);
    // href continua indexado pelo AAMMDD de CONTEÚDO — invariante do #3464 preservada.
    assert.match(html, /href="\/leaderboard\/2026\/arquivo\/261231\?brand=clarice"/);
  });

  it("mês comum (não-dezembro) — heading segue sem ano (regressão de não-quebra, mesmo teste do #3464)", async () => {
    const res = renderArchiveListHtml(["260531"], "2026", "clarice");
    const html = await res.text();
    assert.match(html, /<h2 class="month-heading">Junho<\/h2>/);
  });

  it("brand diaria — heading segue mês real da edição, sem shift nem ano extra (guarda de não-quebra)", async () => {
    const res = renderArchiveListHtml(["261231"], "2026", "diaria");
    const html = await res.text();
    assert.match(html, /<h2 class="month-heading">Dezembro<\/h2>/);
  });
});

// ── 3. renderArchiveVoteHtml — subcopy + meta description sem contradição ───

describe("renderArchiveVoteHtml (#3473) — subcopy sem contradição ano-envio vs ano-leaderboard", () => {
  it("edição de conteúdo-dezembro-2026 → subcopy anota 'conteúdo de dezembro de 2026', não afirma 2 anos contraditórios", async () => {
    const res = renderArchiveVoteHtml("261231", "2026", "clarice");
    const html = await res.text();
    // dateLabel continua mostrando o mês de ENVIO (intencional, #3464).
    assert.match(html, /Edição de janeiro de 2027/);
    // Mas agora reconcilia explicitamente com o ano de CONTEÚDO/leaderboard.
    assert.match(html, /\(conteúdo de dezembro de 2026\)/);
    assert.match(html, /vale ponto no leaderboard anual de 2026/);
    // Meta description reconciliada também.
    assert.match(html, /Vote na edição de janeiro de 2027 \(conteúdo de dezembro de 2026\) e valha ponto no leaderboard anual de 2026/);
  });

  it("mês comum (260531, conteúdo=maio→envio=junho) → subcopy SEM anotação extra (só 1 ano em jogo)", async () => {
    const res = renderArchiveVoteHtml("260531", "2026", "clarice");
    const html = await res.text();
    assert.match(html, /<p class="sub">Edição de junho de 2026 — vale ponto no leaderboard anual de 2026\.<\/p>/);
    assert.doesNotMatch(html, /conteúdo de/);
  });

  it("brand diaria — sem shift de mês, sem anotação (guarda de não-quebra)", async () => {
    const res = renderArchiveVoteHtml("261231", "2026", "diaria");
    const html = await res.text();
    assert.doesNotMatch(html, /conteúdo de/);
    assert.match(html, /Edição de 31 de dezembro de 2026/);
  });
});

// ── 4. buildAlreadyVotedResponse (vote.ts) — sem contradição ano-envio/leaderboard ─

function scoreOnlyEnv(scoreRaw: string | null = null): Env {
  return {
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
    POLL: { get: async () => scoreRaw } as unknown as KVNamespace,
  } as unknown as Env;
}

describe("buildAlreadyVotedResponse (#3473) — mensagem 'já votou' sem contradição ano-envio vs ano-leaderboard", () => {
  it("re-voto numa edição de conteúdo-dezembro-2026 (brand clarice) → mensagem cita 'janeiro de 2027' (envio) e NÃO afirma nenhum ano de leaderboard na mesma frase", async () => {
    const res = await buildAlreadyVotedResponse(
      scoreOnlyEnv(JSON.stringify({ nickname: "Leitor" })),
      "clarice",
      "261231",
      "user@x.com",
      JSON.stringify({ choice: "A" }),
    );
    const html = await res.text();
    assert.match(html, /Você já votou na edição de janeiro de 2027/, "mês de envio (#3464) continua exibido");
    // Trava a invariante: a mensagem "já votou" nunca cita um "leaderboard
    // anual de {ano}" — se citasse, teria que reconciliar (como
    // renderArchiveVoteHtml faz) para não contradizer "janeiro de 2027".
    assert.doesNotMatch(
      html,
      /leaderboard anual de \d{4}/,
      "mensagem não deve afirmar um ano de leaderboard — evita reintroduzir a contradição do #3473 caso alguém adicione esse texto sem reconciliar",
    );
  });

  it("brand diaria (edição diária comum) — mensagem cita a data real, comportamento pré-existente inalterado", async () => {
    const res = await buildAlreadyVotedResponse(
      scoreOnlyEnv(JSON.stringify({ nickname: "Leitor" })),
      "diaria",
      "261231",
      "user@x.com",
      JSON.stringify({ choice: "A" }),
    );
    const html = await res.text();
    assert.match(html, /Você já votou na edição de 31 de dezembro de 2026/);
  });
});
