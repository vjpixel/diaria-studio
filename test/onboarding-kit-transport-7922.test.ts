/**
 * test/onboarding-kit-transport-7922.test.ts (#7922 fatia 1/N)
 *
 * Cobre a lista de critérios de aceite da issue para o núcleo puro de
 * `scripts/lib/onboarding-kit-transport.ts` — filtro vazio, destinatário
 * errado, descadastro, confirmação tardia, duas rodadas concorrentes,
 * timeout após criação, reexecução (retry) e falha de consulta.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildLotId,
  buildLotTagName,
  planLot,
  selectEligibleKitRecipients,
  buildOnboardingLotFilter,
  buildOnboardingBroadcastInput,
  assertEmail3ScheduleAuthorized,
  decideLotReconciliation,
  reconcileLotWithKit,
  mapKitBroadcastStatusToLocal,
  LOT_STALE_AFTER_MS,
  type OnboardingKitCandidate,
  type OnboardingKitLot,
} from "../scripts/lib/onboarding-kit-transport.ts";
import { buildAllSubscribersFilter, type KitSubscriberFilter } from "../scripts/lib/kit-broadcasts.ts";

function candidate(over: Partial<OnboardingKitCandidate> = {}): OnboardingKitCandidate {
  return {
    subscription_id: "42",
    email: "novo@example.com",
    kit_subscriber_id: 42,
    kit_state: "active",
    seeded_by: null,
    ...over,
  };
}

function lot(over: Partial<OnboardingKitLot> = {}): OnboardingKitLot {
  return {
    lot_id: "email1-2026-09-15-01",
    kind: "email1",
    tag_name: "onboarding-email1-2026-09-15-01",
    tag_id: 7,
    broadcast_id: null,
    recipient_subscription_ids: ["42"],
    recipient_emails: ["novo@example.com"],
    status: "pending",
    created_at: new Date().toISOString(),
    send_at: null,
    last_reconciled_at: null,
    last_error: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Identidade do lote
// ---------------------------------------------------------------------------

describe("buildLotId / buildLotTagName — determinismo", () => {
  it("mesma chave (kind, data, seq) produz sempre o mesmo id/tag", () => {
    assert.equal(buildLotId("email1", "2026-09-15", 1), "email1-2026-09-15-01");
    assert.equal(buildLotTagName("email1-2026-09-15-01"), "onboarding-email1-2026-09-15-01");
  });

  it("seq diferente nunca colide", () => {
    assert.notEqual(buildLotId("email1", "2026-09-15", 1), buildLotId("email1", "2026-09-15", 2));
  });
});

describe("planLot", () => {
  it("recipient_subscription_ids/emails seguem a ordem dos elegíveis", () => {
    const eligible = [candidate({ subscription_id: "1", email: "a@x.com" }), candidate({ subscription_id: "2", email: "b@x.com" })];
    const plan = planLot({ kind: "email2", dateIso: "2026-09-15", seq: 1, eligible });
    assert.deepEqual(plan.recipient_subscription_ids, ["1", "2"]);
    assert.deepEqual(plan.recipient_emails, ["a@x.com", "b@x.com"]);
    assert.equal(plan.tag_name, "onboarding-email2-2026-09-15-01");
  });

  it("lote vazio (0 elegíveis) é um plano válido, sem lançar", () => {
    const plan = planLot({ kind: "email1", dateIso: "2026-09-15", seq: 1, eligible: [] });
    assert.deepEqual(plan.recipient_subscription_ids, []);
  });
});

// ---------------------------------------------------------------------------
// Critério: destinatário errado / descadastro / confirmação tardia
// ---------------------------------------------------------------------------

describe("selectEligibleKitRecipients — wrong recipient / unsubscribe / confirmação tardia", () => {
  it("candidato ativo com id resolvido entra", () => {
    const { eligible, excluded } = selectEligibleKitRecipients([candidate()]);
    assert.equal(eligible.length, 1);
    assert.equal(excluded.length, 0);
  });

  it("descadastrado (kit_state cancelled) é excluído — nunca recebe", () => {
    const { eligible, excluded } = selectEligibleKitRecipients([candidate({ kit_state: "cancelled" })]);
    assert.equal(eligible.length, 0);
    assert.equal(excluded[0].reason, "status_nao_confirmado");
  });

  it("sem kit_subscriber_id é excluído — não dá pra taguear (destinatário errado/não resolvido)", () => {
    const { eligible, excluded } = selectEligibleKitRecipients([candidate({ kit_subscriber_id: null })]);
    assert.equal(eligible.length, 0);
    assert.equal(excluded[0].reason, "sem_kit_subscriber_id");
  });

  it("confirmação tardia: kit_state null (lookup pendente/ainda não confirmado) é excluído nesta rodada...", () => {
    const { eligible, excluded } = selectEligibleKitRecipients([candidate({ kit_state: null })]);
    assert.equal(eligible.length, 0);
    assert.equal(excluded[0].reason, "status_nao_confirmado");
  });

  it("...e passa a ser elegível assim que kit_state vira 'active' numa rodada seguinte", () => {
    const c = candidate({ kit_state: "active" });
    const { eligible } = selectEligibleKitRecipients([c]);
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].email, c.email);
  });

  it("coorte #7665/#7675 (seeded_by presente) é excluída da seleção automática", () => {
    const { eligible, excluded } = selectEligibleKitRecipients([candidate({ seeded_by: "#7665" })]);
    assert.equal(eligible.length, 0);
    assert.equal(excluded[0].reason, "cohort_excluida_manual");
  });

  it("seeded_by vence mesmo se o resto estiver elegível (ordem de checagem não importa pro resultado)", () => {
    const { excluded } = selectEligibleKitRecipients([candidate({ seeded_by: "#7675", kit_state: "active", kit_subscriber_id: 1 })]);
    assert.equal(excluded[0].reason, "cohort_excluida_manual");
  });
});

// ---------------------------------------------------------------------------
// Critério: filtro vazio (nunca base inteira)
// ---------------------------------------------------------------------------

describe("buildOnboardingLotFilter — nunca vazio/base inteira", () => {
  it("tagId válido produz filtro de tag", () => {
    const filter = buildOnboardingLotFilter(99);
    assert.deepEqual(filter, [{ all: [{ type: "tag", ids: [99] }] }]);
  });

  it("tagId 0 é recusado (runtime)", () => {
    assert.throws(() => buildOnboardingLotFilter(0), /tagId inválido/);
  });

  it("tagId negativo é recusado", () => {
    assert.throws(() => buildOnboardingLotFilter(-5), /tagId inválido/);
  });

  it("tagId NaN é recusado", () => {
    assert.throws(() => buildOnboardingLotFilter(Number.NaN), /tagId inválido/);
  });

  it("o tipo de retorno exclui a sentinela de base inteira em compilação", () => {
    const filter: KitSubscriberFilter = buildOnboardingLotFilter(1);
    // @ts-expect-error AllSubscribersFilter não é atribuível a KitSubscriberFilter
    const _neverAllSubscribers: KitSubscriberFilter = buildAllSubscribersFilter();
    assert.ok(filter);
    assert.ok(_neverAllSubscribers);
  });
});

describe("buildOnboardingBroadcastInput — public:false e D+10 sempre rascunho", () => {
  it("email1/email2 aceitam send_at explícito e embutem public:false", () => {
    const input = buildOnboardingBroadcastInput({
      kind: "email1",
      subject: "Bem-vindo",
      content: "<p>oi</p>",
      tagId: 5,
      sendAt: "2026-09-15T12:00:00.000Z",
    });
    assert.equal(input.public, false);
    assert.equal(input.send_at, "2026-09-15T12:00:00.000Z");
  });

  it("email3 FORÇA send_at para null mesmo se o caller passar uma data", () => {
    const input = buildOnboardingBroadcastInput({
      kind: "email3",
      subject: "Apoie",
      content: "<p>apoie</p>",
      tagId: 5,
      sendAt: "2026-09-25T12:00:00.000Z",
    });
    assert.equal(input.send_at, null, "e-mail 3 nunca sai de rascunho pela criação — precisa de aprovação humana explícita depois");
    assert.equal(input.public, false);
  });

  it("subscriber_filter nunca é vazio no payload resultante", () => {
    const input = buildOnboardingBroadcastInput({ kind: "email2", subject: "s", content: "c", tagId: 3, sendAt: null });
    assert.notDeepEqual(input.subscriber_filter, []);
  });
});

describe("assertEmail3ScheduleAuthorized — aprovação humana obrigatória pro e-mail 3", () => {
  it("lança para email3 sem aprovação", () => {
    assert.throws(() => assertEmail3ScheduleAuthorized("email3", false), /aprovação humana explícita/);
  });

  it("não lança para email3 com aprovação explícita", () => {
    assert.doesNotThrow(() => assertEmail3ScheduleAuthorized("email3", true));
  });

  it("não lança para email1/email2 independente da flag (guard é específico do e-mail 3)", () => {
    assert.doesNotThrow(() => assertEmail3ScheduleAuthorized("email1", false));
    assert.doesNotThrow(() => assertEmail3ScheduleAuthorized("email2", false));
  });
});

// ---------------------------------------------------------------------------
// Critério: duas rodadas concorrentes / timeout após criação / retry
// ---------------------------------------------------------------------------

describe("decideLotReconciliation — idempotência/mutex", () => {
  it("nenhum lote local ainda → seguro criar", () => {
    assert.deepEqual(decideLotReconciliation(null, Date.now()), { action: "create" });
  });

  it("lote com broadcast_id confirmado (created/scheduled/completed) → reusa, NUNCA recria (retry)", () => {
    for (const status of ["created", "scheduled", "completed"] as const) {
      const decision = decideLotReconciliation(lot({ broadcast_id: 111, status }), Date.now());
      assert.equal(decision.action, "reuse");
    }
  });

  it("lote cancelado localmente → seguro criar de novo (cancelamento reabre a chave)", () => {
    const decision = decideLotReconciliation(lot({ broadcast_id: 111, status: "cancelled" }), Date.now());
    assert.equal(decision.action, "create");
  });

  it("duas rodadas concorrentes: lote pending SEM broadcast, criado AGORA → bloqueia a 2ª rodada", () => {
    const nowMs = Date.now();
    const recent = lot({ status: "pending", broadcast_id: null, created_at: new Date(nowMs - 1_000).toISOString() });
    const decision = decideLotReconciliation(recent, nowMs);
    assert.equal(decision.action, "blocked_concurrent");
  });

  it("timeout após criação: lote pending SEM broadcast, mais velho que LOT_STALE_AFTER_MS → seguro recriar", () => {
    const nowMs = Date.now();
    const stale = lot({ status: "pending", broadcast_id: null, created_at: new Date(nowMs - LOT_STALE_AFTER_MS - 1_000).toISOString() });
    const decision = decideLotReconciliation(stale, nowMs);
    assert.equal(decision.action, "recreate_after_timeout");
  });

  it("data local ILEGÍVEL é tratada como recente (fail-safe cauteloso — nunca recria por engano)", () => {
    const nowMs = Date.now();
    const corrupted = lot({ status: "pending", broadcast_id: null, created_at: "não é uma data" });
    const decision = decideLotReconciliation(corrupted, nowMs);
    assert.equal(decision.action, "blocked_concurrent");
  });
});

// ---------------------------------------------------------------------------
// Critério: falha de consulta nunca autoriza recriação
// ---------------------------------------------------------------------------

describe("reconcileLotWithKit — failed lookup nunca autoriza recriação", () => {
  it("lote sem broadcast_id devolve intocado sem chamar fetchBroadcast", async () => {
    const l = lot({ broadcast_id: null });
    let called = false;
    const result = await reconcileLotWithKit(l, async () => {
      called = true;
      return { status: "draft" };
    });
    assert.equal(called, false);
    assert.deepEqual(result, l);
  });

  it("lookup bem-sucedido atualiza o status local a partir do Kit", async () => {
    const l = lot({ broadcast_id: 55, status: "pending" });
    const result = await reconcileLotWithKit(l, async () => ({ status: "scheduled" }));
    assert.equal(result.status, "scheduled");
    assert.ok(result.last_reconciled_at);
  });

  it("lookup que FALHA propaga o erro — nunca vira 'não existe, pode recriar'", async () => {
    const l = lot({ broadcast_id: 55, status: "created" });
    await assert.rejects(
      reconcileLotWithKit(l, async () => {
        throw new Error("rede indisponível");
      }),
      /rede indisponível/,
    );
  });

  it("depois de um lookup falho, decideLotReconciliation (sobre o lote ORIGINAL, intocado) continua vendo 'reuse' — nunca 'create'", async () => {
    const l = lot({ broadcast_id: 55, status: "created" });
    await assert.rejects(reconcileLotWithKit(l, async () => { throw new Error("timeout"); }));
    // O objeto `l` nunca foi mutado pela chamada que falhou — broadcast_id
    // continua presente, então a decisão de reconciliação nunca abre a porta
    // para uma 2ª criação em cima de um lookup que só falhou, não confirmou ausência.
    const decision = decideLotReconciliation(l, Date.now());
    assert.equal(decision.action, "reuse");
  });
});

describe("mapKitBroadcastStatusToLocal", () => {
  it("mapeia todos os status conhecidos do Kit", () => {
    assert.equal(mapKitBroadcastStatusToLocal("draft"), "created");
    assert.equal(mapKitBroadcastStatusToLocal("scheduled"), "scheduled");
    assert.equal(mapKitBroadcastStatusToLocal("sending"), "completed");
    assert.equal(mapKitBroadcastStatusToLocal("completed"), "completed");
    assert.equal(mapKitBroadcastStatusToLocal("aborted"), "cancelled");
  });
});
