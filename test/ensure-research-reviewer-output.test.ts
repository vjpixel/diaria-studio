/**
 * test/ensure-research-reviewer-output.test.ts (#1273)
 *
 * Cobertura do enforcement runtime de out_path do research-reviewer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  ensureResearchReviewerOutput,
  alternativePathsFor,
  KNOWN_ALTERNATIVE_NAMES,
} from "../scripts/ensure-research-reviewer-output.ts";

describe("alternativePathsFor", () => {
  it("retorna paths irmãos do canônico com nomes conhecidos", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ensure-rr-alts-"));
    const canonical = resolve(dir, "tmp-reviewer-output.json");
    const alts = alternativePathsFor(canonical);
    assert.equal(alts.length, KNOWN_ALTERNATIVE_NAMES.length);
    for (const alt of alts) {
      // alt deve estar no mesmo dir que canonical
      assert.ok(alt.startsWith(dir), `${alt} should start with ${dir}`);
      assert.ok(KNOWN_ALTERNATIVE_NAMES.some((n) => alt.endsWith(n)));
    }
  });
});

describe("ensureResearchReviewerOutput", () => {
  it("retorna 'ok' quando arquivo canônico existe", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ensure-rr-"));
    const canonical = resolve(dir, "tmp-reviewer-output.json");
    writeFileSync(canonical, '{"categorized":{}}', "utf8");

    const r = ensureResearchReviewerOutput(canonical);
    assert.equal(r.action, "ok");
    assert.equal(r.canonical, canonical);
  });

  it("renomeia de tmp-reviewed.json (caso real #1271) pro canônico", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ensure-rr-"));
    const canonical = resolve(dir, "tmp-reviewer-output.json");
    const alt = resolve(dir, "tmp-reviewed.json");
    writeFileSync(alt, '{"categorized":{}}', "utf8");

    const r = ensureResearchReviewerOutput(canonical);
    assert.equal(r.action, "renamed_from");
    if (r.action === "renamed_from") {
      assert.equal(r.source, alt);
    }
    assert.ok(existsSync(canonical));
    assert.ok(!existsSync(alt));
  });

  it("renomeia de qualquer path alternativo conhecido", () => {
    for (const altName of KNOWN_ALTERNATIVE_NAMES) {
      const dir = mkdtempSync(resolve(tmpdir(), "ensure-rr-"));
      const canonical = resolve(dir, "tmp-reviewer-output.json");
      const alt = resolve(dir, altName);
      writeFileSync(alt, '{"x":1}', "utf8");

      const r = ensureResearchReviewerOutput(canonical);
      if (altName === "tmp-reviewer-output.json") {
        assert.equal(r.action, "ok", `${altName} é o canônico`);
      } else {
        assert.equal(r.action, "renamed_from", `${altName} → canônico`);
      }
      assert.ok(existsSync(canonical));
    }
  });

  it("retorna 'missing' quando nenhum arquivo existe", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ensure-rr-"));
    const canonical = resolve(dir, "tmp-reviewer-output.json");

    const r = ensureResearchReviewerOutput(canonical);
    assert.equal(r.action, "missing");
    if (r.action === "missing") {
      assert.equal(r.checked.length, KNOWN_ALTERNATIVE_NAMES.length);
    }
  });

  it("aceita injeção de fileExists/rename pra teste puro", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ensure-rr-inj-"));
    const canonical = resolve(dir, "canonical.json");
    const altPath = resolve(dir, "tmp-reviewed.json");
    let renamed: { from: string; to: string } | null = null;
    const r = ensureResearchReviewerOutput(canonical, {
      fileExists: (p) => p === altPath,
      rename: (from, to) => {
        renamed = { from, to };
      },
    });
    assert.equal(r.action, "renamed_from");
    if (r.action === "renamed_from") {
      assert.equal(r.source, altPath);
    }
    assert.deepEqual(renamed, { from: altPath, to: canonical });
  });

  it("prioriza canônico se ele E alternativo existirem", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ensure-rr-prio-"));
    const canonical = resolve(dir, "canonical.json");
    const altPath = resolve(dir, "tmp-reviewed.json");
    let renamed = false;
    const r = ensureResearchReviewerOutput(canonical, {
      fileExists: (p) => p === canonical || p === altPath,
      rename: () => {
        renamed = true;
      },
    });
    assert.equal(r.action, "ok");
    assert.equal(renamed, false, "não renomeou — canônico já existia");
  });
});
