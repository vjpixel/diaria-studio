/**
 * test/brevo-dashboard-cta-experiment.test.ts (#3884)
 *
 * Regressão (#633) para o painel de avaliação de experimentos A/B da Clarice
 * (mensal) + registro "Experimento vigente":
 *  - matchCta01Campaign / pairExperimentCampaigns — pareamento de campanhas
 *    A/B do mesmo envio a partir do naming gerado por
 *    scripts/clarice-cta-ab-setup.ts.
 *  - computeArmMetrics / countDecisionClicks — acumulado por braço, incluindo
 *    a métrica de decisão (cliques no link com utm_term configurado).
 *  - evaluateExperimentDecision — teste de duas proporções (reusa
 *    `twoProportionZTest` de sections-core.ts, #2976) + regra de decisão
 *    (lift relativo ≥ threshold E p < alpha).
 *  - evaluateArmGuardrails — mesmos circuit breakers da aba Rampa
 *    (thresholds.ts), por braço.
 *  - renderExperimentRegistrySection / renderExperimentEvaluationSection —
 *    smoke tests de render (HTML não-vazio, contém os dados esperados).
 *
 * Todas as funções são puras, exportadas de
 * workers/brevo-dashboard/src/index.ts (re-export de experiment-cta.ts).
 * Sem chamada de rede — fixtures locais do shape real da Brevo API (mesmo
 * padrão de test/brevo-dashboard-fase2.test.ts).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  matchCta01Campaign,
  pairExperimentCampaigns,
  matchExperimentCampaigns,
  computeArmMetrics,
  countDecisionClicks,
  evaluateExperimentDecision,
  evaluateArmGuardrails,
  renderExperimentRegistrySection,
  renderExperimentEvaluationSection,
  renderExperimentsEvaluationSections,
  renderDashboardHtml,
  CTA01_EXPERIMENT,
  EXPERIMENTS,
  type ExperimentDefinition,
  type ArmMetrics,
} from "../workers/brevo-dashboard/src/index.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeGlobalStats(overrides: Partial<{
  sent: number; delivered: number; hardBounces: number; softBounces: number;
  uniqueViews: number; viewed: number; trackableViews: number;
  uniqueClicks: number; clickers: number; unsubscriptions: number;
  complaints: number; appleMppOpens: number;
}> = {}) {
  return {
    sent: 6000, delivered: 5940, hardBounces: 10, softBounces: 20,
    uniqueViews: 1000, viewed: 1200, trackableViews: 700,
    uniqueClicks: 60, clickers: 60, unsubscriptions: 5, complaints: 1,
    appleMppOpens: 200,
    ...overrides,
  };
}

/** Braço "a" (topo-marca, topo, corpo-marca, corpo, fim-marca, fim, fim-marca2) — só os 2 relevantes ao teste (topo + corpo) pra manter o fixture enxuto. */
function ctaLinksStats(arm: "a" | "b", topoClicks: number): Record<string, number> {
  return {
    [`https://diaria.beehiiv.com/?utm_source=clarice&utm_medium=email&utm_campaign=clarice-2606-07-cta-${arm}&utm_term=topo`]: topoClicks,
    [`https://diaria.beehiiv.com/?utm_source=clarice&utm_medium=email&utm_campaign=clarice-2606-07-cta-${arm}&utm_term=corpo`]: topoClicks + 5,
    "https://diaria.beehiiv.com/unsubscribe?x=1": 3, // link de sistema — nunca deve contar como decisionClicks
  };
}

function makeCtaCampaign(
  id: number,
  envio: number,
  arm: "A" | "B",
  sentDate: string,
  gsOverrides: Parameters<typeof makeGlobalStats>[0] = {},
  topoClicks = 30,
): BrevoCampaign & { listName?: string; listSize?: number } {
  const armLower = arm.toLowerCase() as "a" | "b";
  return {
    id,
    name: `Diar.ia Mensal 2606 — envio ${envio}${arm} (cta-${armLower} qui 23/07)`,
    subject: "Test",
    status: "sent",
    sentDate,
    scheduledAt: null,
    createdAt: sentDate,
    recipients: { lists: [id + 100] },
    listName: `Diar.ia Mensal 2606 — envio ${envio}${arm} (cta-${armLower} qui 23/07)`,
    listSize: 6000,
    statistics: {
      globalStats: makeGlobalStats(gsOverrides),
      linksStats: ctaLinksStats(armLower, topoClicks),
    },
  };
}

