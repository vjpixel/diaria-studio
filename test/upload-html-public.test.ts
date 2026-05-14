/**
 * upload-html-public.test.ts (#1178, #1239)
 *
 * Tests pra `scripts/upload-html-public.ts`. Foca na assinatura HMAC,
 * payload do PUT e migração draft Worker (#1239) — fetch é stubado.
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
  buildWorkerUrl,
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

describe("buildWorkerUrl (#1239)", () => {
  it("draft Worker usa root path /{edition}", () => {
    assert.equal(
      buildWorkerUrl("https://draft.diaria.workers.dev", "260514", "draft"),
      "https://draft.diaria.workers.dev/260514",
    );
  });

  it("poll-legacy Worker usa /html/{edition}", () => {
    assert.equal(
      buildWorkerUrl("https://diar-ia-poll.diaria.workers.dev", "260514", "poll-legacy"),
      "https://diar-ia-poll.diaria.workers.dev/html/260514",
    );
  });

  it("trim trailing slash do base URL", () => {
    assert.equal(
      buildWorkerUrl("https://draft.example.dev/", "260514", "draft"),
      "https://draft.example.dev/260514",
    );
  });

  it("encoda edition", () => {
    assert.equal(
      buildWorkerUrl("https://draft.example.dev", "260 514", "draft"),
      "https://draft.example.dev/260%20514",
    );
  });
});

describe("uploadHtml — dry-run", () => {
  it("dry-run não chama fetch e retorna metadata (draft URL por default)", async () => {
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
    assert.match(r.url, /draft.*\/260514$/);
    assert.equal(r.target, "draft");
  });

  it("dry-run com --legacy-only usa poll URL", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "upload-html-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    writeFileSync(htmlPath, "<p>x</p>", "utf8");
    const fetchStub = (): Promise<Response> => {
      throw new Error("fetch should not be called in dry-run");
    };
    const r = await uploadHtml({
      edition: "260514",
      htmlPath,
      secret: SECRET,
      dryRun: true,
      legacyOnly: true,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });
    assert.equal(r.target, "poll-legacy");
    assert.match(r.url, /\/html\/260514$/);
  });
});

describe("uploadHtml — real PUT (#1239 migration)", () => {
  it("tenta draft primeiro, sucesso = retorna target=draft", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "upload-html-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    const html = "<p>real newsletter</p>";
    writeFileSync(htmlPath, html, "utf8");

    let capturedUrl: string | null = null;

    const fetchStub = (url: string | URL): Promise<Response> => {
      capturedUrl = String(url);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, bytes: html.length, ttl_seconds: 43200 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    const r = await uploadHtml({
      edition: "260514",
      htmlPath,
      secret: SECRET,
      draftWorkerUrl: "https://draft.test.dev",
      pollWorkerUrl: "https://poll.test.dev",
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    assert.equal(capturedUrl, "https://draft.test.dev/260514");
    assert.equal(r.target, "draft");
    assert.match(r.url, /draft.test.dev\/260514$/);
  });

  it("fallback automático pra poll-legacy se draft retorna 404", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "upload-html-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    writeFileSync(htmlPath, "<p>x</p>", "utf8");

    const capturedUrls: string[] = [];
    const fetchStub = (url: string | URL): Promise<Response> => {
      const urlStr = String(url);
      capturedUrls.push(urlStr);
      if (urlStr.includes("draft.test.dev")) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ bytes: 3, ttl_seconds: 43200 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    const r = await uploadHtml({
      edition: "260514",
      htmlPath,
      secret: SECRET,
      draftWorkerUrl: "https://draft.test.dev",
      pollWorkerUrl: "https://poll.test.dev",
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    assert.equal(capturedUrls.length, 2, "tentou ambas URLs");
    assert.match(capturedUrls[0], /draft.test.dev/);
    assert.match(capturedUrls[1], /poll.test.dev\/html/);
    assert.equal(r.target, "poll-legacy");
  });

  it("--legacy-only pula draft e vai direto pra poll", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "upload-html-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    writeFileSync(htmlPath, "<p>x</p>", "utf8");

    const capturedUrls: string[] = [];
    const fetchStub = (url: string | URL): Promise<Response> => {
      capturedUrls.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({ bytes: 3, ttl_seconds: 43200 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    const r = await uploadHtml({
      edition: "260514",
      htmlPath,
      secret: SECRET,
      draftWorkerUrl: "https://draft.test.dev",
      pollWorkerUrl: "https://poll.test.dev",
      legacyOnly: true,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    assert.equal(capturedUrls.length, 1, "só 1 tentativa (legacy)");
    assert.match(capturedUrls[0], /poll.test.dev\/html/);
    assert.equal(r.target, "poll-legacy");
  });

  it("rejeita quando ambos workers falham", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "upload-html-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    writeFileSync(htmlPath, "<p>x</p>", "utf8");

    const fetchStub = (): Promise<Response> =>
      Promise.resolve(new Response('{"error":"down"}', { status: 503 }));

    await assert.rejects(
      () =>
        uploadHtml({
          edition: "260514",
          htmlPath,
          secret: SECRET,
          draftWorkerUrl: "https://draft.test.dev",
          pollWorkerUrl: "https://poll.test.dev",
          fetchImpl: fetchStub as unknown as typeof fetch,
        }),
      /falhou em ambos/,
    );
  });

  it("Bearer HMAC + body HTML chega corretamente no fetch", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "upload-html-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    const html = "<p>secret payload</p>";
    writeFileSync(htmlPath, html, "utf8");

    let capturedAuth: string | null = null;
    let capturedBody: string | null = null;
    const fetchStub = (_url: string | URL, init?: RequestInit): Promise<Response> => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
      capturedBody = init?.body as string;
      return Promise.resolve(
        new Response(JSON.stringify({ bytes: html.length, ttl_seconds: 43200 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    await uploadHtml({
      edition: "260514",
      htmlPath,
      secret: SECRET,
      draftWorkerUrl: "https://draft.test.dev",
      fetchImpl: fetchStub as unknown as typeof fetch,
    });
    assert.equal(capturedAuth, `Bearer ${htmlPutSig(SECRET, "260514")}`);
    assert.equal(capturedBody, html);
  });
});
