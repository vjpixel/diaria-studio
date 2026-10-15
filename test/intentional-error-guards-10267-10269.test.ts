/**
 * Regressões de #10267 (record-kit-review: placeholder/no_error/JSON ilegível/
 * decode de entidades) e #10269 (propose-intentional-error-candidate:
 * `--list-recent`/`--check-wrong` não podem tratar JSONL ilegível como vazio).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildKitReviewRecord,
  checkIntentionalErrorInEmail,
  normalizeEmailText,
} from "../scripts/lib/kit-review-record.ts";
import { checkEditionEmail } from "../scripts/record-kit-review.ts";
import { isIntentionalErrorPlaceholder } from "../scripts/lib/intentional-errors.ts";
import { main as proposeMain } from "../scripts/propose-intentional-error-candidate.ts";

function editionWith(ie: string | null, email: string | null): { dir: string; emailFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "kit-10267-"));
  mkdirSync(join(dir, "_internal"));
  if (ie !== null) writeFileSync(join(dir, "_internal", "intentional-error.json"), ie);
  const emailFile = join(dir, "_internal", ".email-body.tmp");
  if (email !== null) writeFileSync(emailFile, email);
  return { dir, emailFile };
}

describe("#10267 placeholder e no_error não viram gabarito", () => {
  it("isIntentionalErrorPlaceholder reconhece {PREENCHER...}", () => {
    assert.equal(isIntentionalErrorPlaceholder("{PREENCHER}"), true);
    assert.equal(isIntentionalErrorPlaceholder("  {preencher: grafia errada}"), true);
    assert.equal(isIntentionalErrorPlaceholder("Unibanko"), false);
  });

  it("wrong_value placeholder → no_wrong_value, e status ok é aceito", () => {
    const check = checkIntentionalErrorInEmail("<p>O Unibanco abriu</p>", "{PREENCHER}");
    assert.equal(check, "no_wrong_value");
    assert.doesNotThrow(() => buildKitReviewRecord({ status: "ok", intentionalErrorCheck: check }));
  });

  it("cenário real: JSON do Stage 2 ainda com placeholder → record ok gravável", () => {
    const { dir, emailFile } = editionWith(
      JSON.stringify({ description: "{PREENCHER}", wrong_value: "{PREENCHER}", correct_value: "{PREENCHER}" }),
      "<p>O Unibanco abriu</p>",
    );
    const r = checkEditionEmail(dir, emailFile);
    assert.equal(r.check, "no_wrong_value");
    assert.deepEqual(r.warnings, []);
  });

  it("no_error: true com wrong_value residual → no_wrong_value (não missing)", () => {
    const { dir, emailFile } = editionWith(
      JSON.stringify({ no_error: true, wrong_value: "Unibanko" }),
      "<p>O Unibanco abriu</p>",
    );
    const r = checkEditionEmail(dir, emailFile);
    assert.equal(r.check, "no_wrong_value");
    assert.doesNotThrow(() => buildKitReviewRecord({ status: "ok", intentionalErrorCheck: r.check }));
  });

  it("wrong_value real ausente do e-mail continua missing (guard do #10243 intacto)", () => {
    const { dir, emailFile } = editionWith(JSON.stringify({ wrong_value: "Unibanko" }), "<p>O Unibanco abriu</p>");
    assert.equal(checkEditionEmail(dir, emailFile).check, "missing");
  });
});

describe("#10267 falha de leitura não desliga a checagem em silêncio", () => {
  it("intentional-error.json malformado → warning", () => {
    const { dir, emailFile } = editionWith("{ não é json", "<p>Unibanko</p>");
    const r = checkEditionEmail(dir, emailFile);
    assert.equal(r.check, "no_wrong_value");
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /intentional-error\.json ilegível/);
  });

  it("intentional-error.json que não é objeto → warning", () => {
    const { dir, emailFile } = editionWith("[1,2]", "<p>Unibanko</p>");
    assert.match(checkEditionEmail(dir, emailFile).warnings[0] ?? "", /ilegível/);
  });

  it("--email-file inexistente → warning", () => {
    const { dir, emailFile } = editionWith(JSON.stringify({ wrong_value: "Unibanko" }), null);
    const r = checkEditionEmail(dir, emailFile);
    assert.equal(r.check, "no_email");
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /--email-file .* não existe/);
  });

  it("intentional-error.json ausente não é warning (sem gabarito declarado)", () => {
    const { dir, emailFile } = editionWith(null, "<p>x</p>");
    assert.deepEqual(checkEditionEmail(dir, emailFile), { check: "no_wrong_value", warnings: [] });
  });
});

describe("#10267 decode de entidades", () => {
  it("entidade numérica fora do intervalo Unicode não lança", () => {
    assert.doesNotThrow(() => normalizeEmailText("a &#99999999; b &#x110000; c"));
    assert.equal(normalizeEmailText("a &#99999999; b"), "a &#99999999; b");
  });

  it("entidades acentuadas nomeadas casam com wrong_value acentuado", () => {
    assert.equal(normalizeEmailText("Ita&uacute; &ccedil;&atilde;o &Aacute;"), "Itaú ção Á");
    assert.equal(checkIntentionalErrorInEmail("<p>Funda&ccedil;&atilde;o Unibank&otilde;</p>", "Fundação Unibankõ"), "present");
  });

  it("entidade desconhecida fica como está", () => {
    assert.equal(normalizeEmailText("&foobar;"), "&foobar;");
  });
});

describe("#10269 --list-recent/--check-wrong com JSONL ilegível", () => {
  function run(argv: string[]): { code: number; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const ol = console.log;
    const oe = console.error;
    console.log = (m: string) => out.push(m);
    console.error = (m: string) => err.push(m);
    try {
      return { code: proposeMain(argv), out, err };
    } finally {
      console.log = ol;
      console.error = oe;
    }
  }

  it("JSONL existente mas ilegível (EISDIR) → exit 1, nunca {repeats: []}", () => {
    const dir = mkdtempSync(join(tmpdir(), "ie-10269-"));
    const jsonl = join(dir, "h.jsonl");
    mkdirSync(jsonl); // existe, mas readFileSync lança — análogo ao lock do OneDrive
    const r = run(["--edition", "260930", "--jsonl", jsonl, "--check-wrong", "Anthropik"]);
    assert.equal(r.code, 1);
    assert.equal(r.out.length, 0);
    assert.ok(r.err.some((l) => /não pôde ser lido/.test(l)));
    assert.equal(run(["--edition", "260930", "--jsonl", jsonl, "--list-recent"]).code, 1);
  });

  it("JSONL inteiramente corrompido → exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "ie-10269b-"));
    const jsonl = join(dir, "h.jsonl");
    writeFileSync(jsonl, "{corrompido\nlixo\n");
    const r = run(["--edition", "260930", "--jsonl", jsonl, "--check-wrong", "Anthropik"]);
    assert.equal(r.code, 1);
    assert.equal(r.out.length, 0);
  });

  it("JSONL com uma linha corrompida entre válidas → exit 0 + warning, repetição ainda detectada", () => {
    const dir = mkdtempSync(join(tmpdir(), "ie-10269c-"));
    const jsonl = join(dir, "h.jsonl");
    writeFileSync(
      jsonl,
      JSON.stringify({ edition: "260928", wrong_value: "Anthropik", correct_value: "Anthropic", description: "x" }) +
        "\n{corrompido\n",
    );
    const r = run(["--edition", "260930", "--jsonl", jsonl, "--check-wrong", "Anthropik"]);
    assert.equal(r.code, 0);
    assert.ok(r.err.some((l) => /WARN 1 linha/.test(l)));
    assert.equal(JSON.parse(r.out[0]).repeats[0].edition, "260928");
  });

  it("JSONL ausente segue sendo histórico vazio (exit 0)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ie-10269d-"));
    const r = run(["--edition", "260930", "--jsonl", join(dir, "nao-existe.jsonl"), "--check-wrong", "Anthropik"]);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out[0]).repeats, []);
  });
});
