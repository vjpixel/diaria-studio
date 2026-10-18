/**
 * test/meta-capi-observabilidade-10393.test.ts (#10393, itens 2-4)
 *
 * Achados da fleet do PR #10391 (sinais do CAPI, #8543):
 *   - item 2: var `KIT_ORIGEM_*_FIELD` ausente com sinal presente avisa UMA
 *     vez; o lote distingue "veio e foi rejeitado" de "nunca veio";
 *   - item 3: 422 do Kit no POST de criação com campo de sinal → 1 retry sem
 *     eles (cadastro nunca falha por campo opcional); log do erro sem IP/UA;
 *   - item 4: POST de criação do Kit no `cursos` com timeout.
 *
 * Nenhum teste toca rede real: `fetchImpl` é sempre mock.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyMatchSignalFields,
  matchSignalRejections,
  postKitCreateWithSignalFallback,
  redactLogValues,
  resetMatchSignalFieldWarningsForTest,
} from "../scripts/lib/shared/meta-capi.ts";
import { runMetaConfirmationBatch } from "../scripts/lib/meta-capi-confirmation-batch.ts";
import {
  KIT_CLIENT_IP_FIELD_NAME,
  KIT_FBP_FIELD_NAME,
  KIT_USER_AGENT_FIELD_NAME,
  type ConfirmationRosterEntry,
} from "../scripts/lib/google-ads-confirmation-batch.ts";
import { handleJogarSubscribe } from "../workers/poll/src/subscribe.ts";
import type { Env as PollEnv } from "../workers/poll/src/index.ts";
import { handleGateSubscribe } from "../workers/cursos/src/subscribe.ts";
import type { Env as CursosEnv } from "../workers/cursos/src/index.ts";

const FBP = "fb.1.1700000000000.1234567890";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
const IP = "203.0.113.7";

/** Captura console.warn/console.error durante o teste. */
function captureConsole() {
  const lines: string[] = [];
  const origWarn = console.warn;
  const origErr = console.error;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  return {
    lines,
    restore() {
      console.warn = origWarn;
      console.error = origErr;
    },
  };
}

describe("#10393 item 2 — applyMatchSignalFields avisa var ausente uma vez", () => {
  let cap: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    resetMatchSignalFieldWarningsForTest();
    cap = captureConsole();
  });
  afterEach(() => cap.restore());

  it("sinal presente + var ausente → 1 aviso por var, mesmo com N cadastros; sem o valor do sinal", () => {
    for (let i = 0; i < 3; i++) {
      applyMatchSignalFields({}, { KIT_ORIGEM_FBP_FIELD: "origem_fbp" }, { clientIpAddress: IP, clientUserAgent: UA, fbp: FBP }, "poll");
    }
    const warns = cap.lines.filter((l) => l.includes("match_signal_field_missing"));
    assert.equal(warns.length, 2, warns.join("\n"));
    assert.ok(warns.some((w) => w.includes("KIT_ORIGEM_CLIENTIP_FIELD")));
    assert.ok(warns.some((w) => w.includes("KIT_ORIGEM_USERAGENT_FIELD")));
    assert.ok(warns.every((w) => w.includes('"worker":"poll"')));
    assert.ok(!cap.lines.join("\n").includes(IP));
    assert.ok(!cap.lines.join("\n").includes(UA));
  });

  it("var ausente SEM sinal (pixel não rodou) → nenhum aviso", () => {
    applyMatchSignalFields({}, {}, {}, "cursos");
    applyMatchSignalFields({}, {}, undefined, "cursos");
    assert.equal(cap.lines.length, 0);
  });

  it("devolve os nomes de campo gravados (insumo do retry do item 3)", () => {
    const fields: Record<string, string> = {};
    const written = applyMatchSignalFields(
      fields,
      { KIT_ORIGEM_CLIENTIP_FIELD: "origem_client_ip", KIT_ORIGEM_FBP_FIELD: "origem_fbp" },
      { clientIpAddress: IP, fbp: FBP },
      "poll",
    );
    assert.deepEqual(written.sort(), ["origem_client_ip", "origem_fbp"]);
    assert.deepEqual(fields, { origem_client_ip: IP, origem_fbp: FBP });
  });
});

