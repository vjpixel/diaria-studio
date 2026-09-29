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
  parseVisitorId,
  readVisitorIdFromCookieHeader,
  resolveVisitorId,
  visitorIdBootstrapJs,
  warnExternalIdFieldMissingOnce,
} from "../scripts/lib/shared/visitor-id.ts";
import { metaFbcBootstrapJs, fbCookieValueFromDocumentCookieJs } from "../scripts/lib/shared/meta-fbc-bootstrap.ts";
import {
  extractMetaCapiClientSignals,
  buildCompleteRegistrationEvent,
  buildFbcFromReferer,
  buildFbcFromClickId,
  FBCLID_RE,
  FB_COOKIE_RE,
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

  it("isValidVisitorId: fronteira exata de tamanho — 15 rejeita, 16 aceita, 64 aceita, 65 rejeita (#8978 fleet review item 5)", () => {
    assert.equal(isValidVisitorId("a".repeat(15)), false);
    assert.equal(isValidVisitorId("a".repeat(16)), true);
    assert.equal(isValidVisitorId("a".repeat(64)), true);
    assert.equal(isValidVisitorId("a".repeat(65)), false);
  });

  it("parseVisitorId: mesmo comportamento de isValidVisitorId, mas devolve o branded VisitorId (ou undefined)", () => {
    const vid = "550e8400-e29b-41d4-a716-446655440000";
    assert.equal(parseVisitorId(vid), vid);
    assert.equal(parseVisitorId("lixo"), undefined);
    assert.equal(parseVisitorId(undefined), undefined);
    assert.equal(parseVisitorId(null), undefined);
  });

  it("resolveVisitorId: cookie do request vence sobre o corpo; corpo é o fallback (cross-origin, #8978 achado 1)", () => {
    const vid = "550e8400-e29b-41d4-a716-446655440000";
    const bodyVid = "660e8400-e29b-41d4-a716-446655440001";
    // cookie presente → vence, ignora o corpo
    assert.equal(resolveVisitorId(`_dia_vid=${vid}`, bodyVid), vid);
    // sem cookie (caso REAL de produção: POST cross-origin sem
    // credentials:"include") → cai pro corpo, validado
    assert.equal(resolveVisitorId(null, bodyVid), bodyVid);
    assert.equal(resolveVisitorId(undefined, bodyVid), bodyVid);
    // corpo inválido/ausente → undefined, nunca lixo repassado
    assert.equal(resolveVisitorId(null, "lixo"), undefined);
    assert.equal(resolveVisitorId(null, undefined), undefined);
    assert.equal(resolveVisitorId(null, ""), undefined);
  });

  it("warnExternalIdFieldMissingOnce: avisa uma única vez, mesmo chamado várias vezes (aviso é por ISOLATE, nunca por request — #8978 fleet review item 2)", () => {
    const original = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      warnExternalIdFieldMissingOnce("test-worker-warn-once", "kit");
      warnExternalIdFieldMissingOnce("test-worker-warn-once", "kit");
      warnExternalIdFieldMissingOnce("test-worker-warn-once", "beehiiv");
    } finally {
      console.warn = original;
    }
    // pode já estar "gasto" por um call site anterior neste MESMO processo
    // de teste (estado module-level, de propósito) — o invariante real é
    // "nunca mais de 1 chamada", nunca "exatamente 1 nesta suíte isolada".
    assert.ok(calls.length <= 1);
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
    // nunca fabrica: o `if (fbclid && FBCLIDRE.test(fbclid) && ...)` é o
    // único caminho que escreve `document.cookie =`. #8978 (fleet review
    // item 5): charset do fbclid validado ANTES de gravar.
    assert.match(js, /if \(fbclid && FBCLIDRE\.test\(fbclid\) && !\/\(\?:\^\|; \)_fbc=\/\.test\(document\.cookie\)\) \{/);
    assert.match(js, /Domain=\.diar\.ia\.br/);
    assert.match(js, /fb\.1\.'/);
  });

  it("metaFbcBootstrapJs: rejeita fbclid com charset fora de FBCLID_RE (nunca grava _fbc com lixo)", () => {
    const js = metaFbcBootstrapJs();
    // a regex embutida é literalmente a fonte de FBCLID_RE, não um regex
    // solto reinventado — trava contra duplicação silenciosa (item 5).
    assert.match(js, new RegExp(FBCLID_RE.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("fbCookieValueFromDocumentCookieJs: expressão pura que lê _fbc/_fbp do document.cookie da página atual", () => {
    const fbcExpr = fbCookieValueFromDocumentCookieJs("_fbc");
    assert.match(fbcExpr, /document\.cookie \|\| ""\)\.match\(\/\(\?:\^\|; \)_fbc=/);
    const fbpExpr = fbCookieValueFromDocumentCookieJs("_fbp");
    assert.match(fbpExpr, /document\.cookie \|\| ""\)\.match\(\/\(\?:\^\|; \)_fbp=/);
    // nunca "undefined" — cai pra string vazia quando o cookie não existe.
    assert.match(fbcExpr, /return m \? m\[1\] : ""/);
    // #8983 fleet review: try/catch defensivo — nunca lança mesmo se
    // `document.cookie` não for string (sandbox de teste com mock incompleto).
    assert.match(fbcExpr, /^\(function \(\) \{ try \{/);
    assert.match(fbcExpr, /\} catch \(e\) \{ return ""; \} \}\)\(\)$/);
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

  it("extractMetaCapiClientSignals: fbcBody/fbpBody/externalIdBody cobrem o request SEM Cookie header — forma real do POST cross-origin (#8978, achado 1 + finding pós-merge)", () => {
    const vid = "550e8400-e29b-41d4-a716-446655440000";
    const fbcBody = "fb.1.1700000000000.body-clid";
    const fbpBody = "fb.1.1700000000000.body-fbp";
    // request SEM header Cookie nenhum (o caso real: POST cross-origin sem
    // credentials:"include") — só o corpo carrega os 3 sinais.
    const signals = extractMetaCapiClientSignals(new Headers(), {
      fbcBody,
      fbpBody,
      externalIdBody: vid,
    });
    assert.equal(signals.fbc, fbcBody);
    assert.equal(signals.fbp, fbpBody);
    assert.equal(signals.externalId, vid);
  });

  it("extractMetaCapiClientSignals: cookie do request vence sobre *Body quando os dois existem", () => {
    const cookieVid = "550e8400-e29b-41d4-a716-446655440000";
    const bodyVid = "660e8400-e29b-41d4-a716-446655440001";
    const signals = extractMetaCapiClientSignals(
      new Headers({ Cookie: `_dia_vid=${cookieVid}; _fbc=fb.1.111.cookie-clid; _fbp=fb.1.111.cookie-fbp` }),
      { fbcBody: "fb.1.999.body-clid", fbpBody: "fb.1.999.body-fbp", externalIdBody: bodyVid },
    );
    assert.equal(signals.externalId, cookieVid);
    assert.equal(signals.fbc, "fb.1.111.cookie-clid");
    assert.equal(signals.fbp, "fb.1.111.cookie-fbp");
  });

  it("extractMetaCapiClientSignals: fbcBody/fbpBody inválidos (fora de FB_COOKIE_RE) são descartados, nunca repassados crus", () => {
    const signals = extractMetaCapiClientSignals(new Headers(), {
      fbcBody: "<script>alert(1)</script>",
      fbpBody: "não é um cookie fb.*",
      externalIdBody: "lixo",
    });
    assert.equal(signals.fbc, undefined);
    assert.equal(signals.fbp, undefined);
    assert.equal(signals.externalId, undefined);
  });

  it("extractMetaCapiClientSignals: fbcBody vence sobre click_id/Referer quando cookie ausente", () => {
    const fbcBody = "fb.1.1700000000000.body-clid";
    const signals = extractMetaCapiClientSignals(new Headers({ Referer: "https://x.test/?fbclid=referer-clid" }), {
      clickId: "fbclid:form-clid",
      fbcBody,
      fbcCreationTimeMs: 999,
    });
    assert.equal(signals.fbc, fbcBody);
  });

  it("FB_COOKIE_RE: tightened pro charset de FBCLID_RE — payload com espaço/tag é rejeitado (#8978 fleet review item 5)", () => {
    assert.equal(FB_COOKIE_RE.test("fb.1.1700000000000.abc-123_.ok"), true);
    assert.equal(FB_COOKIE_RE.test("fb.1.1700000000000.<script>"), false);
    assert.equal(FB_COOKIE_RE.test("fb.1.1700000000000.a b"), false);
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

/** Request SEM header `Cookie` nenhum — a forma REALISTA do POST cross-origin
 * de produção (`livros`/`arquivo`/`diar.ia.br` → `eia.diar.ia.br`, sem
 * `credentials: "include"`). O corpo é a ÚNICA fonte do `_dia_vid`/`_fbc`
 * nesse caminho (#8978, achado 1 do fleet review pós-#8983). */
function subReqCrossOrigin(body: unknown): Request {
  return new Request("https://poll.test/jogar/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://livros.diar.ia.br" },
    body: JSON.stringify(body),
  });
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

  it("#8978 (achado 1, forma REAL de produção): SEM Cookie header, external_id no CORPO do POST → ainda assim gravado no Kit", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReqCrossOrigin({ email: "cross-origin@b.com", optin: true, source: "livros-hero", external_id: VID }),
      pollKitEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields.origem_external_id, VID);
  });

  it("#8978 (forma REAL de produção): SEM Cookie header, external_id INVÁLIDO no corpo → nunca gravado", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReqCrossOrigin({ email: "cross-origin-bad@b.com", optin: true, source: "livros-hero", external_id: "<script>" }),
      pollKitEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields?.origem_external_id, undefined);
  });
});

// ---- caminho Beehiiv, achado 3 do fleet review pós-#8983: a suíte acima só
// exercitava SUBSCRIBE_BACKEND: "kit" — maior tráfego em produção (default de
// resolveBackend) ficava sem cobertura nenhuma pro external_id. Mesmo padrão
// de test/subscribe-origin-signal-8003.test.ts (achado 1 daquela PR). ----

function pollBeehiivEnv(overrides: Partial<PollEnv> = {}): PollEnv {
  return {
    POLL: makeMapKV() as unknown as PollEnv["POLL"],
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "https://diar.ia.br",
    // SUBSCRIBE_BACKEND ausente de propósito — resolveBackend cai em
    // "beehiiv" por default.
    BEEHIIV_API_KEY: "test-beehiiv-key",
    BEEHIIV_PUBLICATION_ID: "pub_test",
    BEEHIIV_API_URL: "https://beehiiv.test/v2",
    BEEHIIV_ORIGEM_EXTERNALID_FIELD: "origem_external_id",
    ...overrides,
  };
}

describe("subscribeToBeehiiv (worker poll) — persiste origem_external_id via custom_fields (#8978, achado 3 do fleet review)", () => {
  it("cookie _dia_vid válido + env configurado → custom_fields recebe o campo (array-append)", async () => {
    const fetchMock = makeFetchMock(200, { data: { status: "active" } });
    const res = await handleJogarSubscribe(
      subReqWithCookie({ email: "a@b.com", optin: true, source: "jogar" }, `_dia_vid=${VID}`),
      pollBeehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.custom_fields, [{ name: "origem_external_id", value: VID }]);
  });

  it("SEM Cookie header (forma real do POST cross-origin), external_id no corpo → custom_fields gravado", async () => {
    const fetchMock = makeFetchMock(200, { data: { status: "active" } });
    const res = await handleJogarSubscribe(
      subReqCrossOrigin({ email: "cross@b.com", optin: true, source: "livros-hero", external_id: VID }),
      pollBeehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.custom_fields, [{ name: "origem_external_id", value: VID }]);
  });

  it("sem env configurado → custom_fields nunca aparece, mesmo com cookie/corpo presentes", async () => {
    const fetchMock = makeFetchMock(200, { data: { status: "active" } });
    const res = await handleJogarSubscribe(
      subReqWithCookie({ email: "b@b.com", optin: true, source: "jogar" }, `_dia_vid=${VID}`),
      pollBeehiivEnv({ BEEHIIV_ORIGEM_EXTERNALID_FIELD: undefined }),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.custom_fields, undefined);
  });

  it("sem cookie nem corpo → custom_fields nunca aparece, mesmo com env configurado", async () => {
    const fetchMock = makeFetchMock(200, { data: { status: "active" } });
    const res = await handleJogarSubscribe(
      subReqWithCookie({ email: "c@b.com", optin: true, source: "jogar" }),
      pollBeehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.custom_fields, undefined);
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

function gateReqNoCookie(body: unknown): Request {
  return new Request("https://cursos.test/gate/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

  it("#8978 (achado 1): SEM Cookie header, external_id no CORPO do POST → ainda assim gravado no Kit", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleGateSubscribe(
      gateReqNoCookie({ email: "cross@b.com", optin: true, external_id: VID }),
      cursosKitEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields.origem_external_id, VID);
  });
});

function cursosBeehiivEnv(overrides: Partial<CursosEnv> = {}): CursosEnv {
  return {
    ASSETS: { fetch: async () => new Response("") } as unknown as CursosEnv["ASSETS"],
    CURSOS_SUBSCRIBERS: makeMapKV() as unknown as CursosEnv["CURSOS_SUBSCRIBERS"],
    COOKIE_HMAC_SECRET: "cookie-secret",
    // SUBSCRIBE_BACKEND ausente — mesmo default beehiiv de resolveBackend.
    BEEHIIV_API_KEY: "test-beehiiv-key",
    BEEHIIV_PUBLICATION_ID: "pub_test",
    BEEHIIV_API_URL: "https://beehiiv.test/v2",
    BEEHIIV_ORIGEM_EXTERNALID_FIELD: "origem_external_id",
    ...overrides,
  };
}

describe("subscribeToBeehiiv (worker cursos) — mesmo invariante do worker poll (#8978, achado 3 do fleet review)", () => {
  it("cookie _dia_vid válido + env configurado → custom_fields recebe o campo", async () => {
    const fetchMock = makeFetchMock(200, { data: { status: "active" } });
    const res = await handleGateSubscribe(
      gateReqWithCookie({ email: "a@b.com", optin: true }, `_dia_vid=${VID}`),
      cursosBeehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.custom_fields, [{ name: "origem_external_id", value: VID }]);
  });

  it("SEM Cookie header, external_id no corpo → custom_fields gravado", async () => {
    const fetchMock = makeFetchMock(200, { data: { status: "active" } });
    const res = await handleGateSubscribe(gateReqNoCookie({ email: "cross@b.com", optin: true, external_id: VID }), cursosBeehiivEnv(), {
      fetchImpl: fetchMock,
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.custom_fields, [{ name: "origem_external_id", value: VID }]);
  });

  it("sem env configurado → custom_fields nunca aparece", async () => {
    const fetchMock = makeFetchMock(200, { data: { status: "active" } });
    const res = await handleGateSubscribe(
      gateReqWithCookie({ email: "b@b.com", optin: true }, `_dia_vid=${VID}`),
      cursosBeehiivEnv({ BEEHIIV_ORIGEM_EXTERNALID_FIELD: undefined }),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.custom_fields, undefined);
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
