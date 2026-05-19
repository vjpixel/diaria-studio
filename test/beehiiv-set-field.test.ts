/**
 * test/beehiiv-set-field.test.ts (#1423)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSetFieldJs, isFieldVerified } from "../scripts/lib/beehiiv-set-field.ts";

describe("buildSetFieldJs (#1423)", () => {
  it("encoda field name + value como JSON strings (escape seguro)", () => {
    const js = buildSetFieldJs("post-title", `Google I/O: "Gemini 3.5" lança hoje`);
    // Selector é JSON-encoded — aspas internas viram \\"
    assert.match(js, /textarea\[name=\\"post-title\\"\]/);
    // Value JSON-encoded com aspas escapadas
    assert.match(js, /"Google I\/O: \\"Gemini 3\.5\\" lança hoje"/);
    // Sequência atômica: focus → select → delete → insertText → blur
    assert.match(js, /el\.focus\(\)/);
    assert.match(js, /el\.select\(\)/);
    assert.match(js, /execCommand\('delete'\)/);
    assert.match(js, /execCommand\('insertText'/);
    assert.match(js, /el\.blur\(\)/);
  });

  it("subtitle field gera selector correto", () => {
    const js = buildSetFieldJs("post-subtitle", "Sub");
    assert.match(js, /textarea\[name=\\"post-subtitle\\"\]/);
  });

  it("#1423: ordem importa — delete ANTES de insertText", () => {
    const js = buildSetFieldJs("post-title", "X");
    const deleteIdx = js.indexOf("delete");
    const insertIdx = js.indexOf("insertText");
    assert.ok(deleteIdx < insertIdx, "delete deve vir antes de insertText pra não concatenar");
  });

  it("blur depois do insertText (trigger autosave)", () => {
    const js = buildSetFieldJs("post-title", "X");
    const insertIdx = js.indexOf("insertText");
    const blurIdx = js.indexOf("blur()");
    assert.ok(insertIdx < blurIdx, "blur depois pra trigar autosave");
  });
});

describe("isFieldVerified (#1423)", () => {
  it("true quando valores idênticos", () => {
    assert.equal(isFieldVerified("title X", "title X"), true);
  });

  it("true ignorando trailing whitespace", () => {
    assert.equal(isFieldVerified("title X ", "title X"), true);
    assert.equal(isFieldVerified("  title X  ", "title X"), true);
  });

  it("false quando valores diferentes (case-sensitive)", () => {
    assert.equal(isFieldVerified("Title X", "title X"), false);
    assert.equal(isFieldVerified("different", "title X"), false);
  });

  it("#1423: false quando duplicado (bug original — insertText concatenado)", () => {
    const expected = "Google I/O: Gemini 3.5";
    const actual = "Google I/O: Gemini 3.5I/O: Gemini 3.5";
    assert.equal(isFieldVerified(actual, expected), false);
  });

  it("false quando actual é null/undefined", () => {
    assert.equal(isFieldVerified(null, "X"), false);
    assert.equal(isFieldVerified(undefined, "X"), false);
  });
});
