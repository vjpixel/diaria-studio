/**
 * test/evaluate-brevo-diaria-kit-self-confirm-6340.test.ts (#6340 item 4)
 *
 * "Promoção ao confirmar — quem vira `active` no Kit sai da fila do Brevo."
 *
 * Antes desta unidade, `runEvaluation` — Passo 1 (auto-confirmação) — checava
 * SEMPRE a Beehiiv, mesmo pra contatos ingeridos a partir do cohort
 * `inactive` do Kit (`sync-kit-inactive-to-brevo.ts`, #6340 item 3,
 * `beehiiv_subscription_id` sintético `kit:${kit_subscriber_id}`). Um
 * contato desses nunca existe na Beehiiv, então o GET nunca resolvia
 * `"active"` — o contato ficava preso na fila do Brevo indefinidamente
 * mesmo depois de confirmar o double opt-in no Kit (envio duplicado: Kit E
 * Brevo).
 *
 * Este arquivo cobre o roteamento por origem que fecha esse gap
 * (`parseKitSubscriberId` + o `if`/`else` no Passo 1 de `runEvaluation`) —
 * NUNCA o caminho Beehiiv pré-existente, que segue coberto por
 * `test/evaluate-brevo-diaria-4266.test.ts` (reusa o mesmo estilo de mock
 * de `globalThis.fetch` de lá, não um harness novo).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEvaluation, parseKitSubscriberId, KIT_ORIGIN_ID_PREFIX } from "../scripts/evaluate-brevo-diaria.ts";
import { findContact, type BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fixture — contato `in_brevo` mínimo, mesmo shape de
 *  `test/evaluate-brevo-diaria-4266.test.ts::contact()` (não reexportado de
 *  lá — arquivo de teste irmão, sem módulo compartilhado de fixtures no
 *  repo hoje). Default `beehiiv_subscription_id: sub_${email}` (origem
 *  Beehiiv) — testes de origem Kit sempre passam o override explícito. */
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

/** Resposta Brevo (`GET /contacts/{email}`, Passo 0) neutra — sem
 *  `emailBlacklisted`, sem envios/aberturas — pra não disparar o caminho de
 *  descadastro nativo (#4476 item 7) nem influenciar a avaliação de score
 *  do Passo 2 em nenhum dos testes deste arquivo (todos ficam em `keep`,
 *  0/0 abaixo do piso de amostra dos dois lados). */
function neutralBrevoContactRes(): Response {
  return jsonRes(200, { emailBlacklisted: false, statistics: { messagesSent: [], opened: [] } });
}

/** Resposta Kit (`GET /v4/subscribers/{id}`) — envelope mínimo que
 *  `getSubscriberById` exige (`{subscriber: {...}}`). */
function kitSubscriberRes(id: number, state: string, email: string): Response {
  return jsonRes(200, { subscriber: { id, email_address: email, state, created_at: "2026-08-01T00:00:00.000Z" } });
}

describe("parseKitSubscriberId — extrai o id numérico do beehiiv_subscription_id sintético (#6340 item 4)", () => {
  it(`extrai o id de um "${KIT_ORIGIN_ID_PREFIX}123" válido`, () => {
    assert.equal(parseKitSubscriberId(`${KIT_ORIGIN_ID_PREFIX}123`), 123);
  });

  it("origem Beehiiv (sem o prefixo kit:) → null", () => {
    assert.equal(parseKitSubscriberId("sub_a@b.com"), null);
  });

  it("outra origem sintética (curated:/sunset:) → null, nunca confundida com Kit", () => {
    assert.equal(parseKitSubscriberId("curated:a@b.com"), null);
    assert.equal(parseKitSubscriberId("sunset:a@b.com"), null);
  });

  it("sufixo não-numérico → null (malformado)", () => {
    assert.equal(parseKitSubscriberId("kit:abc"), null);
  });

  it("sufixo vazio → null", () => {
    assert.equal(parseKitSubscriberId("kit:"), null);
  });

  it("sufixo <= 0 ou não-inteiro → null", () => {
    assert.equal(parseKitSubscriberId("kit:0"), null);
    assert.equal(parseKitSubscriberId("kit:-5"), null);
    assert.equal(parseKitSubscriberId("kit:12.5"), null);
  });
});

