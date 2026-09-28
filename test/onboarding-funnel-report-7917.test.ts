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

  it("campanha Brevo com estado ambíguo (suspended) não promove a enviado — vira estado_ambiguo, não rascunho (#7917 item 4)", () => {
    const entry = baseEntry({
      email3_state: "campaign_created",
      email3_campaign_id: 555,
      email3_decided_at: new Date((T0 - 1 * DAY) * 1000).toISOString(),
    });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ brevoCampaignState: { status: "suspended" } }));
    assert.equal(result.email3.stage, "estado_ambiguo");
    assert.equal(result.email3.provider, "brevo");
    assert.match(result.email3.nextAction, /estado ambíguo/);
  });

  it("campanha Brevo com estado ambíguo (in_review) também vira estado_ambiguo", () => {
    const entry = baseEntry({
      email3_state: "campaign_created",
      email3_campaign_id: 777,
      email3_decided_at: new Date((T0 - 1 * DAY) * 1000).toISOString(),
    });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ brevoCampaignState: { status: "in_review" } }));
    assert.equal(result.email3.stage, "estado_ambiguo");
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

describe("onboarding-funnel-report — e-mail 1 / e-mail 2 (transacionais)", () => {
  it("e-mail 1 enviado: state sent, com brevoMessageId", () => {
    const entry = baseEntry();
    const result = buildOnboardingFunnelEntry(entry, baseOpts());
    assert.equal(result.email1.state, "sent");
    assert.equal(result.email1.sentAt, entry.email1_sent_at);
    assert.equal(result.email1.brevoMessageId, "msg-1");
  });

  it("e-mail 1 nunca enviado + status inativo na detecção: blocked_not_active", () => {
    const entry = baseEntry({ email1_sent_at: null, email1_brevo_id: null, email2_sent_at: null, email2_brevo_id: null, email3_state: "pending", status_detectado: "pending" });
    const result = buildOnboardingFunnelEntry(entry, baseOpts());
    assert.equal(result.email1.state, "blocked_not_active");
  });

  it("e-mail 2 enviado: state sent", () => {
    const entry = baseEntry();
    const result = buildOnboardingFunnelEntry(entry, baseOpts());
    assert.equal(result.email2.state, "sent");
    assert.equal(result.email2.brevoMessageId, "msg-2");
  });

  it("#7917 item 2 (fleet review PR #8955): e-mail 2 ANTES de D+3 vencer e status ainda inativo → not_reached, NUNCA blocked_not_active", () => {
    const entry = baseEntry({
      email1_sent_at: new Date((T0 - 1 * DAY) * 1000).toISOString(), // confirmou há só 1 dia
      email2_sent_at: null,
      email2_brevo_id: null,
      status_detectado: "pending",
    });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ email2Days: 3 }));
    assert.equal(result.email2.state, "not_reached", "antes do gate de tempo, não é 'bloqueado' — só ainda não chegou a hora");
  });

  it("e-mail 2 DEPOIS de D+3 vencido e status inativo: blocked_not_active", () => {
    const entry = baseEntry({
      email1_sent_at: new Date((T0 - 5 * DAY) * 1000).toISOString(),
      email2_sent_at: null,
      email2_brevo_id: null,
      status_detectado: "pending",
    });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ email2Days: 3 }));
    assert.equal(result.email2.state, "blocked_not_active");
  });

  it("e-mail 2 vencido mas status ATIVO: not_reached (só bloqueia por inatividade, não por idade)", () => {
    const entry = baseEntry({
      email1_sent_at: new Date((T0 - 5 * DAY) * 1000).toISOString(),
      email2_sent_at: null,
      email2_brevo_id: null,
      status_detectado: "active",
    });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ email2Days: 3 }));
    assert.equal(result.email2.state, "not_reached");
  });
});

