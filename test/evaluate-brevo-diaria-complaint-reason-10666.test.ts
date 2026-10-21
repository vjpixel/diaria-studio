/**
 * test/evaluate-brevo-diaria-complaint-reason-10666.test.ts (#10666)
 *
 * Regressão: o #10568 passou a contar reclamação de spam
 * (`statistics.complaints`) como saída nova de um contato `kit-sem-abertura:`,
 * mas o motivo da saída só olhava `userUnsubscribed`/`hardBounced` — a
 * reclamação caía em `native_admin_block` no store (e em `bouncedNative` no
 * dry-run), indistinguível de bloqueio administrativo. Agora ela grava
 * `native_complaint`, com contador próprio (`complainedNative`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runEvaluation,
  hasComplaint,
  nativeBounceReason,
  nativeBlacklistExitReason,
  type BrevoContactStatistics,
} from "../scripts/evaluate-brevo-diaria.ts";
import { applyBrevoDiariaBounced, findContact, type BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";

/** Eventos reais da Brevo trazem `eventTime`, que `BrevoStatEvent` não declara. */
const st = (o: unknown) => o as BrevoContactStatistics;

const ADDED_AT = "2026-10-10T00:00:00.000Z";
const COMPLAINT_AFTER = [{ campaignId: 3, eventTime: "2026-10-12T08:00:00Z" }];

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

function brevoBlacklisted(statistics: Record<string, unknown>) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("beehiiv") || u.includes("api.kit.com")) throw new Error(`não deveria tocar ${u}`);
    if (method !== "GET") return jsonRes(200, {});
    return jsonRes(200, {
      emailBlacklisted: true,
      listIds: [7],
      statistics: { messagesSent: [{ campaignId: 1, eventTime: "2026-10-11T09:00:00Z" }], opened: [], ...statistics },
    });
  }) as typeof fetch;
}

async function evaluate(statistics: Record<string, unknown>, push: boolean) {
  const kitLog: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = brevoBlacklisted(statistics);
  let unsubscribed = false;
  try {
    const contact = movedContact("m@x.com");
    const r = await runEvaluation({
      contacts: [contact],
      store: { contacts: [contact] },
      push,
      publicationId: "pub",
      beehiivApiKey: "b",
      brevoApiKey: "br",
      kitApiKey: "k",
      listId: 7,
      log: () => {},
      newsletterBackend: "kit",
      appendKitSemAberturaLog: (line) => {
        kitLog.push(line);
      },
      unsubscribeKitSemAberturaDeps: {
        unsubscribe: async () => {
          unsubscribed = true;
        },
        getState: async () => (unsubscribed ? "cancelled" : "active"),
      },
      kitEnvioBrevoTagDeps: {
        findTagId: async () => 555,
        untag: async () => {
          throw new Error("não deveria reverter a movimentação");
        },
        listTags: async () => [],
      },
    });
    return { r, kitLog, unsubscribed };
  } finally {
    globalThis.fetch = origFetch;
  }
}

describe("helpers puros (#10666)", () => {
  it("hasComplaint: só com >=1 reclamação", () => {
    assert.equal(hasComplaint(undefined), false);
    assert.equal(hasComplaint({}), false);
    assert.equal(hasComplaint({ complaints: [] }), false);
    assert.equal(hasComplaint(st({ complaints: "lixo" })), false);
    assert.equal(hasComplaint(st({ complaints: COMPLAINT_AFTER })), true);
  });

  it("nativeBounceReason: complaint antes de hard bounce; estado legado sem o campo segue igual", () => {
    assert.equal(nativeBounceReason({ hardBounced: false, spamComplained: true }), "native_complaint");
    assert.equal(nativeBounceReason({ hardBounced: true, spamComplained: true }), "native_complaint");
    assert.equal(nativeBounceReason({ hardBounced: true }), "native_bounce");
    assert.equal(nativeBounceReason({ hardBounced: false }), "native_admin_block");
  });

  it("nativeBlacklistExitReason: descadastro por clique vence a reclamação", () => {
    assert.equal(nativeBlacklistExitReason({ userUnsubscribed: true, hardBounced: false, spamComplained: true }), "native_unsubscribe");
    assert.equal(nativeBlacklistExitReason({ userUnsubscribed: false, hardBounced: false, spamComplained: true }), "native_complaint");
  });

  it("applyBrevoDiariaBounced grava native_complaint com status bounced", () => {
    const out = applyBrevoDiariaBounced({ contacts: [movedContact("m@x.com")] }, "m@x.com", "native_complaint", "2026-10-20T00:00:00.000Z");
    const c = findContact(out, "m@x.com")!;
    assert.equal(c.status, "bounced");
    assert.equal(c.resolution_reason, "native_complaint");
  });
});

describe("evaluate: reclamação de spam de kit-sem-abertura tem motivo próprio (#10666)", () => {
  it("push: store grava native_complaint (não native_admin_block), conta em complainedNative", async () => {
    const { r, kitLog, unsubscribed } = await evaluate({ complaints: COMPLAINT_AFTER }, true);
    assert.ok(unsubscribed, "saída nas duas bases segue acontecendo (#10437)");
    const c = findContact(r.store, "m@x.com")!;
    assert.equal(c.status, "bounced");
    assert.equal(c.resolution_reason, "native_complaint");
    assert.equal(r.complainedNative, 1);
    assert.equal(r.bouncedNative, 0, "reclamação não entra no contador de bounce/admin");
    assert.equal(kitLog.length, 1);
    assert.equal(JSON.parse(kitLog[0]).brevo_exit, "native_complaint");
  });

  it("dry-run: contagem vai pra complainedNative, não bouncedNative; store intocado", async () => {
    const { r, unsubscribed } = await evaluate({ complaints: COMPLAINT_AFTER }, false);
    assert.equal(unsubscribed, false);
    assert.equal(r.complainedNative, 1);
    assert.equal(r.bouncedNative, 0);
    assert.equal(findContact(r.store, "m@x.com")!.status, "in_brevo");
  });

  it("sem reclamação: bloqueio administrativo segue native_admin_block em bouncedNative", async () => {
    const { r } = await evaluate({ unsubscriptions: { adminUnsubscription: [{ campaignId: 3, eventTime: "2026-10-12T08:00:00Z" }] } }, true);
    const c = findContact(r.store, "m@x.com")!;
    assert.equal(c.resolution_reason, "native_admin_block");
    assert.equal(r.bouncedNative, 1);
    assert.equal(r.complainedNative, 0);
  });
});
