import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNewsletterHtmlNotBehindReviewed } from "../scripts/lib/invariant-checks/stage-4.ts";
import {
  evaluateNewsletterHtmlFreshness,
  sha256OfFileOrNull,
  writeRenderSourceStamp,
  RENDER_SOURCE_STAMP,
} from "../scripts/lib/newsletter-html-freshness.ts";
import { checkStageInvariantsForWrite } from "../scripts/pipeline-sentinel.ts";

const HTML = "_internal/newsletter-final.html";
const RULE = "newsletter-html-not-behind-reviewed";
const T0 = 1_700_000_000; // segundos

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function edition(): string {
  const d = mkdtempSync(join(tmpdir(), "html-fresh-10258-"));
  dirs.push(d);
  mkdirSync(join(d, "_internal"), { recursive: true });
  return d;
}

function put(dir: string, rel: string, content: string, mtimeSec: number): void {
  writeFileSync(join(dir, rel), content);
  utimesSync(join(dir, rel), mtimeSec, mtimeSec);
}

describe("evaluateNewsletterHtmlFreshness (#10258) — pura", () => {
  const base = { reviewedSha256: "aaa", stamp: null };
  it("HTML mais novo que o reviewed → fresco (fluxo normal: render depois do reviewed)", () => {
    assert.equal(evaluateNewsletterHtmlFreshness({ ...base, htmlMtimeMs: 3e6, reviewedMtimeMs: 2e6 }).stale, false);
  });
  it("diferença dentro da tolerância de 1s → fresco", () => {
    assert.equal(evaluateNewsletterHtmlFreshness({ ...base, htmlMtimeMs: 2e6, reviewedMtimeMs: 2e6 + 900 }).stale, false);
  });
  it("HTML ausente → não acusa", () => {
    assert.equal(evaluateNewsletterHtmlFreshness({ ...base, htmlMtimeMs: null, reviewedMtimeMs: 2e6 }).stale, false);
  });
  it("HTML antigo sem carimbo → defasado", () => {
    const r = evaluateNewsletterHtmlFreshness({ ...base, htmlMtimeMs: 1e6, reviewedMtimeMs: 2e6 });
    assert.deepEqual([r.stale, r.reason], [true, "no-stamp"]);
  });
  it("HTML antigo, carimbo com o sha atual e anterior ao HTML → fresco (reviewed só tocado)", () => {
    const r = evaluateNewsletterHtmlFreshness({
      htmlMtimeMs: 1e6, reviewedMtimeMs: 2e6, reviewedSha256: "aaa", stamp: { reviewed_sha256: "aaa", mtimeMs: 1e6 },
    });
    assert.deepEqual([r.stale, r.reason], [false, "stamp-matches"]);
  });
  it("HTML antigo, carimbo com sha diferente → defasado (replant mudou o texto)", () => {
    const r = evaluateNewsletterHtmlFreshness({
      htmlMtimeMs: 1e6, reviewedMtimeMs: 2e6, reviewedSha256: "bbb", stamp: { reviewed_sha256: "aaa", mtimeMs: 1e6 },
    });
    assert.deepEqual([r.stale, r.reason], [true, "stamp-mismatch"]);
  });
  it("carimbo mais novo que o HTML (re-render só do draft, sem substitute) → defasado mesmo com sha igual", () => {
    const r = evaluateNewsletterHtmlFreshness({
      htmlMtimeMs: 1e6, reviewedMtimeMs: 2e6, reviewedSha256: "aaa", stamp: { reviewed_sha256: "aaa", mtimeMs: 2e6 },
    });
    assert.deepEqual([r.stale, r.reason], [true, "stamp-newer-than-html"]);
  });
});

describe("checkNewsletterHtmlNotBehindReviewed (#10245/#10258) — disco", () => {
  it("replant regravou o reviewed depois do HTML → error", () => {
    const d = edition();
    put(d, "02-reviewed.md", "texto velho", T0);
    writeRenderSourceStamp(d);
    utimesSync(join(d, RENDER_SOURCE_STAMP), T0, T0);
    put(d, HTML, "<p>texto velho</p>", T0);
    put(d, "02-reviewed.md", "texto com erro replantado", T0 + 600);
    const v = checkNewsletterHtmlNotBehindReviewed(d);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
    assert.match(v[0].message, /conteúdo de 02-reviewed\.md mudou/);
  });
  it("reviewed tocado sem mudar conteúdo depois do render → sem violação", () => {
    const d = edition();
    put(d, "02-reviewed.md", "mesmo texto", T0);
    writeRenderSourceStamp(d);
    utimesSync(join(d, RENDER_SOURCE_STAMP), T0, T0);
    put(d, HTML, "<p>mesmo texto</p>", T0);
    put(d, "02-reviewed.md", "mesmo texto", T0 + 600);
    assert.deepEqual(checkNewsletterHtmlNotBehindReviewed(d), []);
  });
  it("carimbo grava o sha256 do reviewed", () => {
    const d = edition();
    put(d, "02-reviewed.md", "abc", T0);
    writeRenderSourceStamp(d);
    const stamp = JSON.parse(readFileSync(join(d, RENDER_SOURCE_STAMP), "utf8"));
    assert.equal(stamp.reviewed_sha256, sha256OfFileOrNull(join(d, "02-reviewed.md")));
  });
});

describe("pipeline-sentinel write --step 4 recusa HTML defasado (#10258)", () => {
  // KIT_API_KEY presente e vazia: o audit-kit-fixtures.ts spawnado pela regra
  // kit-fixture-audit não reidrata a credencial real do .env (#6387).
  const prevKit = process.env.KIT_API_KEY;
  process.env.KIT_API_KEY = "";
  after(() => {
    if (prevKit === undefined) delete process.env.KIT_API_KEY;
    else process.env.KIT_API_KEY = prevKit;
  });

  it("HTML anterior ao reviewed editado → erro desta regra entre os que bloqueiam o write", () => {
    const d = edition();
    put(d, HTML, "<p>velho</p>", T0);
    put(d, "02-reviewed.md", "novo", T0 + 600);
    const r = checkStageInvariantsForWrite(d, 4);
    assert.equal(r.passed, false);
    assert.ok(r.errors.some((e) => e.rule === RULE), "newsletter-html-not-behind-reviewed deveria bloquear o sentinel");
  });
  it("HTML renderizado depois do reviewed → esta regra não bloqueia", () => {
    const d = edition();
    put(d, "02-reviewed.md", "novo", T0);
    put(d, HTML, "<p>novo</p>", T0 + 60);
    const r = checkStageInvariantsForWrite(d, 4);
    assert.ok(!r.errors.some((e) => e.rule === RULE));
  });
});
