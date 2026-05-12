/**
 * line-endings.test.ts (#1132 P3.6)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLF,
  toCRLF,
  detectLineEnding,
  ensureLF,
} from "../scripts/lib/line-endings.ts";

describe("normalizeLF (#1132 P3.6)", () => {
  it("converte CRLF pra LF", () => {
    assert.equal(normalizeLF("a\r\nb\r\nc"), "a\nb\nc");
  });

  it("converte CR isolado pra LF (macOS clássico)", () => {
    assert.equal(normalizeLF("a\rb\rc"), "a\nb\nc");
  });

  it("preserva LF existente", () => {
    assert.equal(normalizeLF("a\nb\nc"), "a\nb\nc");
  });

  it("string vazia → string vazia", () => {
    assert.equal(normalizeLF(""), "");
  });

  it("string sem newlines → idêntica", () => {
    assert.equal(normalizeLF("singleline"), "singleline");
  });

  it("idempotente (aplicar 2× = mesmo resultado)", () => {
    const input = "mixed\r\nlines\nhere\r";
    const once = normalizeLF(input);
    const twice = normalizeLF(once);
    assert.equal(once, twice);
  });

  it("mixed CRLF + LF normaliza tudo pra LF", () => {
    assert.equal(normalizeLF("a\r\nb\nc\r\nd"), "a\nb\nc\nd");
  });
});

describe("toCRLF (#1132 P3.6)", () => {
  it("LF → CRLF", () => {
    assert.equal(toCRLF("a\nb"), "a\r\nb");
  });

  it("CRLF existente → CRLF (sem dups)", () => {
    assert.equal(toCRLF("a\r\nb"), "a\r\nb");
  });

  it("idempotente", () => {
    const input = "a\r\nb\nc";
    const once = toCRLF(input);
    const twice = toCRLF(once);
    assert.equal(once, twice);
  });
});

describe("detectLineEnding (#1132 P3.6)", () => {
  it("LF puro", () => {
    assert.equal(detectLineEnding("a\nb\nc"), "lf");
  });

  it("CRLF puro", () => {
    assert.equal(detectLineEnding("a\r\nb\r\nc"), "crlf");
  });

  it("mixed", () => {
    assert.equal(detectLineEnding("a\r\nb\nc"), "mixed");
  });

  it("string sem newline", () => {
    assert.equal(detectLineEnding("single line"), "none");
  });

  it("string vazia", () => {
    assert.equal(detectLineEnding(""), "none");
  });
});

describe("ensureLF (#1132 P3.6 — alias de normalizeLF pra clareza semântica em writers)", () => {
  it("converte CRLF pra LF antes de write", () => {
    assert.equal(ensureLF("a\r\nb\r\n"), "a\nb\n");
  });
});
