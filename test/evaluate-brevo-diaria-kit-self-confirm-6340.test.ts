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

describe("parseKitSubscriberId — união discriminada (#6340 item 4 fix C, review pós-merge)", () => {
  it(`extrai o id de um "${KIT_ORIGIN_ID_PREFIX}123" válido`, () => {
    assert.deepEqual(parseKitSubscriberId(`${KIT_ORIGIN_ID_PREFIX}123`), { kind: "kit-valid", id: 123 });
  });

  it("origem Beehiiv (sem o prefixo kit:) → not-kit", () => {
    assert.deepEqual(parseKitSubscriberId("sub_a@b.com"), { kind: "not-kit" });
  });

  it("outra origem sintética (curated:/sunset:) → not-kit, nunca confundida com Kit", () => {
    assert.deepEqual(parseKitSubscriberId("curated:a@b.com"), { kind: "not-kit" });
    assert.deepEqual(parseKitSubscriberId("sunset:a@b.com"), { kind: "not-kit" });
  });

  it("sufixo não-numérico → kit-malformed (distinto de not-kit — é origem Kit, mas o id não dá pra extrair)", () => {
    assert.deepEqual(parseKitSubscriberId("kit:abc"), { kind: "kit-malformed", raw: "abc" });
  });

  it("sufixo vazio → kit-malformed", () => {
    assert.deepEqual(parseKitSubscriberId("kit:"), { kind: "kit-malformed", raw: "" });
  });

  it("sufixo <= 0 ou não-inteiro → kit-malformed", () => {
    assert.deepEqual(parseKitSubscriberId("kit:0"), { kind: "kit-malformed", raw: "0" });
    assert.deepEqual(parseKitSubscriberId("kit:-5"), { kind: "kit-malformed", raw: "-5" });
    assert.deepEqual(parseKitSubscriberId("kit:12.5"), { kind: "kit-malformed", raw: "12.5" });
  });

  it("#6340 item 4 fix E — espaço em branco no sufixo → kit-malformed (Number(' 123') aceitaria, regex de dígitos rejeita)", () => {
    assert.deepEqual(parseKitSubscriberId("kit: 123"), { kind: "kit-malformed", raw: " 123" });
  });

  it("#6340 item 4 fix E — notação científica no sufixo → kit-malformed (Number('1e2')===100 aceitaria, regex de dígitos rejeita)", () => {
    assert.deepEqual(parseKitSubscriberId("kit:1e2"), { kind: "kit-malformed", raw: "1e2" });
  });

  it("#6340 item 4 fix E — prefixo case-sensitive: 'Kit:123' (maiúscula) → not-kit, NUNCA kit-malformed (cai silenciosamente como origem Beehiiv)", () => {
    assert.deepEqual(parseKitSubscriberId("Kit:123"), { kind: "not-kit" });
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
      // #6677: contato de origem Kit resolve `self_confirmed_kit` — a
      // confirmação aconteceu no Kit, nunca na Beehiiv.
      assert.equal(c.resolution_reason, "self_confirmed_kit");
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
      assert.equal(result.failed, 0, "kitApiKey ausente é precondição de ambiente — nunca conta como failed");
      assert.equal(result.kitAutoConfirmSkipped, 1, "#6340 item 4 fix A — contador DEDICADO pra kitApiKey ausente, distinto de failed");
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
      assert.equal(result.kitAutoConfirmSkipped, 1, "#6340 item 4 fix A — mesmo em push, kitApiKey ausente conta aqui, não em failed");
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

describe("runEvaluation — Passo 0 (descadastro nativo) roteado por origem (#6340 item 4 fix B, review pós-merge)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  /** Resposta Brevo (`GET /contacts/{email}`, Passo 0) com `emailBlacklisted:
   *  true` — variante blacklisted de `neutralBrevoContactRes` (arquivo
   *  irmão), com `userUnsubscription` opcional. */
  function blacklistedBrevoContactRes(opts: { userUnsubscribed?: boolean; hardBounced?: boolean } = {}): Response {
    return jsonRes(200, {
      emailBlacklisted: true,
      statistics: {
        messagesSent: [],
        opened: [],
        unsubscriptions: {
          userUnsubscription: opts.userUnsubscribed ? [{ date: "2026-08-01T00:00:00.000Z" }] : [],
          adminUnsubscription: [],
        },
        ...(opts.hardBounced ? { hardBounces: [{ campaignId: 1 }] } : {}),
      },
    });
  }

  it("push:true, kit-origem, emailBlacklisted + userUnsubscription genuína, ainda inactive no Kit → unsubscribedNative, resolution_reason native_unsubscribe_kit_origin, ZERO chamada Beehiiv, unlink chamado", async () => {
    let beehiivCalls = 0;
    let unlinkCalled = false;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.beehiiv.com")) {
        beehiivCalls++;
        throw new Error(`fetch Beehiiv NUNCA deveria rodar pra contato de origem Kit no Passo 0: ${u}`);
      }
      if (u.includes("api.kit.com")) return kitSubscriberRes(321, "inactive", "kit-unsub@b.com");
      if (init?.method === "PUT") {
        unlinkCalled = true;
        assert.deepEqual(JSON.parse(init.body as string), { unlinkListIds: [7] });
        return jsonRes(200, {});
      }
      if (u.includes("/contacts/")) return blacklistedBrevoContactRes({ userUnsubscribed: true });
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("kit-unsub@b.com", { beehiiv_subscription_id: "kit:321" })];
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
      assert.equal(result.unsubscribedNative, 1);
      assert.equal(result.selfConfirmed, 0);
      assert.equal(result.bouncedNative, 0);
      assert.equal(result.failed, 0);
      assert.equal(beehiivCalls, 0, "contato de origem Kit nunca consulta/escreve na Beehiiv no Passo 0 (#6340 item 4 fix B)");
      assert.equal(unlinkCalled, true);
      const c = findContact(result.store, "kit-unsub@b.com")!;
      assert.equal(c.status, "unsubscribed");
      assert.equal(c.resolution_reason, "native_unsubscribe_kit_origin");
    } finally {
      restore();
    }
  });

  it("kit-origem, emailBlacklisted SEM userUnsubscription (ruído admin/bounce), ainda inactive no Kit → bouncedNative/native_admin_block, ZERO chamada Beehiiv", async () => {
    let beehiivCalls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.beehiiv.com")) {
        beehiivCalls++;
        throw new Error(`fetch Beehiiv NUNCA deveria rodar pra contato de origem Kit no Passo 0: ${u}`);
      }
      if (u.includes("api.kit.com")) return kitSubscriberRes(322, "inactive", "kit-bounce@b.com");
      if (init?.method === "PUT") return jsonRes(200, {});
      if (u.includes("/contacts/")) return blacklistedBrevoContactRes({ userUnsubscribed: false });
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("kit-bounce@b.com", { beehiiv_subscription_id: "kit:322" })];
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
      assert.equal(result.bouncedNative, 1);
      assert.equal(result.unsubscribedNative, 0);
      assert.equal(result.failed, 0);
      assert.equal(beehiivCalls, 0);
      const c = findContact(result.store, "kit-bounce@b.com")!;
      assert.equal(c.status, "bounced");
      assert.equal(c.resolution_reason, "native_admin_block");
    } finally {
      restore();
    }
  });

  it("kit-origem, emailBlacklisted MAS já ativo no Kit → cai no bloco compartilhado de auto-confirmação (selfConfirmed), NUNCA tratado como unsub, e o Passo 1 reusa o mesmo GET (só 1 chamada ao Kit no run)", async () => {
    let kitCalls = 0;
    let beehiivCalls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.beehiiv.com")) {
        beehiivCalls++;
        throw new Error(`fetch Beehiiv NUNCA deveria rodar pra contato de origem Kit: ${u}`);
      }
      if (u.includes("api.kit.com")) {
        kitCalls++;
        return kitSubscriberRes(323, "active", "kit-ja-ativo@b.com");
      }
      if (init?.method === "PUT") return jsonRes(200, {});
      if (u.includes("/contacts/")) return blacklistedBrevoContactRes({ userUnsubscribed: true });
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("kit-ja-ativo@b.com", { beehiiv_subscription_id: "kit:323" })];
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
      assert.equal(result.selfConfirmed, 1, "já ativo no Kit → auto-confirmação, NUNCA revertido por causa do emailBlacklisted (mesmo racional do #4630 pro par Beehiiv)");
      assert.equal(result.unsubscribedNative, 0);
      assert.equal(result.bouncedNative, 0);
      assert.equal(kitCalls, 1, "Passo 1 reusa o kitConfirmed já obtido no Passo 0 — nunca 2 GETs ao Kit no mesmo run");
      assert.equal(beehiivCalls, 0);
      const c = findContact(result.store, "kit-ja-ativo@b.com")!;
      assert.equal(c.status, "promoted_beehiiv");
      // #6677 — ver nota acima.
      assert.equal(c.resolution_reason, "self_confirmed_kit");
    } finally {
      restore();
    }
  });

  it("kit-origem, emailBlacklisted, kitApiKey AUSENTE → kitAutoConfirmSkipped (não failed), ZERO chamada Beehiiv/Kit, contato pulado esta rodada (nenhuma mutação no store)", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.beehiiv.com")) throw new Error(`fetch Beehiiv NUNCA deveria rodar: ${u}`);
      if (u.includes("api.kit.com")) throw new Error(`fetch Kit NUNCA deveria rodar sem kitApiKey: ${u}`);
      if (u.includes("/contacts/")) return blacklistedBrevoContactRes({ userUnsubscribed: true });
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    const logs: string[] = [];
    try {
      const contacts = [contact("kit-semkey-p0@b.com", { beehiiv_subscription_id: "kit:324" })];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: (m) => logs.push(m),
        // kitApiKey OMITIDO de propósito
      });
      assert.equal(result.kitAutoConfirmSkipped, 1);
      assert.equal(result.failed, 0);
      assert.equal(result.unsubscribedNative, 0);
      assert.equal(result.bouncedNative, 0);
      assert.equal(result.kept, 0, "contato pulado inteiro nesta rodada — nem passa pra avaliação de score (dado incompleto)");
      const c = findContact(result.store, "kit-semkey-p0@b.com")!;
      assert.equal(c.status, "in_brevo", "nenhuma mutação — retentado na próxima rodada quando a key estiver presente");
      assert.ok(logs.some((l) => l.includes("kitApiKey ausente")));
    } finally {
      restore();
    }
  });

  it("kit-origem, emailBlacklisted, id malformado → conta failed, ZERO chamada Kit/Beehiiv", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.beehiiv.com")) throw new Error(`fetch Beehiiv NUNCA deveria rodar: ${u}`);
      if (u.includes("api.kit.com")) throw new Error(`fetch Kit NUNCA deveria rodar pra id malformado: ${u}`);
      if (u.includes("/contacts/")) return blacklistedBrevoContactRes({ userUnsubscribed: true });
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    const logs: string[] = [];
    try {
      const contacts = [contact("kit-malformado-p0@b.com", { beehiiv_subscription_id: "kit:xyz" })];
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
      assert.equal(result.failed, 1);
      assert.equal(result.kitAutoConfirmSkipped, 0);
      assert.ok(logs.some((l) => l.includes("não é possível decidir o Passo 0")));
    } finally {
      restore();
    }
  });
});

describe("runEvaluation — origens mistas no MESMO run (#6340 item 4 fix F, review pós-merge)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("Kit-confirmado + Beehiiv-confirmado + Kit-malformado no MESMO runEvaluation → contadores independentes, nenhum estado (beehiivStatus/kitConfirmed/statusCheckFailed) vaza de um contato pro próximo", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.kit.com/v4/subscribers/501")) return kitSubscriberRes(501, "active", "kit-ok@b.com");
      if (u.includes("subscriptions/by_email/beehiiv-ok%40b.com")) return jsonRes(200, { data: { status: "active" } });
      if (u.includes("/contacts/")) return neutralBrevoContactRes();
      if (init?.method === "PUT") return jsonRes(200, {});
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [
        contact("kit-ok@b.com", { beehiiv_subscription_id: "kit:501" }),
        contact("beehiiv-ok@b.com"), // default: sub_beehiiv-ok@b.com — origem Beehiiv
        contact("kit-malformado-mix@b.com", { beehiiv_subscription_id: "kit:notanumber" }),
      ];
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
      assert.equal(result.selfConfirmed, 2, "kit-ok (via Kit) + beehiiv-ok (via Beehiiv) — cada um confirmado no backend certo");
      assert.equal(result.failed, 1, "só kit-malformado-mix conta failed — nenhum vazamento pros outros 2");
      assert.equal(result.kept, 1, "kit-malformado-mix, mesmo com id malformado, ainda cai na avaliação normal por taxa de abertura (Passo 2) — 0/0 abaixo do piso de amostra");
      assert.equal(findContact(result.store, "kit-ok@b.com")!.status, "promoted_beehiiv");
      assert.equal(findContact(result.store, "beehiiv-ok@b.com")!.status, "promoted_beehiiv");
      // #6677: no MESMO run, cada origem grava seu próprio `resolution_reason`
      // — é o que prova que a distinção sobrevive ao loop multi-contato, e não
      // só a um run de contato único.
      assert.equal(findContact(result.store, "kit-ok@b.com")!.resolution_reason, "self_confirmed_kit");
      assert.equal(findContact(result.store, "beehiiv-ok@b.com")!.resolution_reason, "self_confirmed_beehiiv");
      assert.equal(findContact(result.store, "kit-malformado-mix@b.com")!.status, "in_brevo", "malformado nunca resolve — segue in_brevo");
    } finally {
      restore();
    }
  });
});
