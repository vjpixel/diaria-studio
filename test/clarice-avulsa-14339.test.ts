/**
 * test/clarice-avulsa-14339.test.ts (#14339)
 *
 * Campanha avulsa da Black Friday 2026 (#438/#439, cupom NEWS65) no
 * monitoramento da Clarice. Decisão do editor (briefing 261128): categoria
 * "avulsa" separada — fora dos agregados de ciclo/onda, dentro de volume de
 * cobrança, guardrails, sunset, priority_points, recência/duplicidade e do
 * rastreio do cupom.
 *
 * Cenário real da issue: as duas campanhas foram para todos os send_eligible
 * do store em 27-28/11, e o cutoff mensal da recência (#7234, início do mês da
 * data de envio) deixava a onda de 01/12 mandar outro e-mail logo em seguida;
 * o dashboard tirava os 88k do volume do ciclo de cobrança por não reconhecer
 * o nome da campanha.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CLARICE_AVULSA_CAMPAIGNS,
  activeAvulsaCooldowns,
  brtDateOf,
  excludeAvulsaCooldown,
  isClariceAvulsaCampaign,
} from "../scripts/lib/shared/clarice-avulsa.ts";
import { groupKeyFromCampaignName, summarizeCycleSends } from "../scripts/lib/clarice-wave-plan.ts";
import { parseClariceCampaignKey } from "../scripts/lib/shared/brevo-campaign-stats.ts";
import { excludeSentSince } from "../scripts/lib/clarice-recency.ts";
import { sendMonthStartIso } from "../scripts/lib/clarice-paths.ts";
import { parseBrevoContact } from "../scripts/lib/brevo-stats.ts";
import { openClariceDb, makeBrevoUpsert, recomputeDerived } from "../scripts/lib/clarice-db.ts";
import { pickCampaignsPendingEvaluation, emptyGuardrailAlarmState } from "../scripts/lib/clarice-guardrail-alarm.ts";
import {
  TARGET_CODES,
  COMPARISON_CODES,
  splitComparisonCodes,
  isCouponExpired,
  fetchCouponUsage,
  type CouponUsageReport,
} from "../scripts/lib/stripe-coupons.ts";
import {
  extractMonthlyCycleCandidate,
  classifyClariceAudience,
  calcCumulativeSentInBillingWindow,
  findUnclassifiedCampaignNames,
  findAvulsaCampaignNames,
  renderAvulsaCampaignsNote,
  aggregateByWeekday,
  billingCycleWindow,
  renderCouponTabPanel,
} from "../workers/brevo-dashboard/src/index.ts";

const BF_NAME = "Clarice Black Friday 2026 (NEWS65) — elegíveis";

describe("classificação 'avulsa' (#14339)", () => {
  it("reconhece #438/#439 pelo id e o nome da Black Friday pelo padrão", () => {
    assert.equal(isClariceAvulsaCampaign({ id: 438, name: "qualquer" }), true);
    assert.equal(isClariceAvulsaCampaign({ id: 439, name: "qualquer" }), true);
    assert.equal(isClariceAvulsaCampaign({ name: BF_NAME }), true);
    assert.equal(isClariceAvulsaCampaign({ name: "Clarice avulsa 2026-12 natal" }), true);
  });

  it("não marca como avulsa os padrões regulares de onda/ciclo", () => {
    for (const name of [
      "Clarice 2610 grupo:d7-sex07",
      "Clarice News 2606-07 — A: assunto",
      "Diar.ia Mensal 2610 — 2026-11-05 01:33",
      "cold 2606-07 — B",
    ]) {
      assert.equal(isClariceAvulsaCampaign({ id: 1, name }), false, name);
    }
  });

  it("o registro carrega o cupom NEWS65 e as listas reais (431, 432)", () => {
    const byId = new Map(CLARICE_AVULSA_CAMPAIGNS.map((a) => [a.id, a]));
    assert.deepEqual(byId.get(438)?.listIds, [431]);
    assert.deepEqual(byId.get(439)?.listIds, [432]);
    assert.equal(byId.get(438)?.coupon, "NEWS65");
  });

  it("fica fora de ciclo e onda: nenhum parser de ciclo/onda atribui a campanha", () => {
    assert.equal(groupKeyFromCampaignName(BF_NAME), null);
    assert.equal(parseClariceCampaignKey(BF_NAME), null);
    assert.equal(extractMonthlyCycleCandidate(BF_NAME), null);
    assert.equal(classifyClariceAudience(BF_NAME), null);
    const state = summarizeCycleSends(
      [{ id: 438, name: BF_NAME, subject: "BF", status: "sent", sentDate: "2026-11-27T15:00:00Z", scheduledAt: null, listName: "Clarice Black Friday 27/11 (NEWS65) — elegíveis", listSize: 88064 } as never],
      "2611-12",
      new Date("2026-11-29T12:00:00Z"),
    );
    assert.equal(state.waves.length, 0);
    assert.equal(state.volumeSum, 0);
    assert.equal(state.unscopedCount, 0, "avulsa não é onda sem ciclo — não conta como unscoped");
  });
});

describe("cooldown de recência da avulsa (#14339)", () => {
  it("janela: #438 cobre 27/11..03/12 e #439 cobre 28/11..04/12 (7 dias)", () => {
    assert.deepEqual(activeAvulsaCooldowns("2026-11-26").map((a) => a.id), []);
    assert.deepEqual(activeAvulsaCooldowns("2026-11-27").map((a) => a.id), [438]);
    assert.deepEqual(activeAvulsaCooldowns("2026-12-01").map((a) => a.id), [438, 439]);
    assert.deepEqual(activeAvulsaCooldowns("2026-12-04").map((a) => a.id), [439]);
    assert.deepEqual(activeAvulsaCooldowns("2026-12-05").map((a) => a.id), []);
    assert.throws(() => activeAvulsaCooldowns("01/12/2026"), /data inválida/);
  });

  const rows = [
    // recebeu a #438 e o sync já gravou o last_sent_at
    { email: "a@x.com", last_sent_at: "2026-11-27T15:02:00.000Z", brevo_list_ids: "[12,431]" },
    // recebeu a #439, mas o sync incremental ainda não trouxe o last_sent_at
    { email: "b@x.com", last_sent_at: "2026-11-10T12:00:00.000Z", brevo_list_ids: "[432]" },
    // fora das duas: última onda regular em 10/11
    { email: "c@x.com", last_sent_at: "2026-11-10T12:00:00.000Z", brevo_list_ids: "[12]" },
    // cadastro novo, nunca recebeu
    { email: "d@x.com", last_sent_at: null, brevo_list_ids: null },
  ];

  it("cenário da issue: a onda de 01/12 passaria pelo cutoff mensal (#7234) e o cooldown a barra", () => {
    const monthly = excludeSentSince(rows, sendMonthStartIso("2026-12-01"));
    assert.equal(monthly.length, 4, "o cutoff de dezembro não enxerga quem recebeu a avulsa em 27-28/11");
    const r = excludeAvulsaCooldown(monthly, "2026-12-01");
    assert.deepEqual(r.kept.map((x) => x.email), ["c@x.com", "d@x.com"]);
    assert.equal(r.excluded, 2);
    assert.deepEqual(r.active.map((a) => a.id), [438, 439]);
  });

  it("depois do cooldown ninguém é barrado", () => {
    const r = excludeAvulsaCooldown(rows, "2026-12-05");
    assert.equal(r.kept.length, 4);
    assert.equal(r.excluded, 0);
  });

  it("brevo_list_ids corrompido não derruba nem exclui", () => {
    const r = excludeAvulsaCooldown([{ last_sent_at: null, brevo_list_ids: "{nope" }], "2026-12-01");
    assert.equal(r.kept.length, 1);
  });

  it("brtDateOf usa o dia de Brasília (01:00Z de 02/12 ainda é 01/12 BRT)", () => {
    assert.equal(brtDateOf(new Date("2026-12-02T01:00:00Z")), "2026-12-01");
  });
});

describe("store: sunset e priority_points com eventos da #438 (#14339)", () => {
  it("unsub/hard bounce/spam da avulsa viram send_eligible=0; abertura alimenta priority_points", () => {
    const db = openClariceDb(":memory:");
    for (const email of ["unsub@x.com", "bounce@x.com", "spam@x.com", "abriu@x.com"]) {
      db.prepare("INSERT INTO clarice_users (email, status, tier) VALUES (?, 'active', 1)").run(email);
    }
    recomputeDerived(db);
    const upsert = makeBrevoUpsert(db);
    const sent = [{ campaignId: 438, eventTime: "2026-11-27T15:00:00Z" }];
    upsert(parseBrevoContact({ email: "unsub@x.com", statistics: { messagesSent: sent, unsubscriptions: { userUnsubscription: [{ campaignId: 438, eventTime: "2026-11-27T16:00:00Z" }] } } }));
    upsert(parseBrevoContact({ email: "bounce@x.com", statistics: { messagesSent: sent, hardBounces: [{ campaignId: 438, eventTime: "2026-11-27T15:01:00Z" }] } }));
    upsert(parseBrevoContact({ email: "spam@x.com", statistics: { messagesSent: sent, complaints: [{ campaignId: 438, eventTime: "2026-11-27T18:00:00Z" }] } }));
    upsert(parseBrevoContact({
      email: "abriu@x.com",
      statistics: {
        messagesSent: sent,
        opened: [{ campaignId: 438, eventTime: "2026-11-27T17:00:00Z" }],
        clicked: [{ campaignId: 438, links: [{ url: "https://clarice.ai/precos-planos?via=diaria", eventTime: "2026-11-27T17:01:00Z" }] }],
      },
    }));
    recomputeDerived(db);
    const get = (email: string) =>
      db.prepare("SELECT send_eligible, priority_points, last_sent_at FROM clarice_users WHERE email = ?").get(email) as {
        send_eligible: number;
        priority_points: number;
        last_sent_at: string | null;
      };
    assert.equal(get("unsub@x.com").send_eligible, 0, "descadastro na avulsa suprime");
    assert.equal(get("bounce@x.com").send_eligible, 0, "hard bounce da avulsa suprime");
    assert.equal(get("spam@x.com").send_eligible, 0, "spam da avulsa suprime");
    const abriu = get("abriu@x.com");
    assert.equal(abriu.send_eligible, 1);
    assert.ok(abriu.priority_points > 0, "abertura/clique da avulsa conta no priority_points");
    assert.equal(abriu.last_sent_at, "2026-11-27T15:00:00.000Z", "last_sent_at da avulsa chega ao store (recência)");
    db.close();
  });
});

describe("guardrail: a avulsa entra na avaliação (#14339)", () => {
  it("pickCampaignsPendingEvaluation não filtra por nome", () => {
    const picked = pickCampaignsPendingEvaluation(
      [{ id: 438, name: BF_NAME, sentDate: "2026-11-27T15:00:00Z" }],
      emptyGuardrailAlarmState(),
      new Date("2026-11-28T12:00:00Z"),
    );
    assert.deepEqual(picked.map((c) => c.id), [438]);
  });
});

function camp(id: number, name: string, sentDate: string, sent: number) {
  return {
    id,
    name,
    subject: "s",
    status: "sent",
    sentDate,
    scheduledAt: null,
    createdAt: sentDate,
    recipients: { lists: [id] },
    listName: `List ${id}`,
    listSize: sent,
    statistics: {
      globalStats: {
        uniqueClicks: 1, clickers: 1, complaints: 0, delivered: sent, sent, softBounces: 0, hardBounces: 0,
        uniqueViews: Math.round(sent * 0.2), trackableViews: 0, unsubscriptions: 0, viewed: 0, appleMppOpens: 0,
      },
    },
  };
}

describe("dashboard: avulsa no volume de cobrança, fora do dia da semana (#14339)", () => {
  const regular = camp(400, "Clarice 2610 grupo:d20-qua26", "2026-11-26T12:00:00Z", 1000);
  const avulsa = camp(438, BF_NAME, "2026-11-27T15:00:00Z", 88064);

  it("calcCumulativeSentInBillingWindow soma os envios da avulsa", () => {
    const window = billingCycleWindow(new Date("2026-11-28T12:00:00Z"));
    assert.equal(calcCumulativeSentInBillingWindow([regular, avulsa] as never, window), 89064);
  });

  it("a avulsa não cai em 'não classificada' e ganha nota própria", () => {
    assert.deepEqual(findUnclassifiedCampaignNames([regular, avulsa]), []);
    const names = findAvulsaCampaignNames([regular, avulsa]);
    assert.deepEqual(names, [BF_NAME]);
    const html = renderAvulsaCampaignsNote(names);
    assert.match(html, /1 campanha avulsa/);
    assert.match(html, /fora dos agregados de ciclo\/onda/);
    assert.equal(renderAvulsaCampaignsNote([]), "");
  });

  it("aggregateByWeekday ignora a avulsa (não distorce o plano semanal)", () => {
    const now = new Date("2026-12-10T12:00:00Z");
    const { rows } = aggregateByWeekday([regular, avulsa] as never, null, now);
    const total = rows.reduce((s, r) => s + r.count, 0);
    assert.equal(total, 1, "só a onda regular entra");
  });
});

describe("cupons: NEWS65 monitorado, BLACKFRIDAY60 só comparação (#14339)", () => {
  it("TARGET_CODES inclui NEWS65 e não inclui o cupom de comparação", () => {
    assert.ok((TARGET_CODES as readonly string[]).includes("NEWS65"));
    assert.ok((COMPARISON_CODES as readonly string[]).includes("BLACKFRIDAY60"));
    assert.ok(!(TARGET_CODES as readonly string[]).includes("BLACKFRIDAY60"));
  });

  it("splitComparisonCodes tira BLACKFRIDAY60 do report do KV/comissão", () => {
    const entry = { couponIds: [], timesRedeemed: 0, rowCount: 0, totalProjectedDiscountCents: 0, redemptions: [] };
    const report: CouponUsageReport = { NEWS65: entry, BLACKFRIDAY60: entry, NEWS50: entry };
    const { target, comparison } = splitComparisonCodes(report);
    assert.deepEqual(Object.keys(target).sort(), ["NEWS50", "NEWS65"]);
    assert.deepEqual(Object.keys(comparison), ["BLACKFRIDAY60"]);
  });

  it("NEWS65 expira depois de 30/11 23:59 BRT e segue na lista (histórico)", () => {
    assert.equal(isCouponExpired("NEWS65", new Date("2026-12-01T02:59:00Z")), false);
    assert.equal(isCouponExpired("NEWS65", new Date("2026-12-01T03:00:00Z")), true);
    assert.equal(isCouponExpired("NEWS50", new Date("2030-01-01T00:00:00Z")), false);
  });

  it("aba Cupons rotula NEWS65 como expirado depois do prazo, sem tirar o histórico", () => {
    const entry = { couponIds: [], timesRedeemed: 0, rowCount: 0, totalProjectedDiscountCents: 0, redemptions: [] };
    const report: CouponUsageReport = { NEWS65: entry, NEWS50: entry };
    const before = renderCouponTabPanel(report, new Date("2026-11-30T12:00:00Z"));
    assert.doesNotMatch(before, /coupon-expired-note/);
    const after = renderCouponTabPanel(report, new Date("2026-12-02T12:00:00Z"));
    assert.match(after, /coupon-expired-note">NEWS65 expirado em 30\/11\/2026\. Histórico/);
    assert.doesNotMatch(after, /NEWS50 expirado/);
  });

  it("fetchCouponUsage busca os códigos pedidos (default = TARGET_CODES, sem comparação)", async () => {
    const queried: string[] = [];
    const empty = { data: [], has_more: false };
    const mockFetch = (async (url: string | URL) => {
      const u = String(url);
      const m = /promotion_codes\?code=([A-Z0-9]+)/.exec(u);
      if (m) queried.push(m[1]);
      return { ok: true, status: 200, json: async () => empty, text: async () => JSON.stringify(empty) } as unknown as Response;
    }) as unknown as typeof fetch;
    await fetchCouponUsage("rk_test_dummy", mockFetch, "2026-11-28T00:00:00Z");
    assert.deepEqual(queried, ["NEWS50", "NEWS25", "NEWS65"]);
    queried.length = 0;
    await fetchCouponUsage("rk_test_dummy", mockFetch, "2026-11-28T00:00:00Z", [...TARGET_CODES, ...COMPARISON_CODES]);
    assert.deepEqual(queried, ["NEWS50", "NEWS25", "NEWS65", "BLACKFRIDAY60"]);
  });
});
