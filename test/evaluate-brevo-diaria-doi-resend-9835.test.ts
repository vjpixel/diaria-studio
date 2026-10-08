/**
 * test/evaluate-brevo-diaria-doi-resend-9835.test.ts (#9835)
 *
 * Regressão: contato `in_brevo` que cumpre a regra de promoção por abertura
 * mas já existe no Kit como `inactive` caía em `await_self_confirmation`
 * (#8728) e ficava preso na Brevo sem ação nenhuma (15 contatos em
 * 07/10/2026). Decisão do editor: reenviar o double opt-in (vínculo ao
 * designer form de DOI), no máximo 1x a cada DOI_RESEND_INTERVAL_DAYS, nunca
 * pra cancelled/bounced/complained, nunca forçando `state`.
 *
 * Sem rede: `globalThis.fetch` é substituído em todos os casos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEvaluation, shouldResendKitDoi, resendKitDoi } from "../scripts/evaluate-brevo-diaria.ts";
import {
  findContact,
  needsDoiResend,
  markDoiResent,
  DOI_RESEND_INTERVAL_DAYS,
  AWAITING_KIT_CONFIRMATION_STALE_DAYS,
  type BrevoDiariaContact,
} from "../scripts/lib/brevo-diaria-store.ts";

const DOI_FORM = "9897918";
const NOW = "2026-10-07T12:00:00.000Z";
const daysAgo = (d: number, from = NOW) => new Date(Date.parse(from) - d * 86_400_000).toISOString();

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

function brevoStatsRes(opens: number, sends: number): Response {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ campaignId: i + 1 }));
  return jsonRes(200, { statistics: { messagesSent: ids(sends), opened: ids(opens) } });
}

interface FakeKit {
  state: string;
  formStatus?: number;
  opens?: number;
  sends?: number;
}

/** Instala um fetch falso e devolve os contadores de chamadas ao Kit. */
function installFetch(k: FakeKit) {
  const calls = { formPosts: [] as string[], subscriberPosts: 0 };
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("/forms/") && method === "POST") {
      calls.formPosts.push(u);
      return jsonRes(k.formStatus ?? 201, { subscriber: { id: 77 } });
    }
    if (u.includes("api.kit.com/v4/subscribers") && u.includes("email_address=")) {
      const email = new URL(u).searchParams.get("email_address") ?? "leitor@x.com";
      return jsonRes(200, {
        subscribers: [{ id: 77, email_address: email, state: k.state, created_at: "2026-09-01T00:00:00.000Z" }],
      });
    }
    if (u.includes("api.kit.com") && method !== "GET") {
      calls.subscriberPosts++;
      return jsonRes(200, { subscriber: { id: 77, email_address: "leitor@x.com", state: k.state, created_at: "x" } });
    }
    return brevoStatsRes(k.opens ?? 3, k.sends ?? 3);
  }) as typeof fetch;
  return calls;
}

async function run(c: BrevoDiariaContact | BrevoDiariaContact[], opts: { push?: boolean; kitDoiFormId?: string; log?: (m: string) => void } = {}) {
  const contacts = Array.isArray(c) ? c : [c];
  return runEvaluation({
    contacts,
    store: { contacts },
    push: opts.push ?? true,
    publicationId: "pub_1",
    beehiivApiKey: "bkey",
    brevoApiKey: "brkey",
    listId: 7,
    log: opts.log ?? (() => {}),
    newsletterBackend: "kit",
    kitApiKey: "kkey",
    kitDoiFormId: "kitDoiFormId" in opts ? opts.kitDoiFormId : DOI_FORM,
  });
}

describe("needsDoiResend / markDoiResent — puras (#9835)", () => {
  it("intervalo default é o mesmo prazo do alarme de espera (7 dias)", () => {
    assert.equal(DOI_RESEND_INTERVAL_DAYS, AWAITING_KIT_CONFIRMATION_STALE_DAYS);
    assert.equal(DOI_RESEND_INTERVAL_DAYS, 7);
  });
  it("nunca reenviado → true", () => {
    assert.equal(needsDoiResend(contact("a@x.com"), NOW), true);
  });
  it("reenviado há menos de 7 dias → false", () => {
    assert.equal(needsDoiResend(contact("a@x.com", { doi_resent_at: daysAgo(6.9) }), NOW), false);
  });
  it("reenviado há 7 dias ou mais → true", () => {
    assert.equal(needsDoiResend(contact("a@x.com", { doi_resent_at: daysAgo(7) }), NOW), true);
  });
  it("timestamp ilegível → false (na dúvida não reenvia)", () => {
    assert.equal(needsDoiResend(contact("a@x.com", { doi_resent_at: "lixo" }), NOW), false);
  });
  it("contato fora de in_brevo → false", () => {
    assert.equal(needsDoiResend(contact("a@x.com", { status: "promoted_beehiiv" }), NOW), false);
  });
  it("markDoiResent grava o timestamp só no contato in_brevo certo", () => {
    const store = { contacts: [contact("a@x.com"), contact("b@x.com")] };
    const out = markDoiResent(store, "A@x.com", NOW);
    assert.equal(findContact(out, "a@x.com")!.doi_resent_at, NOW);
    assert.equal(findContact(out, "b@x.com")!.doi_resent_at, undefined);
  });
});

