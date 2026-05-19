/**
 * test/beehiiv-cover-upload.test.ts (#1416)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCoverUploadJs,
  classifyUploadResult,
} from "../scripts/lib/beehiiv-cover-upload.ts";

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

describe("classifyUploadResult (#1416)", () => {
  it("ok=true quando thumbnailSrc bate com pattern Beehiiv S3", () => {
    const r = classifyUploadResult({
      thumbnailSrc: "https://beehiiv-images-production.s3.amazonaws.com/uploads/asset_file_abc.jpg",
      steps: ["clicked: Add thumbnail", "clicked: uploaded image card"],
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.thumbnailUrl, /beehiiv-images-production/);
    }
  });

  it("ok=false quando JS retornou error explícito", () => {
    const r = classifyUploadResult({
      error: "Add thumbnail button not found",
      steps: [],
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /Add thumbnail/);
    }
  });

  it("#1416: ok=false quando thumbnailSrc ausente pós-upload (UI flow falhou silently)", () => {
    const r = classifyUploadResult({
      thumbnailSrc: null,
      steps: ["clicked: Add thumbnail", "clicked: Use from library", "clicked: Upload tab"],
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /ausente pós-upload/);
      assert.equal(r.lastStep, "clicked: Upload tab");
    }
  });

  it("ok=false quando thumbnailSrc não bate pattern Beehiiv (uploadou pra outro lugar)", () => {
    const r = classifyUploadResult({
      thumbnailSrc: "https://random-cdn.example.com/foo.jpg",
      steps: ["all clicks ok"],
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /não bate com pattern/);
    }
  });
});
