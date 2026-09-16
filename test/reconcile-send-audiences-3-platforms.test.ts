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
import {
  beehiivSendAudience,
  buildDivergenceFindings,
  decideOutcome,
  resolveGuardExitCode,
  shouldUseAllActiveAsKitAudience,
} from "../scripts/reconcile-send-audiences.ts";
import { EDITOR_SEED_EMAILS } from "../scripts/lib/editor-copy.ts";

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

  // REGRESSÃO #7482 (decisão do editor, 10/09/2026): 0 ativos na Beehiiv +
  // backend=kit é o estado ESPERADO pós-migração — o "destinatários reais"
  // positivo que ainda aparece é resíduo do último envio ANTES da migração
  // terminar, não uma medição de canal errado. Sem este guard, comparar 314
  // contra 0 sempre reporta "inesperado, investigar" mesmo sendo normal.
  it("0 ativos na Beehiiv + backend=kit: pula o gap check, nunca alarma 'inesperado' (#7482)", () => {
    const audience = reconcileSendAudiences([{ name: "kit", emails: ["a@x.com"] }]);
    const outcome = decideOutcome(
      audience,
      [],
      [{ platform: "beehiiv", measured: true, recipients: 314 }],
      0,
      "kit",
    );
    assert.equal(outcome.beehiivGapSkippedPostMigration, true);
    assert.equal(outcome.beehiivDeliveryGap, null);
  });

  it("0 ativos na Beehiiv SEM backend=kit: continua alarmando normalmente (comportamento antigo preservado)", () => {
    const audience = reconcileSendAudiences([{ name: "kit", emails: ["a@x.com"] }]);
    const outcome = decideOutcome(
      audience,
      [],
      [{ platform: "beehiiv", measured: true, recipients: 314 }],
      0,
      undefined,
    );
    assert.equal(outcome.beehiivGapSkippedPostMigration, false);
    assert.equal(outcome.beehiivDeliveryGap?.ok, false);
  });

  // REGRESSÃO #7482 (16/09/2026): o skip exigia 0 ativos e quebrou quando a
  // Beehiiv passou a contar 1 ativo residual — "314 > 1, inesperado". Com
  // backend=kit a Beehiiv não envia a diária, qualquer que seja a contagem.
  it("Beehiiv com ativo residual (1) + backend=kit: pula o gap check mesmo assim (#7482)", () => {
    const audience = reconcileSendAudiences([{ name: "beehiiv", emails: ["a@x.com"] }]);
    const outcome = decideOutcome(
      audience,
      [],
      [{ platform: "beehiiv", measured: true, recipients: 314 }],
      1,
      "kit",
    );
    assert.equal(outcome.beehiivGapSkippedPostMigration, true);
    assert.equal(outcome.beehiivDeliveryGap, null);
  });

  it("Beehiiv com ativos + backend=beehiiv: gap check continua rodando normalmente", () => {
    const audience = reconcileSendAudiences([{ name: "beehiiv", emails: ["a@x.com"] }]);
    const outcome = decideOutcome(
      audience,
      [],
      [{ platform: "beehiiv", measured: true, recipients: 314 }],
      317,
      "beehiiv",
    );
    assert.equal(outcome.beehiivGapSkippedPostMigration, false);
    assert.equal(outcome.beehiivDeliveryGap?.ok, true);
  });

  // REGRESSÃO #7482 (16/09/2026): as 5 "sobreposições bloqueantes" medidas
  // ao vivo eram exatamente as 5 sondas do editor, que ficam na lista Brevo
  // E no Kit de propósito.
  it("sobreposição só de sondas do editor não bloqueia; é contada em seedOverlapsExempted (#7482)", () => {
    const audience = reconcileSendAudiences([
      { name: "kit", emails: ["Sonda@X.com", "a@x.com"] },
      { name: "brevo", emails: ["sonda@x.com"] },
    ]);
    const outcome = decideOutcome(audience, [], [], 0, "kit", ["sonda@x.com"]);
    assert.equal(outcome.audience.overlapCount, 0);
    assert.equal(outcome.seedOverlapsExempted, 1);
    assert.equal(outcome.blocking, false);
  });

  it("sobreposição real junto com sonda: a real continua bloqueando, a sonda sai da lista", () => {
    const audience = reconcileSendAudiences([
      { name: "kit", emails: ["sonda@x.com", "real@x.com"] },
      { name: "brevo", emails: ["sonda@x.com", "real@x.com"] },
    ]);
    const outcome = decideOutcome(audience, [], [], 0, "kit", ["sonda@x.com"]);
    assert.equal(outcome.audience.overlapCount, 1);
    assert.equal(outcome.audience.overlaps[0].email, "real@x.com");
    assert.equal(outcome.blocking, true);
  });

  it("default de seedEmails é EDITOR_SEED_EMAILS", () => {
    const seed = EDITOR_SEED_EMAILS[0];
    const audience = reconcileSendAudiences([
      { name: "kit", emails: [seed] },
      { name: "brevo", emails: [seed] },
    ]);
    const outcome = decideOutcome(audience, [], [], 0, "kit");
    assert.equal(outcome.blocking, false);
    assert.equal(outcome.seedOverlapsExempted, 1);
  });

  it("decideOutcome expõe kitAudienceIsAllActive no GuardOutcome (#7482 fleet review — paridade com beehiivGapSkippedPostMigration)", () => {
    const audience = reconcileSendAudiences([{ name: "kit", emails: ["a@x.com"] }]);
    const withKitBackend = decideOutcome(audience, [], [], 0, "kit");
    assert.equal(withKitBackend.kitAudienceIsAllActive, true);
    const withoutKitBackend = decideOutcome(audience, [], [], 0, "beehiiv");
    assert.equal(withoutKitBackend.kitAudienceIsAllActive, false);
  });
});

