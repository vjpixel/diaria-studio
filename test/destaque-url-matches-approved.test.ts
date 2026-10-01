/**
 * #9252 — regressão: writer-destaque headless emitiu URL inventada (faltava
 * `/gemini-models/`) e nenhum lint de Stage 2 pegou. O check compara a URL de
 * cada destaque com `highlights[N-1].article.url` do approved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDestaqueUrlMatchesApproved } from "../scripts/lib/lint-checks/destaque-url-matches-approved.ts";
import { runStage2LintReport } from "../scripts/lint-newsletter-md.ts";

const REAL = "https://blog.google/technology/google-deepmind/gemini-models/argon/";
const INVENTED = "https://blog.google/technology/google-deepmind/argon/";
const D2 = "https://example.com/d2-real";

function md(d1Url: string, d2Url: string = D2): string {
  return [
    "DESTAQUE 1 | LANÇAMENTO",
    "",
    `[Google lança o Argon](${d1Url})`,
    "",
    "Corpo do destaque um.",
    "",
    "Por que isso importa:",
    "",
    "Porque sim.",
    "",
    "---",
    "",
    "DESTAQUE 2 | NOTÍCIA",
    "",
    `[Outro destaque](${d2Url})`,
    "",
    "Corpo do destaque dois.",
    "",
    "Por que isso importa:",
    "",
    "Porque também.",
    "",
  ].join("\n");
}

const approved = {
  highlights: [{ article: { url: REAL } }, { url: D2 }],
};

describe("checkDestaqueUrlMatchesApproved (#9252)", () => {
  it("URLs idênticas ao approved → ok", () => {
    const r = checkDestaqueUrlMatchesApproved(md(REAL), approved);
    assert.deepEqual(r, { ok: true, errors: [] });
  });

  it("cenário real 261001: URL inventada no D1 → url_mismatch bloqueia", () => {
    const r = checkDestaqueUrlMatchesApproved(md(INVENTED), approved);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.deepEqual(r.errors[0], {
      destaque: 1,
      type: "url_mismatch",
      found: INVENTED,
      expected: REAL,
    });
  });

  it("ignora só o fragmento; trailing slash e query continuam semânticos", () => {
    assert.equal(checkDestaqueUrlMatchesApproved(md(`${REAL}#amp`), approved).ok, true);
    assert.equal(checkDestaqueUrlMatchesApproved(md(REAL.replace(/\/$/, "")), approved).ok, false);
    assert.equal(checkDestaqueUrlMatchesApproved(md(`${REAL}?x=1`), approved).ok, false);
  });

  it("destaque sem highlight correspondente no approved → no_approved_highlight", () => {
    const r = checkDestaqueUrlMatchesApproved(md(REAL), { highlights: [{ article: { url: REAL } }] });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].destaque, 2);
    assert.equal(r.errors[0].type, "no_approved_highlight");
  });

  it("agregador --stage 2 inclui o check como gate-blocking e reprova a URL inventada", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-9252-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "02-draft.md"), md(INVENTED));
      writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(approved));
      const report = runStage2LintReport(dir, process.cwd());
      const c = report.checks.find((x) => x.id === "destaque-url-matches-approved");
      assert.ok(c, "check presente no relatório do Stage 2");
      assert.equal(c.severity, "gate-blocking");
      assert.equal(c.ok, false);
      assert.equal(report.passed, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
