/**
 * #8753 — contato aguardando auto-confirmação no Kit (#8728) passa a ter data
 * de início no store, e quem passa do prazo é reportado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  markAwaitingKitConfirmation,
  findStaleAwaitingKitConfirmation,
  AWAITING_KIT_CONFIRMATION_STALE_DAYS,
  type BrevoDiariaContact,
  type BrevoDiariaStore,
} from "../scripts/lib/brevo-diaria-store.ts";

function contact(email: string, over: Partial<BrevoDiariaContact> = {}): BrevoDiariaContact {
  return {
    email,
    beehiiv_subscription_id: "sub",
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_open_rate: null,
    added_at: "2026-09-01T00:00:00.000Z",
    last_evaluated_at: null,
    ...over,
  };
}

describe("awaiting_kit_confirmation_since (#8753)", () => {
  it("marca só na 1ª vez (preserva o início da espera)", () => {
    let store: BrevoDiariaStore = { contacts: [contact("a@x.com")] };
    store = markAwaitingKitConfirmation(store, "a@x.com", "2026-09-10T00:00:00.000Z");
    store = markAwaitingKitConfirmation(store, "A@x.com", "2026-09-20T00:00:00.000Z");
    assert.equal(store.contacts[0].awaiting_kit_confirmation_since, "2026-09-10T00:00:00.000Z");
  });

  it("não marca contato fora de in_brevo", () => {
    const store = markAwaitingKitConfirmation({ contacts: [contact("a@x.com", { status: "suppressed" })] }, "a@x.com");
    assert.equal(store.contacts[0].awaiting_kit_confirmation_since, undefined);
  });

  it(`reporta só in_brevo aguardando há mais de ${AWAITING_KIT_CONFIRMATION_STALE_DAYS} dias`, () => {
    const store: BrevoDiariaStore = {
      contacts: [
        contact("velho@x.com", { awaiting_kit_confirmation_since: "2026-09-01T00:00:00.000Z" }),
        contact("novo@x.com", { awaiting_kit_confirmation_since: "2026-09-22T00:00:00.000Z" }),
        contact("saiu@x.com", { status: "promoted_beehiiv", awaiting_kit_confirmation_since: "2026-09-01T00:00:00.000Z" }),
        contact("nunca@x.com"),
      ],
    };
    const stale = findStaleAwaitingKitConfirmation(store, "2026-09-24T00:00:00.000Z");
    assert.deepEqual(stale, [{ email: "velho@x.com", since: "2026-09-01T00:00:00.000Z", days: 23 }]);
  });
});
