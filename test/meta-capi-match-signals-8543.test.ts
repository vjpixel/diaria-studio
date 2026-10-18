/**
 * test/meta-capi-match-signals-8543.test.ts (#8543, EMQ 28/09/2026)
 *
 * `SubscriptionConfirmed` estava em EMQ 5.0/10 (só e-mail + fbc) e
 * `Reactivation` em 3.2/10. Este arquivo trava o enriquecimento:
 *
 *   - cadastro (poll e cursos) grava IP, user agent e `_fbp` no Kit, sob
 *     minimização (`selectPersistableMatchSignals`);
 *   - o lote `SubscriptionConfirmed` relê esses campos e os manda (com
 *     `external_id`), revalidados;
 *   - o `reativar` manda IP/UA do clique no `Reactivation`.
 *
 * Nenhum teste toca rede real: `fetchImpl` é sempre mock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PERSISTED_USER_AGENT_MAX,
  applyMatchSignalFields,
  isPlausibleClientIp,
  sanitizePersistedMatchSignals,
  selectPersistableMatchSignals,
} from "../scripts/lib/shared/meta-capi.ts";
import {
  buildConfirmationClientSignals,
  runMetaConfirmationBatch,
} from "../scripts/lib/meta-capi-confirmation-batch.ts";
import {
  KIT_CLIENT_IP_FIELD_NAME,
  KIT_FBP_FIELD_NAME,
  KIT_USER_AGENT_FIELD_NAME,
  persistedMatchFieldsFromKit,
  type ConfirmationRosterEntry,
} from "../scripts/lib/google-ads-confirmation-batch.ts";
import { handleJogarSubscribe } from "../workers/poll/src/subscribe.ts";
import type { Env as PollEnv } from "../workers/poll/src/index.ts";
import { handleGateSubscribe } from "../workers/cursos/src/subscribe.ts";
import type { Env as CursosEnv } from "../workers/cursos/src/index.ts";
import { handleConfirm, type Env as ReativarEnv } from "../workers/reativar/src/index.ts";

const FBP = "fb.1.1700000000000.1234567890";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
const VID = "d6e05d2f-6e44-49fb-ae05-85dccd5f7697";

describe("#8543 — minimização: selectPersistableMatchSignals", () => {
  const full = { clientIpAddress: "203.0.113.7", clientUserAgent: UA, fbp: FBP };

  it("com sinal da Meta (fbp) → IP, UA e fbp", () => {
    assert.deepEqual(selectPersistableMatchSignals(full, ""), full);
  });

  it("com click id fbclid: e sem cookie → IP e UA (fbclid conta como sinal da Meta)", () => {
    assert.deepEqual(selectPersistableMatchSignals({ clientIpAddress: "203.0.113.7", clientUserAgent: UA }, "fbclid:ABC"), {
      clientIpAddress: "203.0.113.7",
      clientUserAgent: UA,
    });
  });

  it("click id de OUTRO canal (gclid:/msclkid:) → nada, mesmo com fbp", () => {
    assert.deepEqual(selectPersistableMatchSignals(full, "gclid:xyz"), {});
    assert.deepEqual(selectPersistableMatchSignals(full, "msclkid:xyz"), {});
  });

  it("sem nenhum sinal da Meta (pixel não rodou) → nada", () => {
    assert.deepEqual(selectPersistableMatchSignals({ clientIpAddress: "203.0.113.7", clientUserAgent: UA }, ""), {});
  });
});

describe("#8543 — sanitização (dos dois lados)", () => {
  it("IP: v4/v6 passam, lixo/lista/porta não", () => {
    assert.ok(isPlausibleClientIp("203.0.113.7"));
    assert.ok(isPlausibleClientIp("2001:db8::1"));
    assert.ok(isPlausibleClientIp("::ffff:203.0.113.7"));
    assert.ok(!isPlausibleClientIp("203.0.113.7, 10.0.0.1"));
    assert.ok(!isPlausibleClientIp("203.0.113.7:443"));
    assert.ok(!isPlausibleClientIp("999.1.1.1"));
    assert.ok(!isPlausibleClientIp("<script>"));
    assert.ok(!isPlausibleClientIp(""));
  });

  it("UA: corta no teto e remove caractere de controle; fbp fora da forma é descartado", () => {
    const s = sanitizePersistedMatchSignals({ clientUserAgent: `a\u0000b\n${"x".repeat(500)}`, fbp: "lixo" });
    assert.equal(s.clientUserAgent?.length, PERSISTED_USER_AGENT_MAX);
    assert.ok(!/[\u0000-\u001f]/.test(s.clientUserAgent ?? ""));
    assert.equal(s.fbp, undefined);
  });

  it("#10428: teto do UA cabe num custom field de 255 (UA do FBAN/FBAV passa de 250)", () => {
    assert.ok(PERSISTED_USER_AGENT_MAX <= 255);
    const s = sanitizePersistedMatchSignals({ clientUserAgent: "y".repeat(300) });
    assert.ok((s.clientUserAgent?.length ?? 0) <= 255);
  });

  it("applyMatchSignalFields: só grava com env configurada E valor presente", () => {
    const fields: Record<string, string> = {};
    applyMatchSignalFields(fields, { KIT_ORIGEM_CLIENTIP_FIELD: "origem_client_ip" }, { clientIpAddress: "1.2.3.4", fbp: FBP });
    assert.deepEqual(fields, { origem_client_ip: "1.2.3.4" });
    applyMatchSignalFields(fields, { KIT_ORIGEM_FBP_FIELD: "origem_fbp" }, undefined);
    assert.deepEqual(fields, { origem_client_ip: "1.2.3.4" });
  });
});

describe("#8543 — lote SubscriptionConfirmed relê e manda os sinais", () => {
  it("persistedMatchFieldsFromKit lê os 3 campos; null/vazio = ausente", () => {
    assert.deepEqual(
      persistedMatchFieldsFromKit({ [KIT_CLIENT_IP_FIELD_NAME]: "1.2.3.4", [KIT_USER_AGENT_FIELD_NAME]: UA, [KIT_FBP_FIELD_NAME]: FBP }),
      { clientIp: "1.2.3.4", clientUserAgent: UA, fbp: FBP },
    );
    assert.deepEqual(persistedMatchFieldsFromKit({ [KIT_CLIENT_IP_FIELD_NAME]: null as unknown as string }), {});
    assert.deepEqual(persistedMatchFieldsFromKit(undefined), {});
  });

  it("buildConfirmationClientSignals revalida: campo editado à mão some, o resto fica", () => {
    assert.deepEqual(
      buildConfirmationClientSignals({ externalId: VID, clientIp: "1.2.3.4, 5.6.7.8", clientUserAgent: UA, fbp: "lixo" }, undefined),
      { externalId: VID, clientUserAgent: UA },
    );
    assert.equal(buildConfirmationClientSignals({}, undefined), undefined);
  });

  it("evento enviado carrega client_ip_address, client_user_agent, fbp, external_id e fbc; resumo conta a cobertura", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meta-signals-8543-"));
    try {
      const now = new Date();
      const createdAt = new Date(now.getTime() - 2 * 86400000).toISOString();
      const baseDate = createdAt.slice(0, 10);
      const bodies: Array<{ data: Array<{ user_data: Record<string, unknown> }> }> = [];
      const fetchImpl = (async (_u: unknown, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      const roster: ConfirmationRosterEntry[] = [
        {
          id: 1,
          email_address: "a@example.com",
          state: "active",
          created_at: createdAt,
          fields: {
            origem_click_id: "fbclid:ABC",
            origem_external_id: VID,
            [KIT_CLIENT_IP_FIELD_NAME]: "203.0.113.7",
            [KIT_USER_AGENT_FIELD_NAME]: UA,
            [KIT_FBP_FIELD_NAME]: FBP,
          },
        },
        // Cadastro anterior ao #8543: sem os campos — sai só com e-mail (como antes).
        { id: 2, email_address: "b@example.com", state: "active", created_at: createdAt, fields: {} },
      ];
      const s = await runMetaConfirmationBatch({
        roster,
        baseSnapshot: [
          { id: 1, state: "inactive", created_at: createdAt },
          { id: 2, state: "inactive", created_at: createdAt },
        ],
        baseDate,
        indexPath: join(dir, "idx.json"),
        dryRun: false,
        accessToken: "tok",
        fetchImpl,
        now,
        log: () => {},
      });
      assert.equal(s.sent, 2);
      assert.equal(s.withClientIp, 1);
      assert.equal(s.withUserAgent, 1);
      assert.equal(s.withFbp, 1);
      assert.equal(s.withExternalId, 1);
      const byIp = bodies.map((b) => b.data[0].user_data);
      const rich = byIp.find((u) => u.client_ip_address)!;
      assert.equal(rich.client_ip_address, "203.0.113.7");
      assert.equal(rich.client_user_agent, UA);
      assert.equal(rich.fbp, FBP);
      assert.ok(Array.isArray(rich.external_id));
      assert.match(String(rich.fbc), /^fb\.1\.\d+\.ABC$/);
      const plain = byIp.find((u) => !u.client_ip_address)!;
      assert.equal(plain.client_user_agent, undefined);
      assert.equal(plain.fbp, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- workers: o cadastro grava os campos ----

function makeMapKV() {
  const m = new Map<string, string>();
  return {
    async get(key: string) {
      return m.get(key) ?? null;
    },
    async getWithMetadata(key: string) {
      return { value: m.get(key) ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: undefined };
    },
  };
}

type Calls = Array<{ url: string; body: any }>;
function kitFetch(): { fn: typeof fetch; calls: Calls } {
  const calls: Calls = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ subscriber: { id: 1, state: "active" } }), { status: 201 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const SIGNAL_ENV = {
  KIT_ORIGEM_CLIENTIP_FIELD: "origem_client_ip",
  KIT_ORIGEM_USERAGENT_FIELD: "origem_user_agent",
  KIT_ORIGEM_FBP_FIELD: "origem_fbp",
};

function pollEnv(over: Partial<PollEnv> = {}): PollEnv {
  return {
    POLL: makeMapKV() as unknown as PollEnv["POLL"],
    POLL_SECRET: "s",
    ADMIN_SECRET: "a",
    ALLOWED_ORIGINS: "https://diar.ia.br",
    SUBSCRIBE_BACKEND: "kit",
    KIT_API_KEY: "k",
    KIT_API_URL: "https://kit.test/v4",
    KIT_ORIGEM_CLICKID_FIELD: "origem_click_id",
    ...SIGNAL_ENV,
    ...over,
  } as PollEnv;
}

function pollReq(body: unknown, ip = "203.0.113.7"): Request {
  return new Request("https://poll.test/jogar/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://diar.ia.br", "CF-Connecting-IP": ip, "user-agent": UA },
    body: JSON.stringify(body),
  });
}

describe("#8543 — worker poll grava IP/UA/fbp no Kit", () => {
  it("com fbp no corpo e env configurada → os 3 campos no POST de criação", async () => {
    const { fn, calls } = kitFetch();
    const res = await handleJogarSubscribe(pollReq({ email: "a@b.com", optin: true, source: "jogar", fbp: FBP }), pollEnv(), { fetchImpl: fn });
    assert.equal(res.status, 200);
    const create = calls.find((c) => c.url.endsWith("/subscribers"))!;
    assert.equal(create.body.fields.origem_client_ip, "203.0.113.7");
    assert.equal(create.body.fields.origem_user_agent, UA);
    assert.equal(create.body.fields.origem_fbp, FBP);
  });

  it("click id do Google → nenhum dos 3 campos (minimização)", async () => {
    const { fn, calls } = kitFetch();
    await handleJogarSubscribe(pollReq({ email: "a@b.com", optin: true, source: "jogar", fbp: FBP, click_id: "gclid:x" }), pollEnv(), { fetchImpl: fn });
    const f = calls.find((c) => c.url.endsWith("/subscribers"))!.body.fields ?? {};
    assert.equal(f.origem_client_ip, undefined);
    assert.equal(f.origem_user_agent, undefined);
    assert.equal(f.origem_fbp, undefined);
  });

  it("sem as env vars (worker sem os campos configurados) → nada gravado", async () => {
    const { fn, calls } = kitFetch();
    await handleJogarSubscribe(
      pollReq({ email: "a@b.com", optin: true, source: "jogar", fbp: FBP }),
      pollEnv({ KIT_ORIGEM_CLIENTIP_FIELD: undefined, KIT_ORIGEM_USERAGENT_FIELD: undefined, KIT_ORIGEM_FBP_FIELD: undefined }),
      { fetchImpl: fn },
    );
    const f = calls.find((c) => c.url.endsWith("/subscribers"))!.body.fields ?? {};
    assert.equal(f.origem_client_ip, undefined);
    assert.equal(f.origem_fbp, undefined);
  });
});

describe("#8543 — worker cursos grava IP/UA/fbp no Kit", () => {
  it("com fbclid: no click id → IP e UA gravados", async () => {
    const { fn, calls } = kitFetch();
    const env = {
      ASSETS: { fetch: async () => new Response("") },
      CURSOS_SUBSCRIBERS: makeMapKV(),
      COOKIE_HMAC_SECRET: "cookie-secret",
      SUBSCRIBE_BACKEND: "kit",
      KIT_API_KEY: "k",
      KIT_API_URL: "https://kit.test/v4",
      ...SIGNAL_ENV,
    } as unknown as CursosEnv;
    const req = new Request("https://cursos.test/gate/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "2001:db8::1", "user-agent": UA },
      body: JSON.stringify({ email: "a@b.com", optin: true, click_id: "fbclid:ZZ" }),
    });
    const res = await handleGateSubscribe(req, env, { fetchImpl: fn });
    assert.equal(res.status, 200);
    const f = calls.find((c) => c.url.endsWith("/subscribers"))!.body.fields;
    assert.equal(f.origem_client_ip, "2001:db8::1");
    assert.equal(f.origem_user_agent, UA);
    assert.equal(f.origem_fbp, undefined);
  });
});

describe("#8543 — reativar manda IP/UA do clique no Reactivation", () => {
  function reativarFetch() {
    const metaBodies: Array<{ data: Array<{ event_name: string; user_data: Record<string, unknown> }> }> = [];
    const fn = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("graph.facebook.com")) {
        if (init?.body) metaBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
      }
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(null, { status: 404 });
      if (method === "POST") return new Response(JSON.stringify({ data: { id: "s1", status: "active" } }), { status: 201 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    return { fn, metaBodies };
  }
  const env = {
    BEEHIIV_API_KEY: "k",
    BEEHIIV_PUBLICATION_ID: "pub_1",
    BEEHIIV_API_URL: "https://beehiiv.test/v2",
    META_CAPI_ACCESS_TOKEN: "tok",
  } as ReativarEnv;
  const url = new URL("https://reativar.diaria.workers.dev/?email=ana%40example.com");

  it("com headers do request → client_ip_address e client_user_agent no evento", async () => {
    const { fn, metaBodies } = reativarFetch();
    const headers = new Headers({ "CF-Connecting-IP": "198.51.100.4", "user-agent": UA });
    const res = await handleConfirm(url, env, fn, undefined, undefined, headers);
    assert.equal(res.status, 303);
    assert.equal(metaBodies.length, 1);
    assert.equal(metaBodies[0].data[0].event_name, "Reactivation");
    assert.equal(metaBodies[0].data[0].user_data.client_ip_address, "198.51.100.4");
    assert.equal(metaBodies[0].data[0].user_data.client_user_agent, UA);
  });

  it("sem headers (chamada antiga) → evento sai só com o hash do e-mail, como antes", async () => {
    const { fn, metaBodies } = reativarFetch();
    await handleConfirm(url, env, fn);
    assert.equal(metaBodies[0].data[0].user_data.client_ip_address, undefined);
  });
});
