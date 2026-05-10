import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { deleteFbPost, deleteLinkedinKey } from "../scripts/delete-test-schedules.ts";

describe("deleteFbPost (#1058)", () => {
  let saved: typeof globalThis.fetch;
  beforeEach(() => { saved = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = saved; });

  it("DELETE Graph API: 200 success → ok=true", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (url: string | Request) => {
      capturedUrl = typeof url === "string" ? url : url.url;
      return new Response('{"success":true}', { status: 200 });
    }) as typeof fetch;
    const r = await deleteFbPost("12345", "tok-abc", "v25.0");
    assert.equal(r.ok, true);
    assert.equal(r.httpStatus, 200);
    assert.match(capturedUrl ?? "", /graph\.facebook\.com\/v25\.0\/12345/);
    assert.match(capturedUrl ?? "", /access_token=tok-abc/);
  });

  it("DELETE Graph API: 404 not found → ok=false", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const r = await deleteFbPost("99999", "tok", "v25.0");
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 404);
  });

  it("encoda token no URL pra evitar caracteres especiais", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (url: string | Request) => {
      capturedUrl = typeof url === "string" ? url : url.url;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await deleteFbPost("12345", "tok+with/chars=", "v25.0");
    // Token com `+`, `/`, `=` deve ser URL-encoded
    assert.match(capturedUrl ?? "", /access_token=tok%2Bwith%2Fchars%3D/);
  });
});

describe("deleteLinkedinKey (#1058)", () => {
  let saved: typeof globalThis.fetch;
  beforeEach(() => { saved = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = saved; });

  it("DELETE /queue/:key com X-Diaria-Token header", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.url;
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response('{"deleted":true,"key":"x"}', { status: 200 });
    }) as typeof fetch;
    const key = "queue:2026-05-20T12:00:00.000Z:abc-123";
    const r = await deleteLinkedinKey(
      "https://worker.test",
      "secret-tok",
      key,
    );
    assert.equal(r.ok, true);
    assert.equal(r.httpStatus, 200);
    // Key deve ser URL-encoded (contém `:`)
    assert.match(capturedUrl ?? "", /\/queue\/queue%3A2026-05-20T12%3A00%3A00\.000Z%3Aabc-123/);
    assert.equal(capturedHeaders?.["X-Diaria-Token"], "secret-tok");
  });

  it("normaliza trailing slash no workerUrl", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (url: string | Request) => {
      capturedUrl = typeof url === "string" ? url : url.url;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await deleteLinkedinKey("https://worker.test///", "tok", "queue:k1");
    assert.match(capturedUrl ?? "", /^https:\/\/worker\.test\/queue\//);
    assert.ok(!(capturedUrl ?? "").includes("//queue"));
  });

  it("404 not found → ok=false (key já deletada/firada)", async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":"key not found"}', { status: 404 })) as typeof fetch;
    const r = await deleteLinkedinKey("https://w.test", "t", "queue:gone");
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 404);
  });

  it("401 unauthorized → ok=false", async () => {
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    const r = await deleteLinkedinKey("https://w.test", "wrong", "queue:k1");
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 401);
  });
});

// ── #1056 — is_test filter safety logic ──

describe("#1056 is_test filter (filterTargets safety)", () => {
  // Replica a lógica do filter no main() pra testar isolado
  // Filter rule: if requireIsTest, p.is_test must be true; status !== "deleted"; platform match
  function filterTargets(
    posts: Array<{ status: string; is_test?: boolean; platform: string; destaque: string }>,
    requireIsTest: boolean,
    platform: "all" | "facebook" | "linkedin" = "all",
  ) {
    return posts.filter((p) => {
      if (p.status === "deleted") return false;
      if (requireIsTest && p.is_test !== true) return false;
      if (platform === "all") return true;
      return p.platform === platform;
    });
  }

  const productionPosts = [
    { platform: "facebook", destaque: "d1", status: "scheduled" }, // sem is_test (produção real)
    { platform: "facebook", destaque: "d2", status: "scheduled" },
    { platform: "linkedin", destaque: "d1", status: "scheduled", subtype: "main" },
  ];

  const testPosts = [
    { platform: "facebook", destaque: "d1", status: "scheduled", is_test: true },
    { platform: "linkedin", destaque: "d1", status: "scheduled", is_test: true, subtype: "main" },
    { platform: "linkedin", destaque: "d2", status: "scheduled", is_test: true, subtype: "comment_pixel" },
  ];

  it("require_is_test=true: produção real (sem is_test) → filtra fora (safety)", () => {
    const targets = filterTargets(productionPosts, true);
    assert.equal(targets.length, 0, "Sem is_test, nenhum target");
  });

  it("require_is_test=true: posts marcados is_test:true → incluídos", () => {
    const targets = filterTargets(testPosts, true);
    assert.equal(targets.length, 3);
  });

  it("require_is_test=false: força deleta tudo (perigoso, opt-out via flag)", () => {
    const targets = filterTargets(productionPosts, false);
    assert.equal(targets.length, 3, "Com --no-require-is-test, todos voltam");
  });

  it("entries já deletadas (status=deleted) sempre filtradas", () => {
    const mixed = [
      { platform: "facebook", destaque: "d1", status: "deleted", is_test: true },
      { platform: "linkedin", destaque: "d1", status: "scheduled", is_test: true },
    ];
    const targets = filterTargets(mixed, true);
    assert.equal(targets.length, 1, "Apenas a não-deleted deve sobrar");
  });

  it("mixed produção + test: require_is_test only deleta os tagados", () => {
    const mixed = [
      ...productionPosts,
      ...testPosts,
    ];
    const targets = filterTargets(mixed, true);
    assert.equal(targets.length, 3, "Apenas os 3 com is_test");
    for (const t of targets) {
      // @ts-expect-error testing inline shape
      assert.equal(t.is_test, true);
    }
  });

  it("filter combina platform + is_test", () => {
    const targets = filterTargets(testPosts, true, "linkedin");
    assert.equal(targets.length, 2, "Apenas linkedin de test");
    for (const t of targets) assert.equal(t.platform, "linkedin");
  });
});
