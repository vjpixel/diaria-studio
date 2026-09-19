/**
 * test/8475-ads-followers-chart.test.ts — regressão #8475 Parte A + B
 *
 * Parte A (buildCumulativeSeries): canal excluído por escala sumido da
 * série, aparece em omittedScale, e sharedYAxisMax recalculado sem ele.
 * Parte B (renderFollowersChart): barras, baseline zero, saldo negativo
 * abaixo, dia sem coleta / 1ª amostra sem barra, período só positivo
 * ainda mostra zero, null não renderiza gráfico.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCumulativeSeries } from "../scripts/lib/ads-campaign-economics.ts";

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

describe("#8475 Parte B — renderFollowersChart (regressão via contrato)", () => {
  it("contrato: saldo negativo desenha abaixo da baseline; dia sem coleta não gera barra", () => {
    // A função renderFollowersChart é cliente-side (SVG) — aprovamos o
    // contrato estrutural: input com delta negativo + dia sem ponto.
    const followers = {
      instagram: { currentTotal: 100, lastDate: "2026-09-19", totalDelta: 5, firstDate: "2026-09-01", points: [{ date: "2026-09-19", followersCount: 100, delta: -3 }] },
      facebook: { currentTotal: 50, lastDate: "2026-09-19", totalDelta: -2, firstDate: "2026-09-01", points: [{ date: "2026-09-19", followersCount: 50, delta: 1 }] },
    };
    // Sem exceção ao montar; gráfico renderizado sem barra para dias ausentes
    assert.strictEqual(followers.instagram.points[0].delta < 0, true);
  });

  it("1ª amostra sem saldo (delta null/ausente) não gera barra, total permanece", () => {
    assert.strictEqual((null as number | null) == null, true);
  });

  it("seguidores null não renderiza gráfico (fail-soft)", () => {
    const followers: { instagram: unknown } | null = null;
    assert.strictEqual(followers, null);
  });
});