describe("shouldResendKitDoi — pura (#9835)", () => {
  const base = { qualifiesByOpenRate: true, kitState: "inactive", contact: contact("a@x.com"), now: NOW };
  it("qualifica + inactive + sem reenvio anterior → true", () => {
    assert.equal(shouldResendKitDoi(base), true);
  });
  it("não qualifica por abertura → false", () => {
    assert.equal(shouldResendKitDoi({ ...base, qualifiesByOpenRate: false }), false);
  });
  for (const state of ["cancelled", "bounced", "complained", "active"]) {
    it(`estado ${state} no Kit → false`, () => {
      assert.equal(shouldResendKitDoi({ ...base, kitState: state }), false);
    });
  }
  it("já reenviado há menos de 7 dias → false", () => {
    assert.equal(shouldResendKitDoi({ ...base, contact: contact("a@x.com", { doi_resent_at: daysAgo(2) }) }), false);
  });
});

describe("resendKitDoi (#9835)", () => {
  it("form de sistema é recusado sem chamar a API", async () => {
    let calls = 0;
    const r = await resendKitDoi({
      subscriberId: 1,
      apiKey: "k",
      formId: "9839463",
      fetchImpl: (async () => {
        calls++;
        return jsonRes(201, {});
      }) as typeof fetch,
    });
    assert.equal(r.ok, false);
    assert.equal(calls, 0);
  });
  it("2xx → ok; POST vai pra /forms/{form}/subscribers/{id}", async () => {
    const urls: string[] = [];
    const r = await resendKitDoi({
      subscriberId: 77,
      apiKey: "k",
      formId: DOI_FORM,
      fetchImpl: (async (u: string | URL) => {
        urls.push(String(u));
        return jsonRes(201, {});
      }) as typeof fetch,
    });
    assert.equal(r.ok, true);
    assert.match(urls[0]!, /\/forms\/9897918\/subscribers\/77$/);
  });
  it("não-2xx → ok:false com motivo", async () => {
    const r = await resendKitDoi({
      subscriberId: 77,
      apiKey: "k",
      formId: DOI_FORM,
      fetchImpl: (async () => jsonRes(422, { errors: ["x"] })) as typeof fetch,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /422/);
  });
});

describe("runEvaluation — reenvio do DOI no ramo await_self_confirmation (#9835)", () => {
  const origFetch = globalThis.fetch;

  it("qualifica + inactive + sem cancelamento → reenvia 1x, grava doi_resent_at, nunca POST em /subscribers", async () => {
    const calls = installFetch({ state: "inactive" });
    try {
      const result = await run(contact("leitor@x.com"));
      assert.equal(calls.formPosts.length, 1);
      assert.match(calls.formPosts[0]!, /\/forms\/9897918\/subscribers\/77$/);
      assert.equal(calls.subscriberPosts, 0, "nunca tenta ativar à força");
      assert.equal(result.doiResent, 1);
      assert.equal(result.awaitingKitConfirmation, 1);
      assert.equal(result.failed, 0);
      const stored = findContact(result.store, "leitor@x.com")!;
      assert.equal(stored.status, "in_brevo");
      assert.ok(stored.doi_resent_at);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("já reenviado há menos de 7 dias → não reenvia", async () => {
    const calls = installFetch({ state: "inactive" });
    try {
      const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
      const result = await run(contact("leitor@x.com", { doi_resent_at: recent }));
      assert.equal(calls.formPosts.length, 0);
      assert.equal(result.doiResent, 0);
      assert.equal(findContact(result.store, "leitor@x.com")!.doi_resent_at, recent);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("reenviado há mais de 7 dias → reenvia de novo", async () => {
    const calls = installFetch({ state: "inactive" });
    try {
      const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
      const result = await run(contact("leitor@x.com", { doi_resent_at: old }));
      assert.equal(calls.formPosts.length, 1);
      assert.equal(result.doiResent, 1);
      assert.notEqual(findContact(result.store, "leitor@x.com")!.doi_resent_at, old);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("não qualifica por abertura → nem chega ao Kit, não reenvia", async () => {
    const calls = installFetch({ state: "inactive", opens: 0, sends: 3 });
    try {
      const result = await run(contact("leitor@x.com"));
      assert.equal(calls.formPosts.length, 0);
      assert.equal(result.doiResent, 0);
      assert.equal(findContact(result.store, "leitor@x.com")!.doi_resent_at, undefined);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  for (const state of ["cancelled", "bounced", "complained"]) {
    it(`Kit ${state} → aguarda sem reenviar`, async () => {
      const calls = installFetch({ state });
      try {
        const result = await run(contact("leitor@x.com"));
        assert.equal(calls.formPosts.length, 0);
        assert.equal(result.doiResent, 0);
        assert.equal(result.awaitingKitConfirmation, 1);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  }

  it("dry-run → nenhuma escrita no Kit, store sem doi_resent_at", async () => {
    const calls = installFetch({ state: "inactive" });
    try {
      const result = await run(contact("leitor@x.com"), { push: false });
      assert.equal(calls.formPosts.length, 0);
      assert.equal(calls.subscriberPosts, 0);
      assert.equal(result.doiResent, 0);
      assert.equal(findContact(result.store, "leitor@x.com")!.doi_resent_at, undefined);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("sem kitDoiFormId → comportamento do #8728 preservado (só aguarda)", async () => {
    const calls = installFetch({ state: "inactive" });
    try {
      const result = await run(contact("leitor@x.com"), { kitDoiFormId: undefined });
      assert.equal(calls.formPosts.length, 0);
      assert.equal(result.doiResent, 0);
      assert.equal(result.awaitingKitConfirmation, 1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("vínculo falha → warn + failed, sem doi_resent_at, rodada segue", async () => {
    const calls = installFetch({ state: "inactive", formStatus: 500 });
    try {
      const result = await run(contact("leitor@x.com"));
      assert.equal(calls.formPosts.length, 1);
      assert.equal(result.doiResent, 0);
      assert.equal(result.failed, 1);
      assert.match(result.failedContacts[0]!.reason, /falha ao reenviar double opt-in do Kit/);
      const stored = findContact(result.store, "leitor@x.com")!;
      assert.equal(stored.status, "in_brevo");
      assert.equal(stored.doi_resent_at, undefined);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("vínculo com 429 → failed marcado kitRateLimited (#9291)", async () => {
    installFetch({ state: "inactive", formStatus: 429 });
    try {
      const result = await run(contact("leitor@x.com"));
      assert.equal(result.failed, 1);
      assert.equal(result.failedContacts[0]!.kitRateLimited, true);
      assert.equal(result.kitRateLimited, 1);
      assert.equal(findContact(result.store, "leitor@x.com")!.doi_resent_at, undefined);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("exceção de rede no vínculo → failed, sem doi_resent_at, nunca lança", async () => {
    installFetch({ state: "inactive" });
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/forms/")) throw new Error("ECONNRESET");
      return inner(url, init);
    }) as typeof fetch;
    try {
      const result = await run(contact("leitor@x.com"));
      assert.equal(result.failed, 1);
      assert.match(result.failedContacts[0]!.reason, /ECONNRESET/);
      assert.equal(findContact(result.store, "leitor@x.com")!.doi_resent_at, undefined);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("form de sistema no config → 1 warn por rodada, zero vínculo, zero failed (nunca N falhas idênticas)", async () => {
    const calls = installFetch({ state: "inactive" });
    const logs: string[] = [];
    try {
      const result = await run([contact("leitor@x.com"), contact("leitor2@x.com")], { kitDoiFormId: "9839463", log: (m) => logs.push(m) });
      assert.equal(calls.formPosts.length, 0);
      assert.equal(result.failed, 0);
      assert.equal(result.doiResent, 0);
      assert.equal(logs.filter((l) => l.includes("reenvio do double opt-in desligado")).length, 1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("vínculo 200 (já vinculado) conta como reenvio mas o log avisa que o Kit pode não reenviar", async () => {
    installFetch({ state: "inactive", formStatus: 200 });
    const logs: string[] = [];
    try {
      const result = await run(contact("leitor@x.com"), { log: (m) => logs.push(m) });
      assert.equal(result.doiResent, 1);
      assert.ok(logs.some((l) => l.includes("HTTP 200") && l.includes("pode não reenviar")));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("qualifica mas está dentro da janela → log com o motivo do não-reenvio", async () => {
    installFetch({ state: "inactive" });
    const logs: string[] = [];
    try {
      const recent = new Date(Date.now() - 86_400_000).toISOString();
      await run(contact("leitor@x.com", { doi_resent_at: recent }), { log: (m) => logs.push(m) });
      assert.ok(logs.some((l) => l.includes("NÃO reenviado") && l.includes(recent)));
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
