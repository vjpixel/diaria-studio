/**
 * test/kit-sem-abertura-complaint-blacklist-10568.test.ts (#10568)
 *
 * Regressão: `latestBlacklistEventTime` só lia descadastro (user/admin) e hard
 * bounce. Um contato `kit-sem-abertura:` que reclamava de spam DEPOIS de
 * entrar na lista (evento só em `statistics.complaints`) ficava sem evento
 * datado ⇒ `isKitSemAberturaBlacklistNew` = false ⇒ com `--push` o caminho do
 * #10557 tirava a tag `envio-brevo` no Kit e gravava `converted_to_kit` — quem
 * reclamou de spam voltava a receber a diária pelo Kit.
 *
 * Duas travas:
 * - `complaints` entra na datação do blacklist (vira saída nova, nunca reversão);
 * - evento de blacklist SEM data legível não autoriza a reversão (nem o
 *   descadastro no Kit): o contato fica `in_brevo`, contado à parte.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runEvaluation,
  latestBlacklistEventTime,
  hasUndatedBlacklistEvent,
  type BrevoContactStatistics,
  type KitEnvioBrevoTagDeps,
} from "../scripts/evaluate-brevo-diaria.ts";
import { findContact, type BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";

/** Eventos reais da Brevo trazem `eventTime`, que `BrevoStatEvent` não declara. */
const st = (o: unknown) => o as BrevoContactStatistics;

const ADDED_AT = "2026-10-10T00:00:00.000Z";

function movedContact(email: string): BrevoDiariaContact {
  return {
    email,
    beehiiv_subscription_id: "kit-sem-abertura:42",
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_open_rate: null,
    added_at: ADDED_AT,
    last_evaluated_at: null,
  };
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function brevoBlacklisted(statistics: Record<string, unknown>, http: string[]) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    http.push(`${method} ${u}`);
    if (u.includes("beehiiv") || u.includes("api.kit.com")) throw new Error(`não deveria tocar ${u}`);
    if (method !== "GET") return jsonRes(200, {});
    return jsonRes(200, {
      emailBlacklisted: true,
      listIds: [7],
      statistics: { messagesSent: [{ campaignId: 1, eventTime: "2026-10-11T09:00:00Z" }], opened: [], ...statistics },
    });
  }) as typeof fetch;
}

async function evaluate(statistics: Record<string, unknown>) {
  const http: string[] = [];
  const kit: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = brevoBlacklisted(statistics, http);
  const tagDeps: KitEnvioBrevoTagDeps = {
    findTagId: async () => {
      kit.push("findTag");
      return 555;
    },
    untag: async (tagId, id) => {
      kit.push(`untag:${tagId}:${id}`);
    },
    listTags: async (id) => {
      kit.push(`listTags:${id}`);
      return [];
    },
  };
  try {
    const contact = movedContact("m@x.com");
    const r = await runEvaluation({
      contacts: [contact],
      store: { contacts: [contact] },
      push: true,
      publicationId: "pub",
      beehiivApiKey: "b",
      brevoApiKey: "br",
      kitApiKey: "k",
      listId: 7,
      log: () => {},
      newsletterBackend: "kit",
      appendKitSemAberturaLog: () => {},
      unsubscribeKitSemAberturaDeps: {
        unsubscribe: async (id: number) => {
          kit.push(`unsubscribe:${id}`);
        },
        getState: async (id: number) => {
          kit.push(`get:${id}`);
          return kit.some((k) => k.startsWith("unsubscribe:")) ? "cancelled" : "active";
        },
      },
      kitEnvioBrevoTagDeps: tagDeps,
    });
    return { r, http, kit };
  } finally {
    globalThis.fetch = origFetch;
  }
}

describe("helpers puros (#10568)", () => {
  it("latestBlacklistEventTime inclui statistics.complaints", () => {
    assert.equal(
      latestBlacklistEventTime(
        st({
          hardBounces: [{ campaignId: 1, eventTime: "2026-08-01T00:00:00Z" }],
          complaints: [{ campaignId: 2, eventTime: "2026-10-12T08:00:00Z" }],
        }),
      ),
      "2026-10-12T08:00:00.000Z",
    );
    assert.equal(latestBlacklistEventTime(st({ complaints: [{ campaignId: 2, eventTime: "2026-10-12T08:00:00Z" }] })), "2026-10-12T08:00:00.000Z");
  });

  it("hasUndatedBlacklistEvent: só com evento sem horário legível", () => {
    assert.equal(hasUndatedBlacklistEvent(undefined), false);
    assert.equal(hasUndatedBlacklistEvent({}), false, "sem evento algum não é 'sem data'");
    assert.equal(hasUndatedBlacklistEvent(st({ complaints: [{ campaignId: 2, eventTime: "2026-10-12T08:00:00Z" }] })), false);
    assert.equal(hasUndatedBlacklistEvent({ complaints: [{ campaignId: 2 }] }), true);
    assert.equal(hasUndatedBlacklistEvent(st({ hardBounces: [{ campaignId: 2, eventTime: "lixo" }] })), true);
    assert.equal(hasUndatedBlacklistEvent({ unsubscriptions: { adminUnsubscription: [{}] } }), true);
    assert.equal(hasUndatedBlacklistEvent(st({ unsubscriptions: { userUnsubscription: ["x"] } })), true);
  });
});

describe("evaluate: reclamação de spam posterior à entrada não devolve ao Kit (#10568)", () => {
  it("complaint datado depois de added_at ⇒ saída nas duas bases, nunca reversão", async () => {
    const { r, kit } = await evaluate({ complaints: [{ campaignId: 3, eventTime: "2026-10-12T08:00:00Z" }] });
    assert.ok(!kit.some((k) => k.startsWith("untag:")), "nunca remove a tag envio-brevo (reversão do #10557)");
    assert.ok(kit.includes("unsubscribe:42"), "a reclamação é saída: descadastra no Kit");
    const c = findContact(r.store, "m@x.com")!;
    assert.notEqual(c.status, "converted_to_kit");
    assert.notEqual(c.status, "in_brevo");
    assert.equal(r.kitSemAberturaPreexistingBlacklist, 0);
    assert.equal(r.kitSemAberturaBlacklistReverted, 0);
  });

  it("complaint SEM data (e nada datado depois da entrada) ⇒ fica in_brevo, Kit intocado", async () => {
    const { r, http, kit } = await evaluate({
      hardBounces: [{ campaignId: 9, eventTime: "2026-08-01T00:00:00Z" }],
      complaints: [{ campaignId: 3 }],
    });
    assert.deepEqual(kit, [], "nem reversão nem descadastro no Kit");
    assert.ok(!http.some((h) => h.startsWith("PUT ")), "nada desvinculado da lista Brevo");
    assert.equal(findContact(r.store, "m@x.com")!.status, "in_brevo");
    assert.equal(r.kitSemAberturaBlacklistUndated, 1);
    assert.equal(r.kitSemAberturaPreexistingBlacklist, 0);
    assert.equal(r.kitSemAberturaBlacklistReverted, 0);
    assert.equal(r.failed, 0);
  });

  it("blacklist só com eventos datados anteriores segue revertido (#10557 intacto)", async () => {
    const { r, kit } = await evaluate({ hardBounces: [{ campaignId: 9, eventTime: "2026-08-01T00:00:00Z" }] });
    assert.ok(kit.includes("untag:555:42"));
    assert.equal(findContact(r.store, "m@x.com")!.status, "converted_to_kit");
    assert.equal(r.kitSemAberturaBlacklistReverted, 1);
    assert.equal(r.kitSemAberturaBlacklistUndated, 0);
  });
});
