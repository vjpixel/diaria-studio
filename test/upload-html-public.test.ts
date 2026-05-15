/**
 * upload-html-public.test.ts (#1178, #1239)
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
import {
  uploadHtml,
  htmlPutSig,
  buildDraftUrl,
  findUnresolvedImgPlaceholders,
} from "../scripts/upload-html-public.ts";

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

describe("buildDraftUrl (#1239)", () => {
  it("usa root path /{edition}", () => {
    assert.equal(
      buildDraftUrl("https://draft.diaria.workers.dev", "260514"),
      "https://draft.diaria.workers.dev/260514",
    );
  });

  it("trim trailing slash do base URL", () => {
    assert.equal(
      buildDraftUrl("https://draft.example.dev/", "260514"),
      "https://draft.example.dev/260514",
    );
  });

  it("encoda edition", () => {
    assert.equal(
      buildDraftUrl("https://draft.example.dev", "260 514"),
      "https://draft.example.dev/260%20514",
    );
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
    assert.match(r.url, /\/260514$/);
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
        new Response(JSON.stringify({ ok: true, key: "260514", bytes: html.length, ttl_seconds: 43200 }), {
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

    assert.equal(capturedUrl, "https://test.workers.dev/260514");
    assert.equal(capturedAuth, `Bearer ${htmlPutSig(SECRET, "260514")}`);
    assert.equal(capturedBody, html);
    assert.equal(r.bytes, html.length);
    assert.equal(r.ttl_seconds, 43200);
  });

  it("propaga erro quando Worker retorna não-2xx", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "upload-html-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    writeFileSync(htmlPath, "<p>x</p>", "utf8");

    const fetchStub = (): Promise<Response> =>
      Promise.resolve(new Response('{"error":"forbidden"}', { status: 403 }));

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
});

describe("findUnresolvedImgPlaceholders (#1277)", () => {
  it("retorna lista vazia quando HTML não tem placeholders", () => {
    const html = '<img src="https://example.com/img.jpg" alt=""/>';
    assert.deepEqual(findUnresolvedImgPlaceholders(html), []);
  });

  it("detecta placeholders {{IMG:...}} unresolved", () => {
    const html = '<img src="{{IMG:04-d1-2x1.jpg}}"/><img src="{{IMG:01-eia-A.jpg}}"/>';
    const found = findUnresolvedImgPlaceholders(html).sort();
    assert.deepEqual(found, ["{{IMG:01-eia-A.jpg}}", "{{IMG:04-d1-2x1.jpg}}"]);
  });

  it("dedup quando mesma placeholder aparece múltiplas vezes", () => {
    const html =
      '<img src="{{IMG:cover.jpg}}"/><img src="{{IMG:cover.jpg}}"/>';
    assert.deepEqual(findUnresolvedImgPlaceholders(html), ["{{IMG:cover.jpg}}"]);
  });
});

describe("uploadHtml — fail-loud em placeholders {{IMG:...}} (#1277)", () => {
  it("aborta com erro útil quando HTML tem placeholders unresolved", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "upload-html-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    writeFileSync(
      htmlPath,
      '<img src="{{IMG:04-d1-2x1.jpg}}"/><img src="{{IMG:01-eia-A.jpg}}"/>',
      "utf8",
    );

    const fetchStub = (): Promise<Response> => {
      throw new Error("fetch should not be called when placeholders unresolved");
    };

    await assert.rejects(
      () =>
        uploadHtml({
          edition: "260515",
          htmlPath,
          secret: SECRET,
          fetchImpl: fetchStub as unknown as typeof fetch,
        }),
      (e) => {
        const msg = (e as Error).message;
        return (
          /placeholder/i.test(msg) &&
          /substitute-image-urls/.test(msg) &&
          /upload-images-public/.test(msg) &&
          /04-d1-2x1\.jpg/.test(msg)
        );
      },
    );
  });

  it("aborta antes mesmo de testar dry-run (placeholder check é eager)", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "upload-html-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    writeFileSync(htmlPath, '<img src="{{IMG:cover.jpg}}"/>', "utf8");

    await assert.rejects(
      () =>
        uploadHtml({
          edition: "260515",
          htmlPath,
          secret: SECRET,
          dryRun: true,
        }),
      /placeholder/i,
    );
  });

  it("permite upload quando HTML sem placeholders", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "upload-html-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    writeFileSync(htmlPath, '<img src="https://cdn.example/img.jpg"/>', "utf8");

    const r = await uploadHtml({
      edition: "260515",
      htmlPath,
      secret: SECRET,
      dryRun: true,
    });
    assert.equal(r.dry_run, true);
  });
});
