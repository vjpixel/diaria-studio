/**
 * test/poll-batch-3109-3110-3112.test.ts
 *
 * Regressão para o lote de 3 issues do worker `poll` (mesma revisão):
 *
 *   #3109 — form de nickname dizia "leaderboard mensal" mesmo no brand `clarice`
 *   (leaderboard ANUAL, `BRAND_INFO.clarice.leaderboardPeriod === "year"`).
 *   Fix: deriva a palavra ("mensal"/"anual") de `BRAND_INFO[brand].leaderboardPeriod`
 *   — mesmo padrão já usado em vote.ts (#2061).
 *
 *   #3110 — botões cheios (.nick-save, botões A/B "Essa é a IA", badge .you)
 *   usavam texto claro sobre fundo teal (#00A0A0), contraste ~3:1 (abaixo de
 *   AA 4.5:1). Fix: fundo ink (#171411) — mesmo texto claro (onInk #FBFAF6),
 *   contraste ~15:1. Teal segue reservado a texto/acentos (design-tokens.ts).
 *
 *   #3112 — `formatEditionDate` sempre formatava "DD de mês de AAAA", mas a
 *   Clarice News é MENSAL — o "dia" do AAMMDD é só artefato do formato do
 *   código, não dado real (mesmo racional do #2006 em vote.ts). Fix:
 *   `formatEditionDateForBrand` — "Mês de AAAA" (sem dia) quando
 *   `leaderboardPeriod === "year"`; formato completo inalterado quando
 *   `"month"`. Aplicado em `renderArchiveListHtml` e `renderArchiveVoteHtml`.
 *   O código AAMMDD interno usado em hrefs/gabarito NÃO muda — só a string
 *   exibida.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { votePageHtml } from "../workers/poll/src/index.ts";
import { formatEditionDate, formatEditionDateForBrand } from "../workers/poll/src/lib.ts";
import {
  renderArchiveListHtml,
  renderArchiveVoteHtml,
} from "../workers/poll/src/leaderboard-routes.ts";
import type { Env } from "../workers/poll/src/index.ts";

// ── #3109 — texto do form de nickname por brand ─────────────────────────────

describe("#3109 — form de nickname deriva 'mensal'/'anual' de BRAND_INFO.leaderboardPeriod", () => {
  it("brand diaria (leaderboardPeriod: 'month') → 'leaderboard mensal'", () => {
    const html = votePageHtml(
      "Voto registrado!",
      true,
      { email: "a@x.com", sig: "sig123" },
      null,
      null,
      "diaria",
    );
    assert.match(html, /aparecer no leaderboard mensal/);
    assert.doesNotMatch(html, /aparecer no leaderboard anual/);
  });

  it("brand clarice (leaderboardPeriod: 'year') → 'leaderboard anual', NÃO 'mensal'", () => {
    const html = votePageHtml(
      "Voto registrado!",
      true,
      { email: "a@x.com", sig: "sig123" },
      null,
      null,
      "clarice",
    );
    assert.match(html, /aparecer no leaderboard anual/);
    assert.doesNotMatch(html, /aparecer no leaderboard mensal/);
  });

  it("sem nicknameForm → form não aparece, texto ausente nos 2 brands (guarda: não afeta o caminho sem form)", () => {
    const htmlDiaria = votePageHtml("Voto registrado!", true, null, null, null, "diaria");
    const htmlClarice = votePageHtml("Voto registrado!", true, null, null, null, "clarice");
    assert.doesNotMatch(htmlDiaria, /aparecer no leaderboard/);
    assert.doesNotMatch(htmlClarice, /aparecer no leaderboard/);
  });
});

// ── #3110 — contraste dos botões cheios (ink, não teal) ─────────────────────

describe("#3110 — botões cheios usam fundo ink (#171411), não teal (#00A0A0)", () => {
  it(".nick-save: background ink + texto claro (onInk)", () => {
    const html = votePageHtml(
      "Voto registrado!",
      true,
      { email: "a@x.com", sig: "sig123" },
      null,
      null,
      "diaria",
    );
    assert.match(html, /\.nick-save\s*\{[^}]*background:\s*#171411[^}]*\}/);
    assert.match(html, /\.nick-save\s*\{[^}]*color:\s*#FBFAF6[^}]*\}/);
    assert.doesNotMatch(html, /\.nick-save\s*\{[^}]*background:\s*#00A0A0[^}]*\}/);
  });

  it(".you badge: background ink + texto claro (onInk)", () => {
    const html = votePageHtml(
      "Acertou!",
      true,
      null,
      { edition: "260707", aiSide: "A", clickedSide: "A" },
      null,
      "diaria",
    );
    assert.match(html, /\.result-image \.you\s*\{[^}]*background:\s*#171411[^}]*\}/);
    assert.doesNotMatch(html, /\.result-image \.you\s*\{[^}]*background:\s*#00A0A0[^}]*\}/);
  });

  it("botões A/B do arquivo retroativo (.choice button): background ink + texto claro", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    assert.match(html, /\.choice button\s*\{[^}]*background:\s*#171411[^}]*\}/);
    assert.match(html, /\.choice button\s*\{[^}]*color:\s*#FBFAF6[^}]*\}/);
    assert.doesNotMatch(html, /\.choice button\s*\{[^}]*background:\s*#00A0A0[^}]*\}/);
  });

  it("teal (#00A0A0) segue reservado a texto/acentos — não desaparece do CSS inteiro, só dos botões cheios", () => {
    // Guarda contra "corrigir demais": .result-image.clicked (borda) e tr.leader
    // (texto do ranking) continuam em teal — só os 3 elementos da issue mudaram.
    const html = votePageHtml("Acertou!", true, null, { edition: "260707", aiSide: "A", clickedSide: "A" }, null, "diaria");
    assert.match(html, /\.result-image\.clicked\s*\{[^}]*border-color:\s*#00A0A0/);
  });
});

// ── #3112 — formatEditionDateForBrand ────────────────────────────────────────

describe("formatEditionDateForBrand (#3112) — pure", () => {
  it("brand diaria (leaderboardPeriod 'month') → formato completo, idêntico a formatEditionDate", () => {
    assert.equal(formatEditionDateForBrand("260707", "diaria"), formatEditionDate("260707"));
    assert.equal(formatEditionDateForBrand("260707", "diaria"), "7 de julho de 2026");
  });

  it("brand clarice (leaderboardPeriod 'year') → SÓ 'Mês de AAAA', sem o dia", () => {
    assert.equal(formatEditionDateForBrand("260531", "clarice"), "maio de 2026");
    assert.equal(formatEditionDateForBrand("260701", "clarice"), "julho de 2026");
    // Dia do código (31 vs 01) não aparece nem influencia o mês exibido.
    assert.doesNotMatch(formatEditionDateForBrand("260531", "clarice"), /\b31\b/);
  });

  it("clarice: dias diferentes no mesmo mês produzem a MESMA string (dia é artefato, não dado real)", () => {
    assert.equal(
      formatEditionDateForBrand("260701", "clarice"),
      formatEditionDateForBrand("260715", "clarice"),
    );
  });

  it("input malformado → retorna input cru (mesmo fallback de formatEditionDate) nos 2 brands", () => {
    assert.equal(formatEditionDateForBrand("invalid", "clarice"), "invalid");
    assert.equal(formatEditionDateForBrand("261301", "clarice"), "261301"); // mês 13
    assert.equal(formatEditionDateForBrand("invalid", "diaria"), "invalid");
  });
});

describe("#3112 — renderArchiveListHtml aplica formatação por brand sem alterar o AAMMDD do href", () => {
  it("brand diaria: exibe data completa (com dia) — comportamento inalterado", async () => {
    const res = renderArchiveListHtml(["260707", "260615"], "2026", "diaria");
    const html = await res.text();
    assert.match(html, /7 de julho de 2026/);
    assert.match(html, /15 de junho de 2026/);
    // Href preserva o AAMMDD interno intacto.
    assert.match(html, /href="\/leaderboard\/2026\/arquivo\/260707"/);
    assert.match(html, /href="\/leaderboard\/2026\/arquivo\/260615"/);
  });

  it("brand clarice: exibe só 'Mês de AAAA' (sem dia) — mas href mantém o AAMMDD interno intacto", async () => {
    const res = renderArchiveListHtml(["260701", "260601"], "2026", "clarice");
    const html = await res.text();
    assert.match(html, /julho de 2026/);
    assert.match(html, /junho de 2026/);
    // O texto exibido NÃO deve conter "1 de julho" nem "01" — só o mês.
    assert.doesNotMatch(html, /\d+\s+de\s+julho/);
    assert.doesNotMatch(html, /\d+\s+de\s+junho/);
    // Href/gabarito continuam usando o AAMMDD cru (260701, 260601) — só a
    // formatação exibida mudou, não o código interno da edição.
    assert.match(html, /href="\/leaderboard\/2026\/arquivo\/260701\?brand=clarice"/);
    assert.match(html, /href="\/leaderboard\/2026\/arquivo\/260601\?brand=clarice"/);
  });
});

describe("#3112 — renderArchiveVoteHtml aplica formatação por brand sem alterar o AAMMDD do gabarito/imagens", () => {
  it("brand diaria: subtítulo mostra data completa com dia", async () => {
    const res = renderArchiveVoteHtml("260707", "2026", "diaria");
    const html = await res.text();
    assert.match(html, /Edição de 7 de julho de 2026/);
  });

  it("brand clarice: subtítulo mostra só 'Mês de AAAA', sem dia — mas edição/imagens/gabarito usam o AAMMDD cru intacto", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "clarice");
    const html = await res.text();
    assert.match(html, /Edição de julho de 2026/);
    assert.doesNotMatch(html, /Edição de \d+\s+de julho/);
    // O AAMMDD interno (usado no hidden input do form, nas imagens A/B e no
    // gabarito correct:{edition}) NÃO foi tocado — continua 260701 cru.
    assert.match(html, /<input type="hidden" name="edition" value="260701">/);
    assert.match(html, /\/img\/img-260701-01-eia-A\.jpg/);
    assert.match(html, /\/img\/img-260701-01-eia-B\.jpg/);
    assert.match(html, /href="\/leaderboard\/2026\/arquivo\?brand=clarice"/);
  });
});

// ── Integração ponta-a-ponta via worker (garante o wiring completo) ────────

function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const data: Record<string, string> = { ...seed };
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => { data[key] = value; },
    delete: async (key: string) => { delete data[key]; },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Object.keys(data).filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as unknown as KVNamespace;
}

function makeEnv(seed: Record<string, string> = {}): Env {
  return {
    POLL: makeKv(seed),
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  };
}

describe("#3112 — integração via worker fetch: /leaderboard/{YYYY}/arquivo/{AAMMDD}", () => {
  it("brand clarice via query param real: página de voto mostra 'Mês de AAAA' sem dia", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const env = makeEnv({ "clarice:correct:260701": "A" });
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo/260701?brand=clarice"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Edição de julho de 2026/);
    assert.doesNotMatch(html, /Edição de \d+\s+de julho/);
  });

  it("brand diaria (default) via worker fetch: mantém data completa com dia", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const env = makeEnv({ "correct:260701": "A" });
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo/260701"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Edição de 1 de julho de 2026/);
  });
});
