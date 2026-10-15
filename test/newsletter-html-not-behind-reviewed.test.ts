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
import {
  runStage4PostEditChecks,
  HTML_FRESHNESS_RULE_ID,
  SWEEP_SKIPPED_RULE_IDS,
} from "../scripts/lib/stage4-post-edit-checks-core.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";

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

  // #10261: o sweep em background (stage4-post-edit-checks.ts) roda logo após
  // o Edit do reviewed, antes do re-render. Se ele acusasse esta regra, o
  // relatório (identificado só pelo hash de reviewed+social) ficava com
  // gate_blocking pendente mesmo depois do re-render e travava o `sim`.
  it("#10261: edit → sweep (HTML velho) → re-render → sweep não deixa bloqueio desta regra; sentinel segue recusando HTML defasado", () => {
    const projectRoot = join(import.meta.dirname, "..");
    const d = edition();
    // Estado inicial: reviewed renderizado.
    put(d, "02-reviewed.md", "texto original", T0);
    writeRenderSourceStamp(d);
    utimesSync(join(d, RENDER_SOURCE_STAMP), T0, T0);
    put(d, HTML, "<p>texto original</p>", T0);

    // 1. Edit do editor no gate — HTML fica para trás até o re-render.
    put(d, "02-reviewed.md", "texto com uma palavra trocada", T0 + 600);

    // 2. Sweep em background dispara AGORA (HTML ainda velho).
    const during = runStage4PostEditChecks(d, projectRoot);
    assert.ok(
      !during.findings.some((f) => f.id === RULE),
      `sweep não deveria acusar ${RULE} no meio do re-render: ${JSON.stringify(during.findings.filter((f) => f.id === RULE))}`,
    );
    assert.ok(during.checks_run.includes("invariants:stage-4"), "o item 5 (invariantes) precisa ter rodado");

    // ...mas o sentinel, que lê o estado final, recusa enquanto o HTML estiver defasado.
    const sentinelStale = checkStageInvariantsForWrite(d, 4);
    assert.equal(sentinelStale.passed, false);
    assert.ok(sentinelStale.errors.some((e) => e.rule === RULE), "sentinel deveria recusar HTML defasado (#10258)");

    // 3. Re-render: carimbo com o sha novo + HTML regravado depois do reviewed.
    writeRenderSourceStamp(d);
    utimesSync(join(d, RENDER_SOURCE_STAMP), T0 + 660, T0 + 660);
    put(d, HTML, "<p>texto com uma palavra trocada</p>", T0 + 660);

    // 4. Sweep pós-render e sentinel: nenhum bloqueio desta regra.
    const afterRender = runStage4PostEditChecks(d, projectRoot);
    assert.ok(!afterRender.findings.some((f) => f.id === RULE));
    const sentinelFresh = checkStageInvariantsForWrite(d, 4);
    assert.ok(!sentinelFresh.errors.some((e) => e.rule === RULE));
  });

  it("#10261: a regra pulada no sweep segue no registry do Stage 4 (quem impõe é o sentinel)", () => {
    assert.equal(HTML_FRESHNESS_RULE_ID, RULE);
    assert.ok(SWEEP_SKIPPED_RULE_IDS.has(RULE));
    assert.ok(getRulesForStage(4).some((r) => r.id === RULE));
  });
});
