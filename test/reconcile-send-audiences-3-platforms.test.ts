/**
 * test/reconcile-send-audiences-3-platforms.test.ts (#7385)
 *
 * Regressão pura pro guard "quem recebe × quem recebe" nas 3 plataformas —
 * `scripts/lib/beehiiv-kit-reconcile.ts` (funções novas do #7385) +
 * `scripts/reconcile-send-audiences.ts` (`decideOutcome`). Sem rede, sem
 * credencial — mesma disciplina de `test/beehiiv-kit-reconcile.test.ts`.
 *
 * Cobre, ponto a ponto, o que o corpo da issue pede:
 *   - a comparação usa audiência de ENVIO (não presença na base) nas 3
 *     plataformas;
 *   - a folga constante da Beehiiv (~3 abaixo do total ativo, medida em
 *     485/488, 463/466, 415/418, 314/317) não dispara alarme;
 *   - `globalStats` zerado por falta do parâmetro `?statistics=globalStats`
 *     é DETECTADO e tratado como "não medido", nunca confundido com "zero
 *     enviado real".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  reconcileSendAudiences,
  maskSendAudiencesResultForJson,
  findOrphans,
  maskOrphansForJson,
  checkBeehiivDeliveryGap,
  BEEHIIV_DELIVERY_GAP_TOLERANCE_ABS,
  looksLikeMissingGlobalStatsParam,
  resolveBrevoCampaignRecipients,
  type EmailSource,
} from "../scripts/lib/beehiiv-kit-reconcile.ts";
import { decideOutcome } from "../scripts/reconcile-send-audiences.ts";

describe("reconcileSendAudiences (#7385) — audiência de ENVIO, não base de ativos", () => {
  it("achado da issue: Kit=629 ativos mas só 280 na tag — a fonte que entra aqui é a TAG, não os 629", () => {
    // O ponto do #7385 é que o CALLER (o script) passa a audiência de envio
    // (tag rampa-kit), não "todos os ativos" — este teste fixa o contrato
    // desta função pura: ela só sabe comparar o que recebe, o caller decide
    // o que é "o que recebe".
    const kitSendAudience = Array.from({ length: 280 }, (_, i) => `kit${i}@example.com`);
    const beehiivActive = Array.from({ length: 314 }, (_, i) => `kit${i}@example.com`).slice(0, 280).concat(
      Array.from({ length: 34 }, (_, i) => `beehiiv-only${i}@example.com`),
    );
    const sources: EmailSource[] = [
      { name: "kit", emails: kitSendAudience },
      { name: "beehiiv", emails: beehiivActive },
    ];
    const result = reconcileSendAudiences(sources);
    assert.equal(result.sources.find((s) => s.name === "kit")?.total, 280);
    assert.equal(result.overlapCount, 280); // interseção completa neste cenário fabricado
  });

  it("3 fontes disjuntas — sobreposição 0 (o normal esperado)", () => {
    const sources: EmailSource[] = [
      { name: "kit", emails: ["a@x.com", "b@x.com"] },
      { name: "beehiiv", emails: ["c@x.com", "d@x.com"] },
      { name: "brevo", emails: ["e@x.com"] },
    ];
    const result = reconcileSendAudiences(sources);
    assert.equal(result.overlapCount, 0);
    assert.equal(result.distinctTotal, 5);
  });

  it("e-mail presente em 2 das 3 fontes — sobreposição bloqueante, reporta as 2 fontes", () => {
    const sources: EmailSource[] = [
      { name: "kit", emails: ["dup@x.com"] },
      { name: "beehiiv", emails: ["dup@x.com"] },
      { name: "brevo", emails: [] },
    ];
    const result = reconcileSendAudiences(sources);
    assert.equal(result.overlapCount, 1);
    assert.deepEqual(result.overlaps[0].sources, ["beehiiv", "kit"]);
  });

  it("normaliza (case/trim) antes de comparar — mesma disciplina do par Beehiiv×Kit", () => {
    const sources: EmailSource[] = [
      { name: "kit", emails: ["Joao@Example.com"] },
      { name: "beehiiv", emails: ["  joao@example.com  "] },
    ];
    const result = reconcileSendAudiences(sources);
    assert.equal(result.overlapCount, 1);
  });

  it("maskSendAudiencesResultForJson nunca vaza e-mail cru", () => {
    const sources: EmailSource[] = [
      { name: "kit", emails: ["joao@example.com"] },
      { name: "beehiiv", emails: ["joao@example.com"] },
    ];
    const masked = maskSendAudiencesResultForJson(reconcileSendAudiences(sources));
    const json = JSON.stringify(masked);
    assert.ok(!json.includes("joao@example.com"));
    assert.ok(json.includes("j***@example.com"));
  });
});

describe("findOrphans (#7385) — ativo em alguma plataforma, fora de toda audiência de envio", () => {
  it("achado #7357: ativo no Kit, fora da tag de audiência, fora das outras plataformas — órfão", () => {
    const active: EmailSource[] = [{ name: "kit", emails: ["preso@x.com", "na-tag@x.com"] }];
    const sendAudience: EmailSource[] = [{ name: "kit", emails: ["na-tag@x.com"] }];
    const orphans = findOrphans(active, sendAudience);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].email, "preso@x.com");
    assert.deepEqual(orphans[0].activeIn, ["kit"]);
  });

  it("ativo em 2 plataformas, coberto pela audiência de UMA delas — não é órfão", () => {
    const active: EmailSource[] = [
      { name: "kit", emails: ["a@x.com"] },
      { name: "beehiiv", emails: ["a@x.com"] },
    ];
    const sendAudience: EmailSource[] = [{ name: "beehiiv", emails: ["a@x.com"] }];
    const orphans = findOrphans(active, sendAudience);
    assert.equal(orphans.length, 0);
  });

  it("nenhum ativo em nenhuma plataforma — nenhum órfão (não confundir ausente com órfão)", () => {
    const orphans = findOrphans([{ name: "kit", emails: [] }], [{ name: "kit", emails: [] }]);
    assert.equal(orphans.length, 0);
  });

  it("maskOrphansForJson mascara o e-mail, preserva activeIn", () => {
    const orphans = findOrphans([{ name: "kit", emails: ["joao@example.com"] }], [{ name: "kit", emails: [] }]);
    const masked = maskOrphansForJson(orphans);
    assert.equal(masked[0].email, "j***@example.com");
    assert.deepEqual(masked[0].activeIn, ["kit"]);
  });
});

describe("checkBeehiivDeliveryGap (#7385) — armadilha de medição #2: folga constante NÃO alarma", () => {
  const measured: Array<[number, number]> = [
    [488, 485],
    [466, 463],
    [418, 415],
    [317, 314],
  ];
  for (const [active, recipients] of measured) {
    it(`gap medido real ${active}/${recipients} — ok, não alarma`, () => {
      const check = checkBeehiivDeliveryGap(active, recipients);
      assert.equal(check.ok, true);
      assert.equal(check.gap, active - recipients);
    });
  }

  it("gap zero (entrega perfeita) — ok", () => {
    const check = checkBeehiivDeliveryGap(100, 100);
    assert.equal(check.ok, true);
    assert.equal(check.gap, 0);
  });

  it("gap muito acima do tolerado — não-ok, investigar", () => {
    const check = checkBeehiivDeliveryGap(500, 400); // gap=100, bem acima da tolerância
    assert.equal(check.ok, false);
    assert.match(check.reason ?? "", /excede a tolerância/);
  });

  it("recipients > active — inesperado, não-ok", () => {
    const check = checkBeehiivDeliveryGap(100, 105);
    assert.equal(check.ok, false);
    assert.match(check.reason ?? "", /inesperado/);
  });

  it("entrada inválida (negativo/não-inteiro) — não-ok, mensagem explica", () => {
    assert.equal(checkBeehiivDeliveryGap(-1, 0).ok, false);
    assert.equal(checkBeehiivDeliveryGap(10, -1).ok, false);
    assert.equal(checkBeehiivDeliveryGap(10.5, 5).ok, false);
  });

  it("tolerância nunca cai abaixo do piso absoluto mesmo pra base pequena", () => {
    const check = checkBeehiivDeliveryGap(10, 10 - BEEHIIV_DELIVERY_GAP_TOLERANCE_ABS);
    assert.equal(check.ok, true);
  });
});

describe("Brevo globalStats — armadilha de medição #1 (#7385)", () => {
  it("campanha 'sent' sem bloco 'statistics' nenhum — detectado como parâmetro ausente", () => {
    assert.equal(looksLikeMissingGlobalStatsParam({ id: 1, status: "sent" }), true);
  });

  it("campanha 'sent' com 'statistics' mas sem 'globalStats' — ainda detectado", () => {
    assert.equal(looksLikeMissingGlobalStatsParam({ id: 1, status: "sent", statistics: {} }), true);
  });

  it("campanha 'sent' com 'globalStats' presente (mesmo com sent=0) — NÃO é o caso da armadilha", () => {
    assert.equal(
      looksLikeMissingGlobalStatsParam({ id: 1, status: "sent", statistics: { globalStats: { sent: 0 } } }),
      false,
    );
  });

  it("campanha ainda não enviada (status != 'sent') — não aplica (nunca teria stats mesmo)", () => {
    assert.equal(looksLikeMissingGlobalStatsParam({ id: 1, status: "draft" }), false);
  });

  it("resolveBrevoCampaignRecipients: parâmetro ausente vira 'não medido', NUNCA zero real", () => {
    const resolved = resolveBrevoCampaignRecipients({ id: 42, status: "sent" });
    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
      assert.match(resolved.reason, /esqueceu.*statistics=globalStats/);
    }
  });

  it("resolveBrevoCampaignRecipients: globalStats presente com sent=0 real — aceito como zero de verdade", () => {
    const resolved = resolveBrevoCampaignRecipients({
      id: 42,
      status: "sent",
      statistics: { globalStats: { sent: 0 } },
    });
    assert.equal(resolved.ok, true);
    if (resolved.ok) assert.equal(resolved.sent, 0);
  });

  it("resolveBrevoCampaignRecipients: caminho feliz — extrai 'sent' numérico", () => {
    const resolved = resolveBrevoCampaignRecipients({
      id: 42,
      status: "sent",
      statistics: { globalStats: { sent: 314 } },
    });
    assert.equal(resolved.ok, true);
    if (resolved.ok) assert.equal(resolved.sent, 314);
  });
});

describe("decideOutcome (#7385) — orquestração do guard de 3 plataformas", () => {
  it("sem sobreposição, sem órfão — não bloqueia", () => {
    const audience = reconcileSendAudiences([
      { name: "kit", emails: ["a@x.com"] },
      { name: "beehiiv", emails: ["b@x.com"] },
    ]);
    const orphans = findOrphans(
      [{ name: "kit", emails: ["a@x.com"] }, { name: "beehiiv", emails: ["b@x.com"] }],
      [{ name: "kit", emails: ["a@x.com"] }, { name: "beehiiv", emails: ["b@x.com"] }],
    );
    const outcome = decideOutcome(audience, orphans, [], 1);
    assert.equal(outcome.blocking, false);
  });

  it("com órfão — bloqueia", () => {
    const audience = reconcileSendAudiences([{ name: "kit", emails: [] }]);
    const orphans = findOrphans([{ name: "kit", emails: ["preso@x.com"] }], [{ name: "kit", emails: [] }]);
    const outcome = decideOutcome(audience, orphans, [], 0);
    assert.equal(outcome.blocking, true);
  });

  it("com sobreposição — bloqueia", () => {
    const audience = reconcileSendAudiences([
      { name: "kit", emails: ["dup@x.com"] },
      { name: "beehiiv", emails: ["dup@x.com"] },
    ]);
    const outcome = decideOutcome(audience, [], [], 0);
    assert.equal(outcome.blocking, true);
  });

  it("gap de entrega Beehiiv medido e dentro da tolerância não bloqueia sozinho", () => {
    const audience = reconcileSendAudiences([{ name: "beehiiv", emails: Array.from({ length: 317 }, (_, i) => `e${i}@x.com`) }]);
    const outcome = decideOutcome(
      audience,
      [],
      [{ platform: "beehiiv", measured: true, recipients: 314 }],
      317,
    );
    assert.equal(outcome.blocking, false);
    assert.equal(outcome.beehiivDeliveryGap?.ok, true);
  });
});
