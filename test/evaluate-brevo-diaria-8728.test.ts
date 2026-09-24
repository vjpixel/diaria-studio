/**
 * test/evaluate-brevo-diaria-8728.test.ts (#8728)
 *
 * Regressão pro fix da issue #8728: com `newsletterBackend === "kit"`, a
 * promoção por score de um contato que já existe no Kit em estado
 * NÃO-`active` (`inactive`/`cancelled`/`bounced`/`complained`) nunca
 * confirmava — `POST /v4/subscribers` com `state: "active"` devolve 200 mas
 * a API ignora o campo quando o contato já existe fora de `active`. Isso
 * incrementava `failed`, e `brevo-diaria-stage5-dispatch.ts` trata
 * `failed > 0` do passo `evaluate-brevo-diaria --push` como falha do passo
 * inteiro — bloqueando o dispatch do canal Brevo diária pra edição inteira
 * por causa de 2 de 109 contatos (colorao1948@gmail.com,
 * regianeaguiardecastro@gmail.com, 22-23/09/2026).
 *
 * Correção: `decideKitPromotionAction` (pura) decide, a partir do estado
 * ATUAL do contato no Kit, se a promoção deve tentar o POST ("promote") ou
 * só esperar a auto-confirmação (Passo 1, já existente) resolver por conta
 * própria ("await_self_confirmation") — nunca força reativação (Kit
 * `inactive` é ambíguo entre "nunca confirmou" e "se descadastrou", e
 * reativar por outro caminho revogaria o descadastro genuíno sem
 * consentimento).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideKitPromotionAction, runEvaluation } from "../scripts/evaluate-brevo-diaria.ts";
import { findContact, type BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function contact(email: string, overrides: Partial<BrevoDiariaContact> = {}): BrevoDiariaContact {
  return {
    email,
    beehiiv_subscription_id: `sub_${email}`,
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_open_rate: null,
    added_at: "2026-07-01T00:00:00.000Z",
    last_evaluated_at: null,
    ...overrides,
  };
}

// #8724-style: força a decisão "promote_to_beehiiv" no evaluateContact
// interno (openRate 1.0, sends_count=3 >= piso).
function highOpenRateBrevoContactRes(): Response {
  return jsonRes(200, {
    statistics: {
      messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
      opened: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
    },
  });
}

describe("decideKitPromotionAction — pura (#8728)", () => {
  it("contato inexistente no Kit (null) → promote", () => {
    assert.equal(decideKitPromotionAction(null), "promote");
  });

  it("contato já active no Kit → promote (POST idempotente, comportamento preservado)", () => {
    assert.equal(decideKitPromotionAction({ state: "active" }), "promote");
  });

  it("contato inactive no Kit → await_self_confirmation (nunca força reativação)", () => {
    assert.equal(decideKitPromotionAction({ state: "inactive" }), "await_self_confirmation");
  });

  it("contato cancelled no Kit → await_self_confirmation", () => {
    assert.equal(decideKitPromotionAction({ state: "cancelled" }), "await_self_confirmation");
  });

  it("contato bounced no Kit → await_self_confirmation", () => {
    assert.equal(decideKitPromotionAction({ state: "bounced" }), "await_self_confirmation");
  });

  it("contato complained no Kit → await_self_confirmation", () => {
    assert.equal(decideKitPromotionAction({ state: "complained" }), "await_self_confirmation");
  });
});

describe("runEvaluation — promoção pro Kit checa o estado ANTES do POST (#8728)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("contato já INACTIVE no Kit → promoção PULADA, ZERO POST no Kit, conta em awaitingKitConfirmation (NUNCA em failed), contato permanece in_brevo", async () => {
    let kitPostCalls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.kit.com/v4/subscribers") && u.includes("email_address=")) {
        // getKitSubscriberByEmail (status=all) — contato já existe, inactive.
        return jsonRes(200, {
          subscribers: [{ id: 4293671997, email_address: "colorao1948@gmail.com", state: "inactive", created_at: "2026-09-13T00:00:00.000Z" }],
        });
      }
      if (u.includes("api.kit.com") && (init?.method ?? "GET") !== "GET") {
        kitPostCalls++;
        return jsonRes(200, { subscriber: { id: 4293671997, email_address: "colorao1948@gmail.com", state: "inactive", created_at: "x" } });
      }
      return highOpenRateBrevoContactRes();
    }) as typeof fetch;

    try {
      const contacts = [contact("colorao1948@gmail.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
        newsletterBackend: "kit",
        kitApiKey: "kkey",
      });

      assert.equal(kitPostCalls, 0, "nunca deve chamar POST /v4/subscribers pra um contato já inactive no Kit (#8728)");
      assert.equal(result.failed, 0, "estado esperado, NUNCA conta como failed — é o próprio bug que bloqueava o dispatch");
      assert.equal(result.awaitingKitConfirmation, 1);
      assert.equal(result.failedContacts.length, 0);
      const stored = findContact(result.store, "colorao1948@gmail.com");
      assert.equal(stored!.status, "in_brevo", "permanece in_brevo, aguardando auto-confirmação (Passo 1) resolver por conta própria");
      // #8753: o início da espera fica registrado no store (base do alarme).
      assert.ok(stored!.awaiting_kit_confirmation_since, "awaiting_kit_confirmation_since deve ser gravado");
    } finally {
      restore();
    }
  });

  it("contato inexistente no Kit → promove normalmente (comportamento pré-#8728 preservado)", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.kit.com/v4/subscribers") && u.includes("email_address=")) {
        return jsonRes(200, { subscribers: [] });
      }
      if (u.includes("api.kit.com")) {
        return jsonRes(200, { subscriber: { id: 42, email_address: "novo@b.com", state: "active", created_at: "x" } });
      }
      return highOpenRateBrevoContactRes();
    }) as typeof fetch;

    try {
      const contacts = [contact("novo@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
        newsletterBackend: "kit",
        kitApiKey: "kkey",
      });

      assert.equal(result.awaitingKitConfirmation, 0);
      assert.equal(result.failed, 0);
      const stored = findContact(result.store, "novo@b.com");
      assert.equal(stored!.status, "promoted_beehiiv");
      assert.equal(stored!.resolution_reason, "score_threshold_kit");
    } finally {
      restore();
    }
  });

  it("lookup no Kit falha (rede/HTTP) → conta em failed com motivo distinto, NUNCA em awaitingKitConfirmation, contato permanece in_brevo", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.kit.com/v4/subscribers") && u.includes("email_address=")) {
        // 403 (não >=500/429) — não-retriável em kitFetch, evita pagar o
        // backoff real de fetchWithRetry neste teste (mesmo padrão do
        // #7382, ver "falha ao checar status Kit (HTTP 403 ...)" em
        // test/evaluate-brevo-diaria-7382.test.ts).
        return jsonRes(403, { error: "boom" });
      }
      if (u.includes("api.kit.com")) {
        throw new Error("nunca deveria chegar ao POST — lookup falhou antes");
      }
      return highOpenRateBrevoContactRes();
    }) as typeof fetch;

    try {
      const contacts = [contact("lookup-falha@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
        newsletterBackend: "kit",
        kitApiKey: "kkey",
      });

      assert.equal(result.awaitingKitConfirmation, 0);
      assert.equal(result.failed, 1);
      assert.match(result.failedContacts[0]!.reason, /falha ao checar estado Kit antes de promover/);
      const stored = findContact(result.store, "lookup-falha@b.com");
      assert.equal(stored!.status, "in_brevo");
    } finally {
      restore();
    }
  });
});
