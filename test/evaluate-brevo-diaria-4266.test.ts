/**
 * test/evaluate-brevo-diaria-4266.test.ts (#4266, reescrito no #4476 —
 * fórmula por taxa de abertura + descadastro nativo como 3ª saída terminal)
 *
 * Avaliação periódica dos contatos in_brevo: contadores + emailBlacklisted a
 * partir de UMA leitura só do estado da Brevo, veredito puro (taxa de
 * abertura + threshold), a checagem de auto-confirmação Beehiiv que fecha o
 * gap de duplicidade registrado na própria issue #4266, e a checagem de
 * descadastro nativo (#4476 item 7) que roda ANTES de tudo isso.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeCountsFromBrevoStatistics,
  evaluateContact,
  fetchBrevoContactState,
  fetchBeehiivSubscriptionStatus,
  verifyPromotedToBeehiiv,
  verifySuppressedInBrevo,
  suppressInBrevo,
  unlinkFromBrevoList,
  promoteBeehiivSubscription,
  runEvaluation,
} from "../scripts/evaluate-brevo-diaria.ts";
import { findContact, type BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fixture — contato `in_brevo` mínimo, com overrides pontuais por teste. */
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

describe("computeCountsFromBrevoStatistics — dedup por campaignId (#4266)", () => {
  it("statistics ausente → 0/0", () => {
    assert.deepEqual(computeCountsFromBrevoStatistics(undefined), { sends_count: 0, opens_count: 0 });
  });

  it("conta campanhas ÚNICAS enviadas/abertas, não eventos brutos", () => {
    const stats = {
      messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
      // campanha 1 reaberta 2x — deve contar 1, não 2
      opened: [{ campaignId: 1 }, { campaignId: 1 }, { campaignId: 2 }],
    };
    assert.deepEqual(computeCountsFromBrevoStatistics(stats), { sends_count: 3, opens_count: 2 });
  });

  it("arrays malformados (não-array) → 0", () => {
    assert.deepEqual(
      computeCountsFromBrevoStatistics({ messagesSent: undefined, opened: undefined }),
      { sends_count: 0, opens_count: 0 },
    );
  });
});

describe("evaluateContact — taxa de abertura + threshold combinados (#4476 item 1)", () => {
  it("2 enviados/1 aberto → openRate 0.5 → promote_to_beehiiv", () => {
    const ev = evaluateContact({ opens_count: 1, sends_count: 2 });
    assert.equal(ev.open_rate, 0.5);
    assert.equal(ev.action, "promote_to_beehiiv");
  });

  it("5 enviados/1 aberto → openRate 0.2 → suppress", () => {
    const ev = evaluateContact({ opens_count: 1, sends_count: 5 });
    assert.equal(ev.open_rate, 0.2);
    assert.equal(ev.action, "suppress");
  });

  it("3 enviados/1 aberto → openRate 0.33, abaixo do piso de amostra de supressão (n<5) → keep", () => {
    const ev = evaluateContact({ opens_count: 1, sends_count: 3 });
    assert.equal(ev.action, "keep");
  });
});

describe("fetchBrevoContactState — 1 leitura, contadores + emailBlacklisted (#4476 item 7)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("extrai contadores E emailBlacklisted:false do mesmo body", async () => {
    globalThis.fetch = (async () =>
      jsonRes(200, {
        statistics: { messagesSent: [{ campaignId: 1 }, { campaignId: 2 }], opened: [{ campaignId: 1 }] },
      })) as typeof fetch;
    try {
      const state = await fetchBrevoContactState("key", "a@b.com");
      assert.deepEqual(state, { sends_count: 2, opens_count: 1, emailBlacklisted: false });
    } finally {
      restore();
    }
  });

  it("emailBlacklisted:true no body → refletido no estado", async () => {
    globalThis.fetch = (async () =>
      jsonRes(200, { emailBlacklisted: true, statistics: { messagesSent: [], opened: [] } })) as typeof fetch;
    try {
      const state = await fetchBrevoContactState("key", "a@b.com");
      assert.equal(state.emailBlacklisted, true);
    } finally {
      restore();
    }
  });

  it("404 (contato não encontrado) → lança com mensagem própria (fail loud)", async () => {
    globalThis.fetch = (async () => jsonRes(404, {})) as typeof fetch;
    try {
      await assert.rejects(() => fetchBrevoContactState("key", "a@b.com"), /não foi possível ler estado/);
    } finally {
      restore();
    }
  });

  it("erro HTTP não-404 (ex: 403) → lança (propaga o fail-loud de brevoGet)", async () => {
    globalThis.fetch = (async () => jsonRes(403, {})) as typeof fetch;
    try {
      await assert.rejects(() => fetchBrevoContactState("key", "a@b.com"), /Brevo GET .* falhou \(403\)/);
    } finally {
      restore();
    }
  });
});