// ─── matchCta01Campaign ───────────────────────────────────────────────────────

describe("matchCta01Campaign", () => {
  test("casa envio 8A (cta-a)", () => {
    const r = matchCta01Campaign("Diar.ia Mensal 2606 — envio 8A (cta-a qui 23/07)");
    assert.deepEqual(r, { pairKey: "envio-8", armId: "a" });
  });

  test("casa envio 9B (cta-b)", () => {
    const r = matchCta01Campaign("Diar.ia Mensal 2606 — envio 9B (cta-b sex 24/07)");
    assert.deepEqual(r, { pairKey: "envio-9", armId: "b" });
  });

  test("nome não relacionado ao experimento → null", () => {
    assert.equal(matchCta01Campaign("Clarice News 2605 d01-A (qua)"), null);
    assert.equal(matchCta01Campaign("Diar.ia Mensal 2606 — 2026-07-14 19:26"), null);
  });
});

// ─── pairExperimentCampaigns / matchExperimentCampaigns ──────────────────────

describe("pairExperimentCampaigns", () => {
  const campaigns = [
    makeCtaCampaign(95, 8, "A", "2026-07-23T09:00:00Z"),
    makeCtaCampaign(97, 8, "B", "2026-07-23T09:00:00Z"),
    makeCtaCampaign(96, 9, "A", "2026-07-24T09:00:00Z"),
    makeCtaCampaign(98, 9, "B", "2026-07-24T09:00:00Z"),
    // Campanha de outro experimento/naming — não deve entrar em nenhum par.
    {
      id: 200, name: "Clarice News 2605 d01-A (qua)", subject: "x", status: "sent",
      sentDate: "2026-06-10T09:00:00Z", scheduledAt: null, createdAt: "2026-06-10T09:00:00Z",
      recipients: { lists: [1] }, statistics: { globalStats: makeGlobalStats() },
    } as BrevoCampaign,
  ];

  test("agrupa 2 envios, ordenados por pairKey", () => {
    const pairs = pairExperimentCampaigns(campaigns, CTA01_EXPERIMENT);
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0].pairKey, "envio-8");
    assert.equal(pairs[1].pairKey, "envio-9");
    assert.equal(pairs[0].arms.a?.id, 95);
    assert.equal(pairs[0].arms.b?.id, 97);
    assert.equal(pairs[1].arms.a?.id, 96);
    assert.equal(pairs[1].arms.b?.id, 98);
  });

  test("par incompleto (só 1 braço enviado) fica com o outro braço ausente", () => {
    const incomplete = [makeCtaCampaign(95, 8, "A", "2026-07-23T09:00:00Z")];
    const pairs = pairExperimentCampaigns(incomplete, CTA01_EXPERIMENT);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].arms.a?.id, 95);
    assert.equal(pairs[0].arms.b, undefined);
  });

  test("matchExperimentCampaigns ignora campanhas de outro naming", () => {
    const refs = matchExperimentCampaigns(campaigns, CTA01_EXPERIMENT);
    assert.equal(refs.length, 4); // só as 4 CTA-01, não a "Clarice News 2605 d01-A"
    assert.ok(refs.every((r) => r.campaign.id !== 200));
  });
});

// ─── countDecisionClicks / computeArmMetrics ─────────────────────────────────

describe("countDecisionClicks", () => {
  test("soma só o link com utm_campaign+utm_term do braço, ignora outros", () => {
    const campaign = makeCtaCampaign(95, 8, "A", "2026-07-23T09:00:00Z", {}, 42);
    const armDef = CTA01_EXPERIMENT.arms.find((a) => a.id === "a")!;
    assert.equal(countDecisionClicks(campaign, armDef, "topo"), 42);
  });

  test("braço errado (utm_campaign não bate) → 0", () => {
    const campaign = makeCtaCampaign(97, 8, "B", "2026-07-23T09:00:00Z", {}, 42);
    const armDefA = CTA01_EXPERIMENT.arms.find((a) => a.id === "a")!;
    assert.equal(countDecisionClicks(campaign, armDefA, "topo"), 0);
  });

  test("sem linksStats → 0", () => {
    const armDef = CTA01_EXPERIMENT.arms.find((a) => a.id === "a")!;
    const campaign = { ...makeCtaCampaign(95, 8, "A", "2026-07-23T09:00:00Z"), statistics: {} };
    assert.equal(countDecisionClicks(campaign, armDef, "topo"), 0);
  });
});

