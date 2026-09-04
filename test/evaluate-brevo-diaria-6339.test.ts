/**
 * test/evaluate-brevo-diaria-6339.test.ts (#6339)
 *
 * Regressão pro fix da issue #6339: a promoção por score
 * (`evaluate-brevo-diaria.ts`) escrevia SEMPRE na Beehiiv
 * (`promoteBeehiivSubscription`/`verifyPromotedToBeehiiv`), mesmo depois do
 * switchover do #6114 (`publishing.newsletter.backend === "kit"`) — a
 * Beehiiv não publica mais nada, então a promoção só chegava aos
 * assinantes de fato via a ponte temporária de sync
 * (`scripts/sync-beehiiv-subscribers-kit.ts`), até 24h de atraso, e some no
 * dia em que alguém aposentar essa ponte.
 *
 * Este arquivo cobre o novo par `promoteKitSubscription`/
 * `verifyPromotedToKit`, e `runEvaluation` ramificando por
 * `newsletterBackend` — sem essas duas coisas, o bug volta a acontecer em
 * silêncio (promoção "confirmada" no store sem nunca escrever no backend
 * que de fato publica).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  promoteKitSubscription,
  verifyPromotedToKit,
  runEvaluation,
} from "../scripts/evaluate-brevo-diaria.ts";
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

describe("promoteKitSubscription / verifyPromotedToKit (#6339)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("promoteKitSubscription: POST /v4/subscribers com state=active, devolve o id", async () => {
    let body: unknown;
    let url = "";
    globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
      url = String(u);
      body = JSON.parse(init!.body as string);
      return jsonRes(200, { subscriber: { id: 555, email_address: "a@b.com", state: "active", created_at: "x" } });
    }) as typeof fetch;
    try {
      const result = await promoteKitSubscription("a@b.com", "kkey");
      assert.equal(result.id, 555);
      assert.match(url, /\/subscribers$/);
      // #6425 Parte B: passou a mandar `fields` (UTM do registry +
      // origem_cadastro) — cobertura detalhada do shape em
      // test/kit-attribution-6425.test.ts; aqui só confirma que o body
      // NÃO regrediu pra "sem fields nenhum" (o bug original desta issue).
      const b = body as { email_address: string; state: string; fields?: Record<string, string> };
      assert.equal(b.email_address, "a@b.com");
      assert.equal(b.state, "active");
      assert.ok(b.fields && Object.keys(b.fields).length > 0, "esperava fields não-vazio (regressão do #6425)");
    } finally {
      restore();
    }
  });

  it("verifyPromotedToKit: state active na releitura → true", async () => {
    globalThis.fetch = (async () =>
      jsonRes(200, { subscriber: { id: 555, email_address: "a@b.com", state: "active", created_at: "x" } })) as typeof fetch;
    try {
      assert.equal(await verifyPromotedToKit(555, "kkey"), true);
    } finally {
      restore();
    }
  });

  it("verifyPromotedToKit: qualquer state != active na releitura → false (fail-safe, nunca confia no POST)", async () => {
    globalThis.fetch = (async () =>
      jsonRes(200, { subscriber: { id: 555, email_address: "a@b.com", state: "cancelled", created_at: "x" } })) as typeof fetch;
    try {
      assert.equal(await verifyPromotedToKit(555, "kkey"), false);
    } finally {
      restore();
    }
  });
});

describe("runEvaluation — newsletterBackend ramifica a promoção (#6339)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it('newsletterBackend="kit": promoção escreve no Kit (POST+GET /v4/subscribers), NUNCA faz DELETE/POST na Beehiiv (a checagem de status GET por_email, passo 1 de auto-confirmação, é independente e continua rodando)', async () => {
    const kitUrls: string[] = [];
    const beehiivSubscriptionWrites: string[] = [];
    globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
      const url = String(u);
      if (url.includes("api.kit.com")) {
        kitUrls.push(`${init?.method ?? "GET"} ${url}`);
        // Mesma resposta serve tanto o POST (create) quanto o GET
        // (releitura) — o teste só precisa confirmar `state: "active"`.
        return jsonRes(200, { subscriber: { id: 777, email_address: "promo@b.com", state: "active", created_at: "x" } });
      }
      if (url.includes("/publications/") && url.includes("subscriptions")) {
        const method = init?.method ?? "GET";
        if (method !== "GET") {
          // DELETE/POST são exclusivos de `promoteBeehiivSubscription` — com
          // newsletterBackend="kit" isso NUNCA deveria acontecer.
          beehiivSubscriptionWrites.push(`${method} ${url}`);
          return jsonRes(200, { data: { id: "nunca_deveria_ser_criado" } });
        }
        // GET by_email (passo 1, auto-confirmação) — "pending" (nunca
        // confirmou por conta própria), deixa a avaliação seguir pro score.
        return jsonRes(200, { data: { status: "pending" } });
      }
      if (init?.method === "PUT") {
        // unlinkFromBrevoList
        return jsonRes(200, {});
      }
      // GET /contacts/{email} (Brevo, passo 0/2) — sends=opens=3 >= piso → promote
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
        newsletterBackend: "kit",
        kitApiKey: "kkey",
      });

      assert.equal(result.failed, 0);
      assert.equal(result.promoted, 1);
      assert.deepEqual(beehiivSubscriptionWrites, [], "promoção com backend=kit nunca deve DELETAR/CRIAR subscription na Beehiiv");
      assert.ok(kitUrls.some((u) => u.startsWith("POST") && u.endsWith("/subscribers")), "esperava POST /subscribers no Kit");
      assert.ok(kitUrls.some((u) => u.startsWith("GET") && u.includes("/subscribers/777")), "esperava GET /subscribers/{id} (releitura) no Kit");

      const stored = findContact(result.store, "promo@b.com");
      assert.equal(stored!.status, "promoted_beehiiv");
      assert.equal(stored!.resolution_reason, "score_threshold_kit", "auditoria: promovido via Kit, não Beehiiv");
    } finally {
      restore();
    }
  });

  it('newsletterBackend="kit" + push=true, mas kitApiKey ausente → lança (nunca promove sem credencial, e nunca cai pro caminho Beehiiv por engano)', async () => {
    globalThis.fetch = (async (u: string | URL) => {
      const url = String(u);
      if (url.includes("api.kit.com")) {
        throw new Error(`chamada inesperada em ${url} — kitApiKey ausente deveria abortar ANTES de qualquer fetch de promoção`);
      }
      if (url.includes("/publications/") && url.includes("subscriptions/by_email/")) {
        // Passo 1 (auto-confirmação) — checagem independente, "pending" pra
        // deixar a avaliação seguir pro score (que decide "promote").
        return jsonRes(200, { data: { status: "pending" } });
      }
      // GET /contacts/{email} (Brevo) — força a decisão "promote"
      return jsonRes(200, {
        statistics: {
          messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
          opened: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
        },
      });
    }) as typeof fetch;

    try {
      const contacts = [contact("promo2@b.com")];
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
        // kitApiKey ausente de propósito
      });
      // #4398: falha por contato nunca aborta o run inteiro — o erro lançado
      // dentro do try/catch por contato vira `failed++`. `promoted` conta a
      // DECISÃO (evalResult.action === "promote_to_beehiiv"), não o sucesso —
      // mesma semântica não-exclusiva documentada em `RunEvaluationResult`
      // (um contato pode incrementar `promoted` E `failed` no mesmo run). O
      // que importa pro fix do #6339 é o `store`: continua `in_brevo`, NUNCA
      // promovido sem credencial.
      assert.equal(result.failed, 1);
      assert.equal(result.promoted, 1);
      const stored = findContact(result.store, "promo2@b.com");
      assert.equal(stored!.status, "in_brevo", "sem kitApiKey, o contato NUNCA é promovido nem escrito em nenhum backend");
    } finally {
      restore();
    }
  });

  it('newsletterBackend omitido (default) → preserva o caminho Beehiiv pré-#6339, resolution_reason continua "score_threshold"', async () => {
    let byEmailCalls = 0;
    globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
      const url = String(u);
      if (url.includes("api.kit.com")) {
        // #7382 — checagem cross-plataforma antes de promover pra Beehiiv:
        // contato NÃO existe no Kit, promoção pra Beehiiv segue normal.
        return jsonRes(200, { subscribers: [], pagination: {} });
      }
      if (url.includes("subscriptions/by_email/")) {
        byEmailCalls++;
        if (byEmailCalls === 1) return jsonRes(200, { data: { status: "pending" } });
        if (byEmailCalls === 2) return jsonRes(200, { data: { id: "sub_x", status: "pending" } });
        return jsonRes(200, { data: { status: "active" } });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("/publications/pub_1/subscriptions") && init?.method === "POST") return jsonRes(200, {});
      if (init?.method === "PUT") return jsonRes(200, {});
      return jsonRes(200, {
        statistics: {
          messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
          opened: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
        },
      });
    }) as typeof fetch;

    try {
      const contacts = [contact("default-backend@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
        kitApiKey: "kkey", // #7382 — necessário pra checagem cross-plataforma antes de promover
        // newsletterBackend omitido de propósito
      });
      assert.equal(result.failed, 0);
      assert.equal(result.promoted, 1);
      assert.equal(result.skippedActiveOnKit, 0, "#7382 — contato não está no Kit, promoção segue normal");
      const stored = findContact(result.store, "default-backend@b.com");
      assert.equal(stored!.resolution_reason, "score_threshold");
    } finally {
      restore();
    }
  });
});