describe("#10393 item 2 — rejeitado × nunca veio", () => {
  it("matchSignalRejections: só marca o que veio com valor e não passou", () => {
    assert.deepEqual(matchSignalRejections({ clientIpAddress: "fe80::1%eth0", clientUserAgent: "\u0000\u0001", fbp: "lixo" }), {
      clientIpAddress: true,
      clientUserAgent: true,
      fbp: true,
    });
    assert.deepEqual(matchSignalRejections({ clientIpAddress: IP, clientUserAgent: UA, fbp: FBP }), {
      clientIpAddress: false,
      clientUserAgent: false,
      fbp: false,
    });
    assert.deepEqual(matchSignalRejections({ clientIpAddress: "", clientUserAgent: null, fbp: "  " }), {
      clientIpAddress: false,
      clientUserAgent: false,
      fbp: false,
    });
  });

  it("resumo do lote expõe rejected* separado de with* (cenário: 1 válido, 1 editado à mão, 1 sem campos)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meta-obs-10393-"));
    try {
      const now = new Date();
      const createdAt = new Date(now.getTime() - 2 * 86400000).toISOString();
      const roster: ConfirmationRosterEntry[] = [
        {
          id: 1,
          email_address: "a@example.com",
          state: "active",
          created_at: createdAt,
          fields: { [KIT_CLIENT_IP_FIELD_NAME]: IP, [KIT_USER_AGENT_FIELD_NAME]: UA, [KIT_FBP_FIELD_NAME]: FBP },
        },
        {
          id: 2,
          email_address: "b@example.com",
          state: "active",
          created_at: createdAt,
          fields: { [KIT_CLIENT_IP_FIELD_NAME]: "1.2.3.4, 5.6.7.8", [KIT_FBP_FIELD_NAME]: "editado" },
        },
        { id: 3, email_address: "c@example.com", state: "active", created_at: createdAt, fields: {} },
      ];
      const logs: string[] = [];
      const s = await runMetaConfirmationBatch({
        roster,
        baseSnapshot: [1, 2, 3].map((id) => ({ id, state: "inactive", created_at: createdAt })),
        baseDate: createdAt.slice(0, 10),
        indexPath: join(dir, "idx.json"),
        dryRun: true,
        now,
        log: (m) => logs.push(m),
      });
      assert.equal(s.toSend, 3);
      assert.equal(s.withClientIp, 1);
      assert.equal(s.rejectedClientIp, 1);
      assert.equal(s.withFbp, 1);
      assert.equal(s.rejectedFbp, 1);
      assert.equal(s.withUserAgent, 1);
      assert.equal(s.rejectedUserAgent, 0);
      assert.ok(logs.some((l) => l.includes("descartados")));
      // Nunca o valor rejeitado no log.
      assert.ok(!logs.join("\n").includes("5.6.7.8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#10393 item 3 — redactLogValues", () => {
  it("troca IP/UA/e-mail, inclusive na forma escapada de JSON", () => {
    const body = JSON.stringify({ errors: [`bad ${IP}`, `ua ${UA}`, "x a@b.com", "url https://x.test/a/b"] });
    const out = redactLogValues(body, [IP, UA, "a@b.com", "https://x.test/a/b", undefined, ""]);
    assert.ok(!out.includes(IP));
    assert.ok(!out.includes("iPhone"));
    assert.ok(!out.includes("a@b.com"));
    assert.ok(!out.includes("x.test"));
    assert.ok(out.includes("[redacted]"));
  });
});

describe("#10393 item 3 — postKitCreateWithSignalFallback", () => {
  it("422 sem campo de sinal no corpo → não refaz (a causa é outra)", async () => {
    let n = 0;
    const res = await postKitCreateWithSignalFallback({
      post: async () => (n++, new Response("{}", { status: 422 })),
      body: { email_address: "a@b.com", fields: { origem_cadastro: "x" } },
      signalFieldNames: [],
      redactValues: [],
      log: () => {},
    });
    assert.equal(res.status, 422);
    assert.equal(n, 1);
  });

  it("não-422 (ex.: 401) com campo de sinal → não refaz", async () => {
    let n = 0;
    await postKitCreateWithSignalFallback({
      post: async () => (n++, new Response("{}", { status: 401 })),
      body: { email_address: "a@b.com", fields: { origem_client_ip: IP } },
      signalFieldNames: ["origem_client_ip"],
      redactValues: [IP],
      log: () => {},
    });
    assert.equal(n, 1);
  });

  it("422 com só campos de sinal → retry sem `fields`", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    const res = await postKitCreateWithSignalFallback({
      post: async (b) => {
        bodies.push(b);
        return bodies.length === 1 ? new Response(`{"errors":["origem_client_ip ${IP} inválido"]}`, { status: 422 }) : new Response("{}", { status: 201 });
      },
      body: { email_address: "a@b.com", state: "active", fields: { origem_client_ip: IP } },
      signalFieldNames: ["origem_client_ip"],
      redactValues: [IP, "a@b.com"],
      log: (m) => logs.push(m),
    });
    assert.equal(res.status, 201);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].fields, undefined);
    assert.equal(bodies[1].state, "active");
    assert.ok(logs[0].includes("kit_create_422_retry_without_match_signals"));
    assert.ok(!logs.join("\n").includes(IP));
  });
});

// ---- workers ----

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

type Call = { url: string; body: any; hasSignal: boolean };
/** Kit mock: o POST de criação responde `createStatuses[i]` na i-ésima chamada
 * (o corpo do 422 ECOA o payload, como um erro de validação faria). */
function kitFetch(createStatuses: number[]): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let createN = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), body, hasSignal: init?.signal instanceof AbortSignal });
    if (String(url).endsWith("/subscribers")) {
      const status = createStatuses[Math.min(createN++, createStatuses.length - 1)];
      if (status === 422) return new Response(JSON.stringify({ errors: ["campo inválido"], echo: body }), { status: 422 });
      return new Response(JSON.stringify({ subscriber: { id: 1, state: "active" } }), { status });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const SIGNAL_ENV = {
  KIT_ORIGEM_CLIENTIP_FIELD: "origem_client_ip",
  KIT_ORIGEM_USERAGENT_FIELD: "origem_user_agent",
  KIT_ORIGEM_FBP_FIELD: "origem_fbp",
};

function pollEnv(): PollEnv {
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
  } as PollEnv;
}

