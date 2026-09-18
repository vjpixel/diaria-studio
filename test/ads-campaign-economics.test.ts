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
  computeCampaignPauseStatus,
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

describe("#8210 Bug 3c — gasto desconhecido nunca vira 0 (custo/cadastro nunca R$ 0,00 por API fora do ar)", () => {
  it("achado ao vivo #8210: canal com API falhando + cadastros reais via Kit NÃO mostra custo/cadastro R$ 0,00", () => {
    // Sem `metrics` nenhum pro canal (API do Meta Ads falhou) — só cadastros
    // via Kit. Antes do fix: gastoTotalBrl calculava como 0 (soma de []) e
    // custoPorCadastroBrl saía 0/146 = 0 — "grátis" enganoso.
    const metrics: ChannelDailyMetric[] = [];
    const signups: ChannelDailySignup[] = [{ canal: "Meta Ads (teste 2608)", date: "2026-09-01", cadastros: 146 }];
    const rows = buildChannelTable(metrics, signups, {
      channelsWithUnknownLiveSpend: new Set(["Meta Ads (teste 2608)"]),
    });
    const meta = rows.find((r) => r.canal === "Meta Ads (teste 2608)")!;
    assert.ok(meta, "canal com gasto desconhecido ainda precisa aparecer na tabela");
    assert.equal(meta.gastoTotalBrl, null, "nunca 0 — gasto é DESCONHECIDO, não zero real");
    assert.equal(meta.gastoFonte, "unknown");
    assert.equal(meta.custoPorCadastroBrl, null, "nunca R$ 0,00 — era exatamente o bug reportado na issue");
  });

  it("com fallback manual (spend.csv reconciliado): gastoFonte='manual', custo/cadastro calculado sobre o valor manual", () => {
    const signups: ChannelDailySignup[] = [{ canal: "Meta Ads (teste 2608)", date: "2026-09-01", cadastros: 100 }];
    const rows = buildChannelTable([], signups, {
      channelsWithUnknownLiveSpend: new Set(["Meta Ads (teste 2608)"]),
      manualFallback: { "Meta Ads (teste 2608)": { totalBrl: 517.85, asOfDate: "2026-09-09" } },
    });
    const meta = rows.find((r) => r.canal === "Meta Ads (teste 2608)")!;
    assert.equal(meta.gastoTotalBrl, 517.85);
    assert.equal(meta.gastoFonte, "manual");
    assert.equal(meta.gastoAsOf, "2026-09-09");
    assert.equal(meta.custoPorCadastroBrl, 5.18);
  });

  it("gasto AO VIVO genuinamente zero (API respondeu, canal não gastou) continua gastoFonte='live', não vira 'unknown'", () => {
    const metrics: ChannelDailyMetric[] = [{ canal: "Google Ads (teste 2608)", date: "2026-09-01", gastoBrl: 0, cliques: 0, impressoes: 0 }];
    const rows = buildChannelTable(metrics, [], { channelsWithUnknownLiveSpend: new Set() });
    const google = rows.find((r) => r.canal === "Google Ads (teste 2608)")!;
    assert.equal(google.gastoTotalBrl, 0);
    assert.equal(google.gastoFonte, "live");
  });

  it("sem opts (default): comportamento idêntico a antes — nenhuma linha vira 'unknown'/'manual' sem pedir", () => {
    const metrics: ChannelDailyMetric[] = [{ canal: "A", date: "2026-01-01", gastoBrl: 100, cliques: 10, impressoes: 1000 }];
    const rows = buildChannelTable(metrics, []);
    assert.equal(rows[0].gastoFonte, "live");
    assert.equal(rows[0].gastoTotalBrl, 100);
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

  it("#8242 — revisao presente SEM `pausas` (formato real do run-state.json, que só grava `pausa`) não lança e não desconta dias", () => {
    // Regressão: `assertValidRunState` exigia `revisao.pausas` incondicionalmente
    // antes do #8242, então `runState` nunca chegava aqui de verdade contra o
    // arquivo real (fail-soft do caller devolvia sempre `null`). Depois do
    // #8242, `pausas` é opcional — este tile precisa continuar funcionando
    // (sem desconto de dias pausados, que é follow-up separado) em vez de
    // lançar `TypeError: pausas.some is not a function` sobre `undefined`.
    const tiles = buildTestStateTiles(
      [],
      [],
      { d0: "2026-01-01", fim_janela: "2026-01-15", revisao: {} },
      "2026-01-05",
    );
    assert.equal(tiles.diasDecorridos, 4);
    assert.equal(tiles.diasVeiculacaoReal, 4);
  });

  it("#8293 — pausa cobrindo o próprio d0 (formato ATUAL, `revisao.pausa`) não cobra o dia 2x", () => {
    // d0 = 05/09 inteiramente pausado, today = 06/09 sem pausa nenhuma:
    // diasDecorridos = 1 (05->06); o único dia "decorrido" (06) veiculou
    // o dia inteiro, então diasVeiculacaoReal deve ser 1 — não 0 (bug
    // relatado na issue: o desconto rodava sobre [d0, today] inclusivo,
    // 1 dia maior que a janela exclusiva-no-início de `diasDecorridos`).
    const tiles = buildTestStateTiles(
      [],
      [],
      {
        d0: "2026-09-05",
        fim_janela: "2026-09-20",
        revisao: { pausa: { inicio: "2026-09-05T00:00:00-03:00", fim: "2026-09-06T00:00:00-03:00" } },
      },
      "2026-09-06",
    );
    assert.equal(tiles.diasDecorridos, 1);
    assert.equal(tiles.diasVeiculacaoReal, 1);
  });

  it("#8293 — pausa cobrindo o próprio d0 (formato ANTIGO, `revisao.pausas`) também não cobra o dia 2x", () => {
    // Mesmo cenário acima, mas no formato de fallback (plural, só data) —
    // a issue registra que o off-by-one "vale para os dois formatos".
    const tiles = buildTestStateTiles(
      [],
      [],
      {
        d0: "2026-09-05",
        fim_janela: "2026-09-20",
        revisao: { pausas: [{ desde: "2026-09-05", ate: "2026-09-05" }] },
      },
      "2026-09-06",
    );
    assert.equal(tiles.diasDecorridos, 1);
    assert.equal(tiles.diasVeiculacaoReal, 1);
  });

  it("#8293 — borda vizinha: pausa em curso sem fim (`fim: null`) segue descontando todo dia posterior ao d0", () => {
    const tiles = buildTestStateTiles(
      [],
      [],
      {
        d0: "2026-09-01",
        fim_janela: "2026-09-20",
        revisao: { pausa: { inicio: "2026-09-09T16:05:36-03:00", fim: null } },
      },
      "2026-09-11",
    );
    // diasDecorridos = 10 (01->11). 01-08 sem pausa (8 dias), 09 pausado
    // fração do dia (a partir das 16:05:36), 10 e 11 pausados o dia
    // inteiro (pausa em andamento). Só o dia 09 conta fração < 1.
    assert.equal(tiles.diasDecorridos, 10);
    assert.ok(tiles.diasVeiculacaoReal !== null && tiles.diasVeiculacaoReal > 7 && tiles.diasVeiculacaoReal < 8);
  });

  it("#8293 — borda vizinha: pausa que não cobre o d0 continua descontando normalmente (regressão do comportamento pré-fix)", () => {
    // d0 = 01/09, pausa só a partir de 05/09 (não cobre d0) — resultado
    // precisa ser idêntico ao que `countPausedDaysWithin` (aritmética
    // antiga) já produzia pra esse caso, já que aqui não há ambiguidade
    // de baseline.
    const tiles = buildTestStateTiles(
      [],
      [],
      {
        d0: "2026-09-01",
        fim_janela: "2026-09-20",
        revisao: { pausas: [{ desde: "2026-09-05", ate: "2026-09-05" }] },
      },
      "2026-09-08",
    );
    assert.equal(tiles.diasDecorridos, 7);
    assert.equal(tiles.diasVeiculacaoReal, 6);
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

describe("#8210 melhoria 1 — buildChannelTable: funil (ativos/% ativo) por canal a partir do store", () => {
  it("canal AUSENTE de activeCountsByChannel (store não ingerido nesta máquina) nunca vira 0 — ativosTotal/pctAtivo ficam null", () => {
    const metrics: ChannelDailyMetric[] = [{ canal: "Microsoft Ads (teste 2608)", date: "2026-09-01", gastoBrl: 288.02, cliques: 4, impressoes: 200 }];
    const signups: ChannelDailySignup[] = [{ canal: "Microsoft Ads (teste 2608)", date: "2026-09-01", cadastros: 1 }];
    // opts sem `activeCountsByChannel` — o caso "nenhuma ingestão do store rodou ainda".
    const rows = buildChannelTable(metrics, signups);
    const ms = rows.find((r) => r.canal === "Microsoft Ads (teste 2608)")!;
    assert.equal(ms.ativosTotal, null, "dado desconhecido — nunca 0");
    assert.equal(ms.ativosAmostraN, 0);
    assert.equal(ms.pctAtivo, null);
  });

  it("canal com n BAIXO (achado #7999: Microsoft, 2 cadastros, 0 ativos) expõe o n em vez de esconder a taxa enganosa", () => {
    const metrics: ChannelDailyMetric[] = [{ canal: "Microsoft Ads (teste 2608)", date: "2026-09-01", gastoBrl: 288.02, cliques: 4, impressoes: 200 }];
    const signups: ChannelDailySignup[] = [{ canal: "Microsoft Ads (teste 2608)", date: "2026-09-01", cadastros: 2 }];
    const rows = buildChannelTable(metrics, signups, {
      activeCountsByChannel: { "Microsoft Ads (teste 2608)": { ativos: 0, totalNoStore: 2 } },
    });
    const ms = rows.find((r) => r.canal === "Microsoft Ads (teste 2608)")!;
    assert.equal(ms.ativosTotal, 0, "0 ativos é um dado REAL medido, não 'desconhecido' — ver teste anterior");
    assert.equal(ms.ativosAmostraN, 2, "n sempre visível — UI decide esmaecer com base nele, nunca esconder");
    assert.equal(ms.pctAtivo, 0);
  });

  it("canal com dado normal: pctAtivo = ativos/totalNoStore, independente de cadastrosTotal (fonte diferente, Kit vs. store)", () => {
    const metrics: ChannelDailyMetric[] = [];
    const signups: ChannelDailySignup[] = [{ canal: "Google Ads (teste 2608)", date: "2026-09-01", cadastros: 10 }];
    const rows = buildChannelTable(metrics, signups, {
      activeCountsByChannel: { "Google Ads (teste 2608)": { ativos: 6, totalNoStore: 8 } },
    });
    const google = rows.find((r) => r.canal === "Google Ads (teste 2608)")!;
    assert.equal(google.cadastrosTotal, 10, "cadastrosTotal segue vindo do Kit — não é sobrescrito pelo store");
    assert.equal(google.ativosTotal, 6);
    assert.equal(google.ativosAmostraN, 8);
    assert.equal(google.pctAtivo, 0.75);
  });
});

describe("#8210 melhoria 2 — computeCampaignPauseStatus: badge ativa/pausada/desconhecido", () => {
  it("sem revisao (infra sem consumidor que a escreva, ou nenhuma pausa jamais registrada) — 'desconhecido', NUNCA 'ativa'", () => {
    assert.equal(computeCampaignPauseStatus(undefined, "2026-09-17"), "desconhecido");
  });

  it("todayIso dentro de uma pausa registrada — 'pausada'", () => {
    const revisao = { pausas: [{ desde: "2026-09-09", ate: "2026-09-16" }] };
    assert.equal(computeCampaignPauseStatus(revisao, "2026-09-12"), "pausada");
    assert.equal(computeCampaignPauseStatus(revisao, "2026-09-09"), "pausada", "limite inferior inclusivo");
    assert.equal(computeCampaignPauseStatus(revisao, "2026-09-16"), "pausada", "limite superior inclusivo");
  });

  it("todayIso fora de qualquer pausa, com revisao presente — 'ativa'", () => {
    const revisao = { pausas: [{ desde: "2026-09-09", ate: "2026-09-16" }] };
    assert.equal(computeCampaignPauseStatus(revisao, "2026-09-17"), "ativa");
  });

  describe("hotfix #8283/#8284 — shape REAL de produção (revisao.pausa singular, sem revisao.pausas)", () => {
    // Fixture real: data/aquisicao/teste-2608/run-state.json grava a pausa
    // em `revisao.pausa` (singular, com HORA) — nunca em `pausas` (plural,
    // formato antigo). `computeCampaignPauseStatus` estourava em
    // `revisao.pausas.some(...)` sobre `undefined` nesse shape.
    const revisaoReal = {
      pausa: {
        inicio: "2026-09-09T16:05:36-03:00",
        fim: "2026-09-17T00:16:00-03:00",
        inicio_por_braco: {
          "Google Ads (teste 2608)": "2026-09-09T16:05:36-03:00",
          "Microsoft Ads (teste 2608)": "2026-09-09T16:05:36-03:00",
          "Meta Ads (teste 2608)": "2026-09-09T16:05:36-03:00",
        },
      },
    };

    it("não lança e devolve 'pausada' pra uma data dentro do intervalo", () => {
      assert.doesNotThrow(() => computeCampaignPauseStatus(revisaoReal, "2026-09-12"));
      assert.equal(computeCampaignPauseStatus(revisaoReal, "2026-09-12"), "pausada");
    });

    it("não lança e devolve 'ativa' pra uma data bem depois do fim da pausa", () => {
      assert.doesNotThrow(() => computeCampaignPauseStatus(revisaoReal, "2026-09-20"));
      assert.equal(computeCampaignPauseStatus(revisaoReal, "2026-09-20"), "ativa");
    });
  });

  it("revisao presente mas sem `pausa` NEM `pausas` — 'desconhecido', sem lançar", () => {
    assert.doesNotThrow(() => computeCampaignPauseStatus({}, "2026-09-17"));
    assert.equal(computeCampaignPauseStatus({}, "2026-09-17"), "desconhecido");
  });

  it("buildChannelTable aplica o MESMO pauseStatus aos 3 braços (pausas são da campanha inteira, não por canal)", () => {
    const metrics: ChannelDailyMetric[] = [
      { canal: "Google Ads (teste 2608)", date: "2026-09-01", gastoBrl: 10, cliques: 1, impressoes: 10 },
      { canal: "Meta Ads (teste 2608)", date: "2026-09-01", gastoBrl: 10, cliques: 1, impressoes: 10 },
    ];
    const rows = buildChannelTable(metrics, [], { pauseStatus: "pausada" });
    assert.ok(rows.every((r) => r.pauseStatus === "pausada"));
  });

  it("sem pauseStatus em opts (default): 'desconhecido' — nunca 'ativa' por omissão", () => {
    const metrics: ChannelDailyMetric[] = [{ canal: "Google Ads (teste 2608)", date: "2026-09-01", gastoBrl: 10, cliques: 1, impressoes: 10 }];
    const rows = buildChannelTable(metrics, []);
    assert.equal(rows[0].pauseStatus, "desconhecido");
  });
});