describe("computeArmMetrics", () => {
  test("acumula entre os 2 envios, por braço", () => {
    const campaigns = [
      makeCtaCampaign(95, 8, "A", "2026-07-23T09:00:00Z", { delivered: 6000 }, 30),
      makeCtaCampaign(97, 8, "B", "2026-07-23T09:00:00Z", { delivered: 6000 }, 45),
      makeCtaCampaign(96, 9, "A", "2026-07-24T09:00:00Z", { delivered: 6700 }, 33),
      makeCtaCampaign(98, 9, "B", "2026-07-24T09:00:00Z", { delivered: 6700 }, 48),
    ];
    const metrics = computeArmMetrics(campaigns, CTA01_EXPERIMENT);
    assert.equal(metrics.length, 2);
    const [a, b] = metrics;
    assert.equal(a.armId, "a");
    assert.equal(b.armId, "b");
    assert.equal(a.campaignCount, 2);
    assert.equal(a.delivered, 6000 + 6700);
    assert.equal(a.decisionClicks, 30 + 33);
    assert.equal(b.decisionClicks, 45 + 48);
  });

  test("braço sem nenhuma campanha ainda → métricas zeradas, nunca ausente", () => {
    const onlyA = [makeCtaCampaign(95, 8, "A", "2026-07-23T09:00:00Z")];
    const metrics = computeArmMetrics(onlyA, CTA01_EXPERIMENT);
    assert.equal(metrics.length, 2);
    const b = metrics.find((m) => m.armId === "b")!;
    assert.equal(b.campaignCount, 0);
    assert.equal(b.delivered, 0);
    assert.equal(b.decisionClicks, 0);
  });

  test("campanha sem stats reais (sent=0) é ignorada, não zera o acumulado de outras", () => {
    const campaigns = [
      makeCtaCampaign(95, 8, "A", "2026-07-23T09:00:00Z", {}, 30),
      { ...makeCtaCampaign(96, 9, "A", "2026-07-24T09:00:00Z"), statistics: { globalStats: makeGlobalStats({ sent: 0, delivered: 0 }) } },
    ];
    const metrics = computeArmMetrics(campaigns, CTA01_EXPERIMENT);
    const a = metrics.find((m) => m.armId === "a")!;
    assert.equal(a.campaignCount, 1); // só a campanha 95 conta
  });
});

// ─── evaluateExperimentDecision (reusa twoProportionZTest, #2976) ────────────

describe("evaluateExperimentDecision", () => {
  test("taxas idênticas → lift 0, não significativo", () => {
    const control: Pick<ArmMetrics, "decisionClicks" | "delivered"> = { decisionClicks: 60, delivered: 12000 };
    const treatment: Pick<ArmMetrics, "decisionClicks" | "delivered"> = { decisionClicks: 60, delivered: 12000 };
    const r = evaluateExperimentDecision(control, treatment);
    assert.ok(Math.abs(r.liftRelative) < 1e-9);
    assert.equal(r.significant, false);
    assert.equal(r.meetsDecisionRule, false);
  });

  test("lift +50% com amostra suficiente → cruza a regra de decisão (p<0.05)", () => {
    // controle 60/12000 (0.5%), tratamento 90/12000 (0.75%) — lift relativo 50%.
    const control = { decisionClicks: 60, delivered: 12000 };
    const treatment = { decisionClicks: 90, delivered: 12000 };
    const r = evaluateExperimentDecision(control, treatment, 0.30, 0.05);
    assert.ok(Math.abs(r.liftRelative - 0.5) < 1e-9, `lift esperado 0.5, obtido ${r.liftRelative}`);
    assert.ok(r.pValue < 0.05, `esperado p<0.05, obtido ${r.pValue}`);
    assert.equal(r.significant, true);
    assert.equal(r.meetsDecisionRule, true);
  });

  test("significativo mas lift abaixo do threshold → NÃO cruza a regra", () => {
    // mesmo N, diferença pequena o bastante pra não bater 30% de lift mesmo
    // que fosse significativa — aqui o lift em si (10%) já reprova a regra.
    const control = { decisionClicks: 100, delivered: 12000 };
    const treatment = { decisionClicks: 110, delivered: 12000 }; // lift = 10%
    const r = evaluateExperimentDecision(control, treatment, 0.30, 0.05);
    assert.ok(Math.abs(r.liftRelative - 0.10) < 1e-9);
    assert.equal(r.meetsDecisionRule, false); // reprovado pelo lift, independente do p-valor
  });

  test("braço sem entregas ainda (delivered=0) → insufficientData, nunca cruza a regra", () => {
    const r = evaluateExperimentDecision({ decisionClicks: 0, delivered: 0 }, { decisionClicks: 5, delivered: 100 });
    assert.equal(r.insufficientData, true);
    assert.equal(r.pValue, 1);
    assert.equal(r.meetsDecisionRule, false);
  });

  test("controle com 0 cliques e tratamento >0 → lift Infinity, não quebra", () => {
    const r = evaluateExperimentDecision({ decisionClicks: 0, delivered: 5000 }, { decisionClicks: 10, delivered: 5000 });
    assert.equal(r.liftRelative, Infinity);
    // meetsDecisionRule exige Number.isFinite(liftRelative) — Infinity nunca cruza.
    assert.equal(r.meetsDecisionRule, false);
  });
});

