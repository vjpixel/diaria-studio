import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateDeliveredSize, GMAIL_CLIP_BYTES, GMAIL_NEAR_CLIP_BYTES } from "../scripts/lint-test-email-size.ts";
import { sitePageMergeBlocker, writeSitePageState } from "../scripts/publish-edition-site-page.ts";

// #9277 — o caso real da 261001: HTML local 43 KB, entregue 106.488 bytes.
// #9311: sizeEstimate é a mensagem MIME inteira (teto da parte HTML) — acima do
// corte vira "pode cortar" (info), nunca over_limit/blocker.
test("#9277/#9311: sizeEstimate acima do corte acusa como PODE cortar, sem over_limit", () => {
  const r = evaluateDeliveredSize({ sizeEstimate: 106_488, localHtmlBytes: 43 * 1024 });
  assert.equal(r.over_limit, false);
  assert.equal(r.may_clip, true);
  assert.equal(r.delivered_source, "gmail_size_estimate");
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].category, "delivered_size_may_clip");
  assert.equal(r.issues[0].type, "info");
  assert.match(r.issues[0].detail, /HTML local: 43\.0 KB/);
  assert.match(r.issues[0].detail, /MIME inteira/);
});

// #9311 — cenário da issue: HTML de ~60 KB, estimate de ~110 KB → não acusa corte.
test("#9311: parte HTML medida tem precedência sobre o sizeEstimate (HTML 60 KB, estimate 110 KB → ok)", () => {
  const r = evaluateDeliveredSize({ htmlPartBytes: 60 * 1024, sizeEstimate: 110 * 1024 });
  assert.equal(r.delivered_source, "gmail_html_part");
  assert.equal(r.over_limit, false);
  assert.equal(r.may_clip, false);
  assert.deepEqual(r.issues, []);
});

test("#9311: parte HTML acima do corte é veredito definitivo (over_clip, over_limit)", () => {
  const r = evaluateDeliveredSize({ htmlPartBytes: GMAIL_CLIP_BYTES + 1, sizeEstimate: 200_000 });
  assert.equal(r.over_limit, true);
  assert.equal(r.may_clip, false);
  assert.equal(r.issues[0].category, "delivered_size_over_clip");
});

test("#9311: sizeEstimate abaixo do corte → ok (o teto já prova que a parte HTML cabe)", () => {
  // #9823: no alarme de 95 KB ainda é silêncio; entre ele e o corte vira near_clip (teste abaixo).
  const r = evaluateDeliveredSize({ sizeEstimate: GMAIL_NEAR_CLIP_BYTES });
  assert.equal(r.over_limit, false);
  assert.equal(r.may_clip, false);
  assert.equal(r.near_clip, false);
  assert.deepEqual(r.issues, []);
});

// #9823 — caso real da 261007: e-mail de teste com 98,8 KB, a ~3% do corte, sem nenhum aviso.
test("#9823: entre 95 KB e o corte acusa near_clip (warning com parte HTML, info com sizeEstimate), exit inalterado", () => {
  const html = evaluateDeliveredSize({ htmlPartBytes: Math.round(98.8 * 1024) });
  assert.equal(html.near_clip, true);
  assert.equal(html.over_limit, false);
  assert.equal(html.issues.length, 1);
  assert.equal(html.issues[0].category, "delivered_size_near_clip");
  assert.equal(html.issues[0].type, "warning");
  const est = evaluateDeliveredSize({ sizeEstimate: GMAIL_CLIP_BYTES });
  assert.equal(est.near_clip, true);
  assert.equal(est.may_clip, false);
  assert.equal(est.issues[0].category, "delivered_size_near_clip");
  assert.equal(est.issues[0].type, "info");
  const over = evaluateDeliveredSize({ htmlPartBytes: GMAIL_CLIP_BYTES + 1 });
  assert.equal(over.near_clip, false, "acima do corte é over_clip, não near_clip");
});

test("#9311: review-test-email roteia TODOS os achados de tamanho como info:, nunca email: (blocker do fix loop)", () => {
  const md = readFileSync(join(import.meta.dirname, "..", ".claude", "agents", "review-test-email.md"), "utf8");
  const sec = md.slice(md.indexOf("### 3f. Tamanho do e-mail ENTREGUE"), md.indexOf("### 3b. Image freshness"));
  assert.ok(sec.length > 0, "seção 3f não encontrada");
  assert.doesNotMatch(sec, /"email:delivered_size/, "achado de tamanho com prefixo email: dispara o fix loop do Stage 5");
  for (const cat of ["delivered_size_over_clip", "delivered_size_may_clip", "delivered_size_near_clip", "delivered_size_unmeasured"]) {
    assert.ok(sec.includes(`"info:${cat}`), `${cat} deveria mapear para info:`);
  }
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
  assert.ok(r.issues.some((i) => i.type === "info"), "fallback avisa que é estimativa por baixo");
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

test("#9278: mergeado, sem merged registrado ou sem publicação não gera bloqueio", () => {
  assert.equal(sitePageMergeBlocker({ published: true, merged: true }), null);
  assert.equal(sitePageMergeBlocker({ published: true, merged: undefined }), null);
  assert.equal(sitePageMergeBlocker({ published: false, merged: false }), null);
});

// #9326 — branch pushada sem PR identificado (gh pr create/list sem URL
// parseável) é o mesmo 404 no envio; antes devolvia null e o gate 6 ficava verde.
test("#9326: published + merged:false SEM prUrl também bloqueia, apontando a branch", () => {
  const msg = sitePageMergeBlocker({
    published: true,
    merged: false,
    mergeReason: "sem prNumber — nada a mergear",
    slug: "abc",
  });
  assert.ok(msg);
  assert.match(msg!, /BLOQUEIO/);
  assert.match(msg!, /não identificado/);
  assert.match(msg!, /site-publish\/abc/);
  assert.match(msg!, /06:00/);
  assert.match(msg!, /\/p\/abc/);
});

test("#9326: writeSitePageState persiste mergeBlocker mesmo sem prUrl", () => {
  const dir = mkdtempSync(join(tmpdir(), "site-9326-"));
  writeSitePageState(dir, {
    code: 0,
    slug: "abc",
    bytes: 1,
    published: true,
    merged: false,
    mergeReason: "sem prNumber — nada a mergear",
  } as Parameters<typeof writeSitePageState>[1]);
  const st = JSON.parse(readFileSync(join(dir, "_internal", "site-page-published.json"), "utf8"));
  assert.match(st.mergeBlocker, /site-publish\/abc/);
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
