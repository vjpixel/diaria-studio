/**
 * test/evaluate-brevo-diaria-7382.test.ts (#7382)
 *
 * Regressão pro fix da issue #7382: a promoção por score
 * (`evaluate-brevo-diaria.ts`, `newsletterBackend !== "kit"` — o caminho que
 * ESCREVE na Beehiiv) escolhia o destino só pelo backend configurado, sem
 * NUNCA checar se a pessoa já estava `active` no Kit — achado ao vivo
 * (03/09/2026): 4 contatos promovidos pra Beehiiv enquanto já ativos no
 * Kit, recebendo a edição em dobro (janelas de até 14 dias até a limpeza
 * manual notar).
 *
 * Cobre `decidePromoteToBeehiivAction` (pura) e a integração em
 * `runEvaluation`: contato ativo no Kit → promoção pulada (marcado
 * `converted_to_kit`, nunca `promoted_beehiiv`); contato NÃO ativo no Kit →
 * promoção segue normal (comportamento pré-existente preservado, mesmo
 * cenário coberto por `test/evaluate-brevo-diaria-4266.test.ts` e
 * `test/evaluate-brevo-diaria-6339.test.ts`, atualizados nesta mesma PR pra
 * mockar a checagem Kit); checagem indisponível (sem `KIT_API_KEY`, ou
 * falha transitória) → fail-safe, contato mantido `in_brevo`, NUNCA
 * promovido sem saber se já está no Kit.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decidePromoteToBeehiivAction, runEvaluation } from "../scripts/evaluate-brevo-diaria.ts";
import { findContact, type BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Contato `in_brevo` mínimo, mesmo shape dos arquivos irmãos (#6339/#6340). */
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

/** GET /contacts/{email} (passo 0, reusado no passo 2) — 3 enviados/3
 *  abertos → openRate 1.0, sends_count=3>=piso → promote_to_beehiiv. */
function highOpenRateBrevoContactRes(): Response {
  return jsonRes(200, {
    emailBlacklisted: false,
    statistics: {
      messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
      opened: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
    },
  });
}

describe("decidePromoteToBeehiivAction — pura (#7382)", () => {
  it("checagem Kit indisponível → skip_kit_check_unavailable, independente de kitActive", () => {
    assert.equal(decidePromoteToBeehiivAction({ kitCheckAvailable: false, kitActive: false }), "skip_kit_check_unavailable");
    assert.equal(decidePromoteToBeehiivAction({ kitCheckAvailable: false, kitActive: true }), "skip_kit_check_unavailable");
  });

  it("checagem disponível + já ativo no Kit → skip_active_on_kit", () => {
    assert.equal(decidePromoteToBeehiivAction({ kitCheckAvailable: true, kitActive: true }), "skip_active_on_kit");
  });

  it("checagem disponível + não ativo no Kit → promote", () => {
    assert.equal(decidePromoteToBeehiivAction({ kitCheckAvailable: true, kitActive: false }), "promote");
  });
});

