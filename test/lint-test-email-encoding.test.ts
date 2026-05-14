import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripHtmlToText,
  checkEncoding,
} from "../scripts/lint-test-email-encoding.ts";

describe("stripHtmlToText (#1248)", () => {
  it("remove tags + decoda entities", () => {
    const html = "<p>R$84&nbsp;mil &amp; outras</p>";
    const t = stripHtmlToText(html);
    assert.match(t, /R\$84\s+mil\s*&\s*outras/);
  });

  it("remove <style> e <script>", () => {
    const html = "<style>p {color:red}</style><p>texto</p><script>alert(1)</script>";
    const t = stripHtmlToText(html);
    assert.doesNotMatch(t, /color:red/);
    assert.doesNotMatch(t, /alert/);
    assert.match(t, /texto/);
  });

  it("decoda numeric entities", () => {
    const html = "<p>&#225;rea</p>"; // á = 0xE1 = 225
    assert.match(stripHtmlToText(html), /área/);
  });

  it("decoda hex entities", () => {
    const html = "<p>&#xE3;</p>"; // ã = 0xE3
    assert.match(stripHtmlToText(html), /ã/);
  });
});

describe("checkEncoding (#1248)", () => {
  it("retorna [] quando todos os chars especiais aparecem no email", () => {
    const source = "Cobertura de IA com ênfase técnica e ação";
    const email = "Cobertura de IA com ênfase técnica e ação";
    assert.deepEqual(checkEncoding(source, email), []);
  });

  it("char_dropped quando char não aparece nem com substituto", () => {
    const source = "emoji 🎉 importante";
    const email = "emoji importante"; // emoji removido sem substituto
    const r = checkEncoding(source, email);
    assert.equal(r.length, 1);
    assert.equal(r[0].type, "char_dropped");
    assert.equal(r[0].char, "🎉");
  });

  it("char_substituted quando ASCII fallback presente", () => {
    const source = "publicação";
    const email = "publicacao"; // ç → c, ã → a
    const r = checkEncoding(source, email);
    // 2 substituições detectadas (ç→c, ã→a)
    assert.ok(r.length >= 1);
    for (const i of r) {
      assert.equal(i.type, "char_substituted");
      assert.ok(i.email_substitute);
    }
  });

  it("detecta drop de aspas tipográficas → ASCII", () => {
    const source = "ele disse “isso aqui”"; // smart quotes
    const email = 'ele disse "isso aqui"'; // ASCII quotes
    const r = checkEncoding(source, email);
    // pelo menos 1 char_substituted (smart quote → ASCII)
    assert.ok(r.length > 0);
  });

  it("contexto inclui ~20 chars antes/depois", () => {
    const source = "início aqui texto longo antes do char especial é aqui texto depois";
    const email = "inicio aqui texto longo antes do char especial e aqui texto depois";
    const r = checkEncoding(source, email);
    for (const i of r) {
      assert.ok(i.source_context.length > 0);
      assert.ok(i.source_context.length < 60);
    }
  });

  it("retorna codepoint hex no formato U+XXXX", () => {
    const source = "ação";
    const email = "acao";
    const r = checkEncoding(source, email);
    for (const i of r) {
      assert.match(i.codepoint, /^U\+[0-9A-F]{4,}$/);
    }
  });
});
