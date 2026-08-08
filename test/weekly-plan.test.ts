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
  classifySpamSignal,
  resolveSpamSignal,
  POSTMASTER_STALE_MS,
  POSTMASTER_DATA_STALE_MS,
  POSTMASTER_MIN_COVERAGE_RATIO,
  computeWeekPlan,
  renderWeeklyPlanTabPanel,
  renderHealthSection,
  renderRecommendationSection,
  baseVolumeFromLastSendDay,
  groupByBrtDay,
  selectMatureDayCampaigns,
  DEFAULT_HEALTH_THRESHOLDS,
  MATURATION_MS,
  type HealthAggregate,
  type SpamSignal,
} from "../workers/brevo-dashboard/src/index.ts";
import type { BrevoCampaign, PostmasterSpamEntry } from "../workers/brevo-dashboard/src/index.ts";

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
  assert.deepEqual(health, {
    openRate: 0,
    hardBounceRate: 0,
    bounceRate: 0,
    spamRate: 0,
    unsubRate: 0,
    delivered: 0,
    sent: 0,
  });
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

// Defaults todos VERDE sob os limites do doc — cada teste isola 1 métrica.
// #4063: `spamRate` (derivado de `complaints` da Brevo) permanece no shape
// pra `aggregateHealth`/exibição, mas NÃO alimenta mais `decideSemaphore`
// (que passou a receber um `SpamSignal` — leitura manual do Postmaster —
// como 2º argumento obrigatório). Mantido aqui só por retrocompat estrutural.
function mkHealth(overrides: Partial<HealthAggregate>): HealthAggregate {
  return {
    openRate: 20,
    hardBounceRate: 0.5,
    bounceRate: 1,
    spamRate: 0.01,
    unsubRate: 0.5,
    delivered: 1000,
    sent: 1000,
    ...overrides,
  };
}

// #4063: sinal de spam "confiável e limpo" — usado nos testes que isolam
// OUTRA métrica (abertura/bounce/unsub), pra não deixar o spam (agora
// indeterminado por padrão, ver bloco de testes dedicado abaixo) confundir
// o resultado.
function mkSpamOk(): SpamSignal {
  return { source: "postmaster", ratePct: 0.01, breach: false };
}

// Limites = circuit breakers do doc "Parceria Clarice × Diar.ia" (🔴 = breaker):
// abertura <15 · hard ≥2 · total ≥5 · spam ≥0,1 · unsub ≥3.
test("decideSemaphore — abertura: 🔴 <15%, 🟡 15-17, 🟢 ≥17", () => {
  assert.equal(decideSemaphore(mkHealth({ openRate: 17 }), mkSpamOk()), "green");
  assert.equal(decideSemaphore(mkHealth({ openRate: 16.9 }), mkSpamOk()), "yellow");
  assert.equal(decideSemaphore(mkHealth({ openRate: 15 }), mkSpamOk()), "yellow");
  assert.equal(decideSemaphore(mkHealth({ openRate: 14.9 }), mkSpamOk()), "red");
});

test("decideSemaphore — hard bounce: 🔴 ≥2%, 🟡 1,5-2, 🟢 <1,5", () => {
  assert.equal(decideSemaphore(mkHealth({ hardBounceRate: 1.49 }), mkSpamOk()), "green");
  assert.equal(decideSemaphore(mkHealth({ hardBounceRate: 1.5 }), mkSpamOk()), "yellow");
  assert.equal(decideSemaphore(mkHealth({ hardBounceRate: 1.99 }), mkSpamOk()), "yellow");
  assert.equal(decideSemaphore(mkHealth({ hardBounceRate: 2 }), mkSpamOk()), "red");
});

test("decideSemaphore — bounce total: 🔴 ≥5%, 🟡 4-5, 🟢 <4", () => {
  assert.equal(decideSemaphore(mkHealth({ bounceRate: 3.99 }), mkSpamOk()), "green");
  assert.equal(decideSemaphore(mkHealth({ bounceRate: 4 }), mkSpamOk()), "yellow");
  assert.equal(decideSemaphore(mkHealth({ bounceRate: 4.99 }), mkSpamOk()), "yellow");
  assert.equal(decideSemaphore(mkHealth({ bounceRate: 5 }), mkSpamOk()), "red");
});

test("decideSemaphore — unsub: 🔴 ≥3%, 🟡 2-3, 🟢 <2", () => {
  assert.equal(decideSemaphore(mkHealth({ unsubRate: 1.99 }), mkSpamOk()), "green");
  assert.equal(decideSemaphore(mkHealth({ unsubRate: 2 }), mkSpamOk()), "yellow");
  assert.equal(decideSemaphore(mkHealth({ unsubRate: 2.99 }), mkSpamOk()), "yellow");
  assert.equal(decideSemaphore(mkHealth({ unsubRate: 3 }), mkSpamOk()), "red");
});

// #4063: o breaker de spam NÃO lê mais `health.spamRate` (Brevo/`complaints`,
// que subconta o spam real em ~50×) — lê o `SpamSignal` resolvido a partir da
// leitura MANUAL do Postmaster (`resolveSpamSignal`). `classifySpamSignal` é a
// função que decide a cor desse sinal especificamente.
test("classifySpamSignal — indeterminado (sem leitura de Postmaster) NUNCA é verde — é sempre 🟡 (#4063)", () => {
  const indeterminate: SpamSignal = { source: "indeterminate", ratePct: null, breach: false };
  assert.equal(classifySpamSignal(indeterminate), "yellow");
});

test("classifySpamSignal — com leitura do Postmaster, aplica as mesmas 3 faixas dos limiares oficiais do Postmaster Tools (#4154): 🔴 ≥0,3%, 🟡 0,1-0,3, 🟢 <0,1", () => {
  assert.equal(classifySpamSignal({ source: "postmaster", ratePct: 0.099, breach: false }), "green");
  assert.equal(classifySpamSignal({ source: "postmaster", ratePct: 0.1, breach: false }), "yellow");
  assert.equal(classifySpamSignal({ source: "postmaster", ratePct: 0.299, breach: false }), "yellow");
  assert.equal(classifySpamSignal({ source: "postmaster", ratePct: 0.3, breach: true }), "red");
});

test("decideSemaphore — spam indeterminado (sem leitura Postmaster) nunca deixa o semáforo geral verde, mesmo com tudo mais saudável (#4063, regressão da issue)", () => {
  const indeterminate: SpamSignal = { source: "indeterminate", ratePct: null, breach: false };
  // health "tudo verde" (mkHealth default) + spam indeterminado → geral é 🟡,
  // nunca 🟢. Isso é o próprio bug relatado: o dashboard mostrava 🟢 com
  // ~0,02% de complaints da Brevo enquanto o Postmaster media ~1,0%.
  assert.equal(decideSemaphore(mkHealth({}), indeterminate), "yellow");
});

