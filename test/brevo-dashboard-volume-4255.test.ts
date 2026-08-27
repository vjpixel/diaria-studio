/**
 * test/brevo-dashboard-volume-4255.test.ts (#4255)
 *
 * Regressão: "Volume enviado no ciclo" mostrava "97.459 envios de 135.191
 * créditos do plano (72,1%)" quando o real (verificado ao vivo contra a
 * Brevo em 260728) era "112.268 de 150.000 (74,8%)". Causa raiz:
 * `classifyClariceAudience` (workers/brevo-dashboard/src/sections-core.ts)
 * não reconhecia o naming `Clarice {yymm} grupo:{key}` produzido pelo fluxo
 * `--group` (`scripts/clarice-schedule-group.ts:162`, `campaignNameFor`) --
 * ex: "Clarice 2606 grupo:envio11" (8.005 envios) e "Clarice 2606
 * grupo:envio10" (6.804 envios). `8.005 + 6.804 = 14.809`, exatamente o
 * buraco (`112.268 − 14.809 = 97.459`).
 *
 * É a TERCEIRA ocorrência da mesma classe de bug (#3076, #4082 item 2) --
 * um naming novo de campanha que nenhuma agregação reconhece.
 *
 * O denominador (`planTotal = planCredits + cumulativeSent`, ver
 * `renderVolumeSection` em sections-kv.ts) é derivado de `cumulativeSent` --
 * corrigir a classificação corrige os DOIS sintomas relatados na issue sem
 * precisar de uma constante de config nova (a divergência 140k-vs-150k
 * levantada na issue é uma decisão de produto que precisa confirmação do
 * editor contra a fatura da Brevo antes de codificar -- fora do escopo
 * autônomo deste fix).
 *
 * Fixtures 100% sintéticas -- nenhum id/email real. Os nomes de campanha
 * ("Clarice 2606 grupo:envio10/11") são os mesmos citados na issue, mas os
 * `sent` usados nos testes de soma são valores sintéticos pequenos (não os
 * volumes reais de produção) -- só o teste de reprodução exata do incidente
 * usa os números reais (8.005/6.804/97.459/112.268), citados para provar que
 * a fórmula bate com o que o editor observou ao vivo.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyClariceAudience,
  calcCumulativeSentInBillingWindow,
  billingCycleWindow,
  renderVolumeSection,
} from "../workers/brevo-dashboard/src/index.ts";
import { campaignNameFor } from "../scripts/clarice-schedule-group.ts";

function makeGlobalStats(sent: number) {
  return {
    sent, delivered: sent, hardBounces: 0, softBounces: 0,
    uniqueViews: 0, viewed: 0, trackableViews: 0,
    uniqueClicks: 0, clickers: 0, unsubscriptions: 0, complaints: 0,
    appleMppOpens: 0,
  };
}

function makeCampaign(id: number, name: string, sentDate: string, sent: number) {
  return {
    id,
    name,
    subject: "Test",
    status: "sent",
    sentDate,
    scheduledAt: null,
    createdAt: sentDate,
    recipients: { lists: [id + 100] },
    listName: `List ${id}`,
    listSize: 100,
    statistics: { globalStats: makeGlobalStats(sent) },
  };
}

// ─── classifyClariceAudience reconhece o naming "--group" (Causa 1) ─────────

describe("classifyClariceAudience (#4255) — naming 'Clarice {yymm} grupo:{key}' (fluxo --group)", () => {
  test("'Clarice 2606 grupo:envio11' → 'warm' (antes do fix: null)", () => {
    assert.equal(classifyClariceAudience("Clarice 2606 grupo:envio11"), "warm");
  });

  test("'Clarice 2606 grupo:envio10' → 'warm' (antes do fix: null)", () => {
    assert.equal(classifyClariceAudience("Clarice 2606 grupo:envio10"), "warm");
  });

  test("qualquer key do grupo é aceita (não hardcoded 'envioN')", () => {
    assert.equal(classifyClariceAudience("Clarice 2607 grupo:ramp-warm"), "warm");
    assert.equal(classifyClariceAudience("Clarice 2601 grupo:reativacao"), "warm");
  });

  test("espelha EXATAMENTE a string real produzida por campaignNameFor (scripts/clarice-schedule-group.ts) — o teste quebra se o gerador mudar de shape", () => {
    assert.equal(classifyClariceAudience(campaignNameFor("2606-07", "envio11")), "warm");
    assert.equal(classifyClariceAudience(campaignNameFor("2606-07", "envio10")), "warm");
  });

  test("continua null para naming genuinamente desconhecido (não vira permissivo demais)", () => {
    assert.equal(classifyClariceAudience("T1-W1 digest"), null);
    assert.equal(classifyClariceAudience("Outra campanha qualquer"), null);
    // "grupo" sem o prefixo "Clarice {yymm} " não deve casar por acidente
    assert.equal(classifyClariceAudience("grupo:envio11"), null);
  });

  test("naming preexistente (News/cold/Mensal) continua funcionando (sem regressão)", () => {
    assert.equal(classifyClariceAudience("Clarice News 2605 d01-A (qua)"), "warm");
    assert.equal(classifyClariceAudience("cold 2606-07 — A: subject"), "cold");
    assert.equal(classifyClariceAudience("Diar.ia Mensal 2604 — 2026-05-14 19:26"), "warm");
  });
});

// ─── calcCumulativeSentInBillingWindow agora contabiliza as campanhas --group ──

describe("calcCumulativeSentInBillingWindow (#4255) — campanhas 'grupo:' dentro da janela", () => {
  const window = billingCycleWindow(new Date("2026-07-20T12:00:00Z")); // ciclo 04/jul→04/ago

  test("campanha 'Clarice {yymm} grupo:{key}' dentro da janela agora É contabilizada (era descartada)", () => {
    const grupo = makeCampaign(1, "Clarice 2606 grupo:envio11", "2026-07-10T09:00:00Z", 500);
    const total = calcCumulativeSentInBillingWindow([grupo], window);
    assert.equal(total, 500, "antes do fix: 0 (classifyClariceAudience retornava null e a campanha era pulada)");
  });

  test("soma junto com naming diário/cold normalmente", () => {
    const daily = makeCampaign(1, "Clarice News 2607 d05 (qua)", "2026-07-10T09:00:00Z", 100);
    const grupo1 = makeCampaign(2, "Clarice 2606 grupo:envio11", "2026-07-12T09:00:00Z", 8005);
    const grupo2 = makeCampaign(3, "Clarice 2606 grupo:envio10", "2026-07-08T09:00:00Z", 6804);
    const total = calcCumulativeSentInBillingWindow([daily, grupo1, grupo2], window);
    assert.equal(total, 100 + 8005 + 6804);
  });

  // Reprodução do incidente 260728 (números reais confirmados contra a API da
  // Brevo): a soma correta de todas as campanhas do ciclo era 112.268; sem as
  // duas campanhas 'grupo:' (8.005 + 6.804 = 14.809) o dashboard mostrava
  // 97.459. Este teste prova que a fórmula agora fecha com o valor real.
  test("reprodução do incidente 260728: 14.809 estavam faltando (8.005 + 6.804)", () => {
    const restOfCycle = makeCampaign(1, "Clarice News 2607 d10 (sex)", "2026-07-15T09:00:00Z", 97459);
    const grupo11 = makeCampaign(2, "Clarice 2606 grupo:envio11", "2026-07-12T09:00:00Z", 8005);
    const grupo10 = makeCampaign(3, "Clarice 2606 grupo:envio10", "2026-07-08T09:00:00Z", 6804);
    const total = calcCumulativeSentInBillingWindow([restOfCycle, grupo11, grupo10], window);
    assert.equal(total, 112268, "97.459 (naming reconhecido antes do fix) + 14.809 (grupo:, agora reconhecidos)");
  });

  test("campanha 'grupo:' FORA da janela continua excluída (o fix é de classificação, não de janela)", () => {
    const grupoForaDaJanela = makeCampaign(1, "Clarice 2606 grupo:envio09", "2026-06-01T00:00:00Z", 999);
    const total = calcCumulativeSentInBillingWindow([grupoForaDaJanela], window);
    assert.equal(total, 0);
  });
});

// ─── denominador (renderVolumeSection): #6394 — a função só EXIBE o planTotal
// já resolvido pelo call site (resolvePlanTotal, brevo-api.ts); deixou de
// somar planCredits + cumulativeSent aqui dentro, então os testes passam o
// total JÁ somado como 3º arg, não mais o restante isolado ──────────────────

describe("renderVolumeSection (#4255) — denominador reconcilia com o cumulativeSent corrigido", () => {
  const window = billingCycleWindow(new Date("2026-07-20T12:00:00Z"));

  test("com cumulativeSent corrigido (112.268) + planTotal já resolvido (150.000) → não 135.191", () => {
    const html = renderVolumeSection(112268, window, 150000);
    assert.ok(html.includes("150.000"), "planTotal recebido direto fecha em 150.000");
    assert.ok(html.includes("112.268"), "numerador mostra o valor corrigido");
    assert.ok(!html.includes("135.191"), "denominador antigo (que escondia os 14.809 perdidos) não aparece mais");
    // 112268 / 150000 = 74.845...%
    assert.ok(html.includes("74,8%") || html.includes("74.8%"), "percentual reconcilia com o real observado pelo editor (74,8%)");
  });

  test("regressão do bug antigo: SEM o fix, cumulativeSent=97.459 produzia planTotal=135.191 (documentado, não o comportamento atual)", () => {
    // Este teste documenta a ARITMÉTICA do bug antigo (não chama nenhum código
    // afetado pelo fix — o planTotal aqui é passado manualmente como o valor
    // subcontado que o classificador antigo produzia, já somado — desde
    // #6394 quem soma é o call site, não `renderVolumeSection`) — serve de
    // ancoragem pra não perder de vista POR QUE o fix em
    // classifyClariceAudience é suficiente sozinho: o denominador nunca
    // precisou de correção própria.
    const buggyCumulativeSent = 97459;
    const buggyPlanTotal = 97459 + 37732; // 135.191 — restante+enviado do classificador antigo
    const html = renderVolumeSection(buggyCumulativeSent, window, buggyPlanTotal);
    assert.ok(html.includes("135.191"), "reproduz o denominador errado relatado na issue, a partir do numerador subcontado");
  });
});
