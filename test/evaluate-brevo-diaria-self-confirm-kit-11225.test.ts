/**
 * test/evaluate-brevo-diaria-self-confirm-kit-11225.test.ts (#11225)
 *
 * Regressão: a auto-confirmação do Passo 1 (contato de origem Beehiiv que
 * confirmou o double opt-in da Beehiiv sozinho) só desvinculava o contato da
 * fila Brevo e dependia da ponte `sync-beehiiv-subscribers-kit.ts` pra
 * colocá-lo no Kit. A ponte foi aposentada no #11225 (Beehiiv só arquivo
 * histórico). Sem a escrita direta no Kit, o contato sairia da fila Brevo e
 * nunca receberia a diária — o dead end silencioso que
 * `test/sync-beehiiv-subscribers-kit-load-bearing-6339.test.ts` travava.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEvaluation, promoteSelfConfirmedBeehiivToKit } from "../scripts/evaluate-brevo-diaria.ts";
import { findContact, type BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";
import { KIT_ORIGEM_CADASTRO_FIELD_NAME, KIT_BEEHIIV_SYNC_SIGNUP_MARKER } from "../scripts/lib/shared/kit-signup-origin.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function contact(email: string): BrevoDiariaContact {
  return {
    email,
    beehiiv_subscription_id: `sub_${email}`,
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_open_rate: null,
    added_at: "2026-07-01T00:00:00.000Z",
    last_evaluated_at: null,
  };
}

interface KitFake {
  existing: { id: number; state: string } | null;
  afterPostState: string;
  posts: Array<Record<string, unknown>>;
  unlinked: boolean;
}

function installFetch(fake: KitFake): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "active" } });
    if (u.includes("api.kit.com")) {
      if (method === "POST" && /\/subscribers$/.test(u)) {
        fake.posts.push(JSON.parse(init!.body as string));
        return jsonRes(200, { subscriber: { id: 900, email_address: "x", state: fake.afterPostState, created_at: "x" } });
      }
      if (/\/subscribers\/900/.test(u)) {
        return jsonRes(200, { subscriber: { id: 900, email_address: "x", state: fake.afterPostState, created_at: "x" } });
      }
      if (u.includes("email_address=")) {
        const email = decodeURIComponent(new URL(u).searchParams.get("email_address") ?? "");
        const subs = fake.existing ? [{ ...fake.existing, email_address: email, created_at: "x", fields: {} }] : [];
        return jsonRes(200, { subscribers: subs, pagination: { has_next_page: false } });
      }
      throw new Error(`fetch Kit inesperado: ${method} ${u}`);
    }
    if (method === "PUT") {
      fake.unlinked = true;
      return jsonRes(200, {});
    }
    if (u.includes("/contacts/")) return jsonRes(200, { emailBlacklisted: false, statistics: { messagesSent: [], opened: [] } });
    throw new Error(`fetch inesperado: ${method} ${u}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

async function run(fake: KitFake, opts: { kitApiKey?: string } = { kitApiKey: "kkey" }) {
  const contacts = [contact("auto@b.com")];
  return runEvaluation({
    contacts,
    store: { contacts },
    push: true,
    publicationId: "pub_1",
    beehiivApiKey: "bkey",
    brevoApiKey: "brkey",
    listId: 7,
    log: () => {},
    newsletterBackend: "kit",
    kitApiKey: opts.kitApiKey,
  });
}

describe("auto-confirmação Beehiiv escreve direto no Kit (#11225)", () => {
  it("contato inexistente no Kit → POST active com origem beehiiv-sync, releitura active, sai da fila Brevo", async () => {
    const fake: KitFake = { existing: null, afterPostState: "active", posts: [], unlinked: false };
    const restore = installFetch(fake);
    try {
      const result = await run(fake);
      assert.equal(result.selfConfirmed, 1);
      assert.equal(result.failed, 0);
      assert.equal(fake.posts.length, 1, "escreveu no Kit exatamente 1x");
      const body = fake.posts[0] as { state: string; fields: Record<string, string> };
      assert.equal(body.state, "active");
      assert.equal(body.fields[KIT_ORIGEM_CADASTRO_FIELD_NAME], KIT_BEEHIIV_SYNC_SIGNUP_MARKER);
      assert.equal(fake.unlinked, true);
      assert.equal(findContact(result.store, "auto@b.com")!.resolution_reason, "self_confirmed_beehiiv");
    } finally {
      restore();
    }
  });

  it("releitura do Kit não confirma active → mantém in_brevo, failed, nunca desvincula", async () => {
    const fake: KitFake = { existing: null, afterPostState: "inactive", posts: [], unlinked: false };
    const restore = installFetch(fake);
    try {
      const result = await run(fake);
      assert.equal(result.selfConfirmed, 0);
      assert.equal(result.failed, 1);
      assert.equal(fake.unlinked, false, "nunca sai da fila Brevo sem o Kit confirmar");
      assert.equal(findContact(result.store, "auto@b.com")!.status, "in_brevo");
    } finally {
      restore();
    }
  });

  it("já existe no Kit como cancelled → não reativa (#8728), mantém in_brevo", async () => {
    const fake: KitFake = { existing: { id: 900, state: "cancelled" }, afterPostState: "cancelled", posts: [], unlinked: false };
    const restore = installFetch(fake);
    try {
      const result = await run(fake);
      assert.equal(fake.posts.length, 0, "nenhum POST pra quem saiu do Kit");
      assert.equal(result.failed, 1);
      assert.equal(fake.unlinked, false);
    } finally {
      restore();
    }
  });

  it("KIT_API_KEY ausente → falha segura, sem desvincular", async () => {
    const fake: KitFake = { existing: null, afterPostState: "active", posts: [], unlinked: false };
    const restore = installFetch(fake);
    try {
      const result = await run(fake, { kitApiKey: undefined });
      assert.equal(result.failed, 1);
      assert.equal(fake.posts.length, 0);
      assert.equal(fake.unlinked, false);
    } finally {
      restore();
    }
  });

  it("promoteSelfConfirmedBeehiivToKit: já active no Kit → POST idempotente confirma", async () => {
    const fake: KitFake = { existing: { id: 900, state: "active" }, afterPostState: "active", posts: [], unlinked: false };
    const restore = installFetch(fake);
    try {
      assert.deepEqual(await promoteSelfConfirmedBeehiivToKit("auto@b.com", "kkey"), { confirmed: true });
    } finally {
      restore();
    }
  });
});
