/**
 * test/reativar-kit-origem-preservada-8235.test.ts (#8235)
 *
 * Regressão: o clique no Confirmar (com token #8194 ou pelo DOI) fazia o
 * worker `reativar` sobrescrever a origem de quem já existia no Kit
 * (`utm_source=google-ads` → `brevo-diaria`), e a ingestão diária copiava a
 * sobrescrita pro store. Cobre as duas camadas: o worker só grava campo de
 * origem vazio (lido pelo GET singular, fail-closed) e o store preserva a
 * origem anterior com `reativado = 1`, estável entre rodadas. Mock de fetch
 * e SQLite `:memory:`, sem rede.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  activateSubscriptionKit,
  filterKitOrigemFields,
  type Env,
} from "../workers/reativar/src/index.ts";
import { BREVO_DIARIA_REATIVAR_CLIQUE_UTM } from "../scripts/lib/shared/utm-registry.ts";
import { ingestKitRoster, resolveKitOrigemOnReativacao } from "../scripts/lib/kit-subscribers-ingest.ts";
import {
  openDiariaSubscribersDb,
  findSubscriberIdByAlias,
  getSubscriptionsForSubscriber,
} from "../scripts/lib/diaria-subscribers-db.ts";
import type { KitSubscriberSummary } from "../scripts/lib/kit-subscribers.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { method: string; url: string; body?: Record<string, unknown> };

const ORIGEM_PAGA = {
  utm_source: "google-ads",
  utm_medium: "cpc",
  utm_campaign: "teste-2608",
  referring_site: "diar.ia.br",
  origem_cadastro: "kit-nativo",
};

/**
 * Kit fake com estado. O upsert (`POST /subscribers`) só aplica `state` a
 * cadastro novo (medido ao vivo, #8194) e sobrescreve os `fields` enviados —
 * é justamente a sobrescrita que o #8235 evita.
 */
function fakeKit(opts: {
  existing: { state: string; fields: Record<string, string | null> } | null;
  singularGet?: "ok" | "500" | "throw" | "sem-fields";
}) {
  const calls: Call[] = [];
  let sub = opts.existing ? { state: opts.existing.state, fields: { ...opts.existing.fields } } : null;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ method, url: u, body });
    if (method === "GET" && u.includes("/subscribers?email_address=")) {
      // Lista com `fields` DEFASADO de propósito — o worker não pode confiar nele.
      return jsonRes(200, { subscribers: sub ? [{ id: 42, state: sub.state, fields: {} }] : [] });
    }
    if (method === "GET" && u.endsWith("/subscribers/42")) {
      const modo = opts.singularGet ?? "ok";
      const promoteRead = calls.some((c) => c.method === "POST");
      if (!promoteRead && modo === "500") return jsonRes(500, { error: "boom" });
      if (!promoteRead && modo === "throw") throw new Error("network down");
      if (!promoteRead && modo === "sem-fields") return jsonRes(200, { subscriber: { id: 42, state: sub?.state } });
      return jsonRes(200, { subscriber: { id: 42, state: sub?.state ?? null, fields: sub?.fields ?? {} } });
    }
    if (method === "POST" && u.endsWith("/subscribers")) {
      const novo = sub === null;
      if (novo) sub = { state: body!.state as string, fields: {} };
      if (body!.fields) Object.assign(sub!.fields, body!.fields as Record<string, string>);
      return jsonRes(novo ? 201 : 200, { subscriber: { id: 42, state: sub!.state } });
    }
    if (method === "POST" && /\/forms\/9839463\/subscribers\/42$/.test(u)) {
      if (sub?.state === "inactive") sub.state = "active";
      return jsonRes(201, { subscriber: { id: 42, state: "inactive" } });
    }
    return jsonRes(200, {});
  }) as typeof fetch;
  return { fetchImpl, calls, get: () => sub };
}

const env = (over: Partial<Env> = {}): Env => ({
  SUBSCRIBE_BACKEND: "kit",
  KIT_API_KEY: "k",
  KIT_API_URL: "https://kit.test/v4",
  KIT_DOI_FORM_ID: "9897918",
  KIT_ACTIVATE_FORM_ID: "9839463",
  KIT_UTM_SOURCE_FIELD: "utm_source",
  KIT_UTM_MEDIUM_FIELD: "utm_medium",
  KIT_UTM_CAMPAIGN_FIELD: "utm_campaign",
  KIT_REFERRING_SITE_FIELD: "referring_site",
  KIT_ORIGEM_CADASTRO_FIELD: "origem_cadastro",
  ...over,
});

async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; warns: Record<string, unknown>[] }> {
  const e = mock.method(console, "error", () => {});
  const w = mock.method(console, "warn", () => {});
  try {
    const result = await fn();
    const warns = w.mock.calls.map((c) => JSON.parse(String(c.arguments[0])) as Record<string, unknown>);
    return { result, warns };
  } finally {
    e.mock.restore();
    w.mock.restore();
  }
}