test("decideSemaphore — spam via Postmaster acima do limite BLOQUEIA o semáforo (vermelho) mesmo com `health.spamRate` (Brevo/complaints) em ZERO (#633, regressão exigida pela issue #4063)", () => {
  // Reproduz o caso real da issue: Brevo reporta ~0,02%/0 reclamações
  // enquanto o Postmaster mede ~1,0-1,5%. O breaker precisa travar no
  // vermelho usando o dado do Postmaster, INDEPENDENTE do que a Brevo diz.
  const health = mkHealth({ spamRate: 0 }); // Brevo: 0 complaints
  const postmasterBreach: SpamSignal = { source: "postmaster", ratePct: 1.02, breach: true };
  assert.equal(decideSemaphore(health, postmasterBreach), "red");
});

test("decideSemaphore — pior métrica manda (1 vermelha entre verdes → vermelho)", () => {
  assert.equal(decideSemaphore(mkHealth({}), mkSpamOk()), "green");
  assert.equal(
    decideSemaphore(mkHealth({}), { source: "postmaster", ratePct: 0.35, breach: true }),
    "red",
  );
});

test("decideSemaphore — thresholds customizados são respeitados", () => {
  const custom = { ...DEFAULT_HEALTH_THRESHOLDS, openRate: { green: 50, yellow: 40 } };
  assert.equal(decideSemaphore(mkHealth({ openRate: 45 }), mkSpamOk(), custom), "yellow");
});

test("computeWeekPlan — verde escalona +10% composto ter/sex/dom", () => {
  const plan = computeWeekPlan(1000, "green", 0.1);
  assert.equal(plan.semaphore, "green");
  assert.equal(plan.flagged, false);
  assert.equal(plan.volumes[0], Math.round(1000 * 1.1));
  assert.equal(plan.volumes[1], Math.round(1000 * 1.1 ** 2));
  assert.equal(plan.volumes[2], Math.round(1000 * 1.1 ** 3));
  // estritamente crescente
  assert.ok(plan.volumes[0] < plan.volumes[1]);
  assert.ok(plan.volumes[1] < plan.volumes[2]);
});

