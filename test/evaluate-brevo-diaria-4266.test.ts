/**
 * test/evaluate-brevo-diaria-4266.test.ts (#4266)
 *
 * Avaliação periódica dos contatos in_brevo: contadores a partir da
 * estatística de contato da Brevo, veredito puro (score + threshold), e a
 * checagem de auto-confirmação Beehiiv que fecha o gap de duplicidade
 * registrado na própria issue.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeCountsFromBrevoStatistics,
  evaluateContact,
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
    last_score: null,
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

describe("evaluateContact — score + threshold combinados (#4266)", () => {
  it("3 enviados/3 abertos → score 60 → promote_to_beehiiv", () => {
    const ev = evaluateContact({ opens_count: 3, sends_count: 3 });
    assert.equal(ev.score, 60);
    assert.equal(ev.action, "promote_to_beehiiv");
  });

  it("3 enviados/0 abertos → score -30 → suppress", () => {
    const ev = evaluateContact({ opens_count: 0, sends_count: 3 });
    assert.equal(ev.score, -30);
    assert.equal(ev.action, "suppress");
  });

  it("2 enviados/1 aberto → score 10 → keep", () => {
    const ev = evaluateContact({ opens_count: 1, sends_count: 2 });
    assert.equal(ev.score, 10);
    assert.equal(ev.action, "keep");
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

describe("verifyPromotedToBeehiiv — fail-safe se ainda pending (#4266)", () => {
  it("status active → true (promoção confirmada)", async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "active" } })) as typeof fetch;
    assert.equal(await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl), true);
  });

  it("status ainda pending → false (fail-safe: NÃO confirma promoção)", async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "pending" } })) as typeof fetch;
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

describe("runEvaluation — fail-safe por contato, nunca aborta o run (#4398 fixes 1-4)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("dry-run: falha ao checar status Beehiiv de 1 contato conta em failed, mas os demais são avaliados normalmente", async () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/falha%40b.com")) return new Response("boom", { status: 500 });
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      throw new Error(`fetch inesperado em dry-run: ${u}`);
    }) as typeof fetch;

    try {
      const contacts = [
        contact("falha@b.com", { opens_count: 1, sends_count: 2 }),
        contact("ok@b.com", { opens_count: 1, sends_count: 2 }),
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
      assert.equal(result.kept, 2, "ambos avaliados por score mesmo com a falha de auto-confirmação");
      assert.ok(logs.some((l) => l.includes("falha ao checar status Beehiiv de falha@b.com")));
    } finally {
      restore();
    }
  });

  it("push: exceção ao buscar contadores de 1 contato NÃO aborta o run — o próximo contato ainda é processado (fix 1)", async () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (init?.method === undefined && u.includes("/contacts/erro%40b.com")) {
        return new Response("forbidden", { status: 403 }); // brevoGet: 403 lança sem retry
      }
      if (init?.method === undefined && u.includes("/contacts/ok%40b.com")) {
        return jsonRes(200, {
          statistics: {
            messagesSent: [{ campaignId: 1 }, { campaignId: 2 }],
            opened: [{ campaignId: 1 }, { campaignId: 2 }],
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
      assert.equal(result.failed, 1, "só o contato com erro conta como falha");
      assert.equal(result.kept, 1, "o segundo contato foi processado normalmente (score 40 → keep)");
      assert.ok(logs.some((l) => l.includes("FALHA em erro@b.com")));
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
        // 1ª GET: contadores — score -30 (3 enviados, 0 abertos) → suppress
        return jsonRes(200, { statistics: { messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }], opened: [] } });
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
        return jsonRes(200, { statistics: { messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }], opened: [] } });
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
      // GET /contacts/{email} — contadores: 3 enviados/3 abertos → score 60 → promote
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
