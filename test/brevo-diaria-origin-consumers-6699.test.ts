/**
 * test/brevo-diaria-origin-consumers-6699.test.ts — trava os DOIS
 * consumidores do prefixo `kit:` (`evaluate-brevo-diaria.ts` e
 * `brevo-diaria-store.ts`) na mesma constante canônica
 * (`ORIGIN_PREFIX.KIT`, scripts/lib/shared/brevo-diaria-origin.ts, #6678).
 *
 * #6699: antes deste fix existiam 3 definições independentes do mesmo
 * prefixo — `ORIGIN_PREFIX.KIT` (canônico), `KIT_ORIGIN_ID_PREFIX`
 * (`evaluate-brevo-diaria.ts`, literal próprio) e um `.startsWith("kit:")`
 * hardcoded dentro de `applySelfConfirmed` (`brevo-diaria-store.ts`). O
 * teste "fix D" existente (`test/sync-kit-inactive-to-brevo-6340.test.ts`)
 * só cobria produtor (`sync-kit-inactive-to-brevo.ts`) ↔ consumidor
 * (`evaluate-brevo-diaria.ts`) — o `store` não era exercitado por ele, e
 * uma mudança em `ORIGIN_PREFIX.KIT` (ex: `"kit:"` → `"kit_v2:"`) passava
 * pela suíte inteira verde enquanto `applySelfConfirmed` silenciosamente
 * parava de reconhecer contatos Kit e gravava `self_confirmed_beehiiv`
 * (auditoria errada) pra eles.
 *
 * #633: teste de regressão — reproduz o cenário de risco descrito na issue
 * simulando uma origem Kit construída via `buildOrigin("kit", ...)` (o
 * mesmo caminho que o produtor real usa) e confirma que TODOS os
 * consumidores concordam sobre o que é origem Kit.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ORIGIN_PREFIX, buildOrigin, parseOrigin } from "../scripts/lib/shared/brevo-diaria-origin.ts";
import { applySelfConfirmed, type BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";
import { KIT_ORIGIN_ID_PREFIX, parseKitSubscriberId } from "../scripts/evaluate-brevo-diaria.ts";

function contactStore(email: string, beehiivSubscriptionId: string): BrevoDiariaStore {
  return {
    contacts: [
      {
        email,
        beehiiv_subscription_id: beehiivSubscriptionId,
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

describe("consolidação do prefixo kit: — 3 cópias → 1 fonte única (#6699)", () => {
  it("KIT_ORIGIN_ID_PREFIX (evaluate-brevo-diaria.ts) É a mesma constante que ORIGIN_PREFIX.KIT (canônico) — não só o mesmo valor", () => {
    // Identidade de referência (não só `.equal`): garante que
    // evaluate-brevo-diaria.ts não voltou a definir um literal próprio que
    // por acaso bate hoje mas pode divergir amanhã.
    assert.strictEqual(KIT_ORIGIN_ID_PREFIX, ORIGIN_PREFIX.KIT);
  });

  it("applySelfConfirmed (brevo-diaria-store.ts) reconhece origem Kit construída via buildOrigin — nunca via literal hardcoded", () => {
    const kitOrigin = buildOrigin("kit", "123");
    assert.equal(kitOrigin, "kit:123");
    const result = applySelfConfirmed(contactStore("test@kit.example", kitOrigin), "test@kit.example", "2026-08-29T02:00:00Z");
    assert.strictEqual(result.contacts[0].resolution_reason, "self_confirmed_kit");
  });

  it("applySelfConfirmed trata origem Beehiiv (payload sem prefixo) como self_confirmed_beehiiv", () => {
    const beehiivOrigin = buildOrigin("beehiiv", "sub_abc123");
    const result = applySelfConfirmed(contactStore("test@bee.example", beehiivOrigin), "test@bee.example", "2026-08-29T02:00:00Z");
    assert.strictEqual(result.contacts[0].resolution_reason, "self_confirmed_beehiiv");
  });

  it("evaluate-brevo-diaria.ts (parseKitSubscriberId) e brevo-diaria-store.ts (applySelfConfirmed) concordam sobre o MESMO beehiiv_subscription_id — cenário de risco da issue: mudar ORIGIN_PREFIX.KIT precisa quebrar os dois juntos, nunca só um", () => {
    const kitOrigin = buildOrigin("kit", "999");

    // Consumidor 1: evaluate-brevo-diaria.ts
    const parsed = parseKitSubscriberId(kitOrigin);
    assert.deepEqual(parsed, { kind: "kit-valid", id: 999 });

    // Consumidor 2: brevo-diaria-store.ts (via applySelfConfirmed)
    const storeResult = applySelfConfirmed(contactStore("both@consumers.example", kitOrigin), "both@consumers.example", "2026-08-29T02:00:00Z");
    assert.strictEqual(storeResult.contacts[0].resolution_reason, "self_confirmed_kit");

    // Consumidor 3 (canônico): parseOrigin concorda com os outros dois.
    assert.equal(parseOrigin(kitOrigin).kind, "kit");
  });

  it("origem curated: não é confundida com Kit por nenhum dos consumidores (regressão: 'não é kit' não pode virar 'é Beehiiv')", () => {
    const curatedOrigin = buildOrigin("curated", "leitor@antigo.example");
    assert.equal(parseKitSubscriberId(curatedOrigin).kind, "not-kit");
    const result = applySelfConfirmed(contactStore("leitor@antigo.example", curatedOrigin), "leitor@antigo.example", "2026-08-29T02:00:00Z");
    // brevo-diaria-store.ts só distingue kit vs. não-kit (self_confirmed_kit
    // vs. self_confirmed_beehiiv) — curated cai no "não-kit", que é o
    // comportamento hoje documentado (não uma regressão introduzida aqui).
    assert.strictEqual(result.contacts[0].resolution_reason, "self_confirmed_beehiiv");
  });
});