describe("shouldUseAllActiveAsKitAudience (#7482, achado 16/09/2026) — audiência de envio do Kit pós-migração", () => {
  it("backend=kit: audiência de envio é TODO ativo, não a tag rampa-kit (publish-newsletter-kit.ts manda pra buildAllSubscribersFilter)", () => {
    assert.equal(shouldUseAllActiveAsKitAudience("kit"), true);
  });

  it("backend=beehiiv (ou ausente): a tag continua sendo a audiência de envio real (rampa incremental ainda em curso)", () => {
    assert.equal(shouldUseAllActiveAsKitAudience("beehiiv"), false);
    assert.equal(shouldUseAllActiveAsKitAudience(undefined), false);
  });

  it("qualquer outro valor cai no comportamento antigo (tag) — fail-safe, nunca assume 'todo ativo' sem confirmar backend=kit", () => {
    assert.equal(shouldUseAllActiveAsKitAudience("outro-backend-hipotetico"), false);
  });
});

// REGRESSÃO #7482 (16/09/2026): 1 ativo residual na Beehiiv, também ativo no
// Kit, aparecia como "sobreposição Beehiiv×Kit" — mas com backend=kit a
// Beehiiv não envia a diária.
describe("beehiivSendAudience (#7482) — Beehiiv fora da audiência de envio com backend=kit", () => {
  it("backend=kit: audiência de envio vazia; residual ativo em Beehiiv e Kit não é sobreposição", () => {
    const beehiivActive = ["residual@x.com"];
    const sources: EmailSource[] = [
      { name: "kit", emails: ["residual@x.com"] },
      { name: "beehiiv", emails: beehiivSendAudience("kit", beehiivActive) },
    ];
    assert.equal(reconcileSendAudiences(sources).overlapCount, 0);
  });

  it("backend=kit: ativo SÓ na Beehiiv continua aparecendo como órfão", () => {
    const beehiivActive = ["so-beehiiv@x.com"];
    const sources: EmailSource[] = [
      { name: "kit", emails: [] },
      { name: "beehiiv", emails: beehiivSendAudience("kit", beehiivActive) },
    ];
    const orphans = findOrphans([{ name: "beehiiv", emails: beehiivActive }], sources);
    assert.equal(orphans.length, 1);
  });

  it("backend=beehiiv (ou ausente): ativos da Beehiiv são a audiência de envio", () => {
    assert.deepEqual(beehiivSendAudience("beehiiv", ["a@x.com"]), ["a@x.com"]);
    assert.deepEqual(beehiivSendAudience(undefined, ["a@x.com"]), ["a@x.com"]);
  });
});

