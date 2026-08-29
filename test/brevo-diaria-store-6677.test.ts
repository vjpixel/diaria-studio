import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applySelfConfirmed, type BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";

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
});
