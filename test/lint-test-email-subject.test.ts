/**
 * lint-test-email-subject.test.ts (#1645)
 *
 * O loop de review do test email validava só o CORPO; o subject/título podia
 * sair como 'New post' (autosave latency #1198) ou como o título da edição
 * anterior (260505) sem ser pego. checkSubject + runLints(subject) fecham isso.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkSubject,
  normalizeSubject,
  runLints,
} from "../scripts/lint-test-email.ts";
import type { IntentionalError } from "../scripts/lib/intentional-errors.ts";

const NO_INTENTIONAL: IntentionalError[] = [];
const EXPECTED = "35 mil bolsas pra virar creator com IA";

describe("normalizeSubject (#1645)", () => {
  it("remove o prefixo '[TEST] ' do Beehiiv", () => {
    assert.equal(normalizeSubject("[TEST] " + EXPECTED), EXPECTED);
  });
  it("remove prefixo duplicado '[TEST] [TEST] ' (#1215)", () => {
    assert.equal(normalizeSubject("[TEST] [TEST] " + EXPECTED), EXPECTED);
  });
  it("case-insensitive no prefixo + apara espaços", () => {
    assert.equal(normalizeSubject("  [test]   " + EXPECTED + "  "), EXPECTED);
  });
  it("sem prefixo → inalterado (só trim)", () => {
    assert.equal(normalizeSubject("  " + EXPECTED + " "), EXPECTED);
  });
});

describe("checkSubject (#1645)", () => {
  it("subject correto (com prefixo [TEST]) → null (ok)", () => {
    assert.equal(checkSubject("[TEST] " + EXPECTED, EXPECTED), null);
  });

  it("placeholder 'New post' → blocker subject_mismatch", () => {
    const issue = checkSubject("[TEST] New post", EXPECTED);
    assert.ok(issue);
    assert.equal(issue!.type, "blocker");
    assert.equal(issue!.category, "subject_mismatch");
    assert.match(issue!.detail, /placeholder/i);
  });

  it("subject vazio → blocker", () => {
    const issue = checkSubject("[TEST] ", EXPECTED);
    assert.ok(issue);
    assert.equal(issue!.category, "subject_mismatch");
  });

  it("subject == título da edição anterior → blocker (caso 260505)", () => {
    const prev = "Santander abre 35 mil vagas grátis para creators";
    const issue = checkSubject("[TEST] " + prev, EXPECTED, prev);
    assert.ok(issue);
    assert.equal(issue!.category, "subject_mismatch");
    assert.match(issue!.detail, /edição anterior/i);
    assert.equal(issue!.source_md_value, prev);
  });

  it("subject diverge do esperado (não é prev, não é placeholder) → blocker", () => {
    const issue = checkSubject("[TEST] Outro título qualquer", EXPECTED);
    assert.ok(issue);
    assert.equal(issue!.category, "subject_mismatch");
    assert.match(issue!.detail, /diverge/i);
  });

  it("divergência só por caixa/espaço → null (tolerante)", () => {
    assert.equal(checkSubject("[TEST]   " + EXPECTED.toUpperCase(), EXPECTED), null);
  });
});

describe("runLints com subject (#1645)", () => {
  it("subject divergente vira issue blocker no resultado", () => {
    const res = runLints("corpo qualquer", "corpo qualquer", "260601", NO_INTENTIONAL, {
      received: "[TEST] New post",
      expected: EXPECTED,
    });
    const subjectIssues = res.issues.filter((i) => i.category === "subject_mismatch");
    assert.equal(subjectIssues.length, 1);
    assert.ok(res.summary.blockers >= 1);
  });

  it("subject correto → nenhuma issue de subject", () => {
    const res = runLints("corpo", "corpo", "260601", NO_INTENTIONAL, {
      received: "[TEST] " + EXPECTED,
      expected: EXPECTED,
    });
    assert.equal(res.issues.filter((i) => i.category === "subject_mismatch").length, 0);
  });

  it("sem param subject → não checa subject (back-compat)", () => {
    const res = runLints("corpo", "corpo", "260601", NO_INTENTIONAL);
    assert.equal(res.issues.filter((i) => i.category === "subject_mismatch").length, 0);
  });
});
