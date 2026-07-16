/**
 * test/poll-jogar-sequence-3589.test.ts (#3589)
 *
 * Rework do "É IA?" web (EPIC #3514, feedback do editor 260716): o web deixa
 * de ser "par único de hoje + arquivo navegável" e vira SEMPRE uma
 * SEQUÊNCIA — os pares do MÊS COMPLETO ANTERIOR, jogados em ordem, com % de
 * acerto e crédito real no leaderboard MENSAL (BRAND_INFO.web já era
 * `leaderboardPeriod: "month"` desde #3516 — nenhuma mudança ali). Cobre:
 *
 *   - `resolvePreviousCalendarMonth` (pure) — mês/ano anterior, com wrap
 *     dezembro→janeiro.
 *   - `resolveJogarSequenceEditions` (pure) — filtra `correct:*` pro mês de
 *     conteúdo anterior, ordem ASCENDENTE (cronológica), exclui outros
 *     meses/anos e formatos não-AAMMDD.
 *   - `renderJogarSequencePageHtml` (pure) — anti-spoiler, estado vazio,
 *     cada rodada vota de VERDADE via `/vote` (não o endpoint read-only do
 *     quiz), share final reusa `/jogar/quiz/result` (#3520), caixa de
 *     descoberta + form inline presentes.
 *   - `GET /jogar` (sem `?edition=`) — serve a sequência (default NOVO);
 *     `GET /jogar?edition=X` (explícito e válido) preserva o par único
 *     clássico (ponte clarice/#3524, #3578) — regressão coberta por
 *     test/poll-jogar-3516.test.ts (não duplicada aqui).
 *   - Regressão: `/jogar/quiz`, `/jogar/arquivo` e o resto do EPIC seguem
 *     intactos (não são tocados por este rework).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveJogarSequenceEditions,
  resolvePreviousCalendarMonth,
  renderJogarSequencePageHtml,
  resolveQuizResultParams,
  QUIZ_MAX_N,
} from "../workers/poll/src/jogar.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async getWithMetadata(key: string) {
      const v = m.get(key);
      return { value: v ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    _map: m,
  };
}

const makeEnv = (seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeMapKV> } => ({
  POLL: makeMapKV(seed),
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
});

// ── resolvePreviousCalendarMonth (pure) ─────────────────────────────────────

describe("resolvePreviousCalendarMonth (#3589)", () => {
  it("mês do meio do ano — retrocede 1 mês, mesmo ano", () => {
    // 2026-07-16T12:00:00Z é 16/07 em BRT
    const now = new Date("2026-07-16T12:00:00Z");
    assert.deepEqual(resolvePreviousCalendarMonth(now), { yy: "26", mm: "06" });
  });

  it("wrap de ano — janeiro retrocede pra dezembro do ano anterior", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    assert.deepEqual(resolvePreviousCalendarMonth(now), { yy: "25", mm: "12" });
  });

  it("BRT-aware — considera a data em BRT, não UTC (mesma disciplina de todayAammddBrt)", () => {
    // 2026-07-01T02:00:00Z ainda é 30/06 em BRT (UTC-3) — "hoje" cai em
    // junho, então o mês anterior é maio, não junho.
    const now = new Date("2026-07-01T02:00:00Z");
    assert.deepEqual(resolvePreviousCalendarMonth(now), { yy: "26", mm: "05" });
  });
});

// ── resolveJogarSequenceEditions (pure) ─────────────────────────────────────

describe("resolveJogarSequenceEditions (#3589)", () => {
  it("filtra só edições do mês de conteúdo ANTERIOR, ordem ASCENDENTE (cronológica)", () => {
    const now = new Date("2026-07-16T12:00:00Z"); // mês anterior: 2026-06
    const keys = [
      "correct:260615",
      "correct:260601",
      "correct:260610",
      "correct:260701", // mês corrente — não deve entrar
      "correct:260530", // mês anterior ao anterior — não deve entrar
    ];
    const editions = resolveJogarSequenceEditions(keys, now);
    assert.deepEqual(editions, ["260601", "260610", "260615"]);
  });

  it("ignora chaves de outro ano mesmo com mesmo mês/dia", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const keys = ["correct:260601", "correct:250601"];
    const editions = resolveJogarSequenceEditions(keys, now);
    assert.deepEqual(editions, ["260601"]);
  });

  it("ignora chaves não-AAMMDD (ex: ciclo mensal Clarice)", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const keys = ["correct:260601", "correct:2606-07"];
    const editions = resolveJogarSequenceEditions(keys, now);
    assert.deepEqual(editions, ["260601"]);
  });

  it("mês anterior sem NENHUMA edição fechada → array vazio (nunca lança)", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    assert.deepEqual(resolveJogarSequenceEditions([], now), []);
  });

  it("wrap de ano: mês anterior a janeiro é dezembro do ano anterior", () => {
    const now = new Date("2026-01-15T12:00:00Z"); // mês anterior: 2025-12
    const keys = ["correct:251215", "correct:251201", "correct:260101"];
    const editions = resolveJogarSequenceEditions(keys, now);
    assert.deepEqual(editions, ["251201", "251215"]);
  });
});

// ── renderJogarSequencePageHtml (pure render) ───────────────────────────────

describe("renderJogarSequencePageHtml (#3589)", () => {
  it("estado vazio (sem edições do mês anterior) → mensagem amigável, nunca quebra", () => {
    const html = renderJogarSequencePageHtml([]);
    assert.match(html, /Ainda não há uma sequência fechada/i);
    assert.match(html, /\/jogar\/quiz/, "oferece o quiz relâmpago como alternativa imediata");
  });

  it("anti-spoiler: embute só os AAMMDD (nunca o gabarito A/B) no script", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    assert.match(html, /var editions = \["260601","260602"\]/);
    assert.doesNotMatch(html, /"correct"\s*:\s*"[AB]"/);
  });

  it("cada rodada vota DE VERDADE via /vote (não o endpoint read-only do quiz)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /var voteUrl = "\/vote\?" \+ params\.toString\(\);/);
    assert.doesNotMatch(html, /\/jogar\/quiz\/answer/, "sequência não usa o endpoint sem side-effect do quiz");
  });

  it("identidade anônima: mesmo token localStorage+cookie do #3516 (não pede login/e-mail digitado)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /eia_web_token/);
    assert.match(html, /crypto\.randomUUID/);
  });

  it("share final REUSA /jogar/quiz/result (#3520) — zero endpoint novo pro card de compartilhamento", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    assert.match(html, /fetch\("\/jogar\/quiz\/result\?score="/);
  });

  // Bug real pego no self-review (#2038) — CORRIGIDO no mesmo PR, não só
  // comentado (mesmo precedente #3117/#3120): reusar /jogar/quiz/result
  // (#3520) ingenuamente teria quebrado a sequência, porque
  // resolveQuizResultParams rejeitava `total > QUIZ_MAX_N` (10) — um mês
  // real tem até ~23 edições fechadas (dias úteis), MUITO acima do teto do
  // quiz relâmpago. Fix: `QUIZ_RESULT_MAX_TOTAL` (31, novo teto do
  // endpoint) desacopla o limite do resultado do limite de rodadas
  // PEDIDAS de um quiz novo (QUIZ_MAX_N, inalterado).
  it("resolveQuizResultParams aceita total realista de um mês inteiro (>QUIZ_MAX_N, <=31) — regressão do bug pego no self-review", () => {
    assert.notEqual(QUIZ_MAX_N, 31, "sanity: QUIZ_MAX_N não deveria ter virado 31 (senão este teste não prova nada)");
    const monthTotal = 23; // ~nº de dias úteis num mês de 31 dias
    assert.ok(monthTotal > QUIZ_MAX_N, "sanity: o cenário só é interessante se exceder o teto antigo do quiz");
    assert.deepEqual(resolveQuizResultParams("20", String(monthTotal)), { score: 20, total: monthTotal });
  });

  it("resolveQuizResultParams ainda rejeita total absurdo (forja) — teto de 31 preservado", () => {
    assert.equal(resolveQuizResultParams("1", "999"), null);
    assert.equal(resolveQuizResultParams("1", "32"), null);
    assert.deepEqual(resolveQuizResultParams("31", "31"), { score: 31, total: 31 });
  });

  it("caixa de descoberta (rework #3518) e form inline (#3580) presentes, hidden por padrão", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /<div id="jogar-subscribe-cta" class="subscribe-cta" hidden>/);
    assert.match(html, /<form id="jogar-signup-form" class="signup-form" hidden novalidate>/);
  });

  it("NÃO linka pro arquivo (#3589 item 3 — nenhuma view web auto-promove /jogar/arquivo)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.doesNotMatch(html, /Jogar edições passadas/);
    assert.doesNotMatch(html, /href="\/jogar\/arquivo"/);
  });

  it("streak/stats do servidor NUNCA exibidos por rodada — só ✅/❌ decidem certo/errado no cliente (#3589 item 3, #3595: sempre em background)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /text\.indexOf\("✅"\) === 0/);
    // O texto bruto do servidor (que pode incluir "🔥 N dias seguidos") nunca
    // é injetado no DOM — nem por rodada (não existe mais reveal por rodada,
    // #3595) nem na tela final (que só mostra as strings fixas montadas por
    // este próprio script — placar numérico + "Errou nos pares ...").
    assert.doesNotMatch(html, /innerHTML[^;]*msgEl/);
  });

  it("progress bar mostra só 'Par X de N' — sem contador de acertos incremental (#3595: revelaria parcialmente resultado de rodadas já jogadas)", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602", "260603"]);
    assert.doesNotMatch(html, /acertos: \d/);
    assert.match(html, /"Par " \+ \(originalIndex \+ 1\) \+ " de " \+ total/);
  });

  it("leaderboard linkado com brand=web (mensal — nenhuma mudança de BRAND_INFO)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /\/leaderboard\?brand=web/);
  });
});

// ── GET /jogar — dispatch default (sequência) vs ?edition= (par único) ─────

describe("GET /jogar (#3589) — default vira a sequência do mês anterior", () => {
  it("sem ?edition=: serve a sequência com as edições fechadas do mês anterior (via KV)", async () => {
    const env = makeEnv({
      "correct:260601": "A",
      "correct:260615": "B",
      "correct:260701": "A", // mês corrente — não deve entrar (referência: "hoje" resolvido por todayAammddBrt(new Date()))
    });
    const res = await worker.fetch(new Request("https://poll.test/jogar"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    // Não fixamos qual mês é "anterior" (depende de new Date() real do
    // ambiente de teste) — só garantimos que a resposta é a página de
    // SEQUÊNCIA (progress bar ou estado vazio), nunca o par único de hoje.
    assert.doesNotMatch(html, /id="jogar-form"/, "não deve renderizar o form de par único como default");
  });

  it("Cache-Control: no-store (cada rodada grava voto real — nunca cachear a sequência)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar"), env);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("mês anterior sem NENHUMA edição fechada → 200, estado vazio amigável", async () => {
    const env = makeEnv(); // KV vazio
    const res = await worker.fetch(new Request("https://poll.test/jogar"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Ainda não há uma sequência fechada/i);
  });

  it("?edition= explícito e válido preserva o par único clássico (ponte clarice/#3524) — regressão", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), env);
    const html = await res.text();
    assert.match(html, /id="jogar-form"/);
    assert.match(html, /name="edition"\s+value="260101"/);
  });
});

// ── Regressão: /jogar/quiz e /jogar/arquivo intocados por este rework ──────

describe("Regressão — /jogar/quiz e /jogar/arquivo seguem intactos (#3589 não os toca)", () => {
  it("/jogar/quiz continua respondendo normalmente (mecanismo distinto, sem crédito de leaderboard)", async () => {
    const env = makeEnv({ "correct:260101": "A" });
    const res = await worker.fetch(new Request("https://poll.test/jogar/quiz"), env);
    assert.equal(res.status, 200);
  });

  it("/jogar/arquivo continua respondendo (NÃO deletado — destino da ponte clarice/#3524, ver rationale em jogar.ts)", async () => {
    const env = makeEnv({ "correct:260101": "A" });
    const res = await worker.fetch(new Request("https://poll.test/jogar/arquivo?year=2026"), env);
    assert.equal(res.status, 200);
  });

  it("endpoints 404 seguem listando /jogar, /jogar/quiz e /jogar/arquivo", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/rota-inexistente"), env);
    const body = (await res.json()) as { endpoints: string[] };
    assert.ok(body.endpoints.includes("/jogar"));
    assert.ok(body.endpoints.includes("/jogar/quiz"));
    assert.ok(body.endpoints.includes("/jogar/arquivo"));
  });
});