const upsertPost = (calls: Call[]) => calls.find((c) => c.method === "POST" && c.url.endsWith("/subscribers"));

describe("activateSubscriptionKit preserva a origem de quem já existe (#8235)", () => {
  it("inactive com utm_source=google-ads + token válido → POST sem campos de origem, estado final active", async () => {
    const kit = fakeKit({ existing: { state: "inactive", fields: ORIGEM_PAGA } });
    const { result, warns } = await capture(() => activateSubscriptionKit(env(), "a@x.com", kit.fetchImpl, true));
    assert.equal(result.beehiivStatus, "active");
    assert.equal(kit.get()!.state, "active");
    const post = upsertPost(kit.calls)!;
    assert.equal("fields" in post.body!, false, "nenhum campo de origem pode ir no upsert");
    assert.deepEqual(kit.get()!.fields, ORIGEM_PAGA);
    assert.ok(
      kit.calls.some((c) => c.method === "GET" && c.url.endsWith("/subscribers/42")),
      "origem precisa ser lida pelo GET singular",
    );
    const log = warns.find((l) => l.event === "reativar_kit_origem_preservada");
    assert.ok(log, "esperava log reativar_kit_origem_preservada");
    assert.equal(log!.motivo, "campo_preenchido");
    assert.equal(log!.utm_source_atual, "google-ads");
    assert.deepEqual(
      [...(log!.campos as string[])].sort(),
      ["origem_cadastro", "referring_site", "utm_campaign", "utm_medium", "utm_source"],
    );
  });

  it("mesmo cenário pelo caminho SEM token (DOI) → origem intacta", async () => {
    const kit = fakeKit({ existing: { state: "inactive", fields: ORIGEM_PAGA } });
    const { result } = await capture(() => activateSubscriptionKit(env(), "a@x.com", kit.fetchImpl, false));
    assert.equal(result.ok, true);
    const post = upsertPost(kit.calls)!;
    assert.equal("fields" in post.body!, false);
    assert.deepEqual(kit.get()!.fields, ORIGEM_PAGA);
    assert.equal(kit.get()!.fields.utm_source, "google-ads");
  });

  it("origem parcial → só os campos vazios recebem a UTM de reativação", async () => {
    const kit = fakeKit({
      existing: { state: "inactive", fields: { utm_source: "clarice", utm_medium: "", utm_campaign: null, referring_site: null, origem_cadastro: null } },
    });
    await capture(() => activateSubscriptionKit(env(), "a@x.com", kit.fetchImpl, true));
    const post = upsertPost(kit.calls)!;
    assert.deepEqual(post.body!.fields, {
      utm_medium: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.medium,
      utm_campaign: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.campaign,
      referring_site: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.referringSite,
      origem_cadastro: "kit-nativo",
    });
    assert.equal(kit.get()!.fields.utm_source, "clarice");
  });

  it("assinante inexistente → POST continua com a UTM de reativação (sem regressão do #6318)", async () => {
    const kit = fakeKit({ existing: null });
    const { result } = await capture(() => activateSubscriptionKit(env(), "a@x.com", kit.fetchImpl, true));
    assert.equal(result.beehiivStatus, "active");
    const post = upsertPost(kit.calls)!;
    assert.deepEqual(post.body!.fields, {
      utm_source: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.source,
      utm_medium: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.medium,
      utm_campaign: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.campaign,
      referring_site: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.referringSite,
      origem_cadastro: "kit-nativo",
    });
  });

  for (const modo of ["500", "throw", "sem-fields"] as const) {
    it(`GET singular falha (${modo}) → não sobrescreve origem, mas ativa mesmo assim`, async () => {
      const kit = fakeKit({ existing: { state: "inactive", fields: ORIGEM_PAGA }, singularGet: modo });
      const { result, warns } = await capture(() => activateSubscriptionKit(env(), "a@x.com", kit.fetchImpl, true));
      assert.equal(result.ok, true);
      assert.equal(result.beehiivStatus, "active");
      const post = upsertPost(kit.calls)!;
      assert.equal("fields" in post.body!, false);
      assert.deepEqual(kit.get()!.fields, ORIGEM_PAGA);
      const log = warns.find((l) => l.event === "reativar_kit_origem_preservada");
      assert.equal(log?.motivo, "leitura_falhou");
    });
  }
});

describe("filterKitOrigemFields (#8235)", () => {
  it("vazio/null/espaços contam como ausente; leitura null → nada", () => {
    const desired = { a: "1", b: "2", c: "3", d: "4" };
    assert.deepEqual(filterKitOrigemFields(desired, { a: "x", b: "", c: "  ", d: null }), { b: "2", c: "3", d: "4" });
    assert.deepEqual(filterKitOrigemFields(desired, null), {});
  });
});