// #7482 (decisão do editor, 16/09/2026): divergência vira issue PRÓPRIA em
// vez de exit 1 — exit 1 fazia o alarme de units systemd descrever o achado
// como "unit quebrada".
describe("buildDivergenceFindings (#7482) — achado vira issue própria", () => {
  it("guard limpo: nenhum finding (a issue conta execução limpa e fecha)", () => {
    const audience = reconcileSendAudiences([{ name: "kit", emails: ["a@x.com"] }]);
    const outcome = decideOutcome(audience, [], [], 0, "kit", []);
    assert.deepEqual(buildDivergenceFindings(outcome), []);
  });

  it("divergência: 1 finding família estado, fingerprint FIXO, contagens na assinatura e no título", () => {
    const audience = reconcileSendAudiences([
      { name: "kit", emails: ["dup@x.com"] },
      { name: "brevo", emails: ["dup@x.com"] },
    ]);
    const orphans = findOrphans([{ name: "kit", emails: ["preso@x.com"] }], [{ name: "kit", emails: [] }]);
    const outcome = decideOutcome(audience, orphans, [], 0, "kit", []);
    const findings = buildDivergenceFindings(outcome);
    assert.equal(findings.length, 1);
    const [f] = findings;
    assert.equal(f.family, "estado");
    assert.equal(f.fingerprint, "send-audiences:diverge");
    assert.equal(f.contentSignature, "overlap:1|orphans:1");
    assert.match(f.title, /1 sobreposição\(ões\), 1 órfão\(s\)/);
    assert.match(f.body, /não está quebrada/);
  });

  it("fingerprint não muda quando as contagens mudam (senão fecha a issue como resolvida sem ter sido)", () => {
    const one = decideOutcome(
      reconcileSendAudiences([{ name: "kit", emails: ["d@x.com"] }, { name: "brevo", emails: ["d@x.com"] }]),
      [], [], 0, "kit", [],
    );
    const two = decideOutcome(
      reconcileSendAudiences([
        { name: "kit", emails: ["d@x.com", "e@x.com"] },
        { name: "brevo", emails: ["d@x.com", "e@x.com"] },
      ]),
      [], [], 0, "kit", [],
    );
    assert.equal(buildDivergenceFindings(one)[0].fingerprint, buildDivergenceFindings(two)[0].fingerprint);
    assert.notEqual(buildDivergenceFindings(one)[0].contentSignature, buildDivergenceFindings(two)[0].contentSignature);
  });

  it("decideOutcome não muta o audience recebido ao isentar sondas", () => {
    const audience = reconcileSendAudiences([
      { name: "kit", emails: ["sonda@x.com"] },
      { name: "brevo", emails: ["sonda@x.com"] },
    ]);
    decideOutcome(audience, [], [], 0, "kit", ["sonda@x.com"]);
    assert.equal(audience.overlapCount, 1);
  });

  // Achado do review da PR #8183: falha ao registrar a issue não pode virar
  // exit ≠0 numa medição limpa (volta o falso "unit quebrada"), mas também
  // não pode engolir uma divergência que não chegou a lugar nenhum.
  it("resolveGuardExitCode: só sai ≠0 quando há divergência E o registro falhou", () => {
    assert.equal(resolveGuardExitCode(false, false), 0);
    assert.equal(resolveGuardExitCode(true, false), 0);
    assert.equal(resolveGuardExitCode(false, true), 0);
    assert.equal(resolveGuardExitCode(true, true), 3);
  });

  it("corpo da issue nunca expõe e-mail em claro (usa a máscara do --json)", () => {
    const outcome = decideOutcome(
      reconcileSendAudiences([
        { name: "kit", emails: ["fulano.secreto@gmail.com"] },
        { name: "brevo", emails: ["fulano.secreto@gmail.com"] },
      ]),
      [], [], 0, "kit", [],
    );
    assert.doesNotMatch(buildDivergenceFindings(outcome)[0].body, /fulano\.secreto@gmail\.com/);
  });
});
