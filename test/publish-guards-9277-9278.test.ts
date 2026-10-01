import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateDeliveredSize, GMAIL_CLIP_BYTES } from "../scripts/lint-test-email-size.ts";
import { sitePageMergeBlocker, writeSitePageState } from "../scripts/publish-edition-site-page.ts";

// #9277 — o caso real da 261001: HTML local 43 KB, entregue 106.488 bytes.
test("#9277: sizeEstimate do Gmail acima do corte acusa mesmo com HTML local pequeno", () => {
  const r = evaluateDeliveredSize({ sizeEstimate: 106_488, localHtmlBytes: 43 * 1024 });
  assert.equal(r.over_limit, true);
  assert.equal(r.delivered_source, "gmail_size_estimate");
  assert.equal(r.issues[0].category, "delivered_size_over_clip");
  assert.match(r.issues[0].detail, /HTML local: 43\.0 KB/);
});

test("#9277: sizeEstimate tem precedência sobre o dump", () => {
  const r = evaluateDeliveredSize({ sizeEstimate: 50_000, emailFileBytes: 200_000 });
  assert.equal(r.over_limit, false);
  assert.equal(r.delivered_bytes, 50_000);
});

test("#9277: sem sizeEstimate cai no tamanho do dump", () => {
  const r = evaluateDeliveredSize({ emailFileBytes: GMAIL_CLIP_BYTES + 1 });
  assert.equal(r.delivered_source, "email_file");
  assert.equal(r.over_limit, true);
});

test("#9277: sem medida nenhuma vira info, nunca passa por limpo silencioso", () => {
  const r = evaluateDeliveredSize({});
  assert.equal(r.over_limit, false);
  assert.equal(r.issues[0].category, "delivered_size_unmeasured");
});

// #9278 — PR aberto e não mergeado precisa virar bloqueio com prazo.
test("#9278: published + merged:false gera bloqueio com prazo e link", () => {
  const msg = sitePageMergeBlocker({
    published: true,
    merged: false,
    mergeReason: "CI não convergiu",
    prUrl: "https://x/pull/9263",
    slug: "abc",
  });
  assert.ok(msg);
  assert.match(msg!, /06:00/);
  assert.match(msg!, /\/p\/abc/);
  assert.match(msg!, /pull\/9263/);
});

test("#9278: mergeado ou sem PR não gera bloqueio", () => {
  assert.equal(sitePageMergeBlocker({ published: true, merged: true }), null);
  assert.equal(sitePageMergeBlocker({ published: true, merged: undefined }), null);
  assert.equal(sitePageMergeBlocker({ published: false, merged: false }), null);
});

test("#9278: writeSitePageState persiste mergeBlocker", () => {
  const dir = mkdtempSync(join(tmpdir(), "site-9278-"));
  writeSitePageState(dir, {
    code: 0,
    slug: "abc",
    bytes: 1,
    published: true,
    prUrl: "https://x/pull/1",
    merged: false,
    mergeReason: "timeout",
  } as Parameters<typeof writeSitePageState>[1]);
  const st = JSON.parse(readFileSync(join(dir, "_internal", "site-page-published.json"), "utf8"));
  assert.match(st.mergeBlocker, /BLOQUEIO/);
});