describe("runEvaluation — Passo 1 (auto-confirmação) roteado por origem (#6340 item 4)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("contato kit:123 ATIVO no Kit → selfConfirmed incrementa, unlinkFromBrevoList chamado, applySelfConfirmed aplicado, NENHUMA chamada a fetchBeehiivSubscriptionStatus", async () => {
    let kitCalls = 0;
    let unlinkCalled = false;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.beehiiv.com")) {
        throw new Error(`fetch Beehiiv NUNCA deveria rodar pra contato de origem Kit: ${u}`);
      }
      if (u.includes("api.kit.com")) {
        kitCalls++;
        assert.ok(u.includes("/subscribers/123"), `URL Kit inesperada: ${u}`);
        return kitSubscriberRes(123, "active", "kit-ativo@b.com");
      }
      if (init?.method === "PUT") {
        unlinkCalled = true;
        assert.deepEqual(JSON.parse(init.body as string), { unlinkListIds: [7] });
        return jsonRes(200, {});
      }
      if (u.includes("/contacts/")) return neutralBrevoContactRes();
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("kit-ativo@b.com", { beehiiv_subscription_id: "kit:123" })];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
        kitApiKey: "kkey",
      });
      assert.equal(result.selfConfirmed, 1);
      assert.equal(result.failed, 0);
      assert.equal(kitCalls, 1, "exatamente 1 GET ao Kit — nunca 2x pro mesmo contato no mesmo run");
      assert.equal(unlinkCalled, true);
      const c = findContact(result.store, "kit-ativo@b.com")!;
      assert.equal(c.status, "promoted_beehiiv");
      assert.equal(c.resolution_reason, "self_confirmed_beehiiv");
    } finally {
      restore();
    }
  });

  it("contato kit:456 ainda INACTIVE no Kit → NÃO auto-confirmado, segue pra avaliação normal (Passo 2) como qualquer outro contato não confirmado", async () => {
    let kitCalls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.beehiiv.com")) {
        throw new Error(`fetch Beehiiv NUNCA deveria rodar pra contato de origem Kit: ${u}`);
      }
      if (u.includes("api.kit.com")) {
        kitCalls++;
        return kitSubscriberRes(456, "inactive", "kit-inativo@b.com");
      }
      if (u.includes("/contacts/")) return neutralBrevoContactRes();
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("kit-inativo@b.com", { beehiiv_subscription_id: "kit:456" })];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
        kitApiKey: "kkey",
      });
      assert.equal(result.selfConfirmed, 0);
      assert.equal(result.kept, 1, "avaliado por taxa de abertura como qualquer contato não confirmado (0/0, abaixo do piso de amostra)");
      assert.equal(result.failed, 0);
      assert.equal(kitCalls, 1);
    } finally {
      restore();
    }
  });

  it("contato de origem Beehiiv (id normal, sem prefixo kit:) → caminho Beehiiv intacto, Kit NUNCA consultado (guard de não-regressão)", async () => {
    let kitCalls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.kit.com")) {
        kitCalls++;
        return jsonRes(500, {}); // nunca deveria ser chamado — se for, a asserção de kitCalls abaixo pega
      }
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (u.includes("/contacts/")) return neutralBrevoContactRes();
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("beehiiv-origem@b.com")]; // default: beehiiv_subscription_id: sub_beehiiv-origem@b.com
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
        kitApiKey: "kkey",
      });
      assert.equal(result.selfConfirmed, 0);
      assert.equal(result.kept, 1);
      assert.equal(result.failed, 0);
      assert.equal(kitCalls, 0, "contato de origem Beehiiv nunca dispara uma checagem contra o Kit");
    } finally {
      restore();
    }
  });

  it("kit: com id malformado (sufixo não-numérico) → degrada sem lançar, log de warn, conta como failed, segue pra avaliação normal", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.kit.com")) throw new Error(`fetch Kit NUNCA deveria rodar pra id malformado: ${u}`);
      if (u.includes("/contacts/")) return neutralBrevoContactRes();
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    const logs: string[] = [];
    try {
      const contacts = [contact("kit-malformado@b.com", { beehiiv_subscription_id: "kit:abc" })];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: (m) => logs.push(m),
        kitApiKey: "kkey",
      });
      assert.equal(result.selfConfirmed, 0);
      assert.equal(result.failed, 1, "id malformado é anomalia de dado — conta como failed, mesmo espírito de statusCheckFailed");
      assert.equal(result.kept, 1, "mesmo com id malformado, o contato ainda é avaliado por taxa de abertura nesta rodada");
      assert.ok(logs.some((l) => l.includes("beehiiv_subscription_id de origem Kit malformado")));
    } finally {
      restore();
    }
  });

  it("kit:789 com kitApiKey AUSENTE (dry-run) → degrada sem lançar, log de warn, NÃO conta como failed (precondição de ambiente, não anomalia), segue pra avaliação normal", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.kit.com")) throw new Error(`fetch Kit NUNCA deveria rodar sem kitApiKey: ${u}`);
      if (u.includes("/contacts/")) return neutralBrevoContactRes();
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    const logs: string[] = [];
    try {
      const contacts = [contact("kit-semkey@b.com", { beehiiv_subscription_id: "kit:789" })];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: (m) => logs.push(m),
        // kitApiKey OMITIDO de propósito
      });
      assert.equal(result.selfConfirmed, 0);
      assert.equal(result.failed, 0, "kitApiKey ausente é precondição de ambiente — nunca conta como failed (mesmo tratamento de brevoApiKey ausente no Passo 0)");
      assert.equal(result.kept, 1);
      assert.ok(logs.some((l) => l.includes("kitApiKey ausente")));
    } finally {
      restore();
    }
  });

  it("push:true com kit:999 e kitApiKey AUSENTE → NUNCA lança, mesmo em push (nunca promove sem conseguir confirmar)", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.kit.com")) throw new Error(`fetch Kit NUNCA deveria rodar sem kitApiKey: ${u}`);
      if (init?.method === "PUT") throw new Error("unlinkFromBrevoList NUNCA deveria rodar — contato não confirmado");
      if (u.includes("/contacts/")) return neutralBrevoContactRes();
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("kit-semkey-push@b.com", { beehiiv_subscription_id: "kit:999" })];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
        // kitApiKey OMITIDO de propósito
      });
      assert.equal(result.selfConfirmed, 0);
      assert.equal(result.failed, 0);
    } finally {
      restore();
    }
  });

  it("falha de rede/HTTP (403, não-retriável) no GET do Kit de 1 contato conta em failed, mas os demais contatos são avaliados normalmente", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.kit.com/v4/subscribers/111")) {
        // 403 é status NÃO-retriável em kitFetch (só 429/>=500 retentam) —
        // falha imediata, sem pagar o backoff real de fetchWithRetry.
        return new Response("forbidden", { status: 403 });
      }
      if (u.includes("api.kit.com/v4/subscribers/222")) return kitSubscriberRes(222, "inactive", "kit-ok@b.com");
      if (u.includes("/contacts/")) return neutralBrevoContactRes();
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    const logs: string[] = [];
    try {
      const contacts = [
        contact("kit-falha@b.com", { beehiiv_subscription_id: "kit:111" }),
        contact("kit-ok@b.com", { beehiiv_subscription_id: "kit:222" }),
      ];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: (m) => logs.push(m),
        kitApiKey: "kkey",
      });
      assert.equal(result.failed, 1, "só o contato com falha no GET do Kit conta como failed");
      assert.equal(result.kept, 2, "os dois contatos são avaliados normalmente por taxa de abertura (nenhum confirmado no Kit)");
      assert.equal(result.selfConfirmed, 0);
      assert.ok(logs.some((l) => l.includes("falha ao checar status Kit de kit-falha@b.com")));
    } finally {
      restore();
    }
  });
});
