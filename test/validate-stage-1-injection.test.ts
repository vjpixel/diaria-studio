import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMissingUrls } from "../scripts/validate-stage-1-injection.ts";

const editorUrl1 = "https://example.com/article-one";
const editorUrl2 = "https://example.org/post?utm_source=newsletter";
const trackingUrl = "https://tracking.tldrnewsletter.com/CL0/x/1/abc=";

describe("computeMissingUrls", () => {
  it("retorna vazio quando todos os URLs do editor estão no pool", () => {
    const editor = [editorUrl1, editorUrl2];
    const pool = [editorUrl1, editorUrl2, "https://other.com/z"];
    assert.deepEqual(computeMissingUrls(editor, pool), []);
  });

  it("detecta step 1h skipado quando pool está vazio", () => {
    const editor = [editorUrl1, editorUrl2];
    const missing = computeMissingUrls(editor, []);
    assert.deepEqual(missing, editor);
  });

  it("detecta subset faltante quando pool tem apenas parte dos URLs", () => {
    const editor = [editorUrl1, editorUrl2];
    const pool = [editorUrl1];
    const missing = computeMissingUrls(editor, pool);
    assert.deepEqual(missing, [editorUrl2]);
  });

  it("canonicaliza trailing slash — URL com e sem barra devem dar match", () => {
    const editorWithSlash = "https://example.com/article-one/";
    const poolWithoutSlash = ["https://example.com/article-one"];
    assert.deepEqual(computeMissingUrls([editorWithSlash], poolWithoutSlash), []);
  });

  it("canonicaliza UTM params — URL com utm_source deve dar match com URL limpa", () => {
    const editorWithUtm = "https://example.org/post?utm_source=newsletter&utm_medium=email";
    const poolClean = ["https://example.org/post"];
    assert.deepEqual(computeMissingUrls([editorWithUtm], poolClean), []);
  });
});