describe("fetchBeehiivSubscriptionStatus — auto-confirmação (#4266)", () => {
  it("404 → null (contato não encontrado nessa forma)", async () => {
    const fetchImpl = (async () => jsonRes(404, {})) as typeof fetch;
    const status = await fetchBeehiivSubscriptionStatus("pub_1", "key", "a@b.com", fetchImpl);
    assert.equal(status, null);
  });

  it('status "active" (confirmou por conta própria)', async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "active" } })) as typeof fetch;
    const status = await fetchBeehiivSubscriptionStatus("pub_1", "key", "a@b.com", fetchImpl);
    assert.equal(status, "active");
  });

  it('status "pending" (ainda não confirmou)', async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "pending" } })) as typeof fetch;
    const status = await fetchBeehiivSubscriptionStatus("pub_1", "key", "a@b.com", fetchImpl);
    assert.equal(status, "pending");
  });

  it("!ok não-404 → lança (fail loud)", async () => {
    const fetchImpl = (async () => jsonRes(500, {})) as typeof fetch;
    await assert.rejects(() => fetchBeehiivSubscriptionStatus("pub_1", "key", "a@b.com", fetchImpl), /Beehiiv API 500/);
  });
});

describe("verifyPromotedToBeehiiv — fail-safe se ainda pending (#4266, corrigido pro caso 'invalid' no #4476 item 3)", () => {
  it("status active → true (promoção confirmada)", async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "active" } })) as typeof fetch;
    assert.equal(await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl), true);
  });

  it("status ainda pending → false (fail-safe: NÃO confirma promoção)", async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "pending" } })) as typeof fetch;
    assert.equal(await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl), false);
  });

  it('status "invalid" → false (#4476 item 3, achado do teste ao vivo: reactivate_existing:true pode retornar 201 mas deixar status="invalid" — NÃO é confirmação, mesmo não sendo "pending")', async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "invalid" } })) as typeof fetch;
    assert.equal(await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl), false);
  });

  it('status "validating" (estado transitório observado no POST inicial, ao vivo #4476) → false', async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "validating" } })) as typeof fetch;
    assert.equal(await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl), false);
  });

  it("404 (subscription sumiu) → false", async () => {
    const fetchImpl = (async () => jsonRes(404, {})) as typeof fetch;
    assert.equal(await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl), false);
  });
});

// ── #4398 review: fixes 1-4 (silent-failure-hunter, code-reviewer,
// pr-test-analyzer convergiram nestes pontos) ────────────────────────────