describe("onboarding-funnel-report — Kit lot precede pending (#7917 item 7, fleet review PR #8955)", () => {
  it("email3_state ainda 'pending' MAS lote Kit email3 já existe: usa o estágio do lote Kit, provider kit", () => {
    const entry = baseEntry({ email3_state: "pending", email3_campaign_id: null, email3_decided_at: null });
    const lot = kitLot({ status: "created", broadcast_id: 321 });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ kitLots: [lot] }));
    assert.equal(result.email3.provider, "kit");
    assert.equal(result.email3.stage, "rascunho_criado");
    assert.equal(result.email3.campaignOrBroadcastId, 321);
  });

  it("email3_state 'pending' + lote Kit 'scheduled': agendado, provider kit", () => {
    const entry = baseEntry({ email3_state: "pending" });
    const lot = kitLot({ status: "scheduled", broadcast_id: 654 });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ kitLots: [lot] }));
    assert.equal(result.email3.stage, "agendado");
    assert.equal(result.email3.provider, "kit");
  });

  it("email3_state 'pending' SEM lote Kit: segue o caminho normal de pending (aguardando_confirmacao/not_due/aguardando_dados) — precedência não quebra o caso comum", () => {
    const entry = baseEntry({ email3_state: "pending", email1_sent_at: new Date((T0 - 2 * DAY) * 1000).toISOString() });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ kitLots: [] }));
    assert.equal(result.email3.stage, "not_due");
  });

  it("AMBOS existem (email3_state='campaign_created' local + lote Kit): lote Kit vence (precedência preservada, #7922)", () => {
    const entry = baseEntry({ email3_state: "campaign_created", email3_campaign_id: 111 });
    const lot = kitLot({ status: "completed", broadcast_id: 222 });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ kitLots: [lot] }));
    assert.equal(result.email3.stage, "enviado");
    assert.equal(result.email3.provider, "kit");
    assert.equal(result.email3.campaignOrBroadcastId, 222);
  });
});