// ─── evaluateArmGuardrails (mesmos circuit breakers da Rampa, thresholds.ts) ─

describe("evaluateArmGuardrails", () => {
  function metrics(overrides: Partial<ArmMetrics> = {}): ArmMetrics {
    return {
      armId: "a", label: "A", campaignCount: 1, sent: 10000, delivered: 9900,
      uniqueViews: 2000, uniqueClicks: 100, decisionClicks: 60,
      unsubscriptions: 50, complaints: 2, hardBounces: 20, softBounces: 30,
      ...overrides,
    };
  }

  test("dentro dos limites → nenhum breach", () => {
    const g = evaluateArmGuardrails(metrics());
    assert.equal(g.anyBreach, false);
  });

  test("abertura < 15% → openBreach", () => {
    const g = evaluateArmGuardrails(metrics({ uniqueViews: 100, delivered: 10000 })); // 1%
    assert.equal(g.openBreach, true);
    assert.equal(g.anyBreach, true);
  });

  test("unsub >= 3% → unsubBreach", () => {
    const g = evaluateArmGuardrails(metrics({ unsubscriptions: 400, sent: 10000 })); // 4%
    assert.equal(g.unsubBreach, true);
  });

  test("spam >= 0,1% → spamBreach", () => {
    const g = evaluateArmGuardrails(metrics({ complaints: 15, sent: 10000 })); // 0.15%
    assert.equal(g.spamBreach, true);
  });

  test("hard bounce >= 2% (mesmo com total < 5%) → bounceBreach (regra OR, #3078)", () => {
    const g = evaluateArmGuardrails(metrics({ hardBounces: 250, softBounces: 30, sent: 10000 })); // hard 2.5%, total 2.8%
    assert.equal(g.bounceBreach, true);
  });

  test("sem envios ainda (delivered=0) → nunca afirma breach de abertura", () => {
    const g = evaluateArmGuardrails(metrics({ delivered: 0, uniqueViews: 0, sent: 0, hardBounces: 0, softBounces: 0, unsubscriptions: 0, complaints: 0 }));
    assert.equal(g.openBreach, false);
    assert.equal(g.anyBreach, false);
  });

  test("campanha recém-enviada (delivered>0, uniqueViews=0 ainda propagando) → NÃO afirma breach de abertura", () => {
    // #3078: mesmo guard de sections-core.ts (openAlert exige openRateNum > 0,
    // não só delivered > 0) — dado de abertura ainda propagando (MPP leva
    // minutos) não pode ser confundido com "0% de abertura permanente".
    const g = evaluateArmGuardrails(metrics({ delivered: 6000, uniqueViews: 0, sent: 6000, hardBounces: 0, softBounces: 0, unsubscriptions: 0, complaints: 0 }));
    assert.equal(g.openRatePct, 0);
    assert.equal(g.openBreach, false);
  });
});

// ─── Render: seção "Experimento vigente" ─────────────────────────────────────

