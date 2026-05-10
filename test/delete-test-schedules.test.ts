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
