/**
 * #2974: aba "Rampa" (planejador semanal de volume cold).
 *
 * Cobre as 4 funções puras do worker (sem I/O):
 *  - filterMatureCampaigns: janela de maturação >48h (47h fora, 49h dentro).
 *  - aggregateHealth: agregado ponderado por delivered/sent.
 *  - decideSemaphore: cada fronteira do semáforo, por métrica — pior manda.
 *  - computeWeekPlan: verde escalona (composto), amarelo repete, vermelho corta -30% + flag.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterMatureCampaigns,
  aggregateHealth,
  decideSemaphore,
  classifyMetric,
  computeWeekPlan,
  renderWeeklyPlanTabPanel,
  baseVolumeFromLastSendDay,
  DEFAULT_HEALTH_THRESHOLDS,
  MATURATION_MS,
  type HealthAggregate,
} from "../workers/brevo-dashboard/src/index.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/index.ts";

const NOW = new Date("2026-07-10T12:00:00.000Z");

function campaignSentHoursAgo(
  hoursAgo: number,
  overrides: Partial<BrevoCampaign> = {},
): BrevoCampaign {
  const sentMs = NOW.getTime() - hoursAgo * 60 * 60 * 1000;
  return {
    id: overrides.id ?? Math.round(Math.random() * 1e6),
    name: overrides.name ?? "Clarice News 2606-07 — A · dom",
    subject: "subject",
    status: "sent",
    sentDate: new Date(sentMs).toISOString(),
    scheduledAt: null,
    createdAt: new Date(sentMs).toISOString(),
    recipients: { lists: [1] },
    ...overrides,
  };
}

function statsFor(opts: {
  sent: number;
  delivered: number;
  uniqueViews: number;
  hardBounces?: number;
  softBounces?: number;
  complaints?: number;
  unsubscriptions?: number;
}): BrevoCampaign["statistics"] {
  return {
    globalStats: {
      sent: opts.sent,
      delivered: opts.delivered,
      hardBounces: opts.hardBounces ?? 0,
      softBounces: opts.softBounces ?? 0,
      uniqueViews: opts.uniqueViews,
      viewed: opts.uniqueViews,
      trackableViews: opts.uniqueViews,
      uniqueClicks: 0,
      clickers: 0,
      unsubscriptions: opts.unsubscriptions ?? 0,
      complaints: opts.complaints ?? 0,
      appleMppOpens: 0,
    },
  };
}

test("filterMatureCampaigns — 47h fora, 49h dentro (fronteira 48h)", () => {
  const immature = campaignSentHoursAgo(47, { id: 1 });
  const mature = campaignSentHoursAgo(49, { id: 2 });
  const noDate = campaignSentHoursAgo(100, { id: 3, sentDate: null });
  const result = filterMatureCampaigns([immature, mature, noDate], NOW);
  assert.deepEqual(
    result.map((c) => c.id),
    [2],
  );
});

test("filterMatureCampaigns — respeita minAgeMs custom", () => {
  const c = campaignSentHoursAgo(2, { id: 1 });
  assert.equal(filterMatureCampaigns([c], NOW, 1 * 60 * 60 * 1000).length, 1);
  assert.equal(filterMatureCampaigns([c], NOW, 3 * 60 * 60 * 1000).length, 0);
});

test("filterMatureCampaigns — default é MATURATION_MS (48h)", () => {
  assert.equal(MATURATION_MS, 48 * 60 * 60 * 1000);
});

test("aggregateHealth — agregado ponderado por delivered/sent entre múltiplas campanhas", () => {
  const c1 = campaignSentHoursAgo(72, {
    id: 1,
    statistics: statsFor({ sent: 1000, delivered: 990, uniqueViews: 150, hardBounces: 10, complaints: 1, unsubscriptions: 4 }),
  });
  const c2 = campaignSentHoursAgo(96, {
    id: 2,
    statistics: statsFor({ sent: 2000, delivered: 1980, uniqueViews: 300, hardBounces: 20, complaints: 2, unsubscriptions: 8 }),
  });
  const health = aggregateHealth([c1, c2]);
  // delivered total = 2970, views total = 450 → openRate = 450/2970*100
  assert.ok(Math.abs(health.openRate - (450 / 2970) * 100) < 1e-9);
  // sent total = 3000, bounces total = 30 → bounceRate = 30/3000*100 = 1
  assert.ok(Math.abs(health.bounceRate - 1) < 1e-9);
  // spam total = 3, sent 3000 → 0.1%
  assert.ok(Math.abs(health.spamRate - 0.1) < 1e-9);
  // unsub total = 12, sent 3000 → 0.4%
  assert.ok(Math.abs(health.unsubRate - 0.4) < 1e-9);
  assert.equal(health.delivered, 2970);
  assert.equal(health.sent, 3000);
});

test("aggregateHealth — vazio retorna zeros (sem divisão por zero)", () => {
  const health = aggregateHealth([]);
  assert.deepEqual(health, { openRate: 0, bounceRate: 0, spamRate: 0, unsubRate: 0, delivered: 0, sent: 0 });
});

test("aggregateHealth — pula campanhas sem stats reais (sent=0)", () => {
  const noStats = campaignSentHoursAgo(72, { id: 1, statistics: {} });
  const withStats = campaignSentHoursAgo(72, {
    id: 2,
    statistics: statsFor({ sent: 100, delivered: 99, uniqueViews: 20 }),
  });
  const health = aggregateHealth([noStats, withStats]);
  assert.equal(health.sent, 100);
});

function mkHealth(overrides: Partial<HealthAggregate>): HealthAggregate {
  return { openRate: 20, bounceRate: 0.5, spamRate: 0.01, unsubRate: 0.1, delivered: 1000, sent: 1000, ...overrides };
}

test("decideSemaphore — abertura: fronteiras 14%/11%", () => {
  assert.equal(decideSemaphore(mkHealth({ openRate: 14 })), "green");
  assert.equal(decideSemaphore(mkHealth({ openRate: 13.9 })), "yellow");
  assert.equal(decideSemaphore(mkHealth({ openRate: 11 })), "yellow");
  assert.equal(decideSemaphore(mkHealth({ openRate: 10.9 })), "red");
});

test("decideSemaphore — bounce: fronteiras 1,5%/2,5%", () => {
  assert.equal(decideSemaphore(mkHealth({ bounceRate: 1.49 })), "green");
  assert.equal(decideSemaphore(mkHealth({ bounceRate: 1.5 })), "yellow");
  assert.equal(decideSemaphore(mkHealth({ bounceRate: 2.49 })), "yellow");
  assert.equal(decideSemaphore(mkHealth({ bounceRate: 2.5 })), "red");
});

test("decideSemaphore — spam: fronteiras 0,05%/0,1%", () => {
  assert.equal(decideSemaphore(mkHealth({ spamRate: 0.049 })), "green");
  assert.equal(decideSemaphore(mkHealth({ spamRate: 0.05 })), "yellow");
  assert.equal(decideSemaphore(mkHealth({ spamRate: 0.099 })), "yellow");
  assert.equal(decideSemaphore(mkHealth({ spamRate: 0.1 })), "red");
});

test("decideSemaphore — unsub: fronteiras 0,4%/0,7%", () => {
  assert.equal(decideSemaphore(mkHealth({ unsubRate: 0.39 })), "green");
  assert.equal(decideSemaphore(mkHealth({ unsubRate: 0.4 })), "yellow");
  assert.equal(decideSemaphore(mkHealth({ unsubRate: 0.69 })), "yellow");
  assert.equal(decideSemaphore(mkHealth({ unsubRate: 0.7 })), "red");
});

test("decideSemaphore — pior métrica manda (1 vermelha entre 4 verdes → vermelho)", () => {
  const health = mkHealth({ openRate: 30, bounceRate: 0.1, spamRate: 0.01, unsubRate: 0.1 });
  assert.equal(decideSemaphore(health), "green");
  const withOneRed = { ...health, spamRate: 0.2 };
  assert.equal(decideSemaphore(withOneRed), "red");
});

test("decideSemaphore — thresholds customizados são respeitados", () => {
  const custom = { ...DEFAULT_HEALTH_THRESHOLDS, openRate: { green: 50, yellow: 40 } };
  assert.equal(decideSemaphore(mkHealth({ openRate: 45 }), custom), "yellow");
});

test("computeWeekPlan — verde escalona +7% composto ter/sex/dom", () => {
  const plan = computeWeekPlan(1000, "green", 0.07);
  assert.equal(plan.semaphore, "green");
  assert.equal(plan.flagged, false);
  assert.equal(plan.volumes[0], Math.round(1000 * 1.07));
  assert.equal(plan.volumes[1], Math.round(1000 * 1.07 ** 2));
  assert.equal(plan.volumes[2], Math.round(1000 * 1.07 ** 3));
  // estritamente crescente
  assert.ok(plan.volumes[0] < plan.volumes[1]);
  assert.ok(plan.volumes[1] < plan.volumes[2]);
});

test("computeWeekPlan — amarelo repete o volume-base nos 3 dias", () => {
  const plan = computeWeekPlan(1000, "yellow");
  assert.deepEqual(plan.volumes, [1000, 1000, 1000]);
  assert.equal(plan.flagged, false);
});

test("computeWeekPlan — vermelho corta 30% e sinaliza flagged", () => {
  const plan = computeWeekPlan(1000, "red");
  assert.deepEqual(plan.volumes, [700, 700, 700]);
  assert.equal(plan.flagged, true);
  assert.equal(plan.semaphore, "red");
});

test("render — só envios <48h → 'aguardando maturar', sem semáforo vermelho falso (regressão)", () => {
  // Reproduz o caso real: os únicos envios recentes (sáb/dom) ainda têm <48h.
  const camps = [campaignSentHoursAgo(12), campaignSentHoursAgo(36)];
  const html = renderWeeklyPlanTabPanel(camps, NOW);
  assert.match(html, /aguardando maturar/i);
  // NÃO pode virar 🔴 (agregado de amostra vazia daria abertura 0%)
  assert.doesNotMatch(html, /Vermelho/);
});

test("render — envio maduro (>48h) → semáforo + plano aparecem (sem diferenciar cold/quente)", () => {
  const camps = [
    campaignSentHoursAgo(60, {
      statistics: statsFor({ sent: 1000, delivered: 990, uniqueViews: 160 }),
    }),
  ];
  const html = renderWeeklyPlanTabPanel(camps, NOW);
  assert.doesNotMatch(html, /aguardando maturar/i);
  assert.match(html, /Verde|Amarelo|Vermelho/);
});

test("classifyMetric — fronteiras (higher=abertura; lower=bounce/spam/unsub)", () => {
  // higher: maior é melhor
  assert.equal(classifyMetric(14, { green: 14, yellow: 11 }, "higher"), "green");
  assert.equal(classifyMetric(13.9, { green: 14, yellow: 11 }, "higher"), "yellow");
  assert.equal(classifyMetric(10.9, { green: 14, yellow: 11 }, "higher"), "red");
  // lower: menor é melhor (ex unsub 0,4/0,7)
  assert.equal(classifyMetric(0.39, { green: 0.4, yellow: 0.7 }, "lower"), "green");
  assert.equal(classifyMetric(0.5, { green: 0.4, yellow: 0.7 }, "lower"), "yellow");
  assert.equal(classifyMetric(2.1, { green: 0.4, yellow: 0.7 }, "lower"), "red"); // caso real: unsub engajado
});

test("render — mostra coluna de Alvo + colore o valor (verde/vermelho) por métrica", () => {
  // abertura alta (verde) + unsub alto (vermelho, como o caso real do engajado)
  const camps = [
    campaignSentHoursAgo(60, {
      statistics: statsFor({ sent: 1000, delivered: 990, uniqueViews: 270, unsubscriptions: 21 }),
    }),
  ];
  const html = renderWeeklyPlanTabPanel(camps, NOW);
  assert.match(html, /Alvo/); // coluna de alvo presente
  assert.match(html, /#158a4a/); // valor verde (abertura 27%)
  assert.match(html, /#c0392b/); // valor vermelho (unsub 2,1%)
  assert.match(html, /PIOR métrica/); // explica o critério do semáforo
});

test("saúde = últimos 10 MADUROS (amostra por contagem, não janela de tempo)", () => {
  // 12 envios maduros → só os 10 mais recentes entram no agregado incluído.
  const camps = Array.from({ length: 12 }, (_, i) =>
    campaignSentHoursAgo(72 + i * 24, {
      id: i + 1,
      statistics: statsFor({ sent: 500, delivered: 495, uniqueViews: 80 }),
    }),
  );
  const html = renderWeeklyPlanTabPanel(camps, NOW);
  assert.match(html, /10 envios maduros/); // rótulo do agregado
});

test("baseVolumeFromLastSendDay — soma células A/B/C do último dia BRT (não pega 1 só)", () => {
  const mk = (id: number, sentDate: string, sent: number): BrevoCampaign =>
    campaignSentHoursAgo(0, { id, sentDate, statistics: statsFor({ sent, delivered: sent, uniqueViews: 0 }) });
  // 3 células no mesmo domingo BRT + 1 envio de terça (dia anterior, menor).
  const camps = [
    mk(1, "2026-07-05T09:00:00Z", 600), // dom
    mk(2, "2026-07-05T09:00:00Z", 620), // dom (mesma data)
    mk(3, "2026-07-05T09:05:00Z", 610), // dom (mesma data, minuto diferente)
    mk(4, "2026-06-30T09:00:00Z", 500), // ter anterior — não deve entrar
  ];
  // soma das 3 do último dia = 600+620+610 = 1830 (não 610 de uma célula só)
  assert.equal(baseVolumeFromLastSendDay(camps), 1830);
});

test("baseVolumeFromLastSendDay — vazio retorna 0", () => {
  assert.equal(baseVolumeFromLastSendDay([]), 0);
});
