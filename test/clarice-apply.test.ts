import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countOccurrences,
  applyClariceSuggestions,
} from "../scripts/clarice-apply.ts";

describe("countOccurrences", () => {
  it("conta substring exata", () => {
    assert.equal(countOccurrences("manter empregabilidade", "manter"), 1);
  });

  it("conta múltiplas ocorrências", () => {
    assert.equal(countOccurrences("e isso e aquilo e tal", "e"), 3);
  });

  it("conta zero quando não encontra", () => {
    assert.equal(countOccurrences("texto qualquer", "ausente"), 0);
  });

  it("needle vazio retorna 0", () => {
    assert.equal(countOccurrences("texto", ""), 0);
  });

  it("não conta sobreposição (avança por needle.length)", () => {
    // "aaa" tem 3 ocorrências de "a", mas só 1 de "aa" sem sobreposição (pos 0, depois pos 2 não bate)
    assert.equal(countOccurrences("aaa", "aa"), 1);
  });

  it("case-sensitive", () => {
    assert.equal(countOccurrences("Manter manter MANTER", "manter"), 1);
  });
});

describe("applyClariceSuggestions", () => {
  it("aplica sugestão única com count=1", () => {
    const r = applyClariceSuggestions(
      "Para manter empregabilidade no futuro.",
      [{ from: "manter", to: "manter a" }],
    );
    assert.equal(r.patched, "Para manter a empregabilidade no futuro.");
    assert.equal(r.applied.length, 1);
    assert.equal(r.skipped.length, 0);
  });

  it("skipa sugestão ambígua (count>1)", () => {
    const r = applyClariceSuggestions(
      "mais e mais e mais coisas",
      [{ from: "mais", to: "" }],
    );
    assert.equal(r.patched, "mais e mais e mais coisas");
    assert.equal(r.applied.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].reason, "ambiguous");
    assert.equal(r.skipped[0].count, 3);
  });

  it("skipa sugestão not_found (count=0)", () => {
    const r = applyClariceSuggestions(
      "texto sem a palavra alvo",
      [{ from: "ausente", to: "presente" }],
    );
    assert.equal(r.patched, "texto sem a palavra alvo");
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].reason, "not_found");
    assert.equal(r.skipped[0].count, 0);
  });

  it("skipa from vazio com reason=empty_from", () => {
    const r = applyClariceSuggestions("texto", [
      { from: "", to: "X" },
      { from: "   ", to: "Y" },
    ]);
    assert.equal(r.patched, "texto");
    assert.equal(r.skipped.length, 2);
    assert.equal(r.skipped[0].reason, "empty_from");
    assert.equal(r.skipped[1].reason, "empty_from");
  });

  it("aplica multiple unambiguous + skipa ambíguas", () => {
    const text = "Para manter empregabilidade. O impacto sobre empregabilidade é grande. Mais e mais.";
    const r = applyClariceSuggestions(text, [
      { from: "manter", to: "manter a" },
      { from: "sobre", to: "sobre a" },
      { from: "Mais", to: "" }, // count=1, applies
      { from: "mais", to: "" }, // count=1 in patched after Mais removed... wait
    ]);
    // Trace: original has "manter" 1x, "sobre" 1x, "Mais" 1x, "mais" 1x
    // After applies: "Para manter a empregabilidade. O impacto sobre a empregabilidade é grande.  e ."
    // Actually let me think more carefully — "manter a empregabilidade" still has "manter" in it
    // After "manter" → "manter a": text has "manter a empregabilidade". "manter" still appears (count=1).
    // After "sobre" → "sobre a": "sobre a empregabilidade".
    // After "Mais" → "": " e mais." remaining. "Mais" gone.
    // After "mais" → "":  removed.
    // 4 applied, 0 skipped.
    assert.equal(r.applied.length, 4);
    assert.equal(r.skipped.length, 0);
    assert.equal(
      r.patched,
      "Para manter a empregabilidade. O impacto sobre a empregabilidade é grande.  e .",
    );
  });

  it("array vazio retorna texto inalterado", () => {
    const r = applyClariceSuggestions("texto", []);
    assert.equal(r.patched, "texto");
    assert.equal(r.applied.length, 0);
    assert.equal(r.skipped.length, 0);
  });

  it("preserva metadados da sugestão (rule, explanation) no skipped", () => {
    const r = applyClariceSuggestions("a a a", [
      {
        from: "a",
        to: "o",
        rule: "test rule",
        explanation: "test explanation",
      },
    ]);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].rule, "test rule");
    assert.equal(r.skipped[0].explanation, "test explanation");
    assert.equal(r.skipped[0].reason, "ambiguous");
  });

  it("não interpreta $ patterns no replacement (function-form)", () => {
    // String.replace(string, string) interpreta $&/$1/$`/$' como special
    // patterns. Helper usa function-form pra preservar literal.
    const r = applyClariceSuggestions("foo bar", [
      { from: "foo", to: "x$&y" },
    ]);
    assert.equal(r.patched, "x$&y bar");
  });

  it("preserva $1 literal no replacement", () => {
    const r = applyClariceSuggestions("foo bar", [
      { from: "foo", to: "captured: $1" },
    ]);
    assert.equal(r.patched, "captured: $1 bar");
  });

  it("smoke real (replicando caso do PR #211)", () => {
    // Caso descoberto no smoke do diaria-3-social
    const text = "para manter empregabilidade quem ainda avalia adoção e mais e mais";
    const r = applyClariceSuggestions(text, [
      { from: "manter", to: "manter a" },
      { from: "avalia", to: "avalia a" },
      { from: "mais", to: "" }, // ambíguo no original
      { from: "e", to: "e a" }, // ambíguo
    ]);
    // 2 unambíguas aplicadas, 2 ambíguas skipadas
    assert.equal(r.applied.length, 2);
    assert.equal(r.skipped.length, 2);
    assert.deepEqual(
      r.skipped.map((s) => s.reason).sort(),
      ["ambiguous", "ambiguous"],
    );
  });
});

describe("clarice-apply CLI (#224)", () => {
  it("aplica sugestão e emite report JSON no stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-cli-"));
    writeFileSync(join(dir, "text.md"), "Para manter empregabilidade.");
    writeFileSync(join(dir, "sugs.json"), JSON.stringify([
      { from: "manter", to: "manter a" },
    ]));
    const result = spawnSync(process.execPath, [
      "--import", "tsx",
      "scripts/clarice-apply.ts",
      "--text-file", join(dir, "text.md"),
      "--suggestions", join(dir, "sugs.json"),
      "--out", join(dir, "out.md"),
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `process exited with ${result.status}: ${result.stderr}`);
    const out = readFileSync(join(dir, "out.md"), "utf8");
    assert.ok(out.includes("manter a empregabilidade"));
    // stderr deve ser JSON com campo "applied"
    const report = JSON.parse(result.stderr);
    assert.ok(typeof report.applied === "number");
  });
});
