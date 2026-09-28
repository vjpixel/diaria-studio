/**
 * test/meta-external-id-8978.test.ts (#8978)
 *
 * Cobre a issue "Meta EMQ": `external_id` first-party (`_dia_vid`) mandado
 * IDÊNTICO no pixel e na CAPI, `_fbc` gravado em `.diar.ia.br` a partir de
 * `fbclid` na URL de entrada (sem fabricar quando não há `fbclid`), o
 * fallback de `fbc` via `Referer`, a persistência do `external_id` no
 * cadastro (poll/cursos) e o reuso pelo lote `SubscriptionConfirmed`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIA_VISITOR_ID_COOKIE_NAME,
  DIA_VISITOR_ID_COOKIE_DOMAIN,
  isValidVisitorId,
  readVisitorIdFromCookieHeader,
  visitorIdBootstrapJs,
} from "../scripts/lib/shared/visitor-id.ts";
import { metaFbcBootstrapJs } from "../scripts/lib/shared/meta-fbc-bootstrap.ts";
import {
  extractMetaCapiClientSignals,
  buildCompleteRegistrationEvent,
  buildFbcFromReferer,
  buildFbcFromClickId,
} from "../scripts/lib/shared/meta-capi.ts";
import { handleJogarSubscribe } from "../workers/poll/src/subscribe.ts";
import type { Env as PollEnv } from "../workers/poll/src/index.ts";
import { handleGateSubscribe } from "../workers/cursos/src/subscribe.ts";
import type { Env as CursosEnv } from "../workers/cursos/src/index.ts";
import {
  KIT_EXTERNAL_ID_FIELD_NAME,
  selectConfirmationCandidates,
  type ConfirmationRosterEntry,
} from "../scripts/lib/google-ads-confirmation-batch.ts";
import { runMetaConfirmationBatch, type MetaSendFn } from "../scripts/lib/meta-capi-confirmation-batch.ts";
import type { SubscriberStateRecord } from "../scripts/lib/subscriber-state-snapshot.ts";

describe("visitor-id.ts (#8978)", () => {
  it("isValidVisitorId aceita UUID/hex de 16-64 chars, rejeita lixo/vazio", () => {
    assert.equal(isValidVisitorId("550e8400-e29b-41d4-a716-446655440000"), true);
    assert.equal(isValidVisitorId("a".repeat(32)), true);
    assert.equal(isValidVisitorId(""), false);
    assert.equal(isValidVisitorId(undefined), false);
    assert.equal(isValidVisitorId("curto"), false);
    assert.equal(isValidVisitorId("<script>alert(1)</script>"), false);
  });

  it("readVisitorIdFromCookieHeader lê só o cookie válido, ignora ausente/inválido", () => {
    const vid = "550e8400-e29b-41d4-a716-446655440000";
    assert.equal(readVisitorIdFromCookieHeader(`_dia_vid=${vid}; outro=1`), vid);
    assert.equal(readVisitorIdFromCookieHeader(null), undefined);
    assert.equal(readVisitorIdFromCookieHeader("outro=1"), undefined);
    assert.equal(readVisitorIdFromCookieHeader("_dia_vid=<script>"), undefined);
  });

  it("visitorIdBootstrapJs: gera/lê o cookie, grava em .diar.ia.br, expõe window.__DIA_VID__ e empurra external_id pro dataLayer, tudo em try/catch", () => {
    const js = visitorIdBootstrapJs();
    assert.match(js, /^try \{/);
    assert.match(js, /\} catch \(e\) \{\}$/);
    assert.match(js, new RegExp(DIA_VISITOR_ID_COOKIE_NAME));
    assert.match(js, new RegExp(DIA_VISITOR_ID_COOKIE_DOMAIN.replace(".", "\\.")));
    assert.match(js, /crypto\.randomUUID/);
    assert.match(js, /window\.__DIA_VID__ = vid;/);
    assert.match(js, /dataLayer\.push\(\{ external_id: vid \}\);/);
    assert.match(js, /diar\\\.ia\\\.br/); // guard de host antes de gravar domain=
  });
});

describe("meta-fbc-bootstrap.ts (#8978)", () => {
  it("metaFbcBootstrapJs: só grava _fbc quando HÁ fbclid na URL e o cookie ainda não existe, sempre em .diar.ia.br, tudo em try/catch", () => {
    const js = metaFbcBootstrapJs();
    assert.match(js, /^try \{/);
    assert.match(js, /\} catch \(e\) \{\}$/);
    assert.match(js, /URLSearchParams\(window\.location\.search\)\.get\('fbclid'\)/);
    // nunca fabrica: o `if (fbclid && ...)` é o único caminho que escreve `document.cookie =`
    assert.match(js, /if \(fbclid && !\/\(\?:\^\|; \)_fbc=\/\.test\(document\.cookie\)\) \{/);
    assert.match(js, /Domain=\.diar\.ia\.br/);
    assert.match(js, /fb\.1\.'/);
  });
});

describe("meta-capi.ts — external_id + fallback de fbc via Referer (#8978)", () => {
  it("buildFbcFromReferer deriva fb.1.{ms}.{fbclid} só quando o Referer tem fbclid válido", () => {
    assert.equal(
      buildFbcFromReferer("https://eia.diar.ia.br/jogar?fbclid=AbC-123", 1_700_000_000_000),
      "fb.1.1700000000000.AbC-123",
    );
    assert.equal(buildFbcFromReferer("https://eia.diar.ia.br/jogar", 1_700_000_000_000), undefined);
    assert.equal(buildFbcFromReferer(null, 1_700_000_000_000), undefined);
    assert.equal(buildFbcFromReferer("não-é-url", 1_700_000_000_000), undefined);
    assert.equal(buildFbcFromReferer("https://eia.diar.ia.br/jogar?fbclid=a b", 1_700_000_000_000), undefined);
  });

  it("extractMetaCapiClientSignals: cookie _fbc > click_id > Referer, nessa ordem", () => {
    const cookieWins = extractMetaCapiClientSignals(
      new Headers({ Cookie: "_fbc=fb.1.111.cookie-clid", Referer: "https://x.test/?fbclid=referer-clid" }),
      { clickId: "fbclid:form-clid", fbcCreationTimeMs: 999 },
    );
    assert.equal(cookieWins.fbc, "fb.1.111.cookie-clid");

    const clickIdWins = extractMetaCapiClientSignals(new Headers({ Referer: "https://x.test/?fbclid=referer-clid" }), {
      clickId: "fbclid:form-clid",
      fbcCreationTimeMs: 999,
    });
    assert.equal(clickIdWins.fbc, buildFbcFromClickId("fbclid:form-clid", 999));

    const refererWins = extractMetaCapiClientSignals(new Headers({ Referer: "https://x.test/?fbclid=referer-clid" }), {
      fbcCreationTimeMs: 999,
    });
    assert.equal(refererWins.fbc, "fb.1.999.referer-clid");

    const none = extractMetaCapiClientSignals(new Headers());
    assert.equal(none.fbc, undefined);
  });

  it("extractMetaCapiClientSignals: lê _dia_vid válido do cookie como externalId, ignora inválido", () => {
    const vid = "550e8400-e29b-41d4-a716-446655440000";
    const withVid = extractMetaCapiClientSignals(new Headers({ Cookie: `_dia_vid=${vid}` }));
    assert.equal(withVid.externalId, vid);

    const garbage = extractMetaCapiClientSignals(new Headers({ Cookie: "_dia_vid=<bad>" }));
    assert.equal(garbage.externalId, undefined);

    const absent = extractMetaCapiClientSignals(new Headers());
    assert.equal(absent.externalId, undefined);
  });

  it("buildCompleteRegistrationEvent: external_id entra como array RAW (sem hash) quando presente, omitido quando ausente", async () => {
    const vid = "550e8400-e29b-41d4-a716-446655440000";
    const withVid = await buildCompleteRegistrationEvent({
      email: "a@b.com",
      eventSourceUrl: "https://eia.diar.ia.br/jogar/subscribe",
      clientSignals: { externalId: vid },
    });
    assert.deepEqual(withVid.user_data.external_id, [vid]);

    const without = await buildCompleteRegistrationEvent({
      email: "a@b.com",
      eventSourceUrl: "https://eia.diar.ia.br/jogar/subscribe",
    });
    assert.equal(without.user_data.external_id, undefined);
  });
});

// ---- persistência do external_id no cadastro (poll/cursos, #8978) ----

type FetchMock = typeof fetch & { calls: Array<{ url: string; init: RequestInit | undefined }> };
function makeFetchMock(status = 201, body: unknown = { subscriber: { id: 1 } }): FetchMock {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as FetchMock;
  fn.calls = calls;
  return fn;
}

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
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: undefined };
    },
  };
}

const VID = "550e8400-e29b-41d4-a716-446655440000";

function pollKitEnv(overrides: Partial<PollEnv> = {}): PollEnv {
  return {
    POLL: makeMapKV() as unknown as PollEnv["POLL"],
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "https://diar.ia.br",
    SUBSCRIBE_BACKEND: "kit",
    KIT_API_KEY: "test-kit-key",
    KIT_API_URL: "https://kit.test/v4",
    KIT_ORIGEM_EXTERNALID_FIELD: "origem_external_id",
    ...overrides,
  };
}

function subReqWithCookie(body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "https://diar.ia.br" };
  if (cookie) headers.Cookie = cookie;
  return new Request("https://poll.test/jogar/subscribe", { method: "POST", headers, body: JSON.stringify(body) });
}

describe("handleJogarSubscribe (worker poll) — persiste origem_external_id do cookie (#8978)", () => {
  it("cookie _dia_vid válido + env configurado → gravado no Kit", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReqWithCookie({ email: "a@b.com", optin: true, source: "jogar" }, `_dia_vid=${VID}`),
      pollKitEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields.origem_external_id, VID);
  });

  it("sem cookie → campo nunca aparece, mesmo com env configurado", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReqWithCookie({ email: "b@b.com", optin: true, source: "jogar" }),
      pollKitEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields?.origem_external_id, undefined);
  });

  it("cookie presente, mas sem env configurado → campo nunca aparece", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReqWithCookie({ email: "c@b.com", optin: true, source: "jogar" }, `_dia_vid=${VID}`),
      pollKitEnv({ KIT_ORIGEM_EXTERNALID_FIELD: undefined }),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields?.origem_external_id, undefined);
  });
});

function cursosKitEnv(overrides: Partial<CursosEnv> = {}): CursosEnv {
  return {
    ASSETS: { fetch: async () => new Response("") } as unknown as CursosEnv["ASSETS"],
    CURSOS_SUBSCRIBERS: makeMapKV() as unknown as CursosEnv["CURSOS_SUBSCRIBERS"],
    COOKIE_HMAC_SECRET: "cookie-secret",
    SUBSCRIBE_BACKEND: "kit",
    KIT_API_KEY: "test-kit-key",
    KIT_API_URL: "https://kit.test/v4",
    KIT_ORIGEM_EXTERNALID_FIELD: "origem_external_id",
    ...overrides,
  };
}

function gateReqWithCookie(body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  return new Request("https://cursos.test/gate/subscribe", { method: "POST", headers, body: JSON.stringify(body) });
}

describe("handleGateSubscribe (worker cursos) — persiste origem_external_id do cookie (#8978)", () => {
  it("cookie _dia_vid válido + env configurado → gravado no Kit", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleGateSubscribe(
      gateReqWithCookie({ email: "a@b.com", optin: true }, `_dia_vid=${VID}`),
      cursosKitEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields.origem_external_id, VID);
  });

  it("sem cookie → campo nunca aparece", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleGateSubscribe(gateReqWithCookie({ email: "b@b.com", optin: true }), cursosKitEnv(), {
      fetchImpl: fetchMock,
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields?.origem_external_id, undefined);
  });
});

// ---- reuso pelo lote SubscriptionConfirmed (#8978) ----

describe("selectConfirmationCandidates — carrega externalId de KIT_EXTERNAL_ID_FIELD_NAME (#8978)", () => {
  it("popula candidate.externalId quando o campo existe no roster", () => {
    const roster: ConfirmationRosterEntry[] = [
      {
        id: 1,
        email_address: "a@b.com",
        state: "active",
        created_at: "2026-09-27T12:00:00Z",
        fields: { [KIT_EXTERNAL_ID_FIELD_NAME]: VID },
      },
    ];
    const base: SubscriberStateRecord[] = [{ id: 1, state: "inactive", created_at: "2026-09-26T12:00:00Z" }];
    const { candidates } = selectConfirmationCandidates(roster, base, "2026-09-26");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].externalId, VID);
  });

  it("ausente no roster → undefined, nunca string vazia", () => {
    const roster: ConfirmationRosterEntry[] = [
      { id: 2, email_address: "b@b.com", state: "active", created_at: "2026-09-27T12:00:00Z" },
    ];
    const base: SubscriberStateRecord[] = [{ id: 2, state: "inactive", created_at: "2026-09-26T12:00:00Z" }];
    const { candidates } = selectConfirmationCandidates(roster, base, "2026-09-26");
    assert.equal(candidates[0].externalId, undefined);
  });
});

describe("runMetaConfirmationBatch — SubscriptionConfirmed reusa externalId persistido (#8978)", () => {
  it("externalId válido no Kit → vai pro clientSignals do evento enviado", async () => {
    const roster: ConfirmationRosterEntry[] = [
      {
        id: 10,
        email_address: "a@b.com",
        state: "active",
        created_at: "2026-09-27T12:00:00Z",
        fields: { [KIT_EXTERNAL_ID_FIELD_NAME]: VID },
      },
    ];
    const base: SubscriberStateRecord[] = [{ id: 10, state: "inactive", created_at: "2026-09-26T12:00:00Z" }];
    let sentInput: Parameters<MetaSendFn>[0] | undefined;
    const sendFn: MetaSendFn = async (input) => {
      sentInput = input;
      return { ok: true, status: 200 };
    };
    const dir = mkdtempSync(join(tmpdir(), "meta-external-id-8978-"));
    try {
      await runMetaConfirmationBatch({
        roster,
        baseSnapshot: base,
        baseDate: "2026-09-26",
        indexPath: join(dir, "idx.json"),
        dryRun: false,
        accessToken: "tok",
        sendFn,
        now: new Date("2026-09-27T13:00:00Z"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(sentInput?.clientSignals?.externalId, VID);
  });

  it("externalId INVÁLIDO no Kit (campo editado à mão) é ignorado, nunca mandado pra Meta", async () => {
    const roster: ConfirmationRosterEntry[] = [
      {
        id: 11,
        email_address: "b@b.com",
        state: "active",
        created_at: "2026-09-27T12:00:00Z",
        fields: { [KIT_EXTERNAL_ID_FIELD_NAME]: "lixo" },
      },
    ];
    const base: SubscriberStateRecord[] = [{ id: 11, state: "inactive", created_at: "2026-09-26T12:00:00Z" }];
    let sentInput: Parameters<MetaSendFn>[0] | undefined;
    const sendFn: MetaSendFn = async (input) => {
      sentInput = input;
      return { ok: true, status: 200 };
    };
    const dir = mkdtempSync(join(tmpdir(), "meta-external-id-8978-"));
    try {
      await runMetaConfirmationBatch({
        roster,
        baseSnapshot: base,
        baseDate: "2026-09-26",
        indexPath: join(dir, "idx.json"),
        dryRun: false,
        accessToken: "tok",
        sendFn,
        now: new Date("2026-09-27T13:00:00Z"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(sentInput?.clientSignals?.externalId, undefined);
  });
});