function pollReq(): Request {
  return new Request("https://poll.test/jogar/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://diar.ia.br", "CF-Connecting-IP": IP, "user-agent": UA },
    body: JSON.stringify({ email: "leitor@example.com", optin: true, source: "jogar", fbp: FBP }),
  });
}

function cursosEnv(): CursosEnv {
  return {
    ASSETS: { fetch: async () => new Response("") },
    CURSOS_SUBSCRIBERS: makeMapKV(),
    COOKIE_HMAC_SECRET: "cookie-secret",
    SUBSCRIBE_BACKEND: "kit",
    KIT_API_KEY: "k",
    KIT_API_URL: "https://kit.test/v4",
    ...SIGNAL_ENV,
  } as unknown as CursosEnv;
}

function cursosReq(): Request {
  return new Request("https://cursos.test/gate/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": IP, "user-agent": UA },
    body: JSON.stringify({ email: "leitor@example.com", optin: true, click_id: "fbclid:ZZ" }),
  });
}

const creates = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/subscribers"));

describe("#10393 item 3 — worker poll: 422 por campo de sinal não derruba o cadastro", () => {
  let cap: ReturnType<typeof captureConsole>;
  beforeEach(() => (cap = captureConsole()));
  afterEach(() => cap.restore());

  it("422 e depois 201 → cadastro 200; 2º POST sem os 3 campos de sinal, com os demais", async () => {
    const { fn, calls } = kitFetch([422, 201]);
    const res = await handleJogarSubscribe(pollReq(), pollEnv(), { fetchImpl: fn });
    assert.equal(res.status, 200);
    const c = creates(calls);
    assert.equal(c.length, 2);
    assert.equal(c[0].body.fields.origem_client_ip, IP);
    const f2 = c[1].body.fields ?? {};
    assert.equal(f2.origem_client_ip, undefined);
    assert.equal(f2.origem_user_agent, undefined);
    assert.equal(f2.origem_fbp, undefined);
    assert.equal(c[1].body.email_address, "leitor@example.com");
    assert.ok(!cap.lines.join("\n").includes(IP), cap.lines.join("\n"));
    assert.ok(!cap.lines.join("\n").includes("iPhone"));
  });

  it("422 nas duas → falha, e o log `Kit respondeu` não carrega IP/UA/e-mail", async () => {
    const { fn, calls } = kitFetch([422, 422]);
    const res = await handleJogarSubscribe(pollReq(), pollEnv(), { fetchImpl: fn });
    assert.notEqual(res.status, 200);
    assert.equal(creates(calls).length, 2);
    const all = cap.lines.join("\n");
    assert.ok(all.includes("Kit respondeu 422"), all);
    assert.ok(!all.includes(IP));
    assert.ok(!all.includes("iPhone"));
    assert.ok(!all.includes("leitor@example.com"));
  });
});

describe("#10393 itens 3-4 — worker cursos", () => {
  let cap: ReturnType<typeof captureConsole>;
  beforeEach(() => (cap = captureConsole()));
  afterEach(() => cap.restore());

  it("POST de criação do Kit leva AbortSignal (timeout), como o poll", async () => {
    const { fn, calls } = kitFetch([201]);
    const res = await handleGateSubscribe(cursosReq(), cursosEnv(), { fetchImpl: fn });
    assert.equal(res.status, 200);
    const c = creates(calls);
    assert.equal(c.length, 1);
    assert.ok(c[0].hasSignal, "POST /subscribers sem signal");
  });

  it("422 e depois 201 → cadastro 200 sem os campos de sinal; log sem IP/UA", async () => {
    const { fn, calls } = kitFetch([422, 201]);
    const res = await handleGateSubscribe(cursosReq(), cursosEnv(), { fetchImpl: fn });
    assert.equal(res.status, 200);
    const c = creates(calls);
    assert.equal(c.length, 2);
    assert.equal(c[0].body.fields.origem_client_ip, IP);
    assert.equal((c[1].body.fields ?? {}).origem_client_ip, undefined);
    assert.equal((c[1].body.fields ?? {}).origem_user_agent, undefined);
    assert.ok(c[1].hasSignal);
    const all = cap.lines.join("\n");
    assert.ok(!all.includes(IP));
    assert.ok(!all.includes("iPhone"));
  });

  it("422 nas duas → `Kit respondeu` redigido", async () => {
    const { fn } = kitFetch([422, 422]);
    const res = await handleGateSubscribe(cursosReq(), cursosEnv(), { fetchImpl: fn });
    assert.notEqual(res.status, 200);
    const all = cap.lines.join("\n");
    assert.ok(all.includes("Kit respondeu 422"), all);
    assert.ok(!all.includes(IP));
    assert.ok(!all.includes("leitor@example.com"));
  });
});
