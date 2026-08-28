/**
 * test/brevo-dashboard-hour-test-5154.test.ts (#5154)
 *
 * Regressão (#633) para a seção de leitura do teste de HORÁRIO da onda
 * ramp-warm (#5140): `parseHourTestCampaign` (naming), `aggregateHourTest`
 * (agregação por braço + z-test + guard de poder), `renderHourTestSection`
 * (só renderiza com >=2 braços amostrados — mesmo defeito que a Parte 2 da
 * #5140 já corrigiu na seção A/B/C, nunca reintroduzir bloco permanente
 * vazio).
 *
 * Todas as funções testadas são puras, exportadas de
 * workers/brevo-dashboard/src/sections-core.ts (re-export via index.ts).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseHourTestCampaign,
  resolveHourTestCampaignCell,
  aggregateHourTest,
  renderHourTestSection,
  type HourTestResult,
} from "../workers/brevo-dashboard/src/index.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

// ─── Fixtures (mesmo padrão de test/brevo-dashboard-abc-audience-schedule.test.ts) ──

function makeGlobalStats(overrides: Partial<{
  sent: number; delivered: number; hardBounces: number; softBounces: number;
  uniqueViews: number; viewed: number; trackableViews: number;
  uniqueClicks: number; clickers: number; unsubscriptions: number;
  complaints: number; appleMppOpens: number;
}> = {}) {
  return {
    sent: 2000, delivered: 1960, hardBounces: 20, softBounces: 20,
    uniqueViews: 500, viewed: 600, trackableViews: 360,
    uniqueClicks: 60, clickers: 60, unsubscriptions: 2, complaints: 0,
    appleMppOpens: 100,
    ...overrides,
  };
}

function makeCampaign(id: number, name: string, sentDate: string, gsOverrides: Parameters<typeof makeGlobalStats>[0] = {}): BrevoCampaign & { listName?: string } {
  return {
    id,
    name,
    subject: "Test",
    status: "sent",
    sentDate,
    scheduledAt: sentDate,
    createdAt: sentDate,
    recipients: { lists: [id + 100] },
    listName: `List ${id}`,
    listSize: 100,
    statistics: {
      globalStats: makeGlobalStats(gsOverrides),
    },
  } as unknown as BrevoCampaign & { listName?: string };
}

function withCampaignStats(
  campaign: ReturnType<typeof makeCampaign>,
  csOverrides: Partial<{ uniqueClicks: number }> = {},
) {
  const gs = (campaign.statistics as { globalStats: ReturnType<typeof makeGlobalStats> }).globalStats;
  return {
    ...campaign,
    statistics: {
      ...campaign.statistics,
      campaignStats: [{
        listId: 1,
        sent: gs.sent, delivered: gs.delivered, hardBounces: gs.hardBounces, softBounces: gs.softBounces,
        deferred: 0, uniqueViews: gs.uniqueViews, viewed: gs.viewed, trackableViews: gs.trackableViews,
        uniqueClicks: gs.uniqueClicks, clickers: gs.clickers, unsubscriptions: gs.unsubscriptions,
        complaints: gs.complaints,
        ...csOverrides,
      }],
    },
  };
}

// ─── parseHourTestCampaign ────────────────────────────────────────────────

describe("parseHourTestCampaign", () => {
  test("naming 'Clarice {yymm} grupo:{key}-H{HH}' → hora extraída", () => {
    assert.deepEqual(parseHourTestCampaign("Clarice 2608 grupo:d6-qui06-H06"), { hourBrt: 6 });
    assert.deepEqual(parseHourTestCampaign("Clarice 2608 grupo:d6-qui06-H10"), { hourBrt: 10 });
  });

  test("célula A/B/C (assunto) → null — dimensão distinta de propósito (#5140)", () => {
    assert.equal(parseHourTestCampaign("Clarice 2608 grupo:d6-qui06-A"), null);
  });

  test("grupo sem célula → null", () => {
    assert.equal(parseHourTestCampaign("Clarice 2608 grupo:ramp-warm"), null);
  });

  test("naming não reconhecido → null", () => {
    assert.equal(parseHourTestCampaign("Newsletter aleatória"), null);
  });

  test("hora fora de 0-23 → null", () => {
    assert.equal(parseHourTestCampaign("Clarice 2608 grupo:d6-qui06-H99"), null);
  });
});

// ─── resolveHourTestCampaignCell (#6308) ───────────────────────────────────

describe("#6308: resolveHourTestCampaignCell — reconcilia as 2 campanhas H06 sem sufixo na apuração", () => {
  test("REGRESSÃO: campaignId 164 ('d25-sab22', sem sufixo -H{HH} no nome) resolve H06 pela allowlist", () => {
    assert.deepEqual(resolveHourTestCampaignCell({ id: 164, name: "Clarice 2607 grupo:d25-sab22" }), { hourBrt: 6 });
  });

  test("REGRESSÃO: campaignId 166 ('d26-dom23', sem sufixo -H{HH} no nome) resolve H06 pela allowlist", () => {
    assert.deepEqual(resolveHourTestCampaignCell({ id: 166, name: "Clarice 2607 grupo:d26-dom23" }), { hourBrt: 6 });
  });

  test("campanha irmã com sufixo correto (id 165, 'd25-sab22-H10') resolve pelo NOME, sem precisar da allowlist", () => {
    assert.deepEqual(resolveHourTestCampaignCell({ id: 165, name: "Clarice 2607 grupo:d25-sab22-H10" }), { hourBrt: 10 });
  });

  test("guard contra falso positivo: campanha ALHEIA com nome parecido mas id fora da allowlist NÃO entra", () => {
    // Mesmo padrão de nome sem sufixo que causou o incidente, mas um id
    // qualquer não registrado — nunca deve casar por coincidência de nome.
    assert.equal(resolveHourTestCampaignCell({ id: 9999, name: "Clarice 2607 grupo:d25-sab22" }), null);
  });

  test("guard contra falso positivo: id 164/166 com um NOME diferente do incidente real não é mascarado — ainda resolve pela allowlist (id é a fonte de verdade, não o nome)", () => {
    // A allowlist é por id, não por (id, nome) — documentando o comportamento
    // esperado: se a campanha #164 for renomeada no futuro por qualquer
    // motivo, o fallback por id continua valendo até a entrada ser removida
    // manualmente da allowlist (ver docstring de HOUR_TEST_CAMPAIGN_ID_FALLBACK).
    assert.deepEqual(resolveHourTestCampaignCell({ id: 164, name: "Qualquer outro nome" }), { hourBrt: 6 });
  });

  test("campanha comum, sem sufixo e id fora da allowlist → null (comportamento pré-#6308 preservado)", () => {
    assert.equal(resolveHourTestCampaignCell({ id: 500, name: "Clarice 2608 grupo:ramp-warm" }), null);
  });
});

// ─── aggregateHourTest ─────────────────────────────────────────────────────

describe("aggregateHourTest", () => {
  test("2 braços amostrados agregam métricas e decidem líder por clique", () => {
    const campaigns = [
      withCampaignStats(makeCampaign(1, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-06T09:00:00Z", { uniqueClicks: 40 }), { uniqueClicks: 40 }),
      withCampaignStats(makeCampaign(2, "Clarice 2608 grupo:d6-qui06-H10", "2026-08-06T13:00:00Z", { uniqueClicks: 100 }), { uniqueClicks: 100 }),
      withCampaignStats(makeCampaign(3, "Clarice 2608 grupo:d7-sex07-H06", "2026-08-07T09:00:00Z", { uniqueClicks: 45 }), { uniqueClicks: 45 }),
      withCampaignStats(makeCampaign(4, "Clarice 2608 grupo:d7-sex07-H10", "2026-08-07T13:00:00Z", { uniqueClicks: 110 }), { uniqueClicks: 110 }),
    ];
    const result = aggregateHourTest(campaigns);
    assert.equal(result.cells.length, 2);
    const h06 = result.cells.find((c) => c.hourBrt === 6)!;
    const h10 = result.cells.find((c) => c.hourBrt === 10)!;
    assert.equal(h06.campaignCount, 2);
    assert.equal(h06.clicksAttributed, 85);
    assert.equal(h10.clicksAttributed, 210);
    assert.equal(result.leaderClickRateHour, 10);
    assert.ok(result.pValue !== null);
  });

  test("campanhas não-hora (A/B/C ou sem célula) são ignoradas", () => {
    const campaigns = [
      withCampaignStats(makeCampaign(1, "Clarice 2608 grupo:d6-qui06-A", "2026-08-06T09:00:00Z"), {}),
      withCampaignStats(makeCampaign(2, "Clarice News 2608 d06", "2026-08-06T09:00:00Z"), {}),
    ];
    const result = aggregateHourTest(campaigns);
    assert.equal(result.cells.length, 0);
  });

  test("1 braço só amostrado → leaderClickRateHour null (sem comparação possível)", () => {
    const campaigns = [
      withCampaignStats(makeCampaign(1, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-06T09:00:00Z"), {}),
    ];
    const result = aggregateHourTest(campaigns);
    assert.equal(result.cells.length, 1);
    assert.equal(result.leaderClickRateHour, null);
    assert.equal(result.pValue, null);
  });

  test("REGRESSÃO #6307/#6308: campanhas 164/166 (H06 sem sufixo no nome) entram na apuração — H06 e H10 ficam equilibrados", () => {
    const campaigns = [
      // campaignId 164: 'd25-sab22', SEM sufixo -H{HH} (o bug) — 22/08/2026 09:00Z = 06:00 BRT.
      withCampaignStats(makeCampaign(164, "Clarice 2607 grupo:d25-sab22", "2026-08-22T09:00:00Z", { uniqueClicks: 40 }), { uniqueClicks: 40 }),
      // campaignId 165: 'd25-sab22-H10', irmã com sufixo correto.
      withCampaignStats(makeCampaign(165, "Clarice 2607 grupo:d25-sab22-H10", "2026-08-22T13:00:00Z", { uniqueClicks: 100 }), { uniqueClicks: 100 }),
      // campaignId 166: 'd26-dom23', SEM sufixo -H{HH} (o bug) — 23/08/2026 09:00Z = 06:00 BRT.
      withCampaignStats(makeCampaign(166, "Clarice 2607 grupo:d26-dom23", "2026-08-23T09:00:00Z", { uniqueClicks: 45 }), { uniqueClicks: 45 }),
      // campaignId 167: 'd26-dom23-H10', irmã com sufixo correto.
      withCampaignStats(makeCampaign(167, "Clarice 2607 grupo:d26-dom23-H10", "2026-08-23T13:00:00Z", { uniqueClicks: 110 }), { uniqueClicks: 110 }),
    ];
    const result = aggregateHourTest(campaigns);
    const h06 = result.cells.find((c) => c.hourBrt === 6)!;
    const h10 = result.cells.find((c) => c.hourBrt === 10)!;
    // Antes do #6308, 164/166 sumiam e h06.campaignCount ficaria 0 pra esses
    // 2 dias — o painel super-representava H10 (achado ao vivo: 7×9 vs 9×9).
    assert.equal(h06.campaignCount, 2);
    assert.equal(h10.campaignCount, 2);
    assert.equal(h06.clicksAttributed, 85);
    assert.equal(h10.clicksAttributed, 210);
  });

  test("campanha sem campaignStats cai pro total não-atribuído (mesma degradação do A/B/C, #4559)", () => {
    const campaigns = [
      makeCampaign(1, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-06T09:00:00Z", { uniqueClicks: 40 }),
      makeCampaign(2, "Clarice 2608 grupo:d6-qui06-H10", "2026-08-06T13:00:00Z", { uniqueClicks: 100 }),
    ];
    const result = aggregateHourTest(campaigns);
    const h06 = result.cells.find((c) => c.hourBrt === 6)!;
    assert.equal(h06.unattributedCampaignCount, 1);
    assert.equal(h06.clicksAttributed, 40); // caiu pro total, mas sinalizado
  });
});

// ─── aggregateHourTest — escopo por janela ativa (#5189) ───────────────────

describe("aggregateHourTest — escopo por janela (#5189)", () => {
  test("hourTestState OMITIDO (undefined) preserva o comportamento pré-#5189 — agrega TODA a história", () => {
    const campaigns = [
      withCampaignStats(makeCampaign(1, "Clarice 2606 grupo:d6-qui06-H06", "2026-06-06T09:00:00Z", { uniqueClicks: 40 }), { uniqueClicks: 40 }),
      withCampaignStats(makeCampaign(2, "Clarice 2606 grupo:d6-qui06-H10", "2026-06-06T13:00:00Z", { uniqueClicks: 100 }), { uniqueClicks: 100 }),
      withCampaignStats(makeCampaign(3, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-06T09:00:00Z", { uniqueClicks: 45 }), { uniqueClicks: 45 }),
      withCampaignStats(makeCampaign(4, "Clarice 2608 grupo:d6-qui06-H10", "2026-08-06T13:00:00Z", { uniqueClicks: 110 }), { uniqueClicks: 110 }),
    ];
    const result = aggregateHourTest(campaigns);
    const h06 = result.cells.find((c) => c.hourBrt === 6)!;
    assert.equal(h06.campaignCount, 2, "sem estado passado, os 2 testes (jun + ago) se misturam — comportamento antigo");
  });

  test("REGRESSÃO #5189: teste ATIVO exclui campanhas de um teste ANTERIOR (mesmas horas H06/H10, ciclo mensal diferente)", () => {
    // Teste #1: rodou (e nunca foi formalmente encerrado no estado — cenário
    // de degradação) em junho/2026.
    const testeAntigo = [
      withCampaignStats(makeCampaign(1, "Clarice 2606 grupo:d6-qui06-H06", "2026-06-06T09:00:00Z", { uniqueClicks: 40 }), { uniqueClicks: 40 }),
      withCampaignStats(makeCampaign(2, "Clarice 2606 grupo:d6-qui06-H10", "2026-06-06T13:00:00Z", { uniqueClicks: 100 }), { uniqueClicks: 100 }),
    ];
    // Teste #2: reabre em agosto/2026, REUSANDO as mesmas horas H06/H10.
    const testeNovo = [
      withCampaignStats(makeCampaign(3, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-06T09:00:00Z", { uniqueClicks: 45 }), { uniqueClicks: 45 }),
      withCampaignStats(makeCampaign(4, "Clarice 2608 grupo:d6-qui06-H10", "2026-08-06T13:00:00Z", { uniqueClicks: 110 }), { uniqueClicks: 110 }),
    ];
    const hourTestState = { status: "ativo" as const, hoursBrt: [6, 10], startedAt: "2026-08-01T00:00:00.000Z" };
    const result = aggregateHourTest([...testeAntigo, ...testeNovo], hourTestState);
    const h06 = result.cells.find((c) => c.hourBrt === 6)!;
    const h10 = result.cells.find((c) => c.hourBrt === 10)!;
    assert.equal(h06.campaignCount, 1, "só a campanha de agosto (dentro da janela) deve contar");
    assert.equal(h06.clicksAttributed, 45, "45 (agosto) — NÃO 85 (jun+ago misturados)");
    assert.equal(h10.campaignCount, 1);
    assert.equal(h10.clicksAttributed, 110);
  });

  test("REGRESSÃO #5189: teste ENCERRADO só inclui campanhas dentro de [startedAt, decidedAt] — não vaza pro teste seguinte", () => {
    const testeAntigo = [
      withCampaignStats(makeCampaign(1, "Clarice 2606 grupo:d6-qui06-H06", "2026-06-06T09:00:00Z", { uniqueClicks: 40 }), { uniqueClicks: 40 }),
      withCampaignStats(makeCampaign(2, "Clarice 2606 grupo:d6-qui06-H10", "2026-06-06T13:00:00Z", { uniqueClicks: 100 }), { uniqueClicks: 100 }),
    ];
    // Esta é a janela FECHADA de junho: [01/06, 15/06].
    const hourTestStateAntigo = {
      status: "encerrado" as const,
      hoursBrt: [6, 10],
      startedAt: "2026-06-01T00:00:00.000Z",
      decidedAt: "2026-06-15T00:00:00.000Z",
    };
    const resultAntigo = aggregateHourTest(testeAntigo, hourTestStateAntigo);
    const h06Antigo = resultAntigo.cells.find((c) => c.hourBrt === 6)!;
    assert.equal(h06Antigo.campaignCount, 1);

    // Campanha de agosto (fora da janela fechada de junho) não deve aparecer
    // se, por algum motivo, o dashboard ainda estivesse lendo o estado antigo.
    const testeNovo = withCampaignStats(makeCampaign(3, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-06T09:00:00Z", { uniqueClicks: 45 }), { uniqueClicks: 45 });
    const resultMisturado = aggregateHourTest([...testeAntigo, testeNovo], hourTestStateAntigo);
    const h06Misturado = resultMisturado.cells.find((c) => c.hourBrt === 6)!;
    assert.equal(h06Misturado.campaignCount, 1, "campanha de agosto fica FORA da janela encerrada de junho");
    assert.equal(h06Misturado.clicksAttributed, 40);
  });

  test("hourTestState null (KV sem estado válido) exclui TODAS as campanhas H0N — nunca agrega às cegas", () => {
    const campaigns = [
      withCampaignStats(makeCampaign(1, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-06T09:00:00Z", { uniqueClicks: 40 }), { uniqueClicks: 40 }),
      withCampaignStats(makeCampaign(2, "Clarice 2608 grupo:d6-qui06-H10", "2026-08-06T13:00:00Z", { uniqueClicks: 100 }), { uniqueClicks: 100 }),
    ];
    const result = aggregateHourTest(campaigns, null);
    assert.equal(result.cells.length, 0);
  });

  test("hourTestState {status:'inativo'} exclui TODAS as campanhas H0N", () => {
    const campaigns = [
      withCampaignStats(makeCampaign(1, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-06T09:00:00Z"), {}),
      withCampaignStats(makeCampaign(2, "Clarice 2608 grupo:d6-qui06-H10", "2026-08-06T13:00:00Z"), {}),
    ];
    const result = aggregateHourTest(campaigns, { status: "inativo" });
    assert.equal(result.cells.length, 0);
  });

  test("campanha sem scheduledAt/sentDate parseável é excluída quando escopado (nunca incluída por default)", () => {
    const campaign = withCampaignStats(makeCampaign(1, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-06T09:00:00Z"), {});
    campaign.sentDate = null;
    campaign.scheduledAt = null;
    const hourTestState = { status: "ativo" as const, hoursBrt: [6, 10], startedAt: "2026-08-01T00:00:00.000Z" };
    const result = aggregateHourTest([campaign], hourTestState);
    assert.equal(result.cells.length, 0);
  });
});

// ─── renderHourTestSection ─────────────────────────────────────────────────

describe("renderHourTestSection", () => {
  function emptyResult(): HourTestResult {
    return { cells: [], leaderClickRateHour: null, significantClick: false, pValue: null, minDetectableLiftRelative: null };
  }

  test("sem braços amostrados → string vazia (nunca bloco permanente vazio)", () => {
    assert.equal(renderHourTestSection(emptyResult()), "");
  });

  test("1 braço só amostrado → string vazia (sem comparação possível ainda)", () => {
    const result: HourTestResult = {
      cells: [
        { hourBrt: 6, hourLabel: "H06", campaignCount: 3, sent: 6000, delivered: 5900, opens: 1500, clicksAttributed: 120, unattributedCampaignCount: 0, clicksTotal: 120, unsubscriptions: 6, bounces: 60, openRate: 25, ctor: 8, clickRate: 2, unsubRate: 0.1, bounceRate: 1 },
      ],
      leaderClickRateHour: null, significantClick: false, pValue: null, minDetectableLiftRelative: null,
    };
    assert.equal(renderHourTestSection(result), "");
  });

  test("2+ braços amostrados → renderiza tabela + veredito, sem tocar a seção A/B/C", () => {
    const campaigns = [
      withCampaignStats(makeCampaign(1, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-06T09:00:00Z", { uniqueClicks: 40 }), { uniqueClicks: 40 }),
      withCampaignStats(makeCampaign(2, "Clarice 2608 grupo:d6-qui06-H10", "2026-08-06T13:00:00Z", { uniqueClicks: 100 }), { uniqueClicks: 100 }),
    ];
    const html = renderHourTestSection(aggregateHourTest(campaigns));
    assert.ok(html.includes("Teste de Horário"));
    assert.ok(html.includes("06:00 BRT"));
    assert.ok(html.includes("10:00 BRT"));
    assert.ok(html.includes('id="hour-test-ramp-warm"'));
    // Seção SEPARADA — nunca reusa o id/título da seção A/B/C por audiência.
    assert.ok(!html.includes("abc-audience"));
    assert.ok(!html.includes("Resumo A/B/C"));
  });

  test("amostra pequena com p<0.05 ganha a ressalva de poder no mesmo formato do A/B/C (#4559)", () => {
    // Amostra pequena o suficiente pra minDetectableLiftRelative >= 30%.
    const campaigns = [
      withCampaignStats(makeCampaign(1, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-06T09:00:00Z", { sent: 100, delivered: 98, uniqueClicks: 3 }), { uniqueClicks: 3 }),
      withCampaignStats(makeCampaign(2, "Clarice 2608 grupo:d6-qui06-H10", "2026-08-06T13:00:00Z", { sent: 100, delivered: 98, uniqueClicks: 15 }), { uniqueClicks: 15 }),
    ];
    const result = aggregateHourTest(campaigns);
    const html = renderHourTestSection(result);
    if (result.significantClick) {
      assert.ok(html.includes("poder"));
    }
  });

  test("todos zerados → 'aguardando dados de clique'", () => {
    const campaigns = [
      withCampaignStats(makeCampaign(1, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-06T09:00:00Z", { uniqueClicks: 0 }), { uniqueClicks: 0 }),
      withCampaignStats(makeCampaign(2, "Clarice 2608 grupo:d6-qui06-H10", "2026-08-06T13:00:00Z", { uniqueClicks: 0 }), { uniqueClicks: 0 }),
    ];
    const html = renderHourTestSection(aggregateHourTest(campaigns));
    assert.ok(html.includes("Aguardando dados de clique"));
  });
});

describe("#5947: dias inválidos — exclusão por data BRT (#5947)", () => {
  test("campaign de dia marcado como inválido é excluída; resultado reflete só dias restantes", () => {
    const campaigns = [
      withCampaignStats(makeCampaign(1, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-21T09:00:00Z", { uniqueClicks: 40 }), { uniqueClicks: 40 }),
      withCampaignStats(makeCampaign(2, "Clarice 2608 grupo:d6-qui06-H10", "2026-08-06T13:00:00Z", { uniqueClicks: 100 }), { uniqueClicks: 100 }),
    ];
    const hourTestState = { status: "ativo" as const, hoursBrt: [6, 10], startedAt: "2026-08-01T00:00:00.000Z", invalidDays: ["2026-08-21"] };
    const result = aggregateHourTest(campaigns, hourTestState);
    assert.deepEqual(result.excludedDays, ["2026-08-21"]);
    const h06 = result.cells.find((c) => c.hourBrt === 6);
    assert.equal(h06 ? h06.campaignCount : 0, 0, "H06 de 21/08 (inválido) excluído");
    const h10 = result.cells.find((c) => c.hourBrt === 10);
    assert.equal(h10 ? h10.campaignCount : 0, 1, "H10 de 06/08 (válido) mantido");
  });

  test("renderHourTestSection inclui nota de exclusão quando excludedDays existe", () => {
    const campaigns = [
      withCampaignStats(makeCampaign(1, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-21T09:00:00Z", { uniqueClicks: 40 }), { uniqueClicks: 40 }),
      withCampaignStats(makeCampaign(2, "Clarice 2608 grupo:d6-qui06-H06", "2026-08-06T09:00:00Z", { uniqueClicks: 50 }), { uniqueClicks: 50 }),
      withCampaignStats(makeCampaign(3, "Clarice 2608 grupo:d6-qui06-H10", "2026-08-22T13:00:00Z", { uniqueClicks: 110 }), { uniqueClicks: 110 }),
      withCampaignStats(makeCampaign(4, "Clarice 2608 grupo:d6-qui06-H10", "2026-08-06T13:00:00Z", { uniqueClicks: 100 }), { uniqueClicks: 100 }),
    ];
    const hourTestState = { status: "ativo" as const, hoursBrt: [6, 10], startedAt: "2026-08-01T00:00:00.000Z", invalidDays: ["2026-08-21", "2026-08-22"] };
    const html = renderHourTestSection(aggregateHourTest(campaigns, hourTestState));
    assert.ok(html.includes("Nota de exclusão"));
    assert.ok(html.includes("2026-08-21"));
  });
});
