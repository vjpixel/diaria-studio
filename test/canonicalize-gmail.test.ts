/**
 * test/canonicalize-gmail.test.ts (#1969)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeGmail,
  gmailEquivalent,
  extractEmail,
} from "../scripts/lib/canonicalize-gmail.ts";

describe("canonicalizeGmail (#1969)", () => {
  it("Gmail: remove pontos do local-part", () => {
    assert.equal(canonicalizeGmail("diaria.editor@gmail.com"), "diariaeditor@gmail.com");
    assert.equal(canonicalizeGmail("d.i.a.r.i.a.editor@gmail.com"), "diariaeditor@gmail.com");
  });

  it("Gmail: descarta sufixo +tag", () => {
    assert.equal(canonicalizeGmail("diariaeditor+news@gmail.com"), "diariaeditor@gmail.com");
    assert.equal(canonicalizeGmail("diaria.editor+x.y@gmail.com"), "diariaeditor@gmail.com");
  });

  it("Gmail: lowercase + normaliza googlemail.com → gmail.com", () => {
    assert.equal(canonicalizeGmail("Diaria.Editor@GoogleMail.com"), "diariaeditor@gmail.com");
  });

  it("extrai e-mail de header 'Nome <email>'", () => {
    assert.equal(canonicalizeGmail('"Pixel" <diaria.editor@gmail.com>'), "diariaeditor@gmail.com");
    assert.equal(extractEmail('"Pixel" <vjpixel@gmail.com>'), "vjpixel@gmail.com");
  });

  it("não-Gmail: preserva pontos/+tag (significativos fora do Gmail)", () => {
    assert.equal(canonicalizeGmail("pixel@memelab.com.br"), "pixel@memelab.com.br");
    assert.equal(canonicalizeGmail("a.b+t@outlook.com"), "a.b+t@outlook.com");
  });

  it("gmailEquivalent: dot/+tag/case/googlemail são a mesma caixa", () => {
    assert.ok(gmailEquivalent("diariaeditor@gmail.com", "diaria.editor@gmail.com"));
    assert.ok(gmailEquivalent("diaria.editor+news@gmail.com", "DiariaEditor@googlemail.com"));
    assert.ok(!gmailEquivalent("diariaeditor@gmail.com", "outro@gmail.com"));
    // dot fora do Gmail NÃO é equivalente
    assert.ok(!gmailEquivalent("a.b@outlook.com", "ab@outlook.com"));
  });

  it("entrada degenerada não quebra (sem @)", () => {
    assert.equal(canonicalizeGmail("Pixel"), "pixel");
    assert.equal(canonicalizeGmail(""), "");
  });
});
