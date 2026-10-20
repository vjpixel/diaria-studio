/**
 * test/onboarding-followup-panel-10606.test.ts (#10606, #10605)
 *
 * Painel `/assinantes`: contagem por e-mail (recebidos por transporte,
 * pulados por motivo, pendentes, falhos — sem piloto), tabela por pessoa com
 * e-mail MASCARADO e falha em destaque; contrato do formulário (#10605); e o
 * eixo do alarme de continuidade das sequências.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFollowupPanel, maskEmail, maskInText } from "../scripts/lib/onboarding-followup-panel.ts";
import { emptyStore, type OnboardingEntry } from "../scripts/lib/onboarding-store.ts";
import type { OnboardingKitLot } from "../scripts/lib/onboarding-kit-transport.ts";
import {
  parseFormSubmission,
  parseFormResponsesPayload,
  isAuthorizedResponsesRequest,
  formResponseKey,
  prefillEmailFromQuery,
} from "../scripts/lib/onboarding-form-contract.ts";
import { evaluateContinuityRound, FOLLOWUP_CHECK } from "../scripts/onboarding-continuity-alarm.ts";

function entry(over: Partial<OnboardingEntry>): OnboardingEntry {
  return {
    subscription_id: "1", email: "ana.souza@exemplo.com", status_detectado: "active", created_at: 1_760_000_000,
    detected_at: "2025-10-09T00:00:00Z", email1_sent_at: null, email1_brevo_id: null, email2_sent_at: null, email2_brevo_id: null,
    email3_state: "pending", email3_campaign_id: null, email3_decided_at: null, ...over,
  };
}

function kitLot(over: Partial<OnboardingKitLot>): OnboardingKitLot {
  return {
    lot_id: "email3-2026-10-01-01", kind: "email3", tag_name: "onboarding-email3-2026-10-01-01", tag_id: 1, broadcast_id: 10,
    recipient_subscription_ids: ["3"], recipient_emails: ["c@x.com"], status: "scheduled", created_at: "2026-10-01T12:00:00Z",
    send_at: "2026-10-01T12:05:00Z", last_reconciled_at: null, last_error: null, ...over,
  };
}

describe("#10606 mascaramento", () => {
  it("e-mail nunca sai cru", () => {
    assert.equal(maskEmail("ana.souza@exemplo.com"), "a***@exemplo.com");
    assert.equal(maskEmail("semarroba"), "s***");
    assert.equal(maskEmail(""), "***");
    assert.equal(maskInText("falhou pra bob@x.com e ze@y.org"), "falhou pra b***@x.com e z***@y.org");
  });
});

describe("#10606 contagem por e-mail e por pessoa", () => {
  const store = emptyStore();
  store.entries = {
    "1": entry({ subscription_id: "1", email: "a@x.com", email1_sent_at: "2026-10-01T12:00:00Z", email1_transport: "kit", email1_kit_lot_id: "l1" }),
    "2": entry({ subscription_id: "2", email: "b@x.com", email1_sent_at: "2026-09-01T12:00:00Z", email2_sent_at: "2026-09-04T12:00:00Z", email3_state: "skipped_no_open" }),
    "3": entry({ subscription_id: "3", email: "c@x.com", email1_sent_at: "2026-09-20T12:00:00Z", email1_transport: "kit", email3_state: "campaign_created", email3_kit_lot_id: "email3-2026-10-01-01" }),
    "4": entry({ subscription_id: "4", email: "d@x.com", status_detectado: "inactive" }),
    "5": entry({ subscription_id: "5", email: "e@x.com", email2_sent_at: "SKIPPED_INCIDENTE_260824_MASS_SEND", email1_sent_at: "2026-08-24T12:00:00Z" }),
    "pilot:z": entry({ subscription_id: "pilot:z", email: "z@x.com", email1_sent_at: "2026-10-01T12:00:00Z" }),
  };
  store.kit_transport = { lots: { "email3-2026-10-01-01": kitLot({}) } };
  store.followup = {
    people: {
      "3": { kit_subscriber_id: 3, email: "c@x.com", cadastro_at: "2026-09-20T00:00:00Z", sends: [{ step: "apoio30", at: "2026-10-20T12:05:00Z", lot_id: "a" }, { step: "form", at: "2026-09-26T12:05:00Z", lot_id: "f" }], apoia: false, form_filled_at: null },
      "9": { kit_subscriber_id: 9, email: "x9@y.com", cadastro_at: "2026-01-01T00:00:00Z", sends: [], skips: [{ step: "apoio90", at: "2026-04-01T00:00:00Z", motivo: "apoia" }], apoia: true },
    },
    lots: {},
    last_run: {
      at: "2026-10-20T12:10:00Z", apoio_blocked: null, form_blocked: { motivo: "texto_pendente", detalhe: "data/snippets/formulario-lembrete.md contém ONBOARDING-CORPO-PENDENTE" },
      lots_created: 1, lots_failed: 0, over_cap: 0, lookups_failed: 0,
      counts: { apoio30: { enviado: 1, vencida: 40, espacamento: 2 }, apoio90: { apoia: 1 } },
    },
    consecutive_failed_runs: 0,
  };

  const view = buildFollowupPanel(store, { apoiaByEmail: (e) => e === "b@x.com" });
  const step = (s: string) => view.steps.find((x) => x.step === s)!;

  it("escada: recebidos por transporte, pulados por motivo, pendentes; piloto fora", () => {
    assert.equal(step("email1").recebidos, 4);
    assert.deepEqual(step("email1").porTransporte, { kit: 2, brevo: 2 });
    assert.equal(step("email1").pendentes.aguardando_confirmacao, 1);
    assert.equal(step("email2").recebidos, 1);
    assert.equal(step("email2").pulados.SKIPPED_INCIDENTE_260824_MASS_SEND, 1);
    assert.equal(step("email3").recebidos, 1);
    assert.equal(step("email3").porTransporte.kit, 1);
    assert.equal(step("email3").pulados.skipped_no_open, 1);
  });

  it("sequências: recebidos do registro por pessoa + motivos da última rodada (sem contar 'apoia' 2 vezes)", () => {
    assert.equal(step("apoio30").recebidos, 1);
    assert.equal(step("apoio30").pulados.vencida, 40);
    assert.equal(step("apoio30").pendentes.espacamento, 2);
    assert.equal(step("apoio90").pulados.apoia, 1);
    assert.equal(step("form").recebidos, 1);
    assert.equal(view.blocked.form?.motivo, "texto_pendente");
  });

  it("por pessoa: e-mail mascarado, e-mail 3 conta como pedido de apoio, formulário e 'apoia'", () => {
    const c = view.people.find((r) => r.key === "3")!;
    assert.equal(c.emailMasked, "c***@x.com");
    assert.equal(c.apoioRecebidos, 2, "e-mail 3 + D+30");
    assert.equal(c.formRecebidos, 1);
    assert.equal(c.apoia, false);
    assert.equal(view.people.find((r) => r.key === "9")!.apoia, true);
    assert.equal(view.people.find((r) => r.key === "2")!.apoia, true, "índice de apoiadores do Studio");
    assert.ok(!view.people.some((r) => r.key.startsWith("pilot:")));
    assert.ok(view.people.every((r) => !/^[^*]+@/.test(r.emailMasked)), "nenhum e-mail cru");
    // Ordem padrão: quem não apoia e recebeu mais pedidos de apoio primeiro.
    assert.equal(view.people[0].key, "3");
  });

  it("falha em rodadas seguidas aparece no topo", () => {
    assert.equal(view.alerts.length, 0);
    const bad = { ...store, consecutive_email3_failures: 3, last_email3_error: "Folder id is missing (a@x.com)", followup: { ...store.followup!, consecutive_failed_runs: 2 } };
    const v2 = buildFollowupPanel(bad);
    assert.equal(v2.alerts.length, 2);
    assert.ok(v2.alerts.every((a) => !a.mensagem.includes("a@x.com")));
  });
});

describe("#10623 e-mail 3 da Brevo: rascunho pré-#10603 não conta como recebido", () => {
  it("campaign_created sem email3_scheduled_at fica em pendentes; com ele conta como brevo", () => {
    const store = emptyStore();
    store.entries = {
      "1": entry({ subscription_id: "1", email: "a@x.com", email3_state: "campaign_created", email3_campaign_id: 77, email3_decided_at: "2026-09-01T12:00:00Z" }),
      "2": entry({ subscription_id: "2", email: "b@x.com", email3_state: "campaign_created", email3_campaign_id: 88, email3_decided_at: "2026-10-20T12:00:00Z", email3_scheduled_at: "2026-10-20T12:00:00Z" }),
    };
    const view = buildFollowupPanel(store);
    const e3 = view.steps.find((x) => x.step === "email3")!;
    assert.equal(e3.recebidos, 1);
    assert.deepEqual(e3.porTransporte, { kit: 0, brevo: 1 });
    assert.equal(e3.pendentes.rascunho_brevo_sem_envio_confirmado, 1);
    assert.equal(view.people.find((r) => r.key === "1")!.apoioRecebidos, 0, "rascunho não é pedido de apoio recebido");
    assert.equal(view.people.find((r) => r.key === "2")!.apoioRecebidos, 1);
  });
});

describe("#10605 contrato do formulário", () => {
  const qs = [
    { id: "area", label: "Área", kind: "select" as const, options: ["tech", "direito"], required: true },
    { id: "interesses", label: "Interesses", kind: "textarea" as const },
  ];
  it("valida e-mail, obrigatórias, opções e descarta campo desconhecido", () => {
    const ok = parseFormSubmission({ email: " Ana@X.com ", area: "tech", interesses: "IA", hack: "x" }, qs);
    assert.deepEqual(ok, { ok: true, submission: { email: "ana@x.com", answers: { area: "tech", interesses: "IA" } } });
    assert.equal(parseFormSubmission({ email: "nope", area: "tech" }, qs).ok, false);
    assert.equal(parseFormSubmission({ email: "a@x.com" }, qs).ok, false);
    assert.equal(parseFormSubmission({ email: "a@x.com", area: "outra" }, qs).ok, false);
  });
  it("payload malformado lança (nunca vira 'ninguém preencheu')", () => {
    assert.throws(() => parseFormResponsesPayload({}));
    assert.throws(() => parseFormResponsesPayload({ responses: [{ email: "a@x.com" }] }));
    assert.deepEqual(parseFormResponsesPayload({ responses: [{ email: "A@x.com", submitted_at: "2026-10-20T00:00:00Z", answers: { a: "1", b: 2 } }] }), [
      { email: "a@x.com", submitted_at: "2026-10-20T00:00:00Z", answers: { a: "1" } },
    ]);
  });
  it("endpoint de respostas exige o token; chave KV por e-mail normalizado", () => {
    assert.equal(isAuthorizedResponsesRequest("Bearer abc", "abc"), true);
    assert.equal(isAuthorizedResponsesRequest("Bearer abd", "abc"), false);
    assert.equal(isAuthorizedResponsesRequest(null, "abc"), false);
    assert.equal(isAuthorizedResponsesRequest("Bearer ", undefined), false);
    assert.equal(formResponseKey(" A@X.com"), "resp:a@x.com");
  });
  it("#10623 prefill: o + do e-mail cru (sem url_encode) volta da query como espaço e é restaurado", () => {
    const q = new URL("https://f.example/?email=ana+news@x.com").searchParams.get("email");
    assert.equal(q, "ana news@x.com");
    assert.equal(prefillEmailFromQuery(q), "ana+news@x.com");
    assert.equal(prefillEmailFromQuery(null), "");
    assert.equal(prefillEmailFromQuery(new URL("https://f.example/?email=a.b@x.com").searchParams.get("email")), "a.b@x.com");
  });
});

describe("#10604 alarme de continuidade: eixo das sequências", () => {
  const base = {
    storeExists: true,
    corrupted: false,
    store: { consecutive_zero_detections: 0, last_zero_detection_run_at: new Date().toISOString(), kit_transport: { lots: {} } },
    cfgRead: { enabled: false, error: null },
  };
  it("ligado sem rodada registrada vira achado; desligado entra sem achado (fecha issue aberta)", () => {
    const on = evaluateContinuityRound({ ...base, followupCfgRead: { enabled: true, error: null } });
    assert.ok(on.findings.some((f) => f.check === FOLLOWUP_CHECK));
    const off = evaluateContinuityRound({ ...base, followupCfgRead: { enabled: false, error: null } });
    assert.ok(off.evaluatedChecks.has(FOLLOWUP_CHECK));
    assert.ok(!off.findings.some((f) => f.check === FOLLOWUP_CHECK));
    const unread = evaluateContinuityRound({ ...base, followupCfgRead: { enabled: undefined, error: "boom" } });
    assert.ok(!unread.evaluatedChecks.has(FOLLOWUP_CHECK));
  });
});
