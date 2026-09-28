/**
 * test/onboarding-funnel-report-7917.test.ts (#7917)
 *
 * Cobre `scripts/lib/onboarding-funnel-report.ts` — visibilidade do funil
 * de onboarding até o convite D+10, sem tocar transporte/envio. Cenários
 * exigidos pelos critérios de aceite da issue:
 *
 *   - campanha ainda em rascunho (Brevo e Kit), com/sem idade "parada";
 *   - campanha enviada (Brevo `sent`, lote Kit `completed`);
 *   - falha de consulta explícita (nunca degrada pra "rascunho");
 *   - pagamentos sem vínculo conclusivo (`apoiadorIndex` ausente vs.
 *     presente sem match vs. presente com match);
 *   - coexistência Brevo/Kit sem contar a mesma pessoa 2x;
 *   - coorte histórica ainda em espera (`aguardando_confirmacao`, `not_due`,
 *     `aguardando_dados` dentro/fora da tolerância);
 *   - `seeded_by` excluído do agregado automático.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildOnboardingFunnelEntry,
  summarizeOnboardingFunnel,
  findKitLotForEntry,
  STALE_DRAFT_DAYS,
  type BuildFunnelEntryOptions,
  type OnboardingFunnelEntry,
} from "../scripts/lib/onboarding-funnel-report.ts";
import type { OnboardingEntry } from "../scripts/lib/onboarding-store.ts";
import type { OnboardingKitLot } from "../scripts/lib/onboarding-kit-transport.ts";
import type { LinkableApoiador } from "../scripts/lib/metrics/apoiador-link.ts";
import { buildApoiadorEmailIndex } from "../scripts/lib/metrics/apoiador-link.ts";

const DAY = 86_400;
const T0 = 1_755_000_000; // epoch seg fixo

function baseEntry(overrides: Partial<OnboardingEntry> = {}): OnboardingEntry {
  return {
    subscription_id: "sub_1",
    email: "leitor@example.com",
    status_detectado: "active",
    created_at: T0 - 30 * DAY,
    detected_at: new Date((T0 - 30 * DAY) * 1000).toISOString(),
    email1_sent_at: new Date((T0 - 20 * DAY) * 1000).toISOString(),
    email1_brevo_id: "msg-1",
    email2_sent_at: new Date((T0 - 17 * DAY) * 1000).toISOString(),
    email2_brevo_id: "msg-2",
    email3_state: "pending",
    email3_campaign_id: null,
    email3_decided_at: null,
    ...overrides,
  };
}

function baseOpts(overrides: Partial<BuildFunnelEntryOptions> = {}): BuildFunnelEntryOptions {
  return {
    nowSec: T0,
    email3Days: 10,
    email3GraceDays: 3,
    kitLots: [],
    ...overrides,
  };
}

function kitLot(overrides: Partial<OnboardingKitLot> = {}): OnboardingKitLot {
  return {
    lot_id: "email3-2026-09-01-01",
    kind: "email3",
    tag_name: "onboarding-email3-2026-09-01-01",
    tag_id: 42,
    broadcast_id: 999,
    recipient_subscription_ids: ["sub_1"],
    recipient_emails: ["leitor@example.com"],
    status: "created",
    created_at: new Date((T0 - 1 * DAY) * 1000).toISOString(),
    send_at: null,
    last_reconciled_at: null,
    last_error: null,
    ...overrides,
  };
}

describe("onboarding-funnel-report — e-mail 3 rascunho/enviado/falha", () => {
  it("campanha Brevo criada recentemente: rascunho não-parado, próxima ação = aguardar humano", () => {
    const entry = baseEntry({
      email3_state: "campaign_created",
      email3_campaign_id: 555,
      email3_decided_at: new Date((T0 - 1 * DAY) * 1000).toISOString(),
    });
    const result = buildOnboardingFunnelEntry(entry, baseOpts());
    assert.equal(result.email3.stage, "rascunho_criado");
    assert.equal(result.email3.provider, "brevo");
    assert.equal(result.email3.campaignOrBroadcastId, 555);
    assert.equal(result.email3.stale, false);
    assert.equal(result.email3.ageDays, 1);
  });

  it("campanha Brevo criada há STALE_DRAFT_DAYS+: marca stale com próxima ação nomeando a campanha", () => {
    const entry = baseEntry({
      email3_state: "campaign_created",
      email3_campaign_id: 555,
      email3_decided_at: new Date((T0 - (STALE_DRAFT_DAYS + 2) * DAY) * 1000).toISOString(),
    });
    const result = buildOnboardingFunnelEntry(entry, baseOpts());
    assert.equal(result.email3.stage, "rascunho_criado");
    assert.equal(result.email3.stale, true);
    assert.match(result.email3.nextAction, /parado há \d+ dia/);
    assert.match(result.email3.nextAction, /555/);
  });

  it("campanha Brevo com live state 'sent': stage enviado, nunca stale", () => {
    const entry = baseEntry({
      email3_state: "campaign_created",
      email3_campaign_id: 555,
      email3_decided_at: new Date((T0 - 10 * DAY) * 1000).toISOString(),
    });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ brevoCampaignState: { status: "sent" } }));
    assert.equal(result.email3.stage, "enviado");
    assert.equal(result.email3.stale, false);
  });

  it("campanha Brevo com live state 'queued': stage agendado", () => {
    const entry = baseEntry({
      email3_state: "campaign_created",
      email3_campaign_id: 555,
      email3_decided_at: new Date((T0 - 1 * DAY) * 1000).toISOString(),
    });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ brevoCampaignState: { status: "queued" } }));
    assert.equal(result.email3.stage, "agendado");
  });

  it("falha de consulta à Brevo: 'falha_consulta' explícito, NUNCA degrada pra rascunho", () => {
    const entry = baseEntry({
      email3_state: "campaign_created",
      email3_campaign_id: 555,
      email3_decided_at: new Date((T0 - 10 * DAY) * 1000).toISOString(),
    });
    const result = buildOnboardingFunnelEntry(
      entry,
      baseOpts({ brevoQueryFailed: true, brevoCampaignState: { status: "sent" } }), // mesmo com um live state presente, a falha reportada vence
    );
    assert.equal(result.email3.stage, "falha_consulta");
    assert.equal(result.email3.stale, false); // falha de consulta nunca é classificada como "parada" — não sabemos a idade real do estado
  });

  it("campanha Brevo com estado ambíguo (suspended) não promove a enviado", () => {
    const entry = baseEntry({
      email3_state: "campaign_created",
      email3_campaign_id: 555,
      email3_decided_at: new Date((T0 - 1 * DAY) * 1000).toISOString(),
    });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ brevoCampaignState: { status: "suspended" } }));
    assert.equal(result.email3.stage, "rascunho_criado");
  });
});

describe("onboarding-funnel-report — transporte Kit (#7922) coexistindo com Brevo", () => {
  it("entrada com lote Kit: provider kit, stage do lote reflete OnboardingKitLotStatus", () => {
    const entry = baseEntry({ email3_state: "campaign_created", email3_decided_at: new Date((T0 - 1 * DAY) * 1000).toISOString() });
    const lot = kitLot({ status: "scheduled" });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ kitLots: [lot] }));
    assert.equal(result.email3.provider, "kit");
    assert.equal(result.email3.stage, "agendado");
    assert.equal(result.email3.campaignOrBroadcastId, 999);
  });

  it("lote Kit completed vira 'enviado'", () => {
    const entry = baseEntry({ email3_state: "campaign_created" });
    const lot = kitLot({ status: "completed", created_at: new Date((T0 - 20 * DAY) * 1000).toISOString() });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ kitLots: [lot] }));
    assert.equal(result.email3.stage, "enviado");
    assert.equal(result.email3.stale, false); // enviado nunca é "parado"
  });

  it("lote Kit 'pending' (crash entre tag e broadcast) e velho: stale, nomeia ausência de broadcast_id", () => {
    const entry = baseEntry({ email3_state: "campaign_created" });
    const lot = kitLot({ status: "pending", broadcast_id: null, created_at: new Date((T0 - 5 * DAY) * 1000).toISOString() });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ kitLots: [lot] }));
    assert.equal(result.email3.stage, "rascunho_criado");
    assert.equal(result.email3.stale, true);
    assert.match(result.email3.nextAction, /sem id ainda/);
  });

  it("2 lotes históricos (recreate_after_timeout, #7922): usa o mais RECENTE, nunca conta 2x", () => {
    const entry = baseEntry({ email3_state: "campaign_created" });
    const old = kitLot({ lot_id: "email3-01", broadcast_id: 1, status: "cancelled", created_at: new Date((T0 - 10 * DAY) * 1000).toISOString() });
    const fresh = kitLot({ lot_id: "email3-02", broadcast_id: 2, status: "created", created_at: new Date((T0 - 1 * DAY) * 1000).toISOString() });
    const found = findKitLotForEntry([old, fresh], "email3", "sub_1");
    assert.equal(found?.lot_id, "email3-02");
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ kitLots: [old, fresh] }));
    assert.equal(result.email3.campaignOrBroadcastId, 2);
  });

  it("entrada sem lote Kit correspondente usa o caminho Brevo (coexistência, sem contar 2x)", () => {
    const brevoEntry = baseEntry({ subscription_id: "sub_brevo", email3_state: "campaign_created", email3_campaign_id: 111 });
    const kitEntry = baseEntry({ subscription_id: "sub_kit", email: "kit@example.com", email3_state: "campaign_created" });
    const lot = kitLot({ recipient_subscription_ids: ["sub_kit"], recipient_emails: ["kit@example.com"] });
    const opts = baseOpts({ kitLots: [lot] });
    const rBrevo = buildOnboardingFunnelEntry(brevoEntry, opts);
    const rKit = buildOnboardingFunnelEntry(kitEntry, opts);
    assert.equal(rBrevo.email3.provider, "brevo");
    assert.equal(rKit.email3.provider, "kit");
  });
});

describe("onboarding-funnel-report — coorte histórica ainda em espera", () => {
  it("sem âncora (nunca confirmou assinatura): aguardando_confirmacao, terminal por ora", () => {
    const entry = baseEntry({ email1_sent_at: null, email2_sent_at: null, status_detectado: "pending" });
    const result = buildOnboardingFunnelEntry(entry, baseOpts());
    assert.equal(result.email3.stage, "aguardando_confirmacao");
    assert.equal(result.confirmedAt, null);
  });

  it("D+10 ainda não venceu: not_due com contagem regressiva", () => {
    const entry = baseEntry({ email1_sent_at: new Date((T0 - 2 * DAY) * 1000).toISOString() });
    const result = buildOnboardingFunnelEntry(entry, baseOpts());
    assert.equal(result.email3.stage, "not_due");
    assert.match(result.email3.nextAction, /faltam \d+ dia/);
  });

  it("D+10 venceu, dentro da janela de tolerância, sem stats: aguardando_dados, não-stale", () => {
    const entry = baseEntry({ email1_sent_at: new Date((T0 - 11 * DAY) * 1000).toISOString() });
    const result = buildOnboardingFunnelEntry(entry, baseOpts());
    assert.equal(result.email3.stage, "aguardando_dados");
    assert.equal(result.email3.stale, false);
  });

  it("além da janela de tolerância ainda pendente: aguardando_dados marcado stale (anômalo)", () => {
    const entry = baseEntry({ email1_sent_at: new Date((T0 - 14 * DAY) * 1000).toISOString() });
    const result = buildOnboardingFunnelEntry(entry, baseOpts());
    assert.equal(result.email3.stage, "aguardando_dados");
    assert.equal(result.email3.stale, true);
  });

  it("skipped_no_open/skipped_inactive/skipped_sem_dados são terminais sem próxima ação de reenvio", () => {
    for (const state of ["skipped_no_open", "skipped_inactive", "skipped_sem_dados"] as const) {
      const entry = baseEntry({ email3_state: state, email3_decided_at: new Date((T0 - 5 * DAY) * 1000).toISOString() });
      const result = buildOnboardingFunnelEntry(entry, baseOpts());
      assert.equal(result.email3.stage, state);
      assert.equal(result.email3.stale, false);
      assert.ok(result.email3.nextAction.startsWith("nenhuma"));
    }
  });
});

describe("onboarding-funnel-report — pagamentos sem vínculo conclusivo (#7916)", () => {
  const apoiador: LinkableApoiador = { emails: ["apoiador@example.com"], firstConfirmedAt: "2026-09-10T00:00:00.000Z", currentMonthlyValue: 25 };
  const index = buildApoiadorEmailIndex([apoiador]);

  it("sem apoiadorIndex injetado: apoiador fica null (nunca {linked:false} fabricado)", () => {
    const entry = baseEntry();
    const result = buildOnboardingFunnelEntry(entry, baseOpts());
    assert.equal(result.apoiador, null);
  });

  it("com índice mas sem match por e-mail: linked=false, explícito (não nulo)", () => {
    const entry = baseEntry({ email: "sem-vinculo@example.com" });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ apoiadorIndex: index }));
    assert.deepEqual(result.apoiador, { linked: false, firstConfirmedAt: null, daysToFirstApoio: null });
  });

  it("com índice e match: linked=true, dias até 1º apoio calculado — sem afirmar causalidade", () => {
    const entry = baseEntry({ email: "apoiador@example.com", detected_at: "2026-09-01T00:00:00.000Z" });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ apoiadorIndex: index }));
    assert.equal(result.apoiador?.linked, true);
    assert.equal(result.apoiador?.firstConfirmedAt, "2026-09-10T00:00:00.000Z");
    assert.equal(result.apoiador?.daysToFirstApoio, 9);
  });
});

describe("summarizeOnboardingFunnel — agregado de coorte", () => {
  function toFunnelEntry(entry: OnboardingEntry, opts?: Partial<BuildFunnelEntryOptions>): OnboardingFunnelEntry {
    return buildOnboardingFunnelEntry(entry, baseOpts(opts));
  }

  it("exclui seeded_by do agregado automático (#7665/#7675)", () => {
    const auto = baseEntry({ subscription_id: "auto", email3_state: "campaign_created", email3_decided_at: new Date((T0 - 1 * DAY) * 1000).toISOString() });
    const seeded = baseEntry({ subscription_id: "seeded", seeded_by: "#7665", email3_state: "campaign_created" });
    const summary = summarizeOnboardingFunnel([toFunnelEntry(auto), toFunnelEntry(seeded)]);
    assert.equal(summary.total, 2);
    assert.equal(summary.seededExcluded, 1);
    assert.equal(summary.byEmail3Stage.rascunho_criado, 1);
  });

  it("nunca fabrica cliquesRastreados — sempre null", () => {
    const summary = summarizeOnboardingFunnel([]);
    assert.equal(summary.cohort.cliquesRastreados, null);
  });

  it("semIndiceApoiador true quando nenhuma entrada teve o índice injetado", () => {
    const entry = baseEntry();
    const summary = summarizeOnboardingFunnel([toFunnelEntry(entry)]);
    assert.equal(summary.cohort.semIndiceApoiador, true);
    assert.equal(summary.cohort.primeirosApoiosConfirmados, 0);
  });

  it("staleDrafts ordenado por idade decrescente e conta só quem está de fato parado", () => {
    const fresh = baseEntry({
      subscription_id: "fresh",
      email3_state: "campaign_created",
      email3_campaign_id: 1,
      email3_decided_at: new Date((T0 - 1 * DAY) * 1000).toISOString(),
    });
    const old = baseEntry({
      subscription_id: "old",
      email3_state: "campaign_created",
      email3_campaign_id: 2,
      email3_decided_at: new Date((T0 - 9 * DAY) * 1000).toISOString(),
    });
    const summary = summarizeOnboardingFunnel([toFunnelEntry(fresh), toFunnelEntry(old)]);
    assert.equal(summary.staleDrafts.length, 1);
    assert.equal(summary.staleDrafts[0].subscriptionId, "old");
  });

  it("convitesCriados conta rascunho+agendado+enviado; convitesEnviados só enviado", () => {
    const draft = baseEntry({ subscription_id: "s1", email3_state: "campaign_created", email3_decided_at: new Date((T0 - 1 * DAY) * 1000).toISOString() });
    const sent = baseEntry({ subscription_id: "s2", email3_state: "campaign_created", email3_campaign_id: 3 });
    const summary = summarizeOnboardingFunnel([
      toFunnelEntry(draft),
      buildOnboardingFunnelEntry(sent, baseOpts({ brevoCampaignState: { status: "sent" } })),
    ]);
    assert.equal(summary.cohort.convitesCriados, 2);
    assert.equal(summary.cohort.convitesEnviados, 1);
  });
});
