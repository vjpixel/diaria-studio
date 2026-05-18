/**
 * apply-mcp-clicks.test.ts (#1357 followup)
 *
 * Cobre mapClick (MCP shape → legacy shape) e extractClicksArray
 * (input shape tolerance). Regression: o bootstrap inicial gerou CTR 0.00%
 * em todos os links porque o sync silenciosamente 404'ava no /clicks REST,
 * e mesmo se tivesse buscado, os field names da API moderna não batem com
 * o que build-link-ctr.ts lê. Este test fixa o contract de mapping.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { mapClick, extractClicksArray, applyClicks } from "../scripts/apply-mcp-clicks.ts";

describe("mapClick — MCP shape → legacy", () => {
  it("mapeia campos verified preferencialmente", () => {
    const mcp = {
      url: "https://example.com/a",
      url_hash: "h1",
      email: {
        total_clicked: 30,
        total_unique_clicked: 22,
        click_rate: 14.29,
        total_clicked_verified: 21,
        total_unique_clicked_verified: 19,
        click_rate_verified: 13.64,
      },
      web: { total_clicked: 5, total_unique_clicked: 4 },
    };
    const mapped = mapClick(mcp);
    assert.equal(mapped.url, "https://example.com/a");
    assert.equal(mapped.url_hash, "h1");
    // verified_clicks vem do total_clicked_verified (preferido)
    assert.equal(mapped.email.verified_clicks, 21);
    assert.equal(mapped.email.unique_verified_clicks, 19);
    assert.equal(mapped.email.unique_clicks, 22);
    assert.equal(mapped.email.click_rate, 14.29);
    assert.equal(mapped.email.click_rate_verified, 13.64);
    assert.deepEqual(mapped.web, { total_clicked: 5, total_unique_clicked: 4 });
  });

  it("falls back para total_clicked quando verified ausente", () => {
    const mcp = {
      url: "https://example.com/b",
      email: { total_clicked: 10, total_unique_clicked: 8 },
    };
    const mapped = mapClick(mcp);
    // sem _verified, usa total_clicked como verified_clicks fallback
    assert.equal(mapped.email.verified_clicks, 10);
    assert.equal(mapped.email.unique_verified_clicks, 8);
    assert.equal(mapped.email.unique_clicks, 8);
  });

  it("zera quando email ausente completamente", () => {
    const mapped = mapClick({ url: "https://x.com/" });
    assert.equal(mapped.email.verified_clicks, 0);
    assert.equal(mapped.email.unique_verified_clicks, 0);
    assert.equal(mapped.email.unique_clicks, 0);
  });
});

describe("extractClicksArray — input tolerance", () => {
  it("aceita { clicks: [...] }", () => {
    const got = extractClicksArray({ clicks: [{ url: "a" }] });
    assert.equal(got.length, 1);
  });
  it("aceita { data: [...] }", () => {
    const got = extractClicksArray({ data: [{ url: "a" }, { url: "b" }] });
    assert.equal(got.length, 2);
  });
  it("aceita array nu", () => {
    const got = extractClicksArray([{ url: "a" }]);
    assert.equal(got.length, 1);
  });
  it("retorna [] pra null/undefined/primitivo", () => {
    assert.deepEqual(extractClicksArray(null), []);
    assert.deepEqual(extractClicksArray(undefined), []);
    assert.deepEqual(extractClicksArray(42), []);
    assert.deepEqual(extractClicksArray("string"), []);
  });
});

describe("applyClicks — integration", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "apply-mcp-clicks-"));
    const postsDir = resolve(dir, "posts");
    mkdirSync(postsDir, { recursive: true });
    return { dir, postsDir };
  }

  it("escreve stats.clicks com shape mapeado, replace por default", () => {
    const { postsDir } = setup();
    const postId = "post_test_001";
    const cachePath = resolve(postsDir, `${postId}.json`);
    writeFileSync(cachePath, JSON.stringify({
      id: postId, title: "T",
      stats: { email: { clicks: 5 }, clicks: [] },
    }));
    const stdin = JSON.stringify({
      clicks: [
        { url: "https://a.com/", email: { total_clicked_verified: 10, total_unique_clicked_verified: 7, total_unique_clicked: 7 } },
        { url: "https://b.com/", email: { total_clicked_verified: 3, total_unique_clicked_verified: 3, total_unique_clicked: 3 } },
      ],
    });
    const result = applyClicks(stdin, { postId, append: false, postsDir });
    assert.equal(result.after_count, 2);
    assert.equal(result.mapped, 2);

    const written = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(written.stats.clicks.length, 2);
    assert.equal(written.stats.clicks[0].email.verified_clicks, 10);
    assert.equal(written.stats.email.clicks, 5, "preserved aggregate stats");
  });

  it("append dedup por url", () => {
    const { postsDir } = setup();
    const postId = "post_test_002";
    const cachePath = resolve(postsDir, `${postId}.json`);
    writeFileSync(cachePath, JSON.stringify({
      id: postId,
      stats: { clicks: [{ url: "https://a.com/", email: { verified_clicks: 5 } }] },
    }));
    const stdin = JSON.stringify({
      clicks: [
        { url: "https://a.com/", email: { total_clicked_verified: 99 } }, // overrides
        { url: "https://new.com/", email: { total_clicked_verified: 2 } },
      ],
    });
    const result = applyClicks(stdin, { postId, append: true, postsDir });
    assert.equal(result.after_count, 2, "a.com deduped, new.com added");

    const written = JSON.parse(readFileSync(cachePath, "utf8"));
    const aCom = written.stats.clicks.find((c: { url: string }) => c.url === "https://a.com/");
    assert.equal(aCom.email.verified_clicks, 99, "incoming wins on dedup");
  });

  it("erro loud se cache do post não existe", () => {
    const { postsDir } = setup();
    assert.throws(
      () => applyClicks('{"clicks":[]}', { postId: "post_nonexistent", append: false, postsDir }),
      /cache miss/,
    );
  });
});
