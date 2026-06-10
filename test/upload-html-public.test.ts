/**
 * upload-html-public.test.ts (#1178, #1239, #2012)
 *
 * Tests pra `scripts/upload-html-public.ts`. Foca na assinatura HMAC e
 * payload do PUT — fetch é stubado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import {
  uploadHtml,
  htmlPutSig,
  buildDraftUrl,
  findUnresolvedImgPlaceholders,
  mergeFieldIntoJson,
  persistFieldToJsonFile,
  checkHtmlFreshness,
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
    assert.ok(r.bytes > "<p>hello</p>".length, "bytes should include preview wrapper");
    assert.match(r.url, /\/260514-[0-9a-f]{6}$/);
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

    // #1494: URL includes content hash (of wrapped HTML, not raw)
    assert.match(capturedUrl!, /^https:\/\/test\.workers\.dev\/260514-[0-9a-f]{6}$/);
    const hashMatch = capturedUrl!.match(/260514-([0-9a-f]{6})$/);
    assert.equal(capturedAuth, `Bearer ${htmlPutSig(SECRET, `260514-${hashMatch![1]}`)}`);
    assert.ok(capturedBody!.includes(html), "body should contain original HTML");
    assert.ok(capturedBody!.includes("preview-wrapper"), "body should include mobile wrapper");
    assert.equal(r.ttl_seconds, 43200);
  });

  it("wrap:false sobe o HTML cru, sem o preview-wrapper (#1914)", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "uphtml-nowrap-"));
    const htmlPath = resolve(dir, "doc.html");
    const fullDoc = "<!DOCTYPE html><html><body><p>mensal</p></body></html>";
    writeFileSync(htmlPath, fullDoc, "utf8");

    let capturedBody: string | null = null;
    const fetchStub = (_url: string | URL, init?: RequestInit): Promise<Response> => {
      capturedBody = init?.body as string;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, bytes: fullDoc.length, ttl_seconds: 43200 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    await uploadHtml({
      edition: "m2605",
      htmlPath,
      secret: SECRET,
      workerUrl: "https://test.workers.dev",
      wrap: false,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    assert.equal(capturedBody, fullDoc, "body deve ser o HTML cru, sem modificação");
    assert.ok(!capturedBody!.includes("preview-wrapper"), "não deve aplicar o wrapper");
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

describe("mergeFieldIntoJson (#1734)", () => {
  it("seta o campo num objeto vazio quando existing é null/undefined", () => {
    assert.deepEqual(mergeFieldIntoJson(null, "social_preview_url", "https://x/1"), {
      social_preview_url: "https://x/1",
    });
    assert.deepEqual(mergeFieldIntoJson(undefined, "url", "https://x/2"), {
      url: "https://x/2",
    });
  });

  it("preserva chaves existentes ao adicionar o campo", () => {
    const existing = { edition: "260602", review_completed: true };
    const out = mergeFieldIntoJson(existing, "social_preview_url", "https://x/3");
    assert.deepEqual(out, {
      edition: "260602",
      review_completed: true,
      social_preview_url: "https://x/3",
    });
  });

  it("sobrescreve o campo se já existir (idempotente em re-upload)", () => {
    const existing = { social_preview_url: "https://old" };
    const out = mergeFieldIntoJson(existing, "social_preview_url", "https://new");
    assert.equal(out.social_preview_url, "https://new");
  });

  it("array/valor não-objeto vira {} (fail-open)", () => {
    assert.deepEqual(
      mergeFieldIntoJson([1, 2] as unknown as Record<string, unknown>, "url", "https://x"),
      { url: "https://x" },
    );
  });

  it("lança em chaves perigosas (__proto__/constructor/prototype) em vez de perder URL", () => {
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      assert.throws(() => mergeFieldIntoJson(null, bad, "https://x"), /campo inválido/);
    }
  });
});

describe("persistFieldToJsonFile (#1734)", () => {
  it("cria o arquivo com o campo quando não existe", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "persist-"));
    const p = resolve(dir, "05-social-preview.json");
    persistFieldToJsonFile(p, "social_preview_url", "https://draft/260602-social-abc123");
    assert.ok(existsSync(p));
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(parsed.social_preview_url, "https://draft/260602-social-abc123");
  });

  it("merge num arquivo existente preservando chaves", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "persist-"));
    const p = resolve(dir, "05-social-preview.json");
    writeFileSync(p, JSON.stringify({ edition: "260602" }), "utf8");
    persistFieldToJsonFile(p, "social_preview_url", "https://draft/x");
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(parsed.edition, "260602");
    assert.equal(parsed.social_preview_url, "https://draft/x");
  });

  it("JSON corrompido → recomeça de {} sem lançar (fail-open)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "persist-"));
    const p = resolve(dir, "05-social-preview.json");
    writeFileSync(p, "{corrompido", "utf8");
    persistFieldToJsonFile(p, "social_preview_url", "https://draft/y");
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(parsed.social_preview_url, "https://draft/y");
  });
});

describe("main() --persist-to + dry-run guard via CLI (#1734 review)", () => {
  it("dry-run com --persist-to NÃO grava arquivo (guard !dry_run) e sai 0", async () => {
    const { spawnSync } = await import("node:child_process");
    const { join } = await import("node:path");
    const projectRoot = join(import.meta.dirname, "..");
    const dir = mkdtempSync(resolve(tmpdir(), "cli-dryrun-"));
    const htmlPath = resolve(dir, "social-preview.html");
    writeFileSync(htmlPath, "<p>preview</p>", "utf8");
    const persistPath = resolve(dir, "05-social-preview.json");

    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(projectRoot, "scripts", "upload-html-public.ts"),
        "--edition",
        "260602-social",
        "--dry-run",
        "--html",
        htmlPath,
        "--persist-to",
        persistPath,
        "--field",
        "social_preview_url",
      ],
      { encoding: "utf8", cwd: projectRoot },
    );

    assert.equal(r.status, 0, `esperava exit 0, stderr: ${r.stderr}`);
    // dry-run não sobe nada → não pode persistir URL que daria 404.
    assert.equal(existsSync(persistPath), false, "dry-run não deve gravar o persist file");
    // stdout ainda traz a URL computada (com hash).
    assert.match(r.stdout, /260602-social-[0-9a-f]{6}/);
  });
});

describe("uploadHtml + --persist-to integração (#1734)", () => {
  it("após PUT real, a URL é persistível no JSON dedicado (não só stdout)", async () => {
    // Simula o fluxo do Stage 4 §3: uploadHtml retorna a URL com hash; o caller
    // persiste via persistFieldToJsonFile. Antes do #1734 a URL só ia pro stdout
    // e morria com o TTL 12h do KV — irrecuperável.
    const dir = mkdtempSync(resolve(tmpdir(), "upload-persist-"));
    const htmlPath = resolve(dir, "social-preview.html");
    writeFileSync(htmlPath, "<p>social preview</p>", "utf8");

    const fetchStub = (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ bytes: 100, ttl_seconds: 43200 }), {
          status: 200,
        }),
      );

    const r = await uploadHtml({
      edition: "260602-social",
      htmlPath,
      secret: SECRET,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });
    assert.match(r.url, /260602-social-[0-9a-f]{6}$/);
    assert.notEqual(r.dry_run, true);

    const persistPath = resolve(dir, "05-social-preview.json");
    persistFieldToJsonFile(persistPath, "social_preview_url", r.url);
    const parsed = JSON.parse(readFileSync(persistPath, "utf8"));
    assert.equal(parsed.social_preview_url, r.url);
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

describe("checkHtmlFreshness (#2012)", () => {
  it("retorna null quando HTML é mais novo que 02-reviewed.md (caso ok)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "freshness-"));
    const mdPath = resolve(dir, "02-reviewed.md");
    const htmlPath = resolve(dir, "newsletter-final.html");
    const past = new Date(Date.now() - 60_000); // 1 minuto atrás
    const now = new Date();
    writeFileSync(mdPath, "# reviewed", "utf8");
    writeFileSync(htmlPath, "<p>html</p>", "utf8");
    utimesSync(mdPath, past, past);
    utimesSync(htmlPath, now, now);
    assert.equal(checkHtmlFreshness(htmlPath, mdPath), null);
  });

  it("retorna mensagem de erro quando HTML é mais antigo que 02-reviewed.md (stale)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "freshness-"));
    const mdPath = resolve(dir, "02-reviewed.md");
    const htmlPath = resolve(dir, "newsletter-final.html");
    const past = new Date(Date.now() - 60_000); // HTML gerado 1 min atrás
    const now = new Date();
    writeFileSync(mdPath, "# reviewed", "utf8");
    writeFileSync(htmlPath, "<p>html</p>", "utf8");
    utimesSync(htmlPath, past, past); // HTML mais antigo
    utimesSync(mdPath, now, now);     // MD editado depois
    const msg = checkHtmlFreshness(htmlPath, mdPath);
    assert.ok(msg !== null, "deve retornar erro de freshness");
    assert.match(msg!, /newsletter-final\.html está desatualizado/);
    assert.match(msg!, /render-newsletter-html/);
    assert.match(msg!, /substitute-image-urls/);
  });

  it("retorna null quando 02-reviewed.md não existe (sem bloqueio em re-renders manuais)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "freshness-"));
    const mdPath = resolve(dir, "02-reviewed.md"); // não criado
    const htmlPath = resolve(dir, "newsletter-final.html");
    writeFileSync(htmlPath, "<p>html</p>", "utf8");
    assert.equal(checkHtmlFreshness(htmlPath, mdPath), null);
  });

  it("retorna null quando htmlPath não existe", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "freshness-"));
    const mdPath = resolve(dir, "02-reviewed.md");
    const htmlPath = resolve(dir, "newsletter-final.html"); // não criado
    writeFileSync(mdPath, "# reviewed", "utf8");
    assert.equal(checkHtmlFreshness(htmlPath, mdPath), null);
  });
});

describe("uploadHtml — freshness guard integração (#2012)", () => {
  it("aborta com erro quando HTML está stale (mtime < 02-reviewed.md)", async () => {
    // Regressão: edição 260610 — render sem --out; newsletter-draft.html nunca
    // regenerou; upload subiu stale sem aviso. Guard deve impedir isso.
    const dir = mkdtempSync(resolve(tmpdir(), "freshness-upload-"));
    const mdPath = resolve(dir, "02-reviewed.md");
    const htmlPath = resolve(dir, "newsletter-final.html");
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    writeFileSync(mdPath, "# reviewed", "utf8");
    writeFileSync(htmlPath, "<p>html</p>", "utf8");
    utimesSync(htmlPath, past, past); // HTML mais antigo (stale)
    utimesSync(mdPath, now, now);     // MD editado depois

    const fetchStub = (): Promise<Response> => {
      throw new Error("fetch should not be called when HTML is stale");
    };
    await assert.rejects(
      () =>
        uploadHtml({
          edition: "260610",
          htmlPath,
          secret: "test-secret",
          reviewedMdPath: mdPath,
          fetchImpl: fetchStub as unknown as typeof fetch,
        }),
      /newsletter-final\.html está desatualizado/,
    );
  });

  it("sucesso quando HTML é mais novo que 02-reviewed.md", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "freshness-upload-ok-"));
    const mdPath = resolve(dir, "02-reviewed.md");
    const htmlPath = resolve(dir, "newsletter-final.html");
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    writeFileSync(mdPath, "# reviewed", "utf8");
    writeFileSync(htmlPath, "<p>html</p>", "utf8");
    utimesSync(mdPath, past, past);  // MD editado antes
    utimesSync(htmlPath, now, now);  // HTML gerado depois (fresh)

    const fetchStub = (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ bytes: 10, ttl_seconds: 43200 }), { status: 200 }),
      );
    const r = await uploadHtml({
      edition: "260610",
      htmlPath,
      secret: "test-secret",
      reviewedMdPath: mdPath,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });
    assert.ok(r.bytes > 0);
  });

  it("sem reviewedMdPath: upload passa mesmo que HTML seja antigo (compatibilidade)", async () => {
    // Chamadas externas / previews mensais sem 02-reviewed.md não devem ser bloqueadas.
    const dir = mkdtempSync(resolve(tmpdir(), "freshness-compat-"));
    const htmlPath = resolve(dir, "newsletter-final.html");
    writeFileSync(htmlPath, "<p>html</p>", "utf8");
    const oldTime = new Date(Date.now() - 3600_000);
    utimesSync(htmlPath, oldTime, oldTime);

    const fetchStub = (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ bytes: 10, ttl_seconds: 43200 }), { status: 200 }),
      );
    const r = await uploadHtml({
      edition: "m2605",
      htmlPath,
      secret: "test-secret",
      // sem reviewedMdPath — mensal / override
      fetchImpl: fetchStub as unknown as typeof fetch,
    });
    assert.ok(r.bytes > 0);
  });
});
