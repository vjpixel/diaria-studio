/**
 * stage-4-intentional-error-present-invariant-7243.test.ts (#7243, regressing #633)
 *
 * Teste de regressão pro invariant `intentional-error-present-in-final` (#7243):
 * o `wrong_value` (grafia errada plantada) DEVE existir em `02-reviewed.md`
 * até o Stage 4. Se foi silenciosamente removido durante a gate de revisão
 * (ex: editor fez pruning de RADAR e cortou o erro sem perceber), o registro
 * em `_internal/intentional-error.json` continua dizendo que um erro existe
 * quando na verdade não existe mais — o invariante faila.
 *
 * Cobertura (#633):
 *  1. wrong_value ausente de 02-reviewed.md → violation (error)
 *  2. wrong_value presente em 02-reviewed.md → sem violation
 *  3. no_error: true → sem violation (edição sem erro é estado legítimo, #2016)
 *  4. record ausente → sem violation (outros invariants cobrem)
 *  5. wrong_value é placeholder {PREENCHER} → sem violation (tratado como ausente)
 *  6. 02-reviewed.md ausente → sem violation (outros invariants cobrem)
 *  7. Mensagem de violation é acionável (menciona ambas as saídas: replantar ou no_error)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkIntentionalErrorPresentInFinal,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { intentionalErrorJsonPath } from "../scripts/lib/intentional-errors.ts";
import type { IntentionalErrorJson } from "../scripts/lib/intentional-errors.ts";

function makeFixtureEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "ie-present-7243-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

describe("checkIntentionalErrorPresentInFinal (#7243)", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = makeFixtureEdition();
  });

  afterEach(() => {
    try { rmSync(fixture, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** #3222: escreve _internal/intentional-error.json + 02-reviewed.md numa edição fixture. */
  function setupEdition(dir: string, record: IntentionalErrorJson | null, reviewedBody: string): void {
    if (record !== null) {
      writeFileSync(intentionalErrorJsonPath(dir), JSON.stringify(record, null, 2), "utf8");
    }
    writeFileSync(join(dir, "02-reviewed.md"), reviewedBody, "utf8");
  }

  it("1. wrong_value ausente de 02-reviewed.md → violation (error)", () => {
    setupEdition(fixture, {
      description: "Anthropik no lugar de Anthropic",
      location: "DESTAQUE 2, parágrafo 1",
      category: "attribution",
      correct_value: "Anthropic",
      wrong_value: "Anthropik",
      reveal: "Na última edição, citei Anthropik.",
    }, "DESTAQUE 1 | TREND\n\nTexto sobre Anthropic.\n\nDESTAQUE 2 | TREND\n\nTexto sobre IA.\n");
    const v = checkIntentionalErrorPresentInFinal(fixture);
    assert.equal(v.length, 1, "esperava exatamente 1 violation");
    assert.equal(v[0].rule, "intentional-error-present-in-final");
    assert.equal(v[0].severity, "error");
    assert.equal(v[0].source_issue, "#7243");
    assert.ok(v[0].message.includes("Anthropik"), "mensagem deve citar o wrong_value");
    assert.match(v[0].file, /02-reviewed\.md/);
  });

  it("2. wrong_value presente em 02-reviewed.md → sem violation", () => {
    setupEdition(fixture, {
      description: "Anthropik no lugar de Anthropic",
      location: "DESTAQUE 2, parágrafo 1",
      category: "attribution",
      correct_value: "Anthropic",
      wrong_value: "Anthropik",
      reveal: "Na última edição, citei Anthropik.",
    }, "DESTAQUE 1 | TREND\n\nTexto sobre Anthropik.\n\nDESTAQUE 2 | TREND\n\nTexto sobre IA.\n");
    const v = checkIntentionalErrorPresentInFinal(fixture);
    assert.equal(v.length, 0, `esperava 0 violations, achei: ${JSON.stringify(v)}`);
  });

  it("3. no_error: true → sem violation (edição sem erro é estado legítimo #2016)", () => {
    setupEdition(fixture, { no_error: true }, "DESTAQUE 1 | TREND\n\nTexto sobre IA.\n");
    const v = checkIntentionalErrorPresentInFinal(fixture);
    assert.equal(v.length, 0, `esperava 0 violations com no_error, achei: ${JSON.stringify(v)}`);
  });

  it("4. record ausente (_internal/intentional-error.json não existe) → sem violation", () => {
    setupEdition(fixture, null, "DESTAQUE 1 | TREND\n\nTexto sobre IA.\n");
    const v = checkIntentionalErrorPresentInFinal(fixture);
    assert.equal(v.length, 0, "record ausente não é este invariante que faila — outros cobrem");
  });

  it("5. wrong_value é placeholder {PREENCHER} → sem violation (tratado como ausente)", () => {
    setupEdition(fixture, {
      description: "Anthropik no lugar de Anthropic",
      location: "DESTAQUE 2",
      category: "attribution",
      correct_value: "Anthropic",
      wrong_value: "{PREENCHER — grafia ERRADA plantada}",
      reveal: "Na última edição, escrevi Anthropik onde o correto é Anthropic.",
    }, "DESTAQUE 1 | TREND\n\nTexto sobre Anthropic.\n");
    const v = checkIntentionalErrorPresentInFinal(fixture);
    assert.equal(v.length, 0, "placeholder não preenchido não deve gerar violation aqui");
  });

  it("6. 02-reviewed.md ausente → sem violation (outros invariants cobrem)", () => {
    // Só cria o JSON, não o MD
    writeFileSync(intentionalErrorJsonPath(fixture), JSON.stringify({
      description: "test",
      location: "DESTAQUE 1",
      category: "ortografico",
      correct_value: "certo",
      wrong_value: "errado",
      reveal: "test reveal",
    }, null, 2), "utf8");
    const v = checkIntentionalErrorPresentInFinal(fixture);
    assert.equal(v.length, 0, "MD ausente não é este invariante que faila");
  });

  it("7. Mensagem de violation é acionável — menciona ambas as saídas", () => {
    setupEdition(fixture, {
      description: "Anthropik no lugar de Anthropic",
      location: "DESTAQUE 2",
      category: "attribution",
      correct_value: "Anthropic",
      wrong_value: "Anthropik",
      reveal: "Na última edição, citei Anthropik.",
    }, "DESTAQUE 1 | TREND\n\nTexto sobre Anthropic.\n");
    const v = checkIntentionalErrorPresentInFinal(fixture);
    assert.equal(v.length, 1);
    const msg = v[0].message;
    // Saída (a): replantar o wrong_value
    assert.match(msg, /Replantar|replantar|replantar/i, "mensagem deve mencionar replantar o wrong_value");
    // Saída (b): declarar edição sem erro
    assert.match(msg, /no_error|sem erro|declarar/i, "mensagem deve mencionar no_error como saída");
    // Menciona a gate de revisão como causa provável
    assert.match(msg, /revis[ãa]o|gate|Stage 4/i, "mensagem deve citar a causa provável (gate/revisão)");
  });
});