describe("runEvaluation — promoção pra Beehiiv checa o Kit antes de escrever (#7382)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("contato ATIVO no Kit → promoção pra Beehiiv PULADA, ZERO chamada Beehiiv de escrita, unlinkFromBrevoList chamado, status final converted_to_kit (nunca promoted_beehiiv)", async () => {
    let beehiivWriteCalls = 0;
    let unlinkCalled = false;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.kit.com")) {
        // Contato existe no Kit e está active.
        return jsonRes(200, {
          subscribers: [{ id: 42, email_address: "ativo-no-kit@b.com", state: "active", created_at: "2026-08-01T00:00:00.000Z" }],
          pagination: {},
        });
      }
      if (u.includes("subscriptions/by_email/")) {
        // Passo 1 (auto-confirmação, pré-existente): leitura, sempre permitida
        // — "pending" garante que este contato NUNCA se auto-confirma por
        // esse caminho, só chega na promoção por score (o que este teste
        // exercita).
        return jsonRes(200, { data: { status: "pending" } });
      }
      if (u.includes("api.beehiiv.com")) {
        // Qualquer OUTRA chamada Beehiiv (DELETE/POST — a escrita real de
        // `promoteBeehiivSubscription`) NUNCA deveria rodar pra um contato
        // já ativo no Kit.
        beehiivWriteCalls++;
        throw new Error(`fetch Beehiiv de ESCRITA NUNCA deveria rodar — contato já ativo no Kit (#7382): ${u}`);
      }
      if (init?.method === "PUT") {
        // unlinkFromBrevoList
        unlinkCalled = true;
        return jsonRes(200, {});
      }
      return highOpenRateBrevoContactRes();
    }) as typeof fetch;

    try {
      const contacts = [contact("ativo-no-kit@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        kitApiKey: "kkey",
        listId: 7,
        log: () => {},
        // newsletterBackend omitido (default "beehiiv") — é o caminho que o achado ao vivo expôs
      });
      assert.equal(beehiivWriteCalls, 0, "nenhuma chamada de escrita na Beehiiv — a duplicidade real vinha daqui");
      assert.equal(unlinkCalled, true, "contato sai da fila Brevo mesmo sem promover pra Beehiiv (já recebe via Kit)");
      assert.equal(result.skippedActiveOnKit, 1);
      assert.equal(result.promoted, 1, "contador de INTENÇÃO de score continua incrementando — a decisão de destino é o que muda");
      assert.equal(result.failed, 0);
      const stored = findContact(result.store, "ativo-no-kit@b.com");
      assert.equal(stored!.status, "converted_to_kit");
      assert.equal(stored!.resolution_reason, "converted_to_kit");
    } finally {
      restore();
    }
  });

  it("contato NÃO existe no Kit → promoção pra Beehiiv segue normal (comportamento pré-existente preservado)", async () => {
    let byEmailCalls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.kit.com")) {
        return jsonRes(200, { subscribers: [], pagination: {} });
      }
      if (u.includes("subscriptions/by_email/")) {
        byEmailCalls++;
        if (byEmailCalls === 1) return jsonRes(200, { data: { status: "pending" } });
        if (byEmailCalls === 2) return jsonRes(200, { data: { id: "sub_atual", status: "pending" } });
        return jsonRes(200, { data: { status: "active" } });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (u.includes("/publications/pub_1/subscriptions") && init?.method === "POST") return jsonRes(200, {});
      if (init?.method === "PUT") return jsonRes(200, {});
      return highOpenRateBrevoContactRes();
    }) as typeof fetch;

    try {
      const contacts = [contact("nao-esta-no-kit@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        kitApiKey: "kkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.skippedActiveOnKit, 0);
      assert.equal(result.promoted, 1);
      assert.equal(result.failed, 0);
      const stored = findContact(result.store, "nao-esta-no-kit@b.com");
      assert.equal(stored!.status, "promoted_beehiiv");
      assert.equal(stored!.resolution_reason, "score_threshold");
    } finally {
      restore();
    }
  });

  it("KIT_API_KEY ausente no momento da promoção → fail-safe: contato mantido in_brevo, ZERO chamada Beehiiv, conta em failed (nunca promove sem checar o Kit)", async () => {
    let beehiivWriteCalls = 0;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.kit.com")) {
        throw new Error("fetch Kit NUNCA deveria rodar sem kitApiKey");
      }
      if (u.includes("subscriptions/by_email/")) {
        return jsonRes(200, { data: { status: "pending" } }); // Passo 1, leitura pré-existente, sempre permitida
      }
      if (u.includes("api.beehiiv.com")) {
        beehiivWriteCalls++;
        throw new Error(`fetch Beehiiv de ESCRITA NUNCA deveria rodar — checagem Kit indisponível (#7382): ${u}`);
      }
      return highOpenRateBrevoContactRes();
    }) as typeof fetch;

    try {
      const contacts = [contact("sem-kit-key@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        // kitApiKey ausente de propósito
        listId: 7,
        log: () => {},
      });
      assert.equal(beehiivWriteCalls, 0);
      assert.equal(result.skippedActiveOnKit, 0);
      assert.equal(result.failed, 1, "checagem Kit indisponível conta como falha — visível pro exit code do cron");
      const stored = findContact(result.store, "sem-kit-key@b.com");
      assert.equal(stored!.status, "in_brevo", "NUNCA promovido sem checar o Kit primeiro");
    } finally {
      restore();
    }
  });

  it("falha ao checar status Kit (HTTP 403 — não-retriável em kitFetch, sem pagar o backoff real de fetchWithRetry) → mesmo fail-safe do caso anterior, nunca lança pro caller", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.kit.com")) {
        return new Response("forbidden", { status: 403 });
      }
      if (u.includes("subscriptions/by_email/")) {
        return jsonRes(200, { data: { status: "pending" } }); // Passo 1, leitura pré-existente, sempre permitida
      }
      if (u.includes("api.beehiiv.com")) {
        throw new Error(`fetch Beehiiv de ESCRITA NUNCA deveria rodar — falha na checagem Kit (#7382): ${u}`);
      }
      return highOpenRateBrevoContactRes();
    }) as typeof fetch;

    try {
      const contacts = [contact("falha-checagem-kit@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        kitApiKey: "kkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.failed, 1);
      const stored = findContact(result.store, "falha-checagem-kit@b.com");
      assert.equal(stored!.status, "in_brevo");
    } finally {
      restore();
    }
  });

  it('newsletterBackend="kit" → caminho INALTERADO (checagem cross-plataforma só se aplica quando o destino da escrita é a Beehiiv), ZERO chamada api.kit.com pra checagem de estado ANTES de promover (só a escrita real)', async () => {
    let kitSubscriberCalls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.beehiiv.com")) {
        throw new Error(`fetch Beehiiv NUNCA deveria rodar com newsletterBackend="kit": ${u}`);
      }
      if (u.includes("api.kit.com/v4/subscribers") && !init?.method) {
        kitSubscriberCalls++;
        return jsonRes(201, { subscriber: { id: 99, email_address: "kit-backend@b.com", state: "active", created_at: "2026-08-01T00:00:00.000Z" } });
      }
      if (u.includes("api.kit.com")) {
        return jsonRes(200, { subscriber: { id: 99, email_address: "kit-backend@b.com", state: "active", created_at: "2026-08-01T00:00:00.000Z" } });
      }
      return highOpenRateBrevoContactRes();
    }) as typeof fetch;

    try {
      const contacts = [contact("kit-backend@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        kitApiKey: "kkey",
        listId: 7,
        log: () => {},
        newsletterBackend: "kit",
      });
      assert.equal(result.skippedActiveOnKit, 0, "guard #7382 só existe no ramo que escreve na Beehiiv");
      assert.equal(result.promoted, 1);
      const stored = findContact(result.store, "kit-backend@b.com");
      assert.equal(stored!.status, "promoted_beehiiv");
      assert.equal(stored!.resolution_reason, "score_threshold_kit");
    } finally {
      restore();
    }
  });
});