function makeSub(over: Partial<KitSubscriberSummary> = {}): KitSubscriberSummary {
  return {
    id: 1,
    email_address: "leitor@example.com",
    state: "inactive",
    created_at: "2026-09-10T00:00:00.000Z",
    fields: {},
    ...over,
  } as KitSubscriberSummary;
}

const REATIVAR_FIELDS = {
  utm_source: "brevo-diaria",
  utm_medium: "reativacao-pending",
  utm_campaign: "pending-reativar-clique",
  referring_site: "brevo-diaria-reativar",
  origem_cadastro: "kit-nativo",
};

describe("ingestKitRoster preserva a origem sobrescrita pelo reativar (#8235)", () => {
  it("meta-ads → brevo-diaria: continua meta-ads com reativado=1; 2ª ingestão igual mantém reativado=1", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestKitRoster(
      db,
      [makeSub({ fields: { utm_source: "meta-ads", utm_medium: "paid_social", utm_campaign: "teste-2608", referring_site: "diar.ia.br", origem_cadastro: "kit-nativo" } })],
      "2026-09-16T04:25:00.000Z",
    );
    const id = findSubscriberIdByAlias(db, "kit", "1", "leitor@example.com")!;
    assert.equal(getSubscriptionsForSubscriber(db, id)[0].reativado, null);

    for (const dia of ["2026-09-17T04:25:00.000Z", "2026-09-18T04:25:00.000Z"]) {
      ingestKitRoster(db, [makeSub({ state: "active", fields: REATIVAR_FIELDS })], dia);
      const [sub] = getSubscriptionsForSubscriber(db, id);
      assert.equal(sub.utm_source, "meta-ads", `utm_source em ${dia}`);
      assert.equal(sub.source, "meta-ads");
      assert.equal(sub.utm_medium, "paid_social");
      assert.equal(sub.utm_campaign, "teste-2608");
      assert.equal(sub.referring_site, "diar.ia.br");
      assert.equal(sub.reativado, 1, `reativado em ${dia}`);
      assert.equal(sub.status, "active", "status segue o Kit");
    }
    db.close();
  });

  it("reativado=1 não é zerado quando o Kit volta a ter a origem original (restauração)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const pago = { utm_source: "google-ads", utm_medium: "cpc" };
    ingestKitRoster(db, [makeSub({ fields: pago })], "2026-09-16T04:25:00.000Z");
    ingestKitRoster(db, [makeSub({ fields: REATIVAR_FIELDS })], "2026-09-17T04:25:00.000Z");
    ingestKitRoster(db, [makeSub({ fields: pago })], "2026-09-18T04:25:00.000Z");
    const id = findSubscriberIdByAlias(db, "kit", "1", "leitor@example.com")!;
    const [sub] = getSubscriptionsForSubscriber(db, id);
    assert.equal(sub.utm_source, "google-ads");
    assert.equal(sub.reativado, 1);
    db.close();
  });

  it("sem origem anterior, brevo-diaria é gravado normalmente e reativado fica null", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestKitRoster(db, [makeSub({ fields: REATIVAR_FIELDS })], "2026-09-17T04:25:00.000Z");
    const id = findSubscriberIdByAlias(db, "kit", "1", "leitor@example.com")!;
    const [sub] = getSubscriptionsForSubscriber(db, id);
    assert.equal(sub.utm_source, "brevo-diaria");
    assert.equal(sub.reativado, null);
    db.close();
  });

  it("troca entre origens que não são de reativação segue sobrescrevendo (sem guard)", () => {
    const r = resolveKitOrigemOnReativacao(
      { source: "clarice", utm_source: "clarice", utm_medium: null, utm_campaign: null, utm_channel: null, utm_term: null, utm_content: null, referring_site: null, origem_cadastro: null, reativado: null },
      { source: "google-ads", utm_source: "google-ads", utm_medium: "cpc", utm_campaign: null, utm_channel: null, utm_term: null, utm_content: null, referring_site: null, origem_cadastro: null },
    );
    assert.equal(r.fields.utm_source, "google-ads");
    assert.equal(r.reativado, null);
  });

  it("linha pré-#7207 (só `source`) também é protegida", () => {
    const r = resolveKitOrigemOnReativacao(
      { source: "meta-ads", utm_source: null, utm_medium: null, utm_campaign: null, utm_channel: null, utm_term: null, utm_content: null, referring_site: null, origem_cadastro: null, reativado: null },
      { source: "brevo-diaria", utm_source: "brevo-diaria", utm_medium: "reativacao-pending", utm_campaign: null, utm_channel: null, utm_term: null, utm_content: null, referring_site: null, origem_cadastro: null },
    );
    assert.equal(r.fields.utm_source, "meta-ads");
    assert.equal(r.fields.source, "meta-ads");
    assert.equal(r.reativado, true);
  });
});