describe("suppressInBrevo / unlinkFromBrevoList / promoteBeehiivSubscription — branches de erro (#4398 item 8)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("suppressInBrevo faz PUT emailBlacklisted:true", async () => {
    let body: unknown;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(init!.body as string);
      return jsonRes(200, {});
    }) as typeof fetch;
    try {
      await suppressInBrevo("key", "a@b.com");
      assert.deepEqual(body, { emailBlacklisted: true });
    } finally {
      restore();
    }
  });

  it("suppressInBrevo lança se a Brevo responder erro (fail loud, nunca silencioso)", async () => {
    globalThis.fetch = (async () => jsonRes(403, { message: "forbidden" })) as typeof fetch;
    try {
      await assert.rejects(() => suppressInBrevo("key", "a@b.com"), /Brevo API PUT/);
    } finally {
      restore();
    }
  });

  it("unlinkFromBrevoList faz PUT unlinkListIds", async () => {
    let body: unknown;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(init!.body as string);
      return jsonRes(200, {});
    }) as typeof fetch;
    try {
      await unlinkFromBrevoList("key", 7, "a@b.com");
      assert.deepEqual(body, { unlinkListIds: [7] });
    } finally {
      restore();
    }
  });

  it("unlinkFromBrevoList lança se a Brevo responder erro", async () => {
    globalThis.fetch = (async () => jsonRes(500, { message: "boom" })) as typeof fetch;
    try {
      await assert.rejects(() => unlinkFromBrevoList("key", 7, "a@b.com"), /Brevo API PUT/);
    } finally {
      restore();
    }
  });

  it("promoteBeehiivSubscription: sucesso faz POST com reactivate_existing:true", async () => {
    let body: unknown;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(init!.body as string);
      return jsonRes(200, {});
    }) as typeof fetch;
    await promoteBeehiivSubscription("pub_1", "key", "a@b.com", fetchImpl);
    assert.deepEqual(body, { email: "a@b.com", reactivate_existing: true, send_welcome_email: false });
  });

  it("promoteBeehiivSubscription: !ok lança com status e email na mensagem", async () => {
    const fetchImpl = (async () => new Response("conflict", { status: 409 })) as typeof fetch;
    await assert.rejects(
      () => promoteBeehiivSubscription("pub_1", "key", "a@b.com", fetchImpl),
      /a@b\.com \(HTTP 409\)/,
    );
  });
});

describe("verifySuppressedInBrevo — releitura pós-supressão (#4398 fix 4)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("emailBlacklisted:true e sem o list_id → true (supressão confirmada)", async () => {
    globalThis.fetch = (async () => jsonRes(200, { emailBlacklisted: true, listIds: [] })) as typeof fetch;
    try {
      assert.equal(await verifySuppressedInBrevo("key", 7, "a@b.com"), true);
    } finally {
      restore();
    }
  });

  it("emailBlacklisted:false → false (PUT não pegou, mesmo com 2xx)", async () => {
    globalThis.fetch = (async () => jsonRes(200, { emailBlacklisted: false, listIds: [] })) as typeof fetch;
    try {
      assert.equal(await verifySuppressedInBrevo("key", 7, "a@b.com"), false);
    } finally {
      restore();
    }
  });

  it("emailBlacklisted:true mas AINDA no list_id (unlink não confirmado) → false", async () => {
    globalThis.fetch = (async () => jsonRes(200, { emailBlacklisted: true, listIds: [7] })) as typeof fetch;
    try {
      assert.equal(await verifySuppressedInBrevo("key", 7, "a@b.com"), false);
    } finally {
      restore();
    }
  });

  it("status != 200 (404 — contato sumiu) → false (fail-safe, nunca assume sucesso)", async () => {
    globalThis.fetch = (async () => jsonRes(404, {})) as typeof fetch;
    try {
      assert.equal(await verifySuppressedInBrevo("key", 7, "a@b.com"), false);
    } finally {
      restore();
    }
  });
});

