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
import {
  runEvaluation,
  promoteSelfConfirmedBeehiivToKit,
  buildBeehiivSyncKitFields,
  resolveBeehiivAttribution,
} from "../scripts/evaluate-brevo-diaria.ts";
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
  /** Status HTTP do POST /v4/subscribers (default 200). */
  postStatus?: number;
  beehiivSub?: Record<string, string>;
  posts: Array<Record<string, unknown>>;
  unlinked: boolean;
}

function fake(overrides: Partial<KitFake> = {}): KitFake {
  return { existing: null, afterPostState: "active", posts: [], unlinked: false, ...overrides };
}

function installFetch(f: KitFake): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "active", ...(f.beehiivSub ?? {}) } });
    if (u.includes("api.kit.com")) {
      if (method === "POST" && /\/subscribers$/.test(u)) {
        f.posts.push(JSON.parse(init!.body as string));
        if (f.postStatus && f.postStatus >= 400) return jsonRes(f.postStatus, { errors: ["inválido"] });
        return jsonRes(200, { subscriber: { id: 900, email_address: "x", state: f.afterPostState, created_at: "x" } });
      }
      if (/\/subscribers\/900/.test(u)) {
        return jsonRes(200, { subscriber: { id: 900, email_address: "x", state: f.afterPostState, created_at: "x" } });
      }
      if (u.includes("email_address=")) {
        const email = decodeURIComponent(new URL(u).searchParams.get("email_address") ?? "");
        const subs = f.existing ? [{ ...f.existing, email_address: email, created_at: "x", fields: {} }] : [];
        return jsonRes(200, { subscribers: subs, pagination: { has_next_page: false } });
      }
      throw new Error(`fetch Kit inesperado: ${method} ${u}`);
    }
    if (method === "PUT") {
      f.unlinked = true;
      return jsonRes(200, {});
    }
    if (u.includes("/contacts/")) return jsonRes(200, { emailBlacklisted: false, statistics: { messagesSent: [], opened: [] } });
    throw new Error(`fetch inesperado: ${method} ${u}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

async function run(
  opts: { kitApiKey?: string; push?: boolean } = {},
) {
  const contacts = [contact("auto@b.com")];
  return runEvaluation({
    contacts,
    store: { contacts },
    push: opts.push ?? true,
    publicationId: "pub_1",
    beehiivApiKey: "bkey",
    brevoApiKey: "brkey",
    listId: 7,
    log: () => {},
    kitApiKey: "kitApiKey" in opts ? opts.kitApiKey : "kkey",
  });
}

describe("auto-confirmação Beehiiv escreve direto no Kit (#11225)", () => {
  it("contato inexistente no Kit → POST active com origem beehiiv-sync, releitura active, sai da fila Brevo", async () => {
    const f = fake();
    const restore = installFetch(f);
    try {
      const result = await run();
      assert.equal(result.selfConfirmed, 1);
      assert.equal(result.failed, 0);
      assert.equal(f.posts.length, 1, "escreveu no Kit exatamente 1x");
      const body = f.posts[0] as { state: string; fields: Record<string, string> };
      assert.equal(body.state, "active");
      assert.equal(body.fields[KIT_ORIGEM_CADASTRO_FIELD_NAME], KIT_BEEHIIV_SYNC_SIGNUP_MARKER);
      assert.equal(f.unlinked, true);
      assert.equal(findContact(result.store, "auto@b.com")!.resolution_reason, "self_confirmed_beehiiv");
    } finally {
      restore();
    }
  });

  it("atribuição da Beehiiv (#8060) vai no POST, com acquisition_source como fallback do utm_source", async () => {
    const f = fake({ beehiivSub: { acquisition_source: "website: chatgpt.com / (none)", utm_medium: "referral" } });
    const restore = installFetch(f);
    try {
      await run();
      const fields = (f.posts[0] as { fields: Record<string, string> }).fields;
      assert.equal(fields.utm_source, "website: chatgpt.com / (none)");
      assert.equal(fields.utm_medium, "referral");
      assert.ok(fields.atribuicao_fonte, "buildAttributionFields grava atribuicao_fonte (backfill pula)");
      assert.equal(fields[KIT_ORIGEM_CADASTRO_FIELD_NAME], KIT_BEEHIIV_SYNC_SIGNUP_MARKER);
    } finally {
      restore();
    }
  });

  it("já active no Kit → nenhum POST (preserva origem_cadastro), desvincula e aplica self_confirmed", async () => {
    const f = fake({ existing: { id: 900, state: "active" } });
    const restore = installFetch(f);
    try {
      const result = await run();
      assert.equal(f.posts.length, 0, "upsert sobrescreveria origem_cadastro com beehiiv-sync");
      assert.equal(result.selfConfirmed, 1);
      assert.equal(result.failed, 0);
      assert.equal(f.unlinked, true);
    } finally {
      restore();
    }
  });

  it("releitura do Kit não confirma active → mantém in_brevo, failed, nunca desvincula", async () => {
    const f = fake({ afterPostState: "inactive" });
    const restore = installFetch(f);
    try {
      const result = await run();
      assert.equal(result.selfConfirmed, 0);
      assert.equal(result.failed, 1);
      assert.equal(f.unlinked, false, "nunca sai da fila Brevo sem o Kit confirmar");
      assert.equal(findContact(result.store, "auto@b.com")!.status, "in_brevo");
    } finally {
      restore();
    }
  });

  it("já existe no Kit como cancelled → não reativa (#8728), sem failed, conta em beehiivSelfConfirmedAwaitingKit", async () => {
    const f = fake({ existing: { id: 900, state: "cancelled" }, afterPostState: "cancelled" });
    const restore = installFetch(f);
    try {
      const result = await run();
      assert.equal(f.posts.length, 0, "nenhum POST pra quem saiu do Kit");
      assert.equal(result.selfConfirmed, 0);
      assert.equal(result.failed, 0, "kept_non_active não é falha — contar toda rodada reabriria o bloqueio do #8728");
      assert.equal(result.beehiivSelfConfirmedAwaitingKit, 1);
      assert.equal(f.unlinked, false);
      assert.equal(findContact(result.store, "auto@b.com")!.status, "in_brevo");
    } finally {
      restore();
    }
  });

  it("POST do Kit devolve 422 (sem retry) → failed=1, kitRateLimited=0, não desvincula", async () => {
    const f = fake({ postStatus: 422 });
    const restore = installFetch(f);
    try {
      const result = await run();
      assert.equal(result.failed, 1);
      assert.equal(result.kitRateLimited, 0);
      assert.equal(f.unlinked, false);
      assert.equal(findContact(result.store, "auto@b.com")!.status, "in_brevo");
    } finally {
      restore();
    }
  });

  it("KIT_API_KEY ausente → falha segura, sem desvincular", async () => {
    const f = fake();
    const restore = installFetch(f);
    try {
      const result = await run({ kitApiKey: undefined });
      assert.equal(result.failed, 1);
      assert.equal(f.posts.length, 0);
      assert.equal(f.unlinked, false);
    } finally {
      restore();
    }
  });

  it("push=false → zero escrita no Kit", async () => {
    const f = fake();
    const restore = installFetch(f);
    try {
      const result = await run({ push: false });
      assert.equal(f.posts.length, 0);
      assert.equal(f.unlinked, false);
      assert.equal(result.selfConfirmed, 1, "dry-run segue contando a auto-confirmação");
    } finally {
      restore();
    }
  });

  it("promoteSelfConfirmedBeehiivToKit: desfechos created e already_active", async () => {
    const created = fake();
    let restore = installFetch(created);
    try {
      assert.deepEqual(await promoteSelfConfirmedBeehiivToKit("auto@b.com", "kkey"), { outcome: "created" });
    } finally {
      restore();
    }
    const active = fake({ existing: { id: 900, state: "active" } });
    restore = installFetch(active);
    try {
      assert.deepEqual(await promoteSelfConfirmedBeehiivToKit("auto@b.com", "kkey"), { outcome: "already_active" });
      assert.equal(active.posts.length, 0);
    } finally {
      restore();
    }
  });
});

describe("buildBeehiivSyncKitFields / resolveBeehiivAttribution (#6425 Parte B, #8060)", () => {
  it("sem atribuição → só o marcador origem_cadastro", () => {
    assert.deepEqual(buildBeehiivSyncKitFields(), { [KIT_ORIGEM_CADASTRO_FIELD_NAME]: KIT_BEEHIIV_SYNC_SIGNUP_MARKER });
  });

  it("utm_source de topo vence acquisition_source; acquisition_channel é fallback de utm_channel", () => {
    const rec = resolveBeehiivAttribution("a@b.com", {
      utm_source: "google",
      acquisition_source: "website: x",
      acquisition_channel: "website",
    });
    assert.equal(rec.utm_source, "google");
    assert.equal(rec.utm_channel, "website");
    assert.equal(rec.email, "a@b.com");
  });
});
