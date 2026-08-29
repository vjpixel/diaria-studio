/**
 * test/sync-kit-inactive-to-brevo-6340.test.ts (#6340 item 3)
 *
 * Cobre o diff puro (dedup pelo store compartilhado, filtro MV opcional) e
 * o mapeamento do shape Kit — mesma disciplina de teste de
 * `test/sync-pending-to-brevo-4266.test.ts`, sem repetir cobertura de
 * funções REUSADAS de lá (já testadas naquele arquivo: `computeAvailableSlots`,
 * `applyRolloutGuardrailGate`, `applyMaxAddGate`, `computeCurrentActiveCount`,
 * `ingestContactToBrevo`, `assertStoreFileGuard`, `loadMvVerifiedEmails`,
 * `assertMvGuardAcknowledged`, `selectContactsForBackfill`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapKitInactiveSubscribers,
  computeKitContactsToIngest,
  type KitInactiveSubscriber,
} from "../scripts/sync-kit-inactive-to-brevo.ts";
import { KIT_ORIGIN_ID_PREFIX, parseKitSubscriberId } from "../scripts/evaluate-brevo-diaria.ts";
import type { KitSubscriberSummary } from "../scripts/lib/kit-subscribers.ts";
import type { BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";

describe("mapKitInactiveSubscribers — traduz shape Kit + normaliza email (#6340)", () => {
  it("mapeia id/email e normaliza (lowercase/trim)", () => {
    const raw: KitSubscriberSummary[] = [
      { id: 42, email_address: "  A@B.com ", state: "inactive", created_at: "2026-08-26T00:00:00Z" },
    ];
    const out = mapKitInactiveSubscribers(raw);
    assert.deepEqual(out, [{ kit_subscriber_id: 42, email: "a@b.com" }]);
  });

  it("lista vazia → lista vazia", () => {
    assert.deepEqual(mapKitInactiveSubscribers([]), []);
  });
});

describe("computeKitContactsToIngest — dedup pelo store COMPARTILHADO com sync-pending-to-brevo.ts, nunca pelo Kit (#6340)", () => {
  it("assinante Kit inactive ausente do store → entra na lista de ingestão, com prefixo kit: (#6340)", () => {
    const inactive: KitInactiveSubscriber[] = [{ kit_subscriber_id: 7, email: "a@b.com" }];
    const store: BrevoDiariaStore = { contacts: [] };
    const out = computeKitContactsToIngest(inactive, store);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { email: "a@b.com", beehiiv_subscription_id: "kit:7" });
  });

  it("contato já no store (independente de ter entrado via Beehiiv OU Kit) → NUNCA re-ingerido", () => {
    const inactive: KitInactiveSubscriber[] = [
      { kit_subscriber_id: 1, email: "a@b.com" }, // já in_brevo via Beehiiv pending
      { kit_subscriber_id: 2, email: "b@b.com" }, // já suppressed via Kit anteriormente
      { kit_subscriber_id: 3, email: "c@b.com" }, // novo
    ];
    const store: BrevoDiariaStore = {
      contacts: [
        {
          email: "a@b.com",
          beehiiv_subscription_id: "sub_beehiiv_1",
          status: "in_brevo",
          opens_count: 0,
          sends_count: 0,
          last_open_rate: null,
          added_at: "x",
          last_evaluated_at: null,
        },
        {
          email: "b@b.com",
          beehiiv_subscription_id: "kit:99",
          status: "suppressed",
          opens_count: 0,
          sends_count: 5,
          last_open_rate: 0,
          added_at: "x",
          last_evaluated_at: "y",
          suppressed_at: "z",
          resolution_reason: "score_threshold",
        },
      ],
    };
    const out = computeKitContactsToIngest(inactive, store);
    assert.equal(out.length, 1);
    assert.equal(out[0].email, "c@b.com");
  });

  it("dedup interno da própria listagem Kit (mesmo email 2x)", () => {
    const inactive: KitInactiveSubscriber[] = [
      { kit_subscriber_id: 1, email: "a@b.com" },
      { kit_subscriber_id: 2, email: "a@b.com" },
    ];
    const out = computeKitContactsToIngest(inactive, { contacts: [] });
    assert.equal(out.length, 1);
  });

  it("com verifiedEmails: filtra pra só quem passou no MillionVerifier", () => {
    const inactive: KitInactiveSubscriber[] = [
      { kit_subscriber_id: 1, email: "verificado@b.com" },
      { kit_subscriber_id: 2, email: "nunca-verificado@b.com" },
    ];
    const verified = new Set(["verificado@b.com"]);
    const out = computeKitContactsToIngest(inactive, { contacts: [] }, verified);
    assert.equal(out.length, 1);
    assert.equal(out[0].email, "verificado@b.com");
  });

  it("verifiedEmails null (default) → sem filtro de MV, todos elegíveis passam", () => {
    const inactive: KitInactiveSubscriber[] = [{ kit_subscriber_id: 1, email: "a@b.com" }];
    const out = computeKitContactsToIngest(inactive, { contacts: [] }, null);
    assert.equal(out.length, 1);
  });

  // #6340 item 4 fix D (review pós-merge): produtor (este arquivo, via
  // `computeKitContactsToIngest`) e consumidor (`evaluate-brevo-diaria.ts`,
  // via `parseKitSubscriberId`) usam a MESMA constante importada
  // (`KIT_ORIGIN_ID_PREFIX`) — antes deste fix o produtor escrevia o literal
  // `"kit:"` hardcoded, e nada travava os dois juntos. Este teste falha se
  // um dos dois lados voltar a divergir da constante compartilhada (ex: um
  // rename futuro de `KIT_ORIGIN_ID_PREFIX` só de um lado).
  it("#6340 item 4 fix D — o beehiiv_subscription_id produzido usa KIT_ORIGIN_ID_PREFIX (não um literal 'kit:' solto), e o consumidor consegue fazer o parse de volta", () => {
    const inactive: KitInactiveSubscriber[] = [{ kit_subscriber_id: 999, email: "produtor-consumidor@b.com" }];
    const out = computeKitContactsToIngest(inactive, { contacts: [] });
    assert.equal(out.length, 1);
    assert.equal(out[0].beehiiv_subscription_id, `${KIT_ORIGIN_ID_PREFIX}999`, "o produtor precisa usar a MESMA constante que o consumidor importa");
    assert.deepEqual(
      parseKitSubscriberId(out[0].beehiiv_subscription_id),
      { kind: "kit-valid", id: 999 },
      "o consumidor (evaluate-brevo-diaria.ts) precisa conseguir extrair o id de volta do que o produtor escreveu",
    );
  });
});