test("computeWeekPlan — default step é +10% (DEFAULT_WEEK_STEP)", () => {
  const plan = computeWeekPlan(1000, "green");
  assert.equal(plan.volumes[0], Math.round(1000 * 1.1));
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

// #4400: a linha "Spam (Brevo)" voltou ao default de 2 casas decimais, igual
// às outras 4 linhas da tabela (Abertura/Hard bounce/Bounce total/Unsub) —
// reverte a exceção de 3 casas do #3081 (que só fazia sentido comparada às
// outras tabelas do dashboard, não a esta). A linha "Spam (Postmaster)", que
// governa o semáforo, continua em 3 casas (ver teste dedicado mais abaixo).
test("#4400: Spam (Brevo) mostra o valor com 2 casas decimais (mesmo default das outras linhas)", () => {
  const camps = [
    campaignSentHoursAgo(60, {
      statistics: statsFor({ sent: 3000, delivered: 2990, uniqueViews: 600, complaints: 1 }),
    }),
  ];
  const html = renderWeeklyPlanTabPanel(camps, NOW);
  // spamRate = 1/3000 = 0.0333...% → 0.03% com 2 casas
  const spamBrevoRow = html.match(/<tr><td>Spam \(Brevo\)[\s\S]*?<\/tr>/)?.[0];
  assert.ok(spamBrevoRow, "deve haver a linha 'Spam (Brevo)' na tabela de métricas de saúde");
  assert.match(spamBrevoRow!, />0\.03%</, "spam (Brevo) deve aparecer com 2 casas decimais");
});

// #3081 (achado relacionado, mesma classe do fix de pct() denom-0 → "—" em
// render-links.ts): health.spamRate cai em 0 (não "—") quando health.sent===0
// — "0.000%" afirma falsamente "spam zero confirmado" quando na verdade não
// há stats válidas. Reachable quando existe envio MADURO (>48h, então
// `renderWeeklyPlanTabPanel` não cai no branch "nenhum envio maduro") mas
// SEM stats reais — `pickStats` retorna null (sent=0 tanto em globalStats
// quanto sem campaignStats), então `aggregateHealth` pula a campanha e todos
// os agregados (incluindo `sent`) ficam em 0.
test("#3081: Hard bounce/Bounce total/Spam/Unsub mostram '—' (não '0.0%'/'0.000%') quando há envio maduro mas sem stats válidas (sent=0)", () => {
  const noStatsMature = campaignSentHoursAgo(72, {
    id: 1,
    statistics: statsFor({ sent: 0, delivered: 0, uniqueViews: 0 }),
  });
  const html = renderWeeklyPlanTabPanel([noStatsMature], NOW);
  // Confirma que passamos pelo branch da tabela de métricas, não pelo stub
  // "nenhum envio maduro" (que teria mature.length === 0).
  assert.doesNotMatch(html, /Nenhum envio.*maduro/, "deve ter mature.length > 0 (o próprio sentDate já garante isso)");

  // #3081 (achado do code-review low no PR #3166): a checagem de "sem dado"
  // é POR MÉTRICA (todas as 3 que dividem por `sent`), não só Spam — Hard
  // bounce/Bounce total/Unsub compartilham o MESMO health.sent === 0.
  for (const label of ["Hard bounce", "Bounce total", "Unsub"]) {
    const row = html.match(new RegExp(`<tr><td>${label}</td>[\\s\\S]*?</tr>`))?.[0];
    assert.ok(row, `deve haver linha '${label}' na tabela de métricas de saúde`);
    assert.match(row!, /—/, `${label} deve mostrar '—' (sem dado) quando sent=0`);
    assert.doesNotMatch(row!, /0\.0{1,3}%/, `${label} não deve afirmar falsamente uma taxa zero confirmada quando não há stats`);
    // #3081 (achado do code-review low): "—" não deve ficar colorido como um
    // valor de status real (verde/amarelo/vermelho) — sem dado não é "saudável".
    assert.doesNotMatch(row!, /color:#(0E6B39|8A6100|C00000)/i,
      `${label} com '—' não deve usar as cores de status (green/yellow/red) — contradiria o texto 'sem dado'`);
  }

  // #4063: a linha "Spam" original (Brevo/complaints) ganhou rótulo explícito
  // e NUNCA mais é colorida como verde/vermelho (subconta o spam real em
  // ~50×) — nem mesmo quando `sent===0` (que já era neutro antes) nem quando
  // há dado real (comportamento novo, testado no bloco `buildMetricRows`
  // abaixo). A linha "Spam (Postmaster...)" — a que GOVERNA — mostra "sem
  // leitura" (nenhuma foi passada a `renderWeeklyPlanTabPanel` neste teste).
  const spamBrevoRow = html.match(/<tr><td>Spam \(Brevo[\s\S]*?<\/tr>/)?.[0];
  assert.ok(spamBrevoRow, "deve haver a linha 'Spam (Brevo...)' na tabela de métricas de saúde");
  assert.match(spamBrevoRow!, /—/, "Spam (Brevo) deve mostrar '—' quando sent=0");
  assert.doesNotMatch(spamBrevoRow!, /color:#(0E6B39|8A6100|C00000)/i, "Spam (Brevo) nunca deve usar cores de status (#4063)");

  const spamPostmasterRow = html.match(/<tr><td>Spam \(Postmaster[\s\S]*?<\/tr>/)?.[0];
  assert.ok(spamPostmasterRow, "deve haver a linha 'Spam (Postmaster...)' na tabela de métricas de saúde");
  assert.match(spamPostmasterRow!, /sem leitura/, "Spam (Postmaster) deve indicar 'sem leitura' quando nenhuma foi fornecida");
  assert.doesNotMatch(spamPostmasterRow!, /color:#(0E6B39|8A6100|C00000)/i, "Spam (Postmaster) sem leitura não deve usar cores de status (#4063)");
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
  // abertura alta (verde) + unsub acima do breaker de 3% (vermelho)
  const camps = [
    campaignSentHoursAgo(60, {
      statistics: statsFor({ sent: 1000, delivered: 990, uniqueViews: 270, unsubscriptions: 31 }),
    }),
  ];
  const html = renderWeeklyPlanTabPanel(camps, NOW);
  // #3092: emoji semafórico ganhou role="img" + aria-label (a11y) — o texto
  // "Alvo" e o emoji não ficam mais adjacentes sem marcação entre eles.
  assert.match(html, /Alvo <span role="img" aria-label="verde">🟢<\/span>/); // coluna de alvo verde presente
  assert.match(html, /Alvo <span role="img" aria-label="amarelo">🟡<\/span>/); // coluna de alvo amarelo presente
  assert.doesNotMatch(html, /<th>Status<\/th>/); // coluna Status removida
  assert.match(html, /#0E6B39/); // valor verde (abertura 27%) — #3087: consolidado com STATUS_COLOR
  assert.match(html, /#C00000/); // valor vermelho (unsub 3,1% ≥ breaker 3%) — #3087: agora = DS.alert
  assert.match(html, /PIOR métrica/); // explica o critério do semáforo
});

test("render — aba renomeada para Agendamento (sem parentético no plano)", () => {
  const camps = [
    campaignSentHoursAgo(60, {
      statistics: statsFor({ sent: 1000, delivered: 990, uniqueViews: 160 }),
    }),
  ];
  const html = renderWeeklyPlanTabPanel(camps, NOW);
  assert.match(html, /Agendamento — plano de envio semanal/);
  assert.match(html, /<h3>Recomendação — próximos 3 envios<\/h3>/);
  // rótulos relativos (sem data fixa) + total dos 3 envios
  assert.match(html, /Próximo envio/);
  assert.match(html, /2º envio/);
  assert.match(html, /3º envio/);
  assert.match(html, /Total \(3 envios\)/);
  assert.doesNotMatch(html, /Terça|Sexta|Domingo/);
});

test("render — scheduledSection (#2251) aparece logo abaixo da recomendação, dentro da aba Agendamento (#3010)", () => {
  const camps = [
    campaignSentHoursAgo(60, {
      statistics: statsFor({ sent: 1000, delivered: 990, uniqueViews: 160 }),
    }),
  ];
  const scheduled = [{
    id: 200,
    name: "Clarice News 2605 d02-A (qua)",
    subject: "Test",
    status: "queued",
    sentDate: null,
    scheduledAt: "2026-07-15T09:00:00Z",
    createdAt: "2026-07-14T00:00:00Z",
    recipients: { lists: [1] },
    listName: "T1-W2",
    listSize: 500,
  }];
  const html = renderWeeklyPlanTabPanel(camps, NOW, scheduled as any);
  assert.match(html, /id="scheduled-campaigns"/, "scheduled-campaigns deve renderizar quando `scheduled` é passado");
  const idxRecomendacao = html.indexOf("Recomendação — próximos 3 envios");
  const idxScheduled = html.indexOf('id="scheduled-campaigns"');
  assert.ok(idxRecomendacao >= 0 && idxScheduled > idxRecomendacao, "scheduled-campaigns deve vir depois da recomendação");
});

test("render — sem `scheduled` (default []), scheduledSection não aparece (compat retroativa)", () => {
  const camps = [
    campaignSentHoursAgo(60, {
      statistics: statsFor({ sent: 1000, delivered: 990, uniqueViews: 160 }),
    }),
  ];
  const html = renderWeeklyPlanTabPanel(camps, NOW);
  assert.doesNotMatch(html, /id="scheduled-campaigns"/);
});

test("deriveEditionName — formato DIÁRIO 'd01-A' não vaza o sufixo de célula na Edição (#2983)", () => {
  // bug do review: nome cold diário "Clarice News 2607 d01-A (ter)" — o "-A"
  // vazava pra coluna Edição. Deve virar "Clarice News 2607 d01" (sem célula).
  const daily = [
    campaignSentHoursAgo(60, { id: 1, name: "Clarice News 2607 d01-A (ter)", statistics: statsFor({ sent: 200, delivered: 198, uniqueViews: 40 }) }),
    campaignSentHoursAgo(60, { id: 2, name: "Clarice News 2607 d01-B (ter)", statistics: statsFor({ sent: 200, delivered: 198, uniqueViews: 40 }) }),
  ];
  const html = renderWeeklyPlanTabPanel(daily, NOW);
  assert.match(html, /Clarice News 2607 d01</);
  assert.doesNotMatch(html, /d01-A|d01-B/); // sufixo de célula não vaza
});

test("render — detalhes agrupados por DIA (dia A/B/C vira 1 linha somando o sent)", () => {
  const abcDay = [
    campaignSentHoursAgo(60, { id: 1, name: "Clarice News 2607-01 — A · ter", statistics: statsFor({ sent: 300, delivered: 297, uniqueViews: 60 }) }),
    campaignSentHoursAgo(60, { id: 2, name: "Clarice News 2607-01 — B · ter", statistics: statsFor({ sent: 300, delivered: 297, uniqueViews: 60 }) }),
    campaignSentHoursAgo(60, { id: 3, name: "Clarice News 2607-01 — C · ter", statistics: statsFor({ sent: 300, delivered: 297, uniqueViews: 60 }) }),
  ];
  const html = renderWeeklyPlanTabPanel(abcDay, NOW);
  // 1 linha só pro dia, com o nome limpo (sem sufixo de célula) e soma dos sent (900).
  assert.match(html, /Clarice News 2607-01/);
  assert.doesNotMatch(html, /2607-01 — A/);
  assert.match(html, /900/);
  assert.match(html, /Dias de envio incluídos no agregado \(1\)/);
});

test("saúde = últimos 10 DIAS maduros (amostra por dia, não por campanha)", () => {
  // 12 dias de envio maduros → só os 10 dias mais recentes entram no agregado.
  const camps = Array.from({ length: 12 }, (_, i) =>
    campaignSentHoursAgo(72 + i * 24, {
      id: i + 1,
      statistics: statsFor({ sent: 500, delivered: 495, uniqueViews: 80 }),
    }),
  );
  const html = renderWeeklyPlanTabPanel(camps, NOW);
  assert.match(html, /10 envios maduros/); // rótulo do agregado (10 campanhas = 10 dias aqui)
});

test("agregado por DIA: 11 dias de envio → só os 10 mais recentes contam; dia A/B/C (3 campanhas) = 1 dia", () => {
  // 11 dias distintos, 1 campanha por dia (dias 0..10, 0 = mais recente).
  const singleDayCamps = Array.from({ length: 11 }, (_, i) =>
    campaignSentHoursAgo(72 + i * 24, {
      id: i + 1,
      statistics: statsFor({ sent: 100, delivered: 99, uniqueViews: 20 }),
    }),
  );
  const html1 = renderWeeklyPlanTabPanel(singleDayCamps, NOW);
  // 11 dias disponíveis, mas só 10 entram no agregado (o 11º — mais antigo — fica de fora).
  assert.match(html1, /10 envios maduros/);

  // Um dia de teste A/B/C (3 campanhas no MESMO dia) deve contar como 1 dia,
  // não consumir 3 vagas da amostra de 10 dias.
  const abcDay = [
    campaignSentHoursAgo(72, { id: 101, name: "Clarice News 2607-01 — A · ter", statistics: statsFor({ sent: 100, delivered: 99, uniqueViews: 20 }) }),
    campaignSentHoursAgo(72, { id: 102, name: "Clarice News 2607-01 — B · ter", statistics: statsFor({ sent: 100, delivered: 99, uniqueViews: 20 }) }),
    campaignSentHoursAgo(72, { id: 103, name: "Clarice News 2607-01 — C · ter", statistics: statsFor({ sent: 100, delivered: 99, uniqueViews: 20 }) }),
  ];
  const restOfDays = Array.from({ length: 9 }, (_, i) =>
    campaignSentHoursAgo(96 + i * 24, {
      id: 200 + i,
      statistics: statsFor({ sent: 100, delivered: 99, uniqueViews: 20 }),
    }),
  );
  const html2 = renderWeeklyPlanTabPanel([...abcDay, ...restOfDays], NOW);
  // 3 campanhas do dia A/B/C + 9 dias restantes = 12 campanhas maduras, mas só 10 DIAS (1 + 9).
  assert.match(html2, /12 envios maduros/); // todas as campanhas dos 10 dias selecionados entram
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

// #2992 — fronteira das 48h pode rachar um dia A/B/C entre incluído/excluído.
test("groupByBrtDay — agrupa campanhas em dias distintos corretamente", () => {
  const camps = [
    campaignSentHoursAgo(10, { id: 1, sentDate: "2026-07-08T12:00:00.000Z" }),
    campaignSentHoursAgo(10, { id: 2, sentDate: "2026-07-08T13:00:00.000Z" }),
    campaignSentHoursAgo(10, { id: 3, sentDate: "2026-07-09T12:00:00.000Z" }),
    campaignSentHoursAgo(10, { id: 4, sentDate: null }),
  ];
  const grouped = groupByBrtDay(camps);
  assert.equal(grouped.size, 2);
  assert.deepEqual(
    [...(grouped.get("2026-07-08")?.map((c) => c.id) ?? [])].sort(),
    [1, 2],
  );
  assert.deepEqual(
    [...(grouped.get("2026-07-09")?.map((c) => c.id) ?? [])].sort(),
    [3],
  );
});

test("selectMatureDayCampaigns — dia A/B/C que racha a fronteira 48h fica ATÔMICO (todo excluído)", () => {
  // 3 células do mesmo dia BRT: 2 já maduras (>48h) e 1 ainda não (<48h) —
  // a célula MAIS RECENTE (47.5h) ainda não cruzou 48h, então o dia inteiro
  // deve ficar do lado IMATURO, mesmo que as outras 2 células já tenham >48h.
  const day = [
    campaignSentHoursAgo(47.5, { id: 1, name: "Clarice News 2607-08 — A · qua" }),
    campaignSentHoursAgo(48.2, { id: 2, name: "Clarice News 2607-08 — B · qua" }),
    campaignSentHoursAgo(48.5, { id: 3, name: "Clarice News 2607-08 — C · qua" }),
  ];
  const { mature, immature } = selectMatureDayCampaigns(day, NOW);
  assert.deepEqual(mature, []);
  assert.deepEqual(
    immature.map((c) => c.id).sort(),
    [1, 2, 3],
  );
});

test("selectMatureDayCampaigns — dia A/B/C onde a célula mais recente já passou de 48h fica ATÔMICO (todo incluído)", () => {
  const day = [
    campaignSentHoursAgo(48.1, { id: 1, name: "Clarice News 2607-08 — A · qua" }),
    campaignSentHoursAgo(49, { id: 2, name: "Clarice News 2607-08 — B · qua" }),
    campaignSentHoursAgo(50, { id: 3, name: "Clarice News 2607-08 — C · qua" }),
  ];
  const { mature, immature } = selectMatureDayCampaigns(day, NOW);
  assert.deepEqual(
    mature.map((c) => c.id).sort(),
    [1, 2, 3],
  );
  assert.deepEqual(immature, []);
});

test("render — dia A/B/C rachando a fronteira 48h aparece TODO em excluídos, nunca dividido (regressão #2992)", () => {
  const straddling = [
    campaignSentHoursAgo(47.5, {
      id: 1,
      name: "Clarice News 2607-08 — A · qua",
      statistics: statsFor({ sent: 100, delivered: 99, uniqueViews: 20 }),
    }),
    campaignSentHoursAgo(48.2, {
      id: 2,
      name: "Clarice News 2607-08 — B · qua",
      statistics: statsFor({ sent: 100, delivered: 99, uniqueViews: 20 }),
    }),
    campaignSentHoursAgo(48.5, {
      id: 3,
      name: "Clarice News 2607-08 — C · qua",
      statistics: statsFor({ sent: 100, delivered: 99, uniqueViews: 20 }),
    }),
  ];
  const html = renderWeeklyPlanTabPanel(straddling, NOW);
  // Nenhum envio maduro ainda (o dia inteiro fica do lado imaturo) — mensagem
  // de "aguardando maturar", e as 3 campanhas aparecem juntas na lista de espera.
  assert.match(html, /Nenhum envio.*maduro/);
  assert.match(html, /2607-08 — A/);
  assert.match(html, /2607-08 — B/);
  assert.match(html, /2607-08 — C/);
});

// ---------------------------------------------------------------------------
// #3415 — renderHealthSection/renderRecommendationSection: peças extraídas de
// renderWeeklyPlanTabPanel pro reorg Passado/Presente/Futuro da Visão Geral.
// Reusam computeWeeklySendState/buildMetricRows/describeSemaphore internos —
// cobertura aqui garante que a extração não divergiu do bundle completo.
// ---------------------------------------------------------------------------

test("renderHealthSection — título default é o mesmo da aba Agendamento; opts.title sobrescreve (#3415)", () => {
  const camps = [
    campaignSentHoursAgo(60, { statistics: statsFor({ sent: 1000, delivered: 990, uniqueViews: 160 }) }),
  ];
  const defaultHtml = renderHealthSection(camps, NOW);
  assert.match(defaultHtml, /Agendamento — plano de envio semanal/);

  const scopedHtml = renderHealthSection(camps, NOW, { title: "Saúde" });
  assert.match(scopedHtml, /<h2 class="section-title">Saúde<\/h2>/);
  assert.doesNotMatch(scopedHtml, /Agendamento — plano de envio semanal/);
});

test("renderHealthSection — mesmo semáforo/métricas do bundle completo pro mesmo input (#3415)", () => {
  const camps = [
    campaignSentHoursAgo(60, { statistics: statsFor({ sent: 1000, delivered: 990, uniqueViews: 270, unsubscriptions: 31 }) }),
  ];
  const bundle = renderWeeklyPlanTabPanel(camps, NOW);
  const health = renderHealthSection(camps, NOW, { title: "Saúde" });
  assert.match(health, /#0E6B39/); // mesmo verde (abertura 27%)
  assert.match(health, /#C00000/); // mesmo vermelho (unsub 3,1% ≥ breaker 3%)
  assert.match(bundle, /#0E6B39/);
  assert.match(bundle, /#C00000/);
  // não deve conter a recomendação/agendados/melhores-dias/accordions — só a
  // tabela de saúde (isso é o que diferencia da versão bundle).
  assert.doesNotMatch(health, /Recomendação — próximos 3 envios/);
  assert.doesNotMatch(health, /Dias de envio incluídos/);
});

test("renderHealthSection — sem envios registrados → mensagem neutra, id próprio (#3415)", () => {
  const html = renderHealthSection([], NOW, { title: "Saúde" });
  assert.match(html, /id="weekly-plan-health"/);
  assert.match(html, /Nenhum envio registrado/);
});

test("renderHealthSection — só envios <48h → 'aguardando maturar', sem semáforo (#3415)", () => {
  const camps = [campaignSentHoursAgo(12), campaignSentHoursAgo(36)];
  const html = renderHealthSection(camps, NOW, { title: "Saúde" });
  assert.match(html, /aguardando maturar/i);
  assert.doesNotMatch(html, /Verde|Amarelo|Vermelho/);
});

test("renderRecommendationSection — mesmo plano do bundle completo pro mesmo input (#3415)", () => {
  const camps = [
    campaignSentHoursAgo(60, { statistics: statsFor({ sent: 1000, delivered: 990, uniqueViews: 160 }) }),
  ];
  const bundle = renderWeeklyPlanTabPanel(camps, NOW);
  const recommendation = renderRecommendationSection(camps, NOW);
  assert.match(recommendation, /<h2 class="section-title">Recomendação — próximos 3 envios<\/h2>/);
  assert.match(recommendation, /id="weekly-plan-recommendation"/);
  // openRate = 160/990 ≈ 16,16% → Amarelo (entre 15 e 17) → plano repete o
  // volume-base (1000) nos 3 envios, sem crescer.
  assert.match(recommendation, /Próximo envio<\/td><td>1\.000/);
  assert.match(bundle, /Próximo envio<\/td><td>1\.000/);
  // não deve conter a tabela de saúde/agendados/melhores-dias — só a recomendação.
  assert.doesNotMatch(recommendation, /Alvo <span role="img"/);
  assert.doesNotMatch(recommendation, /id="scheduled-campaigns"/);
});

test("renderRecommendationSection — sem envio maduro → mensagem de indisponível, sem tabela (#3415)", () => {
  const camps = [campaignSentHoursAgo(12)];
  const html = renderRecommendationSection(camps, NOW);
  assert.match(html, /Sem envio maduro/);
  assert.doesNotMatch(html, /Próximo envio/);
});

test("renderRecommendationSection — zero campanhas → 'Nenhum envio registrado', NÃO 'Sem envio maduro' (#3426)", () => {
  const html = renderRecommendationSection([], NOW);
  assert.match(html, /Nenhum envio registrado/);
  assert.doesNotMatch(html, /Sem envio maduro/);
  assert.doesNotMatch(html, /Próximo envio/);
});

// #3431: 3º branch de renderRecommendationSection (mature.length > 0 mas
// baseVolume === 0, ou seja `!state.plan` sem cair nos 2 branches acima) não
// tinha teste dedicado — só o 1º branch (zero campanhas) foi coberto no
// #3426. Reproduz via envio MADURO (>48h) sem stats reais (sent=0), mesmo
// padrão do #3081: `pickStats` retorna null → baseVolumeFromLastSendDay
// soma 0, então `computeWeeklySendState` retorna `plan: null` mesmo com
// `mature.length > 0`.
test("renderRecommendationSection — envio maduro mas sem volume-base (baseVolume===0) → mensagem própria, NÃO 'Sem envio maduro' nem 'Nenhum envio registrado' (#3431)", () => {
  const camps = [
    campaignSentHoursAgo(72, { statistics: statsFor({ sent: 0, delivered: 0, uniqueViews: 0 }) }),
  ];
  const html = renderRecommendationSection(camps, NOW);
  assert.match(html, /Volume-base do último envio indisponível/);
  assert.doesNotMatch(html, /Sem envio maduro/);
  assert.doesNotMatch(html, /Nenhum envio registrado/);
  assert.doesNotMatch(html, /Próximo envio/);
});

// ---------------------------------------------------------------------------
// #4063 — resolveSpamSignal (leitura manual do Postmaster com precedência
// sobre `complaints`/spamRate da Brevo) + wiring fim-a-fim em
// renderWeeklyPlanTabPanel.
// ---------------------------------------------------------------------------

function mkPostmasterEntry(overrides: Partial<PostmasterSpamEntry> = {}): PostmasterSpamEntry {
  return {
    date: "2026-07-10",
    spamRatePct: 1.02,
    recordedAt: NOW.toISOString(),
    ...overrides,
  };
}

test("resolveSpamSignal — sem entrada (null/undefined) → indeterminate, nunca breach (#4063)", () => {
  assert.deepEqual(resolveSpamSignal(null, NOW), { source: "indeterminate", ratePct: null, breach: false, reason: "missing" });
  assert.deepEqual(resolveSpamSignal(undefined, NOW), { source: "indeterminate", ratePct: null, breach: false, reason: "missing" });
});

// #4544 (achado HIGH do fleet review): `reason` distingue as 5 causas de
// indeterminate — antes todas colapsavam no mesmo objeto, indistinguível na
// UI (só a entry crua do KV revelava a causa real, como no diagnóstico
// manual do incidente 260803).
test("resolveSpamSignal — reason distingue as 5 causas de indeterminate (#4544)", () => {
  assert.equal(resolveSpamSignal(null, NOW).reason, "missing");
  assert.equal(resolveSpamSignal(mkPostmasterEntry({ spamRatePct: NaN }), NOW).reason, "malformed");
  const staleRecordedAt = new Date(NOW.getTime() - POSTMASTER_STALE_MS - 1000).toISOString();
  assert.equal(resolveSpamSignal(mkPostmasterEntry({ recordedAt: staleRecordedAt }), NOW).reason, "recorded-stale");
  assert.equal(resolveSpamSignal(mkPostmasterEntry({ recordedAt: "não-é-data" }), NOW).reason, "recorded-stale");
  const staleDate = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal(resolveSpamSignal(mkPostmasterEntry({ date: staleDate }), NOW).reason, "date-stale");
  assert.equal(resolveSpamSignal(mkPostmasterEntry({ date: "não-é-data" }), NOW).reason, "date-stale");
  assert.equal(
    resolveSpamSignal(mkPostmasterEntry({ daysWithData: 1, daysProbed: 10 }), NOW).reason,
    "low-coverage",
  );
  // source==="postmaster" nunca popula reason.
  assert.equal(resolveSpamSignal(mkPostmasterEntry({}), NOW).reason, undefined);
});

test("resolveSpamSignal — entrada com spamRatePct acima do limite resolve breach=true (#633, regressão exigida pela issue #4063)", () => {
  // O ponto central da issue: um spamRate de Postmaster acima do limite
  // precisa travar o breaker MESMO que `complaints` da Brevo esteja em zero
  // — esta função nem recebe o dado da Brevo, então a garantia é estrutural.
  const signal = resolveSpamSignal(mkPostmasterEntry({ spamRatePct: 1.02 }), NOW);
  assert.equal(signal.source, "postmaster");
  assert.equal(signal.ratePct, 1.02);
  assert.equal(signal.breach, true);
});

test("resolveSpamSignal — entrada abaixo do limite resolve breach=false", () => {
  const signal = resolveSpamSignal(mkPostmasterEntry({ spamRatePct: 0.03 }), NOW);
  assert.equal(signal.source, "postmaster");
  assert.equal(signal.breach, false);
});

test("resolveSpamSignal — fronteira exata do breaker (0,3%, #4154) já é breach (>=)", () => {
  assert.equal(resolveSpamSignal(mkPostmasterEntry({ spamRatePct: 0.3 }), NOW).breach, true);
  assert.equal(resolveSpamSignal(mkPostmasterEntry({ spamRatePct: 0.299 }), NOW).breach, false);
});

test("resolveSpamSignal — repassa producedBy pro SpamSignal (#4154, achado do self-review do #4342)", () => {
  assert.equal(resolveSpamSignal(mkPostmasterEntry({ producedBy: "auto" }), NOW).producedBy, "auto");
  assert.equal(resolveSpamSignal(mkPostmasterEntry({ producedBy: "manual" }), NOW).producedBy, "manual");
  assert.equal(resolveSpamSignal(mkPostmasterEntry({}), NOW).producedBy, undefined);
});

test("resolveSpamSignal — leitura mais velha que POSTMASTER_STALE_MS (48h) volta a ser indeterminate", () => {
  const staleRecordedAt = new Date(NOW.getTime() - POSTMASTER_STALE_MS - 1000).toISOString();
  const signal = resolveSpamSignal(mkPostmasterEntry({ spamRatePct: 5, recordedAt: staleRecordedAt }), NOW);
  assert.deepEqual(signal, { source: "indeterminate", ratePct: null, breach: false, reason: "recorded-stale" });
});

test("resolveSpamSignal — leitura DENTRO da janela de 48h continua válida (fronteira)", () => {
  const freshRecordedAt = new Date(NOW.getTime() - POSTMASTER_STALE_MS + 1000).toISOString();
  const signal = resolveSpamSignal(mkPostmasterEntry({ spamRatePct: 5, recordedAt: freshRecordedAt }), NOW);
  assert.equal(signal.source, "postmaster");
});

test("resolveSpamSignal — spamRatePct não-finito (NaN/Infinity) ou recordedAt não-parseável → indeterminate", () => {
  assert.equal(resolveSpamSignal(mkPostmasterEntry({ spamRatePct: NaN }), NOW).source, "indeterminate");
  assert.equal(resolveSpamSignal(mkPostmasterEntry({ recordedAt: "não-é-data" }), NOW).source, "indeterminate");
});

// ---------------------------------------------------------------------------
// #4541 — resolveSpamSignal media frescor por `entry.date` (quando o dado foi
// MEDIDO), não só por `entry.recordedAt` (quando foi GRAVADO no KV). Bug real
// observado em 260803: postmaster-spam-sync.ts roda a cada 12h e reescreve a
// entry mesmo sem dia novo na janela, então `recordedAt` fica sempre fresco
// mesmo com uma medição de dias atrás — o guard de staleness original (só
// `recordedAt`) não pegava isso. Segunda causa somada na mesma issue: cobertura
// baixa da janela (ex: 1/10 dias por erro HTTP transitório) não deveria
// colorir nada — ver `daysWithData`/`daysProbed`.
// ---------------------------------------------------------------------------

test("resolveSpamSignal — recordedAt FRESCO mas date de 7 dias atrás → indeterminate, nunca 🟢 falso (#4541, regressão do incidente 260803)", () => {
  // Reproduz o estado exato do KV no incidente: gravado agora (recordedAt),
  // mas medindo um dia de 7 dias atrás (date) — a leitura de 27/07 carimbada
  // como fresca em 03/08.
  const staleDate = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const signal = resolveSpamSignal(
    mkPostmasterEntry({ spamRatePct: 0, date: staleDate, recordedAt: NOW.toISOString() }),
    NOW,
  );
  assert.deepEqual(signal, { source: "indeterminate", ratePct: null, breach: false, reason: "date-stale" });
});

// `entry.date` é YYYY-MM-DD (dia-calendário, sem hora) — parseado como
// meia-noite UTC. NOW é meio-dia UTC (2026-07-10T12:00), então o diff real
// contra uma data N dias-calendário atrás é sempre N dias + 12h (não N dias
// exatos) — os 2 testes de fronteira abaixo usam dias-calendário inteiros
// (não offsets de ms convertidos pra string) pra não cair nessa fuzz de
// truncamento e testar a fronteira real de POSTMASTER_DATA_STALE_MS (5 dias):
// 4 dias atrás = 4d12h (108h) < 120h → fresco; 5 dias atrás = 5d12h (132h) >
// 120h → stale.
test("resolveSpamSignal — date 4 dias-calendário atrás (dentro de POSTMASTER_DATA_STALE_MS) continua válido (fronteira)", () => {
  assert.equal(POSTMASTER_DATA_STALE_MS, 5 * 24 * 60 * 60 * 1000, "teste assume o limiar de 5 dias documentado — atualizar se mudar");
  const signal = resolveSpamSignal(mkPostmasterEntry({ spamRatePct: 0.05, date: "2026-07-06" }), NOW);
  assert.equal(signal.source, "postmaster");
});

test("resolveSpamSignal — date 5 dias-calendário atrás (além de POSTMASTER_DATA_STALE_MS) → indeterminate (fronteira)", () => {
  const signal = resolveSpamSignal(mkPostmasterEntry({ spamRatePct: 0.05, date: "2026-07-05" }), NOW);
  assert.equal(signal.source, "indeterminate");
});

test("resolveSpamSignal — date não-parseável → indeterminate", () => {
  assert.equal(resolveSpamSignal(mkPostmasterEntry({ date: "não-é-data" }), NOW).source, "indeterminate");
});

test("resolveSpamSignal — cobertura de 1/10 dias → indeterminate mesmo com date/recordedAt frescos (#4541, 2ª causa: erro HTTP transitório encolhendo a amostra)", () => {
  const signal = resolveSpamSignal(
    mkPostmasterEntry({ spamRatePct: 0, daysWithData: 1, daysProbed: 10 }),
    NOW,
  );
  assert.deepEqual(signal, { source: "indeterminate", ratePct: null, breach: false, reason: "low-coverage" });
});

test("resolveSpamSignal — cobertura >= POSTMASTER_MIN_COVERAGE_RATIO (ex: 5/10) resolve normalmente", () => {
  const signal = resolveSpamSignal(
    mkPostmasterEntry({ spamRatePct: 0.05, daysWithData: 5, daysProbed: 10 }),
    NOW,
  );
  assert.equal(signal.source, "postmaster");
});

test("resolveSpamSignal — cobertura abaixo do limiar mesmo em fração equivalente (ex: 2/5) → indeterminate", () => {
  assert.equal(POSTMASTER_MIN_COVERAGE_RATIO, 0.5, "teste assume o limiar de 50% documentado — atualizar se mudar");
  const signal = resolveSpamSignal(
    mkPostmasterEntry({ spamRatePct: 0.05, daysWithData: 2, daysProbed: 5 }),
    NOW,
  );
  assert.equal(signal.source, "indeterminate");
});

test("resolveSpamSignal — sem daysWithData/daysProbed (entry manual ou pré-#4541) NÃO aciona o guard de cobertura", () => {
  const signal = resolveSpamSignal(mkPostmasterEntry({ spamRatePct: 0.05, producedBy: "manual" }), NOW);
  assert.equal(signal.source, "postmaster");
});

// #4544 (achado convergente type-design-analyzer + silent-failure-hunter):
// `daysWithData`/`daysProbed` são optionals INDEPENDENTES — nada no tipo
// impede uma entry com só um dos dois. Documenta o comportamento ATUAL desse
// caso assimétrico (produtor corrompido/parcial, nunca deveria acontecer via
// `buildAveragedEntry`, que sempre grava os dois juntos — mas o tipo não
// GARANTE isso estruturalmente): o guard de cobertura simplesmente não
// dispara, igual ao caso "ambos ausentes" — direção ERRADA pra um sistema
// cujo design é "degradar quando em dúvida" (deveria arguably ser
// `low-coverage`/indeterminate, não `postmaster`), mas é o comportamento
// hoje. Se um reshape pra `coverage?: { daysWithData; daysProbed }` (que
// garantiria o pareamento estruturalmente) acontecer no futuro, este teste
// deve ser atualizado pra refletir o novo comportamento.
test("resolveSpamSignal — só daysWithData OU só daysProbed presente (assimétrico) NÃO aciona o guard de cobertura (comportamento atual, #4544)", () => {
  const onlyWithData = resolveSpamSignal(mkPostmasterEntry({ spamRatePct: 0.05, daysWithData: 1 }), NOW);
  assert.equal(onlyWithData.source, "postmaster");
  const onlyProbed = resolveSpamSignal(mkPostmasterEntry({ spamRatePct: 0.05, daysProbed: 10 }), NOW);
  assert.equal(onlyProbed.source, "postmaster");
});

// ---------------------------------------------------------------------------
// #4705 — resolveSpamSignal prefere o PICO por campanha (`worstCampaignSpamRatePct`)
// sobre a média de domínio (`spamRatePct`) quando presente. Cenário real que
// motivou a mudança (achado da issue): em 03/08/2026 a média de domínio ficou
// dentro do limite enquanto uma campanha específica teve spam bem mais alto —
// a média sozinha nunca revela isso, só o dado por-campanha.
// ---------------------------------------------------------------------------

test("resolveSpamSignal — pico de campanha ACIMA do limite produz breach=true MESMO com a média de domínio dentro do limite (#4705, regressão do cenário real da issue)", () => {
  // Média de domínio: 0,08% — dentro do limite (green < 0.1%, yellow < 0.3%).
  // Pico da campanha pior: 1,39% — bem acima do breaker (>= 0.3%).
  const signal = resolveSpamSignal(
    mkPostmasterEntry({
      spamRatePct: 0.08,
      worstCampaignSpamRatePct: 1.39,
      worstCampaignFeedbackLoopId: "11130585_107",
    }),
    NOW,
  );
  assert.equal(signal.source, "postmaster");
  assert.equal(signal.ratePct, 1.39, "usa o pico da campanha, não a média de domínio");
  assert.equal(signal.breach, true, "a média de domínio sozinha (0,08%) NÃO estouraria o breaker — só o pico por campanha revela o risco real");
});

test("resolveSpamSignal — sem worstCampaignSpamRatePct (schema evolution / sem campanha atribuível na janela) usa a média de domínio, comportamento anterior ao #4705", () => {
  const signal = resolveSpamSignal(mkPostmasterEntry({ spamRatePct: 0.05 }), NOW);
  assert.equal(signal.source, "postmaster");
  assert.equal(signal.ratePct, 0.05);
});

test("resolveSpamSignal — worstCampaignSpamRatePct não-finito (NaN/Infinity, payload corrompido) cai pro fallback de domínio, nunca propaga um valor inválido", () => {
  const signal = resolveSpamSignal(mkPostmasterEntry({ spamRatePct: 0.05, worstCampaignSpamRatePct: NaN }), NOW);
  assert.equal(signal.source, "postmaster");
  assert.equal(signal.ratePct, 0.05);
});

test("resolveSpamSignal — pico de campanha ABAIXO do limite produz breach=false (mesma faixa que a média, só a fonte do número muda)", () => {
  const signal = resolveSpamSignal(
    mkPostmasterEntry({ spamRatePct: 0.05, worstCampaignSpamRatePct: 0.05 }),
    NOW,
  );
  assert.equal(signal.breach, false);
});

test("resolveSpamSignal — guards de staleness/cobertura continuam avaliados sobre os campos de DOMÍNIO mesmo com worstCampaignSpamRatePct presente (#4705 preserva a lógica existente)", () => {
  const staleRecordedAt = new Date(NOW.getTime() - POSTMASTER_STALE_MS - 1000).toISOString();
  const signal = resolveSpamSignal(
    mkPostmasterEntry({ spamRatePct: 0.05, worstCampaignSpamRatePct: 1.39, recordedAt: staleRecordedAt }),
    NOW,
  );
  assert.deepEqual(signal, { source: "indeterminate", ratePct: null, breach: false, reason: "recorded-stale" });
});

test("renderWeeklyPlanTabPanel — com leitura de Postmaster acima do limite, semáforo geral é vermelho MESMO com tudo mais saudável e complaints da Brevo em zero (#4063 fim-a-fim)", () => {
  const camps = [
    campaignSentHoursAgo(60, {
      statistics: statsFor({ sent: 3000, delivered: 2990, uniqueViews: 600, complaints: 0 }),
    }),
  ];
  const html = renderWeeklyPlanTabPanel(camps, NOW, [], mkPostmasterEntry({ spamRatePct: 1.02 }));
  assert.match(html, /Vermelho/);
  // a linha que GOVERNA mostra o número do Postmaster, colorida como alerta.
  const spamPostmasterRow = html.match(/<tr><td>Spam \(Postmaster[\s\S]*?<\/tr>/)?.[0];
  assert.ok(spamPostmasterRow);
  assert.match(spamPostmasterRow!, /1\.020%/);
  assert.match(spamPostmasterRow!, /color:#C00000/i);
  // a linha da Brevo mostra o número de complaints (0%), mas NUNCA colorida —
  // não é mais autoridade nenhuma sobre o semáforo.
  const spamBrevoRow = html.match(/<tr><td>Spam \(Brevo[\s\S]*?<\/tr>/)?.[0];
  assert.ok(spamBrevoRow);
  assert.doesNotMatch(spamBrevoRow!, /color:#(0E6B39|8A6100|C00000)/i);
});

test("renderWeeklyPlanTabPanel — sem leitura de Postmaster, semáforo NUNCA é verde mesmo com tudo mais saudável (#4063 fim-a-fim, regressão do bug relatado)", () => {
  const camps = [
    campaignSentHoursAgo(60, {
      statistics: statsFor({ sent: 3000, delivered: 2990, uniqueViews: 600, complaints: 0 }),
    }),
  ];
  // Sem passar postmasterSpam (default null) — este é EXATAMENTE o cenário do
  // bug: abertura saudável (20%) e complaints da Brevo em 0 não bastam mais
  // pra colorir 🟢.
  const html = renderWeeklyPlanTabPanel(camps, NOW);
  assert.doesNotMatch(html, /Verde/);
  assert.match(html, /Amarelo/);
});

// #4544: a célula "— (sem leitura)" ganha um `title=` (tooltip, mesmo padrão
// de render-links.ts) com a causa ESPECÍFICA do indeterminate — sem isso, as
// 5 causas eram indistinguíveis na UI (incidente 260803 só foi diagnosticado
// puxando a entry crua do KV manualmente).
test("renderWeeklyPlanTabPanel — célula 'sem leitura' carrega title= com a causa específica do indeterminate (#4544)", () => {
  const camps = [
    campaignSentHoursAgo(60, { statistics: statsFor({ sent: 3000, delivered: 2990, uniqueViews: 600, complaints: 0 }) }),
  ];
  // sem postmasterSpam (default null) → reason "missing".
  const htmlMissing = renderWeeklyPlanTabPanel(camps, NOW);
  const rowMissing = htmlMissing.match(/<tr><td>Spam \(Postmaster[\s\S]*?<\/tr>/)?.[0];
  assert.ok(rowMissing);
  assert.match(rowMissing!, /title="Sem leitura gravada no KV/);

  // cobertura baixa → reason "low-coverage", texto diferente do "missing".
  const htmlLowCoverage = renderWeeklyPlanTabPanel(
    camps,
    NOW,
    [],
    mkPostmasterEntry({ spamRatePct: 0.05, daysWithData: 1, daysProbed: 10 }),
  );
  const rowLowCoverage = htmlLowCoverage.match(/<tr><td>Spam \(Postmaster[\s\S]*?<\/tr>/)?.[0];
  assert.ok(rowLowCoverage);
  assert.match(rowLowCoverage!, /title="Cobertura da janela/);

  // com leitura CONFIÁVEL (source==="postmaster"), sem title= nenhum — nunca
  // um tooltip de "causa de indeterminate" numa leitura válida.
  const htmlOk = renderWeeklyPlanTabPanel(camps, NOW, [], mkPostmasterEntry({ spamRatePct: 0.05 }));
  const rowOk = htmlOk.match(/<tr><td>Spam \(Postmaster[\s\S]*?<\/tr>/)?.[0];
  assert.ok(rowOk);
  assert.doesNotMatch(rowOk!, /title=/);
});

// #4400: o rótulo virou "Spam (Postmaster)" — ESTÁTICO em 2 sentidos: (1) não
// reflete mais `producedBy` (sufixo ", automático"/", manual" introduzido no
// #4154), e (2) também perdeu o sufixo fixo "— governa o semáforo" (pedido do
// editor era texto estático SIMPLES, não só remover a parte dinâmica).
// `producedBy` continua existindo em `SpamSignal`/`PostmasterSpamEntry`
// (testado em `resolveSpamSignal — repassa producedBy...` acima), só não
// afeta mais o rótulo renderizado — testado aqui com os 3 valores possíveis
// (auto, manual, ausente) pra garantir que nenhum deles vaza pro texto.
test("renderWeeklyPlanTabPanel — rótulo do Postmaster é estático 'Spam (Postmaster)', independente de producedBy", () => {
  const camps = [campaignSentHoursAgo(60, { statistics: statsFor({ sent: 3000, delivered: 2990, uniqueViews: 600 }) })];
  for (const producedBy of ["auto", "manual", undefined] as const) {
    const html = renderWeeklyPlanTabPanel(camps, NOW, [], mkPostmasterEntry(producedBy ? { producedBy } : {}));
    assert.match(html, /<tr><td>Spam \(Postmaster\)<\/td>/, `producedBy=${producedBy}`);
    assert.doesNotMatch(html, /Spam \(Postmaster, (automático|manual)/, `producedBy=${producedBy}`);
    assert.doesNotMatch(html, /governa o semáforo/, `producedBy=${producedBy}`);
  }
});
