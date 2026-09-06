/**
 * test/ads-campaign-economics.test.ts (#7536)
 *
 * Cobre `scripts/lib/ads-campaign-economics.ts` — os 5 requisitos de tela
 * que a issue derivou de MEDIÇÃO (nunca de gosto), cada um com um teste
 * dedicado que reproduz o cenário real citado no corpo da issue.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCumulativeSeries,
  buildChannelTable,
  buildTestStateTiles,
  computeSourceFreshness,
  type ChannelDailyMetric,
  type ChannelDailySignup,
} from "../scripts/lib/ads-campaign-economics.ts";

describe("#7536 — buildCumulativeSeries: requisito 1 (acumulado, nunca diário)", () => {
  it("dia sem cadastro não gera divisão por zero — custoPorCadastroAcumulado usa o acumulado até ali", () => {
    const metrics: ChannelDailyMetric[] = [
      { canal: "Google Ads (teste 2608)", date: "2026-01-01", gastoBrl: 100, cliques: 10, impressoes: 1000 },
      { canal: "Google Ads (teste 2608)", date: "2026-01-02", gastoBrl: 100, cliques: 10, impressoes: 1000 },
      { canal: "Google Ads (teste 2608)", date: "2026-01-03", gastoBrl: 100, cliques: 10, impressoes: 1000 },
    ];
    // Só o dia 1 e o dia 3 têm cadastro — dia 2 é o "zero cadastro" que a
    // issue cita (30% dos dias reais de jan/2026).
    const signups: ChannelDailySignup[] = [
      { canal: "Google Ads (teste 2608)", date: "2026-01-01", cadastros: 2 },
      { canal: "Google Ads (teste 2608)", date: "2026-01-03", cadastros: 1 },
    ];
    const result = buildCumulativeSeries(metrics, signups, { start: "2026-01-01", end: "2026-01-03" });
    assert.equal(result.series.length, 1);
    const points = result.series[0].points;
    assert.equal(points.length, 3);
    // Dia 1: gasto 100, cadastros 2 -> 50
    assert.equal(points[0].custoPorCadastroAcumulado, 50);
    // Dia 2: gasto acumulado 200, cadastros AINDA 2 (nenhum novo) -> 100, nunca null/NaN/Infinity
    assert.equal(points[1].gastoAcumuladoBrl, 200);
    assert.equal(points[1].cadastrosAcumulados, 2);
    assert.equal(points[1].custoPorCadastroAcumulado, 100);
    // Dia 3: gasto acumulado 300, cadastros 3 -> 100
    assert.equal(points[2].custoPorCadastroAcumulado, 100);
  });

  it("canal sem NENHUM cadastro no período nunca produz custoPorCadastroAcumulado != null (sem baseline de divisão)", () => {
    const metrics: ChannelDailyMetric[] = [{ canal: "X", date: "2026-01-01", gastoBrl: 50, cliques: 1, impressoes: 10 }];
    const result = buildCumulativeSeries(metrics, [], { start: "2026-01-01", end: "2026-01-01" });
    // Canal omitido por completo de `series` (requisito 3) — testado abaixo.
    assert.equal(result.series.length, 0);
  });
});

describe("#7536 — buildCumulativeSeries: requisito 2 (escala compartilhada)", () => {
  it("sharedYAxisMax é o MAIOR custo acumulado de TODOS os canais, não por linha", () => {
    const metrics: ChannelDailyMetric[] = [
      { canal: "A", date: "2026-01-01", gastoBrl: 1000, cliques: 1, impressoes: 1 },
      { canal: "B", date: "2026-01-01", gastoBrl: 10, cliques: 1, impressoes: 1 },
    ];
    const signups: ChannelDailySignup[] = [
      { canal: "A", date: "2026-01-01", cadastros: 1 }, // custo 1000
      { canal: "B", date: "2026-01-01", cadastros: 1 }, // custo 10
    ];
    const result = buildCumulativeSeries(metrics, signups, { start: "2026-01-01", end: "2026-01-01" });
    assert.equal(result.sharedYAxisMax, 1000);
    // As DUAS séries existem — a escala não é recalculada por canal.
    assert.equal(result.series.length, 2);
  });
});

describe("#7536 — buildCumulativeSeries: requisito 3 (canal sem cadastro não ganha linha)", () => {
  it("canal com gasto mas zero cadastro no período INTEIRO some de `series`, aparece em `omittedNoSignups`", () => {
    const metrics: ChannelDailyMetric[] = [
      { canal: "Microsoft Ads (teste 2608)", date: "2026-01-01", gastoBrl: 200, cliques: 5, impressoes: 500 },
      { canal: "Google Ads (teste 2608)", date: "2026-01-01", gastoBrl: 100, cliques: 5, impressoes: 500 },
    ];
    const signups: ChannelDailySignup[] = [{ canal: "Google Ads (teste 2608)", date: "2026-01-01", cadastros: 1 }];
    const result = buildCumulativeSeries(metrics, signups, { start: "2026-01-01", end: "2026-01-01" });
    const canaisNaSerie = result.series.map((s) => s.canal);
    assert.deepEqual(canaisNaSerie, ["Google Ads (teste 2608)"]);
    assert.deepEqual(result.omittedNoSignups, ["Microsoft Ads (teste 2608)"]);
  });
});

describe("#7536 — buildChannelTable: requisito 4 (nunca média entre canais)", () => {
  it("cada linha usa SÓ os próprios dados do canal — sem cruzar CPC/custo entre canais", () => {
    const metrics: ChannelDailyMetric[] = [
      { canal: "A", date: "2026-01-01", gastoBrl: 100, cliques: 10, impressoes: 1000 },
      { canal: "B", date: "2026-01-01", gastoBrl: 300, cliques: 30, impressoes: 3000 },
    ];
    const signups: ChannelDailySignup[] = [
      { canal: "A", date: "2026-01-01", cadastros: 5 },
      { canal: "B", date: "2026-01-01", cadastros: 15 },
    ];
    const rows = buildChannelTable(metrics, signups);
    const a = rows.find((r) => r.canal === "A")!;
    const b = rows.find((r) => r.canal === "B")!;
    assert.equal(a.cpcMedioBrl, 10); // 100/10 — nunca (100+300)/(10+30)
    assert.equal(b.cpcMedioBrl, 10); // 300/30 — mesma proporção, mas calculado isoladamente
    assert.equal(a.custoPorCadastroBrl, 20); // 100/5
    assert.equal(b.custoPorCadastroBrl, 20); // 300/15
  });

  it("canal sem cliques/cadastros nunca produz divisão por zero — null explícito", () => {
    const metrics: ChannelDailyMetric[] = [{ canal: "A", date: "2026-01-01", gastoBrl: 50, cliques: 0, impressoes: 100 }];
    const rows = buildChannelTable(metrics, []);
    assert.equal(rows[0].cpcMedioBrl, null);
    assert.equal(rows[0].custoPorCadastroBrl, null);
    assert.equal(rows[0].cadastrosTotal, 0);
  });
});

describe("#7536 — buildTestStateTiles: nunca média por canal, sempre estado do teste", () => {
  it("sem run-state.json: datas/janela null, mas totais de gasto/cadastro seguem reportados", () => {
    const metrics: ChannelDailyMetric[] = [{ canal: "A", date: "2026-01-01", gastoBrl: 200, cliques: 1, impressoes: 1 }];
    const signups: ChannelDailySignup[] = [{ canal: "A", date: "2026-01-01", cadastros: 3 }];
    const tiles = buildTestStateTiles(metrics, signups, null, "2026-01-02");
    assert.equal(tiles.d0, null);
    assert.equal(tiles.emAndamento, false);
    assert.equal(tiles.gastoAcumuladoTotalBrl, 200);
    assert.equal(tiles.cadastrosAcumuladosTotal, 3);
  });

  it("com run-state.json: dentro da janela d0..fim_janela, emAndamento true; canaisComSinal conta só canais com >0 cadastro", () => {
    const metrics: ChannelDailyMetric[] = [
      { canal: "A", date: "2026-01-05", gastoBrl: 100, cliques: 1, impressoes: 1 },
      { canal: "B", date: "2026-01-05", gastoBrl: 100, cliques: 1, impressoes: 1 },
    ];
    const signups: ChannelDailySignup[] = [{ canal: "A", date: "2026-01-05", cadastros: 1 }];
    const tiles = buildTestStateTiles(metrics, signups, { d0: "2026-01-01", fim_janela: "2026-01-15" }, "2026-01-05");
    assert.equal(tiles.emAndamento, true);
    assert.equal(tiles.diasDecorridos, 4);
    assert.equal(tiles.diasRestantes, 10);
    assert.equal(tiles.canaisComSinal, 1);
    assert.equal(tiles.canaisTotal, 2);
  });

  it("fora da janela (depois de fim_janela): emAndamento false", () => {
    const tiles = buildTestStateTiles([], [], { d0: "2026-01-01", fim_janela: "2026-01-15" }, "2026-02-01");
    assert.equal(tiles.emAndamento, false);
  });
});

describe("#7536 — computeSourceFreshness: requisito 5 (idade/frescor por fonte)", () => {
  it("fonte com fetchedAt recente -> ok; antiga -> stale; com erro -> error; nunca respondeu -> unavailable", () => {
    const now = new Date("2026-01-01T12:00:00Z").getTime();
    const entries = computeSourceFreshness(
      {
        "Google Ads": { fetchedAt: "2026-01-01T11:55:00Z", error: null }, // 5min atrás
        "Microsoft Ads": { fetchedAt: "2026-01-01T10:00:00Z", error: null }, // 2h atrás
        Kit: { fetchedAt: null, error: "KIT_API_KEY ausente" },
        Outra: { fetchedAt: null, error: null },
      },
      now,
      30,
    );
    const byName = Object.fromEntries(entries.map((e) => [e.source, e]));
    assert.equal(byName["Google Ads"].status, "ok");
    assert.equal(byName["Google Ads"].ageMinutes, 5);
    assert.equal(byName["Microsoft Ads"].status, "stale");
    assert.equal(byName["Kit"].status, "error");
    assert.equal(byName["Outra"].status, "unavailable");
  });
});