describe("onboarding-funnel-report — lote Kit cancelado / kind errado não conta (#7917, fleet review PR #8955)", () => {
  it("lote Kit mais recente é 'cancelled': stage cancelado, mesmo havendo lote mais antigo não-cancelado", () => {
    const entry = baseEntry({ email3_state: "campaign_created" });
    const old = kitLot({ lot_id: "email3-01", broadcast_id: 1, status: "created", created_at: new Date((T0 - 10 * DAY) * 1000).toISOString() });
    const cancelled = kitLot({ lot_id: "email3-02", broadcast_id: 2, status: "cancelled", created_at: new Date((T0 - 1 * DAY) * 1000).toISOString() });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ kitLots: [old, cancelled] }));
    assert.equal(result.email3.stage, "cancelado");
    assert.equal(result.email3.campaignOrBroadcastId, 2);
  });

  it("lote de outro `kind` (email1/email2) para a mesma subscription NUNCA é usado pro estágio de email3", () => {
    const entry = baseEntry({ email3_state: "campaign_created", email3_campaign_id: 999, email3_decided_at: new Date((T0 - 1 * DAY) * 1000).toISOString() });
    const email1Lot = kitLot({ lot_id: "email1-01", kind: "email1", status: "completed", broadcast_id: 5 });
    const result = buildOnboardingFunnelEntry(entry, baseOpts({ kitLots: [email1Lot] }));
    // Sem lote de kind "email3" pra esta entrada — cai no caminho Brevo normal.
    assert.equal(result.email3.provider, "brevo");
    assert.equal(result.email3.campaignOrBroadcastId, 999);
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

  describe("fronteiras exatas (#7917, fleet review PR #8955)", () => {
    it("exatamente no segundo em que D+10 vence: já é aguardando_dados, não mais not_due", () => {
      const entry = baseEntry({ email1_sent_at: new Date((T0 - 10 * DAY) * 1000).toISOString() });
      const result = buildOnboardingFunnelEntry(entry, baseOpts({ email3Days: 10 }));
      assert.equal(result.email3.stage, "aguardando_dados");
    });

    it("1 segundo antes de D+10 vencer: ainda not_due", () => {
      const entry = baseEntry({ email1_sent_at: new Date((T0 - 10 * DAY) * 1000 + 1000).toISOString() });
      const result = buildOnboardingFunnelEntry(entry, baseOpts({ email3Days: 10 }));
      assert.equal(result.email3.stage, "not_due");
    });

    it("exatamente no fim da janela de tolerância (D+10+grace): stale já é true", () => {
      const entry = baseEntry({ email1_sent_at: new Date((T0 - 13 * DAY) * 1000).toISOString() });
      const result = buildOnboardingFunnelEntry(entry, baseOpts({ email3Days: 10, email3GraceDays: 3 }));
      assert.equal(result.email3.stage, "aguardando_dados");
      assert.equal(result.email3.stale, true);
    });

    it("1 segundo antes do fim da janela de tolerância: ainda não-stale", () => {
      const entry = baseEntry({ email1_sent_at: new Date((T0 - 13 * DAY) * 1000 + 1000).toISOString() });
      const result = buildOnboardingFunnelEntry(entry, baseOpts({ email3Days: 10, email3GraceDays: 3 }));
      assert.equal(result.email3.stage, "aguardando_dados");
      assert.equal(result.email3.stale, false);
    });

    it("STALE_DRAFT_DAYS exato (age===3): já stale", () => {
      const entry = baseEntry({
        email3_state: "campaign_created",
        email3_campaign_id: 1,
        email3_decided_at: new Date((T0 - STALE_DRAFT_DAYS * DAY) * 1000).toISOString(),
      });
      const result = buildOnboardingFunnelEntry(entry, baseOpts());
      assert.equal(result.email3.ageDays, STALE_DRAFT_DAYS);
      assert.equal(result.email3.stale, true);
    });

    it("1 dia antes de STALE_DRAFT_DAYS (age===2): ainda não-stale", () => {
      const entry = baseEntry({
        email3_state: "campaign_created",
        email3_campaign_id: 1,
        email3_decided_at: new Date((T0 - (STALE_DRAFT_DAYS - 1) * DAY) * 1000).toISOString(),
      });
      const result = buildOnboardingFunnelEntry(entry, baseOpts());
      assert.equal(result.email3.ageDays, STALE_DRAFT_DAYS - 1);
      assert.equal(result.email3.stale, false);
    });
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

  it("convitesCriados também conta estado_ambiguo (#7917 item 4: foi criado, só o estado de envio é incerto)", () => {
    const ambiguous = baseEntry({ subscription_id: "s3", email3_state: "campaign_created", email3_campaign_id: 4 });
    const summary = summarizeOnboardingFunnel([buildOnboardingFunnelEntry(ambiguous, baseOpts({ brevoCampaignState: { status: "suspended" } }))]);
    assert.equal(summary.byEmail3Stage.estado_ambiguo, 1);
    assert.equal(summary.cohort.convitesCriados, 1);
    assert.equal(summary.cohort.convitesEnviados, 0);
  });

  it("cohort.elegiveis exclui aguardando_confirmacao/not_due, inclui todo o resto (#7917, fleet review PR #8955)", () => {
    const semAncora = baseEntry({ subscription_id: "s-sem-ancora", email1_sent_at: null, email2_sent_at: null, status_detectado: "pending" });
    const naoVencido = baseEntry({ subscription_id: "s-nao-vencido", email1_sent_at: new Date((T0 - 2 * DAY) * 1000).toISOString() });
    const aguardandoDados = baseEntry({ subscription_id: "s-aguardando", email1_sent_at: new Date((T0 - 11 * DAY) * 1000).toISOString() });
    const rascunho = baseEntry({
      subscription_id: "s-rascunho",
      email3_state: "campaign_created",
      email3_campaign_id: 9,
      email3_decided_at: new Date((T0 - 1 * DAY) * 1000).toISOString(),
    });
    const summary = summarizeOnboardingFunnel([
      toFunnelEntry(semAncora),
      toFunnelEntry(naoVencido),
      toFunnelEntry(aguardandoDados),
      toFunnelEntry(rascunho),
    ]);
    // Só "aguardando_confirmacao" (semAncora) e "not_due" (naoVencido) ficam
    // de fora — os outros 2 (aguardando_dados, rascunho_criado) já venceram
    // a régua D+10 e contam como "elegível" mesmo sem convite criado ainda.
    assert.equal(summary.cohort.elegiveis, 2);
  });
});
