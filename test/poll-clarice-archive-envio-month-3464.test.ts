/**
 * test/poll-clarice-archive-envio-month-3464.test.ts (#3464)
 *
 * O arquivo do "É IA?" da Clarice (`/leaderboard/{YYYY}/arquivo?brand=clarice`)
 * agrupava/rotulava as edições pelo mês de CONTEÚDO do digest — mas a Clarice
 * News é enviada no mês SEGUINTE ao de conteúdo (invariante
 * `{envio} = {conteúdo} + 1`, ver `legacyMonthlyEditionForCycle`/
 * `cycleForLegacyMonthlyEdition` em lib.ts). Uma edição de conteúdo maio,
 * enviada em junho, aparecia agrupada sob "Maio" — confuso pro leitor que
 * recebeu o e-mail em junho.
 *
 * Fix (só EXIBIÇÃO — hrefs/gabarito/dedup/KV continuam indexados pelo mês de
 * CONTEÚDO): `formatEditionDateForBrand` (lib.ts) e `groupEditionsByMonth`
 * (leaderboard-routes.ts) convertem CONTEÚDO→ENVIO via `envioMonthYear` antes
 * de formatar/agrupar, só para `brand=clarice` (`leaderboardPeriod === "year"`).
 * O brand `diaria` (`leaderboardPeriod === "month"`) é inalterado — já exibia
 * a data real da edição diária, sem esse mapeamento.
 *
 * Estrutura:
 *   1. `envioMonthYear` — helper puro de wrap dez→jan.
 *   2. `formatEditionDateForBrand` — ciclo Clarice YYMM-MM com conteúdo=maio.
 *   3. `groupEditionsByMonth` — heading do grupo usa mês de ENVIO (clarice).
 *   4. Wrap de ano: conteúdo=dezembro → envio=janeiro do ano SEGUINTE.
 *   5. Guarda de regressão: brand `diaria` permanece INALTERADO.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  envioMonthYear,
  formatEditionDateForBrand,
} from "../workers/poll/src/lib.ts";
import {
  groupEditionsByMonth,
  renderArchiveListHtml,
} from "../workers/poll/src/leaderboard-routes.ts";

// ── 1. envioMonthYear — helper puro ─────────────────────────────────────────

describe("envioMonthYear (#3464) — mapeamento conteúdo→envio, pure", () => {
  it("mês comum: só +1, mesmo ano", () => {
    assert.deepEqual(envioMonthYear(2026, 5), { year: 2026, month: 6 });
    assert.deepEqual(envioMonthYear(2026, 7), { year: 2026, month: 8 });
  });

  it("wrap dezembro(12) → janeiro(1) do ano SEGUINTE", () => {
    assert.deepEqual(envioMonthYear(2026, 12), { year: 2027, month: 1 });
  });
});

// ── 2. formatEditionDateForBrand — ciclo Clarice, conteúdo=maio → "junho" ──

describe("formatEditionDateForBrand (#3464) — brand clarice exibe mês de ENVIO", () => {
  it("ciclo 'YYMM-MM' com conteúdo=maio → exibe 'junho de 2026' (envio), não 'maio'", () => {
    assert.equal(formatEditionDateForBrand("2605-06", "clarice"), "junho de 2026");
  });

  it("AAMMDD legado com conteúdo=maio (260531) → mesmo resultado 'junho de 2026'", () => {
    assert.equal(formatEditionDateForBrand("260531", "clarice"), "junho de 2026");
  });

  it("wrap de ano: ciclo com conteúdo=dezembro → 'janeiro de 2027' (envio, ano seguinte)", () => {
    assert.equal(formatEditionDateForBrand("2612-01", "clarice"), "janeiro de 2027");
  });

  it("wrap de ano: AAMMDD legado com conteúdo=dezembro (261231) → 'janeiro de 2027'", () => {
    assert.equal(formatEditionDateForBrand("261231", "clarice"), "janeiro de 2027");
  });
});

// ── 3. groupEditionsByMonth — heading por mês de ENVIO (clarice) ──────────

describe("groupEditionsByMonth (#3464) — brand clarice agrupa pelo mês de ENVIO", () => {
  it("edição de conteúdo=maio (260531) → heading 'Junho', não 'Maio'", () => {
    const groups = groupEditionsByMonth(["260531"], "clarice");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].monthLabel, "Junho");
    // O AAMMDD cru dentro do grupo continua intacto (só o heading muda).
    assert.deepEqual(groups[0].editions, ["260531"]);
  });

  it("2 edições de meses de conteúdo diferentes (maio, junho) → 2 grupos (Junho, Julho)", () => {
    const groups = groupEditionsByMonth(["260630", "260531"], "clarice");
    assert.deepEqual(
      groups.map((g) => g.monthLabel),
      ["Julho", "Junho"],
    );
  });

  it("wrap de ano: edição de conteúdo=dezembro (261231) → heading 'Janeiro'", () => {
    const groups = groupEditionsByMonth(["261231"], "clarice");
    assert.equal(groups[0].monthLabel, "Janeiro");
  });

  it("renderArchiveListHtml (brand clarice) — heading E rótulo do link mostram o mês de ENVIO", async () => {
    const res = renderArchiveListHtml(["260531"], "2026", "clarice");
    const html = await res.text();
    assert.match(html, /<h2 class="month-heading">Junho<\/h2>/);
    assert.match(html, />junho de 2026</);
    // O AAMMDD interno usado no href NÃO muda — continua indexado pelo mês de conteúdo.
    assert.match(html, /href="\/leaderboard\/2026\/arquivo\/260531\?brand=clarice"/);
    assert.doesNotMatch(html, /Maio/);
  });
});

// ── 5. Guarda de regressão — brand diaria permanece INALTERADO ────────────

describe("#3464 — brand diaria (leaderboardPeriod 'month') não é afetado pelo mapeamento envio", () => {
  it("groupEditionsByMonth sem brand (default diaria) → agrupa pelo mês embutido no AAMMDD, sem conversão", () => {
    const groups = groupEditionsByMonth(["260531"]);
    assert.equal(groups[0].monthLabel, "Maio", "brand diaria não converte conteúdo→envio — mostra o mês real da edição diária");
  });

  it("groupEditionsByMonth com brand explícito 'diaria' → mesmo resultado", () => {
    const groups = groupEditionsByMonth(["260531"], "diaria");
    assert.equal(groups[0].monthLabel, "Maio");
  });

  it("formatEditionDateForBrand(diaria) → data completa real, sem conversão de mês", () => {
    assert.equal(formatEditionDateForBrand("260531", "diaria"), "31 de maio de 2026");
  });

  it("renderArchiveListHtml (brand diaria) → heading/rótulo continuam mostrando o mês real da edição", async () => {
    const res = renderArchiveListHtml(["260531"], "2026", "diaria");
    const html = await res.text();
    assert.match(html, /<h2 class="month-heading">Maio<\/h2>/);
    assert.match(html, /31 de maio de 2026/);
  });
});