describe("runEvaluation — descadastro nativo (#4476 item 7), passo 0", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("emailBlacklisted:true detectado ANTES de qualquer avaliação de score → unsubscribedNative, nunca kept/suppressed", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/contacts/")) return jsonRes(200, { emailBlacklisted: true, statistics: { messagesSent: [], opened: [] } });
      throw new Error(`fetch inesperado (não deveria checar Beehiiv/self-confirmação): ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("unsub@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.unsubscribedNative, 1);
      assert.equal(result.kept, 0);
      assert.equal(result.suppressed, 0);
      assert.equal(result.selfConfirmed, 0);
      assert.equal(result.failed, 0);
    } finally {
      restore();
    }
  });

  it("push:true → unlinkFromBrevoList chamado e store marca status unsubscribed, motivo native_unsubscribe", async () => {
    const putCalls: { body: unknown }[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "PUT") {
        putCalls.push({ body: JSON.parse(init.body as string) });
        return jsonRes(200, {});
      }
      if (u.includes("/contacts/")) return jsonRes(200, { emailBlacklisted: true, statistics: { messagesSent: [], opened: [] } });
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("unsub2@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.unsubscribedNative, 1);
      assert.deepEqual(putCalls, [{ body: { unlinkListIds: [7] } }]);
      const c = findContact(result.store, "unsub2@b.com")!;
      assert.equal(c.status, "unsubscribed");
      assert.equal(c.resolution_reason, "native_unsubscribe");
    } finally {
      restore();
    }
  });

  it("emailBlacklisted:false → prossegue normalmente pra auto-confirmação/score (não é uma saída)", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (u.includes("/contacts/")) {
        return jsonRes(200, {
          emailBlacklisted: false,
          statistics: { messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }], opened: [] },
        });
      }
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("normal@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.unsubscribedNative, 0);
      // 3 enviados/0 abertos → openRate 0, sends_count=3 < piso de supressão (5) → keep
      assert.equal(result.kept, 1);
    } finally {
      restore();
    }
  });

  it("sem brevoApiKey (dry-run sem a key configurada) → passo 0 pulado inteiro, nenhuma chamada a /contacts", async () => {
    let contactsCalls = 0;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (u.includes("/contacts/")) {
        contactsCalls++;
        return jsonRes(200, {});
      }
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("sem-key@b.com", { opens_count: 1, sends_count: 3 })];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        // brevoApiKey ausente de propósito
        listId: 7,
        log: () => {},
      });
      assert.equal(contactsCalls, 0, "sem brevoApiKey, passo 0 nunca chama /contacts");
      assert.equal(result.unsubscribedNative, 0);
      // usa contadores do store (1/3 → 33%, abaixo do piso de supressão) → keep
      assert.equal(result.kept, 1);
    } finally {
      restore();
    }
  });

  it("falha ao checar estado Brevo (passo 0) → conta failed, NÃO avalia auto-confirmação/score com dado incompleto", async () => {
    let beehiivCalls = 0;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) {
        beehiivCalls++;
        return jsonRes(200, { data: { status: "pending" } });
      }
      // 403 (não 500/429) — brevoGet lança IMEDIATAMENTE, sem retry/backoff
      // (evita o teste esperar segundos reais de sleep entre tentativas).
      if (u.includes("/contacts/")) return jsonRes(403, {});
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("falha-estado@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.failed, 1);
      assert.equal(result.kept, 0);
      assert.equal(result.unsubscribedNative, 0);
      assert.equal(beehiivCalls, 0, "auto-confirmação nunca chamada — o contato pula pra próxima rodada inteiro");
    } finally {
      restore();
    }
  });
});

describe("runEvaluation — fail-safe por contato, nunca aborta o run (#4398 fixes 1-4, atualizado #4476)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("dry-run sem brevoApiKey: falha ao checar status Beehiiv de 1 contato conta em failed, mas os demais são avaliados normalmente", async () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/falha%40b.com")) return new Response("boom", { status: 500 });
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      throw new Error(`fetch inesperado em dry-run: ${u}`);
    }) as typeof fetch;

    try {
      // #4476: fixtures ajustadas pra "keep" sob a nova fórmula (3 enviados/1
      // aberto → 33%, abaixo do piso de amostra de supressão) — o teste
      // continua cobrindo o mesmo cenário original (falha de auto-confirmação
      // não impede a avaliação de score dos demais), só com valores
      // compatíveis com a fórmula por taxa.
      const contacts = [
        contact("falha@b.com", { opens_count: 1, sends_count: 3 }),
        contact("ok@b.com", { opens_count: 1, sends_count: 3 }),
      ];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        listId: 7,
        log,
      });
      assert.equal(result.failed, 1, "1 falha de checagem contada");
      assert.equal(result.kept, 2, "ambos avaliados por taxa de abertura mesmo com a falha de auto-confirmação");
      assert.ok(logs.some((l) => l.includes("falha ao checar status Beehiiv de falha@b.com")));
    } finally {
      restore();
    }
  });

  it("push: exceção ao checar estado Brevo (passo 0) de 1 contato NÃO aborta o run — o próximo contato ainda é processado", async () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (init?.method === undefined && u.includes("/contacts/erro%40b.com")) {
        return new Response("forbidden", { status: 403 }); // brevoGet: 403 lança sem retry
      }
      if (init?.method === undefined && u.includes("/contacts/ok%40b.com")) {
        // 3 enviados/1 aberto → 33%, abaixo do piso de supressão (n>=5) → keep
        return jsonRes(200, {
          statistics: {
            messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
            opened: [{ campaignId: 1 }],
          },
        });
      }
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("erro@b.com"), contact("ok@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log,
      });
      assert.equal(result.failed, 1, "só o contato com erro no passo 0 conta como falha");
      assert.equal(result.kept, 1, "o segundo contato foi processado normalmente (33% → keep)");
      assert.ok(logs.some((l) => l.includes("falha ao checar estado Brevo de erro@b.com")));
    } finally {
      restore();
    }
  });

  it("push: suppress bem-sucedido (verify confirma blacklist + desvinculação) → status suppressed no store (fix 3+4)", async () => {
    const putCalls: { body: unknown }[] = [];
    let getContactCalls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (init?.method === "PUT") {
        putCalls.push({ body: JSON.parse(init.body as string) });
        return jsonRes(200, {});
      }
      getContactCalls++;
      if (getContactCalls === 1) {
        // 1ª GET (passo 0 — descadastro nativo + contadores reusados no passo 2):
        // 3 enviados, 0 abertos → openRate 0, sends_count=3 < 5 (piso de
        // supressão)... precisa de >=5 pra suprimir — usar 5 enviados/0 abertos.
        return jsonRes(200, { statistics: { messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }, { campaignId: 4 }, { campaignId: 5 }], opened: [] } });
      }
      // 2ª GET: releitura pós-supressão — confirma blacklist + fora da lista
      return jsonRes(200, { emailBlacklisted: true, listIds: [] });
    }) as typeof fetch;

    try {
      const contacts = [contact("supr@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.failed, 0);
      assert.equal(result.suppressed, 1);
      assert.equal(putCalls.length, 2, "suppressInBrevo + unlinkFromBrevoList, ambos chamados");
      assert.deepEqual(putCalls[0].body, { emailBlacklisted: true });
      assert.deepEqual(putCalls[1].body, { unlinkListIds: [7] });
      assert.equal(findContact(result.store, "supr@b.com")!.status, "suppressed");
    } finally {
      restore();
    }
  });

  it("push: suppress cuja releitura NÃO confirma → mantém in_brevo (fail-safe fix 4), conta failed", async () => {
    let getContactCalls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (init?.method === "PUT") return jsonRes(200, {});
      getContactCalls++;
      if (getContactCalls === 1) {
        return jsonRes(200, { statistics: { messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }, { campaignId: 4 }, { campaignId: 5 }], opened: [] } });
      }
      // releitura NÃO confirma: PUT foi 2xx mas o estado real não mudou (mesma armadilha da Beehiiv, ver disclaimer do módulo)
      return jsonRes(200, { emailBlacklisted: false, listIds: [7] });
    }) as typeof fetch;

    try {
      const contacts = [contact("supr2@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.failed, 1, "verificação não confirmada conta como falha, nunca silenciosa");
      assert.equal(result.suppressed, 1, "contado como 'intenção' da avaliação de score, mesmo revertido pelo fail-safe");
      assert.equal(findContact(result.store, "supr2@b.com")!.status, "in_brevo", "NUNCA marcado suppressed sem confirmação");
    } finally {
      restore();
    }
  });

  it("push: promote bem-sucedido continua funcionando após o refactor de runEvaluation (regressão)", async () => {
    let selfConfirmCheckCalls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) {
        selfConfirmCheckCalls++;
        // 1ª chamada: auto-confirmação (ainda "pending", cai no caminho de score).
        // 2ª chamada: verifyPromotedToBeehiiv pós-promoção (já "active", confirma).
        return jsonRes(200, { data: { status: selfConfirmCheckCalls === 1 ? "pending" : "active" } });
      }
      if (u.includes("/publications/pub_1/subscriptions") && init?.method === "POST") {
        return jsonRes(200, {});
      }
      if (init?.method === "PUT") {
        return jsonRes(200, {});
      }
      // GET /contacts/{email} (passo 0, reusado no passo 2) — 3 enviados/3
      // abertos → openRate 1.0, sends_count=3 >= 2 → promote
      return jsonRes(200, {
        statistics: {
          messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
          opened: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
        },
      });
    }) as typeof fetch;

    try {
      const contacts = [contact("promo@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.failed, 0);
      assert.equal(result.promoted, 1);
      assert.equal(findContact(result.store, "promo@b.com")!.status, "promoted_beehiiv");
    } finally {
      restore();
    }
  });
});