describe("renderExperimentRegistrySection", () => {
  test("lista vazia → string vazia", () => {
    assert.equal(renderExperimentRegistrySection([]), "");
  });

  test("CTA-01 (ativo) — contém hipótese, braços, regra e link do protocolo", () => {
    const html = renderExperimentRegistrySection([CTA01_EXPERIMENT]);
    assert.ok(html.includes("Experimento vigente"));
    assert.ok(html.includes("Ativo"));
    assert.ok(html.includes("Trocar o CTA do topo"));
    assert.ok(html.includes("A (controle) — copy atual"));
    assert.ok(html.includes("B (tratamento) — copy B1 aprovada 22/07"));
    assert.ok(html.includes("≥30% relativo"));
    assert.ok(html.includes("docs/experiments/cta-ab-mensal-2606-07.md"));
  });

  test("status 'vencedor' e 'encerrado' — badges corretos", () => {
    const base: ExperimentDefinition = { ...CTA01_EXPERIMENT, id: "cta-01-round1", name: "CTA-01 (round 1, encerrado)" };
    const winner = renderExperimentRegistrySection([{ ...base, status: "vencedor" }]);
    const closed = renderExperimentRegistrySection([{ ...base, status: "encerrado" }]);
    assert.ok(winner.includes("Vencedor"));
    assert.ok(closed.includes("Encerrado"));
  });

  test("suporta MÚLTIPLOS experimentos simultaneamente (lista, não texto hardcoded)", () => {
    const second: ExperimentDefinition = {
      ...CTA01_EXPERIMENT,
      id: "cta-02",
      name: "CTA-02 — posição do bloco dedicado (round 2)",
      status: "ativo",
    };
    const html = renderExperimentRegistrySection([CTA01_EXPERIMENT, second]);
    assert.ok(html.includes("experiment-cta-01"));
    assert.ok(html.includes("experiment-cta-02"));
  });
});

// ─── Render: painel de avaliação ─────────────────────────────────────────────

describe("renderExperimentEvaluationSection", () => {
  test("sem campanhas do experimento na janela → stub graceful", () => {
    const html = renderExperimentEvaluationSection(CTA01_EXPERIMENT, []);
    assert.ok(html.includes("Nenhuma campanha do experimento encontrada"));
  });

  test("com pares completos — contém pareamento, métricas por braço e z-test", () => {
    const campaigns = [
      makeCtaCampaign(95, 8, "A", "2026-07-23T09:00:00Z", { delivered: 6000 }, 30),
      makeCtaCampaign(97, 8, "B", "2026-07-23T09:00:00Z", { delivered: 6000 }, 45),
    ];
    const html = renderExperimentEvaluationSection(CTA01_EXPERIMENT, campaigns);
    assert.ok(html.includes("envio-8"));
    assert.ok(html.includes("Pareamento por envio"));
    assert.ok(html.includes("Acumulado por braço"));
    assert.ok(html.includes("Teste de duas proporções"));
    assert.ok(html.includes("Conversões"));
    // campo manual de conversão — nunca dispara request, só localStorage.
    assert.ok(html.includes("exp-conversions-input"));
    assert.ok(html.includes("data-experiment=\"cta-01\""));
    assert.ok(html.includes("localStorage"));
    assert.ok(!html.includes("fetch("));
  });

  test("renderExperimentsEvaluationSections concatena todos os experimentos do registro", () => {
    const campaigns = [makeCtaCampaign(95, 8, "A", "2026-07-23T09:00:00Z")];
    const html = renderExperimentsEvaluationSections(campaigns, EXPERIMENTS);
    assert.ok(html.includes(CTA01_EXPERIMENT.name));
  });
});

// ─── Integração: wiring dentro de renderDashboardHtml (aba Rampa/Agendamento) ─

describe("renderDashboardHtml — wiring do painel de experimentos (#3884)", () => {
  test("aba Agendamento inclui o registro e o painel de avaliação do CTA-01", () => {
    const campaigns = [
      makeCtaCampaign(95, 8, "A", "2026-07-23T09:00:00Z", { delivered: 6000 }, 30),
      makeCtaCampaign(97, 8, "B", "2026-07-23T09:00:00Z", { delivered: 6000 }, 45),
    ];
    const html = renderDashboardHtml(campaigns);
    assert.ok(html.includes('id="experiment-registry"'));
    assert.ok(html.includes('id="experiment-eval-cta-01"'));
    // dentro da aba Agendamento (panel-rampa), não solta fora dela.
    const rampaStart = html.indexOf('id="panel-rampa"');
    const rampaEnd = html.indexOf("<!-- /panel-rampa -->");
    const registryIdx = html.indexOf('id="experiment-registry"');
    assert.ok(rampaStart > -1 && rampaEnd > -1 && registryIdx > rampaStart && registryIdx < rampaEnd);
  });
});
