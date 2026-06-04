/**
 * test/beehiiv-cover-upload.test.ts (#1416)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCoverUploadJs,
  buildCoverDataTransferJs,
  buildCoverReplaceJs,
  classifyUploadResult,
  buildCoverApplyLocateJs,
  buildCoverVerifyJs,
  classifyCoverVerify,
} from "../scripts/lib/beehiiv-cover-upload.ts";

describe("buildCoverDataTransferJs — método primário (#1801 / #1500)", () => {
  it("gera JS com DataTransfer no input[type=file] + a URL da imagem", () => {
    const url = "https://poll.diaria.workers.dev/img/img-260604-04-d1-2x1.jpg";
    const js = buildCoverDataTransferJs(url);
    assert.match(js, /new DataTransfer\(\)/, "deve usar DataTransfer");
    assert.match(js, /input\[type="file"\]/, "deve setar o input[type=file]");
    assert.match(js, /\.click\(\)/, "deve clicar na img subida pra aplicar");
    assert.ok(js.includes(JSON.stringify(url)), "deve embutir a URL da imagem");
  });

  it("escapa a URL com segurança (JSON.stringify, não concatenação crua)", () => {
    const js = buildCoverDataTransferJs('https://x/y".jpg');
    assert.ok(js.includes(JSON.stringify('https://x/y".jpg')));
  });

  it("usa o filename default 04-d1-2x1.jpg (e aceita override)", () => {
    assert.match(buildCoverDataTransferJs("https://x/y.jpg"), /04-d1-2x1\.jpg/);
    assert.match(buildCoverDataTransferJs("https://x/y.jpg", "capa.jpg"), /capa\.jpg/);
  });

  it("retorna o shape de classifyCoverVerify (verificação DOM-only #1705)", () => {
    const js = buildCoverDataTransferJs("https://x/y.jpg");
    // o JS resolve com { addThumbnailPresent, thumbnailSrc, steps } → classificável
    assert.match(js, /addThumbnailPresent/);
    assert.match(js, /thumbnailSrc/);
  });
});

describe("aplicar/verificar capa por clique real (#1705)", () => {
  it("buildCoverApplyLocateJs localiza o card uploadado (não clica)", () => {
    const js = buildCoverApplyLocateJs();
    assert.match(js, /uploads.asset.file/);
    assert.match(js, /getBoundingClientRect/);
    assert.doesNotMatch(js, /\.click\(\)/);
  });

  it("buildCoverVerifyJs checa 'Add thumbnail' ausente + thumbnail presente", () => {
    const js = buildCoverVerifyJs();
    assert.match(js, /add thumbnail/i);
    assert.match(js, /beehiiv-images-production/);
    assert.match(js, /addThumbnailPresent/);
  });

  it("classifyCoverVerify: aplicada = Add thumbnail ausente + thumbnail presente", () => {
    const r = classifyCoverVerify({ addThumbnailPresent: false, thumbnailSrc: "https://beehiiv-images-production/uploads/x.jpg" });
    assert.equal(r.applied, true);
    assert.equal((r as { thumbnailUrl: string }).thumbnailUrl, "https://beehiiv-images-production/uploads/x.jpg");
  });

  it("classifyCoverVerify: 'Add thumbnail' ainda presente → NÃO aplicada", () => {
    const r = classifyCoverVerify({ addThumbnailPresent: true, thumbnailSrc: null });
    assert.equal(r.applied, false);
    assert.match((r as { reason: string }).reason, /Add thumbnail.*presente/);
  });

  it("classifyCoverVerify: resposta vazia/null (#1640) → NÃO aplicada (sem declaração silenciosa)", () => {
    assert.equal(classifyCoverVerify(null).applied, false);
    assert.equal(classifyCoverVerify(undefined).applied, false);
    assert.equal(classifyCoverVerify({ error: "boom" }).applied, false);
  });

  it("classifyCoverVerify: sem thumbnail src → NÃO aplicada", () => {
    const r = classifyCoverVerify({ addThumbnailPresent: false, thumbnailSrc: null });
    assert.equal(r.applied, false);
  });
});

describe("buildCoverUploadJs (#1416)", () => {
  it("encoda URL como JSON string (escape seguro)", () => {
    const url = `https://poll.diaria.workers.dev/img/img-260520-04-d1-2x1.jpg?v=2`;
    const js = buildCoverUploadJs(url);
    assert.match(js, /"https:\/\/poll\.diaria\.workers\.dev\/img\/img-260520-04-d1-2x1\.jpg\?v=2"/);
  });

  it("inclui sequência completa de cliques (Add thumbnail → Upload from URL)", () => {
    const js = buildCoverUploadJs("https://x.com/a.jpg");
    assert.match(js, /Use from library/);
    assert.match(js, /add thumbnail/i);
    assert.match(js, /Upload from URL/i);
    assert.match(js, /upload \\d\+ media/i);
  });

  it("usa native setter pra contornar React controlled inputs", () => {
    const js = buildCoverUploadJs("https://x.com/a.jpg");
    assert.match(js, /HTMLTextAreaElement\.prototype.*value/);
    assert.match(js, /nativeSetter\.call/);
    assert.match(js, /new Event\('input'/);
  });

  it("retorna steps trail pra debug", () => {
    const js = buildCoverUploadJs("https://x.com/a.jpg");
    assert.match(js, /steps\.push\(/);
  });
});

describe("classifyUploadResult (#1416, #1705)", () => {
  it("#1705: ok=true quando a imagem chegou no library (librarySrc)", () => {
    const r = classifyUploadResult({
      librarySrc: "https://uploads.asset.file/abc.jpg",
      steps: ["clicked: Upload N media", "found: uploaded card in library"],
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.libraryUrl, "https://uploads.asset.file/abc.jpg");
  });

  it("#1705: thumbnailSrc (auto-apply do Beehiiv) também conta como sucesso de upload", () => {
    const r = classifyUploadResult({
      thumbnailSrc: "https://beehiiv-images-production.s3.amazonaws.com/uploads/asset_file_abc.jpg",
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.match(r.libraryUrl, /beehiiv-images-production/);
  });

  it("#1705: NÃO gateia o upload no thumbnail aplicado — librarySrc só já é sucesso", () => {
    // Antes (#1705 bug): exigia beehiiv-images-production (thumbnail aplicado),
    // então o loop gastava 3 retries antes do apply real. Agora library basta.
    const r = classifyUploadResult({ librarySrc: "https://random-cdn.example.com/foo.jpg" });
    assert.equal(r.ok, true);
  });

  it("ok=false quando JS retornou error explícito", () => {
    const r = classifyUploadResult({ error: "Add thumbnail button not found", steps: [] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /Add thumbnail/);
  });

  it("ok=false quando nada apareceu no library (librarySrc + thumbnailSrc ausentes)", () => {
    const r = classifyUploadResult({
      librarySrc: null,
      thumbnailSrc: null,
      steps: ["clicked: Add thumbnail", "clicked: Use from library", "clicked: Upload tab"],
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /library/);
      assert.equal(r.lastStep, "clicked: Upload tab");
    }
  });

  // #1640: MCP claude-in-chrome retorna vazio/null em disconnect intermitente.
  it("#1640: result null → ok=false retryable, NÃO lança TypeError", () => {
    const r = classifyUploadResult(null);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /disconnect.*claude-in-chrome|#1640/);
  });

  it("#1640: result undefined → ok=false retryable", () => {
    assert.equal(classifyUploadResult(undefined).ok, false);
  });

  it("#1640: result não-objeto (string vazia) → ok=false retryable", () => {
    // @ts-expect-error — simula retorno degenerado do MCP
    assert.equal(classifyUploadResult("").ok, false);
  });

  it("#1640: objeto vazio {} → ok=false (nada no library, não crash)", () => {
    assert.equal(classifyUploadResult({}).ok, false);
  });
});

describe("buildCoverReplaceJs (#1457)", () => {
  it("detecta cover existente via Beehiiv S3 pattern", () => {
    const js = buildCoverReplaceJs("https://x.com/new.jpg");
    assert.ok(js.includes("beehiiv-images-production"));
    assert.ok(js.includes("found existing cover"));
  });

  it("usa aria-label selectors específicos (não regex frouxa)", () => {
    const js = buildCoverReplaceJs("https://x.com/new.jpg");
    // Selectors canonical via aria-label
    assert.ok(js.includes('aria-label*="Remove thumbnail" i'));
    assert.ok(js.includes('aria-label*="Delete thumbnail" i'));
    // Distractors EXPLICITAMENTE blocked
    assert.ok(js.includes("twitter|share|navigate|tab|settings"));
    // Word boundary em vez de char solto
    assert.ok(js.includes("\\b(remove|delete|trash)\\b"));
  });

  it("trata caso sem cover existente (fallback pra Add thumbnail flow)", () => {
    const js = buildCoverReplaceJs("https://x.com/new.jpg");
    // Quando `existing` é null, ainda procura "Add thumbnail" ou "Change thumbnail"
    assert.ok(js.includes("add thumbnail|change thumbnail"));
  });

  it("aguarda confirmação modal pós-remove", () => {
    const js = buildCoverReplaceJs("https://x.com/new.jpg");
    assert.ok(js.includes("Confirm|Yes|Remove|Delete"));
    assert.ok(js.includes("confirmed modal"));
  });

  it("encoda URL como JSON string (escape seguro)", () => {
    const url = `https://poll.diaria.workers.dev/img/img-260520-04-d1-2x1.jpg?v=3&t=now`;
    const js = buildCoverReplaceJs(url);
    assert.ok(js.includes('"' + url + '"'));
  });

  it("NÃO clica X (previously Twitter) — caso real 260522", () => {
    const js = buildCoverReplaceJs("https://x.com/new.jpg");
    assert.ok(js.includes("twitter"));
    // Distractor blocking inclui share/navigate/tab/settings/preview/publish/schedule/save
    assert.ok(js.includes("twitter|share|navigate|tab|settings|preview|publish|schedule|save"));
  });

  it("retorna replaced flag pra distinguir replace vs initial upload", () => {
    const js = buildCoverReplaceJs("https://x.com/new.jpg");
    assert.ok(js.includes("replaced: !!existing"));
  });
});
