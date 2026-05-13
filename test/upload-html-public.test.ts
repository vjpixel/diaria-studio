/**
 * upload-html-public.test.ts (#1178)
 *
 * Tests pra `scripts/upload-html-public.ts`. Foca na assinatura HMAC e
 * payload do PUT — fetch é stubado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import { uploadHtml, htmlPutSig } from "../scripts/upload-html-public.ts";

const SECRET = "test-admin";

describe("htmlPutSig", () => {
  it("HMAC SHA-256 de `html:{key}` com ADMIN_SECRET", () => {
    const sig = htmlPutSig(SECRET, "260514");
    const expected = createHmac("sha256", SECRET)
      .update("html:260514")
      .digest("hex");
    assert.equal(sig, expected);
  });

  it("sigs diferentes pra keys diferentes", () => {
    assert.notEqual(htmlPutSig(SECRET, "260514"), htmlPutSig(SECRET, "260515"));
  });
});

describe("uploadHtml — dry-run", () => {
  it("dry-run não chama fetch e retorna metadata", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "upload-html-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    writeFileSync(htmlPath, "<p>hello</p>", "utf8");

    const fetchStub = (): Promise<Response> => {
      throw new Error("fetch should not be called in dry-run");
    };

    const r = await uploadHtml({
      edition: "260514",
      htmlPath,
      secret: SECRET,
      dryRun: true,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });
    assert.equal(r.edition, "260514");
    assert.equal(r.dry_run, true);
    assert.equal(r.bytes, "<p>hello</p>".length);
    assert.match(r.url, /\/html\/260514$/);
  });
});

describe("uploadHtml — real PUT", () => {
  it("PUT com Bearer HMAC válido + body HTML", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "upload-html-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    const html = "<p>real newsletter</p>";
    writeFileSync(htmlPath, html, "utf8");

    let capturedUrl: string | null = null;
    let capturedAuth: string | null = null;
    let capturedBody: string | null = null;

    const fetchStub = (url: string | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
      capturedBody = init?.body as string;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, key: "260514", bytes: html.length, ttl_seconds: 604800 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    const r = await uploadHtml({
      edition: "260514",
      htmlPath,
      secret: SECRET,
      workerUrl: "https://test.workers.dev",
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    assert.equal(capturedUrl, "https://test.workers.dev/html/260514");
    assert.equal(capturedAuth, `Bearer ${htmlPutSig(SECRET, "260514")}`);
    assert.equal(capturedBody, html);
    assert.equal(r.bytes, html.length);
    assert.equal(r.ttl_seconds, 604800);
  });

  it("propaga erro quando Worker retorna não-2xx", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "upload-html-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    writeFileSync(htmlPath, "<p>x</p>", "utf8");

    const fetchStub = (): Promise<Response> => {
      return Promise.resolve(
        new Response('{"error":"forbidden"}', { status: 403 }),
      );
    };

    await assert.rejects(
      () =>
        uploadHtml({
          edition: "260514",
          htmlPath,
          secret: SECRET,
          fetchImpl: fetchStub as unknown as typeof fetch,
        }),
      /Worker PUT 403/,
    );
  });

  it("trim trailing slash do workerUrl pra evitar /html//{key}", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "upload-html-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    writeFileSync(htmlPath, "<p>x</p>", "utf8");

    let capturedUrl: string | null = null;
    const fetchStub = (url: string | URL): Promise<Response> => {
      capturedUrl = String(url);
      return Promise.resolve(
        new Response('{"bytes":3,"ttl_seconds":604800}', { status: 200 }),
      );
    };

    await uploadHtml({
      edition: "260514",
      htmlPath,
      secret: SECRET,
      workerUrl: "https://test.workers.dev/", // trailing slash
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    assert.equal(capturedUrl, "https://test.workers.dev/html/260514");
  });
});
