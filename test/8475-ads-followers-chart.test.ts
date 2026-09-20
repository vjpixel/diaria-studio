/**
 * test/8475-ads-followers-chart.test.ts — regressão #8475 Parte A + B
 *
 * Parte A (buildCumulativeSeries): canal excluído por escala sumido da
 * série, aparece em omittedScale, e sharedYAxisMax recalculado sem ele.
 * Parte B (buildFollowersChartModel): barras, baseline zero, saldo
 * negativo abaixo, dia sem coleta / 1ª amostra sem barra, período só
 * positivo ainda mostra zero, null não renderiza gráfico.
 *
 * #8534 — os 3 testes originais da Parte B nunca chamavam
 * `renderFollowersChart` (cliente-side, toca `document`): eram
 * tautologias (`-3 < 0`, `null == null`). A geometria do gráfico foi
 * extraída para `buildFollowersChartModel` em `ads-followers-chart.js`
 * (função pura, mesmo padrão de `ads-chart.js`/#8300 e
 * `gate-badge.js`/#7050) — este arquivo agora chama essa função de
 * verdade e afirma sobre o modelo REAL que ela devolve.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCumulativeSeries } from "../scripts/lib/ads-campaign-economics.ts";
import { buildFollowersChartModel } from "../scripts/studio-ui/public/ads-followers-chart.js";

describe("#8475 Parte A — buildCumulativeSeries excludeChannels", () => {
  it("excluído (Microsoft Ads) some da série mas aparece em omittedScale e sharedYAxisMax recalculado", () => {
    const res = buildCumulativeSeries(
      [
        { canal: "Google Ads", date: "2026-09-18", gastoBrl: 120, cliques: 10, impressoes: 200 },
        { canal: "Microsoft Ads", date: "2026-09-18", gastoBrl: 721, cliques: 5, impressoes: 100 },
      ],
      [
        { canal: "Google Ads", date: "2026-09-18", cadastros: 4 },
        { canal: "Microsoft Ads", date: "2026-09-18", cadastros: 1 },
      ],
      { start: "2026-09-18", end: "2026-09-18" },
      { excludeChannels: ["Microsoft Ads"] },
    );
    assert.deepStrictEqual(res.series.map((s) => s.canal), ["Google Ads"]);
    assert.deepStrictEqual(res.omittedScale, ["Microsoft Ads"]);
    // sharedYAxisMax deve ser do Google (30), não da Microsoft (721)
    assert.strictEqual(res.sharedYAxisMax, 30);
  });

  it("canal excluído que teria cadastro ainda aparece apenas em omittedScale", () => {
    const res = buildCumulativeSeries(
      [{ canal: "X", date: "2026-09-18", gastoBrl: 10, cliques: 1, impressoes: 10 }],
      [{ canal: "X", date: "2026-09-18", cadastros: 3 }],
      { start: "2026-09-18", end: "2026-09-18" },
      { excludeChannels: ["X"] },
    );
    assert.strictEqual(res.series.length, 0);
    assert.deepStrictEqual(res.omittedScale, ["X"]);
  });
});

describe("#8475 Parte B — buildFollowersChartModel (regressão #8534: chama a função real)", () => {
  it("seguidores null não renderiza gráfico (fail-soft)", () => {
    assert.strictEqual(buildFollowersChartModel(null), null);
  });

  it("sem nenhum ponto em nenhum canal → também null (nada a desenhar)", () => {
    const model = buildFollowersChartModel({ instagram: { points: [] }, facebook: { points: [] } });
    assert.strictEqual(model, null);
  });

  it("baseline zero é sempre parte do modelo, mesmo sem saldo negativo", () => {
    const model = buildFollowersChartModel({
      instagram: { points: [{ date: "2026-09-18", followersCount: 100, delta: 5 }] },
      facebook: { points: [] },
    });
    assert.notStrictEqual(model, null);
    assert.strictEqual(model!.hasNeg, false);
    // Sem negativo, zeroY fica na base do plot (M.top + plotHeight).
    assert.strictEqual(model!.zeroY, model!.margin.top + model!.plotHeight);
  });

  it("saldo negativo: escala simétrica e a barra desenha a partir da baseline pra baixo (y >= zeroY)", () => {
    const model = buildFollowersChartModel({
      instagram: {
        points: [
          { date: "2026-09-18", followersCount: 97, delta: -3 },
          { date: "2026-09-19", followersCount: 100, delta: 3 },
        ],
      },
      facebook: { points: [] },
    });
    assert.notStrictEqual(model, null);
    assert.strictEqual(model!.hasNeg, true);
    // Escala simétrica: symM = max(|-3|, |3|) = 3.
    assert.strictEqual(model!.symM, 3);

    const negBar = model!.bars.find((b) => b.date === "2026-09-18" && b.channel === "instagram");
    const posBar = model!.bars.find((b) => b.date === "2026-09-19" && b.channel === "instagram");
    assert.ok(negBar, "esperava barra pro dia com delta negativo");
    assert.ok(posBar, "esperava barra pro dia com delta positivo");
    // Barra negativa começa NA baseline (ou abaixo dela) — nunca acima.
    assert.ok(negBar!.y >= model!.zeroY - 0.001, `negBar.y (${negBar!.y}) deveria ser >= zeroY (${model!.zeroY})`);
    // Barra positiva termina na baseline: y + height ≈ zeroY.
    assert.ok(
      Math.abs(posBar!.y + posBar!.height - model!.zeroY) < 0.001,
      "barra positiva deveria terminar exatamente na baseline",
    );
  });

  it("dia sem coleta (nenhum canal tem ponto naquela data) não entra em dates nem gera barra", () => {
    const model = buildFollowersChartModel({
      instagram: {
        points: [
          { date: "2026-09-17", followersCount: 90, delta: 2 },
          { date: "2026-09-19", followersCount: 95, delta: 5 },
        ],
      },
      facebook: { points: [] },
    });
    assert.notStrictEqual(model, null);
    // 18/09 nunca foi coletado por nenhum canal — não aparece em dates.
    assert.deepStrictEqual(model!.dates, ["2026-09-17", "2026-09-19"]);
    assert.strictEqual(
      model!.bars.some((b) => b.date === "2026-09-18"),
      false,
    );
  });

  it("1ª amostra sem saldo (delta null) não gera barra pra aquele canal/data, mas a data aparece", () => {
    const model = buildFollowersChartModel({
      instagram: {
        points: [
          { date: "2026-09-18", followersCount: 100, delta: null },
          { date: "2026-09-19", followersCount: 104, delta: 4 },
        ],
      },
      facebook: { points: [] },
    });
    assert.notStrictEqual(model, null);
    // A data da 1ª amostra existe (apareceria na tabela), mas sem barra.
    assert.deepStrictEqual(model!.dates, ["2026-09-18", "2026-09-19"]);
    assert.strictEqual(
      model!.bars.some((b) => b.date === "2026-09-18" && b.channel === "instagram"),
      false,
    );
    assert.strictEqual(
      model!.bars.some((b) => b.date === "2026-09-19" && b.channel === "instagram"),
      true,
    );
  });

  it("Instagram e Facebook no mesmo dia geram 2 barras lado a lado, sem colidir em x", () => {
    const model = buildFollowersChartModel({
      instagram: { points: [{ date: "2026-09-18", followersCount: 100, delta: 2 }] },
      facebook: { points: [{ date: "2026-09-18", followersCount: 50, delta: 1 }] },
    });
    assert.notStrictEqual(model, null);
    const ig = model!.bars.find((b) => b.channel === "instagram");
    const fb = model!.bars.find((b) => b.channel === "facebook");
    assert.ok(ig && fb);
    assert.notStrictEqual(ig!.x, fb!.x);
  });
});
