import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applySelfConfirmed, type BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";
import { REATIVAR_CONFIRMOU_VIA_VALUE } from "../scripts/lib/shared/reativar-confirmou-via.ts"; // #8438

function contact(email: string, id: string): BrevoDiariaStore {
  return {
    contacts: [
      {
        email,
        beehiiv_subscription_id: id,
        status: "in_brevo",
        opens_count: 0,
        sends_count: 0,
        last_open_rate: null,
        added_at: "2026-08-01T00:00:00Z",
        last_evaluated_at: null,
      },
    ],
  };
}

describe("applySelfConfirmed (#6677)", () => {
  it("grava self_confirmed_kit para origem Kit", () => {
    const result = applySelfConfirmed(contact("test@kit.example", "kit:123"), "test@kit.example", "2026-08-29T02:00:00Z");
    assert.strictEqual(result.contacts[0].resolution_reason, "self_confirmed_kit");
    assert.strictEqual(result.contacts[0].status, "promoted_beehiiv");
  });

  it("grava self_confirmed_beehiiv para origem Beehiiv", () => {
    const result = applySelfConfirmed(contact("test@bee.example", "456"), "test@bee.example", "2026-08-29T02:00:00Z");
    assert.strictEqual(result.contacts[0].resolution_reason, "self_confirmed_beehiiv");
  });

  // #8438 — `via` OPCIONAL: compatibilidade com callers que não passam (hoje em
  // dia o `evaluate-brevo-diaria.ts` Passo 1 é o único caller passando `via`,
  // e só quando o GET singular do Kit devolve o field).
  it("sem `via` (callers existentes) → comportamento de hoje preservado", () => {
    const result = applySelfConfirmed(contact("test@kit.example", "kit:123"), "test@kit.example", "2026-08-29T02:00:00Z");
    assert.strictEqual(result.contacts[0].resolution_reason, "self_confirmed_kit");
  });

  it("via=REATIVAR_CONFIRMOU_VIA_VALUE em origem Kit → self_confirmed_kit_botao (clicou no botão)", () => {
    const result = applySelfConfirmed(
      contact("test@kit.example", "kit:123"),
      "test@kit.example",
      "2026-08-29T02:00:00Z",
      REATIVAR_CONFIRMOU_VIA_VALUE,
    );
    assert.strictEqual(result.contacts[0].resolution_reason, "self_confirmed_kit_botao");
    assert.strictEqual(result.contacts[0].status, "promoted_beehiiv");
    assert.strictEqual(result.contacts[0].promoted_at, "2026-08-29T02:00:00Z");
  });

  it("via=REATIVAR_CONFIRMOU_VIA_VALUE em origem Beehiiv → self_confirmed_beehiiv (via não descarta Beehiiv)", () => {
    // #8438: o field `confirmou_via` é escrito SÓ no caminho Kit (worker
    // `reativar`), então um contato Beehiiv nunca teria o valor — mas a
    // função não deve mudar o resultado pra origem Beehiiv por causa do
    // `via` (defensivo: via não é um override de origem).
    const result = applySelfConfirmed(
      contact("test@bee.example", "456"),
      "test@bee.example",
      "2026-08-29T02:00:00Z",
      REATIVAR_CONFIRMOU_VIA_VALUE,
    );
    assert.strictEqual(result.contacts[0].resolution_reason, "self_confirmed_beehiiv");
  });

  it("via com outro valor → self_confirmed_kit (não é o botão de reativação)", () => {
    const result = applySelfConfirmed(
      contact("test@kit.example", "kit:123"),
      "test@kit.example",
      "2026-08-29T02:00:00Z",
      "outro-valor",
    );
    assert.strictEqual(result.contacts[0].resolution_reason, "self_confirmed_kit");
  });

  it("contato não in_brevo não é promovido, independente do via", () => {
    const store: BrevoDiariaStore = {
      contacts: [
        {
          email: "test@kit.example",
          beehiiv_subscription_id: "kit:123",
          status: "promoted_beehiiv",
          opens_count: 0,
          sends_count: 0,
          last_open_rate: null,
          added_at: "2026-08-01T00:00:00Z",
          last_evaluated_at: null,
          resolution_reason: "self_confirmed_kit",
          promoted_at: "2026-08-29T02:00:00Z",
        },
      ],
    };
    const result = applySelfConfirmed(store, "test@kit.example", "2026-08-30T00:00:00Z", REATIVAR_CONFIRMOU_VIA_VALUE);
    assert.strictEqual(result.contacts[0].status, "promoted_beehiiv");
    assert.strictEqual(result.contacts[0].resolution_reason, "self_confirmed_kit");
  });
});
